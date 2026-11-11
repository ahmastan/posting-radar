import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, Search } from "lucide-react";
import { ApiError, updateStatus, useSources, useTracker, type TrackerEntry } from "@/lib/api";
import { Bone, ErrorState, PageHead, Tag } from "@/components/bits";
import { fmtTime, humanize } from "@/lib/local";
import { cn } from "@/lib/utils";

const STATUSES: TrackerEntry["status"][] = ["saved", "applied", "skipped"];

export default function Tracker() {
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("added");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setSearch(input.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer.current);
  }, [input]);

  const q = useTracker(status, source, page, search, sort);
  const sources = useSources();
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  return (
    <>
      <PageHead kicker="Durable record" title="Tracker" />
      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Status filter">
        {["", ...STATUSES].map((s) => (
          <button key={s || "all"} onClick={() => { setStatus(s); setPage(1); }} aria-pressed={status === s}
            className={cn("flex items-baseline gap-2 rounded-sm border px-3 py-2 text-sm transition-colors", status === s ? "border-secondary bg-secondary text-secondary-foreground" : "bg-card hover:bg-muted")}>
            {s ? humanize(s) : "All"}
            <span className="font-mono text-xs opacity-70">{q.data ? (s ? q.data.stats[s] ?? 0 : Object.entries(q.data.stats).filter(([k]) => STATUSES.includes(k as TrackerEntry["status"])).reduce((a, [, v]) => a + v, 0)) : ""}</span>
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search company or role</span>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search company or role"
            className="w-full rounded-sm border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:border-primary" />
        </label>
        <label className="sm:w-60">
          <span className="sr-only">Source</span>
          <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} className="w-full rounded-sm border bg-card px-3 py-2 text-sm">
            <option value="">All sources</option>
            {sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="sm:w-48">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className="w-full rounded-sm border bg-card px-3 py-2 text-sm">
            <option value="added">Recently added</option>
            <option value="posted">Date posted · newest</option>
            <option value="posted-asc">Date posted · oldest</option>
          </select>
        </label>
      </div>

      {q.isLoading && <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Bone key={i} className="h-16" />)}</div>}
      {q.error && <ErrorState message="Tracker failed to load" onRetry={() => q.refetch()} />}
      {q.data && q.data.entries.length === 0 && (
        <div className="gridlines rounded-md border px-6 py-16 text-center">
          <p className="font-display text-xl font-bold">{search || status || source ? "Nothing matches these filters" : "Your tracker is empty"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{search || status || source ? "Loosen a filter to see more." : "Run a sweep from Radar; matching postings land here."}</p>
        </div>
      )}
      {q.data && q.data.entries.length > 0 && (
        <ul className={cn("divide-y rounded-md border bg-card transition-opacity", q.isFetching && "opacity-80")}>
          {q.data.entries.map((e) => <Row key={e.id} entry={e} sourceName={sources.data?.find((s) => s.id === e.sourceId)?.name} />)}
        </ul>
      )}
      {q.data && q.data.total > 0 && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between font-mono text-xs text-muted-foreground">
          <span>{q.data.total} entries · page {page} of {pages}</span>
          <span className="flex gap-1">
            <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-sm border bg-card p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <button aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-sm border bg-card p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </span>
        </nav>
      )}
    </>
  );
}

function Row({ entry, sourceName }: { entry: TrackerEntry; sourceName?: string }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<TrackerEntry["status"] | null>(null);
  const [err, setErr] = useState<{ msg: string; conflict: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = pending ?? entry.status;
  const p = entry.posting;

  async function choose(s: TrackerEntry["status"]) {
    if (s === entry.status && !pending) return;
    setPending(s); setErr(null); setSaving(true);
    try {
      await updateStatus(entry.id, s, entry.revision);
      setPending(null);
      await qc.invalidateQueries({ queryKey: ["tracker"] });
    } catch (e) {
      setErr({ msg: (e as Error).message, conflict: e instanceof ApiError && e.status === 409 });
    } finally { setSaving(false); }
  }

  return (
    <li className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:text-primary">{p.company}<ExternalLink className="h-3 w-3 opacity-60" /></a>
          <span className="text-sm text-muted-foreground">{p.role}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Tag>{p.category}</Tag>
          {p.locations.slice(0, 3).map((l) => <Tag key={l}>{l}</Tag>)}
          {p.locations.length > 3 && <Tag>+{p.locations.length - 3}</Tag>}
          {p.workModel && p.workModel !== "unknown" ? <Tag>{p.workModel === "onsite" ? "in person" : p.workModel}</Tag> : p.remote && <Tag>remote</Tag>}
          {p.pay && p.pay !== "unknown" && <Tag>{p.pay}</Tag>}
          {p.postedAt && <Tag>posted {p.postedAt}</Tag>}
          <Tag>sponsorship {p.sponsorship}</Tag>
          {p.closed && <Tag>closed</Tag>}
          {p.ambiguous && <Tag>ambiguous row</Tag>}
          <Tag>{sourceName ?? entry.sourceId} · {entry.season}</Tag>
          <Tag>{entry.dataOrigin} · {fmtTime(entry.createdAt)}</Tag>
        </div>
        {entry.reasons.length > 0 && <p className="mt-1.5 text-xs text-muted-foreground">Matched because: {entry.reasons.join("; ")}</p>}
        {err && (
          <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--ph-failed))]">
            {err.conflict ? "This entry changed elsewhere. Your choice is kept below." : `Status not saved: ${err.msg}`}
            {err.conflict
              ? <button className="font-medium underline" onClick={() => { setPending(null); setErr(null); qc.invalidateQueries({ queryKey: ["tracker"] }); }}>Reload newest</button>
              : <button className="font-medium underline" onClick={() => choose(shown)}>Retry</button>}
          </p>
        )}
      </div>
      <div role="radiogroup" aria-label={`Status for ${p.company}`} className="flex w-fit rounded-sm border bg-background p-0.5">
        {STATUSES.map((s) => (
          <button key={s} role="radio" aria-checked={shown === s} disabled={saving} onClick={() => choose(s)}
            className={cn("rounded-[3px] px-2.5 py-1 text-xs capitalize transition-colors",
              shown === s ? (s === "applied" ? "bg-[hsl(var(--ph-succeeded))] text-white" : s === "skipped" ? "bg-muted-foreground text-background" : "bg-secondary text-secondary-foreground") : "text-muted-foreground hover:text-foreground",
              shown === s && pending && "ring-2 ring-primary/50")}>{s}</button>
        ))}
      </div>
    </li>
  );
}
