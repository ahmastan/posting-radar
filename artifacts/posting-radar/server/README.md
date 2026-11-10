# Runtime guarantees and limits

- Clerk's verified account ID scopes saved personal tracking. Guests use a cryptographically signed HttpOnly/SameSite browser cookie backed by an expiring anonymous-session record. The browser never supplies an owner ID.
- Guests may edit browser-specific preferences, run checks, and access their own results, baseline, history and event/replay streams. Guest checks do not create tracker entries or imply cross-device persistence. Tracker APIs require a signed-in account.
- Sign-in retains the anonymous cookie, unsaved local filters, and visible guest results. The user separately chooses whether to copy filters or save matches. Handoff is idempotent, verifies both the account and anonymous-session ownership, never moves account baselines, and never overwrites existing tracker statuses.
- PostgreSQL holds request idempotency, frozen preference revisions, per-user baselines, run/source results, tracker revisions, and ordered events.
- The background worker claims saved queue rows independently of HTTP clients. A PostgreSQL session advisory lock elects one worker. Each private commit is fenced by its worker token. On leader restart, unfinished runs and open steps are marked interrupted; successful source commits remain intact.
- Source match inserts, observations, cursor advancement, source result, and terminal save event share a transaction. Cached fallback may save explicitly labeled observations, but never advances a fresh cursor.
- Only successfully parsed README bodies become fallback snapshots. HTTP 304 revalidates a validated body. Network/timeout/5xx/rate-limit errors get one retry, with at most a 2-second wait. Each request has a 10-second abort and a 12-MB body limit.
- Raw snapshots are shared downloads, not private baselines. Snapshot retention is indefinite so historical explanations remain available. No pruning is currently performed.

## Identity and matching
Use canonical application URLs across sources. Remove `utm_*`, and remove `ref`, `source`, `src`, or `gh_src` only when their value is known to be `Simplify`/`GHList`. Preserve other query parameters, paths, and fragments to avoid collapsing distinct jobs. Closed postings lacking application URLs use an explicitly ambiguous SHA-256 company/title/sorted-locations/category fingerprint; these rows are never imported. Active rows lacking a valid URL fail parsing.

Previously seen identities persist beyond the latest baseline, so changed/reordered/reappearing rows are not silently reconsidered. Global job metadata can update; user status and revisions never change during ingestion. Historical preference reconsideration is not supported.

Locations match case-insensitive literal substrings (any selected location against any listed location). Categories use the source section heading. Selected options are OR within each group and AND across groups. Empty location/category selections mean all. Company exclusions are exact, case-insensitive matches and override inclusion. Remote is explicit in a listed location. Source legend symbols alone indicate no sponsorship or citizenship. Missing symbols mean **unknown**, never sponsorship offered. Requiring sponsorship with unknown included retains unknowns as uncertain candidates, not verified eligibility.

## Measurement
Step durations use the server's monotonic clock. They include persisted start-event cost and the work leading up to the terminal-event write. They do not include that terminal write's own commit/flush or browser delivery. A terminal save event is committed atomically with the data it describes, never emitted before commit. Queue elapsed time uses the persisted request time to bridge worker handoff, then a monotonic clock. Interrupted work has no invented duration.

The event stream polls persisted records every 300 ms and supports sequence-based reconnect/catch-up. Live execution is never slowed for animation. Replay is a separate browser-only presentation using read-only recorded events; display pacing does not modify original timestamps or measurements.

## Development checks
`pnpm test` covers real-source parser excerpts and synthetic edge cases, retry/cache/revalidation, full SQL pipeline transactions in a unique temporary schema, idempotency, account boundaries, baseline/seen behavior, preference freezing, rollback, event ordering/catch-up, and interruption. It never changes a user's tables or shared download cache.

`pnpm typecheck` and `pnpm build` check client and server. `db:migrate` is an explicit development/post-merge command only. Production startup has no DDL.

`test:guest-browser` uses a real browser and approved live sources to verify guest preference save/refresh, real sweep and refresh-during-run, persisted event measurements, observed matches without tracker writes, read-only replay controls, phone layouts, and isolation from a second browser session. `test:production` smoke-checks the built Express server serving both API and SPA (not a static-only rewrite), signed anonymous sessions, and built assets.

The task environment did not support the documented signed-in browser testing worker. Signed-in rendered pages and same-account cross-device behavior have not been browser-verified. Authentication was not bypassed. Guest-to-account handoff ownership, idempotency, and status/baseline preservation are covered by isolated database integration tests.
