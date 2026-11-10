import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="grain gridlines flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="rise max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">404 · no signal</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold tracking-tight">Nothing on the radar here.</h1>
        <p className="mt-2 text-muted-foreground">This address does not match any page.</p>
        <Link href="/" className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Back to start</Link>
      </div>
    </div>
  );
}
