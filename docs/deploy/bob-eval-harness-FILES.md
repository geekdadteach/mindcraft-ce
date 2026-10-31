# Bob eval harness — files changed versus live

Apply `docs/deploy/bob-eval-harness-live.patch` with `patch -p1` onto a
tree that matches live for these paths: exact live `src/agent/agent.js`
(HomeRegistry / HomesteadTracker / `maybeSetEssentialsHome`) plus the live
copies of `commands/index.js`, `self_prompter.js`, and `prompter.js`. That
is the same as this branch with `agent.js` replaced by the live file.

Do **not** apply claim-first home-removal files from this branch. Do **not**
replace live `src/agent/commands/actions.js` or
`src/agent/library/bob_goal_circuit.js` (the harness does not touch them;
live copies differ from this branch and must stay).

Runtime files the patch changes versus live:

| Path | Change |
| --- | --- |
| `src/agent/library/bob_eval_harness.js` | new |
| `src/agent/agent.js` | live file + observe-only hooks only |
| `src/agent/commands/index.js` | observe-only hooks only |
| `src/agent/self_prompter.js` | observe-only hooks only |
| `src/models/prompter.js` | observe-only hooks only |

Off unless `BOB_EVAL_HARNESS_LOG` is an absolute path, distinct from the V2
receipt files. The deploy bot on the Mac applies this; this PR stays a draft.
