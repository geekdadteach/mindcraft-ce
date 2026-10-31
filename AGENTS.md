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

## Wiki lookups (`!searchWiki`)
- `!searchWiki` resolves which article a query means with **opensearch** first (`https://minecraft.wiki/api.php?action=opensearch&search=<query>&limit=1&redirects=resolve&format=json`), falling back to the `list=search` top hit only when opensearch has no title or errors out. It then fetches that page and returns a summary capped at ~2000 characters (title + intro + key section headings, with the `Sections:` line reserved so the cap cannot cut it off). `table`/`.navbox`/`.mw-editsection`/reference noise is stripped. Live pages wrap headings in `<div class="mw-heading mw-heading2">`, so the intro stops at a direct child that is `h1`–`h6` **or** carries the `mw-heading` class.
- Both requests carry a 10 s timeout. No hits returns a short "not found" message and fetches no page. A timeout or HTTP error returns a short "could not be reached" message; the command never throws.
- Do not restore the old behaviour of guessing `https://minecraft.wiki/w/<query>` from the raw query and dumping the entire article text into the prompt.
