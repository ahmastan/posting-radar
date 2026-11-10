import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { RotateCw } from "lucide-react";
import { useAccount, useRun, useRuns, useSources } from "@/lib/api";
import { useLaunch } from "@/hooks/use-launch";
import { useRunStream } from "@/hooks/use-run-stream";
import { Bone, Btn, Counts, ErrorState, PageHead, Panel, RunStateBadge, SourceResultCard } from "@/components/bits";
import { EventDiagram, EventLog } from "@/components/event-diagram";
import { rememberGuestRun, GuestMatches, GuestNote } from "@/components/guest";
import { ReplayPanel } from "@/components/replay-panel";
import { fmtMs, fmtTime } from "@/lib/local";
import { cn } from "@/lib/utils";

export default function History() {
  const params = new URLSearchParams(useSearch());
  const runs = useRuns();
  const sources = useSources();
  const [sel, setSel] = useState<string | undefined>(params.get("run") ?? undefined);
  const id = sel ?? runs.data?.[0]?.id;
  const run = useRun(id);
  const isGuest = useAccount().data?.isGuest;
  useEffect(() => { rememberGuestRun(id, isGuest); }, [id, isGuest]);
  const live = run.data?.state === "running" || run.data?.state === "queued";
  const stream = useRunStream(live ? id : undefined);
  const { launch, busy, error } = useLaunch();

  return (
    <>
      <PageHead kicker="Every sweep, on the record" title="History" />
      <GuestNote>History shown here belongs to this browser's 30-day guest session and is not synced across devices.</GuestNote>
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Panel kicker={`${runs.data?.length ?? 0} runs`} title="Runs">
          {runs.isLoading && <div className="space-y-2">{[0, 1, 2].map((i) => <Bone key={i} className="h-12" />)}</div>}
          {runs.error && <ErrorState message="Runs failed to load" onRetry={() => runs.refetch()} />}
          {runs.data?.length === 0 && <p className="text-sm text-muted-foreground">No runs yet. <Link href="/user-portal" className="text-primary hover:underline">Start one</Link>.</p>}
          <ul className="-mx-2 max-h-[70vh] space-y-0.5 overflow-y-auto">
            {runs.data?.map((r) => (
              <li key={r.id}>
                <button onClick={() => setSel(r.id)} aria-current={r.id === id}
                  className={cn("w-full rounded-sm border-l-2 px-3 py-2 text-left transition-colors hover:bg-muted", r.id === id ? "border-primary bg-muted" : "border-transparent")}>
                  <span className="flex items-center justify-between gap-2"><span className="font-mono text-xs">{fmtTime(r.createdAt)}</span><RunStateBadge state={r.state} /></span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-muted-foreground">{r.requestedSources.length} sources · rev {r.preferenceRevision}{r.retryOf ? " · retry" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="min-w-0 space-y-6">
          {run.isLoading && <Bone className="h-64" />}
          {run.error && <ErrorState message="Run details failed to load" onRetry={() => run.refetch()} />}
          {run.data && (
            <Panel kicker={`Run ${run.data.id}`} title={<span className="flex items-center gap-2">Details <RunStateBadge state={run.data.state} /></span>}
              action={(run.data.state === "failed" || run.data.state === "interrupted" || run.data.state === "degraded") && (
                <Btn variant="ink" disabled={busy} onClick={async () => { const nid = await launch(run.data!.requestedSources, run.data!.id); if (nid) setSel(nid); }}>
                  <RotateCw className={cn("h-4 w-4", busy && "sweep")} />Retry this run
                </Btn>
              )}>
              {error && <p role="alert" className="mb-4 rounded-sm border border-[hsl(var(--ph-failed)/.35)] p-3 text-sm">{error.message}{error.ambiguous && " The retry key is kept, so trying again cannot create a duplicate."}</p>}
              <dl className="mb-5 grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
                <div><dt className="text-muted-foreground">started</dt><dd>{fmtTime(run.data.createdAt)}</dd></div>
                <div><dt className="text-muted-foreground">finished</dt><dd>{fmtTime(run.data.finishedAt)}</dd></div>
                <div><dt className="text-muted-foreground">duration</dt><dd>{run.data.finishedAt ? fmtMs(+new Date(run.data.finishedAt) - +new Date(run.data.createdAt)) : "in progress"}</dd></div>
                <div><dt className="text-muted-foreground">preferences</dt><dd>revision {run.data.preferenceRevision}</dd></div>
                {run.data.retryOf && <div className="col-span-2"><dt className="text-muted-foreground">retry of</dt><dd><button className="text-primary hover:underline" onClick={() => setSel(run.data!.retryOf)}>{run.data.retryOf}</button></dd></div>}
              </dl>
              <Counts counts={run.data.totals} />
              <div className="mt-5 grid gap-3 xl:grid-cols-2">
                {run.data.sourceResults.map((sr) => <SourceResultCard key={sr.sourceId} result={sr} source={sources.data?.find((s) => s.id === sr.sourceId)} />)}
              </div>
              {run.data.isGuest ? <div className="mt-5"><GuestMatches matches={run.data.matches ?? []} sources={sources.data} /></div> : <p className="mt-4 text-sm text-muted-foreground">{run.data.results?.length ?? 0} tracker entries created by this run. <Link href="/tracker" className="text-primary hover:underline">Manage in tracker</Link></p>}
            </Panel>
          )}
          {run.data && live && (
            <Panel kicker={`Live · ${stream.status}`} title="In progress">
              {stream.warning && <p role="alert" className="mb-3 rounded-sm border border-[hsl(var(--ph-retrying)/.5)] bg-[hsl(var(--ph-retrying)/.08)] p-3 text-sm">Event stream problem: {stream.warning} Reconnecting.</p>}
              <EventDiagram events={stream.events} />
              <div className="mt-4"><EventLog events={stream.events} live /></div>
            </Panel>
          )}
          {run.data && !live && <ReplayPanel key={run.data.id} runId={run.data.id} />}
        </div>
      </div>
    </>
  );
}
