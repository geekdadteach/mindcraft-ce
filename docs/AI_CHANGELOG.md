# AI CHANGELOG — geekdadteach/mindcraft-ce (NewEarth fork)

Append one dated entry per logical change, newest first. Never erase prior entries.

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
