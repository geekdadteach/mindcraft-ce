# AI CHANGELOG — geekdadteach/mindcraft-ce (NewEarth fork)

Append one dated entry per logical change, newest first. Never erase prior entries.

### 2026-10-23 — MineBob — Branch cursor/bob-brain-client-1dc4 (proposed)
- **Why:** Bob should report deaths, stuck/failed actions, pathfinding failures, goals, and low health to the local Bob Brain queue, and should see finished analyses as unverified advice. The queue must not control him.
- **Done:** `src/agent/library/bob_brain.js` (off unless `BOB_BRAIN_TOKEN_FILE` is set; loopback URL only; mode-600 token file; async timeouts; dedupe/cooldown; `failure_analysis` and `plan` jobs; review notes in the prompt with command text stripped). Wired from `agent.js` and `prompter.js`. Docs: `docs/BOB_BRAIN.md`. Tests: `test/bob_brain.test.js` and `.github/workflows/bob-brain.yml`.
- **Not done:** `packages/bob_brain/validation.py` in the private queue repo was not readable here. Plan footprints are 1..32, default 5×5 when the goal has no size. No live enablement and no token file in this repo.
- **Live state:** Not deployed. No service or process change. Opened as PR #4. Bob keeps playing if the queue is down.
- **Rollback:** Revert this branch. Leaving `BOB_BRAIN_TOKEN_FILE` unset keeps the client disabled.

### 2026-10-23 — MineBob LinuxGrok — Branch newearth/prismarine-chunk-guard-2026-10-23 (proposed)
- **Why:** Live Bob's `node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js` has a hand-applied guard (2026-10-19) around `mcData.version['>=']('26.1')`, which throws on minecraft-data 3.98.0. `newearth/main` `dddbaf4` had no patch file for it, so a fresh `npm ci` would drop it and likely break Bob.
- **Done:** Added `patches/prismarine-chunk+1.41.0.patch` (generated with `npx patch-package prismarine-chunk` from the live file): try/catch around the `26.1` version check, fallback `hasFluidCount = false`. No other code change. Docs updated (handoff: drift fixed, deploy of `dddbaf4` recorded).
- **Verified:** clean `npm ci` applies all 9 patches; resulting `ChunkColumn.js` is byte-identical to live; `diff -rq node_modules <live>/node_modules` is empty; `node --check` OK; `node --test test/bobbot_control.test.js` 5/5 pass.
- **Live state:** Bob deployed from `dddbaf4` at ~08:38 ET 2026-10-23 (with `MINDCRAFT_BIND_HOST=0.0.0.0` drop-in, BobBot token control off). Live already has the guard by hand; this branch changes nothing live.
- **Rollback:** Delete the branch, or revert its commit.

### 2026-10-23 — MineBob LinuxGrok — Branch newearth/secure-mindserver-2026-10-23 (proposed)
- **Why:** MindServer listened on all interfaces with no auth; minebob `73f7378` adds token-gated BobBot control.
- **Done:** (1) bind host from `MINDCRAFT_BIND_HOST`, default `127.0.0.1` (was hard-coded `0.0.0.0`). (2) BobBot control relay from minebob `73f7378` (`src/mindcraft/bobbot_control.js`, `src/agent/bobbot_control.js`, wiring in `mindserver.js` / `mindserver_proxy.js`, `test/bobbot_control.test.js`, `.github/workflows/bobbot-control.yml`); disabled unless `MINDCRAFT_BOBBOT_TOKEN_FILE` is set. (3) Comment fixed: ufw allows 8081, not 8080.
- **Live state:** Not deployed. No service or process change. Opened as PR #2; newearth/main (with PR #1) merged in to resolve doc conflicts.
- **Behavior change if deployed:** 8081 is loopback-only unless `MINDCRAFT_BIND_HOST=0.0.0.0` is set.
- **Rollback:** Redeploy `49761ee`/`5d8be33` content, or set `MINDCRAFT_BIND_HOST=0.0.0.0` and unset `MINDCRAFT_BOBBOT_TOKEN_FILE`.
### 2026-10-23 — MineBob LinuxGrok — Branch newearth/port-minebob-2026-10-23 (proposed)
- **Why:** Port minebob `73f7378` game-code improvements into the fork so the record matches what Bob actually runs.
- **Done:** (1) `patches/mineflayer-pathfinder+2.4.5.patch` replaced with minebob's superset: doors/gates only along facing axis (`doorAllowsMove`), replan on door open/close, upstream PR #395 backport (don't click an open door). Pristine 2.4.5 + this patch == live `node_modules` byte-for-byte. (2) `src/agent/library/full_state.js` adds `goal` {state, prompt}.
- **Live state:** Not deployed. No service or process change. Merged as PR #1 (`e923683`).
- **Rollback:** Delete the branch, or revert its commits.

### 2026-10-23 — MineBob LinuxGrok — Fork created; live snapshot; AI docs
- **Why:** Randy approved ("Make it so", 2026-10-23 08:09 ET) splitting Bob's game code (this public fork) from ops (private `geekdadteach/minebob`), so upstream updates are easy to pull and everything running has a GitHub record.
- **Done:** Fork created. Branch `newearth/live-2026-10-23`: `80045e6` exact live snapshot of LinuxGrok `~/ai-player/mindcraft-ce-stable-42da10d` (upstream `42da10d` + working tree); `49761ee` exact live `package-lock.json` + `NEWEARTH.md`.
- **This commit:** Added `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md`. Documentation only; no code files changed.
- **Live state:** Live Bob = `49761ee` content, not run from a git checkout. No service or process change.
- **Next:** Later, run Bob from a checkout of this fork; minebob records the live commit until then.
- **Rollback:** Revert this commit.
