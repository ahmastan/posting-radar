import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { sources as builtins } from "./config.js";
import { parseReadme, ParseError } from "./parser.js";
import { FetchError } from "./ingestion.js";
import { HttpError } from "./store.js";
import type { Source } from "../src/lib/api.js";

export const MAX_CUSTOM_SOURCES = 8;
export const isCustomId = (id: string) => id.startsWith("custom:");

/** Built-ins plus this account's saved custom repos. */
export async function listSources(userId: string): Promise<Source[]> {
  const rows = (await pool.query(
    "SELECT id,repo,branch,path,name,season FROM radar_user_sources WHERE user_id=$1 ORDER BY created_at", [userId])).rows;
  return [...builtins, ...rows.map(r => ({
    id: r.id, name: r.name, repo: r.repo, branch: r.branch, path: r.path,
    season: r.season || "custom", url: `https://github.com/${r.repo}/blob/${r.branch}/${r.path}`,
    stars: 0, available: true, custom: true as const,
  }))];
}

/** Resolve one source id for a user; null when unknown. */
export async function resolveSource(userId: string, id: string): Promise<Source | null> {
  const all = await listSources(userId);
  return all.find(s => s.id === id) ?? null;
}

function validRepo(repo: string) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }

/**
 * Validate by really downloading and parsing the README, then persist.
 * Never saves a source whose table cannot be parsed.
 */
export async function addUserSource(userId: string, input: { repo: string; branch: string; path: string; name: string; season?: string },
  transport: typeof fetch = fetch): Promise<Source> {
  const repo = input.repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  const branch = input.branch.trim() || "main";
  const path = input.path.trim() || "README.md";
  const name = input.name.trim() || repo;
  const season = (input.season ?? "").trim().slice(0, 80);
  if (!validRepo(repo)) throw new HttpError(400, "Repo must look like owner/name, e.g. SimplifyJobs/Summer2027-Internships.");
  if (!/^[\w./-]+$/.test(branch) || !/^[\w./-]+$/.test(path)) throw new HttpError(400, "Branch and path may only contain letters, numbers, and . _ - /");
  const existing = await pool.query("SELECT id FROM radar_user_sources WHERE user_id=$1", [userId]);
  if (existing.rowCount! >= MAX_CUSTOM_SOURCES) throw new HttpError(400, `You can add at most ${MAX_CUSTOM_SOURCES} custom repos. Remove one first.`);
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  let response: Response;
  try {
    response = await transport(url, { signal: AbortSignal.timeout(10000), redirect: "error", headers: { "User-Agent": "PostingRadar/1.0" } });
  } catch { throw new HttpError(400, "Could not reach GitHub to validate that repo. Check your connection and try again."); }
  if (!response.ok) {
    const code = response.status === 404 ? "Repo, branch, or file not found on GitHub (check it is public and the branch/path are right)." : `GitHub answered HTTP ${response.status}.`;
    throw new HttpError(400, code);
  }
  const raw = await response.text();
  if (raw.length > 12_000_000) throw new HttpError(400, "That README is too large to process (over 12 MB).");
  try {
    const rows = parseReadme(raw);
    if (!rows.length) throw new HttpError(400, "The README downloaded, but its postings table parsed as empty. Posting Radar needs a SimplifyJobs-style markdown job table.");
  } catch (e) {
    if (e instanceof ParseError) throw new HttpError(400, `The README downloaded, but its table could not be parsed: ${e.message}`);
    throw e;
  }
  if (existing.rows.some(r => r.repo === repo && r.branch === branch && r.path === path)) throw new HttpError(409, "You already added that exact repo, branch, and file.");
  const id = `custom:${randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO radar_user_sources(user_id,id,repo,branch,path,name,season) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [userId, id, repo, branch, path, name, season]);
  return { id, name, repo, branch, path, season: season || "custom", url: `https://github.com/${repo}/blob/${branch}/${path}`, stars: 0, available: true, custom: true };
}

/** Removing a source keeps its tracker entries, snapshots, and run history; it only leaves future sweeps. */
export async function removeUserSource(userId: string, id: string): Promise<void> {
  if (!isCustomId(id)) throw new HttpError(400, "Built-in sources cannot be removed.");
  const r = await pool.query("DELETE FROM radar_user_sources WHERE user_id=$1 AND id=$2", [userId, id]);
  if (!r.rowCount) throw new HttpError(404, "Custom source not found.");
}

export { FetchError };
