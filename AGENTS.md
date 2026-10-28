# AGENTS.md — rules for every AI agent and human working in this fork

This is `geekdadteach/mindcraft-ce`, a **public** fork of Mindcraft CE. It holds the **game code** for MineBobNE ("Bob"), the bot on Randy's NewEarth family Minecraft server: Mindcraft CE plus NewEarth changes, kept here so upstream updates are easy to pull.

## Read first
1. `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_CHANGELOG.md`, and `NEWEARTH.md` (live snapshot details).
2. `git status`, `git log -5`, branches. Do not assume a branch is what is running; the private ops repo records which fork commit is live.

## PUBLIC REPOSITORY WARNING
- This repo is public by Randy's choice. It already exposes LAN IPs and in-game coordinates.
- **Never commit secrets** (`keys.json`, API keys, tokens, proxy saves), **Discord IDs**, `bots/` memory/histories, logs, or **ops material** (scripts, Discord bots, systemd units, polkit, watchers).
- Ops, config, secrets handling, and the record of which fork commit is live belong in the **private** repo `geekdadteach/minebob`.

## Randy's rules
- Nothing runs on his systems without a GitHub record.
- Read the three AI docs before changes; update `docs/AI_HANDOFF.md` and append `docs/AI_CHANGELOG.md` for every meaningful change.
- Never merge, deploy, force-push or change default branches (`develop` here) without his authorization.
- Repos never contain secrets.
- Document each change in the repo that owns the code (game code: here; ops: minebob) and reflect shared interface changes in the other repo.

## Claim-first homestead (Bob)
Bob no longer lives at the retired hilltop house (`-823 124 568`, door `-820 124 566`, bed `-822 124 569`). Those coordinates are identification-only for migration matching. They are never a navigation, protection, night-home, stuck-home, or reset destination.

Architecture:
- **Claim is property, not a fence and not a house.** The 128×128 (X -1208..-1081, Z 688..815, center -1144, 752) is Bob's land. He may explore outside it. A verified home must sit **inside the claim** and be **Bob-owned** (chosen site within 16 blocks, or a door/bed he placed).
- **Tracker, not a second controller.** `HomesteadTracker` (`bots/<name>/homestead.json`) records `survey → select_site → gather → foundation → shelter → bed → verified_home → improvements`. The 30s timer only observes; it does not build and does not rewrite the file when nothing changed. Andy continues via `!continueHomestead`.
- **Verified home is discovered in the world.** `HomeRegistry` (`bots/<name>/verified_home.json`) accepts a home only after door + bed + roof (+ storage) are present in loaded chunks, on the claim, not the hilltop, and owned as above.
- **`bot.blockAt` requires a Vec3.** prismarine-world calls `pos.floored()`. Use `botGetBlock` / `vec3()` from `src/agent/library/vec3_util.js`. Tests must use `strictBlockAt` so plain `{x,y,z}` objects fail.
- **`/home house` is inert until `/sethome house` at the verified entrance.** Essentials is still the old hilltop until Bob stands within 2 blocks of the verified door and code sends the fixed `/sethome house`. Landing at the hilltop is a failed teleport and clears that flag. PR #20 opt-in switches stay off (`stuck-home.config.json` `"auto"`, `BOB_NIGHT_HOME`, `BOB_UNSTUCK_HOME`).
- **GriefPrevention helper is operator-only.** Inbox kind `claim-property` requires `"approved": true`. It walks to both corners (~180 blocks apart), right-clicks existing surface blocks with a golden shovel, then checks `/claimslist` for those corner **pairs**. Never auto-claim. Plugin context: Paper + GriefPrevention 16.18.7; no WorldGuard; do not use NewEarthRules safe zones.
- **Migration is operator-run, never on bot start.** `node scripts/migrate_bob_home.js --dir bots/MineBobNE` (dry-run). `--apply` requires `--bot-stopped`. Backs up first. Retires/rewrites hilltop routes, places, lessons (including death "stay inside the house", zone "pick work near the homestead", reset `-821 121 571` / `-822 123 561`), and memory. Keeps compact JSON. Tight coordinate regex; a lone `z 570` is not a hit. Do not delete hilltop knowledge from `long_memory` on startup.

Operator rules for this work:
- Do not touch live servers, do not deploy, do not merge, do not auto-claim.
- Draft PRs target `work/bob-home-from-live-20261028`, never `main`.
- Bring that base forward with a **merge**, not a rebase or force-push.
- Creating the 128×128 GP claim still needs Randy's approval.
