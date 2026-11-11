import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool, transaction } from "./db.js";
import { resolveSource } from "./user-sources.js";
import { Events, errorInfo, LostClaim } from "./events.js";
import { fetchSource, type Snapshot } from "./ingestion.js";
import { parseReadme, matchPosting, hash, PARSER_VERSION } from "./parser.js";
import { assertClaim } from "./store.js";
import type { Posting, Preferences, SourceResult } from "../src/lib/api.js";
export async function processRun(run: { id: string; user_id: string; preferences: Preferences; requested_sources: string[]; worker_token: string; created_at?: string },
  transport: typeof fetch = fetch
) {
  const events = new Events(run.id, performance.now() - (run.created_at ? Math.max(0, Date.now() - new Date(run.created_at).getTime()) : 0), run.worker_token);
  const results: SourceResult[] = [];
  const isGuest = run.user_id.startsWith("guest:");
  await events.step("worker", undefined, "Database", "Server", async () => ({ value: null, summary: "Durable queued request claimed by worker" }));
  for (const sourceId of run.requested_sources) {
    const source = await resolveSource(run.user_id, sourceId);
    if (!source) {
      const error = { code: "SOURCE_REMOVED", message: "This source was removed before the run reached it." };
      await events.append({ sourceId, step: "baseline", phase: "failed", fromLayer: "Database", toLayer: "Server", summary: error.message, error });
      for (const step of ["fetch", "parse", "snapshot", "diff", "filter", "dedupe", "save"]) await events.skip(step, sourceId, "Skipped because the source no longer exists");
      const result: SourceResult = { sourceId, outcome: "failed", counts: { inserted: 0 }, error };
      await transaction(async db => {
        await assertClaim(db, run.id, run.worker_token);
        await db.query("UPDATE radar_run_sources SET result=$3 WHERE run_id=$1 AND source_id=$2", [run.id, sourceId, result]);
      });
      results.push(result);
      continue;
    }
    let failedStep = "baseline";
    let saveStart = 0;
    let counts: Record<string, number> = {};
    try {
      const { cached, baselineId, baseline } = await events.step("baseline", sourceId, "Database", "Server", async () => {
        const r = (await pool.query("SELECT baseline_id FROM radar_run_sources WHERE run_id=$1 AND source_id=$2", [run.id, sourceId])).rows[0];
        const baselineRows: Posting[] = r.baseline_id ? (await pool.query("SELECT rows FROM radar_snapshots WHERE id=$1", [r.baseline_id])).rows[0].rows : [];
        const cache = (await pool.query("SELECT * FROM radar_snapshots WHERE source_id=$1 AND validated AND parser_version=$2 ORDER BY fetched_at DESC LIMIT 1", [sourceId, PARSER_VERSION])).rows[0] as Snapshot | undefined;
        return { value: { cached: cache, baselineId: r.baseline_id, baseline: baselineRows }, summary: r.baseline_id ? "Loaded this account's captured baseline and shared validated cache" : "Initial import — no previous successful baseline", counts: { baselineRows: baselineRows.length } };
      });
      failedStep = "fetch";
      const downloaded = await fetchSource(source, cached, events, transport);
      failedStep = "parse";
      const parsed = await events.step("parse", sourceId, "Server", "Server", async () => {
        const rows = parseReadme(downloaded.raw);
        return { value: rows, summary: `Parsed ${rows.length} rows; ${rows.filter(p => p.closed).length} closed`, counts: { parsed: rows.length, closed: rows.filter(p => p.closed).length, ambiguous: rows.filter(p => p.ambiguous).length }, dataOrigin: downloaded.dataOrigin };
      });
      counts.parsed = parsed.length;
      failedStep = "snapshot";
      const snapshotId = await events.step("snapshot", sourceId, "Server", "Database", async () => {
        if (downloaded.dataOrigin === "cache") return { value: cached!.id, summary: "Kept last validated snapshot; no fresh download claimed", dataOrigin: "cache" as const };
        const id = randomUUID();
        await pool.query(`INSERT INTO radar_snapshots(id,source_id,content_hash,raw,rows,parser_version,etag,last_modified)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, sourceId, hash(downloaded.raw), downloaded.raw, JSON.stringify(parsed), PARSER_VERSION, downloaded.etag || null, downloaded.lastModified || null]);
        return { value: id, summary: "Validated snapshot saved for audit and future recovery", dataOrigin: "live" as const };
      });
      failedStep = "diff";
      const candidates = await events.step("diff", sourceId, "Database", "Server", async () => {
        const seen = new Set((await pool.query("SELECT identity FROM radar_seen WHERE user_id=$1 AND source_id=$2", [run.user_id, sourceId])).rows.map(r => r.identity));
        const baselineSet = new Set(baseline.map(p => p.identity));
        const unique = [...new Map(parsed.map(p => [p.identity, p])).values()];
        const fresh = unique.filter(p => !baselineSet.has(p.identity) && !seen.has(p.identity));
        counts = { ...counts, newSinceBaseline: fresh.length };
        return { value: fresh, summary: `${fresh.length} new observations${!baselineId ? " — initial import" : ""}; changed or previously seen rows are not new`, counts: { newSinceBaseline: fresh.length, existingOrReappearing: unique.length - fresh.length }, dataOrigin: downloaded.dataOrigin };
      });
      failedStep = "filter";
      const matched = await events.step("filter", sourceId, "Server", "Server", async () => {
        const rows = candidates.map(posting => ({ posting, ...matchPosting(posting, run.preferences) })).filter(x => x.matches);
        counts = { ...counts, matched: rows.length, excluded: candidates.length - rows.length };
        return { value: rows, summary: `${rows.length} match frozen preferences; ${counts.excluded} excluded`, counts: { matched: rows.length, excluded: counts.excluded }, dataOrigin: downloaded.dataOrigin };
      });
      failedStep = "dedupe";
      const uniqueMatches = await events.step("dedupe", sourceId, "Database", "Server", async () => {
        const tracked = new Set((await pool.query(`SELECT identity FROM radar_tracker WHERE user_id=$1 AND identity=ANY($2::text[])
          UNION SELECT identity FROM radar_run_matches WHERE run_id=$3 AND identity=ANY($2::text[])`, [run.user_id, matched.map(m => m.posting.identity), run.id])).rows.map(r => r.identity));
        const rows = matched.filter(m => !tracked.has(m.posting.identity));
        counts.alreadyTracked = isGuest ? 0 : matched.length - rows.length;
        if (isGuest) counts.alreadyObserved = matched.length - rows.length;
        return { value: rows, summary: `${matched.length - rows.length} ${isGuest ? "already observed in this run" : "already tracked"}; ${rows.length} unique matches ready`, counts: { alreadyTracked: counts.alreadyTracked, ...(isGuest ? { alreadyObserved: counts.alreadyObserved } : {}), uniqueMatches: rows.length } };
      });
      failedStep = "save";
      const start = performance.now();
      saveStart = start;
      await events.append({ sourceId, step: "save", phase: "started", fromLayer: "Server", toLayer: "Database", summary: "Saving matches and source progress in one transaction" });
      const result = await transaction(async db => {
        await assertClaim(db, run.id, run.worker_token);
        for (const p of parsed) {
          // Global posting updates never change user status or ownership.
          await db.query(`INSERT INTO radar_postings(identity,payload,fingerprint) VALUES($1,$2,$3)
            ON CONFLICT(identity) DO UPDATE SET payload=EXCLUDED.payload,fingerprint=EXCLUDED.fingerprint,last_seen=now()`, [p.identity, p, hash(JSON.stringify(p))]);
        }
        let inserted = 0;
        for (const m of uniqueMatches) {
          await db.query(`INSERT INTO radar_run_matches(id,run_id,identity,posting,source_id,season,reasons,data_origin)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id,identity) DO NOTHING`,
            [randomUUID(), run.id, m.posting.identity, m.posting, sourceId, source.season, JSON.stringify(m.reasons), downloaded.dataOrigin]);
          if (isGuest) continue;
          const row = await db.query(`INSERT INTO radar_tracker(id,user_id,identity,source_id,season,discovered_run,reasons,data_origin)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,identity) DO NOTHING`, [randomUUID(), run.user_id, m.posting.identity, sourceId, source.season, run.id, JSON.stringify(m.reasons), downloaded.dataOrigin]);
          inserted += row.rowCount || 0;
        }
        if (downloaded.dataOrigin === "live") {
          await db.query(`INSERT INTO radar_seen(user_id,source_id,identity)
            SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`, [run.user_id, sourceId, parsed.map(p => p.identity)]);
          await db.query(`INSERT INTO radar_cursors(user_id,source_id,snapshot_id) VALUES($1,$2,$3)
            ON CONFLICT(user_id,source_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,processed_at=now()`, [run.user_id, sourceId, snapshotId]);
        }
        counts.inserted = inserted;
        if (isGuest) counts.guestMatches = uniqueMatches.length;
        const result: SourceResult = { sourceId, outcome: downloaded.dataOrigin === "cache" ? "degraded" : "succeeded", initialImport: !baselineId,
          dataOrigin: downloaded.dataOrigin, cachedAt: downloaded.cachedAt, counts, error: downloaded.fetchError,
          baselineSnapshotId: baselineId, candidateSnapshotId: snapshotId };
        await db.query("UPDATE radar_run_sources SET candidate_id=$3,result=$4 WHERE run_id=$1 AND source_id=$2", [run.id, sourceId, snapshotId, result]);
        await events.append({ sourceId, step: "save", phase: "succeeded", fromLayer: "Server", toLayer: "Database", dataOrigin: downloaded.dataOrigin,
          durationMs: performance.now() - start, counts: { inserted, cursorAdvanced: downloaded.dataOrigin === "live" ? 1 : 0 },
          summary: `${isGuest ? `Retained ${uniqueMatches.length} guest matches; sign in to save to tracker` : `Saved ${inserted} unique matches`}; ${downloaded.dataOrigin === "live" ? "baseline advanced" : "cached observations only — fresh baseline unchanged"}` }, db);
        return result;
      });
      results.push(result);
    } catch (e) {
      if (e instanceof LostClaim) throw e;
      const error = errorInfo(e);
      if (failedStep === "save") {
        await events.append({ sourceId, step: "save", phase: "failed", fromLayer: "Server", toLayer: "Database", summary: `Save transaction rolled back: ${error.message}`, error, durationMs: performance.now() - saveStart });
      }
      const order = ["baseline", "fetch", "parse", "snapshot", "diff", "filter", "dedupe", "save"];
      for (const step of order.slice(order.indexOf(failedStep) + 1)) await events.skip(step, sourceId, `Skipped because ${failedStep} failed`);
      const result: SourceResult = { sourceId, outcome: "failed", counts: { ...counts, inserted: 0 }, error };
      await transaction(async db => {
        await assertClaim(db, run.id, run.worker_token);
        await db.query("UPDATE radar_run_sources SET result=$3 WHERE run_id=$1 AND source_id=$2", [run.id, sourceId, result]);
      });
      results.push(result);
    }
  }
  const totals: Record<string, number> = {};
  for (const r of results) for (const [key, value] of Object.entries(r.counts || {})) totals[key] = (totals[key] || 0) + value;
  const state = results.every(r => r.outcome === "failed") ? "failed" : results.every(r => r.outcome === "succeeded") ? "succeeded" : "degraded";
  const start = performance.now();
  await events.append({ step: "results", phase: "started", fromLayer: "Database", toLayer: "Page", summary: "Preparing persisted run results" });
  await transaction(async db => {
    await assertClaim(db, run.id, run.worker_token);
    await events.append({ step: "results", phase: state === "failed" ? "failed" : "succeeded", fromLayer: "Server", toLayer: "Page",
      summary: `Run ${state}: ${isGuest ? `${totals.guestMatches || 0} guest matches; nothing saved to an account` : `${totals.inserted || 0} saved`}${state === "degraded" ? " — review source warnings" : ""}`,
      counts: totals, durationMs: performance.now() - start }, db);
    await db.query("UPDATE radar_runs SET state=$2,totals=$3,finished_at=now() WHERE id=$1", [run.id, state, totals]);
  });
}
