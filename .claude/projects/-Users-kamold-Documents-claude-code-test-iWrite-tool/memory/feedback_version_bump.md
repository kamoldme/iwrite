---
name: Always bump version on deploy
description: User requires VERSION file bump (#.#.#+1) on every push so they can verify the update deployed
type: feedback
---

Always bump the VERSION file with +1 on the last digit before every push/deploy. Without it, the user can't tell if the update was actually pushed.

**Why:** The user uses the version number as a visual confirmation that the deploy went through. If the version doesn't change, they assume nothing happened.

**How to apply:** Every time you push code, read the VERSION file, increment the last digit by 1, write it back, and include it in the commit.
