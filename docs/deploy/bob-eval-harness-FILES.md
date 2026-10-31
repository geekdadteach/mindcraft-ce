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

Runtime files versus live:

| Path | Change |
| --- | --- |
| `src/agent/library/bob_eval_harness.js` | new (harness) then replace (verifier wiring) |
| `src/agent/library/bob_goal_verifier.js` | new (this commit) |
| `src/agent/agent.js` | live file + observe-only hooks only |
| `src/agent/commands/index.js` | observe-only hooks; pass already-parsed `args` into the harness |
| `src/agent/self_prompter.js` | observe-only hooks only |
| `src/models/prompter.js` | observe-only hooks only |

Apply in order:

1. `docs/deploy/bob-eval-harness-live.patch` (`patch -p1`) — original harness
2. `docs/deploy/bob-eval-goal-verifier.patch` (`patch -p1`) — verifier + hook arg pass-through

`.20` live files that change for the verifier step: `bob_eval_harness.js`,
new `bob_goal_verifier.js`, `commands/index.js`. `agent.js` /
`self_prompter.js` / `prompter.js` stay as the first harness patch left them.

Off unless `BOB_EVAL_HARNESS_LOG` is an absolute path. The world-state
verifier is on with the harness; `BOB_EVAL_GOAL_VERIFIER=0` restores the
stub. The deploy bot on the Mac applies this; this PR stays a draft.

**Not touched:** live `src/agent/commands/actions.js` and
`src/agent/library/bob_goal_circuit.js`.
