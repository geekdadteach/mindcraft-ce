# AI HANDOFF — geekdadteach/mindcraft-ce (NewEarth fork)

## 2026-10-27 — Bob autonomy follow-on (CODED; NOT TESTED; NOT DEPLOYED)
- PR #19 remains unmerged. Public gameplay patch now includes compass-balanced food relocation and an initial local adult-animal keep-two hunting guard; crop/berry gathering is attempted before hunting, and crop harvesting refuses the homestead protected boxes and no-go zones. These are **not yet validated on MM20**.
- Private ops work is staged in `geekdadteach/minebob` branch `feature/bob-autonomy-ops-20261027`; public script copies have NOT been deleted because cross-repo test references still need reconciliation.
- Remaining from developer orders: complete central home source-of-truth refactor, breeding and protected wheat planting, optional logged failure aging, test coverage, private ops integration, secret scan, trial plan and reviewed deployment. No changes to live Bob or server.


**Snapshot:** 2026-10-26 8:30 PM ET — branch `live-m4-20261026` is the exact live tree on Randy's Mac mini `.20` (`~/BobRuntime/cutover/mindcraft-m4`). `m4-runtime-20261026` was the 10:20 ET snapshot. Verify repository and live state before changing anything.

Status words, never conflated: **Proposed** → **Coded** → **Tested** → **Merged** → **Deployed** → **Live-verified**. Merged is not Deployed.

## 2026-10-26 9:00 PM ET — `nav-on-live-20261026`: PR #14 navigation handling ported onto the live tree (Coded, Tested; PR open, not merged; deploy via MM20 bundled with `task-finish-fixes-20261026`)
- Base: `live-m4-20261026` `effe004`. PR #14's three commits are cherry-picked; the only conflicts were in the docs. The live patches are untouched: stuck-home teleport fallback, nodistance (`radius: null`), reset-recovery and chat guard.
- **Change from PR #14: the porch row stays protected.**
  - What the `.20` log shows at z 565: `oak_log` blocks at `-823/-821/-819 124 565` beside the outside pressure plate `-820 124 565` (Bob's collector kept finding them and the live guard refused them), and the door at `-820 124 566`/`125 566`.
  - The live guard protected `x -824..-816 z 564..572`. PR #14's box starts at z 566 and its lane `x -821..-819 z 564..565 y 123..126` was fully unprotected. That would have made the posts at -821/-819, the plate and its support block breakable, and every other z 564..565 cell too.
  - Now: `HOUSE_AREA` is `x -827..-816 y 123..127 z 566..573`, as in PR #14 and used for enclosure detection. A new `HOUSE_PORCH` box `x -827..-816 y 123..127 z 564..565` is also protected.
  - In the lane only loose fill (`LANE_FILL`: dirt, grass_block, gravel, sand, snow, netherrack and similar) can be dug, so a sealed porch can still be cleared. Logs, planks, cobblestone, glass, stairs, fences, doors, plates and unknown blocks stay protected.
  - The plate support `-820 123 565` is never diggable. The protected union still covers the whole live box.
- `inBox` now floors coordinates, so the door-plate landing spot `-819.5 124 565.5` counts as lane cell `-820 124 565`.
- Merged behavior: `ResetRecovery.recordReset`, which both the reset-teleport detector and the stuck-home `/home house` fallback call, now clears the 15-minute unreachable nav blacklist. Old NoPath verdicts are stale after Bob moves.
- Tests: 114/114 (`node --test test/`). New `test/bob_nav_on_live.test.js` and the porch tests in `test/bob_enclosure.test.js`.

## 2026-10-26 8:30 PM ET — `live-m4-20261026`: record of the exact live `.20` tree (Coded, Tested; record only; PR open, not merged)
- Why: Randy approved (8:18 PM ET, "Do steps 1 through 3, and deploy through MM20") recording every live-only `.20` change in git first, so later deploys cannot wipe them.
- Base: `feature/andy-pool-no-api-fallback` `2074ef1` (PR #15, which is itself on `m4-runtime-20261026` `c3c963b`). PR #15 was applied live on `.20` around 3:56–3:58 PM ET but is not merged.
- Added the live-only `.20` patches, byte-for-byte from `~/BobRuntime/cutover/mindcraft-m4`:
  - stuck-home-20261026, approved 1:56 PM ET and applied 2:04 PM ET: `src/agent/library/stuck_home.js` including the later 4:26 PM ET "nodistance" edit (radius `null`/0 = unlimited), `src/agent/library/chat_guard.js`, and the edits to `src/agent/agent.js`, `src/agent/commands/actions.js` and `src/agent/modes.js` (cheat locked off).
  - reset-recovery-20261026 in its later form: `src/agent/library/reset_recovery.js`.
  - Tests `test/bob_stuck_home.test.js` and `test/bob_reset_recovery.test.js`.
  - `docs/BOB_AI_RECEIPTS.md`, the live copy.
- Recorded oddity, not fixed: live `profiles/andy-api.json` is byte-identical to `profiles/andy-api-lite.json` (sha1 `d5a36ae7…`). PR #15's `andy-api.json` had Ollama embeddings. This branch keeps the live copy.
- Verification: every tracked path outside `docs/` was hashed against the live dir. All are identical, and no tracked path is missing on live. The only differences are this repo's `docs/AI_HANDOFF.md` and `docs/AI_CHANGELOG.md`, which are documentation and were never byte-matched.
- Not recorded here: ops/runtime files that belong in the private repo. `run/bob-m4-ctl`, `run/guarded-start.py` and `run/stuck-home.config.json` (`{"radius": null}`) are recorded in `geekdadteach/minebob`. `run/bob-mode.*`, `run/recovery-inbox/`, `M4_CUTOVER_STATUS.json`, `andy_quota_ledger.json`, `keys.json`, `bots/`, `logs/`, the `tmp-*.mjs`/`zz-*.mjs` scratch scripts and the `*.bak-20261026-nodistance` backups are not recorded.
- Tests: `node --test test/` 94/94 pass (Node 20, after `npm ci` + patch-package).

## 2026-10-26 3:50 PM ET — Chat on LM Studio only (`api_fallback: false`), coding on the Andy API in both modes (Coded, Tested; PR open, not merged, not deployed)
- Why: Randy decided chat must use only the local Andy-4.2 LM Studio endpoint (no second LM Studio endpoint, no Andy API backup), so LM Studio failures never spend API quota; coding uses the Andy API model `claude-haiku-5.5` and must stay allowed in LITE too.
- `andy_pool`: new `params.api_fallback` (default `true` = unchanged). `false` = no Andy client is created, routing is forced to `lmstudio_primary`, and when LM Studio errors, times out, returns empty or is paused, the call returns the model-error placeholder at once (the agent never chats or stores it) instead of calling the API. `embed()`/`embedMany()` throw, so callers use word overlap. `lmstudio_fallback_urls` may be missing or `[]`.
- `prompter.js`: when a profile has no usable `embedding` block and the chat api is `andy_pool`, the embedding model now gets the chat profile's params, so `api_fallback: false` also covers embeddings (before, it built a default pool that embedded via the Andy API).
- `andy.js`: a 429 now logs the API error type/code, a short message and `Retry-After`, so the cause (rate limit, quota, network block) is visible in the log. No key is logged.
- `settings.js` LITE block: no longer sets `allow_insecure_coding = false` or blocks `!newAction`. LITE still selects `andy-api-lite.json` and sets `allow_vision = false`. Which Andy-4.2 file LM Studio serves (lighter model while someone is at the console) is handled on the LM Studio host, not here.
- Profiles `andy-api-lite.json` and `andy-api.json`: chat `api_fallback: false`, `lmstudio_fallback_urls: []`; `code_model` = Andy API `claude-haiku-5.5` (`max_tokens` 8192); `vision_model` removed from `andy-api.json` (vision off: andy_pool has no vision request). Lite embedding has no second endpoint. `andy-api.json` embedding is unchanged here; the live machine sets it locally.
- Tests: `node --test test/andy_pool_no_api_fallback.test.js` (9 pass): default unchanged; no Andy client when off; empty/missing fallback list; LM up; LM down and paused = placeholder and 0 API calls; empty reply; embeddings refuse; LITE keeps coding; profile shape.
- Not deployed. Restart timing is Randy's call. Rollback: revert the commit (or set `api_fallback` back to `true`).

## 2026-10-26 10:20 ET — Record M4 (.20) live runtime snapshot (Coded; record only, no PR)
- Why: Randy asked to record the exact code now running on the Mac mini `.20` M4 runtime so a later PR can build on it. This branch is a record only. No logic was rewritten here, no PR, no merge, no history rewrite.
- Base: `feature/lm-fallback-144-20261025` commit `f86efea`. Overlay from the runtime working-tree tarball (sha256 `b3a5d240965fe9219c95664a36ec99c613362285496c8357cc67ff7695121f67`). Snapshot commit `e061d87`.
- Path/time: `~/BobRuntime/cutover/mindcraft-m4` as of 2026-10-26 10:20 ET.
- Includes the long-memory patch applied at 09:56 ET: `src/models/prompter.js` (`ensureLongMemoryPlaceholder` inserts `$LONG_MEMORY` into conversation prompts that lack it) and `src/agent/library/bob_brain_v2.js` (lane-aware advice receipts: skip "no `$LONG_MEMORY` placeholder" on non-conversation lanes; `modelTraceIds`).
- Also includes previously uncommitted M4 files: `bob_path_retry.js`, `bob_path_escalation.js`, `bob_goal_circuit.js`, `bob_ai_v2.js`, `bob_runtime_paths.js`, plus modified `skills.js`, `self_prompter.js`, `failures.js`, and `bob_brain*.js`. Other overlay diffs: `settings.js` (uses `bobRuntimePath`), `vision_interpreter.js`, `mindserver.js`, `agent_process.js`, `embedding_cache.js`, and the matching tests. `keys.json` was intentionally not included.
- Deleted under `src/`, `profiles/`, `test/`, `services/`, `patches/`: none (those trees already matched the tarball; AppleDouble `._*` metadata from the Mac archive was not committed).
- Secret scan: only test fixtures (`valid-token`, `PAYLOAD_SENTINEL`, `sk-proj-this-should-never-appear`). No real credentials.

## 2026-10-25 12:30 PM ET — `.144` is the default LM Studio endpoint, `.143` the fallback (Deployed, Live-verified; PR open, not merged)
- Why: Randy asked at 12:28 PM ET to make `.144` (Wi-Fi) the default while `.143` (Ethernet) stays down. With `.143` first, every start printed about 85 probe warnings and one call per 30 s paid a failed 1.5 s probe.
- Profiles only (no code change): `andy-api-lite.json` chat `url` and embedding `url` are `.144`, with `lmstudio_fallback_urls` / `params.fallback_urls` `[.143]`. `andy-api.json` chat is the same. Its Ollama `.143:11434` entries are unchanged. Comments in `settings.js`, `lm_endpoints.js` and `andy_pool.js` were updated to match.
- Checked 12:30:22–12:36:37 PM ET after the LITE restart: 16 chat calls, all on `.144` (median 24.7 s), 0 probes or warnings for `.143` (the startup burst is gone), 3 `embed=ok`, 0 embedding errors, 0 Andy API calls, no crashes.
- To go back to Ethernet-first once `.143` is reachable again, swap the two URLs back in the profiles. That needs a restart.

## 2026-10-25 — LM Studio endpoint fallback .143 → .144 (Deployed, Live-verified; PR open, not merged; order swapped at 12:30 PM ET, see above)
- Why: the living-room Mac's Ethernet address `192.168.1.143` went unreachable around 9:34 PM ET Oct 24. Every LM Studio chat and embedding call failed, chat fell back to the Andy API (rate-limited overnight), and embeddings fell back to word overlap. The same Mac and the same LM Studio are reachable over Wi-Fi at `192.168.1.144`.
- `src/utils/lm_endpoints.js` (new): ordered endpoint list, a TCP connect probe (`connectMs`, default 1500), and a 30 s skip window for an endpoint that does not connect. Returns `null` when none connects.
- `andy_pool` (`lmstudio_primary`): profile `url` first, then `params.lmstudio_fallback_urls`; `params.lmstudio_connect_timeout_ms` (default 1500). One OpenAI client per URL. An `APIConnectionError` (not a timeout) marks that URL down for 30 s. A slow-model timeout does not switch URLs (same server). If no URL connects, the existing LM Studio pause and Andy API fallback apply unchanged. The pool log line now starts with `lm_url=<url>`.
- `lmstudio` embeddings: `embedding.params.fallback_urls`, `connect_timeout_ms`, optional `embed_timeout_ms` (default 15000). These keys are removed from the params spread into chat requests.
- Profiles: `andy-api-lite.json` and `andy-api.json` chat URL `.143` with `.144` fallback; lite embeddings `text-embedding-nomic-embed-text-v1.5@q8_0` on `.143` with `.144` fallback. (The fork still had `.20` before this branch; live moved to `.143` on Oct 24.) Normal mode's embedding/code/vision models still point at Ollama `.143:11434`, with no fallback.
- Known noise: at startup, the burst of example embeddings probes `.143` in parallel before the first failure is recorded, so about 85 "unreachable" warnings print once. After that it is at most one probe per 30 s. Coalescing concurrent probes is a possible follow-up (needs a restart).
- Deployed to LinuxGrok Oct 25 ~12:16 PM ET (LITE restart). The private ops repo `geekdadteach/minebob` records the deploy and rollback.

## 2026-10-24 — Receipts, rotation, and longer advice (Merged, not deployed)
- PR #8 **Merged** into `newearth/main` at 12:03 PM ET Oct 24 as `79e8f2b`. Both GitHub Actions workflows (Bob Brain client tests, BobBot MindServer control tests) passed on `79e8f2b`.
- Rebased onto `newearth/main` `4398d7a` (PR #10). Optional V2 JSONL receipts stay off unless `BOB_BRAIN_V2_EVENT_LOG` is set. `advice_injected` is written only after the stored line is found in the finished conversation prompt. Optional rotation stays off unless `BOB_BRAIN_V2_ROTATE_LOG=1` (four archives `.1`–`.4`, otherwise the 1 MiB stop). See `docs/BOB_BRAIN.md` and `docs/BOB_V2_RECEIPT_ROTATION.md`.
- Each stored note is capped at 900 characters (`BOB_BRAIN_MAX_ADVICE_CHARS`), cut at a sentence, line, or word, with `…`. The `$LONG_MEMORY` block is capped at 2500 characters (`BOB_BRAIN_MAX_ADVICE_BLOCK_CHARS`) and keeps the newest whole notes. The unverified framing is unchanged.
- **Not deployed.** Receipts, rotation, and the longer advice are Merged in `79e8f2b` but not on the live process. Live Bob is still `4398d7a` (below). GitHub Actions workflows stay; PR #9 (local-only tests) was closed unmerged at 12:03 PM ET.

## Role of this repo
- Home of Bob's **game code** (Mindcraft CE + NewEarth changes). Public.
- The private repo `geekdadteach/minebob` holds ops (scripts, Discord control bot, reset-watcher, systemd units, polkit, Bob Brain queue source), config/profiles, docs, AI handoff rules, and the record of **which commit of this fork is live**.

## Branches
- `m4-runtime-20261026` — record-only snapshot of the Mac mini `.20` M4 runtime at `~/BobRuntime/cutover/mindcraft-m4` as of 2026-10-26 10:20 ET, branched from `f86efea` (`feature/lm-fallback-144-20261025`). Snapshot commit `e061d87`. Not a PR. Later work may build on it.
- `feature/lm-fallback-144-20261025` — LM Studio `.144` first, `.143` fallback. Head `f86efea`. Parent of `m4-runtime-20261026`. LinuxGrok LITE used this tree on Oct 25.
- `develop` — fork default branch, as inherited from upstream. Do not change it or the default-branch setting without Randy's OK.
- `newearth/live-2026-10-23` — exact live tree from LinuxGrok on 2026-10-23:
  - `80045e6` — exact live snapshot of `~/ai-player/mindcraft-ce-stable-42da10d` (upstream stable `42da10d` + working tree), unchanged.
  - `49761ee` — exact live `package-lock.json` + `NEWEARTH.md`.
  - Later commits on this branch are documentation only unless the changelog says otherwise.
- `newearth/main` — `5d8be33` (= `49761ee` code + docs), then PR #1 merged as `e923683`, then PR #2 merged as `dddbaf4`, then PR #3 merged as `b940ba3` (prismarine-chunk guard), then PR #4 merged as `caa179a` (Bob Brain client), then PR #5 merged as `bf99ace` (plain-text advice, conversation prompt only), then PR #10 merged as `4398d7a` (idempotent Bob Brain client keys, 10:51 AM ET Oct 24), then PR #8 merged as `79e8f2b` (receipts, optional rotation, longer advice, 12:03 PM ET Oct 24). This is the working line; base new work on it, not on `develop`.
- `cursor/bob-brain-advice-1dc4` — PR #5 (branch since deleted), merged into `newearth/main` as `bf99ace` and included in the live `4398d7a` tree. Readable review notes, public `enqueuePlan` / `enqueueFailureAnalysis` / `currentAdvice` / `status`, and advice only in prompts that contain `$LONG_MEMORY`. See `docs/BOB_BRAIN.md`.
- `cursor/bob-brain-client-key-391b` — PR #10 (branch deleted Oct 24 12:12 PM ET, head `0ac8c7e`), merged as `4398d7a` and deployed (see What is live). `client_key` names one request (kind, coarse label, canonical payload, 10-minute bucket) instead of a cell forever. A reused-key HTTP 400 is counted and not retried. Non-2xx responses log the JSON `error` string, clipped and deduped. See `docs/BOB_BRAIN.md`.
- `cursor/bob-v2-receipts-14bd` — PR #6, optional V2 JSONL receipts. PR #6 was **closed unmerged** at 12:03 PM ET (superseded by PR #8); its code arrived in `79e8f2b` through PR #8. Not deployed. Off unless `BOB_BRAIN_V2_EVENT_LOG` is set.
- `feature/v2-receipt-rotation-review-20261023` — PR #8, rebased onto `4398d7a`: PR #6 receipts, PR #7 bounded rotation, and longer advice. **Merged** as `79e8f2b` (12:03 PM ET Oct 24). Not deployed. PR #7 (rotation, same head branch into PR #6's branch) was closed unmerged; its code is in PR #8.
- `cursor/v2-receipts-longer-advice-3f21` — same head commit as PR #8 (`cbb1da0`), no PR of its own. Its content is in `79e8f2b`.
- `chore/local-tests-newearth-20261023` — PR #9 (local-only tests, retire hosted Actions), **closed unmerged** at 12:03 PM ET. Branch kept for Randy to decide.
- `newearth/secure-mindserver-2026-10-23` — PR #2 (branch deleted Oct 24 12:12 PM ET, head `dcc4d7f`), merged into `newearth/main` as `dddbaf4` (deployed 2026-10-23), from `5d8be33`: MindServer binds `MINDCRAFT_BIND_HOST` (default `127.0.0.1`), optional token-gated BobBot control (off unless `MINDCRAFT_BOBBOT_TOKEN_FILE` is set), port comment fixed to 8081.
- `newearth/port-minebob-2026-10-23` — PR #1 (branch deleted Oct 24 12:12 PM ET, head `f256c80`), merged into `newearth/main` as `e923683` (deployed as part of `dddbaf4`), from `5d8be33`: pathfinder door/gate patch from minebob `73f7378` (matches live `node_modules`), `full_state.js` goal block.

## What is live
- Mac mini `.20` M4 runtime (2026-10-26 10:20 ET): branch `m4-runtime-20261026` commit `e061d87`, recorded from `~/BobRuntime/cutover/mindcraft-m4`. This is the snapshot of that host. It is not merged and is not a PR.
- LinuxGrok since Oct 25 ~12:30 PM ET (LITE mode): `newearth/main` `79e8f2b` code (deployed Oct 24 12:24 PM ET) plus `feature/lm-fallback-144-20261025` (`f86efea`) LM Studio fallback with `.144` first. From ~12:16 PM ET until then, the same code ran with `.143` first. The private ops repo records the deploy, PIDs and rollback.
- Before that: `79e8f2b` from Oct 24 12:24 PM ET, with profiles switched from `.20` to `.143` at 3:58 PM ET Oct 24 (recorded in minebob, not in this fork until this branch). The earlier "live is `4398d7a`" note is stale.
- The prismarine-chunk guard from PR #3 (`b940ba3`) is in the live tree.
- Older rollback tree: `49761ee` content from 2026-10-23.
- Planned, not done: run Bob straight from a checkout of this fork so live == GitHub.

## Bob Brain client

- Game-side client only. The queue stays a separate process on `127.0.0.1:8765`. This client never runs commands from a job result. The queue is not modified by this fork.
- PR #4 (`caa179a`) is on `newearth/main`. A live queue test of that client put a truncated JSON dump in Bob's note. PR #5 (`bf99ace`) renders `summary`, or a plain plan / failure-analysis line, and skips `validation.valid === false`. That rendering is in the live `4398d7a` tree. PR #10 (`4398d7a`) is merged and deployed. PR #8 (`79e8f2b`) is merged, not deployed.
- `client_key` is unique on the queue forever. A second POST with the same key and a different kind or payload is HTTP 400 `client_key already used for different job`. The same key and payload returns the old job. Keys from PR #4 were only the cell and cause, the failure kind and cell, or the plan objective, so the next death or failure in that cell (a different exact position or goal) was a 400, and an identical payload only replayed a finished job. The client now hashes the kind, that coarse label, a canonical JSON of the payload, and a 10-minute bucket. Retries in the bucket reuse the key. Cooldowns in the client remain the dedupe. A conflicting 400 is counted, logged without the payload, and not retried.
- Any non-2xx response logs the JSON `error` string (control characters removed, 120 characters, token redacted) at most once per distinct text every few minutes, with a count. The request payload and headers are not logged.
- Enable with `BOB_BRAIN_TOKEN_FILE` (mode 600, 32+ characters, outside this repo) and optional `BOB_BRAIN_URL` (loopback only, default `http://127.0.0.1:8765`). Unset token file means disabled.
- The note is inserted only where the prompt contains `$LONG_MEMORY`. One note defaults to 900 characters and the block defaults to 2500, newest notes first, still under the unverified header. Both caps are env-configurable. See `docs/BOB_BRAIN.md`. The longer caps are Merged in `79e8f2b`, not on the live process.
- Plan jobs send `{objective, footprint:{width,depth}}` with width/depth in 1..32, or 5×5 when the goal text has no size. Scripts can call `enqueuePlan`, `enqueueFailureAnalysis`, `currentAdvice`, and `status`.
- V2 receipts are a separate switch. `BOB_BRAIN_V2_EVENT_LOG` must be an absolute path or Bob writes nothing. Use a different file from the one V2 already tails (`BOBBOT_V2_BRAIN_LOG`); V2 has only that one path today. `lesson_applied` and `lesson_outcome` are not emitted. See `docs/BOB_BRAIN.md`.

## Deploy note for secure-mindserver
- If deployed, the MindServer web UI (port 8081) becomes loopback-only. To keep LAN access set `MINDCRAFT_BIND_HOST=0.0.0.0` in the service env before restarting.
- BobBot control needs `MINDCRAFT_BOBBOT_TOKEN_FILE` pointing at a private (mode 600, regular file, >= 32 chars) secret kept outside this repo. A bad file makes MindServer refuse to start.

## Known drift (2026-10-23)
- Live `node_modules/mineflayer-pathfinder` was hand-patched beyond live `patches/mineflayer-pathfinder+2.4.5.patch` (door/gate fixes). A fresh `npm ci` from `49761ee`/`5d8be33` would drop those fixes. Branch `newearth/port-minebob-2026-10-23` makes the patch file match live. **Fixed** (PR #1, in `dddbaf4`).
- Live `node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js` (prismarine-chunk 1.41.0) was hand-patched on 2026-10-19 (`~/ai-player/patches/prismarine-chunk-26.1-guard.patch` on LinuxGrok): `mcData.version['>=']('26.1')` throws with minecraft-data 3.98.0 (no `26.1` entry), so it is wrapped in try/catch and falls back to `hasFluidCount = false`. `dddbaf4` had no patch file for it, so a fresh `npm ci` would drop the guard and likely break chunk loading. **Fixed** on branch `newearth/prismarine-chunk-guard-2026-10-23` by `patches/prismarine-chunk+1.41.0.patch` (merged to `newearth/main` as PR #3, `b940ba3`); with it, a clean `npm ci` of this fork gives a `node_modules` identical to live (`diff -rq` empty).
- Note: `patches/minecraft-data+3.97.0.patch` is applied to the installed minecraft-data 3.98.0; patch-package warns about the version mismatch but applies it cleanly. Not changed.

## Rules
See `AGENTS.md`: public-repo warning (no secrets, Discord IDs or ops), Randy's rules, never merge/deploy/force-push/change default branches without his authorization.
