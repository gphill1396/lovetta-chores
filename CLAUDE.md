# CLAUDE.md: lovetta-chores

A household chore and project app for Grant and Cass. It's a static React 19 + TypeScript single-file app on GitHub Pages, and its data lives as JSON in a separate private repo.

## Layout

- `src/app.tsx`: the entire app (types, GitHub store, date/rotation logic, components, CSS string). Keep it single-file unless Grant asks otherwise.
- `seed/*.json`: starting data, bundled into the app and written to the data repo when a file is missing.
- `index.html`, `public/`: page shell, manifest and icon.
- `build.mjs`: esbuild bundle into `dist/`. `.github/workflows/pages.yml` deploys on push to `main`.
- `tests/e2e.py`: Playwright run against a mocked GitHub contents API. Update it when flows change.

## Data (in `gphill1396/lovetta-chores-data`, `data/<name>.json`)

| File | Shape |
|---|---|
| `house.json` | `{rooms: Room[], chores: Chore[]}`. A room has `zone` A/B/shared for rotation, `fixedOwner` for keep-rooms mode, and `pinned` to never rotate. A chore has `freq` weekly/monthly/seasonal, `months` (seasonal only), `prn` (as needed), an optional permanent `owner`, optional `zone`/`fixedOwner` to split one room's chores between people, `months` (also allowed on weekly/monthly chores to limit them to a season, e.g. mowing), `standard` ("done means", plus `standardBy`/`standardAt`), and `effort` 1–3. |
| `settings.json` also has | `colors[person]` (ink id from `INKS`) and `lastCheckin {at, by, week}` |
| `settings.json` | `mode` rotate/fixed, `rotation.anchorWeek`/`anchorMonth`/`zoneAStarts` |
| `log.json` | `done["<period>|<choreId>"] = {by, at}`. Period is `W<monday yyyy-mm-dd>` or `M<yyyy-mm>`. Pruned after 400 days. |
| `projects.json` | `projects: Project[]`. Priority 1 = highest, effort 1 = hardest, `lead` grant/cass/both, `status` todo/doing/done. |
| `lists.json` | `lists: {id, name, items: {id, text, done, by, at}[]}[]` |
| `plans.json` | `items["<period>|<choreId>"] = {day?, dayBy?, owner?, skip?: {by, reason, at}}`. `owner` = covering for that period (accepted hand-off or "I'll do it"). Pruned after 120 days. |
| `activity.json` | `items: Activity[]`, where `kind` is note/request/kudos/nudge/skip/standard/took/checkin. `ref` = `{type: chore|project|item, id, title, period?}`. Requests have `status` open/accepted/declined and `permanent`. Pruned after 180 days, except open requests. |

All writes go through `GitHubStore.save(name, mutate, message)`. That function re-reads and re-applies `mutate` on a 409/422 sha conflict, so mutations must be **idempotent set operations** (e.g. "set done=true", not "toggle"). The commit message is user-visible history: write it as "Grant did X".

## Ownership rules (`inst()` → `baseOwner` → `roomOwner`)

A per-period plan `owner` (a trade) comes first, then the chore's `owner`. Next, a pinned room or fixed mode means the room's `fixedOwner` applies. Next, a shared zone means both. Otherwise rotation applies: weekly chores flip every Monday, and monthly/seasonal chores flip on the 1st, both counted from the anchors.

## UI conventions

- All mutations live in `makeActions()`. Each one calls `toast(text, undo)` so the user can undo, and undo is just another idempotent set.
- Chore rows have two targets: the checkbox toggles done, and the title opens `ChoreSheet` (plan, standard, size, hand-off, skip, notes).
- The inbox feed is derived from `activity` plus recent `log` check-offs and finished projects. "Seen" is per device, in localStorage.
- The person using a phone is `me`. Their color is `var(--me)`, and each person's is `var(--grant)`/`var(--cass)`.
- Cass is particular about polish. Keep copy plain, give buttons verbs, never leave a dead end, and only ask for confirmation when nothing can undo the action.

## Adding a feature

1. Add types and any new data file to `Data`, `FILES` and `SEED`. A new file gets seeded automatically on first load.
2. Build the UI as a component plus a tab in `TABS`, or a section in `SettingsSheet`.
3. `node build.mjs && python3 tests/e2e.py`, and extend the test.
4. Write user-facing copy in sentence case, plainly. Errors say what to do next.

Grant prefers features scoped as user stories with acceptance criteria.
