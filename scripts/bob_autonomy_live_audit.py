#!/usr/bin/env python3
"""Read-only audit of live Bob state, source overlays and deployment conflicts.

Never changes the live runtime, launchd, git checkout or memory files.
Run on MM20 as user test: python3 scripts/bob_autonomy_live_audit.py
"""
import hashlib
import json
import os
import subprocess
from pathlib import Path

HOME = Path.home()
STAGE = Path(__file__).resolve().parent.parent
LIVE = Path(os.environ.get("BOB_LIVE_DIR", HOME / "BobRuntime/cutover/mindcraft-m4"))
BASE = "72a00e81283caba5c1c33165b5962342bfb49106"
STATE_NAMES = {
    "memory.json", "failures.json", "lessons.json",
    "places.json", "home_routes.json", "stuck_home.json",
}
PATCH_MARKERS = ("stuck-home", "reset-recovery", "chat_guard", "nodistance")

def git(*args):
    return subprocess.check_output(["git", "-C", str(STAGE), *args], stderr=subprocess.PIPE)

def note(title):
    print(f"\n===== {title} =====", flush=True)

def safe_bytes(path):
    if path.is_symlink() or not path.is_file():
        return None
    return path.read_bytes()

def sha(data):
    return hashlib.sha256(data).hexdigest()[:16]

def main():
    note("HOST AND LIVE LOCATION")
    print("User:", os.environ.get("USER", "(unknown)"))
    print("Home:", HOME)
    print("Live:", LIVE)
    if not (LIVE / "bots/MineBobNE/memory.json").is_file():
        print("ERROR: Bob's live memory is missing on this host. No changes made.")
        return 2
    if not (STAGE / ".git").exists():
        print("ERROR: staging checkout missing. No changes made.")
        return 2

    note("CHANGED SOURCE PATHS: BASE VS LIVE")
    changed = [
        s.decode() for s in git("diff", "--name-only", "-z", BASE, "HEAD",
                                "--", "src", "profiles", "settings.js").split(b"\0") if s
    ]
    conflicted = []
    for rel in changed:
        path = LIVE / rel
        current = safe_bytes(path)
        try:
            baseline = git("show", f"{BASE}:{rel}")
            existed = True
        except subprocess.CalledProcessError:
            baseline = None
            existed = False
        if existed and current == baseline:
            status = "MATCH BASE; candidate may replace this path"
        elif not existed and not path.exists() and not path.is_symlink():
            status = "NEW FILE; no live overwrite"
        else:
            status = "CONFLICT / LOCAL PATCH; do NOT deploy"
            conflicted.append(rel)
        print(f"{status}: {rel}")
    print("Overlapping live patches:", len(conflicted))

    note("KNOWN MAC-ONLY PATCH MARKERS (PRESENCE CHECK, NOT PROOF OF CORRECTNESS)")
    for marker in PATCH_MARKERS:
        matches = []
        for root in (LIVE / "src", LIVE / "run"):
            if not root.is_dir():
                continue
            for dirpath, dirs, names in os.walk(root):
                dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "__pycache__")]
                for name in names:
                    if not name.endswith((".js", ".mjs", ".py")):
                        continue
                    p = Path(dirpath) / name
                    try:
                        if not p.is_symlink() and marker.lower() in p.read_text(errors="replace").lower():
                            matches.append(str(p.relative_to(LIVE)))
                    except (OSError, UnicodeError):
                        continue
        print(f"{marker}: " + (", ".join(matches[:12]) or "not found by literal marker"))

    note("STATE FILE INVENTORY: METADATA ONLY")
    found = {n: [] for n in STATE_NAMES}
    for dirpath, dirs, names in os.walk(LIVE):
        relative_parts = Path(dirpath).relative_to(LIVE).parts
        if len(relative_parts) > 6:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in
                   ("node_modules", ".git", "venv", ".venv", "logs", "backups")]
        for name in names:
            if name not in found:
                continue
            p = Path(dirpath) / name
            if p.is_symlink() or not p.is_file():
                print("WARNING symlink/not regular:", p)
                continue
            stat = p.stat()
            found[name].append(p)
            print(f"{p.relative_to(LIVE)}: {stat.st_size} bytes, modified_ns={stat.st_mtime_ns}")
    for name in sorted(STATE_NAMES):
        if not found[name]:
            print("NOT FOUND:", name)

    note("CURRENT SAVED GOAL: NO CONVERSATION TEXT PRINTED")
    mem = LIVE / "bots/MineBobNE/memory.json"
    try:
        state = json.loads(mem.read_text())
        print("Turn count:", len(state.get("turns") or []))
        print("Autonomy state:", state.get("self_prompting_state"))
        print("Goal:", state.get("self_prompt"))
        print("Homestead-only goal:", any(
            word in str(state.get("self_prompt", "")).lower()
            for word in ("at your own homestead", "homestead plateau", "shelter and lighting")
        ))
    except (OSError, ValueError, TypeError) as error:
        print("Memory parse failed:", type(error).__name__)

    note("OLD LAUNCHAGENT BACKUP (NO SECRET CONTENT PRINTED)")
    old = HOME / "Library/LaunchAgents/org.newearth.mindcraft-m4.plist.bak-20261026"
    if old.is_file():
        print("Backup with potential plaintext key exists:", old)
        print("Permissions:", oct(old.stat().st_mode & 0o777))
    else:
        print("Old .plist backup not present")

    note("RESULT")
    print("Audit is read-only. No service changes made.")
    if conflicted:
        print("BLOCKED: reconcile conflicting live changes before deployment.")
        return 3
    print("No direct overwrite conflict in changed paths.")
    print("Still requires review of Mac-only patches and full state-file backup.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
