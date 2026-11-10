import { useCallback, useEffect, useState } from "react";
import { getReplay, type Run, type RunEvent } from "@/lib/api";

export const MAX_GAP_MS = 1400;
export const MIN_GAP_MS = 140;

/** Client-only playback of a persisted run. Never touches live state or the server beyond one GET. */
export function useReplay(runId?: string) {
  const [data, setData] = useState<{ run: Run; events: RunEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!runId) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setError(null); setData(null); setIdx(0); setPlaying(false);
    getReplay(runId)
      .then((d) => {
        if (cancelled) return;
        setData({ run: d.run, events: [...d.events].sort((a, b) => a.sequence - b.sequence) });
        setPlaying(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [runId, nonce]);

  const events = data?.events ?? [];
  useEffect(() => {
    if (!playing || idx >= events.length) {
      if (idx >= events.length && events.length) setPlaying(false);
      return;
    }
    const prev = idx === 0 ? 0 : events[idx - 1].elapsedRunMs;
    const gap = Math.min(Math.max(events[idx].elapsedRunMs - prev, MIN_GAP_MS), MAX_GAP_MS) / speed;
    const t = setTimeout(() => setIdx((i) => i + 1), idx === 0 ? 250 : gap);
    return () => clearTimeout(t);
  }, [playing, idx, events, speed]);

  const restart = useCallback(() => { setIdx(0); setPlaying(true); }, []);
  const toggle = useCallback(() => {
    setPlaying((p) => { if (!p && idx >= events.length) setIdx(0); return !p; });
  }, [idx, events.length]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, shown: events.slice(0, idx), total: events.length, idx, playing, toggle, restart, speed, setSpeed, retry, finished: events.length > 0 && idx >= events.length };
}
