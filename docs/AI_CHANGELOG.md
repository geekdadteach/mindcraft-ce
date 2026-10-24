# AI CHANGELOG — geekdadteach/mindcraft-ce (NewEarth fork)

Append one dated entry per logical change, newest first. Never erase prior entries.

### 2026-10-24 12:10 PM ET — GitHub bot — Refresh AI handoff and changelog to current state
- **Goal:** Record that PR #8 merged into `newearth/main` as `79e8f2b` (12:03 PM ET), that PRs #6, #7, and #9 were closed unmerged, and keep live vs merged clear. Randy authorized docs refresh PRs at 12:01 PM ET.
- **Files:** `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md` (this entry). `AGENTS.md` unchanged (still accurate).
- **Summary:** Added the status-word legend. `newearth/main` history now ends at `79e8f2b`; receipts, rotation, and longer advice are Merged, not deployed. Branch list updated: PR #6 closed (superseded by #8), PR #7 closed (folded into #8), PR #9 closed (local-only tests), `cursor/v2-receipts-longer-advice-3f21` noted (same head as PR #8), `cursor/bob-brain-advice-1dc4` branch gone. Live Bob is `4398d7a`, reported by MineBobNE 60, Oct 24.
- **Decisions:** Entry inserted at the top because this file is newest-first; no existing entry edited. No IPs, Discord IDs, or ops details added (public repo).
- **Tests:** Docs-only; no code tests run. GitHub showed both workflows passing on `79e8f2b`. Scanned added text for secrets, IDs, and IPs (none).
- **Deploy status:** none.
- **Rollback:** revert the PR.
- **Remaining work:** Deploying `79e8f2b` needs Randy's OK (via the private ops repo). Branches of closed PRs #6, #7, #9 are kept for Randy to decide.

### 2026-10-24 — MineBob — Longer Bob Brain advice, rebased receipts (proposed)
- **Why:** Stored advice was cut at 280 characters, so live notes stopped mid-sentence (often at `Check:`). The suggestion block was also hard-sliced at 900 characters, which dropped the newest lines first. A summary that already ended in `.` could show `..`. The handoff still said live was `dddbaf4` and that PR #10 was unmerged.
- **Done:** One note defaults to 900 characters (`BOB_BRAIN_MAX_ADVICE_CHARS`, allowed 32–4000). The `$LONG_MEMORY` block defaults to 2500 (`BOB_BRAIN_MAX_ADVICE_BLOCK_CHARS`, allowed 80–8000) and keeps the newest whole notes. Cuts land on a sentence, a line, or a word, then `…`, never mid-word. A trailing `..` on a summary becomes one period; `...` is left alone. The unverified header is unchanged. `advice_injected` is still written only when that stored line is in the finished prompt. Receipts and optional rotation from PRs #6 and #7 are rebased onto `4398d7a`. GitHub Actions workflows are unchanged (draft PR #9 is separate).
- **Live state:** Not deployed. Live Bob remains `4398d7a` (PR #10), LITE mode, since 2026-10-24 11:12 AM ET. Receipts, rotation, and these longer caps are merged-pending-deploy.
- **Rollback:** Revert this branch. Unset `BOB_BRAIN_V2_EVENT_LOG` keeps receipts off. Unset `BOB_BRAIN_V2_ROTATE_LOG` keeps the 1 MiB stop.

### 2026-10-24 — MineBob — Branch cursor/bob-brain-client-key-391b (proposed)
- **Why:** `POST /v1/jobs` returned HTTP 400 when a later death, stuck action, or plan reused a `client_key`. The queue stores that key forever and rejects the same key with a different payload (`client_key already used for different job`). Bob's keys were only the cell and cause, the failure kind and cell, or the objective, while the payload carried the exact position and goal. An identical payload only returned the old job. The log line was `HTTP 400 POST /v1/jobs` with no server reason, and it repeated.
- **Done:** The key is the kind, the coarse label, a canonical (sorted-key) JSON hash of the payload that is sent, and a 10-minute time bucket, still prefixed `death:`, `fail:`, or `plan:` and kept to 1–128 characters. A retry in the same bucket reuses the key. A later recurrence is a new job. Client cooldowns still dedupe. A 400 for that conflict is counted and not retried. Any non-2xx response logs the JSON `error` string, control characters removed, clipped to 120 characters, token redacted, once per distinct text every few minutes, with a count. The payload and headers are not logged. Tests post at a fake queue that keeps the same client_key rule. Docs updated. The queue server is unchanged.
- **Live state:** Not deployed. No service or process change. Opened as PR #10 against `newearth/main`. Not merged.
- **Rollback:** Revert this branch. Leaving `BOB_BRAIN_TOKEN_FILE` unset keeps the client disabled.

### 2026-10-23 — ChatGPT — Opt-in bounded Bob V2 receipt log rotation (review-only)
- **Why:** Mindcraft V2 JSONL receipt writer stopped at 1MiB. BobBot V2 audit identified evidence loss during longer runtimes.
- **Code:** `src/agent/library/bob_brain_v2.js` now permits explicit `BOB_BRAIN_V2_ROTATE_LOG=1` ring of four safe private numbered archives + active JSONL; reopens a fresh descriptor after rotation, refuses unsafe archives/symlinks, maintains original disabled/default-cap semantics.
- **Tests:** `test/bob_brain_v2.test.js` adds opt-in rotation, archive permissions and symlink fail-closed cases; see exact current HEAD CI. Documentation in `docs/BOB_V2_RECEIPT_ROTATION.md`, AI handoff and changelog.
- **Limitations:** Archive ring bounds disk use but can overwrite unread oldest receipts. Observer handles up to four archives by inode and reports lost rotation evidence if behind. This is not proof of model learning. Separate approval required for live Bob restart, producer env configuration and V2 observability.
- **Deployment:** NONE. Public source-only branch based on unmerged Mindcraft PR #6; no token, Discord ID or machine command. **Rollback:** leave rotation flag unset or revert proposed source.
- **Follow-up:** developer source review, CI, test guild and owner-approved staged rollout of Mindcraft receipts separately from existing gameplay.

### 2026-10-23 — MineBob — Branch cursor/bob-v2-receipts-14bd (proposed)
- **Why:** V2 can see Brain queue jobs, but not whether a note reached the conversation prompt or what Bob ran afterward. Those facts exist only in this process.
- **Done:** Append-only version-1 JSONL receipts in `src/agent/library/bob_brain_v2.js`, off unless `BOB_BRAIN_V2_EVENT_LOG` is an absolute path. `advice_injected` is written only after the stored line is found in the finished prompt. `advice_rejected` covers validation, stripping, an empty note, the list cap, the 900-character block, and a missing line. `action_started` / `action_result` come from real `perform` and from the action runtime, and use the advice job id only when that command is the model reply after an injected note. No `lesson_applied` or `lesson_outcome` (nothing in the code records that a lesson caused a command). Docs and `test/bob_brain_v2.test.js`.
- **Not done:** V2 still reads one `BOBBOT_V2_BRAIN_LOG` file. Bob writes a separate file. The private version-1 schema file was not in this checkout; Bob enforces the field and identifier rules documented in `docs/BOB_BRAIN.md`.
- **Live state:** Not deployed. No service or process change. Default behavior is unchanged when the variable is unset.
- **Rollback:** Revert this branch. Leaving `BOB_BRAIN_V2_EVENT_LOG` unset keeps receipts off.

### 2026-10-23 — MineBob — Branch cursor/bob-brain-advice-1dc4 (proposed)
- **Why:** A live queue test of PR #4 (`caa179a`) stored review results as a truncated JSON dump. Advice was also appended to every prompt, including memory-saving and coding. Scripts had to call private enqueue helpers.
- **Done:** `toAdvisoryText` prefers `summary`, otherwise renders a plan (footprint, wall height, materials, stage titles) or a failure analysis (cause, lesson, first two checks), and skips `validation.valid === false`. Public `enqueuePlan`, `enqueueFailureAnalysis`, `currentAdvice`, and `status`. Conversation prompt (`$LONG_MEMORY`) is the only injection point. Docs and unit tests updated.
- **Live state:** Not deployed. No service or process change. Opened as PR #5. PR #4 remains the merged client on `newearth/main`.
- **Rollback:** Revert this branch. `caa179a` keeps the previous client.

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
