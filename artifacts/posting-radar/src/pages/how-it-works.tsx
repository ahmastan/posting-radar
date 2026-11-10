import { Link } from "wouter";
import { ArrowRight, Database, Globe, Monitor, Server } from "lucide-react";
import { useRuns } from "@/lib/api";
import { Bone, PageHead } from "@/components/bits";
import { Legend } from "@/components/event-diagram";
import { ReplayPanel } from "@/components/replay-panel";

const LAYERS = [
  { name: "Page", icon: Monitor, body: "Your browser. It asks for a run, then listens to the server's event stream. It never invents progress; it only draws what the server persisted." },
  { name: "Server", icon: Server, body: "Coordinates the sweep, applies your preference revision, retries failed fetches, and writes each event to the database before streaming it." },
  { name: "Database", icon: Database, body: "Holds snapshots of each source, your tracker, and every event. A baseline snapshot is how a new posting is told apart from an old one." },
  { name: "GitHub", icon: Globe, body: "The approved README sources. If a fetch fails, the last good cache can be used and is labeled as cache with its timestamp." },
];

export default function HowItWorks() {
  const runs = useRuns();
  const done = runs.data?.find((r) => r.state !== "running" && r.state !== "queued");
  return (
    <>
      <PageHead kicker="No black box" title="How it works" />
      <ol className="mb-8 grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-4">
        {LAYERS.map((l, i) => (
          <li key={l.name} className="rise relative bg-card p-5" style={{ animationDelay: `${i * 70}ms` }}>
            <span className="font-mono text-[10.5px] text-muted-foreground">layer {i + 1}</span>
            <h2 className="mt-1 flex items-center gap-2 font-display text-xl font-bold"><l.icon className="h-5 w-5 text-primary" />{l.name}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{l.body}</p>
            {i < 3 && <ArrowRight className="absolute right-3 top-5 hidden h-4 w-4 text-muted-foreground md:block" />}
          </li>
        ))}
      </ol>
      <div className="mb-6 space-y-3">
        <p className="max-w-2xl text-sm text-muted-foreground">Each arrow below is one real event from your most recent finished run: which layer talked to which, whether it worked, which attempt it was, and how long it took. Failed attempts stay visible even when a retry recovers.</p>
        <Legend />
      </div>
      {runs.isLoading && <Bone className="h-72" />}
      {runs.data && !done && (
        <div className="gridlines rounded-md border px-6 py-16 text-center">
          <p className="font-display text-xl font-bold">No finished run to show yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Once a sweep completes, its real event trail is replayed here.</p>
          <Link href="/user-portal" className="mt-4 inline-block rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Go to Radar</Link>
        </div>
      )}
      {done && <ReplayPanel runId={done.id} />}
    </>
  );
}
