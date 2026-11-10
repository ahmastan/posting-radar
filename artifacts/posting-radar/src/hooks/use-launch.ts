import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, useAccount, savePreferences, startRun, type Preferences } from "@/lib/api";
import { acceptKey, clearDraft, pendingKey, prefsFromDraft, readDraft, samePrefs, writeDraft } from "@/lib/local";

export type LaunchError = { kind: "prefs" | "conflict" | "run"; message: string; ambiguous?: boolean };

/** Flushes any valid pending preference draft, then starts a run with a retained idempotency key. */
export function useLaunch() {
  const qc = useQueryClient();
  const accountId = useAccount().data?.id;
  const user = accountId ? { id: accountId } : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LaunchError | null>(null);

  async function launch(sourceIds: string[], retryOf?: string): Promise<string | null> {
    if (!user) return null;
    setBusy(true); setError(null);
    try {
      let prefs: Preferences;
      try {
        prefs = await qc.fetchQuery({ queryKey: ["preferences"], queryFn: () => api<Preferences>("/preferences"), staleTime: 0 });
      } catch (e) {
        setError({ kind: "prefs", message: `Could not confirm preferences: ${(e as Error).message}` });
        return null;
      }
      const draft = readDraft(user.id);
      if (draft) {
        if (draft.baseRevision !== prefs.revision) {
          setError({ kind: "conflict", message: `Your unsaved preference draft was based on revision ${draft.baseRevision}, but revision ${prefs.revision} is now current. Resolve it in Preferences before running.` });
          return null;
        }
        const next = prefsFromDraft(draft, prefs.revision);
        if (!samePrefs(next, prefs)) {
          try {
            prefs = await savePreferences(next);
            qc.setQueryData(["preferences"], prefs);
            const current = readDraft(user.id);
            if (current && !samePrefs(prefsFromDraft(current, prefs.revision), next)) {
              writeDraft(user.id, { ...current, baseRevision: prefs.revision });
              setError({ kind: "prefs", message: "Preferences were edited while saving. The newer draft is kept. Review it before starting another sweep." });
              return null;
            }
            clearDraft(user.id);
          } catch (e) {
            const conflict = e instanceof ApiError && e.status === 409;
            setError({ kind: conflict ? "conflict" : "prefs", message: conflict ? "Preferences changed elsewhere. Your draft is kept; reload or resave in Preferences." : `Pending preferences failed to save, so the run was blocked: ${(e as Error).message}` });
            return null;
          }
        } else clearDraft(user.id);
      }
      const slot = retryOf ? `${user.id}:retry:${retryOf}` : `${user.id}:run`;
      const key = pendingKey(slot);
      try {
        const res = await startRun(sourceIds, key, prefs.revision, retryOf);
        acceptKey(slot);
        qc.invalidateQueries({ queryKey: ["runs"] });
        return res.id;
      } catch (e) {
        const definite = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
        if (definite && e.status !== 409) acceptKey(slot);
        setError({ kind: "run", message: (e as Error).message, ambiguous: !definite });
        return null;
      }
    } finally {
      setBusy(false);
    }
  }
  return { launch, busy, error, clearError: () => setError(null) };
}
