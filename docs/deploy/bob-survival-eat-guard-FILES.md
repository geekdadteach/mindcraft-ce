# Survival eat-guard — files that change on live `.20`

Apply `docs/deploy/bob-survival-eat-guard.patch` with `patch -p1` onto the
live tree after PR #22 (harness + verifier) is already on `.20`.

Do **not** replace live `src/agent/commands/actions.js` or
`src/agent/library/bob_goal_circuit.js`. Do **not** apply claim-first
home-removal files. Do **not** send Bob to the abandoned hilltop
(`bob_home.js` bed `-822 124 569`).

Runtime files this patch changes versus live:

| Path | Change |
| --- | --- |
| `src/agent/library/bob_survival_gate.js` | allow food/flee/bed/chest; eat-first suggestion; `isGuardBlockResult` |
| `src/agent/commands/index.js` | pass already-parsed args + `recallBedHint` into the survival guard |
| `src/agent/library/failures.js` | skip guard/survival strings in `observeCommand` |
| `src/agent/self_prompter.js` | skip guard/survival strings in `noteFailure` |

Off-path / docs only: `test/bob_survival_gate.test.js`, this file, the patch.

The deploy bot on the Mac applies this. This PR is not merged by the authoring
agent.
