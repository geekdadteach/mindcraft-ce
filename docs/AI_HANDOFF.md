# AI HANDOFF — geekdadteach/mindcraft-ce (NewEarth fork)

## TAKEOVER SNAPSHOT — 2026-11-13 ~11 PM ET (MineBobNE, Grok Bot) — read this first

Written on Randy's order of 13 Nov 2026 that every repo let any AI take over immediately "if grok did not exist". This section is current truth; the 2026-10-24 sections below are history where they disagree. **Public repo:** no secrets, Discord IDs, ops material or home public IPs here. The master takeover document for Bob (hosts, paths, services, accounts, Randy's rules, ownership, open work) is in the private repo **`geekdadteach/minebob` → `docs/AI_HANDOFF.md`**; MineBobNE's personal page is in private `geekdadteach/systems` → `bots/minebobne/HANDOFF.md`.

### What changed since the October snapshot
- **This fork is no longer Bob's runtime.** On **1 Nov 2026** Randy switched Bob (MineBobNE) to **UnionClef** (public fork `geekdadteach/unionclef`, a Fabric 1.21.11 client mod with an MCP tool server) driven by a local driver loop. Mindcraft's LaunchAgent on the Mac mini (.20) was stopped then. **Bob as a whole is OFF since 2 Nov** and stays off until Randy says otherwise.
- Bob's Mindcraft runtime moved LinuxGrok (.60) → Mac mini .20 on 25 Oct 2026; LinuxGrok was **permanently retired** 26 Oct. Model: Andy-4.2 (Air) via LM Studio (on .143, later Leon .144).
- Keep this fork as reference and as a possible fallback; Randy has not decided to delete or revive it. Do not delete branches.

### Branch map (post-Oct-24 work; all public)
| Branch | What |
|---|---|
| `develop` | Fork default; mirrors upstream. Don't change it or the default-branch setting. |
| `newearth/main` | Working line through 24 Oct (`79e8f2b` + docs `4e950cc`). |
| `live-m4-20261026`, `m4-runtime-20261026`, `nav-on-live-20261026` | Record of the live .20 tree after the move (26 Oct). |
| `snapshot/bob-live-m4-20261028` | Sanitized live snapshot from .20 (28 Oct 8:47 AM ET). |
| `work/bob-home-from-live-20261028` | **Latest Mindcraft work line** (~238 commits ahead of `newearth/main`); PRs #22 (eval harness, merge `6689d9e`) and #42 (autonomy/food/bed, merge `9645423`) merged **here**, not into `newearth/main` or `develop`. Head `a4b8788` (1 Nov). |
| `sync/live-to-git-20261031`, `sync/live-to-git-20261101` | Last records of the live .20 Mindcraft tree (`0f637cd`, 1 Nov 6:44 AM ET: LITE Gemini code lane + Leon-patience LM connect/retry). |
| `fix/*-20261031`, `fix/*-20261101`, `feature/*`, `cursor/*`, `chore/*` | Per-PR branches (see PR list). Kept. |
| `fix/bed-reach-shelter-food-20261101` | PR #43 (draft, open): reach a known bed, never eat non-foods, rotate eval log, `!unstuck`, unstick the code lane. Randy: stays a draft. |
| `wip/bob-eval-harness-backup-20261104` | WIP backup of uncommitted eval-harness work from the Grok Bot box, pushed 4 Nov before a planned GitHub rename. **Not reviewed — do not merge.** |

### PR history (#22 → #43, Mindcraft era)
- #22 eval-log harness — deployed to .20 31 Oct (`1deeb66`), later merged into `work/bob-home-from-live-20261028`.
- #23 survival guard (`6971bd3`) — deployed by MM20 31 Oct on Randy's "fix that now".
- #24–#39 — Oct 31 fix series (food loop, chest-deposit verify, combat interrupt/night shelter, consume-edible check, craft planks/starter tools, lessons prune, pathfinder probe, preempt feedback clamp, verifier failure text, searchwiki #25 merged 31 Oct, etc.). Deployment state of each: check the `sync/live-to-git-*` records; individual status **UNVERIFIED** here.
- #40 regen top-up while sheltered — closed. #41 LM retry (transport failures only) — merged 1 Nov. #42 autonomy never off, food stock, known bed, honest shelter — merged into the work branch 1 Nov, **not deployed**. #43 — open draft (above).

### Build / test / run (code only)
- `npm install` then `npm test` (213/213 passed on 28 Oct per commit `db801d0`). Node syntax checks + the GitHub workflows (Bob Brain client tests, BobBot MindServer control tests).
- Running Bob from this code needs: a profile (`profiles/`), `keys.json` (secret, never committed — see `keys.example.json`), ViaProxy in front of NewEarth Paper 26.3 (Mindcraft speaks ≤1.21.6), and the ops wrapper recorded in `minebob`. Only with Randy's OK.

### Randy's rules (short)
Never merge, deploy, force-push or change the default branch without Randy's OK; no secrets/Discord IDs/ops here; document every change here (game code) and in minebob (ops); tell Randy up front about any limit on Bob; no bot monitors Bob or relays status; Bob stays off until Randy says so.

### Who to ask
Bob/this fork → MineBobNE; Mac mini .20 → Randy MM 20; Leon .144 → Leon Mac Mini 143; NewEarth server → Minecraft Server 63; GitHub merges → the GitHub bot; decisions → Randy.

---

## History — 2026-10-24 snapshot (superseded where it disagrees with the takeover section)


**Snapshot:** 2026-10-24 ~12:10 PM ET (GitHub bot docs refresh). Verify repository and live state before changing anything.

Status words, never conflated: **Proposed** → **Coded** → **Tested** → **Merged** → **Deployed** → **Live-verified**. Merged is not Deployed.

## 2026-10-24 — Receipts, rotation, and longer advice (Merged, not deployed)
- PR #8 **Merged** into `newearth/main` at 12:03 PM ET Oct 24 as `79e8f2b`. Both GitHub Actions workflows (Bob Brain client tests, BobBot MindServer control tests) passed on `79e8f2b`.
- Rebased onto `newearth/main` `4398d7a` (PR #10). Optional V2 JSONL receipts stay off unless `BOB_BRAIN_V2_EVENT_LOG` is set. `advice_injected` is written only after the stored line is found in the finished conversation prompt. Optional rotation stays off unless `BOB_BRAIN_V2_ROTATE_LOG=1` (four archives `.1`–`.4`, otherwise the 1 MiB stop). See `docs/BOB_BRAIN.md` and `docs/BOB_V2_RECEIPT_ROTATION.md`.
- Each stored note is capped at 900 characters (`BOB_BRAIN_MAX_ADVICE_CHARS`), cut at a sentence, line, or word, with `…`. The `$LONG_MEMORY` block is capped at 2500 characters (`BOB_BRAIN_MAX_ADVICE_BLOCK_CHARS`) and keeps the newest whole notes. The unverified framing is unchanged.
- **Not deployed.** Receipts, rotation, and the longer advice are Merged in `79e8f2b` but not on the live process. Live Bob is still `4398d7a` (below). GitHub Actions workflows stay; PR #9 (local-only tests) was closed unmerged at 12:03 PM ET.

## Role of this repo
- Home of Bob's **game code** (Mindcraft CE + NewEarth changes). Public.
- The private repo `geekdadteach/minebob` holds ops (scripts, Discord control bot, reset-watcher, systemd units, polkit, Bob Brain queue source), config/profiles, docs, AI handoff rules, and the record of **which commit of this fork is live**.

## Branches
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
- Reported by MineBobNE 60, Oct 24: Bob is running `4398d7a` (PR #10, idempotent client keys) in LITE mode, live since about 11:11–11:12 AM ET Oct 24. The private ops repo records the deploy. Receipts, bounded rotation, and the longer advice caps are not in that process; they are Merged in `79e8f2b` and not deployed.
- Previous live tree was `newearth/main` `dddbaf4`, deployed 2026-10-23. That “live is `dddbaf4`” note is stale.
- The prismarine-chunk guard from PR #3 (`b940ba3`) is in `4398d7a`. A checkout of this commit includes that patch file.
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
