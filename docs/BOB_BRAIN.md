# Bob Brain client

Optional advisory link from Bob to a Bob Brain job queue on the same machine. It is **off unless configured**. The queue does not control Bob: a finished job is a suggestion in Bob's prompt, and Bob does not run commands from it.

`review` means the model finished an analysis. It does not mean Bob did the work.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOB_BRAIN_TOKEN_FILE` | yes, to enable | Path to a private token file. Unset disables the client. |
| `BOB_BRAIN_URL` | no | Queue base URL. Default `http://127.0.0.1:8765`. Must be loopback (`127.0.0.1`, `localhost`, or `::1`) with no path, query, or credentials. |

The token file must be a regular file (not a symlink), mode `600` (no group or world bits), and the token must be 32–512 characters with no whitespace. A bad file disables the client and logs a warning. The token is never logged.

Startup logs either `[bob-brain] enabled url=http://127.0.0.1:8765` or `[bob-brain] disabled: <reason>`. While enabled, Bob's once-a-minute status line includes counters (`e` events sent/dropped, `j` jobs enqueued, `rev` review, `fail` failed, `err` request errors, `adv` advice notes).

## Enable on the host

Bob Brain must already be listening on that host. Do not put the token in this repo. Replace `/path/to/bob-brain.token` with the host path you keep outside the checkout.

```bash
curl -fsS http://127.0.0.1:8765/health
# {"ok": true}

install -m 600 /dev/null /path/to/bob-brain.token
# Write a token of at least 32 characters into that file, then:
stat -c '%a' /path/to/bob-brain.token
# 600
```

Set this only on Bob's process (for example a systemd drop-in), then restart Bob:

```bash
BOB_BRAIN_URL=http://127.0.0.1:8765
BOB_BRAIN_TOKEN_FILE=/path/to/bob-brain.token
```

The log should show `[bob-brain] enabled` and `[bob-brain] health ok`. If the file is missing, too open, or too short, Bob still joins the game and the log shows `[bob-brain] disabled`.

## What it sends

Events go to `POST /v1/events` (`source` is `mindcraft`). Jobs go to `POST /v1/jobs` with a stable `client_key` and a cooldown.

- Death (cause and position) sends an event and a `failure_analysis` job.
- Stuck or failed actions (the existing failure recorder, including the unstuck mode) and pathfinding failures (`noPath`, `timeout`, pathfinder `stuck`, dig/place errors) send events. The same kind enqueues one `failure_analysis` job after it happens again, then waits out a cooldown.
- A build-style goal (`!goal` / self-prompt) sends `goal_set` and, when the text looks like building, a `plan` job `{objective, footprint:{width, depth}}`. A size in the text (`6x4`, `3 by 9`, `8 wide ... 10 deep`) is used, clamped to 1..32. If there is no size, the footprint is 5 by 5. Other goals are not planned. `goal_cleared` is an event only.
- Health from 1 to 6 sends one `low_health` event until health is at least 10 again.

Network calls time out quickly. If the queue is down, returns an error, or sends bad JSON, Bob logs at most one warning per minute and keeps playing.

## Advice

Bob polls only the jobs this process enqueued. On `review`, a short note is added to the conversation prompt, which is the prompt that contains `$LONG_MEMORY`. Memory-saving and coding prompts do not receive it.

`Bob Brain suggestion (unverified): ...`

A review result from the worker looks like `{summary?, proposal, validation:{valid, issues}, finish_reason, review_required, world_action_taken, memory_applied}`.

- When `summary` is a plain string, that string is the note.
- Otherwise a plan note lists footprint (`6x4`), wall height, material counts, and stage titles.
- A failure-analysis note lists cause, lesson, and the first two verification steps.
- When `validation.valid` is false, the result is skipped.
- Command text such as `!goal(...)` is stripped. Notes are capped (3 items, 30 minutes, a few hundred characters). Nothing in the note is executed. A `failed` job is logged and not shown.

## Calling it from a script

These methods are public. They post a job and remember it for polling, or they read state. They do not run Minecraft commands.

```javascript
import { BobBrain, resolveBobBrainConfig } from './src/agent/library/bob_brain.js';

const brain = new BobBrain(resolveBobBrainConfig());
await brain.enqueuePlan(
    { objective: 'build a hut', footprint: { width: 6, depth: 4 } },
    { clientKey: 'plan-hut-1', priority: 0 }
);
await brain.enqueueFailureAnalysis(
    { observed_failure: 'no path out of the cave' }
);
brain.status();        // enabled, counters, outstanding_jobs, advice
brain.currentAdvice(); // [{ jobId, kind, text, at }]
brain.adviceBlock();   // the conversation-prompt note, or ''
```

`clientKey` is optional (1–128 characters). When it is omitted, the client sends a stable hash of the payload. `priority` is clamped to -5..5. A disabled client returns `{ok: false, reason: 'disabled'}` and does not open a connection.

## Check the queue

```bash
curl -fsS \
  -H "Authorization: Bearer $(cat /path/to/bob-brain.token)" \
  "http://127.0.0.1:8765/v1/jobs?status=review"
```

That lists the latest review jobs on the queue (the worker can take minutes). Bob's own log line `stored unverified advice` means one of his jobs was copied into the prompt.

## V2 receipts

Bob can append BobBot V2 version-1 JSONL receipts for things only this process can see: whether stored advice text was actually in the finished prompt, and what command or action Bob then ran. This is off unless configured. It does not change prompts, commands, or the queue client.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOB_BRAIN_V2_EVENT_LOG` | yes, to enable | Absolute path of a JSONL file Bob appends. Unset means no file and no receipts. |

A relative path, a path with whitespace, a symlink, or anything that is not a regular file is refused. Bob creates a missing file as mode `0640` (owner read/write, group read). An existing file is used only when it is mode `0640` or `0600`; a looser mode is left untouched. Each receipt is one `write` of a single line shorter than 4096 bytes, opened with append and `O_NOFOLLOW`. The file stops growing at 1 MiB (the last line is not written if it would pass the cap). A disk error, a short write, or a write that takes longer than a quarter second disables further receipts. None of those failures change gameplay. Startup logs `[bob-brain] v2 receipts enabled` only when the variable is set to an absolute path. Unset does not add a log line.

Suggested path, next to the file the brain-side sync appender already writes, but not the same file:

```bash
BOB_BRAIN_V2_EVENT_LOG=/path/to/bob-v2-mindcraft.jsonl
```

On the deployed host, V2 reads one file (`BOBBOT_V2_BRAIN_LOG`) written by a separate sync appender. Point Bob at a different filename in that directory. Do not point both writers at one path. Bob's own append is atomic for a single short line on Linux, but that does not make sharing safe: Bob's size cap only sees its own stat, and this repo does not assume the other appender uses one append-mode write per line or that it never rewrites the file.

V2 currently takes one `BOBBOT_V2_BRAIN_LOG` path. Pointing that at Bob's file shows Bob's receipts and hides the brain appender. Pointing it at the brain file hides Bob's receipts. Reading both is a gap for V2 (a second path, or something that merges the two files).

### What a line proves

Every line is JSON with `version` 1, `source` `mindcraft`, `trace_id`, `type`, and `summary` (at most 700 characters). `event_id` is included when it fits the identifier rule. `trace_id` and `event_id` are 1–80 and 1–128 characters from `A–Z`, `a–z`, `0–9`, `_`, `.`, `:`, and `-`. Queue job ids this client already accepts are valid trace ids. A Bob-local trace id looks like `bob.` plus 16 hex characters. An event id looks like `bob.{boot}.{trace_id}.{type}.{n}` and stays fixed once written. Summaries are written by this code. They do not contain the prompt, the model reply, chat, or the advice sentence.

The private schema file was not readable from this checkout. The rules above are the ones Bob enforces, sized so a brain event id `brain.{job_id}.a{attempt}.{type}` and a job id of up to 80 characters still fit.

| Type | Proves |
| --- | --- |
| `advice_injected` | After the conversation prompt was fully assembled, the exact stored line `- (kind) text` was still in that string, inside the `Bob Brain suggestion (unverified):` block. `trace_id` is the queue job id. `truncated=yes` means only the stored prefix (the existing character cap) was checked, not the worker's full summary. |
| `advice_rejected` | A review was not stored (validation failed, command text stripped it to nothing, or it had no usable text), an older note was dropped because the list is capped, the 900-character suggestion block cut the line, or the finished conversation prompt did not contain the full line. A prompt with no `$LONG_MEMORY` placeholder emits this once per job (`wrong_prompt` in the summary). That is not deletion: a later conversation prompt can still inject the same note. |
| `action_started` | `perform` was called for a real command, or an action runtime started outside a command (a mode or similar). A parsed string, a guard refusal, or chat of the command is not a start. |
| `action_result` | That same `perform` returned or threw, or the action runtime returned. `outcome=finished` means the runtime returned without an exception, interrupt, or timeout. It does not mean the goal succeeded. `outcome=returned` means the command returned text and did not go through the action runtime. The result text is not copied. |

When a model reply runs a command after a conversation prompt that contained one or more injected notes, each note's job id gets its own `action_started` and `action_result`. The summaries share `action_id=aN` and, when there is more than one note, `note=1/2`. That is one command, correlated to each injected job. Any other caller (a player command, BobBot control, a task, a mode) uses a Bob-local trace id. A mode action that runs inside a command does not add a second pair; its runtime flags (`finished`, `failed`, `interrupted`, `timedout`, `threw`) are the command's outcome.

`lesson_applied` and `lesson_outcome` are not written. Lessons are sentences in the conversation prompt, and a new lesson is stored when a command result matches a fixed pattern. Nothing in this repo records that a particular lesson was chosen as the reason for a command, or that a later result confirmed it. Emitting those types would invent a receipt.
