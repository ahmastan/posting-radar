import type { Preferences } from "./api";

export const parseLines = (text: string) =>
  text.split(/\n/).map((s) => s.trim()).filter(Boolean);
export const parseList = (text: string) =>
  text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

export interface PrefDraft {
  baseRevision: number;
  locations: string;
  remotePolicy: Preferences["remotePolicy"];
  roles: string[];
  sponsorship: Preferences["sponsorship"];
  includeUnknown: boolean;
  excludedCompanies: string;
}

const draftKey = (uid: string) => `posting-radar:draft:${uid}`;
const memoryDrafts = new Map<string, PrefDraft>();
const memoryKeys = new Map<string, string>();

export function readDraft(uid: string): PrefDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(uid));
    return raw ? (JSON.parse(raw) as PrefDraft) : (memoryDrafts.get(uid) ?? null);
  } catch {
    return memoryDrafts.get(uid) ?? null;
  }
}
export function writeDraft(uid: string, d: PrefDraft) {
  memoryDrafts.set(uid, d);
  try { localStorage.setItem(draftKey(uid), JSON.stringify(d)); } catch { /* storage full */ }
}
export function clearDraft(uid: string) {
  memoryDrafts.delete(uid);
  try { localStorage.removeItem(draftKey(uid)); } catch { /* ignore */ }
}

export function draftFromPrefs(p: Preferences): PrefDraft {
  return {
    baseRevision: p.revision,
    locations: p.locations.join("\n"),
    remotePolicy: p.remotePolicy,
    roles: [...p.roles],
    sponsorship: p.sponsorship,
    includeUnknown: p.includeUnknown,
    excludedCompanies: p.excludedCompanies.join("\n"),
  };
}
export function prefsFromDraft(d: PrefDraft, revision: number): Preferences {
  return {
    revision,
    locations: parseLines(d.locations),
    remotePolicy: d.remotePolicy,
    roles: d.roles,
    sponsorship: d.sponsorship,
    includeUnknown: d.includeUnknown,
    excludedCompanies: parseList(d.excludedCompanies),
  };
}
export function samePrefs(a: Preferences, b: Preferences) {
  const n = (p: Preferences) =>
    JSON.stringify([p.locations, p.remotePolicy, [...p.roles].sort(), p.sponsorship, p.includeUnknown, p.excludedCompanies]);
  return n(a) === n(b);
}

/* Idempotency keys live in sessionStorage so an ambiguous failure (network drop,
   5xx, reload mid-request) re-sends the same key. Cleared only once accepted. */
const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function pendingKey(slot: string) {
  const k = `posting-radar:idem:${slot}`;
  let v: string | null;
  try { v = sessionStorage.getItem(k); } catch { v = memoryKeys.get(k) ?? null; }
  if (!v) {
    v = memoryKeys.get(k) ?? uuid();
    memoryKeys.set(k, v);
    try { sessionStorage.setItem(k, v); } catch { /* retain key in this page session */ }
  }
  return v;
}
export function hasPendingKey(slot: string) {
  try { return !!sessionStorage.getItem(`posting-radar:idem:${slot}`) || memoryKeys.has(`posting-radar:idem:${slot}`); }
  catch { return memoryKeys.has(`posting-radar:idem:${slot}`); }
}
export function acceptKey(slot: string) {
  memoryKeys.delete(`posting-radar:idem:${slot}`);
  try { sessionStorage.removeItem(`posting-radar:idem:${slot}`); } catch { /* memory key removed */ }
}

export const fmtMs = (ms?: number) =>
  ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;

export function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function ago(iso?: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const humanize = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase();
