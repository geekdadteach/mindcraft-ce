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

This branch's `src/agent/agent.js` is the home-consolidation snapshot: it
imports `HOME` from `bob_home.js` and does not construct `HomeRegistry` /
`HomesteadTracker`. The live tree adds those homestead imports and start-up
wiring (~50 lines). The `handleMessage` model loop itself matches live.

Harness hooks sit in that shared loop, plus `commands/index.js`,
`self_prompter.js`, and `prompter.js` (`_sendObservedModel`). When this PR is
reconciled with live, keep the live homestead block at the top of `agent.js`
and in `start()`, and keep the `handleMessage` / command / self-prompt hooks
from this PR. Do not rebase or force-push this branch onto main/develop.

## What the harness must not do

It does not call `RepeatGuard.check`, `aiPlayerGuard`, `getBotOutputSummary`,
`parseCommandMessage` on shared objects, `checkCooldown`, or Andy send. Those
are stateful or consume quota.
