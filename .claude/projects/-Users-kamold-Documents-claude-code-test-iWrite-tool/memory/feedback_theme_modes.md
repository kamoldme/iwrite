---
name: Three theme modes definition
description: Exact definitions of the three theme modes - dark (green-black default), light (white-black), sepia (yellowish old book)
type: feedback
---

The three theme modes are:
- **Dark mode** (default, `:root`): Black background with greenish accents (#4ade80). The green-black mode.
- **Light mode** (`.light` class): Fully white and black. Focus on WHITE background. No green anywhere. Pure black & white.
- **Sepia mode** (`.sepia` class): Yellowish, old book style. Parchment backgrounds with copper (#C37E3F) accents.

**Why:** User explicitly stated: "Sepia mode is that yellowish colored mode, Dark mode is green-black colored mode, Light mode is just black and white!" Light mode focuses on WHITE, not just "no green."

**How to apply:** When working on theme CSS, ensure light mode is white-focused (white backgrounds, black text, no color accents). Dark mode keeps its green identity. Sepia stays warm/copper.
