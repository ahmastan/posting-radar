import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Save } from "lucide-react";
import { ApiError, api, roles, savePreferences, usePreferences, type Preferences } from "@/lib/api";
import { GuestNote, useAccountId } from "@/components/guest";
import { Bone, Btn, ErrorState, PageHead, Panel } from "@/components/bits";
import { clearDraft, draftFromPrefs, parseLines, parseList, prefsFromDraft, readDraft, samePrefs, writeDraft, type PrefDraft } from "@/lib/local";
import { cn } from "@/lib/utils";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; rev: number } | { kind: "error"; msg: string } | { kind: "conflict" };

export default function PreferencesPage() {
  const q = usePreferences();
  const qc = useQueryClient();
  const uid = useAccountId();
  const [draft, setDraft] = useState<PrefDraft | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const init = useRef<string | null>(null);
  const draftRef = useRef<PrefDraft | null>(null);
  draftRef.current = draft;

  useEffect(() => {
    if (!q.data || !uid || init.current === uid) return;
    init.current = uid;
    const stored = readDraft(uid);
    if (stored) {
      setDraft(stored);
      if (stored.baseRevision !== q.data.revision) setStatus({ kind: "conflict" });
    } else setDraft(draftFromPrefs(q.data));
  }, [q.data, uid]);

  const server = q.data;
  const dirty = !!(draft && server && (draft.baseRevision !== server.revision || !samePrefs(prefsFromDraft(draft, server.revision), server)));

  function update(patch: Partial<PrefDraft>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    draftRef.current = next;
    setDraft(next);
    writeDraft(uid, next);
    if (status.kind === "saved" || status.kind === "error") setStatus({ kind: "idle" });
  }

  async function save(force = false) {
    if (!draft || !server) return;
    setStatus({ kind: "saving" });
    try {
      const fresh = force ? await qc.fetchQuery({ queryKey: ["preferences"], queryFn: () => api<Preferences>("/preferences"), staleTime: 0 }) : server;
      const sent = draft;
      const saved = await savePreferences(prefsFromDraft(sent, force ? fresh.revision : sent.baseRevision));
      qc.setQueryData(["preferences"], saved);
      const current = draftRef.current;
      if (current && current !== sent && !samePrefs(prefsFromDraft(current, saved.revision), saved)) {
        // Edited while the save was in flight: keep newer input, rebase onto saved revision.
        const rebased = { ...current, baseRevision: saved.revision };
        setDraft(rebased); writeDraft(uid, rebased);
      } else { setDraft(draftFromPrefs(saved)); clearDraft(uid); }
      setStatus({ kind: "saved", rev: saved.revision });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setStatus({ kind: "conflict" });
      else setStatus({ kind: "error", msg: (e as Error).message });
    }
  }

  async function reloadNewest() {
    const fresh = await q.refetch();
    if (fresh.data) { clearDraft(uid); setDraft(draftFromPrefs(fresh.data)); setStatus({ kind: "idle" }); }
  }

  if (q.isLoading || (!draft && !q.error)) return <><PageHead kicker="Filters" title="Preferences" /><div className="space-y-4"><Bone className="h-40" /><Bone className="h-56" /></div></>;
  if (q.error || !draft || !server) return <><PageHead kicker="Filters" title="Preferences" /><ErrorState message="Preferences failed to load" onRetry={() => q.refetch()} /></>;

  const locCount = parseLines(draft.locations).length, exCount = parseList(draft.excludedCompanies).length;

  return (
    <>
      <PageHead kicker={`Filters · revision ${server.revision}`} title="Preferences">
        <div className="flex items-center gap-3">
          <SaveStatus status={status} dirty={dirty} />
          <Btn onClick={() => save(false)} disabled={!dirty || status.kind === "saving" || status.kind === "conflict"}><Save className="h-4 w-4" />Save revision {server.revision + 1}</Btn>
        </div>
      </PageHead>

      {status.kind === "conflict" && (
        <div role="alert" className="rise mb-6 rounded-md border border-[hsl(var(--ph-retrying)/.5)] bg-[hsl(var(--ph-retrying)/.08)] p-4">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-[hsl(var(--ph-retrying))]" />Preferences were changed elsewhere</p>
          <p className="mt-1 text-sm text-muted-foreground">Your draft was based on revision {draft.baseRevision}; the newest is revision {server.revision}. Nothing has been discarded. Choose explicitly:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn variant="outline" onClick={reloadNewest}>Reload newest (discard my draft)</Btn>
            <Btn variant="ink" onClick={() => save(true)}>Save my draft over newest</Btn>
          </div>
        </div>
      )}

      <GuestNote>Guest filters are stored in this browser's 30-day session. After you sign in you can apply them to your account explicitly.</GuestNote>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">Changes apply to postings discovered after you save. Entries already in your tracker stay put. Unsaved edits are kept on this device and saved automatically before your next sweep.</p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel kicker="Group 1 · any of" title="Role categories">
          <p className="mb-3 text-xs text-muted-foreground">None selected means every category. Selected categories combine with OR.</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {roles.map((r) => {
              const on = draft.roles.includes(r);
              return (
                <label key={r} className={cn("flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm transition-colors", on ? "border-primary/60 bg-primary/5" : "hover:bg-muted")}>
                  <input type="checkbox" checked={on} onChange={() => update({ roles: on ? draft.roles.filter((x) => x !== r) : [...draft.roles, r] })} className="accent-[hsl(var(--primary))]" />{r}
                </label>
              );
            })}
          </div>
        </Panel>

        <Panel kicker="Group 2 · any of" title="Locations">
          <label htmlFor="locs" className="mb-2 block text-xs text-muted-foreground">One per line (commas stay part of the value, so "New York, NY" works). Each line matches as a case-insensitive substring of a posting location; any line matching is enough. Empty means anywhere. {locCount > 0 && <span className="font-mono">{locCount} listed</span>}</label>
          <textarea id="locs" rows={5} value={draft.locations} onChange={(e) => update({ locations: e.target.value })} placeholder={"New York, NY\nSeattle\nToronto"}
            className="w-full rounded-sm border bg-background p-3 font-mono text-sm outline-none focus:border-primary" />
          <fieldset className="mt-4">
            <legend className="mb-2 text-xs text-muted-foreground">Remote postings</legend>
            <Seg value={draft.remotePolicy} onChange={(v) => update({ remotePolicy: v })} options={[["any", "Include"], ["only", "Remote only"], ["exclude", "Exclude"]]} />
            <p className="mt-2 text-xs text-muted-foreground">Remote only still requires a listed location to match, if you listed any.</p>
          </fieldset>
        </Panel>

        <Panel kicker="Group 3" title="Sponsorship">
          <Seg value={draft.sponsorship} onChange={(v) => update({ sponsorship: v })} options={[["any", "Not needed"], ["required", "I need sponsorship"]]} />
          {(
            <div className="mt-4 space-y-3 text-sm">
              <p className="text-muted-foreground">{draft.sponsorship === "required" ? "Postings marked no sponsorship or citizenship required are removed." : "Applies only when you need sponsorship; saved either way."}</p>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" checked={draft.includeUnknown} onChange={(e) => update({ includeUnknown: e.target.checked })} className="mt-0.5 accent-[hsl(var(--primary))]" />
                <span>Keep postings where sponsorship is unknown</span>
              </label>
            </div>
          )}
        </Panel>

        <Panel kicker="Always wins" title="Excluded companies">
          <label htmlFor="exc" className="mb-2 block text-xs text-muted-foreground">One per line or comma separated. Exact company name, case-insensitive. Overrides every match above. {exCount > 0 && <span className="font-mono">{exCount} excluded</span>}</label>
          <textarea id="exc" rows={5} value={draft.excludedCompanies} onChange={(e) => update({ excludedCompanies: e.target.value })}
            className="w-full rounded-sm border bg-background p-3 font-mono text-sm outline-none focus:border-primary" />
        </Panel>
      </div>
      <p className="mt-6 font-mono text-xs text-muted-foreground">Rule: (any selected category) AND (any listed location, honoring remote policy) AND (sponsorship rule), then remove excluded companies.</p>
    </>
  );
}

function SaveStatus({ status, dirty }: { status: Status; dirty: boolean }) {
  const base = "flex items-center gap-1.5 font-mono text-xs";
  if (status.kind === "saving") return <span className={base} aria-live="polite">Saving</span>;
  if (status.kind === "saved" && !dirty) return <span className={cn(base, "text-[hsl(var(--ph-succeeded))]")} aria-live="polite"><CheckCircle2 className="h-3.5 w-3.5" />Saved as revision {status.rev}</span>;
  if (status.kind === "error") return <span role="alert" className={cn(base, "max-w-xs text-[hsl(var(--ph-failed))]")}>Not saved: {status.msg}. Edits kept.</span>;
  if (dirty) return <span className={cn(base, "text-muted-foreground")}>Unsaved draft</span>;
  return <span className={cn(base, "text-muted-foreground")}>Up to date</span>;
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" className="inline-flex flex-wrap rounded-sm border bg-background p-0.5">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn("rounded-[3px] px-3 py-1.5 text-sm transition-colors", value === v ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground")}>{l}</button>
      ))}
    </div>
  );
}
