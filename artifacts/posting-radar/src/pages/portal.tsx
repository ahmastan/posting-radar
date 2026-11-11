import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Radar, Star, Trash2, X } from "lucide-react";
import { addCustomSource, removeCustomSource, useAccount, useRun, useRuns, useSources } from "@/lib/api";
import { useLaunch } from "@/hooks/use-launch";
import { useRunStream } from "@/hooks/use-run-stream";
import { Bone, Btn, Counts, ErrorState, PageHead, Panel, RunStateBadge, SourceResultCard } from "@/components/bits";
import { rememberGuestRun, GuestHandoffPanel, GuestMatches, GuestNote } from "@/components/guest";
import { EventDiagram, EventLog, Legend } from "@/components/event-diagram";
import { ago, fmtTime, humanize } from "@/lib/local";
import { cn } from "@/lib/utils";

export default function Portal() {
  const sources = useSources();
  const runs = useRuns();
  const { launch, busy, error } = useLaunch();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [focusId, setFocusId] = useState<string | undefined>();

  const available = useMemo(() => (sources.data ?? []).filter((s) => s.available), [sources.data]);
  const selected = picked ?? available.map((s) => s.id);
  const active = runs.data?.find((r) => r.state === "queued" || r.state === "running");
  const latest = runs.data?.[0];
  const runId = focusId ?? active?.id ?? latest?.id;
  const run = useRun(runId);
  const isGuest = useAccount().data?.isGuest;
  useEffect(() => { rememberGuestRun(runId, isGuest); }, [runId, isGuest]);
  const isLive = run.data ? run.data.state === "queued" || run.data.state === "running" : !!active && active.id === runId;
  const stream = useRunStream(runId);

  useEffect(() => { if (active && !focusId) setFocusId(active.id); }, [active, focusId]);

  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const go = async () => { const id = await launch(selected); if (id) setFocusId(id); };

  return (
    <>
      <PageHead kicker="Today's sweep" title="Radar">
        <p className="max-w-sm text-sm text-muted-foreground">Pick sources, run a sweep, and watch every request travel between layers as it happens.</p>
      </PageHead>

      <GuestNote />
      <div className="mb-6"><GuestHandoffPanel sources={sources.data} /></div>
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-6">
          <Panel kicker="Step 1" title="Approved sources">
            {sources.isLoading && <div className="space-y-2"><Bone className="h-16" /><Bone className="h-16" /></div>}
            {sources.error && <ErrorState message="Sources failed to load" onRetry={() => sources.refetch()} />}
            <ul className="space-y-2">
              {sources.data?.map((s) => {
                const on = selected.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className={cn("flex cursor-pointer gap-3 rounded-sm border p-3 transition-colors", on ? "border-primary/60 bg-primary/5" : "hover:bg-muted", !s.available && "cursor-not-allowed opacity-50")}>
                      <input type="checkbox" className="sr-only" checked={on} disabled={!s.available} onChange={() => toggle(s.id)} />
                      <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="h-3 w-3" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{s.name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{s.repo}@{s.branch}/{s.path}</span>
                        <span className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10.5px] text-muted-foreground">
                          <span>{s.season}</span>{s.custom ? <span className="text-primary">your repo</span> : <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3" />{s.stars.toLocaleString()} at setup</span>}
                          <span>cache {s.cachedAt ? ago(s.cachedAt) : "empty"}</span>{!s.available && <span>unavailable</span>}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <AddSourcePanel onAdded={(id) => setPicked((p) => [...(p ?? selected), id])} />
            <Btn className="mt-4 w-full py-2.5" onClick={go} disabled={busy || !selected.length || !!active}>
              <Radar className={cn("h-4 w-4", busy && "sweep")} />
              {active ? "A run is in progress" : busy ? "Saving preferences and starting" : `Run sweep on ${selected.length} source${selected.length === 1 ? "" : "s"}`}
            </Btn>
            {error && (
              <div role="alert" className="mt-3 rounded-sm border border-[hsl(var(--ph-failed)/.35)] bg-[hsl(var(--ph-failed)/.05)] p-3 text-sm">
                <p>{error.message}</p>
                {error.ambiguous && <p className="mt-1 text-xs text-muted-foreground">The request may have reached the server. Retrying reuses the same idempotency key, so it cannot start twice.</p>}
                {(error.kind === "conflict" || error.kind === "prefs") && <Link href="/preferences" className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline">Open preferences</Link>}
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">Unsaved preference edits are saved first. If that fails, nothing runs. The first sweep of a source imports its current active postings, labeled initial import.</p>
          </Panel>

          <Panel kicker="Recent" title="Runs">
            {runs.isLoading && <Bone className="h-24" />}
            {runs.error && <ErrorState message="Runs failed to load" onRetry={() => runs.refetch()} />}
            {runs.data?.length === 0 && <p className="text-sm text-muted-foreground">No runs yet. Your first sweep will appear here.</p>}
            <ul className="-mx-2 space-y-0.5">
              {runs.data?.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <button onClick={() => setFocusId(r.id)} className={cn("flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted", r.id === runId && "bg-muted")}>
                    <span className="font-mono text-xs">{fmtTime(r.createdAt)}</span><RunStateBadge state={r.state} />
                  </button>
                </li>
              ))}
            </ul>
            <Link href="/history" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">Full history</Link>
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          {!runId && !runs.isLoading && (
            <div className="gridlines rise grid place-items-center rounded-md border px-6 py-20 text-center">
              <div className="relative mb-5 h-20 w-20 rounded-full border">
                <div className="sweep absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, hsl(var(--primary)/.35), transparent 30%)" }} />
                <div className="absolute inset-5 rounded-full border" />
              </div>
              <h2 className="font-display text-2xl font-bold">Nothing swept yet</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">Run your first sweep. Every fetch, cache hit, retry and database write will be drawn here, in order.</p>
            </div>
          )}
          {runId && (
            <Panel kicker={isLive ? `Live · stream ${stream.status}` : "Selected run"}
              title={<span className="flex flex-wrap items-center gap-2">Run <span className="font-mono text-sm text-muted-foreground">{runId.slice(0, 8)}</span>{run.data && <RunStateBadge state={run.data.state} />}</span>}
              action={run.data && <span className="font-mono text-xs text-muted-foreground">prefs rev {run.data.preferenceRevision} · {fmtTime(run.data.createdAt)}{run.data.retryOf && ` · retry of ${run.data.retryOf.slice(0, 8)}`}</span>}>
              {run.isLoading && <Bone className="h-48" />}
              {run.error && <ErrorState message="Run failed to load" onRetry={() => run.refetch()} />}
              {run.data && (
                <div className="space-y-5">
                  {Object.keys(run.data.totals).length > 0 && <Counts counts={run.data.totals} />}
                  {(
                    <>
                      <Legend />
                      {stream.warning && <p role="alert" className="rounded-sm border border-[hsl(var(--ph-retrying)/.5)] bg-[hsl(var(--ph-retrying)/.08)] p-3 text-sm">Event stream problem: {stream.warning} Reconnecting from event #{stream.events.at(-1)?.sequence ?? 0}; nothing shown so far is lost.</p>}
                      <EventDiagram events={stream.events} emptyLabel="Waiting for the server to persist the first event" />
                      <details open={isLive}><summary className="cursor-pointer font-mono text-xs text-muted-foreground">Text event log ({stream.events.length})</summary><div className="mt-3"><EventLog events={stream.events} live={isLive} /></div></details>
                    </>
                  )}
                  {!isLive && (
                    <p className="text-sm text-muted-foreground">Finished {fmtTime(run.data.finishedAt)}. <Link href={`/history?run=${run.data.id}`} className="font-medium text-primary hover:underline">Open the full event replay</Link>.</p>
                  )}
                  <div className="grid gap-3 xl:grid-cols-2">
                    {run.data.sourceResults.map((sr) => <SourceResultCard key={sr.sourceId} result={sr} source={sources.data?.find((s) => s.id === sr.sourceId)} />)}
                  </div>
                  {run.data.isGuest ? <GuestMatches matches={run.data.matches ?? []} sources={sources.data} /> : <Results entries={run.data.results ?? []} />}
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function AddSourcePanel({ onAdded }: { onAdded: (id: string) => void }) {
  const qc = useQueryClient();
  const sources = useSources();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ repo: "", branch: "", path: "", season: "" });
  const [state, setState] = useState<{ kind: "idle" | "saving" | "error"; msg?: string }>({ kind: "idle" });
  const [removing, setRemoving] = useState<string | null>(null);
  const customs = (sources.data ?? []).filter((s) => s.custom);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "saving" });
    try {
      const created = await addCustomSource({
        repo: form.repo, branch: form.branch || undefined, path: form.path || undefined,
        name: "", season: form.season || undefined
      });
      await qc.invalidateQueries({ queryKey: ["sources"] });
      onAdded(created.id);
      setForm({ repo: "", branch: "", path: "", season: "" });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (err) { setState({ kind: "error", msg: (err as Error).message }); }
  }
  async function remove(id: string) {
    setRemoving(id);
    try {
      await removeCustomSource(id);
      await Promise.all([qc.invalidateQueries({ queryKey: ["sources"] }), qc.invalidateQueries({ queryKey: ["runs"] })]);
    } catch (err) { setState({ kind: "error", msg: (err as Error).message }); }
    finally { setRemoving(null); }
  }

  const input = "w-full rounded-sm border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary";
  return (
    <div className="mt-3 border-t pt-3">
      {customs.length > 0 && (
        <ul className="mb-3 space-y-1">
          {customs.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 rounded-sm border border-dashed px-2.5 py-1.5 text-xs">
              <span className="min-w-0 truncate font-mono">{s.repo}@{s.branch}/{s.path}</span>
              <button onClick={() => remove(s.id)} disabled={removing === s.id} aria-label={`Remove ${s.repo}`}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-[hsl(var(--ph-failed))] disabled:opacity-40">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">
          <Plus className="h-4 w-4" />Add a GitHub repo
        </button>
      ) : (
        <form onSubmit={submit} className="space-y-2 rounded-sm border p-3">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">New source</p>
            <button type="button" onClick={() => { setOpen(false); setState({ kind: "idle" }); }} aria-label="Close" className="p-1 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          <label className="block text-xs text-muted-foreground">Repo (owner/name)
            <input required value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} placeholder="SimplifyJobs/Summer2027-Internships" className={input} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted-foreground">Branch
              <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder="main" className={input} /></label>
            <label className="block text-xs text-muted-foreground">File path
              <input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="README.md" className={input} /></label>
          </div>
          <label className="block text-xs text-muted-foreground">Season label (optional)
            <input value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })} placeholder="Summer 2027" className={input} /></label>
          {state.msg && <p role="alert" className="text-xs text-[hsl(var(--ph-failed))]">{state.msg}</p>}
          <Btn type="submit" className="w-full" disabled={state.kind === "saving"}>
            {state.kind === "saving" ? "Validating with GitHub…" : "Validate and add"}
          </Btn>
          <p className="text-[11px] text-muted-foreground">We download the README once to confirm its job table parses. If it can't, the repo is not added and nothing is saved.</p>
        </form>
      )}
    </div>
  );
}

function Results({ entries }: { entries: NonNullable<import("@/lib/api").Run["results"]> }) {
  return (
    <div>
      <h3 className="mb-2 flex items-baseline justify-between font-display font-semibold">New matches in this run <span className="font-mono text-xs font-normal text-muted-foreground">{entries.length}</span></h3>
      {entries.length === 0 ? <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">No new matching postings were added by this run.</p> : (
        <ul className="divide-y rounded-sm border">
          {entries.slice(0, 40).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0"><a href={e.posting.url} target="_blank" rel="noreferrer" className="font-medium hover:text-primary">{e.posting.company}</a> <span className="text-muted-foreground">{e.posting.role}</span></span>
              <span className="font-mono text-[11px] text-muted-foreground">{e.posting.locations.slice(0, 2).join(", ")} · {humanize(e.status)}</span>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 40 && <Link href="/tracker" className="mt-2 inline-block text-xs text-primary hover:underline">See all {entries.length} in the tracker</Link>}
    </div>
  );
}
