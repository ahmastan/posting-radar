import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../server/db.js";
import { ensureUser, createRun, getRun } from "../server/store.js";
import { processRun } from "../server/pipeline.js";
import { cleanupDuplicateSnapshots } from "../server/snapshot-cleanup.js";
import { defaults } from "../server/config.js";
import { readEvents } from "../server/events.js";
import { interruptOrphanedRuns } from "../server/worker.js";
import { getGuestHandoff, saveGuestMatches } from "../server/handoff.js";
import { signGuestId, verifyGuestCookie, guestOwner } from "../server/guest-session.js";
import type { Request } from "express";
// All integration data is isolated in a throwaway schema, never user tables or shared snapshots.
const schema = `radar_test_${randomUUID().replaceAll("-", "")}`;
pool.options.options = `-c search_path=${schema}`;
const fixture = readFileSync(new URL("./fixtures/internships.md", import.meta.url), "utf8");
const other = readFileSync(new URL("./fixtures/new-grad.md", import.meta.url), "utf8");
before(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
});
after(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
let key = 0;
async function run(user: string, sourceIds = ["internships"], transport = (async () => new Response(fixture, { headers: { etag: '"fixture"' } })) as typeof fetch) {
  await ensureUser(user);
  const revision = (await pool.query("SELECT revision FROM radar_preferences WHERE user_id=$1", [user])).rows[0].revision;
  const id = await createRun(user, sourceIds, `test-key-${++key}`, revision);
  const token = randomUUID();
  const r = (await pool.query("UPDATE radar_runs SET state='running',worker_token=$2 WHERE id=$1 RETURNING *", [id, token])).rows[0];
  await processRun(r, transport);
  return getRun(user, id);
}
test("first import, repeat, changed/reordered/reappearing rows and frozen revisions", async () => {
  const first = await run("u1");
  assert.equal(first.state, "succeeded"); assert.equal(first.totals.inserted, 3);
  assert(first.sourceResults[0].initialImport);
  const entry = first.results![0];
  await pool.query("UPDATE radar_tracker SET status='applied',revision=2 WHERE id=$1", [entry.id]);
  await pool.query("UPDATE radar_preferences SET revision=2,payload=$2 WHERE user_id=$1", ["u1", { ...defaults, locations: ["Nowhere"] }]);
  const repeat = await run("u1");
  assert.equal(repeat.preferenceRevision, 2); assert.equal(repeat.totals.newSinceBaseline, 0);
  assert.equal((await getRun("u1", first.id)).preferences.revision, 1);
  const empty = fixture.replace(/<tbody>[\s\S]*?<\/tbody>/, "<tbody></tbody>");
  await run("u1", ["internships"], (async () => new Response(empty)) as typeof fetch);
  const reappeared = await run("u1", ["internships"], (async () => new Response(fixture.replace("Software Engineer Intern", "Updated Software Engineer Intern"))) as typeof fetch);
  assert.equal(reappeared.totals.newSinceBaseline, 0);
  assert.equal((await pool.query("SELECT status,revision FROM radar_tracker WHERE id=$1", [entry.id])).rows[0].status, "applied");
});
test("stored legacy preferences are normalized before a sweep freezes and applies them", async () => {
  await ensureUser("legacy-preferences");
  const { workModel: _workModel, pay: _pay, ...oldPreferences } = defaults;
  await pool.query("UPDATE radar_preferences SET payload=$2 WHERE user_id=$1", [
    "legacy-preferences", { ...oldPreferences, remotePolicy: "exclude", roles: ["Other"] },
  ]);
  const raw = `| Company | Role | Location | Application | Work Model |
| --- | --- | --- | --- | --- |
| Acme | Mechanical Engineer | Remote | [Apply](https://example.org/legacy-remote) | Remote |
| Acme | Mechanical Engineer | Boston | [Apply](https://example.org/legacy-hybrid) | Hybrid |`;
  const result = await run("legacy-preferences", ["jobright-eng"], (async () => new Response(raw)) as typeof fetch);
  assert.equal(result.preferences.workModel, "nonremote");
  assert.equal(result.preferences.pay, "any");
  assert.equal(result.totals.inserted, 1);
  assert.equal(result.results![0].posting.url, "https://example.org/legacy-hybrid");
});
test("unchanged live content reuses snapshots across accounts while refreshing cursors and validators", async () => {
  const source = "pittcsc";
  const count = async () => (await pool.query("SELECT count(*)::int AS count FROM radar_snapshots WHERE source_id=$1", [source])).rows[0].count;
  const first = await run("snapshot-user", [source]);
  const id = first.sourceResults[0].candidateSnapshotId;
  assert(id);
  assert.equal(await count(), 1);
  await pool.query("UPDATE radar_cursors SET processed_at=now()-interval '1 day' WHERE user_id='snapshot-user'");
  await pool.query("UPDATE radar_snapshots SET fetched_at=now()-interval '1 day' WHERE id=$1", [id]);
  const repeat = await run("snapshot-user", [source], (async () => new Response(fixture, {
    headers: { etag: '"refreshed"', "last-modified": "Tue, 10 Nov 2026 12:00:00 GMT" },
  })) as typeof fetch);
  assert.equal(await count(), 1);
  assert.equal(repeat.sourceResults[0].candidateSnapshotId, id);
  assert.equal(repeat.sourceResults[0].baselineSnapshotId, id);
  assert.equal(repeat.sourceResults[0].outcome, "succeeded");
  assert.equal(repeat.sourceResults[0].dataOrigin, "live");
  assert.equal(repeat.totals.inserted, 0);
  assert.equal(repeat.totals.newSinceBaseline, 0);
  const cursor = (await pool.query("SELECT * FROM radar_cursors WHERE user_id='snapshot-user'")).rows[0];
  assert.equal(cursor.snapshot_id, id);
  assert(new Date(cursor.processed_at).getTime() > Date.now() - 60_000);
  const snapshot = (await pool.query("SELECT * FROM radar_snapshots WHERE id=$1", [id])).rows[0];
  assert.equal(snapshot.etag, '"refreshed"');
  assert.equal(snapshot.last_modified, "Tue, 10 Nov 2026 12:00:00 GMT");
  assert(new Date(snapshot.fetched_at).getTime() > Date.now() - 60_000);
  const events = await readEvents(repeat.id);
  assert(events.some(e => e.step === "snapshot" && e.phase === "succeeded" && e.dataOrigin === "live" && /reused/.test(e.summary)));
  assert(events.some(e => e.step === "save" && e.phase === "succeeded" && e.counts?.cursorAdvanced === 1));
  const otherUser = await run("snapshot-other", [source]);
  assert.equal(otherUser.totals.inserted, 3);
  assert.equal(otherUser.sourceResults[0].candidateSnapshotId, id);
  assert.equal(await count(), 1);
  const revalidated = await run("snapshot-user", [source], (async () => new Response(null, { status: 304 })) as typeof fetch);
  assert.equal(revalidated.sourceResults[0].candidateSnapshotId, id);
  assert.equal(await count(), 1);
  const changed = fixture.replace("Software Engineer Intern", "Updated Software Engineer Intern");
  const fetchChanged = (async () => new Response(changed)) as typeof fetch;
  const concurrent = await Promise.all([
    run("snapshot-concurrent-a", [source], fetchChanged),
    run("snapshot-concurrent-b", [source], fetchChanged),
  ]);
  assert(concurrent.every(r => r.state === "succeeded"));
  const changedId = concurrent[0].sourceResults[0].candidateSnapshotId;
  assert.notEqual(changedId, id);
  assert.equal(concurrent[1].sourceResults[0].candidateSnapshotId, changedId);
  assert.equal(await count(), 2);
});
test("duplicate cleanup requires exact approval, preserves recovery/audit boundaries and rolls back atomically", async () => {
  const source = "cleanup-fixture";
  const [old, middle, retained, parserBoundary, parsedBoundary, rawBoundary, invalid, recovery, otherSource] =
    Array.from({ length: 9 }, () => randomUUID());
  const seeds = [
    [old, source, 1, "body", [], true, "2026-01-01"],
    [middle, source, 1, "body", [], true, "2026-01-02"],
    [retained, source, 1, "body", [], true, "2026-01-03"],
    [parserBoundary, source, 2, "body", [], true, "2026-01-01"],
    [parsedBoundary, source, 1, "body", [{ different: true }], true, "2026-01-01"],
    [rawBoundary, source, 1, "not body", [], true, "2026-01-01"],
    [invalid, source, 1, "body", [], false, "2026-01-04"],
    [recovery, source, 1, "older distinct body", [], true, "2025-12-01"],
    [otherSource, "cleanup-other-source", 1, "body", [], true, "2026-01-01"],
  ];
  for (const [id, sourceId, version, raw, rows, validated, date] of seeds) {
    // Deliberately equal hashes: exact raw and parsed equality must also be checked.
    await pool.query(`INSERT INTO radar_snapshots(id,source_id,parser_version,raw,rows,validated,fetched_at,content_hash,etag,last_modified)
      VALUES($1,$2,$3,$4,$5,$6,$7,'same-hash',$8,$9)`,
    [id, sourceId, version, raw, JSON.stringify(rows), validated, date, `"${id}"`, String(date)]);
  }
  await ensureUser("cleanup-user");
  await ensureUser("cleanup-second-user");
  const runId = randomUUID(), jsonOnlyRunId = randomUUID();
  const originalResult = {
    sourceId: source, outcome: "degraded", baselineSnapshotId: old, candidateSnapshotId: middle,
    cachedAt: "2026-01-01", counts: { inserted: 2 }, error: { code: "HTTP_503", message: "Unavailable" },
  };
  for (const id of [runId, jsonOnlyRunId]) {
    await pool.query(`INSERT INTO radar_runs(id,user_id,idempotency_key,requested_sources,preference_revision,preferences,state,totals)
      VALUES($1::uuid,'cleanup-user',$1::uuid::text,$2,1,$3,'degraded','{"inserted":2}')`, [id, JSON.stringify([source]), defaults]);
    await pool.query(`INSERT INTO radar_run_sources(run_id,source_id,baseline_id,candidate_id,result) VALUES($1,$2,$3,$4,$5)`,
      [id, source, id === runId ? old : null, id === runId ? middle : null, originalResult]);
  }
  for (const [user, id] of [["cleanup-user", old], ["cleanup-second-user", middle]]) {
    await pool.query("INSERT INTO radar_cursors(user_id,source_id,snapshot_id) VALUES($1,$2,$3)", [user, source, id]);
  }
  await pool.query("INSERT INTO radar_events(run_id,sequence,payload) VALUES($1,1,$2)", [runId, { summary: "original audit", counts: { inserted: 2 } }]);
  const readState = async () => ({
    snapshots: (await pool.query("SELECT * FROM radar_snapshots ORDER BY id")).rows,
    cursors: (await pool.query("SELECT * FROM radar_cursors ORDER BY user_id,source_id")).rows,
    sources: (await pool.query("SELECT * FROM radar_run_sources ORDER BY run_id,source_id")).rows,
    audits: (await pool.query("SELECT * FROM radar_snapshot_cleanups ORDER BY id")).rows,
    runs: (await pool.query("SELECT * FROM radar_runs ORDER BY id")).rows,
    events: (await pool.query("SELECT * FROM radar_events ORDER BY run_id,sequence")).rows,
    tracker: (await pool.query("SELECT * FROM radar_tracker ORDER BY id")).rows,
  });
  const before = await readState();
  const preview = await cleanupDuplicateSnapshots();
  assert.equal(preview.mode, "dry-run");
  assert.deepEqual(preview.summary, {
    redundantSnapshots: 2, retainedSnapshots: 1, cursorReferences: 2, baselineReferences: 1,
    candidateReferences: 1, resultReferences: 4, estimatedContentBytes: 12,
  });
  assert(preview.mappings.every(m => m.retainedId === retained));
  assert.deepEqual(await readState(), before); // dry-run never mutates data or writes an audit
  await assert.rejects(cleanupDuplicateSnapshots({ planHash: preview.planHash, approvedBy: "" }), /Explicit approval/);
  await assert.rejects(cleanupDuplicateSnapshots({ planHash: "0".repeat(64), approvedBy: "test approver" }), /plan changed/);
  assert.deepEqual(await readState(), before);

  await pool.query(`CREATE FUNCTION fail_cleanup_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected cleanup failure'; END $$`);
  await pool.query("CREATE TRIGGER fail_cleanup BEFORE DELETE ON radar_snapshots FOR EACH ROW EXECUTE FUNCTION fail_cleanup_delete()");
  try {
    await assert.rejects(cleanupDuplicateSnapshots({ planHash: preview.planHash, approvedBy: "test approver" }), /injected cleanup failure/);
    assert.deepEqual(await readState(), before); // includes remapped references and inserted audit, all rolled back
  } finally { await pool.query("DROP TRIGGER fail_cleanup ON radar_snapshots"); }

  await pool.query("UPDATE radar_cursors SET processed_at=processed_at+interval '1 second' WHERE user_id='cleanup-user'");
  await assert.rejects(cleanupDuplicateSnapshots({ planHash: preview.planHash, approvedBy: "test approver" }), /plan changed/);
  const refreshed = await cleanupDuplicateSnapshots();
  const active = randomUUID();
  await pool.query(`INSERT INTO radar_runs(id,user_id,idempotency_key,requested_sources,preference_revision,preferences,state)
    VALUES($1::uuid,'cleanup-user',$1::uuid::text,'[]',1,$2,'queued')`, [active, defaults]);
  await assert.rejects(cleanupDuplicateSnapshots(), /no queued or running/);
  await assert.rejects(cleanupDuplicateSnapshots({ planHash: refreshed.planHash, approvedBy: "test approver" }), /no queued or running/);
  await pool.query("UPDATE radar_runs SET state='running' WHERE id=$1", [active]);
  await assert.rejects(cleanupDuplicateSnapshots(), /no queued or running/);
  await pool.query("UPDATE radar_runs SET state='interrupted' WHERE id=$1", [active]);

  // A concurrently committed request must be seen after the cleanup obtains its lock.
  const concurrent = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await concurrent.query("BEGIN");
    await concurrent.query("UPDATE radar_runs SET state='queued' WHERE id=$1", [active]);
    pending = cleanupDuplicateSnapshots({ planHash: refreshed.planHash, approvedBy: "test approver" })
      .then(() => { throw new Error("Cleanup should have refused a concurrent queued run"); },
        error => assert.match(error.message, /no queued or running/));
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = Boolean((await pool.query(`SELECT 1 FROM pg_locks l
        JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='radar_runs' AND l.mode='ShareRowExclusiveLock' AND NOT l.granted`,
      [schema])).rowCount);
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(blocked, "cleanup must wait for concurrent run creation");
    await concurrent.query("COMMIT");
    await pending;
  } finally {
    await concurrent.query("ROLLBACK");
    concurrent.release();
    if (pending) await pending;
    await pool.query("UPDATE radar_runs SET state='interrupted' WHERE id=$1", [active]);
  }

  const preApply = await readState();
  const applied = await cleanupDuplicateSnapshots({ planHash: refreshed.planHash, approvedBy: "test approver" });
  assert.equal(applied.mode, "applied");
  assert.equal(applied.summary.redundantSnapshots, 2);
  const after = await readState();
  assert.deepEqual(after.snapshots, preApply.snapshots.filter(s => ![old, middle].includes(s.id)));
  assert.deepEqual(after.cursors, preApply.cursors.map(c => [old, middle].includes(c.snapshot_id) ? { ...c, snapshot_id: retained } : c));
  for (const id of [runId, jsonOnlyRunId]) {
    const row = after.sources.find(r => r.run_id === id)!;
    assert.equal(row.baseline_id, id === runId ? retained : null);
    assert.equal(row.candidate_id, id === runId ? retained : null);
    assert.deepEqual(row.result, { ...originalResult, baselineSnapshotId: retained, candidateSnapshotId: retained });
  }
  assert.deepEqual(after.runs, preApply.runs);
  assert.deepEqual(after.events, preApply.events);
  assert.deepEqual(after.tracker, preApply.tracker);
  assert.equal(after.audits.length, preApply.audits.length + 1);
  const audit = after.audits.find(a => a.id === applied.cleanupId)!;
  assert.equal(audit.approved_plan_hash, refreshed.planHash);
  assert.equal(audit.approved_by, "test approver");
  assert.deepEqual(audit.plan.runSources.map((r: { result: unknown }) => r.result), [originalResult, originalResult]);
  assert.deepEqual(audit.plan.mappings.map((m: { removedId: string }) => m.removedId).sort(), [old, middle].sort());
  const noOp = await cleanupDuplicateSnapshots();
  assert.equal(noOp.summary.redundantSnapshots, 0);
  await assert.rejects(cleanupDuplicateSnapshots({ planHash: refreshed.planHash, approvedBy: "test approver" }), /plan changed/);
  await cleanupDuplicateSnapshots({ planHash: noOp.planHash, approvedBy: "test approver" });
  assert.deepEqual(await readState(), after); // repeated cleanup is harmless
});
test("idempotent/concurrent requests, account isolation, active serialization", async () => {
  await ensureUser("u2");
  const ids = await Promise.all([createRun("u2", ["internships"], "same-key-001", 1), createRun("u2", ["internships"], "same-key-001", 1)]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await getRun("u2", ids[0])).sourceResults[0].outcome, "pending");
  await assert.rejects(createRun("u2", ["internships"], "different-key-001", 1), /already active/);
  await assert.rejects(getRun("someone-else", ids[0]), /not found/);
  await pool.query("UPDATE radar_runs SET state='interrupted' WHERE id=$1", [ids[0]]);
  await assert.rejects(createRun("u2", ["internships"], "revision-key-001", 99), /Preferences changed/);
  const r = await run("u2");
  assert.equal(r.totals.inserted, 3); // another user's baseline never moves this one
});
test("one source fails without cache while another succeeds; terminal skipped events", async () => {
  // internships has cache; new-grad has no cache in this isolated schema yet
  const r = await run("u3", ["new-grad", "internships"], (async (url: string | URL | Request) => {
    if (String(url).includes("New-Grad-Positions")) return new Response("error", { status: 500 });
    return new Response(fixture);
  }) as typeof fetch);
  assert.equal(r.state, "degraded");
  assert.equal(r.sourceResults.find(s => s.sourceId === "new-grad")?.outcome, "failed");
  const events = await readEvents(r.id);
  assert.equal(events.filter(e => e.sourceId === "new-grad" && e.step === "fetch" && e.phase === "failed").length, 2);
  assert(events.some(e => e.step === "parse" && e.phase === "skipped"));
  assert.equal((await pool.query("SELECT * FROM radar_cursors WHERE user_id='u3' AND source_id='new-grad'")).rowCount, 0);
});
test("validated stale cache saves labeled observations without fresh cursor; 304 advances", async () => {
  const r = await run("u4", ["internships"], (async () => new Response("", { status: 503 })) as typeof fetch);
  assert.equal(r.state, "degraded"); assert.equal(r.totals.inserted, 3);
  assert.equal(r.results![0].dataOrigin, "cache");
  assert(r.sourceResults[0].error);
  assert.equal((await pool.query("SELECT * FROM radar_cursors WHERE user_id='u4'")).rowCount, 0);
  const revalidated = await run("u4", ["internships"], (async () => new Response(null, { status: 304 })) as typeof fetch);
  assert.equal(revalidated.state, "succeeded"); assert.equal(revalidated.totals.inserted, 0);
  assert.equal((await pool.query("SELECT * FROM radar_cursors WHERE user_id='u4'")).rowCount, 1);
});
test("parse failure preserves baseline/cache/statuses, never reports empty success", async () => {
  const first = await run("u5", ["new-grad"], (async () => new Response(other)) as typeof fetch);
  const cursor = first.sourceResults[0].candidateSnapshotId;
  const r = await run("u5", ["new-grad"], (async () => new Response("malformed readme")) as typeof fetch);
  assert.equal(r.state, "failed"); assert.equal(r.sourceResults[0].error?.code, "PARSE_FAILED");
  assert.equal((await pool.query("SELECT snapshot_id FROM radar_cursors WHERE user_id='u5'")).rows[0].snapshot_id, cursor);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM radar_tracker WHERE user_id='u5'")).rows[0].count, 4);
});
test("cross-source identity saves once without overwriting a user status", async () => {
  const r = await run("cross-source-user", ["new-grad", "internships"]);
  assert.equal(r.totals.matched, 6);
  assert.equal(r.totals.inserted, 3);
  assert.equal(r.totals.alreadyTracked, 3);
  await pool.query("UPDATE radar_tracker SET status='skipped',revision=revision+1 WHERE user_id='cross-source-user'");
  const repeat = await run("cross-source-user", ["new-grad", "internships"]);
  assert.equal(repeat.totals.inserted, 0);
  const statuses = (await pool.query("SELECT DISTINCT status FROM radar_tracker WHERE user_id='cross-source-user'")).rows;
  assert.deepEqual(statuses.map(s => s.status), ["skipped"]);
});
test("preference edits do not silently reconsider previously excluded observations", async () => {
  await ensureUser("excluded-user");
  await pool.query("UPDATE radar_preferences SET payload=$2 WHERE user_id=$1", ["excluded-user", { ...defaults, locations: ["No such location"] }]);
  const first = await run("excluded-user");
  assert.equal(first.totals.inserted, 0); assert.equal(first.totals.excluded, 3);
  await pool.query("UPDATE radar_preferences SET revision=2,payload=$2 WHERE user_id=$1", ["excluded-user", defaults]);
  const repeat = await run("excluded-user");
  assert.equal(repeat.totals.newSinceBaseline, 0); assert.equal(repeat.totals.inserted, 0);
});
test("source save rollback preserves existing data and no cursor advancement", async () => {
  await pool.query(`CREATE FUNCTION fail_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='rollback-user' THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER test_fail BEFORE INSERT ON radar_tracker FOR EACH ROW EXECUTE FUNCTION fail_test_insert()");
  try {
    const r = await run("rollback-user");
    assert.equal(r.state, "failed"); assert.equal(r.sourceResults[0].counts?.inserted, 0);
    assert.equal((await pool.query("SELECT * FROM radar_tracker WHERE user_id='rollback-user'")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM radar_cursors WHERE user_id='rollback-user'")).rowCount, 0);
    assert((await readEvents(r.id)).some(e => e.step === "save" && e.phase === "failed"));
  } finally { await pool.query("DROP TRIGGER test_fail ON radar_tracker"); }
});
test("ordered events, catch-up, read-only replay records and interruption recovery", async () => {
  const r = await run("events-user");
  const events = await readEvents(r.id);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert(events.filter(e => e.phase === "succeeded").every(e => typeof e.durationMs === "number" && e.durationMs >= 0));
  assert.deepEqual((await readEvents(r.id, 3)).map(e => e.sequence), events.filter(e => e.sequence > 3).map(e => e.sequence));
  const before = (await pool.query("SELECT count(*) FROM radar_tracker")).rows[0].count;
  await getRun("events-user", r.id); await readEvents(r.id);
  assert.equal((await pool.query("SELECT count(*) FROM radar_tracker")).rows[0].count, before);
  const id = await createRun("events-user", ["internships"], "interrupt-key-001", 1);
  await pool.query("UPDATE radar_runs SET state='running',worker_token=$2 WHERE id=$1", [id, randomUUID()]);
  await interruptOrphanedRuns();
  assert.equal((await getRun("events-user", id)).state, "interrupted");
  assert((await readEvents(id)).some(e => e.error?.code === "INTERRUPTED"));
  const retry = await createRun("events-user", ["internships"], "retry-key-001", 1, id);
  assert.notEqual(retry, id);
});
test("guest checks stay browser-scoped, do not save tracker entries, and dedupe across sources", async () => {
  const guest = `guest:${randomUUID()}`;
  const result = await run(guest, ["new-grad", "internships"]);
  assert.equal(result.isGuest, true);
  assert.equal(result.results!.length, 0);
  assert.equal(result.matches!.length, 3);
  assert.equal(result.totals.inserted, 0);
  assert.equal(result.totals.guestMatches, 3);
  assert.equal(result.totals.alreadyObserved, 3);
  assert.equal((await pool.query("SELECT * FROM radar_tracker WHERE user_id=$1", [guest])).rowCount, 0);
  await assert.rejects(getRun(`guest:${randomUUID()}`, result.id), /not found/);
  const repeat = await run(guest);
  assert.equal(repeat.matches!.length, 0);
  await ensureUser("guest-account");
  const selected = await getGuestHandoff("guest-account", guest, result.id);
  assert.equal(selected.run?.id, result.id); // preserve selected visible results, not latest empty repeat
  assert.equal(selected.matches.length, 3);
  assert.equal(selected.imported, false);
  assert.equal((await pool.query("SELECT * FROM radar_tracker WHERE user_id='guest-account'")).rowCount, 0);
  const imported = await saveGuestMatches("guest-account", guest, result.id);
  assert.equal(imported.inserted, 3);
  assert.equal((await pool.query("SELECT * FROM radar_cursors WHERE user_id='guest-account'")).rowCount, 0);
  assert.equal((await pool.query("SELECT revision FROM radar_preferences WHERE user_id='guest-account'")).rows[0].revision, 1);
  assert.equal((await getGuestHandoff("guest-account", guest, result.id)).imported, true);
  assert.deepEqual(await saveGuestMatches("guest-account", guest, result.id), imported);
  await pool.query("UPDATE radar_tracker SET status='applied',revision=2 WHERE user_id='guest-account'");
  const otherGuest = `guest:${randomUUID()}`;
  const otherRun = await run(otherGuest);
  await assert.rejects(saveGuestMatches("guest-account", otherGuest, result.id), /not found/);
  assert.equal((await saveGuestMatches("guest-account", otherGuest, otherRun.id)).inserted, 0);
  assert.equal((await pool.query("SELECT DISTINCT status FROM radar_tracker WHERE user_id='guest-account'")).rows[0].status, "applied");
  await assert.rejects(saveGuestMatches(guest, guest, result.id), /Sign in/);
  assert.equal((await getGuestHandoff("guest-account", null)).available, false);
});
test("anonymous cookies require valid signatures and unexpired database sessions", async () => {
  const id = randomUUID(), guest = `guest:${id}`;
  await ensureUser(guest);
  await pool.query("INSERT INTO radar_guest_sessions(id,user_id) VALUES($1,$2)", [id, guest]);
  const cookie = signGuestId(id);
  assert.equal(verifyGuestCookie(cookie), id);
  assert.equal(verifyGuestCookie(`${cookie}tampered`), null);
  assert.equal(verifyGuestCookie(`${randomUUID()}.${cookie.split(".")[1]}`), null);
  const req = { headers: { cookie: `posting_radar_guest=${cookie}` } } as Request;
  assert.equal(await guestOwner(req), guest);
  await pool.query("UPDATE radar_guest_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
  assert.equal(await guestOwner(req), null);
});
