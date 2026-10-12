# Lovetta chores

Chores, house projects and shared lists for Grant and Cass at Lovetta.

**App:** https://gphill1396.github.io/lovetta-chores/

- **Week / Month**: chores by room, filtered to you. Check one off and the other person sees it in your ink (Grant blue, Cass oxblood). "As needed" chores have dashed boxes and don't count toward progress.
- **Seasons**: furnace filter, gutters, hoses, firewood and so on, due by month, plus what's coming up.
- **Projects**: the House To-Do sheet, with lead, priority, effort, cost and notes.
- **Lists**: Restock & refill, Lowe's cart, and any list you add.
- **Settings**: take turns (sides of the house swap every Monday) or keep rooms (permanent until you switch back); edit rooms and chores.

## How it's put together

| Repo | Visibility | Holds |
|---|---|---|
| `gphill1396/lovetta-chores` (this one) | Public | The app code. Pushing to `main` rebuilds the site. |
| `gphill1396/lovetta-chores-data` | Private | `data/*.json`: chores, check-offs, projects, lists, settings. |

The app reads and writes the private data repo with each person's own GitHub token, which stays on their phone. Every check-off is a commit, so the data repo doubles as a history of who did what.

## Setting up a phone

**Cass first needs a GitHub account and an invite.** Grant: in `lovetta-chores-data`, go to Settings → Collaborators → Add people, then add Cass. She accepts the email invite. (Do the same on `lovetta-chores` if she'll edit the code.)

Then, on each phone:

1. Make a token. GitHub only lets fine-grained tokens reach repos you own, so the steps differ:
   - **Grant:** go to <https://github.com/settings/personal-access-tokens/new>. Repository access: only `lovetta-chores-data`. Permissions: **Contents, read and write**.
   - **Cass:** go to <https://github.com/settings/tokens/new> (classic token). Check the **repo** scope.
   - For either, set the expiration as long as GitHub allows, and set a calendar reminder to renew it.
2. Open the app, pick your name, paste the token, and tap **Connect**.
3. Add it to your Home Screen (Safari: Share → Add to Home Screen) so it opens like an app.

## Changing things

- **Chores, rooms, months, owners:** in the app, Settings → Edit rooms and chores. No code needed.
- **New features:** edit `src/app.tsx` (it's the whole app in one file) and push to `main`. The GitHub Action builds and deploys in about a minute. `CLAUDE.md` describes the structure for a Claude session.
- **Run it locally:** `npm install`, then `npm run dev` and open http://localhost:8000.
- **Tests:** `npm run build && python3 tests/e2e.py` (set `DATA_REPO_DIR` to a clone of the data repo to test against the real data). This runs the app in headless Chromium against a mocked GitHub API (requires Python Playwright).

## Where the starting data came from

- Weekly and monthly chores: the laminated apartment charts, remapped to Lovetta rooms
- Projects: the House To-Do Google Sheet (141 rows, imported Oct 12, 2026), stored only in the private data repo. The public seed is empty on purpose. The app is now the source of truth.
- Seasonal list: a starter set (furnace filter, gutters, spigots, dryer vent, etc.). Edit freely.
- `seed/` holds that starting data. The app copies it into the data repo the first time it finds a file missing.
