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
const oldModified = "Mon, 09 Nov 2026 12:00:00 GMT";
const newModified = "Tue, 10 Nov 2026 12:00:00 GMT";
for (const scenario of [
  { name: "both validators changed", headers: { etag: '"new"', "last-modified": newModified }, etag: '"new"', lastModified: newModified },
  { name: "both validators omitted", headers: {}, etag: '"old"', lastModified: oldModified },
  { name: "only ETag changed", headers: { etag: '"new"' }, etag: '"new"', lastModified: oldModified },
  { name: "only Last-Modified changed", headers: { "last-modified": newModified }, etag: '"old"', lastModified: newModified }
]) {
  test(`304 refreshes supplied validators and retains omitted ones: ${scenario.name}`, async () => {
    const snapshot: Snapshot = { ...cache, last_modified: oldModified };
    const requests: Headers[] = [];
    const transport = (async (_url: unknown, options: RequestInit) => {
      requests.push(new Headers(options.headers));
      return new Response(null, { status: 304, headers: requests.length === 1 ? scenario.headers as HeadersInit : {} });
    }) as typeof fetch;
    const result = await fetchSource(sources[0], snapshot, fakeEvents() as unknown as Events, transport);
    assert.equal(result.etag, scenario.etag);
    assert.equal(result.lastModified, scenario.lastModified);
    assert.equal(result.raw, snapshot.raw);
    assert.equal(result.dataOrigin, "live");
    assert.equal(result.revalidated, true);
    assert.equal(result.fetchError, undefined);
    assert.equal(requests[0].get("if-none-match"), snapshot.etag);
    assert.equal(requests[0].get("if-modified-since"), oldModified);

    // Apply the download's metadata as the pipeline does when reusing a snapshot.
    const refreshed: Snapshot = { ...snapshot, etag: result.etag, last_modified: result.lastModified };
    const next = await fetchSource(sources[0], refreshed, fakeEvents() as unknown as Events, transport);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].get("if-none-match"), scenario.etag);
    assert.equal(requests[1].get("if-modified-since"), scenario.lastModified);
    assert.equal(next.etag, scenario.etag);
    assert.equal(next.lastModified, scenario.lastModified);
    assert.equal(next.raw, snapshot.raw);
  });
}
test("network exhaustion without cache fails, 404 gets no retry, invalid HTML not validated here", async () => {
  let calls = 0;
  await assert.rejects(fetchSource(sources[0], undefined, fakeEvents() as unknown as Events, (async () => { calls++; throw new Error("network"); }) as typeof fetch, async () => {}));
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(fetchSource(sources[0], undefined, fakeEvents() as unknown as Events, (async () => { calls++; return new Response("", { status: 404 }); }) as typeof fetch));
  assert.equal(calls, 1);
});
