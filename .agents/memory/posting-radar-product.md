---
name: Posting Radar product rules
description: User-stated constraints for ingestion transparency and durable tracking.
---

Posting Radar monitors the SimplifyJobs New-Grad and Summer Internship READMEs for postings new since the user's last run, filters saved preferences, and stores matches with saved/applied/skipped statuses.

**Why:** The user wants a productivity tracker that survives refresh and is accessible on their phone.

**How to apply:** Keep preferences and tracker state in a database; failures must not discard entered data.

Live pipeline summaries and durations must reflect actual server work. Slowed replay is a separate presentation of the last run, never an artificial delay in real processing.

**Why:** The user explicitly wants a live, layered “How it works” diagram that explains real execution and failure recovery.

**How to apply:** Preserve recorded measurements during replay; show GitHub retry/cache recovery and parser failure explicitly. Retry GitHub once before using a cached snapshot.
