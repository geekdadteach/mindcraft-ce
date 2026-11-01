# AI HANDOFF — geekdadteach/mindcraft-ce (NewEarth fork)

## 2026-11-01 — PR #42 last two fixes: bed-trip fallback and the dusk cutoff (TESTED; NOT DEPLOYED)
- Same branch/PR (`fix/autonomy-food-bed-20261101`, draft PR #42): one commit on top of 2206521.
- **A failed bed trip falls back to the shelter instead of looping.** `tryKnownBed` set `next_bed` only when a trip STARTED, so a slow trip (up to the 600 s cap) ended after its own 120 s window had already expired and the next tick started another trip - he could loop bed trips all night and never shelter. The cooldown is now set in a `finally`, i.e. measured from when the trip ENDS, and `tryKnownBed` also returns early while `bed_failed_until` is in force. (`bed_failed_until` is the value that tells `tryEmergencyShelter` to allow the shelter: `knownBed = now >= bed_failed_until`.)
  - NOTE: the `if (now < this.bed_failed_until) return;` guard is currently REDUNDANT - on failure `bed_failed_until` and `next_bed` are both set to `Date.now() + 120000`, so `bed_failed_until <= next_bed` always holds. It is kept as insurance; no test can distinguish it (verified: removing it fails nothing).
- **The food trip's dusk cutoff moved from 11000 to 8900.** The trip may take up to ~3600 ticks, so starting it after 8900 (nightfall 12542 minus 3600) risked it running into the night. New `FOOD_TRIP_LAST_START = 8900` in modes.js. The urgent food <= 12 path is unchanged and still runs at night.
- Tests: `bob_known_bed` **12/12** (+1: a 200 s failed trip leads to the shelter, not a new bed trip), `bob_food_stock` **12/12** (the dusk test now covers 8899 allowed / 8900, 9000, 11000, 12000, 14000 skipped). Full `npm test` on Node 22: **380/382 pass**; only the pre-existing `confirmSetHome` fails (plus the 1 skipped benchmark). Negative controls: reverting `next_bed` to start-only fails the new test; reverting the cutoff to 11000 fails the dusk test.
- UNPROVEN: still no live Minecraft session.

## 2026-11-01 — Review round on PR #42: boot safety, scan cost, bed hold, local food trip (TESTED; NOT DEPLOYED)
- Same branch and PR (`fix/autonomy-food-bed-20261101`, draft PR #42): one commit on top of a772978.
- **Boot can no longer be killed by a save.** `SelfPrompter.handleLoad` used to `throw` when a saved ACTIVE/PAUSED state had no prompt - `history.js` writes `self_prompt: ''` for a paused empty goal (`!goal("")` while in a conversation), and an older save can have a state with no prompt field. A throw there happens inside the bot's `spawn` handler, so it aborted boot. It now warns and degrades to STOPPED.
- **The night shelter decision is rate-limited.** `shelterReason` ran the 7x7x7 known-bed scan FIRST, and `tryEmergencyShelter` rate-limited only the build, not the decision - so the world was scanned on every ~300 ms mode tick, all night. The scan now runs LAST (behind the night / starving / hostile / health checks) and the decision itself is limited to one check per 15 s (`self_preservation` and `self_defense` run first, so a 12-block hostile warning is still timely).
- **The bed hold actually holds.** `tryKnownBed` set `holding`/`paused_sp`, but the no-verified-home branch released them on the very next tick (the shelter survives this only because `isSheltered()` short-circuits at the top of `update()`), so self-prompting restarted mid-bed-trip and could supersede the `mode:night` action. `release()` is now skipped while a night action is in flight.
- **Nearest bed.** `knownBedNear` returned the first `*_bed` the scan reached; it now returns the nearest to Bob, so he walks the shortest way.
- **The food-17 trip is local (A).** `getFood` gained `relocate` (default true) and `maxRange` (default null). The trip passes `relocate: false`: no 96-160 block far relocation and no `relocateForFood`, searching 40 then 80 blocks. The urgent food <= 12 path keeps the old defaults.
- **Dusk and low health (B).** The trip is skipped from `timeOfDay` 8900 onwards (moved down from 11000, see the entry above; the urgent food <= 12 gate still runs at night), and when health < 10 the whole search is capped at 24 blocks via `maxRange` instead of being skipped.
- **`shut_up` is cleared on resume (C).** `resumeAutonomy()` (pause ending, watchdog, night release, boot) and a player's `!goal` now clear `agent.shut_up`, which is otherwise only cleared when a player speaks to him - without this a player's `!stfu` left him silent for good even after autonomy resumed.
- NOT changed on purpose: a model-sent `!goal` is not gated. Bob has to be able to set his own goals or autonomy dies again.
- Tests: `bob_autonomy_never_off` **16/16**, `bob_food_stock` **12/12**, `bob_known_bed` **11/11**, `bob_night_shelter` **14/14**. Full `npm test` on Node 22: **379/381 pass**; only the pre-existing `confirmSetHome` fails (plus the 1 skipped benchmark). Ten negative controls verified - reverting any new behaviour fails its test.
- UNPROVEN: still no live Minecraft session.

## 2026-11-01 — Autonomy never off + food stock + known bed + honest shelter (TESTED; NOT DEPLOYED)
- New draft PR `fix/autonomy-food-bed-20261101` off `work/bob-home-from-live-20261028` (6261d71).
- **Autonomy never stays off** (opt-out `BOB_AUTONOMY=0`; new leaf module `src/agent/library/autonomy.js`):
  - `!stfu` / `!endGoal` sent by the MODEL during its own self-prompt or system turn are ignored — agent.js marks the turn in `_commandSelfPrompt` (same pattern as the existing `_bobV2ClaimAdvice`) and the command returns a note that goes into the history, so the model learns. A player's command still works.
  - `stopped_by` (`'player' | 'model'`) and `stopped_at` are saved in history.js. A **player's stop is a pause**: `BOB_PLAYER_STOP_SEC` (default 30 s). `canAutoRestart()` is the single rule shared by the idle watchdog, `night.release()`, `releaseNightHold()` (death/respawn) and the boot path. A model stop (or a legacy save with no `stopped_by`) is restarted by the ~2 min idle watchdog with `DEFAULT_SURVIVAL_GOAL`; a player's pause resumes as soon as it has passed (never the 2 min) when he is idle and not in a conversation or a night hold. A player's new `!goal` resumes him immediately. Boot honours the saved pause — it starts at once if the pause already elapsed while he was down, otherwise resumes when it ends, so he is never left stopped forever. With `BOB_AUTONOMY=0` the old behaviour returns (the stop sticks and the model may stop him).
  - Survival modes are untouched: `ModeController.update()` never consults the self-prompt state, so eat / flee / getFood / bed / shelter keep running while stopped.
- **Food when he has none** (opt-out `BOB_FOOD_STOCK=0`): the hunger mode runs `getFood` in the daytime with a wider hunt/forage search (`getFood({ searchRange: 40 })` → crops/berries/hunt at 40, then hunt 80) when he holds no edible item and food < 18 (regen needs 18) or health < 20, on a 2 min cooldown. It no longer waits for food <= 12. Both eat-from-inventory branches stay above it, so eating always wins; at night, while sheltered, or with the opt-out the old food <= 12 gate still applies.
- **Known bed** (opt-out `BOB_KNOWN_BED=0`): `night_shelter.knownBedNear()` counts a `*_bed` block at `BOB_BED` (now overridable with `BOB_BED=x,y,z`) or within 3 blocks of the last bed he slept in, if within ~48 blocks. `hasVerifiedBed()` / `shelterReason()` honour it, so at night with no verified home the night mode walks to that bed and sleeps with `skills.goToBed` (holding like the shelter), and the emergency shelter runs only if that trip fails (`bed_failed_until`).
- **Honest shelter**: `wallIn` now requires the roof cell above his head to end up solid (placed against a side or bottom face) and returns `filled >= 2 && roofSolid`. An open-roof hole therefore falls through to `digPocket`, and the log says `dug a 1x2 pocket` — "sealed in" is never logged with 0 blocks placed and an open roof.
- Tests: 3 new files + 2 extended. `bob_autonomy_never_off.test.js` **14/14** (model vs player stop, watchdog, the 30 s pause under fake timers, `BOB_PLAYER_STOP_SEC=5`, watchdog/release/respawn all refusing during the pause, boot both ways, `BOB_AUTONOMY=0`, eating while stopped), `bob_food_stock.test.js` **7/7**, `bob_known_bed.test.js` **7/7**, `bob_night_shelter.test.js` **14/14**. Full `npm test` on Node 22: **368/370 pass**; only the pre-existing `confirmSetHome` fails (plus the 1 skipped benchmark). Negative controls verified for all six behaviours — reverting any one of them fails its test.
- UNPROVEN: no live Minecraft session. The bed trip, the food trip and the shelter were exercised only against fake bots/worlds.

## 2026-11-01 — PR #41 merged into `work/bob-home-from-live-20261028` (MERGED; NOT YET DEPLOYED)
- Randy authorized it at 7:39 AM ET on Nov 1 2026. It was a `--no-ff` merge `7852c71` of `fix/lm-retry-and-identity-20261101` (`19bf1a3`) on `eb193af`; conflict-free.
- **Current state:** the branch now has the transport-only LM retry, the per-call pause bypass, and the identity-safe YOUR BRAIN line. The entry below describes the PR itself.
- **Not yet deployed:** MM20Bot is to deploy `src/models/andy_pool.js`, `profiles/andy-api.json` and `profiles/andy-api-lite.json` on top of the #27–#40 deploy, then restart Bob.
- Tests: full `npm test` on Node 22: 337/339 pass, 1 skipped; only the pre-existing `confirmSetHome` fails.

## 2026-11-01 — LM retry gating + Bob's identity line (TESTED; NOT DEPLOYED)
- New draft PR `fix/lm-retry-and-identity-20261101` off `work/bob-home-from-live-20261028` (eb193af).
- **Retry gating** — the one-shot 3 s LM retry now runs only for transport failures. New `lmFailureIsRetryable()`: `error` (connection errors and 5xx) and `timeout` retry; `http400` and `length` (context overflow) are prompt-specific and are never retried; `empty` is not retried either.
- **Shared pause** — the retry no longer sets `AndyPool._lmDownUntil = 0`, which used to lift the pause for every other in-flight call. It now sets a per-call `lmRetryBypass` flag, so only the retrying call ignores the pause; `_lmDownUntil` is left alone for everyone else and is still cleared only by a *successful* call. `clearLmUrlDown()` is still called so the retry can reach an endpoint that was marked down 10 s earlier (endpoint-level state, not the pause).
- **Identity** — `profiles/andy-api.json` and `profiles/andy-api-lite.json`: the "YOUR BRAIN" sentence keeps the facts for Bob's own use (chat = Andy 4.2 Air, a 4B Minecraft-tuned model; `!newAction` code = Google Gemini gemini-3.8-flash; memory search = nomic-embed-text v1.5) and tells him that when a player asks what he is or what model he runs on he answers only "I am Bob, from the land of AI!" — the rule already in CHAT RULES. No Randy / Mac mini / living room / Leon / LM Studio / IP anywhere in either prompt; both profiles' `conversing` strings are byte-identical.
- Tests: new `test/lm_retry_identity.test.js` **5/5** against a real local HTTP server: http400 is not retried (exactly 1 request, no 3 s wait), a timeout is retried exactly once (2 requests), and two concurrent calls — the first retries while the second still sees the pause (placeholder, no request of its own). Negative controls: un-gating the retry fails the http400 test; re-adding `_lmDownUntil = 0` fails the concurrent test. Full `npm test` on Node 22: **337/339 pass**; only the pre-existing `confirmSetHome` fails (plus the 1 skipped benchmark).
- UNPROVEN: no live Minecraft session and no live LM Studio; the 3 s retry path was exercised only against the local fake server. Names such as "Randy"/"Leon" remain in unrelated *code comments* (not in any prompt).

## 2026-11-01 — PRs #27–#40 merged into `work/bob-home-from-live-20261028` (MERGED; NOT YET DEPLOYED)
- Randy authorized merging all 14 at 7:19 AM ET on Nov 1 2026. They were merged in this order, each `--no-ff` on base `697f560`: #39, #37, #36, #35, #34, #33, #32, #29, #28, #30, #27, #31, #38, #40. The final merge head is `5fa9ef8`, with this docs commit on top.
- **Current state:** the branch now contains every fix in the entries below (sync to live, Fix 2/2b food loop and regen-while-sheltered, Fix 3 chest deposit plus auto-junk, Fix 5 combat interrupt and night shelter, Fix 6 pathfinder probe, Fix 7a–7e, the starter-tools/planks fix, and own-bed protection). Older entries that say "Not merged" describe the PR at the time it was written.
- **Not yet deployed:** live `.20` still runs the pre-merge tree plus #39's five files. MM20Bot is to deploy the files changed vs `697f560` and restart Bob. Only #39's five files (`profiles/andy-api*.json`, `src/utils/lm_endpoints.js`, `src/models/andy_pool.js`, `src/models/lmstudio.js`) overlap live-only edits, and they already match live.
- Tests: full `npm test` on Node 22: 332/334 pass, 1 skipped; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session with the combined build yet.

## 2026-11-01 — Fix 2b round 2: the regen top-up never cooks while sheltered (TESTED; NOT DEPLOYED)
- New draft PR `fix/regen-eat-sheltered-20261101`, branched from `fix/combat-interrupt-night-shelter-20261031` (#27) with `fix/food-loop-20261031` (#28) merged in. **It must land after #27 and #28.**
- `shouldEatForRegen` (Fix 2b, #28) sits above #27's sheltered branches, so a sealed-in, hurt Bob with food < 18 ran `cookOrEat` — which can walk to a furnace, exactly what the shelter guard forbids. The branch now reads `shelter.isSheltered() ? survival.eatBest(bot) : survival.cookOrEat(bot)`.
- Also added `ModeController.get(name)` so a test can drive one mode's `update()` (this is separate from #30's `getMode`, which is inserted near `initModes`, so the two branches do not conflict).
- Tests: new `test/bob_regen_eat_sheltered.test.js` **3/3**. It drives the real hunger mode against the real shelter state: sheltered + hurt + food 12 → `bot.consume()` runs and `inventory.slots` is never read (so `cookRaw` never ran); the same state unsheltered → `inventory.slots` IS read (the `cookOrEat` path). Negative control: reverting the ternary fails the test. Full `npm test` on Node 22: **288/289 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.


## 2026-11-01 — Branch synced to live `.20`: Gemini code lane in LITE + Leon-patience LM fix (TESTED; ALREADY LIVE; PR NOT MERGED)
- Draft PR `sync/live-to-git-20261101` → `work/bob-home-from-live-20261028` (base `697f560`). Do not merge without Randy's OK.
- **Current state once merged:** for these five files the branch matches Bob's live tree on `.20` (`~/BobRuntime/cutover/mindcraft-m4`) byte for byte: `profiles/andy-api-lite.json`, `profiles/andy-api.json`, `src/utils/lm_endpoints.js`, `src/models/andy_pool.js`, `src/models/lmstudio.js`. A drift check of the rest of `src/` and `profiles/` found no other differences (only an untracked `stuck_home.js.bak-20261026-nodistance` backup on live).
- Bob runs **`BOB_MODE=lite`**, so **`profiles/andy-api-lite.json` is the active profile**. Live `andy-api.json` is again byte-identical to `andy-api-lite.json` (known oddity, see Oct 26 entry).
- Leon (LM Studio host, `.144`) is reached over **Wi-Fi only**; `.143` Ethernet is not used (`lmstudio_fallback_urls: []`).
- Profile changes (live 5:22 AM ET): lite `code_model` is now Google `gemini-3.8-flash` (was Andy API `claude-haiku-5.5`; the key lives only in live `keys.json`, never in git); embedding model id `text-embedding-nomic-embed-text-v1.5` (no `@q8_0` suffix); a `YOUR BRAIN` sentence in the conversing prompt so Bob answers truthfully about Andy 4.2 Air on Leon / Gemini code / nomic embedder.
- Leon-patience fix (live 5:33 AM ET): connect timeout 1.5 s → **5 s** (profiles `lmstudio_connect_timeout_ms` and embedding `connect_timeout_ms` = 5000, code defaults also 5000); `pickLmUrl` retries the probe **once** after 1 s; a down endpoint is skipped **10 s** (was 30 s); new `clearLmUrlDown`. In LM-only mode (`api_fallback: false`) `andy_pool` waits out a pause of ≤15 s and **retries a failed LM call once after 3 s** before replying "My brain disconnected"; LM-only backoff is **10–60 s** (API mode keeps 30–300 s).
- Test: `test/andy_pool_no_api_fallback.test.js` profile test now expects Gemini for both profiles. Full `npm test` on Node 22: 255/256, only the pre-existing `confirmSetHome` failure.
- Nothing on live `.20` was changed or restarted for this PR.
## 2026-10-31 — Fix 7e: entity metadata read-error diagnostic (report 4.10) (TESTED; NOT DEPLOYED)
- Work-order item 7e. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- New `mcdata.readMetadata(entity, { now, windowMs, warn })`: wraps the `entity.metadata` read, logs once per entity name (rate-limited, default 60 s) with the entity name and a hint when the getter throws `read error`, and returns null instead of crashing. Wired into `mcdata.isHuntable` and the villager-profession/baby checks in `world.js`.
- Tests: new `test/bob_metadata_diag.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
## 2026-10-31 — Fix 7d round 2: pruned lessons are archived, the new one is kept (report 4.13) (TESTED; NOT DEPLOYED)
- Review of PR #36. Same branch, second commit (no force-push).
- `_archivePruned()` appends every dropped lesson to `bots/<name>/lessons.pruned.jsonl` (next to `lessons.json`) with `{ prunedAt, key, text, kind, count, first, last }` before the in-memory list is trimmed, so a pruned lesson can be recovered. The prune now keeps exactly `MAX_LESSONS` and always keeps the lesson just added (it is excluded from the prune, then appended).
- Tests: `test/bob_lessons_prune.test.js` **3/3** (new: the archive file, its lines, and the just-added lesson surviving). Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 7d: the lessons list is capped (report 4.13) (TESTED; NOT DEPLOYED)
- Work-order item 7d. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- New exports in `long_memory.js`: `MAX_LESSONS` (150), `lessonValue(lesson)` and the pure `pruneLessons(lessons, max)` (seeds first, then count, then recency; returns a new array). `_addLesson` now prunes through it instead of the old inline `sort`/`length = 150`.
- Tests: new `test/bob_lessons_prune.test.js` **2/2**. Full `npm test` on Node 22: **257/258 pass**; only the pre-existing `confirmSetHome` fails.
## 2026-10-31 — Fix 7c round 2: the verifier actually receives the result text (report 4.11) (TESTED; NOT DEPLOYED)
- Review of PR #35. Same branch, second commit (no force-push).
- **Wired** — `bob_eval_harness` now stores the last command's result summary (`_lastResultText`, set in `noteExecEnd`, cleared in `noteExecStart`) and passes it to `verifyGoal` as `resultText`, so the Fix 4.11 check actually runs (before, it never did).
- **Narrow phrases** — `FAILURE_PHRASES` drops the broad `could not` / `cannot` / `failed` (they also appear in partial successes) and keeps only whole-action failures (`not confirmed`, `no path`, `unreachable`, `don't have`, `inventory full`, `could not find`, `could not get`, `timed out`).
- **Only `met` is downgraded** — a failing result text downgrades a `met` verdict to `not_met` (`result-text`); a kind verifier that already said `not_met`/`progress` keeps its own label (so `!getFood` still reports `verifier: 'food'`).
- Tests: `test/bob_verifier_failure_text.test.js` **5/5** (new: the harness wiring, the downgrade, the partial-success case, and the label-preservation case). Full `npm test` on Node 22: **260/261 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 7c: a failing task text can never be verified met (report 4.11) (TESTED; NOT DEPLOYED)
- Work-order item 7c. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- New exports in `bob_goal_verifier.js`: `FAILURE_PHRASES` (shared list: not confirmed, could not, cannot, failed, don't have, no path, unreachable, timed out, inventory full) and `textReportsFailure(text)`. `verifyGoal()` now returns `not_met` (source `result-text`) when the task/result text reports failure, before any kind-specific check.
- Tests: new `test/bob_verifier_failure_text.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
## 2026-10-31 — Fix 7b round 2: clamp only above the maximum (report 4.8) (TESTED; NOT DEPLOYED)
- Review of PR #34. Same branch, second commit (no force-push).
- `clampToDomain()` no longer clamps a value UP to the minimum: it returns `belowMin` and leaves the value alone, and `parseCommandMessage` keeps the original parse error for a below-minimum number (so `num=0`, `count=0` and `distance=-5` are rejected, not silently turned into 1). It still clamps above the maximum, and for an open upper bound it clamps strictly inside the range (e.g. `y` stays below 320).
- Tests: `test/bob_param_clamp.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 7b: numeric params are clamped, not rejected (report 4.8) (TESTED; NOT DEPLOYED)
- Work-order item 7b. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- New `commands/index.js` export `clampToDomain(value, domain)` clamps into the declared interval (endpoint-aware) and reports `{ value, clamped, note }`. `parseCommandMessage` now clamps an out-of-range numeric param instead of returning a parse error and returns `clampNotes`; `executeCommand` prefixes the feedback with `(Note: <param>=<value> (clamped into <domain>).)`.
- Tests: new `test/bob_param_clamp.test.js` **2/2**. Full `npm test` on Node 22: **257/258 pass**; only the pre-existing `confirmSetHome` fails.
## 2026-10-31 — Fix 7a round 2: consume drinks potions and milk (report 4.9) (TESTED; NOT DEPLOYED)
- Review of PR #33. Same branch, second commit (no force-push).
- New `skills.isDrinkable(itemName)` matches `/potion$|^milk_bucket$/`; `consume()` now refuses only when the item is neither food nor drinkable, so `!consume("potion")` and `!consume("milk_bucket")` work (they are not in `foodsByName`).
- Tests: `test/bob_consume_edible.test.js` **3/3** (new: drinkables). Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 7a: consume() uses the registry for edibility (report 4.9) (TESTED; NOT DEPLOYED)
- Work-order item 7a. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- `skills.isEdible(bot, itemName)` decides edibility from `bot.registry.foodsByName` (allow by default; refuse only when the registry has the map and the item is absent), and `skills.consume()` refuses a non-food with `You cannot eat <item>; it is not food.` The named-item message (`You do not have any <item> to eat.`) is unchanged.
- Tests: new `test/bob_consume_edible.test.js` **2/2**. Full `npm test` on Node 22: **257/258 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.
## 2026-10-31 — Fix 6 round 2: a disabled code lane reports lane 'none' (report 4.5) (TESTED; NOT DEPLOYED)
- Review of PR #32. Same branch, second commit (no force-push).
- `codeLaneInfo()` returns `lane: 'none'` and `selected_lane: 'none'` when `codingEnabled` is false, instead of claiming the coding lane; `reason` is unchanged (`code lane disabled (allow_insecure_coding=false)`).
- Tests: `test/bob_code_lane.test.js` **3/3** (the disabled case now asserts `lane === 'none'`). Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 6: code lane startup log with its reason (TESTED; NOT DEPLOYED)
- Report 4.5, work-order item 6 (chore). Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`.
- **Startup log** — `agent.js` logs `[ai-player] code lane: <reason>` when the coder is created; the reason carries `coder_mode` (from `BOB_CODER_MODE`, default `auto`) and `coding_enabled` (from `allow_insecure_coding`). `coder.logLaneOnce()` repeats it once on the first `generateCode`.
- **Harness** — new `bob_eval_harness.codeLaneInfo()` builds the lane record; `noteLaneSelection()` stores it so every subsequent `turn_start` event carries `lane`, `lane_reason`, `coder_mode` and `coding_enabled`.
- Tests: new `test/bob_code_lane.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session; `BOB_CODER_MODE` is a new optional env knob (unset = `auto`), so live behaviour is unchanged.
## 2026-10-31 — Fix 3 round 3b: stripped logs are not planks (report 4.4) (TESTED; NOT DEPLOYED)
- Review of PR #29. Same branch, fourth commit (no force-push).
- `starterWoodType()` now gates on the already-imported `isNaturalWoodBlockName()`, so `stripped_oak_log` / `stripped_crimson_stem` / `stripped_birch_wood` return `null`: they never count as logs, never win the wood-type pick, and never become a `!craftRecipe("planks")` source.
- Tests: `test/bob_starter_tools.test.js` **8/8** (new: stripped logs are ignored). Full `npm test` on Node 22: **263/264 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 3 round 3: most plentiful wood type, 16-block table reach (report 4.4) (TESTED; NOT DEPLOYED)
- Review of PR #29. Same branch, third commit (no force-push).
- **Most plentiful wood** — new `logCountsByWood()`/`bestStarterWood()`; `starterPlanksName()` uses the wood type Bob holds the most of, and `heldLogCount()` returns that type's count, so a starter run needs >= 3 logs of ONE wood type instead of 3 logs of any mix.
- **Table reach** — `craftingTableAtHand()` now defaults to 16 blocks, matching `skills.craftRecipe`'s `craftingTableRange`.
- Tests: `test/bob_starter_tools.test.js` **7/7** (new: wood-type selection + the 16-block reach). Full `npm test` on Node 22: **262/263 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 3 review: 3-log minimum, table/tool skips, bamboo excluded (TESTED; NOT DEPLOYED)
- Review of PR #29. Same branch, second commit (no force-push).
- **3-log minimum** — `craftStarterTools()` returns immediately unless `heldLogCount(bot) >= STARTER_TOOLS_MIN_LOGS` (3), and crafts `STARTER_TOOLS_PLANKS` (3) planks in one `craftRecipe(bot, planks, 3)` call.
- **Skips** — the crafting table is skipped when one is held or within 4 blocks (`craftingTableAtHand()`), and the pickaxe/sword steps are skipped when Bob already has one of each.
- **Bamboo excluded** — `starterWoodType()` returns null for `bamboo`, so bamboo never maps to planks (in `survival.js` and `long_memory.correctName()`); `heldLogCount` does not count bamboo as a log.
- Tests: `test/bob_starter_tools.test.js` **5/5** (new: one log, two logs, table at hand, already-has-tools, bamboo). Full `npm test` on Node 22: **260/261 pass**; only the pre-existing `confirmSetHome` fails.
- NOTE for merge order: #28 also edits the imports and the end of `src/agent/library/survival.js`. Whichever of #28/#29 merges second must merge the base in (not rebase), combine the imports, and keep the closing `}` of `relocateFarForFood`.

## 2026-10-31 — Fix 3: planks alias and starter tools (TESTED; NOT DEPLOYED)
- Report 4.4, work-order item 3. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`. ON by default; `BOB_STARTER_TOOLS=0` opts out.
- **Planks alias** — `long_memory.correctName()` maps `planks`/`plank`/`wooden_planks` to the held log's own wood type (via `bob_wood_types.isNaturalWoodBlockName`), falling back to `oak_planks` only when no natural log is held. Previously it always forced oak.
- **Starter tools** — new `survival.starterToolsEnabled/needsStarterTools/starterPlanksName/craftStarterTools`; a new idle-only `starter_tools` mode (daylight, `interrupts: []`) crafts planks -> crafting_table -> sticks -> wooden_pickaxe -> wooden_sword with `skills.craftRecipe` when Bob holds logs but lacks a pickaxe or sword.
- Tests: new `test/bob_starter_tools.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome sets the flag only after a server ok reply` fails.
- UNPROVEN: no live Minecraft session; the crafting order and the idle trigger need an in-game check.
## 2026-10-31 — Fix 2 review: bounded relocation, junk-food gate, XZ goals (TESTED; NOT DEPLOYED)
- Review of PR #28. Same branch, second commit (no force-push).
- **Bounded relocation** — `relocateFarForFood()` stops before a spot (and ends) when it turns night, `health <= 10` or `food <= 4`, tries at most 3 spots (`FAR_RELOCATE_MAX_SPOTS`) and 180 s total (`FAR_RELOCATE_TOTAL_MS`); `shouldStopFarRelocation()` is the testable core.
- **XZ goals** — `farRelocationGoal()` aims at the XZ column (`pf.goals.GoalNearXZ`) when the ground height is unknown, instead of a `GoalNear` at a guessed y.
- **Junk-food gate** — `desperateForJunkFood(bot)` = `food <= 6` only; `edibleFoods`/`shouldEatForRegen`/`eatBest` use it, so `spider_eye`/`rotten_flesh`/`chicken` are never unlocked by low health alone.
- Tests: `test/bob_food_loop.test.js` **8/8** (new: bounded relocation, GoalNearXZ, junk-food gate). Full `npm test` on Node 22: **263/264 pass**; only the pre-existing `confirmSetHome` fails.
- NOTE for merge order: #29 also edits the imports and the end of `src/agent/library/survival.js`. Whichever of #28/#29 merges second must merge the base in (not rebase) and combine the imports, keeping the closing `}` of `relocateFarForFood`.

## 2026-10-31 — Fix 2: food loop (desperate edibles, regen eat, relocation, verified hunts) (TESTED; NOT DEPLOYED)
- Report 4.3, work-order item 2. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`. New behaviour ON by default; `BOB_FOOD_RELOCATE=0` opts out of the far relocation.
- **(2a) Desperate edibles** — `survival.edibleFoods()` now allows `spider_eye` (and keeps `rotten_flesh`/`chicken`) when desperate; new `isDesperate(bot)` = food <= 6 or health <= 6.
- **(2b) Eat to 18 for regen** — new `survival.shouldEatForRegen(bot)` (health < 20 and food < 18 and something edible); the `hunger` mode eats on it, before auto-eat's startAt 14 would fire.
- **(2c) Relocate after 2 empty searches** — `getFood()` counts consecutive empty local searches; after 2, in daylight it relocates to a ring 96–160 blocks out outside no-go zones (`relocateFarForFood`, `farFoodCandidates`) and retries `huntAnimal(64)` before reporting failure. `BOB_FOOD_RELOCATE=0` disables it.
- **(2d) Verified hunts** — `huntAnimal()` now walks to drops within 6 blocks for up to 5 s (`collectDropsFor`) and returns ok only when a food count actually rose.
- Tests: new `test/bob_food_loop.test.js` **5/5**. Full `npm test` on Node 22: **260/261 pass**; only the pre-existing `confirmSetHome sets the flag only after a server ok reply` fails.
- UNPROVEN: no live Minecraft session; the far relocation ring (96–160 blocks) and the drop-walk need an in-game check.
## 2026-10-31 — Fix 4 round 3: auto_junk wiring fixes (report 4.6) (TESTED; NOT DEPLOYED)
- Review of PR #30. Same branch, third commit (no force-push).
- **Wrong module** — the `auto_junk` mode called `survival.autoJunkEnabled()`/`survival.autoJunk()`, but those live in `skills.js`; it now calls `skills.autoJunkEnabled()`/`skills.autoJunk(bot)`, wrapped in try/catch.
- **Clear zones** — `junkAllowedHere()` also refuses within 32 blocks of the claim centre (-1144, 752), within 16 of the bed at -1144 68 752, and while sheltered (probed lazily via `shelter_state.js`, so it works before and after the night-shelter branch merges).
- **Test** — `test/bob_auto_junk_mode.test.js` really runs the mode's `update()` with a fake agent/bot and asserts the excess `clay_ball` is tossed far from home and that nothing is tossed at the claim centre/bed.
- **Docs** — the stale "autoJunk is not yet wired" lines in both docs are corrected.
- Tests: `test/bob_auto_junk_mode.test.js` **2/2**, `test/bob_chest_deposit.test.js` 4/4. Full `npm test` on Node 22: **262/263 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session; the shelter refusal only takes effect once the night-shelter branch (#27) merges, since `shelter_state.js` does not exist on this branch yet.

## 2026-10-31 — Fix 4 review: scorecard text-failures, auto-junk wired (TESTED; NOT DEPLOYED)
- Review of PR #30. Same branch, second commit (no force-push).
- **Scorecard** — `bob_scorecard.action_outcome()` now returns `failed` when `result_text_failure` is set or the `result_summary` says "not confirmed" (a call that returned normally but reported failure is no longer counted as succeeded).
- **Auto-junk wired** — a new idle-only `auto_junk` mode calls `survival.autoJunk(bot)` when idle in daylight, with free slots <= 2, and only when away from the house (24 blocks) and protected areas; `BOB_AUTO_JUNK=0` opts out. The docs no longer claim "defined but unwired".
- Tests: `test/bob_scorecard.test.js` **4/4** (new: a text-failed action counts as failed); `test/bob_chest_deposit.test.js` **4/4** (new: the wiring check). Full `npm test` on Node 22: **260/261 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session; the auto_junk mode and the scorecard change have not run against live JSONL in-game.

## 2026-10-31 — Fix 4: chest deposit verification and auto-junk (TESTED; NOT DEPLOYED)
- Report 4.6, work-order item 4. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`. Auto-junk is ON by default; `BOB_AUTO_JUNK=0` opts out.
- **Window count** — `skills.windowItemCount()` counts the player section of the OPEN container window (falling back to `bot.inventory`), and `putInChest`/`takeFromChest` use it before/after, so a real deposit no longer reads as `0/N not confirmed` (mineflayer only reconciles `bot.inventory` on window close).
- **Auto-junk** — `skills.junkPolicy()` (pure) + `autoJunk()`: when free slots <= 2, drop excess `clay_ball` (keep 32), `string` (keep 16), all `big_dripleaf` and flowers, and extra `chest`/`furnace` (keep 1). Never tools, food, logs or planks.
- **Harness** — `bob_eval_harness.noteExecEnd` now records `result_text_failure` for a summary containing `not confirmed`.
- Tests: new `test/bob_chest_deposit.test.js` **3/3**. Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome sets the flag only after a server ok reply` fails.
- UNPROVEN / NOT DONE: no live Minecraft session; `putInChest`/`takeFromChest` end-to-end (real chest window) and auto-junk were not run in-game. `autoJunk` is now wired through the idle daytime `auto_junk` mode (see the entry above).
## 2026-10-31 — Fix 1e round 4: sheltered eating, dimension-change cleanup (report 4.1/4.2) (TESTED; NOT DEPLOYED)
- Review of PR #27. Same branch, fifth commit (no force-push).
- **Eat while sheltered** — the hunger mode's sheltered early-return now sits below both eat branches, so a sealed-in Bob still eats from his inventory but never hunts or runs the food loop; while sheltered it calls `survival.eatBest(bot)` (never `cookOrEat`, which can walk to a furnace the shelter guard forbids).
- **Dimension change** — the night mode's dimension-change path calls `shelter.clearShelter(agent.bot)` so the pathfinder's `canDig` is restored along with the shelter state.
- Tests: `test/bob_shelter_hold.test.js` **6/6** (new: the eat-then-stop order and the dimension-change clear). Full `npm test` on Node 22: **277/278 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session.

## 2026-10-31 — Fix 1e round 3: review fixes (starving Bob never shelters, canDig guard, hold release on death) (TESTED; NOT DEPLOYED)
- Review of PR #27. Same branch, fourth commit (no force-push).
- **Starving Bob never shelters** — `night_shelter.shelterReason()` returns null when `food <= 6` and Bob holds nothing edible, so he is never sealed in with no way to eat; `modes.js` `night` sets `shelterLeftForFood` in `leaveForFood()` and `tryEmergencyShelter()` refuses to re-shelter until `food > 6` or dawn.
- **Hunger stays out of the shelter** — the `hunger` mode returns early while sheltered unless `shouldLeaveEarlyForFood()` (the night mode leaves early instead).
- **canDig guard** — sealing in sets `bot.pathfinder.movements.canDig = false`; `clearShelter(bot)` and `dawnExit` restore it.
- **Hold release on death/respawn** — `modes.releaseNightHold()` drops the night hold immediately (called from the `death`/`spawn` handlers in `agent.js`, which now pass `this.bot` to `clearShelter`).
- Tests: `test/bob_shelter_hold.test.js` **5/5** (new: a starving Bob does not start or re-shelter); `bob_combat_interrupt` 5/5; `bob_night_shelter` 12/12. Full `npm test` on Node 22: **276/277 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session; the canDig guard and hold release need an in-game check.

## 2026-10-31 — Fix 1e round 2: food carve-out, wider hold, lifecycle cleanup (TESTED; NOT DEPLOYED)
- Amends the Fix 1e entry below — same draft PR (#27), third commit, same branch. Review round 2.
- **Food carve-out (eating is never blocked):** while sheltered, if `food <= 6` and Bob holds no edible item, the shelter ends early — `night_shelter.shouldLeaveEarlyForFood()`; the `night` mode logs `[ai-player] shelter: leaving early for food`, runs the same pack-up (`dawnExit`), releases the hold and resumes self-prompting, so `!getFood` is no longer blocked (his food chest is by the bed at -1143 68 752).
- **Wider hold:** `cowardice` and `ranged_threat` are now skipped while sheltered (like `unstuck`/`item_collecting`), and no pathfinding may dig: `shelterMovements()` forces `canDig = false` and `installShelterMovementGuard()` patches `pf.Movements` (installed in `agent.js` next to the protected-area guard); `escapeMovements` also clears `canDig` while sheltered. `self_defense` still fights only a mob inside the box (range 2).
- **Lifecycle cleanup:** `clearShelter()` is called on `death`, `spawn`, `end` and `kicked` in `agent.js` (a silent no-op when there is no shelter — `spawn` also fires at first login); the `night` tick also clears on a dimension change. The dawn pack-up is never run from those paths.
- **State module:** shelter state moved to a leaf `src/agent/library/shelter_state.js` so movement code can read it without an import cycle; `night_shelter.js` re-exports it.
- Tests: new `test/bob_shelter_hold.test.js` **4/4**; `test/bob_combat_interrupt.test.js` **5/5**; `test/bob_night_shelter.test.js` **12/12**. Full `npm test` on Node 22: **275/276 pass**; only the pre-existing `confirmSetHome sets the flag only after a server ok reply` fails.
- UNPROVEN: no live Minecraft session. The `pf.Movements` patch is a monkey-patch (same pattern as the protected-area guard) and needs an in-game sanity check.

## 2026-10-31 — Fix 1 follow-up: shelter stay-in hold, dawn exit, mob-only attacker stamping (TESTED; NOT DEPLOYED)
- Amends the Fix 1 entry below — same draft PR (#27), second commit, same branch. Four review findings.
- **Stay-in hold:** once `buildShelter` seals Bob in, `night_shelter.js` records the shelter (`markSheltered`) and the `night` mode holds him until dawn — it pauses the self-prompter the same way night-home's hold does, and the `unstuck` and `item_collecting` modes are skipped while sheltered. Travel model commands (`!searchForEntity`, `!collectBlocks`, `!goTo*`, `!getFood`, …) are refused by a new `shelterGuard` wired into `commands/index.js`; eating (`!consume`/`!eat`) is never blocked. `self_preservation` (water/lava/fire) still runs, and `self_defense` only engages a mob actually inside the box (range 2).
- **Dawn exit:** at daytime the `night` mode calls `shelter.dawnExit` — it digs back only the blocks the shelter itself placed (the cell must still hold the same name), refills a dug pocket when a seal block is held, clears the state, releases the hold and resumes self-prompting.
- **Attacker stamping:** `stampLikelyAttacker` now skips starving (food 0), lava/fire/water, and falls, so environmental damage no longer makes Bob treat a nearby neutral mob as its attacker.
- Tests: `test/bob_combat_interrupt.test.js` **5/5**, `test/bob_night_shelter.test.js` **12/12**. Full `npm test` on Node 22: **271/272 pass**; the only failure is the pre-existing `confirmSetHome sets the flag only after a server ok reply`.
- UNPROVEN: still no live Minecraft session. `cowardice`/`ranged_threat` were not in the requested skip list and are unchanged. A starving sheltered Bob with no food in inventory cannot `!getFood` (travel is blocked by design); a starving sheltered Bob holding food can still `!consume`.


## 2026-10-31 — Fix 1: combat interrupt, neutral mobs, emergency night shelter (TESTED; NOT DEPLOYED)
- Report 4.1/4.2, work-order item 1. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`. New behaviour is ON by default with env opt-outs. Not merged, not deployed; live Bob / `.20` untouched.
- **(1a) Interruptible defence** — `src/agent/library/skills.js` `defendSelf()` now checks `bot.interrupt_code || superseded(bot, gen)` right after every await (equip, both `pathfinder.goto` calls, the 500 ms sleep) and calls `bot.pvp.stop()` before returning, so a flee request (self_preservation) is no longer blocked for seconds by an in-progress melee loop.
- **(1b) Clear the goal on interrupt** — `src/agent/agent.js` `requestInterrupt()` also calls `bot.pathfinder.setGoal(null)` (wrapped in try/catch) after `pathfinder.stop()`.
- **(1c) Neutral mobs** — `src/utils/mcdata.js` adds `NEUTRAL_MOBS` and `isAggressiveHostile(mob)` (enderman, zombified_piglin, piglin, wolf, bee, llama, trader_llama, panda, polar_bear, dolphin, goat are threats only for 5 s after they damage Bob), plus `stampLikelyAttacker(bot)`, called from the health handler. `isHostile` is unchanged. `defendSelf` and `self_defense` now use `isAggressiveHostile`.
- **(1d) Unarmed disengage** — `self_defense` (via `survival.selfDefenseTarget`) does not melee when Bob has no sword/axe and health <= 10; self_preservation flees instead.
- **(1e) Emergency night shelter** — new `src/agent/library/night_shelter.js`. At night, with hostiles within 12 blocks or health <= 10, and no verified home bed, it seals up with a held dirt/cobble block or digs a 1x2 pocket. Wired into the `night` mode as a fallback; never breaks or places inside a protected house area or a no-go zone. ON by default; `BOB_NIGHT_SHELTER=0` disables. `BOB_NIGHT_HOME` semantics unchanged.
- Tests: `test/bob_combat_interrupt.test.js` **4/4**, `test/bob_night_shelter.test.js` **5/5**. Full `npm test` on Node 22: **264/265 pass**; the only failure is the pre-existing `confirmSetHome sets the flag only after a server ok reply`.
- UNPROVEN: no live Minecraft session was run. The "who damaged Bob" signal is a heuristic (nearest mob within 6 blocks when health drops), and the shelter's wall-in/dig mechanics need an in-game check.

## 2026-10-31 — Fix 5 round 3: non-blocking probe, cache invalidation (report 4.7) (TESTED; NOT DEPLOYED)
- Review of PR #31. Same branch, second commit (no force-push).
- **Non-blocking probe** — `probePathStatus()` now steps the pathfinder's generator (`bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })`) one tick at a time and `await`s `setImmediate` between steps, instead of calling the synchronous `getPathTo` in a 1.5 s loop that blocked the event loop. `yieldToLoop` is injectable so the test proves the hand-back happens.
- **Cache invalidation** — `bob_home.setActiveHome()` now notifies `onActiveHomeChange()` listeners (only when the home's door/bed/inside actually change), and `protected_area.js` clears `PROTECTED_CACHE` on that signal.
- Tests: `test/bob_nav_probe.test.js` **6/6** (+1 skipped benchmark). Full `npm test` on Node 22: **261/263 pass** (1 fail = pre-existing `confirmSetHome`; 1 skip = the benchmark).
- UNPROVEN: no live session; the probe still needs an in-game check that a long search no longer stalls the heartbeat.

## 2026-10-31 — Fix 5: full pathfinder probe, probe-aware unstuck, protected-area cache (TESTED; NOT DEPLOYED)
- Report 4.7, work-order item 5. Draft PR against `work/bob-home-from-live-20261028`, branched from `697f560`. ON by default; `BOB_NAV_FULL_PROBE=0` restores the old single-shot probe.
- **Full probe** — `skills.readPathProbe()` (via the new exported `probePathStatus()`) keeps asking `getPathTo` while the result is `partial`, up to 1500 ms, so `decidePathStrategy` sees a finished search and can pick the non-destructive route.
- **Probe-aware unstuck** — the `unstuck` mode resets its timer while `skills.isPathProbing()` (a pathfinder search is not "being stuck").
- **Cache** — `protected_area.js` caches `protectedAreaAt` per position+name (bounded, cleared per probe by `clearProtectedCache()`).
- **Benchmark (Step 1)** — `test/bob_nav_probe.test.js` has a skipped-by-default synthetic micro-benchmark (`BOB_NAV_BENCH=1`). Measured here (Node 22, 200k nodes): no hook **335.6M nodes/sec**, `protectedAreaAt` uncached **44.2M nodes/sec**, cached **5.0M nodes/sec**. SYNTHETIC (no live A*), and honestly the Map cache is *slower* here because `protectedAreaAt` returns immediately with no verified house; it only pays off once a verified house makes `protectedAreaAt` do real work. Flagged for the reviewer.
- Tests: new `test/bob_nav_probe.test.js` **5/5 active + 1 skipped benchmark**. Full `npm test` on Node 22: **260/262 pass** (1 fail = pre-existing `confirmSetHome`; 1 skip = the benchmark).
- UNPROVEN: no live Minecraft session; the 1500 ms probe budget and the cache win/loss need an in-game measurement with a verified house.
## 2026-11-01 — Bed protection: never break his own bed (TESTED; NOT DEPLOYED)
- New draft PR `fix/protect-own-bed-20261101` off `work/bob-home-from-live-20261028` (697f560).
- **Guard** — `protected_area.js` gained `ownBedAt(pos, blockName)`: a `*_bed` block within 2 blocks of a known bed is never diggable. `Movements.safeToBreak` returns false and the `bot.dig` wrapper throws `The <block> at x, y, z is your bed; do not break it.`
- **Known beds** — the claim bed at -1144 68 752 (`BOB_BED`), the active home's bed, and the last bed Bob actually slept in (`recordSleptBed`, called after a successful `bot.sleep` in the `modes.js` night mode and in `skills.goToBed`).
- **Opt-out** — ON by default; `BOB_PROTECT_BED=0` disables it (`bedProtectEnabled`).
- Tests: new `test/bob_protect_bed.test.js` **3/3** (incl. `bot.dig` on his bed throwing). Full `npm test` on Node 22: **258/259 pass**; only the pre-existing `confirmSetHome` fails.
- UNPROVEN: no live session; the throw path and the sleep-recording hooks were not run in-game.

## 2026-10-31 — `!searchWiki` follow-up: opensearch ranking + wrapped headings (TESTED; NOT DEPLOYED)
- Amends the entry below — same draft PR, second commit, same branch. Two live-review findings.
- **Ranking:** live `list=search` ranks `diamonds` → **`Achievement`** (wrong article). The resolver now tries `api.php?action=opensearch&search=<q>&limit=1&redirects=resolve&format=json` first and uses its first title; `list=search` is only the fallback, used when opensearch returns no title **or errors out** (an opensearch failure logs a warning and falls back instead of failing the command). Verified live: opensearch → `Diamond`; `list=search` → `Achievement | Diamond | Diamond Ore`. Both calls keep the 10 s timeout.
- **Intro cutoff:** live pages wrap headings as `<div class="mw-heading mw-heading2"><h2 id="Obtaining">Obtaining</h2></div>`, so the old "stop at a direct `h1`–`h6` child" check never fired and post-heading body text leaked into the intro. The loop now also stops on a direct child carrying the `mw-heading` class.
- **Cap:** the `Sections:` line is reserved (capped at `max/4`) before the intro is trimmed, so a long article can no longer have its section list cut off by the ~2000 character cap.
- Tests: `test/wiki_search.test.js` **15/15** (adds: opensearch hit wins with no `list=search` call; empty opensearch falls back; opensearch error falls back; wrapped-heading fixtures; body text after a wrapped heading stays out of the intro; `Sections:` survives on a 9000-character article). Full `npm test` on Node 22: **255/256 pass, 1 fail** — only the pre-existing `confirmSetHome` failure. Live end-to-end run: 626-character summary for `diamonds`, sections line present; an unknown query returns the short not-found message.
- Still a draft PR against `work/bob-home-from-live-20261028`. Not merged, not deployed. Live Bob / `.20` untouched.

## 2026-10-31 — `!searchWiki` uses the wiki search API (TESTED; NOT DEPLOYED)
- Draft PR against `work/bob-home-from-live-20261028` (never main/develop), branched from `8640167` — the live-sync merge from PR #24. Do not merge, do not force-push.
- `!searchWiki` used to guess a URL from the raw query (`https://minecraft.wiki/w/<query>`) and return the entire article text. It now calls the search API (`action=query&list=search`) first, takes the **top hit**, fetches that page, and returns a summary capped at ~2000 characters: title + intro paragraphs + the `h2`/`h3` section headings. `table`/`.navbox`/`.mw-editsection`/`sup.reference` noise is stripped.
- 10 s timeout (`AbortSignal.timeout(10000)`) on both requests. No hits → short `"<query> was not found on the Minecraft Wiki…"` message and **no** page fetch. Timeout or HTTP error → short "could not be reached" message; the command never throws.
- Helpers are exported from `src/agent/commands/queries.js` (`fetchWikiTopHit`, `buildWikiSummary`, `searchWiki`, plus `WIKI_SEARCH_TIMEOUT_MS` / `WIKI_SUMMARY_MAX_CHARS`) so tests inject a fake `fetch` and never hit the network. Note: `queries.js` and `commands/index.js` import each other, so a test must import `commands/index.js` first.
- Tests: `test/wiki_search.test.js` **11/11**. Full `npm test` on Node 22: **251/252 pass, 1 fail**; the only failure is the pre-existing `confirmSetHome sets the flag only after a server ok reply`, which already failed on the base `8640167` (documented by PR #24). No in-game validation.
- Nothing on the live Bob tree / `.20` is touched. No gameplay, navigation, home, claim or prompt-shape change.

## 2026-10-31 — Survival guard must not block eating (TESTED; NOT DEPLOYED)
- Randy: "why the hell are we blocking him eating.. fix that now." `criticalSurvivalGuard` was refusing `!searchForEntity` sheep/cow (top blocker). Food, hunt, crop search, food-drop collect, chest take, bed/home, sleep, flee, and defend are now allowed. Mining/building/long trips still blocked. If food is already in inventory the guard steers `!consume("item")` instead of a bare refuse. Guard/survival strings are not recorded as failures or goal-circuit trips. Patch: `docs/deploy/bob-survival-eat-guard.patch`. Does not use the abandoned hilltop.

## 2026-10-31 — World-state goal verifier (TESTED; NOT DEPLOYED)
- Same draft PR #22. `src/agent/library/bob_goal_verifier.js` is on whenever `BOB_EVAL_HARNESS_LOG` is set. Opt out with `BOB_EVAL_GOAL_VERIFIER=0` (stub). Snapshots at exec_start/goal_change and exec_end/turn_end; verdicts `met|not_met|progress|unevaluated` from inventory/position/food, never from `task.finished`. Scorecard reports met rate and exec-succeeded-but-not_met gap. Incremental live patch: `docs/deploy/bob-eval-goal-verifier.patch`. No gameplay change.

## 2026-10-31 — Weekly eval scorecard script (TESTED; NOT DEPLOYED)
- Same draft PR #22. `scripts/bob_scorecard.py` (Python 3 stdlib) reads `BOB_EVAL_HARNESS_LOG`, writes `~/BobRuntime/logs/scorecards/scorecard-YYYY-MM-DD.md` + `.json`, optional Discord POST from a 0600 webhook file. LaunchAgent example `scripts/launchd/org.newearth.bob-scorecard.plist.example` (Monday 10:00 local). No harness/agent behavior change. No secrets or real webhooks in the repo. Install steps in `docs/BOB_EVAL_HARNESS.md`.

## 2026-10-31 — Opt-in Bob evaluation JSONL harness (TESTED; NOT DEPLOYED)
- Draft PR against `work/bob-home-from-live-20261028` (not main/develop). Off unless `BOB_EVAL_HARNESS_LOG` is an absolute path, a separate file from V2 receipts. Async queue+stream writer (not `V2EventLog` / `writeSync`). Hooks early-return when disabled: no new awaits on the promptConvo / handleMessage path, no change to prompts, history, timing, commands, guards, or return values.
- Correlates `run_id` / `goal_id` / `turn_id` / `command_id` / `task_id`. Records turn, model (lane + backend/model), parse, inferred guards (including `dropped_by_interrupt`), exec, history appends, and a `goal_check` that is **not** `task.finished` `succeeded`. Raw text and prompts stay out unless extra env flags are set. File mode 0600, size cap, self-disable on repeated errors.
- Randy (Oct 31 2:56 PM ET): "Make it so" — deploy the harness onto live. This agent does not deploy; the Mac bot does. `src/agent/agent.js` on this PR is now the exact live file (HomeRegistry, HomesteadTracker, `maybeSetEssentialsHome`) plus harness hooks only. Secret-scanned; no keys/Discord IDs. Harness does **not** touch live-divergent `commands/actions.js` or `bob_goal_circuit.js`. Deploy patch: `docs/deploy/bob-eval-harness-live.patch` (apply `-p1` onto live / branch+live `agent.js`). File list: `docs/deploy/bob-eval-harness-FILES.md`.

## 2026-10-28 — Claim-first autonomous homestead design (IN PROGRESS; NOT DEPLOYABLE)
- Randy chose a full 128x128 claim centered at X=-1144, Z=752; Bob must build his own home, without preassigned door/bed/house coordinates. The old hilltop is to be removed from active prompts and memory, not retained as a destination.
- Added `src/agent/library/bob_claim.js` with independent property geometry, boundary checks, and a helper that refuses to treat an unverified position as an established home; added `test/bob_claim.test.js`.
- Additional work: long-memory no longer seeds the old fixed house; legacy home recovery requests fail closed; no-go escape no longer falls back to the abandoned home. These changes have not passed integration testing.\n- **This is only a partial implementation.** Existing `bob_home.js`, navigation, protection and memory code still reference the old physical house. Do not deploy this branch or change server claims until those dependencies are refactored, persistence is migrated safely, and tests pass. Claim geometry in bot code does not provide server-enforced grief protection.

## 2026-10-28 — Home consolidation on verified live snapshot (CODED; NOT DEPLOYED)
- Branch: `work/bob-home-from-live-20261028`, based on sanitized live snapshot `a438d10`; PR #19/#20, main and running Mac unchanged.
- Centralized house coordinates, door/porch protection geometry, indoor occupancy bounds, cave escape avoidance center, enclosure probe positions, reset target, diagnostics, and fixed memory places in `bob_home.js` and consumers. Indoor detection remains distinct from the protected area. The bed hint is now `-822 124 569` rather than `-823 124 568`, with the same six-block search radius.
- `home_routes.json` transitions to version 2 with a `home` entrance key when saved. Version-1 data at the unchanged entrance retains its routes; relocation invalidates old waypoints and archives the original file as `home_routes.json.pre-relocation.json` on save. Other saved memory files are not deleted or reset.
- Regression tests now reside in `test/bob_home_geometry.test.js`. `npm test` uses `node --test "test/**/*.test.js"` so the root `zz-lm-test.mjs` embedding probe is not run.
- Developer independently verified earlier HEAD `54d6e4b`: 157/157 tests via unscoped `node --test` (includes unrelated root embedding probe); PR #20 suites remained green, and Bob stayed PID 65846. **The later test relocation, scoped npm test command and documentation commits have not yet been retested.** No live in-game validation or deployment authorization. Keep Bob running unchanged until reviewed.
- Remaining release gate: `npm test` on current branch, review runtime route persistence on a copy of saved data, then explicit deployment approval. No automatic home behavior switches changed.
- 2026-10-28 9:22 AM ET (MM20Bot): fixed `package.json` `test` script quoting (was invalid JSON); retest `npm test` on `.20` (Node 22) PASSED 156/156, 0 fail, 0 skipped; root `zz-lm-test.mjs` not run. Bob untouched (PID 65846).

## 2026-10-28 8:47 AM ET — `snapshot/bob-live-m4-20261028`: sanitized snapshot of live Bob on `.20` (record only; NOT merged, NOT deployed)
- Why: Randy (Oct 28 8:46 AM ET): "publish a snapshot of bobs live code to a separate branch, excluding credentials, private runtime data, and logs. Then I can finish against that exact baseline."
- Source: Randy's Mac mini `.20`, `~/BobRuntime/cutover/mindcraft-m4` (not a git checkout), read-only tarball taken 2026-10-28 8:47 AM ET (sha256 `b1ea61c8c3abce8464f5685fa33770bb08d90de3c6859437ac284f55edeaf98b`). Bob was not stopped, restarted or signalled.
- Base: `3d6bd38` (PR #19 head = draft PR #20's base). The sanitized live tree was overlaid on it; only added/modified files, no deletions.
- Contents vs `3d6bd38`: the reconciled PR #20 deployed live Oct 27 7:00 PM ET: `src/agent/library/stuck_home.js`, `src/agent/modes.js`, `src/agent/library/ai_player_nav.js`, `src/agent/library/reset_recovery.js`, `src/agent/library/no_go_zones.js`, `test/bob_stuck_home.test.js`, new `test/bob_pr20_independent.test.js`, `test/bob_pr20_navigation.test.js`. Automatic home behavior is opt-in only: stuck-home auto teleport (`run/stuck-home.config.json` `"auto": true` or `BOB_STUCK_HOME_AUTO=1`), night-home (`BOB_NIGHT_HOME=1`), unstuck walk-home (`BOB_UNSTUCK_HOME`). Manual `tphome`/home requests are unchanged. Every other tracked file already matched live byte-for-byte.
- Excluded (credentials, private runtime data, logs, ops material per AGENTS.md): `node_modules/` (symlink), `keys.json`, any key/pem/env/token/secret/credential files (none others found), `bots/MineBobNE/` (memory, histories, lessons, places, failures, skills, home_routes, stuck_home state, last_profile, screenshots, action-code, all `.bak`/`.before-*`/`.pre-autonomy*` copies), `logs/` (incl. >5 MB `mindcraft.log`), `cache/`, `run/` entirely (`bob-mode.*`, `stuck-home.config.json`, `recovery-inbox/`; ops scripts `run/bob-m4-ctl` and `run/guarded-start.py` belong in private `geekdadteach/minebob`), `andy_quota_ledger.json`, `M4_CUTOVER_STATUS.json` (memory snapshot metadata), `*.bak-20261026-nodistance` backups of `stuck_home.js` and its test. Live `docs/AI_HANDOFF.md`/`docs/AI_CHANGELOG.md` are older copies; the repo versions were kept and updated.
- Repo-only files absent from live, kept (not runtime files, never deployed): `.github/workflows/bob-nav.yml`, `scripts/bob_autonomy_live_audit.py`, `test/test_bob_launchd_safety.py`.
- Secret scan: grep for key/token/webhook/private-key/Discord-token/ID patterns on the staged diff found nothing; gitleaks 8.28.0 on the staged diff and on the full sanitized tree: no leaks. No player chat logs or memory included.
- Tests on the box (Node 20.19.2, `npm ci`): `node --test test/` 152/152 pass (matches live 152/152).
- Status: Coded (record only). Not merged, not deployed anywhere; `.20` is unchanged. Finish further work against this branch.

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

## 2026-10-27 follow-up — guarded husbandry and farm ownership (CODED, NOT DEPLOYED)
- `!breedAnimals` is available as a model-selected gameplay action; the breeding routine requires health, food, feed reserves and an eligible adult pair. No periodic automatic breeding scheduler was added.
- Crop harvest and replant now FAIL CLOSED unless `BOB_FARM_ENABLED=true` and all four reviewed plot bounds `BOB_FARM_X1`, `BOB_FARM_X2`, `BOB_FARM_Z1`, `BOB_FARM_Z2` are set. Plot must be at most 33x33 blocks, near Bob's base and outside code-protected areas. Do not enable without confirming land ownership on NewEarth.
- Public operations scripts and migration test removed from PR #19; private `minebob` feature branch contains these plus private preflight tests.
- Current HEAD is NOT verified on MM20. Do not deploy until full preflight, game telemetry format, rollback and actual protected farm plot are reviewed. Live unchanged.

## 2026-10-27 — MM20 preflight correction (not yet rerun)
- MM20 preflight at f5fdd52: 141/147 passed; six failures exclusively referenced two ops tests whose scripts moved private. Relocated `test/bob_autonomy_deploy_preflight.test.js` and `test/bob_state_snapshot.test.js` to minebob private branch; next MM20 preflight required.

## 2026-10-31 — git now mirrors live .20 (pending merge of sync/live-to-git-20261031)
After this PR merges, `work/bob-home-from-live-20261028` runtime code (src/, profiles) matches Bob's live tree on .20 byte for byte. Live code lane: Gemini `gemini-3.8-flash` (key in live keys.json only, never in git). Known pre-existing failing test: `confirmSetHome sets the flag only after a server ok reply` (bob_stuck_home.test.js).
