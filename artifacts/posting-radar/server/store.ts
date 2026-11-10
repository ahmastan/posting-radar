import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool, transaction, type Db } from "./db.js";
import { defaults } from "./config.js";
import { Events, LostClaim } from "./events.js";
import type { Run, TrackerEntry } from "../src/lib/api.js";
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function ensureUser(userId: string) {
  await transaction(async db => {
    await db.query("INSERT INTO radar_users(id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
    await db.query("INSERT INTO radar_preferences(user_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING", [userId, defaults]);
    await db.query("INSERT INTO radar_preference_history(user_id,revision,payload) VALUES($1,1,$2) ON CONFLICT DO NOTHING", [userId, defaults]);
  });
}
export const trackerSelect = `SELECT t.id,t.source_id AS "sourceId",t.season,t.status,t.revision,t.reasons,t.created_at AS "createdAt",
  t.data_origin AS "dataOrigin",p.payload AS posting FROM radar_tracker t JOIN radar_postings p ON p.identity=t.identity`;
export async function getRun(userId: string, id: string, includeResults = true): Promise<Run> {
  const r = await pool.query(`SELECT id,state,requested_sources AS "requestedSources",preference_revision AS "preferenceRevision",
    preferences,created_at AS "createdAt",finished_at AS "finishedAt",totals,retry_of AS "retryOf"
    FROM radar_runs WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.rowCount) throw new HttpError(404, "Run not found");
  const sr = await pool.query("SELECT result,source_id,baseline_id,candidate_id FROM radar_run_sources WHERE run_id=$1 ORDER BY source_id", [id]);
  const sourceResults = sr.rows.map(x => ({ outcome: "pending", ...x.result, sourceId: x.source_id, baselineSnapshotId: x.baseline_id, candidateSnapshotId: x.candidate_id }));
  const results = includeResults ? (await pool.query(`${trackerSelect} WHERE t.user_id=$1 AND t.discovered_run=$2 ORDER BY t.created_at DESC`, [userId, id])).rows as TrackerEntry[] : undefined;
  const isGuest = userId.startsWith("guest:");
  const matches = includeResults && isGuest ? (await pool.query(`SELECT id,posting,source_id AS "sourceId",season,reasons,
    data_origin AS "dataOrigin",created_at AS "createdAt" FROM radar_run_matches WHERE run_id=$1 ORDER BY created_at,id`, [id])).rows : undefined;
  return { ...r.rows[0], sourceResults, isGuest, ...(includeResults ? { results, ...(isGuest ? { matches } : {}) } : {}) };
}
export async function createRun(userId: string, sourceIds: string[], key: string, revision: number, retryOf?: string) {
  const start = performance.now();
  return transaction(async db => {
    // Serialize request creation and preference revisions for this account.
    const pref = (await db.query("SELECT revision,payload FROM radar_preferences WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
    const existing = await db.query("SELECT id FROM radar_runs WHERE user_id=$1 AND idempotency_key=$2", [userId, key]);
    if (existing.rowCount) return existing.rows[0].id as string;
    if (pref.revision !== revision) throw new HttpError(409, "Preferences changed on another device. Save or reload before starting.");
    if ((await db.query("SELECT id FROM radar_runs WHERE user_id=$1 AND state IN ('queued','running')", [userId])).rowCount) throw new HttpError(409, "A run is already active. Open run history to follow it.");
    if (retryOf && !(await db.query("SELECT id FROM radar_runs WHERE id=$1 AND user_id=$2 AND state IN ('failed','interrupted','degraded')", [retryOf, userId])).rowCount) throw new HttpError(400, "Only your failed, interrupted, or degraded runs can be retried.");
    const id = randomUUID();
    await db.query(`INSERT INTO radar_runs(id,user_id,idempotency_key,requested_sources,preference_revision,preferences,state,retry_of)
      VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`, [id, userId, key, JSON.stringify(sourceIds), pref.revision, { ...pref.payload, revision: pref.revision }, retryOf || null]);
    for (const sourceId of sourceIds) {
      const cursor = (await db.query("SELECT snapshot_id FROM radar_cursors WHERE user_id=$1 AND source_id=$2", [userId, sourceId])).rows[0];
      await db.query(`INSERT INTO radar_run_sources(run_id,source_id,baseline_id,result)
        VALUES($1,$2,$3,$4)`, [id, sourceId, cursor?.snapshot_id || null, { sourceId, outcome: "pending", initialImport: !cursor }]);
    }
    const events = new Events(id, start);
    await events.append({ step: "request", phase: "started", fromLayer: "Page", toLayer: "Server", summary: "Received run request", elapsedRunMs: 0 }, db);
    await events.append({ step: "request", phase: "succeeded", fromLayer: "Server", toLayer: "Database",
      summary: `Request, source baselines, and preference revision ${pref.revision} saved atomically`, durationMs: performance.now() - start,
      counts: { sources: sourceIds.length, preferenceRevision: pref.revision } }, db);
    return id;
  });
}
export async function assertClaim(db: Db, runId: string, token: string) {
  const r = await db.query("SELECT id FROM radar_runs WHERE id=$1 AND state='running' AND worker_token=$2 FOR UPDATE", [runId, token]);
  if (!r.rowCount) throw new LostClaim("Worker claim lost; no data was changed.");
}
