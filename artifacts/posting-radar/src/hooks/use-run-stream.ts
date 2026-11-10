import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunEvent } from "@/lib/api";

export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "complete";

/** Live persisted-event stream. Dedupes by sequence; reconnects from the last seen sequence. */
export function useRunStream(runId?: string) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [warning, setWarning] = useState<string | null>(null);
  const qc = useQueryClient();
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    setEvents([]);
    setWarning(null);
    if (!runId) { setStatus("idle"); return; }
    const seen = new Map<number, RunEvent>();
    let last = 0;
    let es: EventSource | null = null;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus("connecting");

    const open = () => {
      es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${last}`);
      es.onopen = () => setStatus("live");
      es.addEventListener("stream-error", (m) => {
        let msg = "The server could not read stored events.";
        try { const d = JSON.parse((m as MessageEvent).data); msg = d.message || d.error || msg; } catch { /* plain */ }
        setWarning(msg);
        setStatus("reconnecting");
      });
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as RunEvent;
          setWarning(null);
          if (seen.has(ev.sequence)) return;
          seen.set(ev.sequence, ev);
          last = Math.max(last, ev.sequence);
          setEvents([...seen.values()].sort((a, b) => a.sequence - b.sequence));
          if (ev.phase !== "started") qcRef.current.invalidateQueries({ queryKey: ["run", runId] });
        } catch { /* malformed frame ignored */ }
      };
      es.addEventListener("complete", () => {
        done = true;
        es?.close();
        setStatus("complete");
        qcRef.current.invalidateQueries({ queryKey: ["runs"] });
        qcRef.current.invalidateQueries({ queryKey: ["run", runId] });
        qcRef.current.invalidateQueries({ queryKey: ["tracker"] });
        qcRef.current.invalidateQueries({ queryKey: ["sources"] });
      });
      es.onerror = () => {
        if (done) return;
        if (es && es.readyState === EventSource.CLOSED) {
          setStatus("reconnecting");
          timer = setTimeout(open, 1500);
        } else setStatus("reconnecting");
      };
    };
    open();
    return () => { done = true; es?.close(); if (timer) clearTimeout(timer); };
  }, [runId]);

  return { events, status, warning };
}
