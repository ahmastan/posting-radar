import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", e => errors.push(e.message));
const out = "../../generated-artifacts";
await mkdir(out, { recursive: true });
try {
  await page.goto(`${base}/user-portal`);
  await page.getByRole("button", { name: "Run sweep on 2 sources" }).waitFor({ timeout: 30000 });
  const account = await page.evaluate(() => fetch("/api/me").then(r => r.json()));
  assert.equal(account.isGuest, true);
  assert.equal(account.guestSessionAvailable, true);
  await page.goto(`${base}/preferences`);
  await page.getByLabel("One per line. Empty means anywhere.", { exact: false }).count(); // use stable field IDs below
  await page.locator("#locs").fill("Chicago, IL");
  await page.getByRole("button", { name: /Save revision/ }).click();
  await page.getByText(/Saved as revision/).waitFor();
  await page.reload();
  await page.locator("#locs").waitFor();
  assert.equal(await page.locator("#locs").inputValue(), "Chicago, IL");
  await page.goto(`${base}/user-portal`);
  await page.getByRole("button", { name: "Run sweep on 2 sources" }).click();
  await page.getByText("Run", { exact: true }).first().count();
  // Request runs through UI; retrieve its actual ID through the same anonymous cookie.
  await page.waitForFunction(async () => (await (await fetch("/api/runs")).json()).length > 0, { timeout: 15000 });
  const id = await page.evaluate(async () => (await (await fetch("/api/runs")).json())[0].id);
  await page.reload(); // the durable server worker must keep running
  let run: any;
  const deadline = Date.now() + 180000;
  do {
    run = await page.evaluate(async runId => (await (await fetch(`/api/runs/${runId}`)).json()), id);
    if (["succeeded", "degraded", "failed", "interrupted"].includes(run.state)) break;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  assert(["succeeded", "degraded"].includes(run.state), JSON.stringify({ state: run.state, sourceResults: run.sourceResults }));
  assert(run.matches.length > 0, "Real README should contain Chicago matches");
  assert.equal(run.results.length, 0);
  assert.equal(run.totals.inserted, 0);
  const replay = await page.evaluate(async runId => (await (await fetch(`/api/runs/${runId}/replay`)).json()), id);
  assert(replay.events.some((e: any) => e.step === "fetch" && e.phase === "succeeded"));
  assert(replay.events.some((e: any) => e.step === "save" && e.phase === "succeeded"));
  assert(replay.events.filter((e: any) => e.phase === "succeeded").every((e: any) => e.durationMs >= 0));
  await page.getByRole("heading", { name: "Observed matches" }).waitFor();
  await page.screenshot({ path: `${out}/guest-radar-desktop.jpg`, fullPage: false });
  const tracker = await page.evaluate(async () => ({ status: (await fetch("/api/tracker")).status }));
  assert.equal(tracker.status, 401);
  await page.goto(`${base}/history?run=${id}`);
  await page.getByRole("button", { name: "Pause replay" }).waitFor();
  await page.getByRole("button", { name: "Pause replay" }).click();
  await page.getByRole("button", { name: "Resume replay" }).click();
  await page.getByRole("button", { name: "Restart" }).click();
  await page.getByRole("radio", { name: "4x", exact: true }).click();
  const mutations: string[] = [];
  const watch = (r: any) => { if (r.url().includes("/api/") && !["GET", "HEAD"].includes(r.method())) mutations.push(r.url()); };
  page.on("request", watch);
  await page.waitForTimeout(4000);
  page.off("request", watch);
  assert.deepEqual(mutations, [], "Replay must be read-only");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/preferences", "/tracker", `/history?run=${id}`, "/how-it-works"]) {
    await page.goto(`${base}${route}`);
    await page.waitForTimeout(1300);
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert(dimensions.scroll <= dimensions.client + 1, `${route} overflows: ${JSON.stringify(dimensions)}`);
    assert(!(await page.getByText("Something went wrong", { exact: false }).count()));
  }
  await page.screenshot({ path: `${out}/guest-replay-mobile.jpg`, fullPage: false });
  const second = await browser.newContext();
  const stranger = await second.newPage();
  await stranger.goto(`${base}/user-portal`);
  await stranger.getByRole("button", { name: "Run sweep on 2 sources" }).waitFor();
  const isolated = await stranger.evaluate(async runId => ({ runs: await (await fetch("/api/runs")).json(), otherRunStatus: (await fetch(`/api/runs/${runId}/replay`)).status }), id);
  assert.equal(isolated.runs.length, 0);
  assert.equal(isolated.otherRunStatus, 404);
  await second.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ outcome: "passed", runId: id, state: run.state, observedMatches: run.matches.length, parsed: run.totals.parsed, events: replay.events.length, noReplayMutations: true, phoneLayouts: true, guestIsolation: true }));
} finally { await ctx.close(); await browser.close(); }
