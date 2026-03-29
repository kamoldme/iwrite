---
name: Version numbering convention
description: Staging branch uses v2.5.x where x increments by 1 each push (2.5.0, 2.5.1, 2.5.2...)
type: feedback
---

Version format on staging/new-features branch: `2.5.x` where x starts at 0 and increments by 1 on each push.

**Why:** User corrected from 2.5.71 to 2.5.0 — wants clean patch versioning on the staging branch.

**How to apply:** When bumping VERSION for a deploy on the staging branch, read current VERSION and increment the patch number by 1 (e.g., 2.5.0 → 2.5.1 → 2.5.2).
