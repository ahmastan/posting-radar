import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool, transaction } from "./db.js";
import { Events } from "./events.js";
import { getRun, HttpError } from "./store.js";
import type { GuestHandoff, GuestMatch, Preferences } from "../src/lib/api.js";
export async function getGuestHandoff(userId: string, guestUserId: string | null, preferredRunId?: string): Promise<GuestHandoff> {
  if (!guestUserId || guestUserId === userId) return { available: false, matches: [], imported: false };
  const pref = (await pool.query("SELECT revision,payload FROM radar_preferences WHERE user_id=$1", [guestUserId])).rows[0];
  const row = (await pool.query(`SELECT id FROM radar_runs WHERE user_id=$1 AND state NOT IN ('queued','running')
    ORDER BY (id=$2::uuid) DESC NULLS LAST,created_at DESC LIMIT 1`, [guestUserId, preferredRunId || null])).rows[0];
  const run = row ? await getRun(guestUserId, row.id) : undefined;
  const imported = run ? !!(await pool.query("SELECT 1 FROM radar_guest_imports WHERE guest_run_id=$1 AND user_id=$2", [run.id, userId])).rowCount : false;
  return { available: !!pref, guestUserId, preferences: pref ? { ...pref.payload, revision: pref.revision } as Preferences : undefined,
    run, matches: run?.matches || [], imported };
}
export async function saveGuestMatches(userId: string, guestUserId: string | null, guestRunId: string) {
  if (!guestUserId || !guestUserId.startsWith("guest:") || userId.startsWith("guest:")) throw new HttpError(401, "Sign in from the same guest browser to save these matches.");
  const start = performance.now();
  return transaction(async db => {
    const pref = (await db.query("SELECT revision,payload FROM radar_preferences WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
    if (!pref) throw new HttpError(401, "Account is not initialized.");
    const guestRun = (await db.query("SELECT * FROM radar_runs WHERE id=$1 AND user_id=$2 AND state NOT IN ('queued','running')", [guestRunId, guestUserId])).rows[0];
    if (!guestRun) throw new HttpError(404, "Finished guest run not found for this browser.");
    const previous = (await db.query(`SELECT i.account_run_id,r.totals FROM radar_guest_imports i JOIN radar_runs r ON r.id=i.account_run_id
      WHERE guest_run_id=$1 AND i.user_id=$2`, [guestRunId, userId])).rows[0];
    if (previous) return { id: previous.account_run_id as string, inserted: Number(previous.totals.inserted || 0) };
    if ((await db.query("SELECT 1 FROM radar_runs WHERE user_id=$1 AND state IN ('queued','running')", [userId])).rowCount) throw new HttpError(409, "Let your current account run finish before importing guest matches.");
    const matches = (await db.query(`SELECT id,identity,posting,source_id AS "sourceId",season,reasons,
      data_origin AS "dataOrigin",created_at AS "createdAt" FROM radar_run_matches WHERE run_id=$1 ORDER BY id`, [guestRunId])).rows as (GuestMatch & {identity: string})[];
    const id = randomUUID();
    await db.query(`INSERT INTO radar_runs(id,user_id,idempotency_key,requested_sources,preference_revision,preferences,state)
      VALUES($1,$2,$3,$4,$5,$6,'running')`, [id, userId, `guest-import:${guestRunId}`, JSON.stringify(guestRun.requested_sources), pref.revision, { ...pref.payload, revision: pref.revision }]);
    const events = new Events(id, start);
    await events.append({ step: "request", phase: "started", fromLayer: "Page", toLayer: "Server", summary: "User explicitly requested saving the visible guest matches", elapsedRunMs: 0 }, db);
    await events.append({ step: "request", phase: "succeeded", fromLayer: "Server", toLayer: "Database", summary: "Explicit guest import request and account preference revision recorded; ingestion will not run", durationMs: performance.now() - start }, db);
    const saveStart = performance.now();
    await events.append({ step: "handoff", phase: "started", fromLayer: "Server", toLayer: "Database", summary: `Saving ${matches.length} selected guest observations without changing account baselines or preferences` }, db);
    let inserted = 0;
    const insertedBySource: Record<string, number> = {};
    for (const match of matches) {
      const result = await db.query(`INSERT INTO radar_tracker(id,user_id,identity,source_id,season,discovered_run,reasons,data_origin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,identity) DO NOTHING`,
        [randomUUID(), userId, match.identity, match.sourceId, match.season, id, JSON.stringify([...match.reasons, "Explicitly saved after guest check; not re-filtered against account preferences"]), match.dataOrigin]);
      inserted += result.rowCount || 0;
      insertedBySource[match.sourceId] = (insertedBySource[match.sourceId] || 0) + (result.rowCount || 0);
    }
    const totals = { matched: matches.length, inserted, alreadyTracked: matches.length - inserted };
    for (const sourceId of guestRun.requested_sources as string[]) {
      const sourceMatches = matches.filter(m => m.sourceId === sourceId);
      await db.query(`INSERT INTO radar_run_sources(run_id,source_id,baseline_id,candidate_id,result)
        SELECT $1,$2,(SELECT snapshot_id FROM radar_cursors WHERE user_id=$3 AND source_id=$2),
        candidate_id,$4 FROM radar_run_sources WHERE run_id=$5 AND source_id=$2`, [id, sourceId, userId,
        { sourceId, outcome: "succeeded", counts: { matched: sourceMatches.length, inserted: insertedBySource[sourceId] || 0, cursorAdvanced: 0 },
          dataOrigin: sourceMatches.some(m => m.dataOrigin === "cache") ? "cache" : "live" }, guestRunId]);
    }
    await db.query("INSERT INTO radar_guest_imports(guest_run_id,user_id,account_run_id) VALUES($1,$2,$3)", [guestRunId, userId, id]);
    await events.append({ step: "handoff", phase: "succeeded", fromLayer: "Server", toLayer: "Database", summary: `Saved ${inserted}; kept ${totals.alreadyTracked} existing entries and statuses unchanged. Account baseline and preferences were not merged.`, counts: totals, durationMs: performance.now() - saveStart }, db);
    const resultStart = performance.now();
    await events.append({ step: "results", phase: "started", fromLayer: "Database", toLayer: "Page", summary: "Preparing explicit guest import results" }, db);
    await events.append({ step: "results", phase: "succeeded", fromLayer: "Server", toLayer: "Page", summary: `Guest handoff complete: ${inserted} saved`, counts: totals, durationMs: performance.now() - resultStart }, db);
    await db.query("UPDATE radar_runs SET state='succeeded',finished_at=now(),totals=$2 WHERE id=$1", [id, totals]);
    return { id, inserted };
  });
}
