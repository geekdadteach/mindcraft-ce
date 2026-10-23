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
- `newearth/main` — currently also points at `49761ee`.

## What is live
- LinuxGrok runs Bob from a plain directory (not a git checkout) whose content = this fork's `49761ee`. minebob records this.
- Planned, not done: run Bob straight from a checkout of this fork so live == GitHub.

## Rules
See `AGENTS.md`: public-repo warning (no secrets, Discord IDs or ops), Randy's rules, never merge/deploy/force-push/change default branches without his authorization.
