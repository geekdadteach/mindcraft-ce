# AI CHANGELOG — geekdadteach/mindcraft-ce (NewEarth fork)

## 2026-10-28 — PR #21 follow-up: claim #26 fallback, sethome confirm, embeddings (CODED; NOT DEPLOYED)
- **Goal:** After the live re-validation of PR #21, fix the new problems: real GP `/claimslist` format, shovel-before-click, `/sethome` confirmation, stale lesson embeddings. Operator is creating claim #26 server-side; the helper is fallback-only and must no-op if that claim already covers the 128×128.
- **Files:** `src/agent/library/{bob_claim,bob_claim_protect,chat_guard,bob_home_migrate,long_memory,reset_recovery}.js`, `src/agent/agent.js`, `scripts/migrate_bob_home.js`, tests, these docs, `AGENTS.md`.
- **Summary:** Parse GP 16.18.7 `world: x-1208, z688 (-16384 blocks)`; existing covering claim = success / do nothing; shovel required only for the create fallback; chat guard allows `/claimslist` only via the helper sender; `confirmSetHome` waits for a server ok/error/timeout; rewritten lessons drop `emb`; backfill re-embeds missing; `--bot-stopped` probes MindServer/launchctl with `--skip-running-probe`.
- **Tests:** `npm test` on Node 22 (count recorded after the run).
- **Deploy status:** Draft PR #21. Not merged, not deployed. Live Bob untouched.
- **Rollback:** Do not merge. Revert the follow-up commit(s) on the PR branch if needed.

## 2026-10-28 — PR #21 live-review fixes (CODED; NOT DEPLOYED)
- **Goal:** Fix every ranked item from the live-machine review of draft PR #21. Item 1 is a real live bug: `bot.blockAt` was given plain `{x,y,z}` objects; prismarine-world calls `pos.floored()`.
- **Files:** `src/agent/library/{vec3_util,bob_home,bob_homestead,bob_claim_protect,bob_home_migrate,stuck_home,chat_guard,house_bounds,bob_enclosure,long_memory,reset_recovery,skills}.js`, `src/agent/{agent,commands/actions}.js`, `scripts/migrate_bob_home.js`, profiles, `AGENTS.md`, these docs, tests including new `test/bob_vec3_block.test.js`.
- **Summary:** Vec3 wrappers + strict mocks; in-claim + Bob-owned home; `/home house` refused until `/sethome house` at the verified door; claim helper walks/verifies/requires `approved:true`; migration lessons + `--bot-stopped` + compact JSON + tight regex; homestead skip-save; null-safe getters; enclosure `HOUSE_AREA` is the house_bounds object; own-claim excluded from keep-away; stale hilltop comments removed. Base `e6e20c8` already merged (no rebase/force).
- **Tests:** `npm test` on Node 22: **201/201 pass**, 0 fail. Vec3-strict tests would have caught item 1.
- **Deploy status:** Draft PR #21 against `work/bob-home-from-live-20261028`. Not merged, not deployed. Live Bob untouched.
- **Rollback:** Do not merge. Revert the review-fix commit(s) on the PR branch if needed.

## 2026-10-28 — Claim-first homestead conversion (CODED; NOT DEPLOYED)
- **Goal:** Finish sections A/B/D of Randy's claim-first homestead handoff: dynamic verified home, construction tracker, recovery without the old `/home`, memory migration, tests. Section C / live servers untouched.
- **Files:** `src/agent/library/{bob_home,bob_homestead,bob_home_migrate,bob_claim_protect,house_bounds,bob_enclosure,home_route,ai_player_nav,stuck_home,reset_recovery,escape,bob_goal_circuit,long_memory,protected_area,no_go_zones}.js`, `src/agent/{agent,modes}.js`, `src/agent/commands/{actions,queries}.js`, `scripts/migrate_bob_home.js`, profiles, tests listed in the handoff, these docs.
- **Summary:** Verified home is discovered from world features (door+bed+geometry) and persisted in `bots/<name>/verified_home.json`. Homestead progress in `homestead.json`. Hilltop is never a destination. Optional operator-only GriefPrevention helper (inbox `claim-property`) clicks the 128×128 corners and checks `/claimslist`; it never runs on start. Migration script dry-runs by default.
- **Claim plugin (from operator read-only check, not a live lookup in this repo):** GriefPrevention 16.18.7 on Paper; no WorldGuard; do not use NewEarthRules safe zones. No claim on the 128×128 yet. Golden-shovel corners (-1208,688) and (-1081,815); fallback `/adminclaims` + `/transferclaim MineBobNE`. **Needs Randy approval before anyone creates the claim.**
- **Tests:** `npm test` on Node 22: 184/184 pass, 0 fail. D1–D7 plus geometry, enclosure, escape, migrate, GP helper. No in-game validation.
- **Deploy status:** Draft PR against `work/bob-home-from-live-20261028`. Not merged, not deployed. Live Bob untouched.
- **Rollback:** Do not merge. Revert the PR branch if needed. Migration `--apply` restores from `bots/<name>/migrations/home-<ts>/`.

## 2026-10-28 — Claim-first autonomous homestead design (IN PROGRESS; NOT DEPLOYABLE)
- Randy chose a full 128x128 claim centered at X=-1144, Z=752; Bob must build his own home, without preassigned door/bed/house coordinates. The old hilltop is to be removed from active prompts and memory, not retained as a destination.
- Added `src/agent/library/bob_claim.js` with independent property geometry, boundary checks, and a helper that refuses to treat an unverified position as an established home; added `test/bob_claim.test.js`.
- **This is only the first isolated implementation step.** Existing `bob_home.js`, navigation, protection and memory code still reference the old physical house. Do not deploy this branch or change server claims until those dependencies are refactored, persistence is migrated safely, and tests pass. Claim geometry in bot code does not provide server-enforced grief protection.

### 2026-10-28 9:22 AM ET — MM20Bot — Fix `npm test` script quoting in `package.json`
- **Goal:** Randy (9:21 AM ET) asked for the `test` script quoting bug to be fixed on `work/bob-home-from-live-20261028`.
- **Files:** `package.json` (`"test": "node --test \"test/**/*.test.js\""`; inner quotes escaped, no other change), these docs.
- **Summary:** Commit `a195897` had unescaped inner quotes, so `package.json` was invalid JSON and `npm test`/`npm ci` failed with `EJSONPARSE`.
- **Tests:** `npm test` on `.20` (Node 22.23.4, separate checkout `~/BobRuntime/bob-home-validation`): 156/156 pass, 0 fail, 0 skipped; `zz-lm-test.mjs` not run, no Ollama call.
- **Deploy status:** Not merged, not deployed. Live Bob untouched (PID 65846).
- **Rollback:** Revert the commit.

## 2026-10-28 — Home consolidation on verified live snapshot (CODED; NOT DEPLOYED)
- Branch: `work/bob-home-from-live-20261028`, based on sanitized live snapshot `a438d10`; PR #19/#20, main and running Mac unchanged.
- Centralized house coordinates, door/porch protection geometry, indoor occupancy bounds, cave escape avoidance center, enclosure probe positions, reset target, diagnostics, and fixed memory places in `bob_home.js` and consumers. Indoor detection remains distinct from the protected area. The bed hint is now `-822 124 569` rather than `-823 124 568`, with the same six-block search radius.
- `home_routes.json` transitions to version 2 with a `home` entrance key when saved. Version-1 data at the unchanged entrance retains its routes; relocation invalidates old waypoints and archives the original file as `home_routes.json.pre-relocation.json` on save. Other saved memory files are not deleted or reset.
- Regression tests now reside in `test/bob_home_geometry.test.js`. `npm test` uses `node --test "test/**/*.test.js"` so the root `zz-lm-test.mjs` embedding probe is not run.
- Developer independently verified earlier HEAD `54d6e4b`: 157/157 tests via unscoped `node --test` (includes unrelated root embedding probe); PR #20 suites remained green, and Bob stayed PID 65846. **The later test relocation, scoped npm test command and documentation commits have not yet been retested.** No live in-game validation or deployment authorization. Keep Bob running unchanged until reviewed.
- Remaining release gate: `npm test` on current branch, review runtime route persistence on a copy of saved data, then explicit deployment approval. No automatic home behavior switches changed.

### 2026-10-28 8:47 AM ET — Grok Bot — Branch `snapshot/bob-live-m4-20261028`: sanitized live `.20` snapshot
- **Goal:** Randy (8:46 AM ET) asked for a snapshot of Bob's live code on a separate branch, excluding credentials, private runtime data and logs, as the exact baseline to finish against.
- **Files:** Over `3d6bd38`: `src/agent/library/{stuck_home,ai_player_nav,reset_recovery,no_go_zones}.js`, `src/agent/modes.js`, `test/bob_stuck_home.test.js`, new `test/bob_pr20_independent.test.js`, `test/bob_pr20_navigation.test.js` (reconciled PR #20 as deployed Oct 27 7:00 PM ET; auto home-teleport/night-home/unstuck-home opt-in only), plus these docs.
- **Excluded:** `keys.json`, `bots/` runtime data, `logs/`, `cache/`, `run/` (runtime state and ops scripts), `andy_quota_ledger.json`, `M4_CUTOVER_STATUS.json`, `.bak`/`.before-*` backups, `node_modules/`. No deletions.
- **Secret scan:** pattern grep + gitleaks: clean.
- **Tests:** `node --test test/` 152/152 (box, Node 20.19.2).
- **Live state:** Not merged, not deployed. `.20` read only; Bob untouched.
- **Rollback:** Delete the branch.

### 2026-10-27 — ChatGPT — Initial sustainable-food guard and balanced relocation (CODED; NOT TESTED)
- **Goal:** Advance Bob developer orders without deploying or touching server state.
- **Files:** `src/agent/library/survival.js`, `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md`.
- **Behavior:** Recovery candidates now sample all compass directions at each radius. Hunting checks at least three visible huntable adults of the selected species within 64 blocks, preserving two. Crop gathering precedes berries/hunting, and refuses homestead protected boxes and no-go zones. Breeding and planting are NOT implemented; other-player claims need a reliable protection API before planting.
- **Tests:** Not run after these commits; previous 148/148 pass belongs to older d3d8b4f. Do not claim current branch passed.
- **Risk:** Entity adulthood metadata and Minecraft world integration require live-like tests. Crop harvest may not replenish seeds; current guard cannot identify arbitrary player builds.
- **Rollback:** Revert unmerged commits. Live runtime unchanged.
- **Next:** Implement remaining orders, test and review. No deploy without Randy's authorization.


Append one dated entry per logical change, newest first. Never erase prior entries.

### 2026-10-26 9:00 PM ET — Grok Bot — Branch `nav-on-live-20261026`: PR #14 on the live tree, porch kept protected
- **Goal:** Randy (8:18 PM ET) step 2. Port the PR #14 nav unreachable/enclosure handling onto `live-m4-20261026` without breaking the live patches and without exposing house blocks.
- **Files:** PR #14's files (`bob_nav_memory.js`, `bob_enclosure.js`, `house_bounds.js`, `protected_area.js`, `skills.js`, `ai_player_nav.js`, `bob_goal_circuit.js`, `failures.js`, `self_prompter.js`, tests, `.github/workflows/bob-nav.yml`) plus `src/agent/library/reset_recovery.js`, `test/bob_nav_on_live.test.js` and `test/bob_enclosure.test.js`.
- **Summary:** Cherry-picked PR #14. The porch row z 564..565 is protected again, because the log shows oak_log posts at -823/-821/-819 124 565 and the outside plate -820 124 565. Only loose fill is diggable in the door lane, and the plate support is never diggable. `inBox` floors coordinates. A reset or stuck-home teleport clears the nav blacklist.
- **Decisions:** Fill-only lane instead of an open lane, so no house block can be dug. Unknown block names count as protected.
- **Tests:** 114/114.
- **Deploy status:** Not deployed. Deployed together with `task-finish-fixes-20261026` via MM20.
- **Rollback:** The deploy package's `rollback.sh` restores the pre-deploy live files.

### 2026-10-26 8:30 PM ET — Grok Bot — Branch `live-m4-20261026`: record of live `.20` (no logic changes)
- **Goal:** Randy (8:18 PM ET): record everything live on `.20` in git before any new deploy.
- **Files:** `src/agent/agent.js`, `src/agent/commands/actions.js`, `src/agent/modes.js`, `src/agent/library/{stuck_home,chat_guard,reset_recovery}.js`, `test/bob_{stuck_home,reset_recovery}.test.js`, `profiles/andy-api.json`, `docs/BOB_AI_RECEIPTS.md`, plus these docs.
- **Summary:** PR #15 plus the stuck-home (with the nodistance edit), reset-recovery and chat-guard patches, copied byte-for-byte from the live dir. The `andy-api.json` == `andy-api-lite.json` oddity is kept as it is live.
- **Tests:** 94/94 `node --test test/`. Every tracked non-doc path was hash-compared against live: identical. gitleaks: no leaks.
- **Deploy status:** Already live on `.20`. Record only. PR open against `m4-runtime-20261026`, not merged.
- **Rollback:** n/a (record). Revert the commit to drop the record.

### 2026-10-26 3:50 PM ET — Grok Bot — andy_pool `api_fallback: false`; coding allowed in LITE
- **Goal:** Randy: chat only on local LM Studio Andy-4.2 with no API backup (errors must not drain quota); coding on the Andy API (`claude-haiku-5.5`) always allowed, LITE included.
- **Files:** `src/models/andy_pool.js`, `src/models/prompter.js`, `src/models/andy.js`, `settings.js`, `profiles/andy-api-lite.json`, `profiles/andy-api.json`, `test/andy_pool_no_api_fallback.test.js`, docs.
- **Summary:** `api_fallback: false` = LM Studio only, clean no-reply on failure, no API embeddings; empty fallback list allowed; prompter embedding fallback keeps andy_pool params; 429 log shows error type/code and Retry-After; LITE no longer disables coding; profiles use `code_model` `claude-haiku-5.5` and no vision model.
- **Decisions:** Default stays `true` so other profiles behave as before. Vision stays off (no vision request path in andy/andy_pool; local model is loaded without a vision projector).
- **Tests:** new test file 9/9 pass; `node --check` on changed files.
- **Deploy status:** Not deployed, not merged. Base `m4-runtime-20261026` (matches the live model code).
- **Rollback:** revert the commit.

### 2026-10-26 10:20 ET — Grok Bot — Record M4 (.20) live runtime snapshot (no logic changes)
- **Goal:** Randy authorized a record-only branch of the exact code running on the Mac mini `.20` M4 runtime, so a later PR can build on it. No logic rewrite, no PR, no merge, no history rewrite.
- **Files:** Overlay of `src/`, `profiles/`, `settings.js`, `main.js`, `package.json`, `package-lock.json`, `test/`, `services/`, `patches/` from `~/BobRuntime/cutover/mindcraft-m4` (tarball sha256 `b3a5d240965fe9219c95664a36ec99c613362285496c8357cc67ff7695121f67`), plus this handoff/changelog. Snapshot commit `e061d87` (24 files, +1647/−71). Docs commit follows.
- **Summary:** Branch `m4-runtime-20261026` from `f86efea`. Includes the long-memory patch applied at 09:56 ET (`src/models/prompter.js` `$LONG_MEMORY` fallback; `src/agent/library/bob_brain_v2.js` lane-aware advice receipts) and the previously uncommitted M4 files (`bob_path_retry.js`, `bob_path_escalation.js`, `bob_goal_circuit.js`, `bob_ai_v2.js`, `bob_runtime_paths.js`, plus modified `skills.js`, `self_prompter.js`, `failures.js`, `bob_brain*.js`). `keys.json` was not included. No files were deleted under `src/`, `profiles/`, `test/`, `services/`, or `patches/`.
- **Decisions:** Record the live tree as-is. AppleDouble `._*` files from the Mac archive were omitted (Finder metadata, not running code).
- **Tests:** Secret scan of the overlay: only test fixtures (`valid-token`, `PAYLOAD_SENTINEL`, `sk-proj-this-should-never-appear`). No real credentials. Byte-compare of overlay paths to the tarball: identical after omitting `._*`.
- **Deploy status:** Already running on `.20` at snapshot time. This branch only records that tree. Not a PR.
- **Rollback:** delete the branch; live `.20` is unchanged by this record.
- **Remaining work:** a later PR may build on `m4-runtime-20261026`.

### 2026-10-25 12:40 PM ET — Grok Bot — Make LM Studio `.144` the default, `.143` the fallback (deployed)
- **Goal:** Randy at 12:28 PM ET Oct 25: "Let's just change it for now make 144 his default". `.143` (Ethernet) is still down, so putting it first only added probe warnings and probe delays.
- **Files:** `profiles/andy-api-lite.json` (chat and embedding `url` → `.144`, fallbacks → `[.143]`), `profiles/andy-api.json` (chat `url` → `.144`, `lmstudio_fallback_urls` → `[.143]`; Ollama entries unchanged), comments only in `settings.js`, `src/utils/lm_endpoints.js` and `src/models/andy_pool.js`, plus `docs/AI_HANDOFF.md` and `docs/AI_CHANGELOG.md`.
- **Summary:** This only swaps the order. The fallback logic from the previous entry is unchanged: if `.144` stops connecting, chat and embeddings try `.143`, then the Andy API or word overlap.
- **Decisions:** Done in the profiles, not in code, so going back to Ethernet-first is a two-line profile swap plus a restart.
- **Tests:** Profiles parse as JSON; `node --check` on `settings.js` and the two JS files. After the LITE restart at 12:30:22 PM ET, watched until 12:36:37 PM ET: 16 chat calls, all `lm_url=.144` with `attempts=1` (10.2 / 24.7 / 26.4 s min/median/max), 0 `.143` probes or warnings, 3 `embed=ok` (31–45 ms), 0 embedding errors, 0 Andy API calls, 0 connection errors, 0 429s, no crashes, `:8081` returned 200. Secret scan of the diff: clean.
- **Deploy status:** Deployed and live-verified on LinuxGrok (LITE). The live profiles, `settings.js` and code files are byte-identical to this commit. The private ops repo records the deploy and rollback.
- **Rollback:** revert this commit (back to `.143` first); on the host, the private ops repo's backup `rollback.sh` restores the previous files and restarts LITE.
- **Remaining work:** Swap back to `.143` first if Randy wants Ethernet once `.143` is reachable. Normal-mode Ollama models are still `.143:11434` only.

### 2026-10-25 12:30 PM ET — Grok Bot — LM Studio endpoint fallback .143 → .144 (PR open, deployed)
- **Goal:** Randy approved at 12:13 PM ET Oct 25: "Make the .143→.144 fallback change, record it in a minebob/fork PR, and restart Bob." `.143` (Ethernet) has been unreachable since about 9:34 PM ET Oct 24; the same LM Studio answers on `.144` (Wi-Fi).
- **Files:** `src/utils/lm_endpoints.js` (new), `src/models/andy_pool.js`, `src/models/lmstudio.js`, `profiles/andy-api-lite.json`, `profiles/andy-api.json`, `settings.js` (comment only), `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md`.
- **Summary:** Chat (`andy_pool` `lmstudio_primary`) and LM Studio embeddings try the profile URL, then `lmstudio_fallback_urls` / `embedding.params.fallback_urls`, choosing the first that accepts TCP within 1500 ms. A URL that fails to connect is skipped for 30 s. Connection errors (not timeouts) mark a URL down. If nothing connects, the existing pause plus Andy API fallback applies. The pool log shows `lm_url=`. The fork's profiles move from the stale `.20` to `.143` with `.144` fallback (embedding model `@q8_0`, matching live).
- **Decisions:** A timeout does not switch URLs because both IPs are the same server. No new runtime dependency. The code files are copied byte-for-byte from the live tree so live == this commit.
- **Tests:** `node --check` on changed JS; profiles parse as JSON; local probe test (closed port skipped, open port chosen, skip window honored, all-down returns null). On LinuxGrok before restart: real embed via `.144` after the `.143` probe failed (1712 ms, then 37 ms; 768 dims) and a real chat via `_callLmDirect` (`lm_url=.144`, 919 ms). After restart: chat calls on `.144` (13–24 s each), no embedding connection errors. Secret scan of the diff: clean.
- **Deploy status:** Deployed and live-verified on LinuxGrok, LITE restart Oct 25 ~12:16 PM ET. Record and rollback are in the private ops repo.
- **Rollback:** revert this PR; on the host, the private ops repo's backup `rollback.sh` restores the previous files and restarts LITE.
- **Remaining work:** Coalesce concurrent startup probes (about 85 warnings once per start). Normal-mode Ollama models are still `.143:11434` only.

### 2026-10-24 12:10 PM ET — GitHub bot — Refresh AI handoff and changelog to current state
- **Goal:** Record that PR #8 merged into `newearth/main` as `79e8f2b` (12:03 PM ET), that PRs #6, #7, and #9 were closed unmerged, and keep live vs merged clear. Randy authorized docs refresh PRs at 12:01 PM ET.
- **Files:** `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md` (this entry). `AGENTS.md` unchanged (still accurate).
- **Summary:** Added the status-word legend. `newearth/main` history now ends at `79e8f2b`; receipts, rotation, and longer advice are Merged, not deployed. Branch list updated: PR #6 closed (superseded by #8), PR #7 closed (folded into #8), PR #9 closed (local-only tests), `cursor/v2-receipts-longer-advice-3f21` noted (same head as PR #8), `cursor/bob-brain-advice-1dc4` branch gone. Live Bob is `4398d7a`, reported by MineBobNE 60, Oct 24.
- **Decisions:** Entry inserted at the top because this file is newest-first; no existing entry edited. No IPs, Discord IDs, or ops details added (public repo).
- **Tests:** Docs-only; no code tests run. GitHub showed both workflows passing on `79e8f2b`. Scanned added text for secrets, IDs, and IPs (none).
- **Deploy status:** none.
- **Rollback:** revert the PR.
- **Remaining work:** Deploying `79e8f2b` needs Randy's OK (via the private ops repo). Branches of closed PRs #6, #7, #9 are kept for Randy to decide.
- **Update ~12:25 PM ET:** With Randy's authorization, merged PR branches `cursor/bob-brain-client-key-391b` (`0ac8c7e`), `newearth/port-minebob-2026-10-23` (`f256c80`), `newearth/secure-mindserver-2026-10-23` (`dcc4d7f`), and `newearth/prismarine-chunk-guard-2026-10-23` (`4270f1e`) were deleted ~12:12 PM ET; the branch list now marks them deleted. Their commits remain in `newearth/main`.

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

### 2026-10-27 — ChatGPT — Gameplay/ops ownership separation and home/food work (CODED, UNTESTED)
- Removed six public deployment/migration/rollback scripts and moved the saved-goal regression to the private `geekdadteach/minebob` feature branch. Operational scripts and tests now live under `ops/bob-autonomy/`.
- Added canonical `bob_home.js` and rewired house bounds, home routes, stuck-home and no-go-zone base coordinates; added `test/bob_home.test.js`.
- Added bounded animal breeding, local farm crop harvest/replant, population-preserving hunting, and tests. Farming vicinity is a proximity restriction, NOT proof of ownership; confirm farm plot/claims before live deployment. Breeding helper currently has no automatic scheduling or command integration; do not call it fully operational.
- Tests: Not run on MM20; isolated sandbox could not clone (git unavailable), so no PASS claim. Risk: gameplay APIs and exact log format require validation.
- No merge or deployment. Rollback: revert unmerged feature branch commits. Next: complete farming ownership validation and integration, verify private preflight on MM20, then request explicit deployment approval.

### 2026-10-27 — MM20 preflight correction
- MM20 preflight at f5fdd52: 141/147 passed; six failures exclusively referenced two ops tests whose scripts moved private. Relocated `test/bob_autonomy_deploy_preflight.test.js` and `test/bob_state_snapshot.test.js` to minebob private branch; next MM20 preflight required.
