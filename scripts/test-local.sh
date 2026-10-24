#!/usr/bin/env bash
# Run the same Brain and authenticated-control checks locally, not on GitHub.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo "Node.js 22+ required" >&2; exit 2; }
CHECKS=(
  src/agent/library/bob_brain.js
  src/agent/library/bob_brain_v2.js
  src/agent/action_manager.js
  src/agent/commands/index.js
  src/agent/agent.js
  src/models/prompter.js
  src/mindcraft/bobbot_control.js
  src/mindcraft/mindserver.js
  src/agent/bobbot_control.js
  src/agent/mindserver_proxy.js
  test/bob_brain.test.js
  test/bob_brain_v2.test.js
  test/bobbot_control.test.js
)
TESTS=()
for file in "${CHECKS[@]}"; do
  if [[ -f "$file" ]]; then
    node --check "$file"
    if [[ "$file" == test/*.test.js ]]; then TESTS+=("$file"); fi
  fi
done
if [[ "${#TESTS[@]}" -gt 0 ]]; then node --test "${TESTS[@]}"; fi
echo "PASS: local Brain + receipt + MindServer control checks"
echo "No Minecraft, Discord or running Bob was accessed."
