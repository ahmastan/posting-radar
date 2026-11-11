---
name: Snapshot cleanup approval
description: Consent and preservation constraints for duplicate snapshot maintenance.
---

Building a snapshot cleanup tool is not permission to execute it. Obtain explicit
user approval of the exact dry-run before removing existing data.

**Why:** The user expressly required approval before deleting older duplicate README copies.

**How to apply:** Keep cleanup separate from startup, migrations and ingestion.
Preserve parser-version boundaries, historical audit results and distinct recovery
snapshots when considering any future retention changes.
