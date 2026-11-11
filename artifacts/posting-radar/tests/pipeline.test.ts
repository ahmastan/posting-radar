import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../server/db.js";
import { ensureUser, createRun, getRun } from "../server/store.js";
import { processRun } from "../server/pipeline.js";
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
