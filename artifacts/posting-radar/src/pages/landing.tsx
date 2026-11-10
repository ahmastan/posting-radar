import { Link } from "wouter";
import { ArrowRight, Database, Globe, Monitor, Server } from "lucide-react";
import { Logo } from "@/components/shell";

const LANES = [
  { n: "Page", i: Monitor }, { n: "Server", i: Server }, { n: "Database", i: Database }, { n: "GitHub", i: Globe },
];
const TRACE: [number, number, string, string][] = [
  [0, 1, "request run", "var(--ph-started)"],
  [1, 2, "load baseline", "var(--ph-succeeded)"],
  [1, 3, "fetch README", "var(--ph-failed)"],
  [1, 3, "fetch README, try 2", "var(--ph-retrying)"],
  [1, 2, "use cache", "var(--ph-recovered)"],
  [1, 0, "stream result", "var(--ph-succeeded)"],
];

export default function Landing() {
  return (
    <div className="grain min-h-[100dvh] bg-background">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/sign-in" className="rounded-sm px-3 py-2 hover:bg-muted">Sign in</Link>
          <Link href="/sign-up" className="rounded-sm bg-secondary px-3 py-2 text-secondary-foreground hover:bg-secondary/90">Create account</Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-7xl gap-12 px-5 pb-20 pt-10 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
        <div className="rise">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">For new graduates, by receipt</p>
          <h1 className="mt-4 font-display text-5xl font-extrabold leading-[0.95] tracking-tight sm:text-7xl">
            Know exactly what your job search tool <span className="text-primary">did.</span>
          </h1>
          <p className="mt-6 max-w-lg text-lg text-muted-foreground">Posting Radar sweeps the community new-grad listings you choose, keeps only what matches your filters, and shows you every fetch, retry and cache fallback it took to get there.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/sign-up" className="inline-flex items-center gap-2 rounded-sm bg-primary px-5 py-3 font-medium text-primary-foreground transition-transform hover:-translate-y-0.5">Start your first sweep<ArrowRight className="h-4 w-4" /></Link>
            <Link href="/user-portal" className="rounded-sm border border-secondary bg-card px-5 py-3 font-medium hover:bg-muted">Try without signing in</Link>
            <Link href="/sign-in" className="rounded-sm px-5 py-3 font-medium text-muted-foreground hover:text-foreground">I have an account</Link>
          </div>
        </div>

        <figure className="rise rounded-md border bg-card p-5" style={{ animationDelay: "120ms" }} aria-label="Example of a run trace diagram">
          <div className="grid grid-cols-4 border-b pb-3">
            {LANES.map(({ n, i: I }) => (
              <div key={n} className="flex flex-col items-center gap-1"><span className="grid h-8 w-8 place-items-center rounded-full border"><I className="h-4 w-4" /></span><span className="font-display text-xs font-semibold">{n}</span></div>
            ))}
          </div>
          <div className="relative">
            <div className="pointer-events-none absolute inset-0 grid grid-cols-4">{LANES.map((l) => <div key={l.n} className="mx-auto w-px bg-border" />)}</div>
            {TRACE.map(([a, b, label, c], k) => {
              const lo = Math.min(a, b), hi = Math.max(a, b);
              return (
                <div key={k} className="rise relative h-11" style={{ animationDelay: `${300 + k * 160}ms` }}>
                  <div className="absolute top-7" style={{ left: `${(lo + 0.5) * 25}%`, width: `${(hi - lo) * 25}%` }}>
                    <div className={`draw border-t-2 ${c.includes("failed") ? "border-dashed" : ""}`} style={{ borderColor: `hsl(${c})`, transformOrigin: a < b ? "left" : "right", animationDelay: `${300 + k * 160}ms` }} />
                  </div>
                  <span className="absolute top-1 -translate-x-1/2 whitespace-nowrap bg-card px-1 text-[11px] font-medium" style={{ left: `${((lo + hi) / 2 + 0.5) * 25}%`, color: `hsl(${c})` }}>{label}</span>
                </div>
              );
            })}
          </div>
          <figcaption className="mt-3 font-mono text-[10.5px] text-muted-foreground">Illustration of the trace format. Your dashboard draws your own runs.</figcaption>
        </figure>
      </section>

      <section className="border-y bg-card">
        <div className="mx-auto grid max-w-7xl gap-px bg-border md:grid-cols-[1fr_1fr_1fr]">
          {[
            ["01", "Pick sources", "Choose from approved, community-maintained new-grad lists on GitHub. Select one or both."],
            ["02", "Write filters you can read", "Categories, locations, remote policy, sponsorship and company exclusions. Every revision is numbered."],
            ["03", "Track with a durable record", "Saved, applied or skipped. Status changes are versioned so two tabs cannot silently overwrite each other."],
          ].map(([n, t, b]) => (
            <div key={n} className="bg-card p-8">
              <span className="font-mono text-sm text-primary">{n}</span>
              <h2 className="mt-3 font-display text-2xl font-bold">{t}</h2>
              <p className="mt-2 text-muted-foreground">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 py-20">
        <div className="grid gap-10 md:grid-cols-[0.9fr_1.1fr]">
          <h2 className="font-display text-4xl font-extrabold leading-tight tracking-tight">The failures stay on the page.</h2>
          <ul className="space-y-5 text-muted-foreground">
            <li><strong className="text-foreground">Retries are shown, not swallowed.</strong> A failed fetch and the attempt that recovered it are both drawn.</li>
            <li><strong className="text-foreground">Cache is labeled.</strong> When GitHub is unreachable, results from cache carry their cached-at time.</li>
            <li><strong className="text-foreground">First sweep says so.</strong> The first run imports currently open postings and marks them as an initial import, not as new.</li>
            <li><strong className="text-foreground">Filters change the future, not the past.</strong> Saving preferences never rewrites what is already in your tracker.</li>
            <li><strong className="text-foreground">Replay any run.</strong> Pause, restart and change speed on the real recorded event trail.</li>
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-20">
        <div className="flex flex-col items-start justify-between gap-6 rounded-md bg-secondary p-10 text-secondary-foreground md:flex-row md:items-center">
          <div>
            <h2 className="font-display text-3xl font-bold">Check it with your coffee. Trust it because you can see it.</h2>
            <p className="mt-2 opacity-75">Try it as a guest in this browser. Sign in when you want to save and track.</p>
          </div>
          <Link href="/user-portal" className="shrink-0 rounded-sm border border-current px-5 py-3 font-medium">Try without signing in</Link>
          <Link href="/sign-up" className="shrink-0 rounded-sm bg-primary px-5 py-3 font-medium text-primary-foreground">Create account</Link>
        </div>
      </section>
      <footer className="border-t py-6 text-center font-mono text-xs text-muted-foreground">Posting Radar · reads public GitHub listings · your data stays in your account</footer>
    </div>
  );
}
