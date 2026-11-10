# Posting Radar

## Confirmed scope
Independent secure accounts with optional sign-in. Guests can set browser-specific preferences, run checks, view matches/history/replay (including internship previews without an account), and maintain a browser-specific baseline via a signed anonymous session. Sign-in is required only for personal saved/applied/skipped tracking and cross-device access. Preserve guest filters and visible results through sign-in, then explicitly offer to copy filters and save current matches; never merge guest baselines or automatically save guest results. Guest sessions expire after 30 days. The first successful source run imports currently active matching postings (guest observations remain unsaved until explicit account handoff). Preferences start broad: all locations, remote and on-site, all role categories, no sponsorship restriction, unknown sponsorship included and explicitly labeled, no excluded companies.

Approved sources (verified 2026-11-10):
- SimplifyJobs/New-Grad-Positions, `dev/README.md`, current title 2026 New Grad Positions (2025–2026 graduates), 18,351 stars.
- SimplifyJobs/Summer2027-Internships, `dev/README.md`, Summer 2027, 48,372 stars.

Both had README updates approximately 30 minutes apart on the verification date. Do not silently roll seasons forward.

## Development
Web artifact: `artifacts/posting-radar`. One Express process hosts the API, durable queue worker, and Vite middleware. Managed workflow supplies PORT and BASE_PATH. Same-origin `/api` requests use Clerk cookies. PostgreSQL is the source of truth.

Install: `pnpm install`. Development schema: `pnpm --filter @workspace/posting-radar db:migrate` (development/post-merge only; never run migrations on production startup). Build/test/typecheck are root package scripts.
