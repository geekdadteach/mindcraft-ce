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
- `newearth/main` — `5d8be33` (= `49761ee` code + docs), then PR #1 merged as `e923683`, then PR #2 merged as `dddbaf4`, then PR #3 merged as `b940ba3` (prismarine-chunk guard), then PR #4 merged as `caa179a` (Bob Brain client).
- `cursor/bob-brain-advice-1dc4` — PR #5, not merged and not deployed: readable review notes, public `enqueuePlan` / `enqueueFailureAnalysis` / `currentAdvice` / `status`, and advice only in prompts that contain `$LONG_MEMORY`. See `docs/BOB_BRAIN.md`.
- `newearth/secure-mindserver-2026-10-23` — PR #2, merged into `newearth/main` as `dddbaf4` (deployed 2026-10-23), from `5d8be33`: MindServer binds `MINDCRAFT_BIND_HOST` (default `127.0.0.1`), optional token-gated BobBot control (off unless `MINDCRAFT_BOBBOT_TOKEN_FILE` is set), port comment fixed to 8081.
- `newearth/port-minebob-2026-10-23` — PR #1, merged into `newearth/main` as `e923683` (deployed as part of `dddbaf4`), from `5d8be33`: pathfinder door/gate patch from minebob `73f7378` (matches live `node_modules`), `full_state.js` goal block.

## What is live
- 2026-10-23 ~08:38 ET: Bob was deployed on LinuxGrok from `newearth/main` `dddbaf4` (directory `~/ai-player/mindcraft-ce-newearth-dddbaf4`, pointed to by the `~/ai-player/mindcraft-ce` symlink; still a plain directory, not a git checkout). A systemd drop-in sets `MINDCRAFT_BIND_HOST=0.0.0.0` so the MindServer UI (8081) stays reachable on the LAN. BobBot token control is off (`MINDCRAFT_BOBBOT_TOKEN_FILE` not set). minebob records this.
- The live `node_modules` carries a hand-applied prismarine-chunk guard (see Known drift) that `dddbaf4` itself does not contain; branch `newearth/prismarine-chunk-guard-2026-10-23` adds it as a patch file.
- Previous live tree: `~/ai-player/mindcraft-ce-stable-42da10d` (content = `49761ee`), kept for rollback.
- Planned, not done: run Bob straight from a checkout of this fork so live == GitHub.

## Bob Brain client

- Game-side client only. The queue stays a separate process on `127.0.0.1:8765`. This client never runs commands from a job result.
- PR #4 (`caa179a`) is on `newearth/main`. A live queue test of that client put a truncated JSON dump in Bob's note. PR #5 renders `summary`, or a plain plan / failure-analysis line, and skips `validation.valid === false`. That follow-up is not deployed.
- Enable with `BOB_BRAIN_TOKEN_FILE` (mode 600, 32+ characters, outside this repo) and optional `BOB_BRAIN_URL` (loopback only, default `http://127.0.0.1:8765`). Unset token file means disabled.
- The note is inserted only where the prompt contains `$LONG_MEMORY`.
- Plan jobs send `{objective, footprint:{width,depth}}` with width/depth in 1..32, or 5×5 when the goal text has no size. Scripts can call `enqueuePlan`, `enqueueFailureAnalysis`, `currentAdvice`, and `status`.

## Deploy note for secure-mindserver
- If deployed, the MindServer web UI (port 8081) becomes loopback-only. To keep LAN access set `MINDCRAFT_BIND_HOST=0.0.0.0` in the service env before restarting.
- BobBot control needs `MINDCRAFT_BOBBOT_TOKEN_FILE` pointing at a private (mode 600, regular file, >= 32 chars) secret kept outside this repo. A bad file makes MindServer refuse to start.

## Known drift (2026-10-23)
- Live `node_modules/mineflayer-pathfinder` was hand-patched beyond live `patches/mineflayer-pathfinder+2.4.5.patch` (door/gate fixes). A fresh `npm ci` from `49761ee`/`5d8be33` would drop those fixes. Branch `newearth/port-minebob-2026-10-23` makes the patch file match live. **Fixed** (PR #1, in `dddbaf4`).
- Live `node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js` (prismarine-chunk 1.41.0) was hand-patched on 2026-10-19 (`~/ai-player/patches/prismarine-chunk-26.1-guard.patch` on LinuxGrok): `mcData.version['>=']('26.1')` throws with minecraft-data 3.98.0 (no `26.1` entry), so it is wrapped in try/catch and falls back to `hasFluidCount = false`. `dddbaf4` had no patch file for it, so a fresh `npm ci` would drop the guard and likely break chunk loading. **Fixed** on branch `newearth/prismarine-chunk-guard-2026-10-23` by `patches/prismarine-chunk+1.41.0.patch` (merged to `newearth/main` as PR #3, `b940ba3`); with it, a clean `npm ci` of this fork gives a `node_modules` identical to live (`diff -rq` empty).
- Note: `patches/minecraft-data+3.97.0.patch` is applied to the installed minecraft-data 3.98.0; patch-package warns about the version mismatch but applies it cleanly. Not changed.

## Rules
See `AGENTS.md`: public-repo warning (no secrets, Discord IDs or ops), Randy's rules, never merge/deploy/force-push/change default branches without his authorization.
