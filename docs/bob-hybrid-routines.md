# Bob + AltoClef-style hybrid routines (pilot)

## Purpose
Keep **one Bob**: Andy/LLM selects goals; the local JavaScript routine
engine handles known multi-step tasks with the existing Mindcraft CE/Mineflayer
skills. Bob Brain continues to supply prompt advice and observe action receipts.
No second Minecraft login, Fabric client, Baritone process, Paper mod, or LinuxGrok
runtime dependency. No code was copied from UnionClef (GPL); this is an
independent implementation of the task-dependency idea used by AltoClef (MIT).

## Current implementation (limited, not general AltoClef support)
- Feature flag: `BOB_ROUTINES_ENABLED=1`. **Default disabled.**
- Registered command: `!obtainItem("oak_planks", 16)` (desired **total** in inventory).
- Supported: `oak_log`, `oak_planks`, `stick`, `crafting_table`.
- Count range: 1..64. Max 12 actions, dependency depth 6, outer ActionManager
  timeout 4 minutes. No hidden retries.
- Reuses `surfaceForWood`, `skills.collectBlock`, `skills.craftRecipe`,
  `world.getInventoryCounts`, `ActionManager`, and existing Brain action receipts.
- Checks observed inventory after **each** gather/craft. Failure to reach the
  target is a *failed* routine, even if the underlying skill returns `true`.
- Cancels between actions when Bob is interrupted or a newer action starts.
  A hung underlying Mineflayer call remains under the existing ActionManager
  stop/timeout handling; the pilot does **not** claim to fix that.
- Routines do not create their own persistence, model calls, or navigation engine.
  Existing no-go/protected-area/pathfinding protections still apply.

## Safe review procedure
1. Keep this feature branch separate from M4 production and PR #14.
2. Review the pure task logic, `actions.js` wiring, and the new CI workflow.
3. Run `node --test test/bob_routines.test.js` and syntax checks.
4. Merge only after CI and code review; merging **does not** enable the command.
5. In an isolated M4 test instance, set `BOB_ROUTINES_ENABLED=1` at startup.
   With spare wood nearby and an unprotected area, test:
   `!obtainItem("oak_planks", 8)`, `!obtainItem("stick", 8)`,
   `!obtainItem("crafting_table", 1)`.
6. Verify inventory, cancellation, NoPath/blocked areas, and actual Brain receipts.
   Tests in Node do not substitute for in-game verification.
7. Disable by omitting/unsetting the flag and restarting the test instance.

## Next phases (NOT implemented)
1. **Planner:** Expand recipe DAG using version-correct Minecraft data,
   tags/substitutions (all log/plank variants), output quantities, inventory
   reservation, and tools. Bound complexity and avoid cycles.
2. **Executor:** Typed routines for mining, gathering drops, smelting,
   safe food, container interactions, shelter/building. Reuse current Bob
   survivability and navigation guards instead of replacing them.
3. **Recovery:** NoPath fail-fast, TTL blacklist, stuck-step escalation,
   safe alternatives, and blocked-goal handoff to Andy. Integrate PR #14 after
   verified deployment, without duplicating navigation logic.
4. **AI control:** Show Andy a compact manifest of available routines; give
   it typed parameters, cost and risk. Andy chooses the goal/routine, reacts
   when exceptions are returned, and can cancel or change goals.
5. **Brain:** Step receipts with routine ID, step ID, observed quantities,
   stop reason and outcome; correlate with prompt and model receipts.
   Do not count proposed plans as observed Minecraft success.
6. **Evaluation:** Compare the same tasks before/after on NewEarth for
   completion rate, deaths, navigation loops, model calls, tokens, elapsed time,
   and recovery. No speed claim without measured results.

### Important boundary
The original AltoClef/UnionClef modules are Java Fabric clients. Their classes
cannot be imported as Node modules. Directly operating UnionClef beside Bob
would require a second client/account and introduce new compatibility,
licensing, and control problems. Do not do that in this pilot.
