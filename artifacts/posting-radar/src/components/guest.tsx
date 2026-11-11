import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ExternalLink, Filter, Inbox, Lock } from "lucide-react";
import { ApiError, api, importGuestMatches, savePreferences, useAccount, useGuestHandoff, type GuestMatch, type Preferences, type Source } from "@/lib/api";
import { Bone, Btn, ErrorState, Panel, Tag } from "./bits";
import { clearDraft, fmtTime, prefsFromDraft, readDraft } from "@/lib/local";

const VISIBLE_KEY = "posting-radar:guest-visible-run";
/** Remember which guest run is on screen so handoff can carry exactly that one. Never for account runs. */
export function rememberGuestRun(id: string | undefined, isGuest: boolean | undefined) {
  if (!id || !isGuest) return;
  try { sessionStorage.setItem(VISIBLE_KEY, id); } catch { /* storage unavailable */ }
}

/** Waits for /api/me so the guest cookie exists before any child query fires. */
export function AccountGate({ children }: { children: ReactNode }) {
  const acc = useAccount();
  if (acc.isLoading) return <div className="space-y-4" aria-busy="true"><Bone className="h-10 w-64" /><Bone className="h-48" /><Bone className="h-72" /></div>;
  if (acc.error || !acc.data) return <ErrorState message={`Could not open a session: ${(acc.error as Error | null)?.message ?? "unknown error"}`} onRetry={() => acc.refetch()} />;
  if (acc.data.isGuest && !acc.data.guestSessionAvailable)
    return <ErrorState message="Guest sessions are unavailable right now. Sign in to keep using Posting Radar." />;
  return <>{children}</>;
}

export function useAccountId() {
  return useAccount().data?.id ?? "";
}

export function GuestNote({ children }: { children?: ReactNode }) {
  const acc = useAccount();
  if (!acc.data?.isGuest) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-primary/40 bg-primary/5 px-4 py-3 text-sm">
      <p className="min-w-0"><span className="font-mono text-[11px] uppercase tracking-wider text-primary">Guest · this browser only</span><br />
        {children ?? "Your runs and filters live in a 30-day session tied to this browser. They do not sync across devices until you sign in and save them."}</p>
      <span className="flex gap-2">
        <Link href="/sign-up" className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Create account</Link>
        <Link href="/sign-in" className="rounded-sm border bg-card px-3 py-1.5 text-xs">Sign in</Link>
      </span>
    </div>
  );
}

export function GuestMatches({ matches, sources }: { matches: GuestMatch[]; sources?: Source[] }) {
  return (
    <div>
      <h3 className="mb-1 flex items-baseline justify-between font-display font-semibold">Observed matches <span className="font-mono text-xs font-normal text-muted-foreground">{matches.length}</span></h3>
      <p className="mb-2 text-xs text-muted-foreground">Seen by this guest run. Nothing was added to a tracker. <Link href="/sign-up" className="font-medium text-primary hover:underline">Sign in to save them</Link>.</p>
      {matches.length === 0 ? <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">No postings matched in this run.</p> : (
        <ul className="divide-y rounded-sm border">
          {matches.map((m) => (
            <li key={m.id} className="px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <a href={m.posting.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:text-primary">{m.posting.company}<ExternalLink className="h-3 w-3 opacity-60" /></a>
                <span className="text-muted-foreground">{m.posting.role}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {m.posting.locations.slice(0, 3).map((l) => <Tag key={l}>{l}</Tag>)}
                {m.posting.locations.length > 3 && <Tag>+{m.posting.locations.length - 3}</Tag>}
                <Tag>{sources?.find((s) => s.id === m.sourceId)?.name ?? m.sourceId} · {m.season}</Tag>
                <Tag>{m.dataOrigin === "cache" ? "from cache" : "live"} · {fmtTime(m.createdAt)}</Tag>
              </div>
              {m.reasons.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Matched because: {m.reasons.join("; ")}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TrackerSignInPrompt() {
  return (
    <div className="gridlines rise rounded-md border px-6 py-16 text-center">
      <Lock className="mx-auto h-6 w-6 text-primary" />
      <h1 className="mt-3 font-display text-3xl font-extrabold">The tracker needs an account</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Guests can run sweeps and read every observed match. Saving postings and tracking saved, applied or skipped needs a signed-in account so your record is durable and private.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/sign-up" className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Create account</Link>
        <Link href="/sign-in" className="rounded-sm border bg-card px-4 py-2 text-sm">Sign in</Link>
        <Link href="/user-portal" className="rounded-sm px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Keep browsing as guest</Link>
      </div>
    </div>
  );
}

/** Explicit, separate actions to carry guest work into a signed-in account. Nothing auto-applies. */
export function GuestHandoffPanel({ sources }: { sources?: Source[] }) {
  const acc = useAccount();
  const qc = useQueryClient();
  const h = useGuestHandoff(!!acc.data && !acc.data.isGuest);
  const [prefState, setPrefState] = useState<{ kind: "idle" | "saving" | "done" | "error" | "conflict"; msg?: string }>({ kind: "idle" });
  const [imp, setImp] = useState<{ kind: "idle" | "saving" | "done" | "error"; msg?: string; inserted?: number }>({ kind: "idle" });
  const [appliedPrefs, setAppliedPrefs] = useState<Preferences | null>(null);

  const guestUserId = h.data?.guestUserId;
  const draft = guestUserId ? readDraft(guestUserId) : null;
  if (!acc.data || acc.data.isGuest) return null;
  if (h.error) return <ErrorState message={`Guest work could not be loaded: ${(h.error as Error).message}. Nothing has been copied or discarded.`} onRetry={() => h.refetch()} />;
  if (!h.data?.available && !draft) return null;
  const { run, matches = [], imported = false } = h.data ?? {};
  const gp: Preferences | undefined = appliedPrefs ?? (draft ? prefsFromDraft(draft, h.data?.preferences?.revision ?? 0) : h.data?.preferences);

  async function applyFilters() {
    if (!gp) return;
    setPrefState({ kind: "saving" });
    try {
      const mine = await qc.fetchQuery({ queryKey: ["preferences"], queryFn: () => api<Preferences>("/preferences"), staleTime: 0 });
      const saved = await savePreferences({ ...gp, revision: mine.revision });
      qc.setQueryData(["preferences"], saved);
      setAppliedPrefs(saved);
      if (guestUserId && draft) {
        const now = readDraft(guestUserId);
        if (now && JSON.stringify(now) === JSON.stringify(draft)) clearDraft(guestUserId);
      }
      setPrefState({ kind: "done", msg: `Saved as revision ${saved.revision}` });
    } catch (e) {
      const c = e instanceof ApiError && e.status === 409;
      setPrefState({ kind: c ? "conflict" : "error", msg: c ? "Your account preferences changed meanwhile. Guest filters are still here; try again to apply over the newest." : (e as Error).message });
    }
  }
  async function importMatches() {
    if (!run) return;
    setImp({ kind: "saving" });
    try {
      const r = await importGuestMatches(run.id);
      setImp({ kind: "done", inserted: r.inserted });
      qc.invalidateQueries({ queryKey: ["tracker"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["guest-handoff"] });
    } catch (e) { setImp({ kind: "error", msg: (e as Error).message }); }
  }

  return (
    <Panel kicker="From your guest session on this browser" title="Bring your guest work into this account"
      className="rise border-primary/40">
      <p className="mb-4 text-sm text-muted-foreground">Nothing has been copied yet. Each action below is separate and only runs when you click it. Your account's own baseline and history are not merged.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-sm border p-4">
          <h3 className="flex items-center gap-2 font-medium"><Filter className="h-4 w-4 text-primary" />Guest filters{draft && <span className="rounded-sm border border-dashed border-primary/50 px-1.5 font-mono text-[10px] uppercase tracking-wider text-primary">unsaved guest draft</span>}</h3>
          {gp ? (
            <dl className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
              <div>categories: {gp.roles.length ? gp.roles.join(", ") : "all"}</div>
              <div>locations: {gp.locations.length ? gp.locations.join(" | ") : "anywhere"}</div>
              <div>work model: {gp.workModel} · pay: {gp.pay} · sponsorship: {gp.sponsorship}{gp.includeUnknown ? " (+unknown)" : ""}</div>
              <div>excluded: {gp.excludedCompanies.length ? gp.excludedCompanies.join(", ") : "none"}</div>
            </dl>
          ) : <p className="mt-2 text-sm text-muted-foreground">No guest filters were saved.</p>}
          <Btn className="mt-3" variant="ink" disabled={!gp || prefState.kind === "saving" || prefState.kind === "done"} onClick={applyFilters}>
            {prefState.kind === "done" ? <CheckCircle2 className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
            {prefState.kind === "saving" ? "Applying" : prefState.kind === "done" ? "Applied" : "Apply guest filters"}
          </Btn>
          {prefState.msg && <p role={prefState.kind === "done" ? "status" : "alert"} className={`mt-2 text-xs ${prefState.kind === "done" ? "text-[hsl(var(--ph-succeeded))]" : "text-[hsl(var(--ph-failed))]"}`}>{prefState.msg}</p>}
          <p className="mt-2 text-[11px] text-muted-foreground">Applies to postings found after saving, as a new account revision.</p>
        </div>
        <div className="rounded-sm border p-4">
          <h3 className="flex items-center gap-2 font-medium"><Inbox className="h-4 w-4 text-primary" />Guest matches</h3>
          <p className="mt-2 text-sm text-muted-foreground">{run ? `${matches.length} observed in the guest run from ${fmtTime(run.finishedAt ?? run.createdAt)}.` : "No finished guest run."}</p>
          <Btn className="mt-3" disabled={!run || !matches.length || imported || imp.kind === "saving" || imp.kind === "done"} onClick={importMatches}>
            {imported || imp.kind === "done" ? <CheckCircle2 className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
            {imp.kind === "saving" ? "Saving" : imported || imp.kind === "done" ? "Saved to tracker" : `Save ${matches.length} guest match${matches.length === 1 ? "" : "es"} to tracker`}
          </Btn>
          {imp.kind === "done" && <p role="status" className="mt-2 text-xs text-[hsl(var(--ph-succeeded))]">{imp.inserted} new tracker entries. <Link href="/tracker" className="underline">Open tracker</Link></p>}
          {imp.kind === "error" && <p role="alert" className="mt-2 text-xs text-[hsl(var(--ph-failed))]">Not saved: {imp.msg}. Safe to retry; it will not duplicate.</p>}
        </div>
      </div>
      {matches.length > 0 && <div className="mt-4"><GuestMatches matches={matches} sources={sources} /></div>}
    </Panel>
  );
}
