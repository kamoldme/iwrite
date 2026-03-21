# iWrite4.me — Subscription Plans

## Free ($0/mo)
- Timed writing sessions (15 min, 30 min only)
- Dangerous mode (fixed 6-second inactivity timer)
- 10 sessions per week (standard + dangerous combined)
- Streak tracking & writing tree (12 stages)
- XP / Level system (15% compounding thresholds)
- Friends system & writing duels
- Document sharing (view, comment, edit)
- Leaderboard participation
- 1,500 words per session
- 3,000 words when editing
- 3 early completes per month
- 3 copy actions per month (during sessions)
- Flat document list (no folders)
- No export
- Username change once per 30 days

## Pro ($1.99/mo or $9.99/6mo — ~25,000 UZS/mo)
- Everything in Free, plus:
- All timer options (5, 15, 30, 60, 90, 120 min, untimed) + custom "+" add your own
- Configurable dangerous mode timer (choose inactivity threshold)
- Unlimited sessions per week
- 10,000 words per session
- 20,000 words when editing
- 15 early completes per month
- 15 copies per month
- Folder organization for documents
- Pinned documents
- Export to PDF
- Session analytics (focus score, best writing time)
- Username change 3 times per month
- Pro badge on leaderboard (gold gradient)
- Priority support

## Where plans are shown
- **Sidebar badge** (`plan-badge` in app.html) — shows "Free" or "Pro"
- **Pricing modal** (`_planFeaturesHTML()` in app.js) — opened by clicking sidebar user info
- **Profile page** — plan cards section
- **Landing page** — pricing section before footer (index.html)
- **Admin panel** — user detail, edit user, users table
- **Pro lock overlay** — blur + lock icon on Pro-only UI elements for free users

## Update checklist
When adding a new Pro feature:
1. Update this file
2. Update `_planFeaturesHTML()` in `public/js/app.js` (both free and pro arrays)
3. Update the landing page pricing section in `public/index.html`
4. Update help topics in `app.js` if relevant
5. Add Pro lock overlay if the feature has UI elements
