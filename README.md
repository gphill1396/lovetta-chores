# Lovetta chores

Chores, house projects and shared lists for Grant and Cass at Lovetta.

**App:** https://gphill1396.github.io/lovetta-chores/

- **Today**: just your plate: what's planned today, anything left from earlier in the week, requests from the other person, and a "since you last looked" card.
- **Week**: a Mon–Sun plan you both share. Tap any chore to give it a day. Progress bars and an effort balance for the month sit at the top.
- **Chores**: every chore by room, as Weekly, Monthly or Seasonal.
- **Tap any chore** to:
  - mark it done
  - pick a day
  - agree on what **done means**
  - set its size (quick, medium, big)
  - **ask the other person to take it** (this week or from now on), take theirs, or send a reminder
  - **skip it** with a reason
  - leave **notes**
- **Inbox**: requests, notes, thank-yous, skips and what the other person finished, with an unread badge.
- **Weekly check-in**: shows up on Sunday through Tuesday. It covers how last week went, open requests, who does which rooms, and which projects to take on this week.
- **Projects** and **Lists**: the House To-Do and shared lists, with notes and a "this week" pick.
- **Sizes**: every chore and project is S (15 min or less), M (15–60 min), L (1–4 hours) or XL (a day or a weekend). The **I have…** picker on Today and Projects shows only what fits the time you have. The effort balance counts S as 1 point, M 2, L 4 and XL 8, and the check-in shows each person's load for the week.
- **Edit any card**: tap a chore and use Edit in the top corner. Projects and list items open straight into an editable card. You can edit or delete your own notes.
- **Undo** after every action. Each person picks their own ink color, and there's a text-size setting.

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
