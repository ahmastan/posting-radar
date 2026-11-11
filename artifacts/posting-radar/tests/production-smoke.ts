import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const port = 23654;
const child = spawn(process.execPath, ["dist/server.mjs"], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", d => { output += d.toString(); });
child.stderr.on("data", d => { output += d.toString(); });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) throw new Error(`Production process exited: ${output}`);
    try { ready = (await fetch(`${base}/api/me`, { headers: { "X-Forwarded-Proto": "https" } })).ok; if (ready) break; } catch { /* wait for listening socket */ }
    await new Promise(r => setTimeout(r, 100));
  }
  assert(ready, `Production server did not start: ${output}`);
  const page = await fetch(`${base}/user-portal`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes('<div id="root">'));
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(asset);
  const js = await fetch(`${base}${asset}`);
  assert.equal(js.status, 200);
  assert(/javascript/.test(js.headers.get("content-type") || ""));
  const denied = await fetch(`${base}/api/runs`);
  assert.equal(denied.status, 401);
  assert(/json/.test(denied.headers.get("content-type") || ""), "API must not be rewritten to SPA HTML");
  const init = await fetch(`${base}/api/me`, { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(init.status, 200);
  const cookie = init.headers.get("set-cookie")!;
  assert(cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"));
  assert.equal((await init.json()).isGuest, true);
  const prefs = await fetch(`${base}/api/preferences`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(prefs.status, 200);
  assert.equal((await prefs.json()).revision, 1);
  assert.equal((await fetch(`${base}/api/runs/00000000-0000-4000-8000-000000000000/events`)).status, 401);
  console.log("Production bundle passed: Express API, guest session, secure cookie, private SSE checks, SPA routes, and built assets.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>(r => child.once("exit", () => r())), new Promise<void>(r => setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000))]);
}
