import { ArrowRight, Database, Globe, Monitor, Server } from "lucide-react";
import type { RunEvent } from "@/lib/api";
import { fmtMs, humanize } from "@/lib/local";
import { PhaseBadge, phaseColor } from "./bits";
import { cn } from "@/lib/utils";

const LAYERS: RunEvent["fromLayer"][] = ["Page", "Server", "Database", "GitHub"];
const ICON = { Page: Monitor, Server, Database, GitHub: Globe } as const;
const DESC = { Page: "This browser tab", Server: "Posting Radar API", Database: "Postgres snapshots", GitHub: "Source READMEs" } as const;

/** Swimlane sequence diagram: one row per persisted event, arrow from fromLayer to toLayer. */
export function EventDiagram({ events, emptyLabel = "No events yet" }: { events: RunEvent[]; emptyLabel?: string }) {
  return (
    <div>
      {/* Desktop lanes */}
      <div className="hidden md:block" aria-hidden="true">
        <div className="grid grid-cols-4 border-b pb-3">
          {LAYERS.map((l) => {
            const I = ICON[l];
            return (
              <div key={l} className="flex flex-col items-center text-center">
                <span className="grid h-9 w-9 place-items-center rounded-full border bg-background"><I className="h-4 w-4" /></span>
                <span className="mt-1.5 font-display text-sm font-semibold">{l}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{DESC[l]}</span>
              </div>
            );
          })}
        </div>
        <div className="relative max-h-[460px] overflow-y-auto">
          <div className="pointer-events-none absolute inset-0 grid grid-cols-4">
            {LAYERS.map((l) => <div key={l} className="mx-auto w-px bg-border" />)}
          </div>
          {events.length === 0 && <p className="relative py-12 text-center font-mono text-xs text-muted-foreground">{emptyLabel}</p>}
          {events.map((e) => <Row key={e.sequence} e={e} />)}
        </div>
      </div>
      {/* Mobile stack */}
      <ol className="space-y-2 md:hidden" aria-hidden="true">
        {events.length === 0 && <p className="py-8 text-center font-mono text-xs text-muted-foreground">{emptyLabel}</p>}
        {events.map((e) => (
          <li key={e.sequence} className="rise rounded-sm border-l-2 bg-background/70 py-2 pl-3 pr-2" style={{ borderColor: `hsl(${phaseColor[e.phase]})` }}>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide">
              <span className="rounded-sm bg-muted px-1">{e.fromLayer}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span className="rounded-sm bg-muted px-1">{e.toLayer}</span>
              <PhaseBadge phase={e.phase} />
            </div>
            <p className="mt-1 break-words text-sm">{humanize(e.step)}{e.attempt > 1 && <span className="text-muted-foreground"> · attempt {e.attempt}</span>}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{e.summary}</p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {e.sourceId ?? "run"} · {e.durationMs == null ? `actual +${fmtMs(e.elapsedRunMs)}` : `took ${fmtMs(e.durationMs)}`}
              {e.dataOrigin && ` · ${e.dataOrigin}`}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Row({ e }: { e: RunEvent }) {
  const a = LAYERS.indexOf(e.fromLayer), b = LAYERS.indexOf(e.toLayer);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const color = `hsl(${phaseColor[e.phase]})`;
  const dashed = e.phase === "failed" || e.phase === "skipped";
  return (
    <div className="rise relative min-h-[94px] border-b border-border/40">
      {a === b ? (
        <span className="absolute top-[26px] h-3 w-3 -translate-x-1/2 rounded-full border-2 bg-card" style={{ left: `${(a + 0.5) * 25}%`, borderColor: color }} />
      ) : (
        <div className="absolute top-[31px]" style={{ left: `${(lo + 0.5) * 25}%`, width: `${(hi - lo) * 25}%` }}>
          <div className={cn("draw h-0 border-t-2", dashed && "border-dashed")} style={{ borderColor: color, transformOrigin: a < b ? "left" : "right" }} />
          <span className="absolute -top-[5px] h-0 w-0 border-y-[5px] border-y-transparent"
            style={a < b ? { right: -1, borderLeft: `8px solid ${color}` } : { left: -1, borderRight: `8px solid ${color}` }} />
        </div>
      )}
      <div className="relative top-1 mx-2 flex flex-wrap items-center gap-1.5 rounded-sm bg-card px-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">#{e.sequence}</span>
        <span className="font-medium" style={{ color }}>{humanize(e.step)}</span>
        <PhaseBadge phase={e.phase} />
        {e.sourceId && <span className="font-mono text-muted-foreground">{e.sourceId}</span>}
        {e.attempt > 1 && <span className="font-mono text-muted-foreground">try {e.attempt}</span>}
        {e.dataOrigin === "cache" && <span className="font-mono text-[hsl(var(--ph-retrying))]">cache</span>}
        {e.durationMs != null && <span className="font-mono text-muted-foreground">{fmtMs(e.durationMs)}</span>}
      </div>
      <p className="relative mx-3 mt-6 break-words rounded-sm bg-card/95 px-1 text-[11px] text-muted-foreground">{e.summary}</p>
    </div>
  );
}

/** Accessible, complete textual log of the same events. */
export function EventLog({ events, live }: { events: RunEvent[]; live?: boolean }) {
  return (
    <ol aria-live={live ? "polite" : undefined} aria-label="Run event log" className="divide-y rounded-md border bg-background/50 font-mono text-xs">
      {events.length === 0 && <li className="p-4 text-muted-foreground">Waiting for the first persisted event.</li>}
      {events.map((e) => (
        <li key={e.sequence} className="grid grid-cols-[3rem_1fr] gap-x-3 gap-y-1 p-3 sm:grid-cols-[3rem_5rem_1fr]">
          <span className="text-muted-foreground">#{e.sequence}</span>
          <span className="hidden tabular-nums text-muted-foreground sm:block">+{fmtMs(e.elapsedRunMs)}</span>
          <div className="col-span-1 min-w-0 space-y-1 font-sans">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <PhaseBadge phase={e.phase} />
              <span className="font-mono text-[11px] text-muted-foreground">{e.fromLayer} to {e.toLayer}</span>
              <span className="font-medium">{humanize(e.step)}</span>
              {e.sourceId && <span className="font-mono text-[11px] text-muted-foreground">[{e.sourceId}]</span>}
              <span className="font-mono text-[11px] text-muted-foreground">attempt {e.attempt}</span>
              {e.durationMs != null && <span className="font-mono text-[11px] text-muted-foreground">took {fmtMs(e.durationMs)}</span>}
              {e.dataOrigin && <span className="font-mono text-[11px]">{e.dataOrigin}</span>}
              <span className="font-mono text-[11px] text-muted-foreground sm:hidden">+{fmtMs(e.elapsedRunMs)}</span>
            </div>
            <p className="break-words text-[13px] text-foreground/85">{e.summary}</p>
            {e.counts && Object.keys(e.counts).length > 0 && (
              <p className="break-words font-mono text-[11px] text-muted-foreground">{Object.entries(e.counts).map(([k, v]) => `${humanize(k)} ${v}`).join(" · ")}</p>
            )}
            {e.error && <p className="break-words font-mono text-[11px] text-[hsl(var(--ph-failed))]">{e.error.code}: {e.error.message}</p>}
            {e.recovery && <p className="break-all font-mono text-[11px] text-[hsl(var(--ph-recovered))]">recovery {JSON.stringify(e.recovery)}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(phaseColor) as RunEvent["phase"][]).map((p) => <PhaseBadge key={p} phase={p} />)}
      <span className="font-mono text-[10.5px] text-muted-foreground">dashed arrow = failed or skipped</span>
    </div>
  );
}
