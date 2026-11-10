import { Pause, Play, RotateCcw } from "lucide-react";
import { useReplay, MAX_GAP_MS } from "@/hooks/use-replay";
import { fmtMs } from "@/lib/local";
import { Bone, Btn, ErrorState, Panel } from "./bits";
import { EventDiagram, EventLog, Legend } from "./event-diagram";

export function ReplayPanel({ runId }: { runId: string }) {
  const r = useReplay(runId);
  const last = r.shown[r.shown.length - 1];
  return (
    <Panel kicker="Replay · read-only" title="Watch this run again"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="outline" onClick={r.toggle} disabled={!r.total} aria-label={r.playing ? "Pause replay" : "Resume replay"}>
            {r.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{r.playing ? "Pause" : r.finished ? "Play again" : "Resume"}
          </Btn>
          <Btn variant="ghost" onClick={r.restart} disabled={!r.total}><RotateCcw className="h-4 w-4" />Restart</Btn>
          <div role="radiogroup" aria-label="Playback speed" className="flex rounded-sm border p-0.5">
            {[0.5, 1, 2, 4].map((s) => (
              <button key={s} role="radio" aria-checked={r.speed === s} onClick={() => r.setSpeed(s)}
                className={`rounded-[3px] px-2 py-1 font-mono text-xs transition-colors ${r.speed === s ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{s}x</button>
            ))}
          </div>
        </div>
      }>
      {r.loading && <div className="space-y-3"><Bone className="h-10" /><Bone className="h-40" /></div>}
      {r.error && <ErrorState message={`Replay failed to load: ${r.error}`} onRetry={r.retry} />}
      {r.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.idx}>
              <div className="h-full origin-left bg-primary transition-transform duration-300" style={{ transform: `scaleX(${r.total ? r.idx / r.total : 0})` }} />
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              event {r.idx}/{r.total} · actual +{fmtMs(last?.elapsedRunMs ?? 0)} · gaps capped at {fmtMs(MAX_GAP_MS)}
            </p>
          </div>
          <Legend />
          <EventDiagram events={r.shown} emptyLabel={r.total ? "Starting playback" : "This run recorded no events"} />
          <details className="group">
            <summary className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground">Text log of replayed events ({r.shown.length})</summary>
            <div className="mt-3"><EventLog events={r.shown} /></div>
          </details>
        </div>
      )}
    </Panel>
  );
}
