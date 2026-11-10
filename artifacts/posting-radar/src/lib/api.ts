import { useQuery } from "@tanstack/react-query";
export const roles = ["Software Engineering", "Product Management", "Data Science, AI & Machine Learning", "Quantitative Finance", "Hardware Engineering", "Other"] as const;
export interface Preferences {
  revision: number; locations: string[]; remotePolicy: "any" | "only" | "exclude";
  roles: string[]; sponsorship: "any" | "required"; includeUnknown: boolean; excludedCompanies: string[];
}
export interface Source {
  id: string; name: string; repo: string; branch: string; path: string; season: string; url: string; stars: number;
  cachedAt?: string | null; available: boolean;
}
export interface Posting {
  identity: string; company: string; role: string; locations: string[]; category: string;
  url: string; remote: boolean; sponsorship: "unknown" | "unavailable" | "citizenship" | "available";
  closed: boolean; ambiguous: boolean;
}
export interface TrackerEntry {
  id: string; posting: Posting; sourceId: string; season: string; status: "saved" | "applied" | "skipped";
  revision: number; reasons: string[]; createdAt: string; dataOrigin: "live" | "cache";
}
export interface RunEvent {
  schemaVersion: number; runId: string; sequence: number; sourceId?: string; step: string;
  phase: "started" | "succeeded" | "failed" | "skipped" | "retrying" | "recovered";
  attempt: number; timestamp: string; elapsedRunMs: number; durationMs?: number;
  fromLayer: "Page" | "Server" | "Database" | "GitHub"; toLayer: "Page" | "Server" | "Database" | "GitHub";
  summary: string; counts?: Record<string, number>; dataOrigin?: "live" | "cache";
  error?: {code: string; message: string}; recovery?: Record<string, unknown>;
}
export interface SourceResult {
  sourceId: string; outcome: string; initialImport?: boolean; dataOrigin?: "live" | "cache";
  cachedAt?: string; baselineSnapshotId?: string; candidateSnapshotId?: string;
  counts?: Record<string, number>; error?: { code: string; message: string };
}
export interface Run {
  id: string; state: "queued" | "running" | "succeeded" | "degraded" | "failed" | "interrupted";
  requestedSources: string[]; preferenceRevision: number; preferences: Preferences;
  createdAt: string; finishedAt?: string; totals: Record<string, number>; sourceResults: SourceResult[];
  retryOf?: string; results?: TrackerEntry[];
  isGuest?: boolean; matches?: GuestMatch[];
}
export interface GuestMatch {
  id: string; posting: Posting; sourceId: string; season: string; reasons: string[];
  dataOrigin: "live" | "cache"; createdAt: string;
}
export interface Account { id: string; isGuest: boolean; guestSessionAvailable: boolean }
export interface GuestHandoff { available: boolean; guestUserId?: string; preferences?: Preferences; run?: Run; matches: GuestMatch[]; imported: boolean }
export const useAccount = () => useQuery({ queryKey: ["account"], queryFn: () => api<Account>("/me"), staleTime: 60_000 });
export const useGuestHandoff = (enabled: boolean) => {
  let runId: string | null = null;
  try { runId = sessionStorage.getItem("posting-radar:guest-visible-run"); } catch { /* latest finished run is available without storage */ }
  return useQuery({ queryKey: ["guest-handoff", runId], queryFn: () => api<GuestHandoff>(`/guest/handoff${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`), enabled });
};
export const importGuestMatches = (runId: string) => api<{ id: string; inserted: number }>("/guest/handoff", { method: "POST", body: JSON.stringify({ runId }) });
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error || "Request failed");
  return data;
}
export const useSources = () => useQuery({ queryKey: ["sources"], queryFn: () => api<Source[]>("/sources") });
export const usePreferences = () => useQuery({ queryKey: ["preferences"], queryFn: () => api<Preferences>("/preferences") });
export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 3000 });
export const useRun = (id?: string) => useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/runs/${id}`), enabled: !!id,
  refetchInterval: q => q.state.data && ["queued", "running"].includes(q.state.data.state) ? 2000 : false });
export const useTracker = (status = "", source = "", page = 1, search = "") => useQuery({
  queryKey: ["tracker", status, source, page, search],
  queryFn: () => api<{ entries: TrackerEntry[]; total: number; page: number; pageSize: number; stats: Record<string, number> }>(`/tracker?status=${encodeURIComponent(status)}&source=${encodeURIComponent(source)}&page=${page}&search=${encodeURIComponent(search)}`)
});
export const savePreferences = (p: Preferences) => api<Preferences>("/preferences", { method: "PUT", body: JSON.stringify(p) });
export const startRun = (sourceIds: string[], idempotencyKey: string, preferenceRevision: number, retryOf?: string) =>
  api<{ id: string; streamUrl: string }>("/runs", { method: "POST", body: JSON.stringify({ sourceIds, idempotencyKey, preferenceRevision, retryOf }) });
export const updateStatus = (id: string, status: TrackerEntry["status"], revision: number) =>
  api<TrackerEntry>(`/tracker/${id}`, { method: "PATCH", body: JSON.stringify({ status, revision }) });
export const getReplay = (id: string) => api<{ run: Run; events: RunEvent[] }>(`/runs/${id}/replay`);
