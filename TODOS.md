# TODOS

## Design Debt

### Create DESIGN.md — Formal Design System
- **What:** Run `/design-consultation` to establish a design system covering typography scale, spacing scale, color tokens, and component library.
- **Why:** Design decisions are scattered across CSS files with no single source of truth. New features drift visually.
- **Pros:** Consistent UI across all features, faster implementation, fewer design review cycles.
- **Cons:** Requires dedicated session (~30 min with CC).
- **Context:** Identified during Stories design review (2026-03-23). The app has implicit patterns (Archivo/Instrument Sans, dark theme variables, card layouts) but no formal documentation.
- **Depends on:** Nothing — can run anytime.

### Accessibility — Stories Keyboard Navigation & ARIA
- **What:** Add keyboard navigation, ARIA roles, and focus management to the Stories tab.
- **Why:** Screen reader users cannot navigate the story feed. No focus management on view transitions. Cards are not keyboard-accessible.
- **Pros:** Meets WCAG 2.1 AA compliance, enables keyboard-only users to use Stories.
- **Cons:** Requires testing with screen readers (VoiceOver on macOS).
- **Context:** Identified during Stories design review (2026-03-23). Specific gaps: no `role="article"` on cards, no `aria-live` for feed updates, no keyboard Enter to open stories, no skip-to-content link.
- **Depends on:** Stories redesign should land first so a11y is added to the final markup.

### Legacy Styled Content — Composer Compatibility
- **What:** Handle stories with legacy color/font inline styles gracefully in the new composer (color picker and font selector were removed).
- **Why:** Published stories with colored text render fine in the reader (inline styles preserved), but if the author reopens them in the composer, they can't change colors anymore.
- **Pros:** Prevents user confusion when editing old stories.
- **Cons:** Low priority — very few stories likely have custom colors.
- **Context:** Identified during eng review (2026-03-23). Color picker and font selector removed in Stories redesign. Legacy content retains inline styles in the reader, only editing is affected.
- **Depends on:** Stories redesign landing first.
