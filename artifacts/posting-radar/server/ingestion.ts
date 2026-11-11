import type { Posting, Source } from "../src/lib/api.js";
import type { Events } from "./events.js";
export interface Snapshot {
  id: string; raw: string; rows: Posting[]; fetched_at: string; etag?: string; last_modified?: string;
}
export interface Download {
  raw: string; dataOrigin: "live" | "cache"; revalidated: boolean;
  etag?: string; lastModified?: string; cachedAt?: string; fetchError?: {code: string; message: string};
}
export class FetchError extends Error {
  constructor(message: string, public code: string, public retryable = true, public retryAfter = 0) { super(message); }
}
export async function fetchSource(source: Source, cached: Snapshot | undefined, events: Events,
  transport: typeof fetch = fetch, wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<Download> {
  let lastError: FetchError | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await events.step<Download>("fetch", source.id, "Server", "GitHub", async () => {
        let response: Response;
        try {
          response = await transport(`https://raw.githubusercontent.com/${source.repo}/${source.branch}/${source.path}`, {
            signal: AbortSignal.timeout(10000), redirect: "error",
            headers: { "User-Agent": "PostingRadar/1.0", ...(cached?.etag ? { "If-None-Match": cached.etag } : {}), ...(cached?.last_modified ? { "If-Modified-Since": cached.last_modified } : {}) }
          });
        } catch { throw new FetchError("GitHub request failed or timed out (10 second limit).", "GITHUB_NETWORK"); }
        if (response.status === 304) {
          if (!cached) throw new FetchError("GitHub returned 304 without a validated cache.", "CACHE_MISSING", false);
          return { value: { raw: cached.raw, dataOrigin: "live" as const, revalidated: true,
            etag: response.headers.get("etag") ?? cached.etag,
            lastModified: response.headers.get("last-modified") ?? cached.last_modified },
            summary: "HTTP 304 — validated cached body successfully revalidated", counts: { httpStatus: 304, bytes: 0 }, dataOrigin: "live" as const };
        }
        if (!response.ok) {
          const value = response.headers.get("retry-after");
          const retryAfter = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now())) : 0;
          throw new FetchError(`GitHub HTTP ${response.status}${retryAfter > 2000 ? " — requested wait exceeds the 2 second retry budget" : ""}`,
            `GITHUB_${response.status}`, response.status >= 500 || [403, 408, 429].includes(response.status), retryAfter);
        }
        // Bound both downloaded bytes and total body-reading time with the request signal.
        const reader = response.body?.getReader();
        if (!reader) throw new FetchError("GitHub returned an empty response body.", "EMPTY_BODY", false);
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 12_000_000) { await reader.cancel(); throw new FetchError("GitHub README exceeds 12 MB limit.", "BODY_TOO_LARGE", false); }
          chunks.push(value);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        return { value: { raw, dataOrigin: "live" as const, revalidated: false, etag: response.headers.get("etag") || undefined, lastModified: response.headers.get("last-modified") || undefined },
          summary: `Downloaded ${size.toLocaleString()} bytes from GitHub`, counts: { bytes: size, httpStatus: response.status }, dataOrigin: "live" as const };
      }, { attempt });
    } catch (e) {
      lastError = e instanceof FetchError ? e : new FetchError((e as Error).message, "GITHUB_NETWORK");
      if (!lastError.retryable || attempt === 2) break;
      const delay = lastError.retryAfter > 2000 ? 0 : Math.max(250, lastError.retryAfter);
      await events.step("retry", source.id, "Server", "GitHub", async () => {
        await wait(delay);
        return { value: null, summary: `Retrying once after ${delay} ms${lastError!.retryAfter > 2000 ? "; long Retry-After recorded, not waited" : ""}`,
          recovery: { retryAfterMs: lastError!.retryAfter, actualWaitBudgetMs: delay }, counts: { retryAttempt: 2 } };
      }, { attempt: 2, phase: "retrying" });
    }
  }
  if (!cached) throw lastError!;
  return events.step("cache", source.id, "Database", "Server", async () => ({
    value: { raw: cached.raw, dataOrigin: "cache" as const, revalidated: false, cachedAt: new Date(cached.fetched_at).toISOString(), fetchError: { code: lastError!.code, message: lastError!.message } },
    summary: `Recovered validated cache from ${new Date(cached.fetched_at).toISOString()} — GitHub failure remains visible`,
    counts: { cacheAgeMs: Math.max(0, Date.now() - new Date(cached.fetched_at).getTime()) }, dataOrigin: "cache" as const,
    recovery: { originalFailure: { code: lastError!.code, message: lastError!.message }, cachedAt: cached.fetched_at }
  }), { phase: "recovered" });
}
