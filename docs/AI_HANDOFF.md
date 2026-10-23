# AI HANDOFF — geekdadteach/mindcraft-ce (NewEarth fork)

**Snapshot:** 2026-10-23. Verify repository and live state before changing anything.

## Role of this repo
- Home of Bob's **game code** (Mindcraft CE + NewEarth changes). Public.
- The private repo `geekdadteach/minebob` holds ops (scripts, Discord control bot, reset-watcher, systemd units, polkit, Bob Brain queue source), config/profiles, docs, AI handoff rules, and the record of **which commit of this fork is live**.

## Branches
- `develop` — fork default branch, as inherited from upstream. Do not change it or the default-branch setting without Randy's OK.
- `newearth/live-2026-10-23` — exact live tree from LinuxGrok on 2026-10-23:
  - `80045e6` — exact live snapshot of `~/ai-player/mindcraft-ce-stable-42da10d` (upstream stable `42da10d` + working tree), unchanged.
  - `49761ee` — exact live `package-lock.json` + `NEWEARTH.md`.
  - Later commits on this branch are documentation only unless the changelog says otherwise.
- `newearth/main` — currently points at `5d8be33` (= `49761ee` code + docs).
- `newearth/port-minebob-2026-10-23` — proposed (local, not merged/deployed), from `5d8be33`: pathfinder door/gate patch from minebob `73f7378` (matches live `node_modules`), `full_state.js` goal block.

## What is live
- LinuxGrok runs Bob from a plain directory (not a git checkout) whose content = this fork's `49761ee`. minebob records this.
- Planned, not done: run Bob straight from a checkout of this fork so live == GitHub.

## Known drift (2026-10-23)
- Live `node_modules/mineflayer-pathfinder` was hand-patched beyond live `patches/mineflayer-pathfinder+2.4.5.patch` (door/gate fixes). A fresh `npm ci` from `49761ee`/`5d8be33` would drop those fixes. Branch `newearth/port-minebob-2026-10-23` makes the patch file match live.

## Rules
See `AGENTS.md`: public-repo warning (no secrets, Discord IDs or ops), Randy's rules, never merge/deploy/force-push/change default branches without his authorization.
