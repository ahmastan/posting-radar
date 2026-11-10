import type { ReactNode } from "react";
import { AlertTriangle, Database, Globe, RotateCcw } from "lucide-react";
import type { Run, RunEvent, Source, SourceResult } from "@/lib/api";
import { ago, fmtTime, humanize } from "@/lib/local";
import { cn } from "@/lib/utils";

export const phaseColor: Record<RunEvent["phase"], string> = {
  started: "var(--ph-started)", succeeded: "var(--ph-succeeded)", failed: "var(--ph-failed)",
  retrying: "var(--ph-retrying)", recovered: "var(--ph-recovered)", skipped: "var(--ph-skipped)",
};

export function PhaseBadge({ phase }: { phase: RunEvent["phase"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider"
      style={{ color: `hsl(${phaseColor[phase]})`, background: `hsl(${phaseColor[phase]} / .1)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${phaseColor[phase]})` }} />
      {phase}
    </span>
  );
}

const stateTone: Record<Run["state"], string> = {
  queued: "var(--ph-skipped)", running: "var(--ph-started)", succeeded: "var(--ph-succeeded)",
  degraded: "var(--ph-retrying)", failed: "var(--ph-failed)", interrupted: "var(--ph-recovered)",
};
export function RunStateBadge({ state }: { state: Run["state"] }) {
  const live = state === "running" || state === "queued";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider"
      style={{ color: `hsl(${stateTone[state]})`, borderColor: `hsl(${stateTone[state]} / .35)` }}>
      <span className="relative flex h-1.5 w-1.5">
        {live && <span className="ping absolute inset-0 rounded-full" style={{ background: `hsl(${stateTone[state]})` }} />}
        <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${stateTone[state]})` }} />
      </span>
      {state}
    </span>
  );
}

export function Panel({ title, kicker, action, children, className }: { title?: ReactNode; kicker?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-md border bg-card", className)}>
      {(title || kicker || action) && (
        <header className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {kicker && <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">{kicker}</p>}
            {title && <h2 className="font-display text-lg font-semibold leading-tight">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Counts({ counts }: { counts?: Record<string, number> }) {
  const entries = Object.entries(counts ?? {});
  if (!entries.length) return <p className="font-mono text-xs text-muted-foreground">No counts recorded</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-1">
          <dt className="truncate text-xs text-muted-foreground">{humanize(k)}</dt>
          <dd className="font-mono text-sm tabular-nums">{v.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SourceResultCard({ result, source }: { result: SourceResult; source?: Source }) {
  const bad = /fail|error|interrupt/i.test(result.outcome);
  return (
    <article className={cn("rounded-md border bg-background/60 p-4", bad && "border-[hsl(var(--ph-failed)/.4)]")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{source?.name ?? result.sourceId}</h3>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{source?.repo ?? result.sourceId}</p>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: `hsl(${bad ? "var(--ph-failed)" : result.outcome === "pending" ? "var(--muted-foreground)" : /degrad|cache|skip/i.test(result.outcome) ? "var(--ph-retrying)" : "var(--ph-succeeded)"})` }}>
          {humanize(result.outcome)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {result.initialImport && <Tag tone="primary">Initial import</Tag>}
        {result.dataOrigin && (
          <Tag>{result.dataOrigin === "cache" ? <Database className="h-3 w-3" /> : <Globe className="h-3 w-3" />}{result.dataOrigin === "cache" ? "From cache" : "Live fetch"}</Tag>
        )}
        {result.cachedAt && <Tag>cached {fmtTime(result.cachedAt)} · {ago(result.cachedAt)}</Tag>}
      </div>
      <div className="mt-3"><Counts counts={result.counts} /></div>
      {result.error && (
        <div className="mt-3 flex gap-2 rounded-sm border border-[hsl(var(--ph-failed)/.3)] bg-[hsl(var(--ph-failed)/.06)] p-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--ph-failed))]" />
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-[hsl(var(--ph-failed))]">{result.error.code}</p>
            <p className="break-words text-foreground/80">{result.error.message}</p>
            {!bad && <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><RotateCcw className="h-3 w-3" /> Recorded error kept after recovery</p>}
          </div>
        </div>
      )}
    </article>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "primary" }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px]",
      tone === "primary" ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground")}>{children}</span>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--ph-failed)/.35)] bg-[hsl(var(--ph-failed)/.05)] p-4 text-sm">
      <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-[hsl(var(--ph-failed))]" />{message}</span>
      {onRetry && <Btn variant="outline" onClick={onRetry}>Try again</Btn>}
    </div>
  );
}

export function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-sm bg-muted motion-reduce:animate-none", className)} />;
}

export function Btn({ variant = "solid", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "outline" | "ghost" | "ink" }) {
  return (
    <button {...p} className={cn(
      "inline-flex items-center justify-center gap-2 rounded-sm px-3.5 py-2 text-sm font-medium transition-[transform,background-color,color,border-color] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45",
      variant === "solid" && "bg-primary text-primary-foreground hover:bg-primary/90",
      variant === "ink" && "bg-secondary text-secondary-foreground hover:bg-secondary/90",
      variant === "outline" && "border bg-card hover:border-foreground/30 hover:bg-muted",
      variant === "ghost" && "text-muted-foreground hover:bg-muted hover:text-foreground",
      className)} />
  );
}

export function PageHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="rise mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">{kicker}</p>
        <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}
