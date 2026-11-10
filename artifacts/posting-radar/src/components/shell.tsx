import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Show, useClerk, useUser } from "@clerk/react";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const NAV = [
  ["/user-portal", "Radar"], ["/tracker", "Tracker"], ["/preferences", "Preferences"],
  ["/history", "History"], ["/how-it-works", "How it works"],
] as const;

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <img src={`${basePath}/logo.svg`} alt="" className="h-7 w-7" />
      <span className="font-display text-[17px] font-extrabold tracking-tight">Posting Radar</span>
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  return (
    <div className="grain min-h-[100dvh] bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-card focus:p-2">Skip to content</a>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2.5 sm:px-6">
          <Link href="/user-portal" aria-label="Posting Radar home"><Logo /></Link>
          <nav aria-label="Primary" className="ml-4 hidden gap-1 md:flex">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={loc === href ? "page" : undefined}
                className={cn("relative rounded-sm px-3 py-1.5 text-sm transition-colors", loc === href ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {label}
                {loc === href && <span className="absolute inset-x-3 -bottom-[11px] h-0.5 bg-primary" />}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Show when="signed-out">
              <span className="hidden rounded-sm border border-dashed px-2 py-1 font-mono text-[11px] text-muted-foreground sm:block">Guest · this browser</span>
              <Link href="/sign-in" className="rounded-sm border px-2.5 py-1.5 text-xs hover:bg-muted">Sign in</Link>
              <Link href="/sign-up" className="rounded-sm bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">Create account</Link>
            </Show>
            <Show when="signed-in">
            <span className="hidden max-w-[200px] truncate font-mono text-xs text-muted-foreground sm:block">{user?.primaryEmailAddress?.emailAddress}</span>
            <button onClick={() => signOut({ redirectUrl: basePath || "/" })}
              className="inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs hover:bg-muted">
              <LogOut className="h-3.5 w-3.5" />Sign out
            </button>
            </Show>
          </div>
        </div>
        <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto border-t px-3 py-1.5 md:hidden">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} aria-current={loc === href ? "page" : undefined}
              className={cn("shrink-0 rounded-sm px-2.5 py-1 text-[13px]", loc === href ? "bg-secondary text-secondary-foreground" : "text-muted-foreground")}>{label}</Link>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
