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
