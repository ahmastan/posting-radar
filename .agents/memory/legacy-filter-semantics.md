---
name: Legacy filter semantics
description: Why legacy remote and role selections cannot be mapped directly to the new filters.
---

Legacy remote-only preferences include hybrid postings when their location explicitly mentions remote. Legacy remote-excluded preferences allow hybrid postings without remote locations. Neither maps exactly to the new strict remote or in-person choices.

**Why:** Converting saved filters must not silently broaden or narrow the jobs users asked to see. Preserve the previous semantics in both stored preferences and unsaved browser drafts.

**How to apply:** When evolving filters, retain distinct compatibility choices where a new choice has different semantics. Preserve a legacy Other selection's coverage when splitting previously uncategorized engineering jobs into their own categories; do not add those categories to focused selections that excluded Other.
