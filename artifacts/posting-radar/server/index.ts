import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { z } from "zod";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware.js";
import { createRouter } from "./routes.js";
import { HttpError } from "./store.js";
import { workerLoop, stopWorker } from "./worker.js";
import { pool } from "./db.js";
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json({ limit: "32kb" }));
app.use(clerkMiddleware((req) => ({
  publishableKey: publishableKeyFromHost(getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY),
})));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin) {
      const host = req.get("x-forwarded-host")?.split(",")[0].trim() || req.get("host");
      try { if (new URL(origin).host !== host) return res.status(403).json({ error: "Cross-origin writes are not allowed." }); }
      catch { return res.status(403).json({ error: "Invalid request origin." }); }
    }
  }
  next();
}, createRouter());
const apiErrors: ErrorRequestHandler = (e, req, res, next) => {
  if (!req.path.startsWith("/api")) return next(e);
  if (res.headersSent) { res.end(); return; }
  if (e instanceof z.ZodError) { res.status(400).json({ error: e.issues.map(x => `${x.path.join(".")}: ${x.message}`).join("; ") }); return; }
  if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
  console.error("API failure", e instanceof Error ? e.message : "Unknown error");
  res.status(503).json({ error: "Storage is temporarily unavailable. Your previous saved data is unchanged; keep your draft and try again." });
};
app.use(apiErrors);
const http = createServer(app);
if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const vite = await createViteServer({ configFile: path.join(root, "vite.config.ts"), server: { middlewareMode: true, hmr: { server: http } }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
  app.use(express.static(root, { index: false, maxAge: "1h" }));
  app.use((_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(root, "index.html")));
}
await pool.query("SELECT 1 FROM radar_runs LIMIT 1");
http.listen(Number(process.env.PORT || 5000), "0.0.0.0", () => {
  console.log("Posting Radar ready");
  void workerLoop().catch(e => { console.error("Worker stopped", e.message); process.exit(1); });
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  stopWorker();
  http.close();
  // Running work is explicitly marked interrupted by the next lock-owning worker.
  setTimeout(() => process.exit(0), 1500).unref();
});
