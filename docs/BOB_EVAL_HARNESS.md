# Bob evaluation harness (opt-in, observe-only)

Isolated JSONL for correlating each step of a model turn. It is **off unless
`BOB_EVAL_HARNESS_LOG` is set to an absolute path**. The file must be distinct
from `BOB_BRAIN_V2_EVENT_LOG` and `BOB_AI_V2_EVENT_LOG`. This writer is not
`V2EventLog` (that one uses `writeSync`).

Status: Coded in this fork; not deployed. Default gameplay is unchanged.

## Enable

On the Bob host only, outside this public repo:

```bash
export BOB_EVAL_HARNESS_LOG=/absolute/private/path/bob-eval.jsonl
# optional: include truncated model text (still never commit the file)
export BOB_EVAL_HARNESS_LOG_RAW=1
# optional: include truncated prompts (long memory / player chat may appear)
export BOB_EVAL_HARNESS_LOG_PROMPTS=1
```

Unset, relative, or a path with spaces disables the harness. When disabled,
every hook returns immediately: no file, no extra awaits, no change to
prompts, history, timing, command selection, guard outcomes, or return values.

The writer is a background queue plus an append stream. Callers never await
it. Errors are swallowed. The file is created mode `0600`. Writes stop at 8
MiB or after three consecutive errors.

Do **not** log into this repository. Do **not** reuse a V2 receipt path.

## JSONL schema

One JSON object per line. Every record has:

| field | meaning |
| --- | --- |
| `ts` | ISO-8601 timestamp |
| `mono_ms` | process monotonic milliseconds |
| `run_id` | one id per process |
| `goal_id` | hash of the self-prompt plus a counter, bumped on start / stop / circuit switch |
| `turn_id` | one id per `handleMessage` loop iteration |
| `command_id` | `turn_id.n` for the n-th command in that turn |
| `task_id` | from a second passive `bob_task_event` listener, or null |
| `type` | event name below |

Event types:

- `goal_change` — self-prompt start, stop, or circuit switch (`prompt_hash` only)
- `turn_start` — source, whether this is a self-prompt, loop index
- `model_response` — lane, backend/model if known, latency, `empty`, `is_model_error`, `text_chars`. Raw text only when `BOB_EVAL_HARNESS_LOG_RAW=1` (truncated). Prompts only when `BOB_EVAL_HARNESS_LOG_PROMPTS=1`
- `parse` — command name from `containsCommand` / already-parsed fields. The harness never calls `parseCommandMessage` on shared objects
- `guard` — `repeat` / `survival` / `stuck` / `failure` / `collect` inferred from the **returned string**, plus `dropped_by_interrupt`. The harness never calls `RepeatGuard.check` or `aiPlayerGuard`
- `exec_start` / `exec_end` — duration, result summary, interrupted, timedout, last task state (labelled as not a goal outcome)
- `history_append` — role, kind, length. Content only with the raw opt-in
- `task_event` — copy of a lifecycle emit, including `task.finished`
- `goal_check` — **separate** world-state verdict (`unevaluated` stub by default)
- `turn_end` — reason (`empty_response`, `model_error`, `dropped_by_interrupt`, `repeat_guard`, `command_returned`, `conversation`, …)

## Goal outcome vs `task.finished`

`task.finished` state `succeeded` only means the action function returned
without throw, interrupt, or timeout. Live logs show `mode:hunger` succeeding
with `Could not find food nearby`. The harness records that state on
`task_event` / `exec_end` / `goal_check.task_finished_state` and always sets
`task_finished_is_not_goal_outcome: true`. `goal_check.verdict` comes from a
pluggable world-state verifier (inventory, position, blocks). The default stub
never returns success.

## Merge with live `agent.js`

`src/agent/agent.js` on this PR **is** the live file (HomeRegistry,
HomesteadTracker, `maybeSetEssentialsHome`) plus harness hooks only. Live
`commands/actions.js` and `bob_goal_circuit.js` still differ from this
branch; the harness does not touch them — leave the live copies in place.

Deploy onto live with `docs/deploy/bob-eval-harness-live.patch` (`patch -p1`).
File list: `docs/deploy/bob-eval-harness-FILES.md`. Do not rebase or
force-push this branch onto main/develop.

## Weekly scorecard

`scripts/bob_scorecard.py` is a **stdlib-only** Python 3 reporter. It does not
change Bob, the harness, or live play. It reads the eval JSONL (and sibling
rotated/capped files), writes a Markdown + JSON scorecard, and can POST a
short summary to Discord.

Aggregates only: runs/restarts, turns, model calls (lane/model, p50/p95,
errors, 429, empty), parse buckets, guards, **action** exec outcomes (never
goal completion), stub `goal_check` verdicts, goal changes, detectable
deaths, lite vs full, top failure patterns, week-over-week deltas. It never
prints raw prompts, replies, chat, player names other than Bob, other-player
coordinates, webhook URLs, or secrets.

### Install on the Mac (MM20)

Copy the script from this checkout. Copy the LaunchAgent template and edit
the four placeholder paths. Create a mode-`0600` webhook file **outside this
repo**. Do not commit the webhook URL.

```bash
# from the mindcraft-ce checkout
install -m 755 scripts/bob_scorecard.py /ABSOLUTE/PATH/TO/mindcraft-ce/scripts/bob_scorecard.py

cp scripts/launchd/org.newearth.bob-scorecard.plist.example \
  ~/Library/LaunchAgents/org.newearth.bob-scorecard.plist
# Edit ProgramArguments: python3, script, --log, eval JSONL, --webhook-file
# Edit StandardOutPath / StandardErrorPath to ~/BobRuntime/logs/bob-scorecard.log
# (launchd does not expand ~; use /Users/YOUR_USER/BobRuntime/logs/bob-scorecard.log)

mkdir -p ~/BobRuntime/logs/scorecards
chmod 700 ~/BobRuntime/logs/scorecards
install -m 600 /dev/null /ABSOLUTE/PATH/TO/scorecard-webhook.url
# Write the Discord webhook URL into that file; keep it mode 600.

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.newearth.bob-scorecard.plist
```

Manual test (no Discord, no files):

```bash
python3 /ABSOLUTE/PATH/TO/mindcraft-ce/scripts/bob_scorecard.py \
  --log /ABSOLUTE/PATH/TO/bob-eval.jsonl \
  --dry-run --no-discord
```

Schedule: Monday 10:00 local (`StartCalendarInterval` weekday 1). Uninstall:

```bash
launchctl bootout gui/$(id -u)/org.newearth.bob-scorecard
rm ~/Library/LaunchAgents/org.newearth.bob-scorecard.plist
```

`--outdir` defaults to `~/BobRuntime/logs/scorecards` (created mode `0700`,
files `0600`). Discord posts only when `BOB_SCORECARD_DISCORD_WEBHOOK` is set
or `--webhook-file` points at a mode-`0600` https URL. A Discord failure still
writes the files and exits 2. No log / empty window writes a short report and
exits 1.

## What the harness must not do

It does not call `RepeatGuard.check`, `aiPlayerGuard`, `getBotOutputSummary`,
`parseCommandMessage` on shared objects, `checkCooldown`, or Andy send. Those
are stateful or consume quota.
