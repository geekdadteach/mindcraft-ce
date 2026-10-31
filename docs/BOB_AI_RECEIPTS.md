# Bob AI model-call receipts for Discord (opt-in)

This is source-only until an approved Bob-host deployment. The receipts come
from Mindcraft's real model-call wrapper, not the Andy provider's hidden log
or internal reasoning. This feature does not start a model, Bob, or Discord.

## Sources and routing

- Brain: BOBBOT_V2_BRAIN_LOG -> #bob-brain (existing).
- Mindcraft action/advice: BOB_BRAIN_V2_EVENT_LOG producer, same file at
  BOBBOT_V2_MINDCRAFT_LOG receiver -> #bob-activity.
- Model calls observed by Mindcraft: BOB_AI_V2_EVENT_LOG producer,
  same private file at BOBBOT_V2_AI_LOG receiver -> #bob-ai.
- Optional eval JSONL (not a V2 receipt, not tailed by BobBot): 
  BOB_EVAL_HARNESS_LOG. See docs/BOB_EVAL_HARNESS.md.

All of these log files must be DISTINCT, private, and locally readable by their
authorized producer/reader. Never let two writers share a receipt path.

## Mindcraft opt-in settings

BOB_AI_V2_EVENT_LOG=/absolute/private/path/ai-events.jsonl
BOB_AI_V2_ROTATE_LOG=1

BOB_BRAIN_V2_EVENT_LOG=/absolute/private/path/mindcraft-events.jsonl
BOB_BRAIN_V2_ROTATE_LOG=1

BOB_EVAL_HARNESS_LOG=/absolute/private/path/bob-eval.jsonl

Each log path is optional; unset means disabled. Enabled writers are
independent. The eval harness uses its own async writer; do not point it at a
V2 file. Rotating files keep up to four numbered archives. The active
writer otherwise stops at its 1 MiB cap. The existing security policy
rejects unsafe file modes and symlinked files. BobBot also rejects symlinked
parent directories (prefer a real path under the user's home on macOS).

## Meaning, privacy and correlation

The model client logs one model_request before calling its backend method,
one model_response on return, or one error on an exception (which propagates
unchanged). These demonstrate CLIENT behavior, not provider acceptance or
task completion. Fixed lanes: conversation, coding, memory, responder, vision,
goal. The event summary contains only a random call ID, fixed lane and
fixed state. No prompts, generated replies, errors, credentials, URLs,
player chat, hidden model reasoning or tokens are serialized.

If the conversation's assembled prompt contained Brain advice, the request
and response share the corresponding Brain job trace_id; multiple advice
notes for one model call use the same call ID. Otherwise a new ai.* trace
is used. A shared ID shows correlation, NOT that the model followed advice
or that the subsequent Minecraft goal succeeded.

## Test / deployment gates

Run on the M4 without GitHub Actions:

    node --test test/bob_ai_v2.test.js test/bob_brain.test.js test/bob_brain_v2.test.js

Review source and isolated V2 ingestion before deployment. A genuine
provider/server-side receipt would require separately instrumenting that
provider; do not mislabel this as an internal Andy-server event.

At cutover, the Linux trace cursor's device/inode will change on macOS.
Preserve the final synchronized SQLite state and rebase the copied cursor
without skipping or replaying historical evidence. Do not activate a second
Discord connection or Minecraft player until the original process is stopped.
