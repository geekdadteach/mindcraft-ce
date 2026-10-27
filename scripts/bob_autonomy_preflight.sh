#!/usr/bin/env bash
# Read-only with respect to the running Bob installation. Run inside a separate
# clean checkout of feature/bob-native-autonomy-20261027 on MM20.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="${BOB_LIVE_DIR:-$HOME/BobRuntime/cutover/mindcraft-m4}"
BASE="72a00e81283caba5c1c33165b5962342bfb49106"
NODE="${BOB_NODE22:-$(brew --prefix node@22)/bin/node}"
FAIL=0

echo "===== STAGE 1: RUNNER AND SOURCE ====="
test -x "$NODE"
test -d "$LIVE/src"
git -C "$ROOT" rev-parse --is-inside-work-tree | grep -qx true
"$NODE" --version
git -C "$ROOT" rev-parse --short HEAD
git -C "$ROOT" cat-file -e "${BASE}^{commit}"
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  echo "FAIL: candidate checkout has uncommitted tracked changes"
  exit 2
fi

echo "===== STAGE 2: CHECK FILES AGAINST LIVE BASELINE ====="
while IFS= read -r -d '' rel; do
  if git -C "$ROOT" cat-file -e "${BASE}:${rel}" 2>/dev/null; then
    if ! test -f "$LIVE/$rel" || ! cmp -s <(git -C "$ROOT" show "${BASE}:${rel}") "$LIVE/$rel"; then
      echo "REVIEW REQUIRED (modified live source): $rel"
      FAIL=1
    fi
  else
    if test -e "$LIVE/$rel" || test -L "$LIVE/$rel"; then
      echo "REVIEW REQUIRED (new path already exists): $rel"
      FAIL=1
    fi
  fi
done < <(git -C "$ROOT" diff --name-only -z "$BASE" HEAD -- src profiles settings.js)

if (( FAIL != 0 )); then
  echo "FAIL: resolve live/source differences before any deployment"
  exit 3
fi
echo "All changed runtime source paths match expected base or are absent."

echo "===== STAGE 3: CHECK JAVASCRIPT SYNTAX ====="
while IFS= read -r -d '' rel; do
  if [[ "$rel" == *.js || "$rel" == *.mjs ]]; then
    "$NODE" --check "$ROOT/$rel"
  fi
done < <(git -C "$ROOT" diff --name-only -z "$BASE" HEAD -- src scripts settings.js)
echo "Syntax: PASS"

echo "===== STAGE 4: NODE TESTS ====="
if [[ ! -d "$ROOT/node_modules" ]]; then
  if [[ -d "$LIVE/node_modules" ]]; then
    ln -s "$LIVE/node_modules" "$ROOT/node_modules"
  elif [[ -d "$HOME/BobMigration/staging/mindcraft-ce/node_modules" ]]; then
    ln -s "$HOME/BobMigration/staging/mindcraft-ce/node_modules" "$ROOT/node_modules"
  else
    echo "FAIL: No existing compatible node_modules directory found; do not install over live runtime"
    exit 4
  fi
fi
cd "$ROOT"
"$NODE" --test test/*.test.js

echo "===== STAGE 5: SAVED GOAL DRY RUN ====="
if [[ -f "$LIVE/bots/MineBobNE/memory.json" ]]; then
  "$NODE" "$ROOT/scripts/bob_migrate_saved_goal.mjs" "$LIVE/bots/MineBobNE/memory.json"
else
  echo "Memory not found in expected location; locate before deployment"
fi
echo "PREFLIGHT PASS. No live source, memory, or services changed."
