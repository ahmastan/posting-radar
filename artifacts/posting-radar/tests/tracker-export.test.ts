import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { pool } from "../server/db.js";
import { ensureUser, createRun, HttpError } from "../server/store.js";
import { createRouter } from "../server/routes.js";
import { trackerCsv, type ExportEntry } from "../server/tracker-export.js";
import { createServer } from "node:http";

const schema = `radar_export_test_${randomUUID().replaceAll("-", "")}`;
pool.options.options = `-c search_path=${schema}`;
const app = express();
// Test-only auth fixture on an isolated HTTP server, never the running app.
app.use((req, _res, next) => {
  req.auth = Object.assign(
    () => ({ userId: req.get("test-account") || null, tokenType: "session_token" }),
    { [Symbol.for("@clerk/express.auth")]: true }
  ) as typeof req.auth;
  next();
});
app.use("/api", createRouter());
const errors: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500).json({ error: err.message });
};
app.use(errors);
const server = createServer(app);
let base: string;
before(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  for (const user of ["export-owner", "other-owner", "empty-owner"]) {
    await ensureUser(user);
    const run = await createRun(user, ["internships"], `export-seed-${user}`, 1);
    if (user === "empty-owner") continue;
    for (let i = 0; i < 35; i++) {
      const identity = `${user}-${i}`;
      const posting = { identity, company: user === "other-owner" ? "PRIVATE" : `Company ${i}`, role: "Engineer",
        locations: ["Montréal, QC", "Remote"], url: `https://example.com/${identity}`, postedAt: i === 0 ? undefined : "2026-11-10" };
      await pool.query("INSERT INTO radar_postings(identity,payload,fingerprint) VALUES($1,$2,$1)", [identity, posting]);
      await pool.query(`INSERT INTO radar_tracker(id,user_id,identity,source_id,season,discovered_run,reasons,data_origin,status)
        VALUES($1,$2,$3,$4,'2027',$5,'[]','live',$6)`,
      [randomUUID(), user, identity, i % 2 ? "new-grad" : "internships", run, ["saved", "applied", "skipped"][i % 3]]);
    }
  }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});
function request(path: string, user = "export-owner") {
  return fetch(`${base}${path}`, { headers: user ? { "test-account": user } : {} });
}
test("export downloads every matching row with metadata, without other accounts", async () => {
  const response = await request("/tracker/export");
  assert.equal(response.status, 200, response.ok ? "" : await response.text());
  assert.match(response.headers.get("content-type")!, /text\/csv; charset=utf-8/);
  assert.match(response.headers.get("content-disposition")!, /attachment; filename="posting-radar-tracker-all-.*\.csv"/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const csv = await response.text();
  assert.equal(csv.trimEnd().split("\r\n").length, 36);
  assert(!csv.includes("PRIVATE"));
  assert(csv.includes("Montréal, QC; Remote"));
  assert(csv.includes('"Created at","Updated at"'));
  assert.match(csv, /"\d{4}-\d{2}-\d{2}T[^"]+Z"/);
  const listed = await (await request("/tracker")).json();
  assert.equal(listed.entries.length, 30);
});
test("all status choices, source, search and ordering match the tracker", async () => {
  for (const status of ["saved", "applied", "skipped"]) {
    const query = new URLSearchParams({ status, source: "internships", search: "Company 1", sort: "posted-asc" });
    const listed = await (await request(`/tracker?${query}`)).json();
    const csv = await (await request(`/tracker/export?${query}`)).text();
    const lines = csv.trimEnd().split("\r\n").slice(1);
    assert.equal(lines.length, listed.total);
    for (const [index, row] of lines.entries()) {
      assert(row.startsWith(`"${listed.entries[index].posting.company}",`));
      assert(row.includes(`"${status}"`));
    }
  }
});
test("empty exports retain headers and invalid filters are rejected", async () => {
  const response = await request("/tracker/export", "empty-owner");
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trimEnd().split("\r\n").length, 1);
  assert.equal((await request("/tracker/export?status=unknown")).status, 400);
  assert.equal((await request("/tracker/export?sort=unknown")).status, 400);
});
test("anonymous and guest sessions cannot export a tracker", async () => {
  assert.equal((await request("/tracker/export", "")).status, 401);
  const init = await request("/me", "");
  const cookie = init.headers.get("set-cookie")!;
  assert(cookie);
  const response = await fetch(`${base}/tracker/export`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(response.status, 401);
});
test("CSV preserves special characters and protects spreadsheet cells", () => {
  const entry = {
    posting: { company: '=HYPERLINK("bad")', role: "Quoted \"role\"\nsecond line", locations: ["東京", "Paris, France"], url: "https://example.org" },
    sourceId: "removed-source", season: "@unsafe", status: "saved", createdAt: "2026-11-01T00:00:00Z", updatedAt: new Date("2026-11-02T00:00:00Z")
  } as ExportEntry;
  const csv = trackerCsv([entry], new Map());
  assert(csv.startsWith("\uFEFF"));
  assert(csv.includes(`"'=HYPERLINK(""bad"")"`));
  assert(csv.includes('"Quoted ""role""\nsecond line"'));
  assert(csv.includes('"東京; Paris, France"'));
  assert(csv.includes('"removed-source"'));
  assert(csv.includes(`"'@unsafe"`));
  assert(csv.includes('"2026-11-02T00:00:00.000Z"'));
  assert(csv.includes('"saved","","2026'));
});
