// Explicit development/post-merge command. Never imported by application startup.
import { readFile } from "node:fs/promises";
import { pool } from "./db.js";
await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
await pool.end();
console.log("Posting Radar development schema ready.");
