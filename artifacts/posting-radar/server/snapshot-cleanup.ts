import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db } from "./db.js";

type Mapping = {
  removedId: string; retainedId: string; sourceId: string; parserVersion: number;
  fetchedAt: string; etag: string | null; lastModified: string | null; contentHash: string;
  estimatedContentBytes: number;
};
type CursorReference = { userId: string; sourceId: string; snapshotId: string; processedAt: string };
type RunReference = { runId: string; sourceId: string; baselineId: string | null; candidateId: string | null; result: Record<string, unknown> };
export type CleanupPlan = {
  version: 1; mappings: Mapping[]; cursors: CursorReference[]; runSources: RunReference[];
  summary: { redundantSnapshots: number; retainedSnapshots: number; cursorReferences: number;
    baselineReferences: number; candidateReferences: number; resultReferences: number; estimatedContentBytes: number };
};
const digest = (plan: CleanupPlan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

async function planCleanup(db: Db): Promise<CleanupPlan> {
  const mappings: Mapping[] = (await db.query(`
    WITH ranked AS (
      SELECT *, first_value(id) OVER (
        PARTITION BY source_id,parser_version,content_hash,raw,rows
        ORDER BY fetched_at DESC,id DESC) AS retained_id
      FROM radar_snapshots WHERE validated
    )
    SELECT id AS "removedId",retained_id AS "retainedId",source_id AS "sourceId",
      parser_version AS "parserVersion",fetched_at::text AS "fetchedAt",etag,
      last_modified AS "lastModified",content_hash AS "contentHash",
      octet_length(raw)::float8 + octet_length(rows::text)::float8 AS "estimatedContentBytes"
    FROM ranked WHERE id<>retained_id ORDER BY id`)).rows;
  const ids = mappings.map(m => m.removedId);
  const cursors: CursorReference[] = (await db.query(`
    SELECT user_id AS "userId",source_id AS "sourceId",snapshot_id AS "snapshotId",processed_at::text AS "processedAt"
    FROM radar_cursors WHERE snapshot_id=ANY($1::uuid[]) ORDER BY user_id,source_id`, [ids])).rows;
  const runSources: RunReference[] = (await db.query(`
    SELECT run_id AS "runId",source_id AS "sourceId",baseline_id AS "baselineId",candidate_id AS "candidateId",result
    FROM radar_run_sources WHERE baseline_id=ANY($1::uuid[]) OR candidate_id=ANY($1::uuid[])
      OR result->>'baselineSnapshotId'=ANY($2::text[]) OR result->>'candidateSnapshotId'=ANY($2::text[])
    ORDER BY run_id,source_id`, [ids, ids])).rows;
  const removed = new Set(ids);
  return {
    version: 1, mappings, cursors, runSources,
    summary: {
      redundantSnapshots: mappings.length, retainedSnapshots: new Set(mappings.map(m => m.retainedId)).size,
      cursorReferences: cursors.length,
      baselineReferences: runSources.filter(r => r.baselineId && removed.has(r.baselineId)).length,
      candidateReferences: runSources.filter(r => r.candidateId && removed.has(r.candidateId)).length,
      resultReferences: runSources.reduce((n, r) => n + ["baselineSnapshotId", "candidateSnapshotId"]
        .filter(key => removed.has(String(r.result[key]))).length, 0),
      estimatedContentBytes: mappings.reduce((n, m) => n + m.estimatedContentBytes, 0),
    },
  };
}

/**
 * Operator-only, never called by ingestion or HTTP routes. Default is dry-run.
 * Approval must be the hash returned by a reviewed dry-run; no wildcard approval.
 * Table locks plus the active-run check protect in-memory worker snapshot IDs.
 */
export async function cleanupDuplicateSnapshots(approval?: { planHash: string; approvedBy: string }) {
  if (approval && (!/^[a-f0-9]{64}$/.test(approval.planHash) || !approval.approvedBy.trim())) {
    throw new Error("Explicit approval requires the dry-run hash and an approver.");
  }
  return transaction(async db => {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='60s'");
    await db.query("LOCK TABLE radar_runs,radar_snapshots,radar_cursors,radar_run_sources IN SHARE ROW EXCLUSIVE MODE");
    if ((await db.query("SELECT 1 FROM radar_runs WHERE state IN ('queued','running') LIMIT 1")).rowCount) {
      throw new Error("Cleanup requires no queued or running checks. Pause new checks and drain the worker first.");
    }
    const plan = await planCleanup(db);
    const planHash = digest(plan);
    if (!approval) return { mode: "dry-run" as const, planHash, summary: plan.summary, mappings: plan.mappings };
    if (approval.planHash !== planHash) throw new Error("Cleanup plan changed. Review a new dry-run before approving.");
    if (!plan.mappings.length) return { mode: "applied" as const, planHash, summary: plan.summary, cleanupId: null };
    const cleanupId = randomUUID();
    // Original reference results and removed HTTP metadata are retained for audit.
    // Raw/parsed bodies are not copied: their exact equivalent remains retained.
    await db.query(`INSERT INTO radar_snapshot_cleanups(id,approved_plan_hash,approved_by,plan)
      VALUES($1,$2,$3,$4)`, [cleanupId, planHash, approval.approvedBy.trim(), JSON.stringify(plan)]);
    const map = JSON.stringify(Object.fromEntries(plan.mappings.map(m => [m.removedId, m.retainedId])));
    await db.query(`UPDATE radar_cursors SET snapshot_id=($1::jsonb->>snapshot_id::text)::uuid
      WHERE $1::jsonb ? snapshot_id::text`, [map]);
    await db.query(`UPDATE radar_run_sources SET
      baseline_id=COALESCE(($1::jsonb->>baseline_id::text)::uuid,baseline_id),
      candidate_id=COALESCE(($1::jsonb->>candidate_id::text)::uuid,candidate_id),
      result=result
        || CASE WHEN $1::jsonb ? (result->>'baselineSnapshotId')
          THEN jsonb_build_object('baselineSnapshotId',$1::jsonb->>(result->>'baselineSnapshotId')) ELSE '{}'::jsonb END
        || CASE WHEN $1::jsonb ? (result->>'candidateSnapshotId')
          THEN jsonb_build_object('candidateSnapshotId',$1::jsonb->>(result->>'candidateSnapshotId')) ELSE '{}'::jsonb END
      WHERE $1::jsonb ? baseline_id::text OR $1::jsonb ? candidate_id::text
        OR $1::jsonb ? (result->>'baselineSnapshotId') OR $1::jsonb ? (result->>'candidateSnapshotId')`, [map]);
    const deleted = await db.query("DELETE FROM radar_snapshots WHERE id=ANY($1::uuid[])", [plan.mappings.map(m => m.removedId)]);
    if (deleted.rowCount !== plan.mappings.length) throw new Error("Snapshot count changed; cleanup rolled back.");
    return { mode: "applied" as const, planHash, summary: plan.summary, cleanupId };
  });
}
