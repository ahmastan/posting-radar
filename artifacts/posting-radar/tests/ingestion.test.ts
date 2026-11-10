import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSource, type Snapshot } from "../server/ingestion.js";
import { sources } from "../server/config.js";
import type { Events } from "../server/events.js";
function fakeEvents() {
  const log: {step: string; phase: string; [key: string]: unknown}[] = [];
  return { log, step: async (step: string, _s: unknown, _f: unknown, _t: unknown, fn: () => Promise<any>, options: any = {}) => {
    log.push({ step, phase: "started" });
    try { const result = await fn(); log.push({ step, phase: options.phase || "succeeded", ...result }); return result.value; }
    catch (e) { log.push({ step, phase: "failed" }); throw e; }
  } };
}
const cache: Snapshot = { id: "snapshot", raw: "validated body", rows: [], fetched_at: "2026-01-01T00:00:00Z", etag: '"old"' };
test("one bounded retry then validated cache with visible original failure and age", async () => {
  const events = fakeEvents(); let calls = 0; const waits: number[] = [];
  const transport = (async () => { calls++; return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }); }) as typeof fetch;
  const result = await fetchSource(sources[0], cache, events as unknown as Events, transport, async n => { waits.push(n); });
  assert.equal(calls, 2); assert.deepEqual(waits, [0]);
  assert.equal(result.dataOrigin, "cache"); assert.equal(result.fetchError?.code, "GITHUB_429");
  assert.equal(events.log.filter(e => e.step === "fetch" && e.phase === "failed").length, 2);
  assert(events.log.some(e => e.step === "cache" && e.phase === "recovered"));
});
test("304 is successful live revalidation; headers sent only with validated cache", async () => {
  let headers: HeadersInit | undefined;
  const transport = (async (_url: unknown, options: RequestInit) => { headers = options.headers; return new Response(null, { status: 304 }); }) as typeof fetch;
  const result = await fetchSource(sources[0], cache, fakeEvents() as unknown as Events, transport);
  assert.equal(result.dataOrigin, "live"); assert.equal(result.revalidated, true); assert.equal(result.raw, cache.raw);
  assert.equal(new Headers(headers).get("if-none-match"), '"old"');
});
test("network exhaustion without cache fails, 404 gets no retry, invalid HTML not validated here", async () => {
  let calls = 0;
  await assert.rejects(fetchSource(sources[0], undefined, fakeEvents() as unknown as Events, (async () => { calls++; throw new Error("network"); }) as typeof fetch, async () => {}));
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(fetchSource(sources[0], undefined, fakeEvents() as unknown as Events, (async () => { calls++; return new Response("", { status: 404 }); }) as typeof fetch));
  assert.equal(calls, 1);
});
