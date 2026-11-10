import { performance } from "node:perf_hooks";
import type { RunEvent } from "../src/lib/api.js";
import { pool, transaction, type Db } from "./db.js";
export class LostClaim extends Error {}
export type EventInput = Pick<RunEvent, "step" | "phase" | "summary"> & Partial<Omit<RunEvent, "runId" | "sequence" | "schemaVersion">>;
export class Events {
  constructor(public runId: string, private started = performance.now(), private token?: string) {}
  async append(input: EventInput, db?: Db): Promise<RunEvent> {
    const write = async (conn: Db) => {
      const result = await conn.query(
        "UPDATE radar_runs SET next_sequence=next_sequence+1 WHERE id=$1 AND ($2::uuid IS NULL OR (worker_token=$2 AND state='running')) RETURNING next_sequence",
        [this.runId, this.token || null]
      );
      if (!result.rowCount) throw new LostClaim("Run is no longer owned by this worker.");
      const event: RunEvent = {
        schemaVersion: 1, runId: this.runId, sequence: result.rows[0].next_sequence,
        timestamp: new Date().toISOString(), elapsedRunMs: Math.round((performance.now() - this.started) * 1000) / 1000,
        fromLayer: "Server", toLayer: "Server", attempt: 1, ...input
      };
      await conn.query("INSERT INTO radar_events(run_id,sequence,payload) VALUES($1,$2,$3)", [this.runId, event.sequence, event]);
      return event;
    };
    return db ? write(db) : transaction(write);
  }
  async step<T>(step: string, sourceId: string | undefined, fromLayer: RunEvent["fromLayer"], toLayer: RunEvent["toLayer"],
    fn: () => Promise<{ value: T; summary: string; counts?: Record<string, number>; dataOrigin?: "live" | "cache"; recovery?: Record<string, unknown> }>,
    options: { attempt?: number; phase?: RunEvent["phase"] } = {}
  ): Promise<T> {
    const start = performance.now();
    const common = { step, sourceId, fromLayer, toLayer, attempt: options.attempt || 1 };
    await this.append({ ...common, phase: "started", summary: `Starting ${step}` });
    try {
      const { value, ...result } = await fn();
      await this.append({ ...common, ...result, phase: options.phase || "succeeded", durationMs: performance.now() - start });
      return value;
    } catch (e) {
      if (e instanceof LostClaim) throw e;
      await this.append({ ...common, phase: "failed", durationMs: performance.now() - start, summary: errorInfo(e).message, error: errorInfo(e) });
      throw e;
    }
  }
  async skip(step: string, sourceId: string, reason: string) {
    const start = performance.now();
    await this.append({ step, sourceId, phase: "started", summary: `Evaluating ${step}` });
    await this.append({ step, sourceId, phase: "skipped", summary: reason, durationMs: performance.now() - start });
  }
}
export function errorInfo(e: unknown) {
  const err = e as { code?: string; message?: string };
  return { code: typeof err?.code === "string" ? err.code : "PROCESSING_FAILED", message: err?.message || "Unexpected processing failure" };
}
export async function readEvents(runId: string, after = 0) {
  const { rows } = await pool.query("SELECT payload FROM radar_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence", [runId, after]);
  return rows.map(r => r.payload as RunEvent);
}
