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
START_ATTEMPTED=0

lifecycle() {
    python3 "$STAGE/scripts/bob_launchd_safety.py" "$1" \
        --domain "$DOMAIN" --label "$LABEL" --live "$LIVE" --timeout "${2:-180}"
}
service_pid() { lifecycle pid; }
service_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

restore_previous() {
    echo "Restoring previous source; memory restored only if candidate never started"
    while IFS= read -r -d '' rel; do
        if [[ -f "$BACKUP/source/$rel" ]]; then
            mkdir -p "$LIVE/$(dirname "$rel")" || return 1
            cp -p "$BACKUP/source/$rel" "$LIVE/$rel" || return 1
        fi
    done < "$BACKUP/old-files.nul"
    while IFS= read -r -d '' rel; do
        rm -f -- "$LIVE/$rel" || return 1
    done < "$BACKUP/new-files.nul"
    if [[ "$START_ATTEMPTED" -eq 0 && -f "$BACKUP/memory.json" ]]; then
        cp -p "$BACKUP/memory.json" "$LIVE/bots/MineBobNE/memory.json" || return 1
    fi
}
on_exit() {
    rc=$?
    trap - EXIT
    if [[ "$DONE" -eq 0 && "$STOPPED" -eq 1 ]]; then
        echo "Deployment interrupted (status $rc)."
        if ! lifecycle stop 30; then
            echo "UNSAFE: runtime writers may remain; no restore or restart."
        elif [[ "$MODIFIED" -eq 1 ]] && ! restore_previous; then
            echo "ROLLBACK FAILED: service stays stopped; inspect $BACKUP"
        elif ! lifecycle ports 180; then
            echo "Ports unavailable; service stays stopped."
        elif ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
            echo "SERVICE RESTART FAILED; inspect LaunchAgent."
        elif ! lifecycle ready 180; then
            echo "ROLLBACK SERVICE NOT VERIFIED; do not start another Bob."
        else
            echo "Previous source restarted and verified at process level."
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
[[ -f "$STAGE/scripts/bob_launchd_safety.py" ]] || { echo "FAIL: lifecycle helper missing"; exit 2; }
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
# Recovery must run even if bootout partially succeeds.
STOPPED=1
lifecycle stop 30
lifecycle ports 180

echo "===== BACK UP FINAL MEMORY STATE ====="
MEMORY="$LIVE/bots/MineBobNE/memory.json"
[[ -f "$MEMORY" && ! -L "$MEMORY" ]] || { echo "Unexpected memory file type"; exit 6; }
cp -p "$MEMORY" "$BACKUP/memory.json"
echo "===== SNAPSHOT ALL KNOWN BOB STATE FILES ====="
# Includes failure guards, lessons, places, homing routes and stuck-home
# history. Never clears failures automatically: reset requires manual review.
python3 "$STAGE/scripts/bob_snapshot_state.py" "$LIVE" "$BACKUP"
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
legacy_goal = 'Review your equipment and supplies. Choose and complete one useful maintenance or organization task at your homestead.'
if before.get('self_prompt') == legacy_goal or 'Inspect your own shelter and lighting.' in str(before.get('self_prompt')):
    assert after.get('self_prompt') != before.get('self_prompt'), 'Legacy goal not migrated'
assert 'Goal: Build/tidy homestead' not in str(after.get('memory')), 'Stale summary still present'
assert 'Goal: Maintain homestead' not in str(after.get('memory')), 'Stale maintenance summary still present'
print("Preserved",len(after.get('turns') or []),"conversation turns; autonomy state",after.get('self_prompting_state'))
print("Migrated goal:",str(after.get('self_prompt'))[:180])
PY

echo "===== START ONE LAUNCHD SERVICE ====="
# Mark candidate start before bootstrap; a partial bootstrap can write memory.
START_ATTEMPTED=1
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
lifecycle ready 180 || { echo "Candidate startup not verified; attempting safe rollback"; exit 8; }
DONE=1
trap - EXIT
echo "DEPLOYMENT COMPLETE — game behavior still requires live smoke checks"
echo "Backup: $BACKUP"
echo "Commit: $(cat "$BACKUP/deployed-commit.txt")"
echo "Latest log:"
tail -n 25 "$LIVE/logs/mindcraft.log" || true
