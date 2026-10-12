# Lovetta chores

Chores, house projects and shared lists for Grant and Cass at Lovetta.

**App:** https://gphill1396.github.io/lovetta-chores/

The app is organized around time. Chores and projects live in **House**, you plan them onto a **month, week or day**, and **Today** shows what's on your plate.

- **Today**: what's planned for you today (chores and project work together), anything left from earlier, requests from the other person, and how your planned time compares to the time you usually have. When you're clear, **Next up** suggests one thing. The **I have…** picker (15 min / 1 hr / afternoon / weekend) shows only what fits.
- **Plan → Week**: Mon–Sun lanes holding both chores and projects. Each day shows planned time for each of you against your usual free time, and red means overloaded. Anything without a day waits in "This week, no day yet".
- **Plan → Month**: a calendar with load bars per person, the selected day's list, week-by-week load, projects for the month, and the month's chores.
- **House**: every chore by room (weekly, monthly, seasonal) and every project. Tap **Plan** on anything to put it on a day, a week or the month. Day buttons show how full each day already is, and the outlined one has the most room.
- **Chore and project cards** work the same way. You can mark done, plan, set the size, hand off, leave notes and edit. Big (L/XL) projects can span several days. Ticking one logs **worked on it**, and the toast offers **It's finished**.
- **Check-ins** cascade. On the 1st of the month you pick that month's projects. On Sundays the weekly check-in reviews last week, then **plans the week**, putting the month's projects on days with a per-day load grid. Unfinished plans roll forward with a "From last week" or "Planned Tue" tag, so nothing silently disappears.
- **Settings → Your time for house stuff**: rough free time per weekday. It drives the load bars and the lightest-day suggestions.
- **Inbox**: requests, notes, thank-yous, skips, work sessions and finished items, with an unread badge.
- **Lists**: Restock & refill, Lowe's cart, Move-in leftovers, and any list you add.
- **Sizes**: S is 15 min or less, M is 15–60 min, L is 1–4 hours, and XL is a day or a weekend. **Undo** after every action, per-person ink colors and text size.

There are no push notifications: a static site has no server to send them. The inbox badge and the "since you last looked" card cover that, and the app refreshes every 30 seconds while it's open.

## How it's put together

| Repo | Visibility | Holds |
|---|---|---|
| `gphill1396/lovetta-chores` (this one) | Public | The app code. Pushing to `main` rebuilds the site. |
| `gphill1396/lovetta-chores-data` | Private | `data/*.json`: chores, check-offs, plans, messages, projects, lists, settings. |

The app reads and writes the private data repo with the household key, which stays on each phone. Every check-off is a commit, so the data repo doubles as a history of who did what.

## Setting up a phone

Both phones use the same "household key" (Grant's fine-grained GitHub token). Cass doesn't need a GitHub account.

1. Grant makes the key at <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: only `lovetta-chores-data`
   - Permissions: **Contents, read and write**
   - Expiration: as long as GitHub allows
2. On each phone, open the app, pick your name, paste the key, and tap **Connect**. The app tracks who did what by the name you pick, not by the key.
3. Add it to your Home Screen (Safari: Share → Add to Home Screen) so it opens like an app.

## Changing things

- **Chores, rooms, months, owners:** in the app, Settings → Edit rooms and chores. No code needed.
- **New features:** edit `src/app.tsx` (it's the whole app in one file) and push to `main`. The GitHub Action builds and deploys in about a minute. `CLAUDE.md` describes the structure for a Claude session.
- **Run it locally:** `npm install`, then `npm run dev` and open http://localhost:8000.
- **Tests:** `npm run build && python3 tests/e2e.py` (set `DATA_REPO_DIR` to a clone of the data repo to test against the real data). This runs the app in headless Chromium against a mocked GitHub API (requires Python Playwright).

## Where the starting data came from

- Weekly and monthly chores: Cass's laminated charts (Drive → 772 Lovetta → MAINTENANCE), remapped to Lovetta rooms. Her room assignments are the "Keep rooms" owners, and her bedroom split (Cass: bed and dusting; Grant: vacuuming) carries into both modes. Additions beyond her charts: trash/recycling, bins, studio, garage, guest room, nursery, a few monthly deep-clean items, and the seasonal list.
- Lawn mowing is always Grant's: weekly as needed, April through October.
- Projects: the House To-Do Google Sheet (141 rows, imported Oct 12, 2026), stored only in the private data repo. The public seed is empty on purpose. The app is now the source of truth.
- Seasonal list: a starter set (furnace filter, gutters, spigots, dryer vent, etc.). Edit freely.
- `seed/` holds that starting data. The app copies it into the data repo the first time it finds a file missing.
