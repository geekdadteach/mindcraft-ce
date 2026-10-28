# Bob home consolidation — developer handoff (2026-10-28)

## Status: INCOMPLETE — NOT DEPLOYABLE

This branch contains an initial source refactor, not a validated home relocation implementation. Do not merge, deploy, or overwrite the live Mac mini installation based on this branch alone.

## Verified live environment (operator read-only diagnostics, Oct 28)
- Running Mindcraft process: Node `main.js` PID 65846, agent PID 65847.
- Working directory: `/Users/test/BobRuntime/cutover/mindcraft-m4`.
- This directory is a deployed copy **without .git**; GitHub cannot establish its exact live diff.
- Live `bob_home.js` contains only base, door, entrance, inside, bed, plateSupport; other modules still have literal coordinates.
- Saved `bots/MineBobNE/home_routes.json` has 5 routes; seed-north counters 15 successes / 119 failures; total recorded counters 30 successes / 220 failures. These are stored counters, not verified independent trips.
- Live `settings.js` selects `profiles/andy-api-lite.json` via legacy `BOB_MODE=lite`. Both current profiles route thinking to LM Studio `http://192.168.1.144:1234/v1` with model ID `andy-4.2`, embeddings to Nomic, and code_model to Andy API `claude-haiku-5.5`. No coding-call success has been verified. Do not change Leon or its independent full/Air swap.
- The legacy Bob Lite/Normal switching cleanup is a **separate project**; do not conflate it with the home move.

## What this branch changes
- Extends `src/agent/library/bob_home.js` with home geometry, exit waypoint/probe cells and seed route.
- Updates `house_bounds.js`, `ai_player_nav.js`, `bob_enclosure.js`, `escape.js`, `home_route.js`, `reset_recovery.js`, `long_memory.js`, `modes.js`, `agent.js` to consume more of `HOME`.
- Edits both `profiles/andy-api*.json` to reduce stale home wording. These edits should be reviewed against the **live** profiles before considering deployment.

## Known blockers
1. **Live reconciliation:** branch diverged from `fix/bob-navigation-controller-conflicts-20261027` (16 commits ahead, 2 behind at comparison). Live files include `pr20-reconciled-20261027` fixes absent from this branch. Obtain a safe snapshot/diff of the live source first; preserve navigation fixes.
2. **Saved routes:** `home_route.js` loads `home_routes.json` and only adds `seed-north` when absent. A relocated home can reuse stale route waypoints. Add home identity/version metadata and invalidate or archive routes on home change, without destroying useful memory.
3. **Indoor detection regression:** branch `ai_player_nav.isInsideHouse()` delegates to `isInsideHouseArea` (protected geometry). Live version uses a tighter x/z/y check. Preserve the indoor-vs-protected-area distinction.
4. **House geometry:** `HOME` still assumes the current house, north-facing doorway, fixed probes/route. A different building footprint/orientation needs explicit geometry and validation.
5. **Escape center:** branch changed escape avoidance center from live x=-821,z=568 to `HOME.base` x=-823,z=568; assess behavior.
6. **Tests:** no full suite or in-game verification has been performed on this branch.
7. **Other references:** inspect persisted places/memory/lessons, player respawn and server-side EssentialsX `/home house` independently; do not silently rewrite them.

## Required completion and acceptance
1. Snapshot live code/config and reconcile against this branch, preserving all working fixes.
2. Make home location/footprint/door orientation single-source, with safe relocation semantics.
3. Distinguish physical indoor test from protected-area geometry.
4. Add versioned home-route invalidation or migration; preserve personality and unrelated memories.
5. Audit runtime references and add relocation/regression tests.
6. Run tests, review diffs, obtain Randy's approval before deployment.
7. After approved deployment, verify navigation, bed access, no-go protection, survival and actual Minecraft behavior. No restart/deploy was performed by this branch.

## Scope
Home consolidation only. Do not touch Leon's LM Studio settings, model switching, or Bob's separate AI-routing cleanup.
