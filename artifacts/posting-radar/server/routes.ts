import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { pool, transaction } from "./db.js";
import { preferenceSchema } from "./config.js";
import { ensureUser, getRun, createRun, trackerSelect, HttpError } from "./store.js";
import { readEvents } from "./events.js";
import { guestOwner, createGuest } from "./guest-session.js";
import { getGuestHandoff, saveGuestMatches } from "./handoff.js";
import { addUserSource, listSources, removeUserSource } from "./user-sources.js";
const uuid = z.string().uuid();
const active = new Set(["queued", "running"]);
export function createRouter() {
  const router = Router();
  router.use("/me", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: "Too many session requests. Please try again in a minute." } }));
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    const accountId = auth?.sessionClaims?.userId || auth?.userId;
    let guestId = await guestOwner(req);
    const authenticated = typeof accountId === "string" && !!accountId;
    if (!authenticated && !guestId && req.method === "GET" && req.path === "/me") guestId = await createGuest(req, res);
    if (!authenticated && !guestId) return res.status(401).json({ error: "Initialize your browser's private guest session at /api/me, or sign in." });
    res.locals.userId = authenticated ? accountId : guestId;
    res.locals.isGuest = !authenticated;
    res.locals.guestUserId = guestId;
    next();
  });
  router.get("/sources", async (_req, res) => {
    await ensureUser(res.locals.userId);
    const r = await pool.query("SELECT source_id,max(fetched_at) AS cached_at FROM radar_snapshots WHERE validated GROUP BY source_id");
    const mine = await listSources(res.locals.userId);
    res.json(mine.map(s => ({ ...s, cachedAt: r.rows.find(x => x.source_id === s.id)?.cached_at || null })));
  });
  const customSourceSchema = z.object({
    repo: z.string().trim().min(3).max(200), branch: z.string().trim().max(100).default("main"),
    path: z.string().trim().max(200).default("README.md"), name: z.string().trim().max(120).default(""),
    season: z.string().trim().max(80).default("")
  }).strict();
  router.post("/sources/custom", async (req, res) => {
    await ensureUser(res.locals.userId);
    const body = customSourceSchema.parse(req.body);
    res.status(201).json(await addUserSource(res.locals.userId, body));
  });
  router.delete("/sources/custom/:id", async (req, res) => {
    await removeUserSource(res.locals.userId, z.string().min(1).max(40).parse(req.params.id));
    res.json({ removed: true });
  });
  router.get("/me", async (_req, res) => {
    await ensureUser(res.locals.userId);
    res.json({ id: res.locals.userId, isGuest: res.locals.isGuest, guestSessionAvailable: !!res.locals.guestUserId });
  });
  router.get("/guest/handoff", async (req, res) => {
    if (res.locals.isGuest) throw new HttpError(401, "Sign in to save guest matches to a personal tracker.");
    const runId = req.query.runId ? uuid.parse(req.query.runId) : undefined;
    res.json(await getGuestHandoff(res.locals.userId, res.locals.guestUserId, runId));
  });
  router.post("/guest/handoff", async (req, res) => {
    if (res.locals.isGuest) throw new HttpError(401, "Sign in to save guest matches to a personal tracker.");
    const body = z.object({ runId: uuid }).strict().parse(req.body);
    await ensureUser(res.locals.userId);
    res.json(await saveGuestMatches(res.locals.userId, res.locals.guestUserId, body.runId));
  });
  router.get("/preferences", async (_req, res) => {
    await ensureUser(res.locals.userId);
    const r = (await pool.query("SELECT revision,payload FROM radar_preferences WHERE user_id=$1", [res.locals.userId])).rows[0];
    res.json(preferenceSchema.parse({ ...r.payload, revision: r.revision }));
  });
  router.put("/preferences", async (req, res) => {
    await ensureUser(res.locals.userId);
    const pref = preferenceSchema.parse(req.body);
    const saved = await transaction(async db => {
      const r = await db.query(`UPDATE radar_preferences SET revision=revision+1,payload=$3,updated_at=now()
        WHERE user_id=$1 AND revision=$2 RETURNING revision`, [res.locals.userId, pref.revision, pref]);
      if (!r.rowCount) throw new HttpError(409, "Preferences changed on another device. Your draft is kept; reload the latest saved version before merging changes.");
      const updated = { ...pref, revision: r.rows[0].revision };
      await db.query("INSERT INTO radar_preference_history(user_id,revision,payload) VALUES($1,$2,$3)", [res.locals.userId, updated.revision, updated]);
      return updated;
    });
    res.json(saved);
  });
  const runLimit = rateLimit({ windowMs: 60_000, limit: 12, keyGenerator: (_req, res) => res.locals.userId, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: "Too many run requests. Please try again in a minute." } });
  router.post("/runs", runLimit, async (req, res) => {
    await ensureUser(res.locals.userId);
    const body = z.object({
      sourceIds: z.array(z.string().min(1).max(40)).min(1).max(10).refine(v => new Set(v).size === v.length, "Select each source only once."),
      idempotencyKey: z.string().min(8).max(120), preferenceRevision: z.number().int().positive(), retryOf: uuid.optional()
    }).strict().parse(req.body);
    const known = new Set((await listSources(res.locals.userId)).map(s => s.id));
    const unknown = body.sourceIds.filter(id => !known.has(id));
    if (unknown.length) throw new HttpError(400, `Unknown source${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Add the repo first.`);
    const id = await createRun(res.locals.userId, body.sourceIds, body.idempotencyKey, body.preferenceRevision, body.retryOf);
    res.status(202).json({ id, streamUrl: `/api/runs/${id}/events` });
  });
  router.get("/runs", async (_req, res) => {
    const runs = await pool.query("SELECT id FROM radar_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [res.locals.userId]);
    res.json(await Promise.all(runs.rows.map(r => getRun(res.locals.userId, r.id, false))));
  });
  router.get("/runs/:id", async (req, res) => res.json(await getRun(res.locals.userId, uuid.parse(req.params.id))));
  router.get("/runs/:id/replay", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const run = await getRun(res.locals.userId, id);
    res.json({ run, events: await readEvents(id) });
  });
  router.get("/runs/:id/events", async (req, res) => {
    const id = uuid.parse(req.params.id);
    await getRun(res.locals.userId, id, false);
    const parsed = Number(req.get("Last-Event-ID") || req.query.after || 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, "Invalid event sequence");
    let after = parsed, closed = false, ticks = 0;
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    req.on("close", () => { closed = true; });
    while (!closed) {
      try {
        const events = await readEvents(id, after);
        for (const event of events) {
          if (closed) break;
          res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.sequence;
        }
        const state = (await pool.query("SELECT state,next_sequence FROM radar_runs WHERE id=$1 AND user_id=$2", [id, res.locals.userId])).rows[0];
        if (!state) { res.end(); return; }
        if (!active.has(state.state) && after >= state.next_sequence) {
          res.write(`event: complete\ndata: ${JSON.stringify({ state: state.state })}\n\n`);
          res.end(); return;
        }
        // Bound buffering for stalled consumers. EventSource will catch up durably on reconnect.
        if (res.writableLength > 1_000_000) { res.end(); return; }
        if (++ticks % 40 === 0) res.write(": heartbeat\n\n");
        await new Promise(r => setTimeout(r, 300));
      } catch {
        res.write('event: stream-error\ndata: {"error":"Live event storage unavailable. Reconnect to catch up; no success is claimed."}\n\n');
        res.end(); return;
      }
    }
  });
  router.get("/tracker", async (req, res) => {
    if (res.locals.isGuest) throw new HttpError(401, "Sign in to save and track applications. Your guest filters and results will remain available.");
    const query = z.object({
      status: z.enum(["", "saved", "applied", "skipped"]).default(""),
      source: z.string().max(40).default(""), page: z.coerce.number().int().min(1).max(100000).default(1),
      search: z.string().max(120).default(""),
      sort: z.enum(["added", "posted", "posted-asc"]).default("added")
    }).parse(req.query);
    const params = [res.locals.userId, query.status, query.source, query.search];
    const where = `WHERE t.user_id=$1 AND ($2='' OR t.status=$2) AND ($3='' OR t.source_id=$3)
      AND ($4='' OR p.payload->>'company' ILIKE '%'||$4||'%' OR p.payload->>'role' ILIKE '%'||$4||'%')`;
    const orderBy = query.sort === "posted" ? `ORDER BY (p.payload->>'postedAt') DESC NULLS LAST,t.created_at DESC,t.id`
      : query.sort === "posted-asc" ? `ORDER BY (p.payload->>'postedAt') ASC NULLS LAST,t.created_at DESC,t.id`
      : `ORDER BY t.created_at DESC,t.id`;
    const count = await pool.query(`SELECT count(*)::int AS total FROM radar_tracker t JOIN radar_postings p ON p.identity=t.identity ${where}`, params);
    const rows = await pool.query(`${trackerSelect} ${where} ${orderBy} LIMIT 30 OFFSET $5`, [...params, (query.page - 1) * 30]);
    const stats = (await pool.query("SELECT status,count(*)::int AS count FROM radar_tracker WHERE user_id=$1 GROUP BY status", [res.locals.userId])).rows;
    res.json({ entries: rows.rows, total: count.rows[0].total, page: query.page, pageSize: 30,
      stats: Object.fromEntries(["saved", "applied", "skipped"].map(s => [s, stats.find(x => x.status === s)?.count || 0])) });
  });
  router.patch("/tracker/:id", async (req, res) => {
    if (res.locals.isGuest) throw new HttpError(401, "Sign in to change tracker statuses.");
    const id = uuid.parse(req.params.id);
    const body = z.object({ revision: z.number().int().positive(), status: z.enum(["saved", "applied", "skipped"]) }).strict().parse(req.body);
    const result = await pool.query(`UPDATE radar_tracker SET status=$3,revision=revision+1,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$4 RETURNING id`, [id, res.locals.userId, body.status, body.revision]);
    if (!result.rowCount) {
      const exists = await pool.query("SELECT id FROM radar_tracker WHERE id=$1 AND user_id=$2", [id, res.locals.userId]);
      throw new HttpError(exists.rowCount ? 409 : 404, exists.rowCount ? "This entry changed on another device. Reload its latest status before trying again." : "Tracker entry not found");
    }
    res.json((await pool.query(`${trackerSelect} WHERE t.user_id=$1 AND t.id=$2`, [res.locals.userId, id])).rows[0]);
  });
  router.use((_req, res) => res.status(404).json({ error: "API route not found" }));
  return router;
}
