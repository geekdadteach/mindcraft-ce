# Bob (MineBobNE) developer report — 2026-10-31

Prepared from a read-only audit of live Bob on Randy's Mac mini (.20). The log window is roughly **1:58 PM – 6:09 PM ET** (EDT, UTC-4) on Oct 31, 2026. The eval harness covers **3:02 PM – 6:08 PM ET**.
Code references are to `geekdadteach/mindcraft-ce` at **697f560** (`work/bob-home-from-live-20261028`). Line numbers were checked against that commit, but they are approximate: re-check them after you pull.

> Status labels used below: **PROVEN** = seen directly in logs and code. **LIKELY** = strong evidence, not reproduced. **UNPROVEN** = a hypothesis you need to confirm before you build a fix on it.

---

## 1. Orientation

### What Bob is
- Bob is a **Mindcraft-CE** AI Minecraft player. His in-game name is **`MineBobNE`**. He plays on Randy's family **NewEarth** Paper server, which runs on the linuxidk box (`.63`).
- Bob **runs only on Randy's Mac mini (.20)**.
- **Model lanes:**
  - Conversation and memory: **andy-4.2** in **LM Studio at `192.168.1.144:1234`**, called through `andy_pool`.
  - Embeddings: **nomic-embed-text-v1.5**.
  - Code lane (`!newAction`): **Google `gemini-3.8-flash`**. This is the `code_model` in `profiles/andy-api.json`. Until ~4:38 PM today the code lane was `claude-haiku-5.5` through the Andy API (see §4.7).

### Repos and trees
| What | Where |
|---|---|
| Public fork | https://github.com/geekdadteach/mindcraft-ce (default branch `develop`) |
| Bob's real branch | `work/bob-home-from-live-20261028`, now at `697f560` (matches live) |
| **Your working checkout (Cline)** | the repo root open in VS Code; all code paths in this report are relative to it |
| Live tree (**do NOT edit**) | `/Users/test/BobRuntime/cutover/mindcraft-m4` |
| Staging (**do NOT touch**; live `node_modules` is a symlink to it) | `/Users/test/BobMigration/staging/mindcraft-ce` |
| Upstream clone (**not the fork**, don't use) | `/Users/test/mindcraft-ce` |
| Private ops repo (ops, secrets handling, record of which commit is live) | `geekdadteach/minebob` |

### Toolchain on .20
```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # Homebrew node 26 is broken (libsimdjson); always use node 22
# from the repo root
npm test                                           # node --test "test/**/*.test.js"
gh auth setup-git --hostname github.com            # once, so git push uses gh auth
git config user.name  "geekdadteach"
git config user.email "geekdadteach@users.noreply.github.com"
```
- **Known pre-existing failure:** `confirmSetHome sets the flag only after a server ok reply` in `test/bob_stuck_home.test.js` (~line 213). The last full run was 255/256. Don't "fix" it as part of unrelated work.
- **Import-cycle gotcha:** `src/agent/commands/queries.js` and `src/agent/commands/index.js` import each other. In any new test, **import `src/agent/commands/index.js` first**, before `queries.js` or `actions.js`, or you get TDZ/undefined errors.
- The shell on .20 is zsh. Prefix ad-hoc log commands with `export LC_ALL=C;`. There is no `rg`; use `grep`, `awk`, or `python3`.

---

## 2. Rules (read before touching anything)

1. Read **`AGENTS.md`**, **`docs/AI_HANDOFF.md`**, **`docs/AI_CHANGELOG.md`** (and `NEWEARTH.md`) first.
2. **Every change** adds a `docs/AI_HANDOFF.md` update and a new top entry in `docs/AI_CHANGELOG.md`. Copy the existing format: Goal / Files / Behavior / Tests / Deploy status / Rollback.
3. **One branch per fix**, cut from `work/bob-home-from-live-20261028`. Open a **draft PR with base `work/bob-home-from-live-20261028`**.
4. **Never** merge, force-push, rebase pushed commits, or use `--no-verify`, and never touch `develop` or `main`.
5. **Public repo:**
   - Never commit keys, tokens, webhooks, Discord IDs, LAN logs, raw logs, or anything from `bots/`.
   - **Secret-scan before every push.** For example: `git diff --cached | grep -nEi 'key|token|secret|webhook|discord|Bearer|sk-|AIza'`, then read every hit.
6. **Stage explicit paths only** (`git add src/... test/... docs/...`). Untracked `validation*.log` files must stay untracked. Never use `git add -A` or `git add .`.
7. **Deploying to live Bob is done only by the MM20 bot, with Randy's OK.** The developer never deploys, restarts, or edits the live tree.
8. Randy's product rules:
   - New features are **ON by default**, with an **env opt-out** (pattern: `BOB_X=0` disables).
   - Bob **never gets op**, and `raw_command` stays disallowed.
   - Bob **stays quiet in chat** (family server; see the CHAT RULES in the profile).
   - **Survival guards must never block eating**, including food search, hunting, and chest withdrawal of food (PR #23).

---

## 3. Where to look (read-only on live is OK)

These are runtime files on Randy's Mac (read-only for you), relative to the live tree `/Users/test/BobRuntime/cutover/mindcraft-m4` unless noted. Code paths elsewhere in this report are repo-relative.

| Source | What it is | Tips |
|---|---|---|
| `logs/mindcraft.log` | Raw console (~189k lines). **Mostly untimestamped**; only some lines carry ISO `Z` timestamps (UTC, so subtract 4 h for ET). | `tail -n 15000` and then grep. Key prefixes: `[ai-player]`, `task-event`, `status pos=`, `Agent executed:`, `Agent died`, `unstuck:`, `nav:`, `food:`. |
| `logs/bob-eval-harness.jsonl` | Structured per-turn events: `turn_start`, `model_response`, `parse`, `exec_start`/`exec_end` (join on `command_id` to get `command_name`), `task_event`, `goal_check` (goal verifier), `guard`, `turn_end`. Each line has a `ts` in UTC. | Best source for rates. Note that `exec_end.task_state='succeeded'` only means the JS function returned; check `result_summary` for failure text. |
| `logs/mindcraft-errors.log` | stderr; a mix of old and current runs; no timestamps. | Good for stack-trace repeats, bad for timing. |
| `bots/MineBobNE/` | `memory.json`, `failures.json`, `lessons.json` (1.3 MB), `skills.json` (empty), `places.json`, `homestead.json`, `last_profile.json` | **Never commit anything from here.** |
| `/Users/test/BobRuntime/logs/scorecards/` | Daily/weekly scorecards (`scorecard-2026-10-31.md`) | |

**Never read or print:**
- `keys.json` or any `*.url` webhook file
- `~/BobRuntime/private` or `~/.config/new-bobbot`
- `viaproxy/saves.json` or plist `.bak` files

If a log line contains a key, token, or webhook, redact it.

---

## 4. Problems, ranked by impact

### 4.1 Bob keeps dying to spiders at night: combat can't be interrupted fast enough, and he has no shelter or weapon
- **Summary:** In about 4 h there were **15 deaths**: 14 to Spiders and 1 to an Enderman. All were at night, near his home and respawn point. When health drops, self_preservation tries to flee. But it has to wait for the in-progress `defendSelf` action to stop, and it often takes several seconds. Bob dies during that wait.
- **Evidence (PROVEN):**
  - `Agent died` ×15 at about 1:58, 2:33, 2:48, 2:55, 3:33, 3:49, ~4:00 (Enderman), 4:16, 4:52, 5:08 ×2, 5:30 ×2, 5:41, and ~6:07 PM ET. These times are approximate: the nearest timestamped line.
  - Game time at death was always between 13812 and 22792 (night). Deaths were around x −1125..−1156, y 67, z 750–756. The respawn point is (−1142, 69, 753), so he respawns among the same spiders. The 5:08 and 5:30 PM pairs were seconds apart.
  - `task.cancel_requested … reason:"superseded_by:mode:self_preservation"` ×68.
  - `waiting for code to finish executing...` ×1,277 in the window. Before a death it typically repeats 10–29 times, which is 3–9 s at 300 ms per poll.
  - `Mode self_defense finished` ×159; `Mode self_preservation finished` ×84. 44 of the self_preservation runs ended in `PathStopped` (death or respawn reset the path: `WorldSync.setColumn → resetPath`).
  - Inventory: no sword, armor, or pickaxe; a bow with **no arrows**.
- **Native vs ours:**
  - Native: the core loop. That includes `defendSelf`, the `self_preservation` "I'm dying" branch, and `action_manager.stop()` polling.
  - Ours: the melee-only filter on `self_defense`, the 10 s abandon in `stop()`, and night-home being opt-in.
- **Root cause:**
  - `src/agent/library/skills.js` → `defendSelf()` (~line 398):
    - It awaits `bot.pathfinder.goto(new GoalFollow(enemy, 3.5), true)` and then `goto(GoalInvert(...))` with errors swallowed.
    - It then **unconditionally calls `bot.pvp.attack(enemy)`** and sleeps 500 ms.
    - It only checks `bot.interrupt_code` at the *end* of each loop iteration (~line 430).
    - So after an interrupt, it can restart pvp (which re-drives the pathfinder) before it notices the interrupt.
  - `src/agent/agent.js` → `requestInterrupt()` (~line 374) calls `pathfinder.stop()`. That stop is *graceful*: it waits for a safe node.
  - `src/agent/action_manager.js` → `stop()` (~line 54) polls every 300 ms and only abandons after 10 s.
  - `src/agent/modes.js` → `self_preservation` (~line 38). The "I'm dying!" branch (~line 92) fires only when `health < 5` or the last hit was at least the current health, and only then calls `moveAway(bot, 20)`. By that point it's too late against several spiders.
  - `src/agent/modes.js` → `self_defense` (~line 283) fights even when unarmed and at low HP. Nothing in it says "don't fight unarmed at night with HP < X; flee or shelter instead."
  - `src/agent/modes.js` → `night` (~line 356) is gated by `nightHomeEnabled()` (~line 598), which needs `BOB_NIGHT_HOME === '1'`. **It is off.** Even when on, it needs a verified home and bed, and Bob has none ("There is no assigned house" in the profile). The prompt asks him to find shelter at night, but no code does it.
- **Suggested fix:**
  1. In `defendSelf`, check `bot.interrupt_code || superseded(bot, gen)` **immediately after every await** (both `goto` calls, `equipHighestAttack`, and the sleep). Return before calling `bot.pvp.attack` again.
  2. In `requestInterrupt`, also call `bot.pathfinder.setGoal(null)`. This makes the stop immediate, the same way `escapeStuck` does in `modes.js` ~line 609.
  3. In `self_defense`, if Bob has no melee weapon and `health <= 10` (or it is night with more than one hostile within 8 blocks), don't engage. Let self_preservation flee, or trigger shelter.
  4. Add an emergency "night shelter" (bury in: dig 2 down, or pillar and wall in with dirt/cobble) that does **not** need a home or bed. Make it **ON by default** with opt-out `BOB_NIGHT_SHELTER=0`.
  5. Raise the self_preservation trigger to `health < 8` while hostiles are within 6 blocks.
- **Acceptance / tests:**
  - Unit test with a fake bot: after `requestInterrupt()` (or a gen bump), `defendSelf` resolves within **≤ 600 ms** and never calls `pvp.attack` again.
  - Unit test: `self_defense.update` does not `execute` when there is no weapon and `health <= 10`.
  - Unit test: the shelter routine places or digs only in non-protected areas (`protected_area.js`) and respects `BOB_NIGHT_SHELTER=0`.
  - Live check after Randy approves a deploy (done by the MM20 bot): over a full night, `Agent died` ≤ 1, and the average run of `waiting for code to finish executing...` before a flee is ≤ 3.
- **Risk:** Medium. Combat changes can make Bob too passive, so he takes hits while fleeing. Shelter digging must never break player builds or claim-protected blocks.
- **Branch:** `fix/combat-interrupt-night-shelter-20261031`

### 4.2 Neutral mobs (Enderman) are treated as hostile: NATIVE (LIKELY)
- **Summary:** The ~4:00 PM ET death was to an Enderman, right after a restart, while `self_defense` was running.
- **Evidence:** `Agent died` (Enderman) at ~4:00 PM ET. The preceding lines show `mode:self_defense` active, then superseded.
- **Native:** `src/utils/mcdata.js` → `isHostile()` (~line 195) returns true for any `type === 'mob' || 'hostile'` except golems. That includes endermen, zombified piglins, wolves, bees, spiders in daylight, and so on.
- **Root cause (LIKELY; the exact provocation was not seen in logs):** `self_defense` attacks an enderman → the enderman retaliates.
- **Fix:** Add `NEUTRAL_MOBS = ['enderman','zombified_piglin','piglin','wolf','bee','iron_golem','snow_golem','llama','trader_llama','panda','polar_bear','dolphin','goat']`. Exclude them in `self_defense` (`modes.js` ~line 291) and in `defendSelf` unless they damaged Bob in the last 5 s (`bot.lastDamageTime` plus nearest-entity heuristics). Keep `isHostile` itself unchanged if other callers depend on it, or add `isAggressiveHostile()`.
- **Tests:** `isAggressiveHostile({name:'enderman',type:'hostile'}) === false`, and `self_defense` ignores an enderman at 3 blocks when there was no recent damage.
- **Risk:** Low.
- **Branch:** same as 4.1 (`fix/combat-interrupt-night-shelter-20261031`) or `fix/neutral-mobs-20261031`.

### 4.3 Food loop: Bob can't feed himself
- **Summary:** Hunger mode and `!getFood` keep searching the same hunted-out area. Hunts that do find an animal fail to bring back food. Bob carries 36 spider eyes, but they never count as food.
- **Evidence (PROVEN):**
  - `!getFood` (harness): 20 runs. 14 returned failure text ("Could not find food nearby (no cow/pig/sheep/... within 64 blocks)"), 5 were cancelled, and 1 was clean. Even the clean one ended "Got food. Food now 4/20, food items in inventory: 0."
  - `!searchForEntity`: 72 runs. 32 were cancelled (27 of them by `unstuck`), 36 returned "Could not find any chicken/rabbit/cow/sheep…", and only 4 found something.
  - Failure memory (console): sheep ×18, chicken ×18, cow ×14, rabbit ×11, pig ×7, plus `!getfood` ×14 and `!getfood stuck` ×3.
  - Console: `food: none found` ×43, `food: hungry and no food` ×23, `food: asked for food … stock=0` ×22 (including at health 1), `food: no safe relocation route found` ×6, and `hunt sheep: animal not killed or drops not collected` 4/4.
  - 5:59–6:06 PM ET: health 5, food falling 16 → 9.
  - Goal verifier: 136 food checks were `not_met`.
- **Native vs ours:**
  - Ours: `hunger` mode (`modes.js` ~line 305), and `survival.js` → `getFood()` (~277), `huntAnimal()` (~207), `edibleFoods()` (~91), and `foodStock()` (~97).
  - Native: `!searchForEntity`, and the `hunting` mode (`modes.js` ~line 448), which is **off** in the profile.
- **Root cause:**
  - `getFood` tries crops → berries → `huntAnimal(24)` → `huntAnimal(64)` around the current spot. When the area is empty it calls `relocateForFood`, which often logs "no safe relocation route".
  - `edibleFoods` excludes everything in auto-eat `bannedFood` (`agent.js` ~line 332: rotten_flesh, **spider_eye**, poisonous_potato, pufferfish, chicken). Only chicken and rotten_flesh are allowed when desperate, so **spider_eye never counts, even at health 1**.
  - The hunt fails to collect drops ("Picked up 1 items. Picked up 0 items." then "food items in inventory: 0"). This is LIKELY the wool being picked up while the mutton was not collected, or the inventory being full (see 4.6). Unproven.
- **Fix:**
  1. Allow `spider_eye` and `rotten_flesh` as **desperation** food when `food <= 6`, or when `health <= 6` with `food < 18`. Eating one spider eye gives Poison for 5 s but restores 2 food, and Bob holds 36.
  2. When food is ≤ 17 and health is < 20, eat to reach ≥ 18 so natural regen works. This is the known "health 5 / food 16" stall; auto-eat `startAt` is 14.
  3. In `getFood`, after 2 failed local searches, **relocate in a ring** of 96–160 blocks in daylight, outside no-go zones. Only then report failure.
  4. After a kill in `huntAnimal`, collect drops: walk to the drop entities within 6 blocks for ~5 s. If the inventory is full, discard junk first (see 4.6).
  5. Consider turning native `hunting` mode ON in the profile.
- **Tests:**
  - `edibleFoods(bot, true)` includes spider_eye; `edibleFoods(bot, false)` doesn't.
  - Hunger mode eats when `food = 16` and `health = 5`.
  - `getFood` calls the relocation path after N empty searches (mock `huntAnimal`).
  - `huntAnimal` returns ok only when a food item count rose.
- **Risk:** Low–medium. The poison effect is brief; relocation can walk Bob into danger, so restrict it to daytime only.
- **Branch:** `fix/food-loop-20261031`

### 4.4 Bob never makes basic tools: a crafting name alias forces oak
- **Summary:** Bob has 20 spruce_log and 9 dark_oak_log but never crafts planks, a crafting table, or wooden tools. He keeps trying `oak_planks`, which needs oak logs he doesn't have.
- **Evidence (PROVEN):**
  - "You do not have the resources to craft a oak_planks. It requires: oak_log: 1." ×2.
  - stone_pickaxe failed: missing cobblestone.
  - Invalid names `grass_planks` and `planks`.
  - Unknown commands `!craftItem` ×2 and `!unstuck` ×2.
  - `!craftRecipe`: 4 runs, 3 failed by text; only sticks worked.
  - Inventory: oak_planks 2, sticks 26, no tools.
- **Native vs ours:**
  - Native: `craftRecipe` (`skills.js` ~line 60) is fine.
  - **Ours:** the name corrector. `src/agent/library/long_memory.js` → `correctName()` (~line 356) has `alias = { planks: 'oak_planks', plank: 'oak_planks', wooden_planks: 'oak_planks', pickaxe: 'wooden_pickaxe', … }` (~line 376). This always maps a generic "planks" to oak, ignoring which logs Bob holds. The `log` branch just above it (~line 365) already picks the held or nearest log type; planks has no equivalent.
  - **Model:** andy-4.2 also invents commands and names.
- **Fix:**
  1. In `correctName`, map `planks/plank/wooden_planks` to `<held_log_type minus _log>_planks`. Use the first `*_log` in inventory, or the existing `bob_wood_types.js` helpers. Fall back to `oak_planks` only when no logs are held.
  2. Add a small **starter-tools** routine, ON by default with opt-out `BOB_STARTER_TOOLS=0`. If there is no pickaxe or sword and Bob has logs: craft planks → crafting_table → sticks → wooden_pickaxe + wooden_sword. Run it from `hunger`-style idle checks in daylight, or expose it as `!craftStarterTools`.
  3. Optional: alias the hallucinated `!craftItem` → `!craftRecipe` and `!unstuck` → `!moveAway 5` in the command parser.
- **Tests:**
  - `correctName(agent,'!craftRecipe','planks','item')` returns `spruce_planks` when the inventory has spruce_log, and `oak_planks` when it has none.
  - The starter-tools routine produces the craft plan in order (mock `craftRecipe`).
- **Risk:** Low.
- **Branch:** `fix/craft-planks-starter-tools-20261031`

### 4.5 Pathfinding is weak, and unstuck fires constantly but only half-works
- **Summary:** Many moves fail to plan a path, or plan slowly. Bob then stands "moving" without progress until `unstuck` interrupts the real task, which happened 70 times.
- **Evidence (PROVEN):**
  - `Timeout: Took to long to decide path to goal!` ×40, mostly from collectBlocks on spruce, dark_oak, and oak logs.
  - `nav: probe inconclusive` ×70, against only `nav: path` ×29 and `nav: noPath` ×5.
  - Probes show `status=partial` after only **~50 visited nodes**.
  - `unstuck: triggered` ×70, **all with `moving=true`**. Breakdown: searchForEntity 27, discard 10, putInChest 5, collectBlocks 4, searchForBlock 4, moveAway 4, hunger 4, item_collecting 4, getFood 2, goToSurface 2, and others.
  - Outcomes: `freed by moveAway` ×33; `could not free in 10s; … nudging` ×35; escalation ×2 (1 reached the sky, 1 failed).
  - Example: stuck at (−1135, 65, 755) and (−1145, 61, 694) with air all around. That's not physically boxed in.
  - `!collectBlocks`: 22 runs, 2 clean, 13 with failure text, 7 cancelled. Goal verifier for collect: not_met 25, met 3.
- **Native vs ours:**
  - Ours: `goToGoal()` in `src/agent/library/skills.js` (~line 1140), `readPathProbe()` (~line 1096), and `decidePathStrategy()` in `src/agent/library/bob_nav_memory.js` (~line 83).
  - Native: mineflayer-pathfinder (patched: `patches/mineflayer-pathfinder+2.4.5.patch`, 246 lines) and mineflayer-collectblock (patched).
  - Ours: the `unstuck` mode (`modes.js` ~line 103, `max_stuck_time: 20`).
- **Root cause:**
  - **PROVEN:** `goToGoal` probes with `bot.pathfinder.getPathTo(movements, goal, 1000)`. In mineflayer-pathfinder, `getPathTo` returns after one compute slice, so `partial` is normal. Nearly every move lands in the "inconclusive → one destructive attempt" branch (~line 1204).
  - **UNPROVEN:** ~50 nodes per slice is far slower than normal. Possible causes:
    1. The `Movements.prototype.safeToBreak` hook in `src/agent/library/protected_area.js` (~line 45). It runs `protectedAreaAt()` for every candidate block.
    2. The pathfinder patch.
    3. Event-loop load. Unlikely: `status` lines show `eld_p99 ≈ 22 ms`.
  - Profile it before you change anything.
  - `unstuck` treats "pathfinder still computing or replanning" as stuck after 20 s (40 s for collectBlocks). It then interrupts tasks that are slowly progressing.
- **Fix:**
  1. In `readPathProbe`, loop `getPathTo` (or call `astar.compute()` repeatedly) until `status !== 'partial'` or about 1–2 s has elapsed. Then the strategy decision is based on a finished probe.
  2. Micro-benchmark `safeToBreak` with and without the protected-area hook. Cache `protectedAreaAt` per block position (keyed `x,y,z`) per path.
  3. In `unstuck`, if `bot.pathfinder.isMoving()` is false but a path is still being computed (`bot.pathfinder.isThinking?.()`), extend the threshold instead of interrupting.
- **Tests:**
  - A fake `getPathTo` that returns `partial` twice and then `success` makes `goToGoal` choose `nonDestructive`.
  - A benchmark test (skipped in CI) logging nodes/sec.
  - `unstuck` does not fire while `isThinking()`.
- **Risk:** Medium. Pathfinder changes affect every movement. Keep the change behind `BOB_NAV_FULL_PROBE=0` as the opt-out.
- **Branch:** `fix/pathfinder-probe-20261031`

### 4.6 `!putInChest` says "deposit not confirmed" (likely false), and the inventory stays clogged
- **Summary:** Deposits report failure, so the model keeps retrying "Time to clear more space!". Meanwhile the inventory is full of junk, which blocks collecting and gathering.
- **Evidence (PROVEN):**
  - `!putInChest`: 27 runs. 21 have failure text in a "succeeded" task, including **≥9 `Chest deposit not confirmed (0/N item)`** at chest (−1143, 68, 752) for clay_ball, stick, flowering_azalea, string, and gunpowder. 6 were cancelled with `SupersededWindowAction: Inventory action was interrupted`.
  - `Inventory full, no place to deposit` blocked collectBlocks and gatherWood (spruce, dark_oak, oak, melon).
  - Inventory includes clay_ball 151, string 64, big_dripleaf 11, chest ×6, and furnace ×4.
- **Native vs ours:**
  - **Ours:** `putInChest()` in `src/agent/library/skills.js` (~line 912; the check is at ~lines 935–946), `takeFromChest()` (~line 953), and `withInventoryWindow()` in `src/agent/library/bob_inventory_window.js`.
  - The harness also scores these as `succeeded`.
- **Root cause (LIKELY, unproven):**
  - `putInChest` counts `bot.inventory.items()` before and after `container.deposit(...)` **while the chest window is still open**.
  - In mineflayer, the player-inventory slots shown in a container window are tracked on the *container window*. `bot.inventory` is reconciled on window close or after a later server sync. So `moved` comes out 0 even when the deposit worked.
  - Confirm this by checking the chest contents (`container.containerItems()`) in a local test, or by reading mineflayer `lib/plugins/inventory.js`.
- **Fix:**
  1. Count with `container.items()` (the player section of the open window) or `container.containerItems()`, before and after the deposit. Or re-count after `window.close()` plus about 250 ms.
  2. Make `takeFromChest` symmetrical.
  3. Add auto-junk handling: when the inventory has ≤ 2 free slots, deposit or discard a configurable junk list (clay_ball beyond 32, string beyond 16, flowers, dripleaf, extra chests and furnaces). ON by default, `BOB_AUTO_JUNK=0` to opt out.
  4. In the harness, map "not confirmed" results to failure (`bob_eval_harness.js`).
- **Tests:**
  - A fake container whose `deposit` updates only the window slots (not `bot.inventory`) must produce "Successfully put …".
  - A fake where nothing moves must produce "not confirmed".
  - The junk policy keeps tools, food, and logs.
- **Risk:** Low–medium. Never discard items from someone else's chest, and never take from chests that aren't Bob's (AGENTS and profile rules).
- **Branch:** `fix/chest-deposit-verify-20261031`

### 4.7 `!newAction` (code lane) has effectively never worked today, and gemini is untested in game
- **Summary:**
  - All 5 code attempts today failed: about 2:00–2:40 PM ET, all "Dig down 2 blocks at my current location".
  - At that time the code lane was `claude-haiku-5.5` through the Andy API, which returned Cloudflare **521** errors.
  - There have been **zero** `!newAction` calls since the switch to gemini-3.8-flash (~4:38 PM ET), so the new lane has never been exercised in game.
- **Evidence (PROVEN):**
  - `Awaiting Andy API response... (model: claude-haiku-5.5` ×20.
  - `Error: Andy API status: 521` ×20, with stack `Coder.generateCode (src/agent/coder.js:53)`.
  - `Agent executed: !newAction and got: Action failed, agent would not write code.` ×5.
  - Two runs were also superseded by modes (self_defense, hunger) and hit `cancel_timeout`.
  - `gemini` appears 0 times in the log window. The errors log also has older `Andy API … temporarily_blocked "This network is temporarily blocked by the safety policy."` ×16 (not in the current window) and `No code block generated. Trying again.` ×27.
- **Uncertain:** `bots/MineBobNE/last_profile.json` (mtime 4:39 PM ET) still shows `code_model: andy / claude-haiku-5.5`, while `profiles/andy-api.json` says `google / gemini-3.8-flash`. **UNPROVEN** which code model the current process (started 6:10 PM ET) loaded.
- **Native vs ours:** `!newAction` and `src/agent/coder.js` are native; the model choice and profile are ours.
- **Fix:**
  1. At startup, log the resolved `code_model` (api + model name only, **never the key**).
  2. Add a smoke test that builds the Coder prompt with a stubbed model and checks that a code block parses.
  3. With Randy's OK, have the MM20 bot run one controlled `!newAction` in game.
  4. Make the "dig down 2" style request a native skill call, so it doesn't need code generation at all.
- **Tests:** a unit test that the profile loader selects `google/gemini-3.8-flash` from `profiles/andy-api.json`, and a coder test with a fake model returning a valid block.
- **Risk:** Low.
- **Branch:** `chore/code-lane-startup-log-20261031`

### 4.8 Model turns wasted: preempted, dropped, or bad commands
- **Summary:** About 40% of turns don't produce a useful command.
- **Evidence (harness `turn_end` reasons):**
  - command_returned 175, command_undefined 68 (a mode preempted the action), dropped_by_interrupt 46, model_error 10, repeat_guard 8, empty_response 5, unknown_command 4.
  - Guards fired: dropped_by_interrupt 46, failure 19, survival 13, repeat 8, stuck 1, collect 1.
  - Repeat-guard blocks: `!searchForEntity` ×6; `!stop`, `!goToRememberedPlace`, `!getFood`, `!gatherWood`, `!discard`, `!attack` ×1 each.
  - Bad params: `!goToCoordinates` with 3 args, `!consume` with 2 args, `search_range` 512 (out of range), block `any_log`.
- **Native vs ours:** the self-prompter loop is native; the guards and harness are ours (`repeat_guard.js`, `failures.js`, `bob_survival_gate.js`).
- **Fix:**
  - When a mode preempts an action, return a short result to the model ("interrupted by self_defense; re-plan"). Today the turn ends with `command_undefined`.
  - Have `correctName` map `any_log` to the held or nearest log.
  - Clamp `search_range` to the allowed max instead of rejecting it.
- **Tests:** command param clamping, and a preempted-action message in history.
- **Risk:** Low.
- **Branch:** `fix/preempt-feedback-param-clamp-20261031`

### 4.9 `!consume` times out on non-food
- **Evidence:** `Error: Promise timed out` ×2 while trying to eat **raw_copper**; "You do not have any mutton" ×1; spider_eye consumed ×1.
- **Native:** `consume()` in `skills.js` (~line 999) equips and calls `bot.consume()` without checking that the item is edible.
- **Fix:** reject items not in `bot.registry.foodsByName` with a clear message.
- **Test:** `consume(bot,'raw_copper')` returns false fast with "not edible".
- **Risk:** Very low.
- **Branch:** `fix/consume-edible-check-20261031`

### 4.10 Protocol read errors on entity metadata (UNPROVEN impact)
- **Evidence:** `PartialReadError: Read error for undefined : Unexpected buffer end while reading VarInt` (packet_entity_metadata) ×30 in the window.
- **Code:** `src/utils/mcdata.js` (~lines 135–146) suppresses these for "non-critical packets".
- **Root cause (UNPROVEN):** a version mismatch between mineflayer/minecraft-data and the server through ViaProxy. It *might* drop entity metadata, for example baby flags (`isHuntable` checks `metadata[16]`, `mcdata.js` ~line 192). That could feed the "no animals found" problem.
- **Fix:** log the packet version and entity type on suppression, and compare with the server version. Align the mineflayer/minecraft-data versions only through a separate, carefully tested PR.
- **Risk:** Medium (dependency bump).
- **Branch:** `chore/entity-metadata-readerror-diag-20261031`

### 4.11 The goal verifier and scorecard can't be trusted yet
- **Evidence:**
  - 245 goal checks: food not_met 136, collect not_met 25 vs met 3, and 63 unevaluated.
  - The 3:37 PM ET scorecard showed 47/47 checks `unevaluated` (world_state_stub).
  - Commands with failure text are counted as `succeeded`.
- **Ours:** `src/agent/library/bob_goal_verifier.js`; for example, food `not_met` is at ~line 592 and the unevaluated paths are at ~lines 503–539. Also `bob_eval_harness.js` and `scripts/bob_scorecard.py`.
- **Fix:**
  - Make sure snapshots are taken (the "Need before and after snapshots" cases).
  - Add a `result_text_failure` flag in `exec_end` using a shared failure-phrase list.
  - In the scorecard, report "task returned" separately from "goal met".
- **Risk:** Low (reporting only).
- **Branch:** `fix/verifier-failure-text-20261031`

### 4.12 Model/infra noise (mostly resolved, keep an eye on it)
- LM Studio was unreachable at **4:47:48–4:48:17 PM ET**, causing 11 model errors (10 conversation, 1 memory).
- Latency: conversation p50 15.7 s / p95 19.6 s over 317 calls; memory p50 6.1 s over 139 calls.
- One `Andy rate-limit wait 75s`.
- Harness turn gaps over 3 min: 3:12 PM (4.0 min), 5:00 PM (5.1 min), 5:20 PM (3.1 min) ET.
- Old items in `mindcraft-errors.log` that are **not** in the current window: 498 `Start blocked: ConnectionRefused`, 114 `mode self_defense action ran over Ns`, and "server version unsupported" ×15.
- **No action needed**, apart from considering a shorter conversation context to cut latency.

### 4.13 Learned-skill library empty; lessons and memory bloated or wrong
- **Evidence:**
  - `bots/MineBobNE/skills.json` is `{"version":1,"skills":[]}`, and `learned_skills/` is empty.
  - `lessons.json` and `lessons.json.bak` are both 1.3 MB and identical.
  - `memory.json` claims "Learned to avoid spiders via !moveAway(64)", which is false given the deaths.
- **Ours:** `src/agent/library/skill_library.js` and `long_memory.js`.
- **Fix:**
  - Cap and prune lessons (by age and count).
  - Only write "learned X" to memory when the verifier says `met`.
  - Document why no skills get saved: likely because `!newAction` never succeeded (4.7).
- **Risk:** Low. **Never commit `bots/` content.**
- **Branch:** `fix/lessons-prune-20261031`

---

## 5. Suggested work order

1. **4.1 + 4.2** combat interrupt, neutral mobs, and night shelter (default ON). This stops the deaths, which reset the inventory and progress.
2. **4.3** food loop, including the eat-to-18 regen fix.
3. **4.4** planks alias and starter tools. A sword and pickaxe also help 4.1.
4. **4.6** chest deposit check and auto-junk.
5. **4.5** pathfinder probe and unstuck tuning. Profile first.
6. **4.7** code-lane startup log and smoke test.
7. Then **4.9 → 4.8 → 4.11 → 4.13 → 4.10**.

Each one gets its own branch and draft PR (base `work/bob-home-from-live-20261028`), plus handoff and changelog entries. **The developer does not deploy.** The MM20 bot deploys after Randy approves.

---

## 6. Copy-paste prompts for Cline

> Prefix each prompt with this context:
> "Repo: this repo (fork geekdadteach/mindcraft-ce); all paths are repo-relative. First read AGENTS.md, docs/AI_HANDOFF.md, docs/AI_CHANGELOG.md, NEWEARTH.md. Use `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Create the branch from `work/bob-home-from-live-20261028`. Do NOT touch /Users/test/BobRuntime/cutover/mindcraft-m4, /Users/test/BobMigration/staging, bots/, logs, keys, or any secrets. New behaviour ON by default with an env opt-out. In tests import src/agent/commands/index.js before queries.js. Run `npm test`; the only allowed failure is the pre-existing confirmSetHome test. Add a docs/AI_HANDOFF.md update and a top docs/AI_CHANGELOG.md entry. Stage explicit paths only, secret-scan `git diff --cached`, commit as geekdadteach <geekdadteach@users.noreply.github.com>, push, and open a DRAFT PR with base work/bob-home-from-live-20261028. Never merge, force-push, rebase pushed commits, use --no-verify, or deploy."

**Fix 1: combat interrupt, neutral mobs, night shelter**
```
Branch fix/combat-interrupt-night-shelter-20261031.
(a) In src/agent/library/skills.js defendSelf() (~line 398), check `bot.interrupt_code || superseded(bot, gen)` right after every await (equipHighestAttack, both pathfinder.goto calls, the 500 ms sleep) and return false before calling bot.pvp.attack again; call bot.pvp.stop() on exit.
(b) In src/agent/agent.js requestInterrupt() (~line 374) also call bot.pathfinder.setGoal(null) after pathfinder.stop() (wrapped in try/catch).
(c) Add isAggressiveHostile(mob) in src/utils/mcdata.js that excludes neutral mobs (enderman, zombified_piglin, piglin, wolf, bee, llama, trader_llama, panda, polar_bear, dolphin, goat) unless they damaged the bot in the last 5 s; use it in modes.js self_defense (~line 283) and defendSelf. Keep isHostile unchanged.
(d) In modes.js self_defense: do not engage when the bot has no sword/axe and health <= 10; let self_preservation handle it.
(e) Add an emergency night shelter (new module src/agent/library/night_shelter.js): at night with hostiles within 12 blocks or health <= 10, and no verified home bed, dig a 1x2 pocket down or wall in with held dirt/cobble, never breaking blocks inside protected areas (src/agent/library/protected_area.js) or no-go zones (no_go_zones.js). Wire it into the existing `night` mode (modes.js ~line 356) as a fallback when no home exists. ON by default; BOB_NIGHT_SHELTER=0 disables. Do not change BOB_NIGHT_HOME semantics.
Tests: defendSelf resolves within 600 ms of interrupt and does not call pvp.attack again; self_defense ignores enderman; no engagement when unarmed at health 8; shelter respects protected areas and the env opt-out.
```

**Fix 2: food loop**
```
Branch fix/food-loop-20261031.
In src/agent/library/survival.js: (a) edibleFoods() (~line 91): when desperate (food <= 6 OR bot.health <= 6), also allow spider_eye and rotten_flesh. (b) hunger mode in src/agent/modes.js (~line 305): when health < 20 and food < 18 and edible food exists, eat (natural regen needs food >= 18), even though auto-eat startAt is 14. (c) getFood() (~line 277): after 2 consecutive empty local searches, relocate in daylight to a ring 96–160 blocks away outside no-go zones, then retry huntAnimal(64); report failure only after that. (d) huntAnimal() (~line 207): after the kill, walk to item entities within 6 blocks for up to 5 s and return ok only if a food item count rose. ON by default; BOB_FOOD_RELOCATE=0 opt-out for (c). Never let any survival guard block eating.
Tests: edibleFoods desperate includes spider_eye; hunger eats at food 16/health 5; getFood calls relocation after 2 empty searches (mock huntAnimal); huntAnimal ok only when food count increases.
```

**Fix 3: planks alias and starter tools**
```
Branch fix/craft-planks-starter-tools-20261031.
In src/agent/library/long_memory.js correctName() (~line 356; alias map ~line 376), map planks/plank/wooden_planks to `<first held *_log without _log>_planks` (use src/agent/library/bob_wood_types.js helpers), falling back to oak_planks only if no logs. Add a starter-tools routine (new export in src/agent/library/survival.js or a new module) that, when the bot has logs and no pickaxe or sword, crafts planks -> crafting_table -> sticks -> wooden_pickaxe -> wooden_sword using skills.craftRecipe; run it from an idle daytime check, ON by default, BOB_STARTER_TOOLS=0 opt-out. Optionally alias !craftItem -> !craftRecipe in the command parser.
Tests: correctName returns spruce_planks with spruce_log held, oak_planks with none; starter-tools calls craftRecipe in the right order (mocked).
```

**Fix 4: chest deposit verification and auto-junk**
```
Branch fix/chest-deposit-verify-20261031.
In src/agent/library/skills.js putInChest() (~line 912) and takeFromChest() (~line 953), stop counting with bot.inventory.items() while the window is open; count with the open window (container.items() for the player section and/or container.containerItems() for the chest) before and after, or re-count after the window closes plus ~250 ms. First write a test that reproduces the current false "Chest deposit not confirmed (0/N)" with a fake container whose deposit updates only window slots. Add an auto-junk step (ON by default, BOB_AUTO_JUNK=0 opt-out) that, when free slots <= 2, deposits into Bob's own chest (or discards) clay_ball above 32, string above 16, flowers, big_dripleaf, extra chests/furnaces; never tools, food, logs, or planks. In src/agent/library/bob_eval_harness.js mark results containing 'not confirmed' as failures.
Tests: the deposit counts correctly with the fake container; a real non-move is reported as not confirmed; the junk policy keeps essentials.
```

**Fix 5: pathfinder probe and unstuck**
```
Branch fix/pathfinder-probe-20261031.
Step 1 (measure): add a skipped-by-default benchmark test that runs pathfinder A* with and without the Movements.prototype.safeToBreak hook from src/agent/library/protected_area.js (~line 45) and logs nodes/sec. Report numbers in the PR.
Step 2: in src/agent/library/skills.js readPathProbe() (~line 1096) keep computing while status === 'partial' until ~1500 ms total, so goToGoal()'s decidePathStrategy (bob_nav_memory.js ~line 83) sees a finished probe. If the hook is slow, cache protectedAreaAt per block position per path.
Step 3: in modes.js unstuck (~line 103) do not count time while the pathfinder is still computing (isThinking-like check) as stuck.
ON by default; BOB_NAV_FULL_PROBE=0 restores old probing.
Tests: a fake getPathTo returning partial,partial,success leads to nonDestructive; unstuck does not fire while thinking.
```

**Fix 6: code-lane check**
```
Branch chore/code-lane-startup-log-20261031.
At agent startup log the resolved code_model api and model name ONLY (never keys/urls with tokens). Add a test that the profile in profiles/andy-api.json resolves code_model to google/gemini-3.8-flash, and a src/agent/coder.js test with a fake model that returns a valid code block and checks it is parsed and executed in the sandbox. Do not call real APIs in tests. Note in the PR that an in-game !newAction check must be run by the MM20 bot after Randy approves.
```

**Fix 7: smaller items** (one PR each)
```
fix/consume-edible-check-20261031: skills.js consume() (~line 999): reject items not in bot.registry.foodsByName with "X is not edible"; test with raw_copper.
fix/preempt-feedback-param-clamp-20261031: when a mode preempts a model command, append a short system result "interrupted by <mode>; re-plan" instead of ending the turn as command_undefined; clamp out-of-range numeric params (e.g. search_range) to the allowed max; map any_log to the held/nearest log in correctName.
fix/verifier-failure-text-20261031: in bob_eval_harness.js add result_text_failure based on a shared failure-phrase list; scorecard reports "task returned" vs "goal met" separately.
fix/lessons-prune-20261031: cap lessons.json size/age in long_memory.js; only write "learned X" when the verifier says met. Never commit bots/.
chore/entity-metadata-readerror-diag-20261031: in src/utils/mcdata.js (~line 135) include protocol version and entity type in the suppressed PartialReadError log (rate-limited).
```

---

## 7. Command outcomes (harness, 3:02–6:08 PM ET)

"Failure text" means `task_state=succeeded`, but `result_summary` contains Failed / Could not / not confirmed / Don't have / Timeout / stuck / Inventory full. This is a regex heuristic.

| Command | Runs | Clean OK | Failure text | Cancelled | Failed | Effective failure |
|---|---|---|---|---|---|---|
| !searchForEntity | 72 | 4 | 36 | 32 | 0 | 94% |
| !putInChest | 27 | 0 | 21 | 6 | 0 | ~100% (likely over-reported; see 4.6) |
| !searchForBlock | 25 | 20 | 0 | 5 | 0 | 20% |
| !collectBlocks | 22 | 2 | 13 | 7 | 0 | 91% |
| !getFood | 20 | 1 | 14 | 5 | 0 | 95% |
| !attack | 9 | 2 | 3 | 4 | 0 | 78% |
| !goToRememberedPlace | 6 | 1 | 4 | 1 | 0 | 83% |
| !craftRecipe | 4 | 1 | 3 | 0 | 0 | 75% |
| !discard | 4 | 0 | 1 | 3 | 0 | 100% |
| !moveAway | 4 | 1 | 0 | 3 | 0 | 75% |
| !goToSurface | 3 | 2 | 0 | 1 | 0 | 33% |
| !consume | 3 | 1 | 1 | 0 | 1 | 67% |
| !getCraftingPlan | 3 | 2 | 0 | 1 | 0 | 33% |
| !gatherWood | 2 | 0 | 1 | 1 | 0 | 100% |
| !goToCoordinates | 1 | 0 | 0 | 1 | 0 | 100% |
| !newAction | 0 in window; 5 earlier (~2:00–2:40 PM ET) | 0 | — | — | 5 | 100% |

**Repeated errors (console window or errors log):**
- PathStopped: 50 in the console window; 526 "Code execution triggered catch: PathStopped" in the errors log.
- Timeout "Took to long to decide path": 40.
- PartialReadError (VarInt): 30.
- Andy API 521: 20.
- NoPath / unreachable: about 5 in the window, 17 in the errors log.
- "My brain disconnected, try again." model-error replies: 60 in the errors log.
- "No code block generated": 27 in the errors log.

**Modes:**

| Mode | Activity in window | Notes |
|---|---|---|
| self_defense | 159 finishes | Engages unarmed (4.1, 4.2) |
| self_preservation | 84 | Usually too late (4.1) |
| unstuck | 70 | ~50% ineffective (4.5) |
| hunger | 25 | Mostly "none found" (4.3) |
| item_collecting | 13 | Often ends in PathStopped; triggered unstuck 4 times |
| night | Never fires | Custom; `BOB_NIGHT_HOME` unset, and there is no home or bed |
| hunting, torch_placing, elbow_room, cowardice | Never fire | Off in profile |
| idle_staring | On | Harmless |

---

## 8. What works fine
- Command parsing: nearly all model commands are syntactically valid.
- `!searchForBlock` navigation: 20/25 clean.
- Memory summarization runs regularly; embeddings take about 50 ms.
- LM Studio has been stable since 4:48 PM ET.
- `!goToSurface` and the escape-up staircase logic work.
- No abandoned actions in the current run, and no mode over-time stops in the current console window.
- `!craftRecipe stick` works.
- The self-prompter restarts itself reliably (152 normal restarts).
- The survival guard no longer blocks eating (PR #23, live since ~4:14 PM ET). No regression seen.

---

## 9. Caveats
- Console times are approximate (taken from the nearest timestamped line). Harness times are exact; they are stored in UTC and converted to ET here.
- **UNPROVEN:**
  - Cause of the chest-deposit false negative: the window-sync theory (4.6).
  - Cause of slow pathfinder probes (4.5).
  - The Enderman provocation mechanism (4.2).
  - Impact of PartialReadError (4.10).
  - Which code model the 6:10 PM process loaded (4.7).
- The live process was redeployed at ~6:10 PM ET (the `!searchWiki` change). Anything after that is not covered here.
