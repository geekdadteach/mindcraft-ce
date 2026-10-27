#!/usr/bin/env bash
# Controlled MM20 install from a separately tested Git checkout.
# Stops Bob once. Preserves original source, plist and memory for local rollback.
set -euo pipefail

STAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="${BOB_LIVE_DIR:-$HOME/BobRuntime/cutover/mindcraft-m4}"
LABEL="org.newearth.mindcraft-m4"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
BASE="72a00e81283caba5c1c33165b5962342bfb49106"
NODE="${BOB_NODE22:-$(brew --prefix node@22)/bin/node}"
BACKUP="$HOME/BobRuntime/backups/native-autonomy-$(date +%Y%m%d-%H%M%S)-$$"
STOPPED=0
MODIFIED=0
DONE=0
UNSAFE=0

service_pid() {
    launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label && $1 ~ /^[0-9]+$/ {print $1; exit}'
}
is_alive() { kill -0 "$1" 2>/dev/null; }
service_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

restore_previous() {
    echo "Rolling back changed runtime sources and saved memory from $BACKUP"
    while IFS= read -r -d '' rel; do
        if [[ -f "$BACKUP/source/$rel" ]]; then
            mkdir -p "$LIVE/$(dirname "$rel")"
            cp -p "$BACKUP/source/$rel" "$LIVE/$rel"
        fi
    done < "$BACKUP/old-files.nul"
    while IFS= read -r -d '' rel; do rm -f -- "$LIVE/$rel"; done < "$BACKUP/new-files.nul"
    if [[ -f "$BACKUP/memory.json" ]]; then cp -p "$BACKUP/memory.json" "$LIVE/bots/MineBobNE/memory.json"; fi
}
on_exit() {
    rc=$?
    trap - EXIT
    if [[ "$DONE" -eq 0 && "$STOPPED" -eq 1 ]]; then
        echo "Deployment interrupted (status $rc)."
        if [[ "$UNSAFE" -eq 1 ]]; then
            echo "UNSAFE: old bot process still alive; service stays unloaded to avoid a second player."
        else
            # If bootstrap partly succeeded, stop the candidate *before* restoring
            # source/memory. Never copy over an active agent's files.
            candidate_pid="$(service_pid)"
            if service_loaded; then
                # Bob launcher spawns the Mineflayer agent as a direct child.
                # Capture it before bootout, since it may be reparented.
                candidate_children=""
                if [[ "$candidate_pid" =~ ^[0-9]+$ ]]; then
                    candidate_children="$(ps -axo pid=,ppid= | awk -v parent="$candidate_pid" '$2 == parent {print $1}')"
                fi
                launchctl bootout "$DOMAIN" "$PLIST" || true
                for _ in {1..10}; do
                    candidate_alive=0
                    if [[ "$candidate_pid" =~ ^[0-9]+$ ]] && is_alive "$candidate_pid"; then candidate_alive=1; fi
                    for child in $candidate_children; do
                        if is_alive "$child"; then candidate_alive=1; fi
                    done
                    if [[ "$candidate_alive" -eq 0 ]]; then break; fi
                    sleep 1
                done
                if [[ "$candidate_alive" -eq 1 ]]; then
                    UNSAFE=1
                    echo "Candidate launcher or agent still running; manual recovery required. No files restored."
                fi
            fi
            if [[ "$UNSAFE" -eq 0 ]]; then
                if [[ "$MODIFIED" -eq 1 ]]; then restore_previous || echo "ROLLBACK FAILED: inspect $BACKUP"; fi
                if ! service_loaded; then
                    launchctl bootstrap "$DOMAIN" "$PLIST" || echo "SERVICE RESTART FAILED: inspect LaunchAgent manually"
                else
                    echo "LaunchAgent already loaded; not bootstrapping a duplicate"
                fi
            fi
        fi
        echo "Backups remain at $BACKUP"
    fi
    exit "$rc"
}
trap on_exit EXIT

echo "===== MM20 NATIVE AUTONOMY DEPLOYMENT ====="
echo "Staged checkout: $STAGE"
echo "Live runtime: $LIVE"
echo "Node 22: $NODE"
[[ -x "$NODE" ]] || { echo "FAIL: Node 22 executable missing: $NODE"; exit 2; }
[[ -f "$PLIST" ]] || { echo "FAIL: LaunchAgent plist missing: $PLIST"; exit 2; }
[[ -d "$LIVE/src" ]] || { echo "FAIL: live source missing: $LIVE/src"; exit 2; }
[[ -f "$LIVE/bots/MineBobNE/memory.json" ]] || { echo "FAIL: live memory missing"; exit 2; }
[[ "$(git -C "$STAGE" branch --show-current)" = "feature/bob-native-autonomy-20261027" ]] || { echo "FAIL: wrong checkout branch"; exit 2; }
[[ -z "$(git -C "$STAGE" status --porcelain --untracked-files=no)" ]] || { echo "FAIL: staged tracked files modified"; git -C "$STAGE" status --short --untracked-files=no; exit 2; }
OLDPID="$(service_pid)"
[[ "$OLDPID" =~ ^[0-9]+$ ]] || { echo "Bob launchd service not running; refusing"; exit 2; }
echo "Running Bob PID: $OLDPID"

echo "===== BEFORE STOP: FULL PREFLIGHT ====="
LOG="$STAGE/autonomy-deployment-preflight.log"
if ! bash "$STAGE/scripts/bob_autonomy_preflight.sh" > "$LOG" 2>&1; then
    tail -n 85 "$LOG"
    echo "Preflight failed; no service changes made."
    exit 3
fi
tail -n 18 "$LOG"
grep -q '^PREFLIGHT PASS' "$LOG" || { echo "Missing PASS marker"; exit 3; }

mkdir -m 700 "$BACKUP"
mkdir -m 700 "$BACKUP/source"
: > "$BACKUP/old-files.nul"
: > "$BACKUP/new-files.nul"
cp -p "$PLIST" "$BACKUP/launchagent.plist"
git -C "$STAGE" rev-parse HEAD > "$BACKUP/deployed-commit.txt"
echo "===== BEFORE STOP: SOURCE BACKUP ====="
while IFS= read -r -d '' rel; do
    [[ -f "$STAGE/$rel" && ! -L "$STAGE/$rel" ]] || { echo "Invalid staged path: $rel"; exit 4; }
    if [[ -e "$LIVE/$rel" || -L "$LIVE/$rel" ]]; then
        [[ -f "$LIVE/$rel" && ! -L "$LIVE/$rel" ]] || { echo "Unsafe live source: $rel"; exit 4; }
        mkdir -p "$BACKUP/source/$(dirname "$rel")"
        cp -p "$LIVE/$rel" "$BACKUP/source/$rel"
        printf '%s\0' "$rel" >> "$BACKUP/old-files.nul"
    else
        printf '%s\0' "$rel" >> "$BACKUP/new-files.nul"
    fi
done < <(git -C "$STAGE" diff --name-only -z "$BASE" HEAD -- src profiles settings.js)

echo "===== STOP BOB / WAIT FOR WRITERS ====="
# Capture direct and indirect children before stopping the launchd parent.
python3 - "$OLDPID" > "$BACKUP/agent-descendants.txt" <<'PY'
import subprocess, sys
root = int(sys.argv[1])
children = {}
for line in subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines():
    try: pid, ppid = map(int, line.split())
    except ValueError: continue
    children.setdefault(ppid, []).append(pid)
found, stack = [], [root]
while stack:
    parent = stack.pop()
    for pid in children.get(parent, []):
        if pid not in found: found.append(pid); stack.append(pid)
for pid in found: print(pid)
PY
launchctl bootout "$DOMAIN" "$PLIST"
STOPPED=1
for _ in {1..20}; do
    alive=0
    if is_alive "$OLDPID"; then alive=1; fi
    while read -r child; do if [[ -n "$child" ]] && is_alive "$child"; then alive=1; fi; done < "$BACKUP/agent-descendants.txt"
    if [[ "$alive" -eq 0 ]]; then break; fi
    sleep 1
done
# Send SIGINT only to previously identified children of this launchd job.
while read -r child; do
    if [[ -n "$child" ]] && is_alive "$child"; then kill -INT "$child" 2>/dev/null || true; fi
done < "$BACKUP/agent-descendants.txt"
sleep 2
if is_alive "$OLDPID"; then UNSAFE=1; echo "Old launcher did not exit"; exit 5; fi
while read -r child; do
    if [[ -n "$child" ]] && is_alive "$child"; then
        UNSAFE=1; echo "Old agent child still running: $child"; exit 5
    fi
done < "$BACKUP/agent-descendants.txt"
[[ -z "$(service_pid)" ]] || { UNSAFE=1; echo "LaunchAgent reappeared unexpectedly"; exit 5; }

echo "===== BACK UP FINAL MEMORY STATE ====="
MEMORY="$LIVE/bots/MineBobNE/memory.json"
[[ -f "$MEMORY" && ! -L "$MEMORY" ]] || { echo "Unexpected memory file type"; exit 6; }
cp -p "$MEMORY" "$BACKUP/memory.json"
python3 - "$BACKUP/memory.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d.get('turns'), list)
assert isinstance(d.get('self_prompting_state'),int)
print("Saved memory: turns=",len(d["turns"]),"autonomy_state=",d["self_prompting_state"])
PY

echo "===== INSTALL AND VERIFY STAGED SOURCE ====="
MODIFIED=1
while IFS= read -r -d '' rel; do
    mkdir -p "$LIVE/$(dirname "$rel")"
    cp -p "$STAGE/$rel" "$LIVE/$rel"
    cmp -s "$STAGE/$rel" "$LIVE/$rel" || { echo "Copy verification failed: $rel"; exit 7; }
done < <(git -C "$STAGE" diff --name-only -z "$BASE" HEAD -- src profiles settings.js)

echo "===== MIGRATE SAVED GOAL WITHOUT DELETING HISTORY ====="
"$NODE" "$STAGE/scripts/bob_migrate_saved_goal.mjs" "$MEMORY" --apply --stopped-confirmed
python3 - "$BACKUP/memory.json" "$MEMORY" <<'PY'
import json,sys
before=json.load(open(sys.argv[1]))
after=json.load(open(sys.argv[2]))
for field in ('turns','taskStart','last_sender','self_prompting_state'):
    assert before.get(field) == after.get(field), f'Unexpected change to {field}'
if 'Inspect your own shelter and lighting.' in str(before.get('self_prompt')):
    assert after.get('self_prompt') != before.get('self_prompt'), 'Legacy goal not migrated'
assert 'Goal: Build/tidy homestead' not in str(after.get('memory')), 'Stale summary still present'
print("Preserved",len(after.get('turns') or []),"conversation turns; autonomy state",after.get('self_prompting_state'))
print("Migrated goal:",str(after.get('self_prompt'))[:180])
PY

echo "===== START ONE LAUNCHD SERVICE ====="
# macOS may report a loaded but temporarily PID-less KeepAlive job.
# Never issue a second bootstrap for a label launchd already registered.
if service_loaded; then
    echo "LaunchAgent already registered; observing its startup"
else
    if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
        # launchctl may race a KeepAlive restart; inspect loaded state first.
        if ! service_loaded; then
            echo "Bootstrap failed and launchd does not report the service loaded"
            exit 8
        fi
    fi
fi
NEWPID=""
for _ in {1..45}; do
    observed="$(service_pid)"
    if [[ "$observed" =~ ^[0-9]+$ ]] && is_alive "$observed"; then
        # Make sure it stays alive rather than being a momentary crash-loop PID.
        sleep 3
        if [[ "$(service_pid)" = "$observed" ]] && is_alive "$observed"; then
            NEWPID="$observed"
            break
        fi
    fi
    sleep 1
done
[[ "$NEWPID" =~ ^[0-9]+$ ]] || { echo "LaunchAgent loaded but no stable running launcher within startup grace period"; exit 8; }
echo "New Bob launcher PID: $NEWPID"
DONE=1
trap - EXIT
echo "DEPLOYMENT COMPLETE — game behavior still requires live smoke checks"
echo "Backup: $BACKUP"
echo "Commit: $(cat "$BACKUP/deployed-commit.txt")"
echo "Latest log:"
tail -n 25 "$LIVE/logs/mindcraft.log" || true
