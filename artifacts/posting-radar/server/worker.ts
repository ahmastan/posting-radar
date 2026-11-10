import { randomUUID } from "node:crypto";
import { pool, transaction } from "./db.js";
import { Events, errorInfo } from "./events.js";
import { processRun } from "./pipeline.js";
let stopping = false;
export function stopWorker() { stopping = true; }
export async function interruptOrphanedRuns() {
  await transaction(async db => {
    const runs = (await db.query("SELECT id FROM radar_runs WHERE state='running' FOR UPDATE")).rows;
    for (const run of runs) {
      const events = new Events(run.id);
      // Close any persisted started lifecycle lacking a terminal event.
      const open = (await db.query(`SELECT payload FROM radar_events e WHERE run_id=$1 AND payload->>'phase'='started' AND NOT EXISTS (
        SELECT 1 FROM radar_events t WHERE t.run_id=e.run_id AND t.sequence>e.sequence
        AND t.payload->>'step'=e.payload->>'step'
        AND COALESCE(t.payload->>'sourceId','')=COALESCE(e.payload->>'sourceId','')
        AND t.payload->>'attempt'=e.payload->>'attempt' AND t.payload->>'phase'<>'started')`, [run.id])).rows;
      for (const { payload } of open) await events.append({
        step: payload.step, sourceId: payload.sourceId, attempt: payload.attempt, phase: "failed",
        fromLayer: payload.fromLayer, toLayer: payload.toLayer,
        summary: "Server interrupted this step; duration unavailable across process restart",
        error: { code: "INTERRUPTED", message: "Execution stopped before a terminal event was persisted. Retry safely with a new run." }
      }, db);
      await events.append({ step: "interruption", phase: "started", fromLayer: "Database", toLayer: "Server", summary: "Recovering interrupted execution" }, db);
      await events.append({ step: "interruption", phase: "failed", fromLayer: "Server", toLayer: "Page", summary: "Run interrupted. Committed source results and tracker edits are preserved; retry is safe.", error: { code: "INTERRUPTED", message: "Previous worker stopped." } }, db);
      await db.query(`UPDATE radar_run_sources SET result=jsonb_build_object('sourceId',source_id,'outcome','interrupted',
        'error',jsonb_build_object('code','INTERRUPTED','message','Worker stopped before this source completed.'))
        WHERE run_id=$1 AND (NOT (result ? 'outcome') OR result->>'outcome' IN ('pending','running'))`, [run.id]);
      const results = (await db.query("SELECT result FROM radar_run_sources WHERE run_id=$1", [run.id])).rows;
      const totals: Record<string, number> = {};
      for (const row of results) for (const [key, value] of Object.entries(row.result.counts || {})) {
        if (typeof value === "number") totals[key] = (totals[key] || 0) + value;
      }
      await db.query("UPDATE radar_runs SET state='interrupted',finished_at=now(),worker_token=NULL,totals=$2 WHERE id=$1", [run.id, totals]);
    }
  });
}
// One DB session lock makes startup recovery safe across multiple web instances.
// Losing the session fences writes (claim checks) and exits, rather than running two workers.
export async function workerLoop() {
  while (!stopping) {
    const leader = await pool.connect();
    let sessionLost = false;
    const onError = () => { sessionLost = true; stopping = true; };
    leader.on("error", onError);
    try {
      const locked = (await leader.query("SELECT pg_try_advisory_lock(58469321) AS locked")).rows[0].locked;
      if (!locked) { await new Promise(r => setTimeout(r, 1000)); continue; }
      await interruptOrphanedRuns();
      while (!stopping && !sessionLost) {
        const run = await transaction(async db => {
          const q = await db.query("SELECT * FROM radar_runs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
          if (!q.rowCount) return null;
          const token = randomUUID();
          await db.query("UPDATE radar_runs SET state='running',worker_token=$2 WHERE id=$1", [q.rows[0].id, token]);
          return { ...q.rows[0], worker_token: token };
        });
        if (!run) { await new Promise(r => setTimeout(r, 400)); continue; }
        try { await processRun(run); } catch (e) {
          // If persistence is unavailable, leave running for explicit recovery once connectivity returns.
          console.error("Run processing stopped", run.id, errorInfo(e));
          break;
        }
      }
      await leader.query("SELECT pg_advisory_unlock(58469321)").catch(() => {});
    } catch (e) { console.error("Worker unavailable", errorInfo(e)); await new Promise(r => setTimeout(r, 2000)); }
    finally {
      leader.off("error", onError);
      leader.release(sessionLost);
    }
    if (sessionLost) process.exit(1);
  }
}
