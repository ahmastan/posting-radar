---
name: Posting Radar product rules
description: User-stated constraints for ingestion transparency and durable tracking.
---

Posting Radar monitors the SimplifyJobs New-Grad and Summer Internship READMEs for postings new since the user's last run, filters saved preferences, and stores matches with saved/applied/skipped statuses.

**Why:** The user wants a productivity tracker that survives refresh and is accessible on their phone.

**How to apply:** Keep preferences and tracker state in a database; failures must not discard entered data.

Support multiple independent accounts, but sign-in is not required to use the app. Sign-in is required only when a user wants to save or track applications. The first run imports current matching postings.

**Why:** The user explicitly clarified optional sign-in and selected initial import.

**How to apply:** Keep browsing and running checks accessible to guests, explicitly including previews of internship postings without an account. Require an account for durable personal tracking and preserve guest-entered filters and visible results through sign-in.

Guest filters and the guest baseline are browser-specific; server-side guest runs are protected by an anonymous session. Guests see a sign-in prompt instead of saved tracker entries. Preserve filters and results through sign-in and explicitly offer to save current matches.

**Why:** The user approved these proposed guest-mode defaults.

**How to apply:** Do not imply that guest activity syncs between devices or automatically merge guest results into an account.

Use the verified current official SimplifyJobs New-Grad and Summer Internship READMEs and display their seasons. Initial filters allow all locations and role types, include remote and unknown sponsorship, impose no sponsorship restriction, and exclude no companies.

**Why:** The user approved these starting defaults.

**How to apply:** Verify current source URLs rather than guessing; let users narrow filters before running.

Live pipeline summaries and durations must reflect actual server work. Slowed replay is a separate presentation of the last run, never an artificial delay in real processing.

**Why:** The user explicitly wants a live, layered “How it works” diagram that explains real execution and failure recovery.

**How to apply:** Preserve recorded measurements during replay; show GitHub retry/cache recovery and parser failure explicitly. Retry GitHub once before using a cached snapshot.
