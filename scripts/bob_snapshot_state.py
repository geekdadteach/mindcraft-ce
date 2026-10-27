#!/usr/bin/env python3
"""Snapshot Bob's persistence files while the service is stopped.

Writes exclusively beneath the specified backup directory, NEVER to LIVE.
Exit nonzero if a discovered state file is not a regular file or changes mid-copy.
"""
import hashlib
import json
import os
import shutil
import stat
import sys
from pathlib import Path

NAMES = {
    "memory.json", "failures.json", "lessons.json",
    "places.json", "home_routes.json", "stuck_home.json",
}
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "logs", "backups"}

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def snapshot(live, backup):
    live, backup = Path(live).resolve(), Path(backup).resolve()
    if not live.is_dir():
        raise ValueError("live runtime does not exist")
    if not backup.is_dir():
        raise ValueError("backup directory does not exist")
    if live == backup or live in backup.parents and backup == live:
        raise ValueError("unsafe backup location")
    destroot = backup / "persistent-state"
    destroot.mkdir(mode=0o700, exist_ok=False)
    manifest = []
    discovered = set()
    for dirpath, dirs, names in os.walk(live, followlinks=False):
        root = Path(dirpath)
        relroot = root.relative_to(live)
        if len(relroot.parts) > 6:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (root / d).is_symlink()]
        for name in sorted(names):
            if name not in NAMES:
                continue
            src = root / name
            if src.is_symlink() or not src.is_file():
                raise ValueError(f"unsafe state file: {src}")
            src_stat = src.stat()
            if not stat.S_ISREG(src_stat.st_mode):
                raise ValueError(f"not a regular file: {src}")
            rel = src.relative_to(live)
            dst = destroot / rel
            dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            h0 = digest(src)
            shutil.copy2(src, dst)
            os.chmod(dst, 0o600)
            if digest(dst) != h0 or digest(src) != h0 or src.stat().st_mtime_ns != src_stat.st_mtime_ns:
                raise RuntimeError(f"state changed during snapshot: {rel}")
            manifest.append({"path":str(rel),"size":src_stat.st_size,"sha256":h0})
            discovered.add(name)
    if "memory.json" not in discovered:
        raise ValueError("missing memory.json; no dependable backup")
    (destroot / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    os.chmod(destroot / "manifest.json", 0o600)
    print(f"Snapshot complete: {len(manifest)} state files; manifest verified.")
    for entry in manifest:
        print(f"  {entry['path']}: {entry['size']} bytes")
    for name in sorted(NAMES - discovered):
        print(f"  Not found (not erased): {name}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: bob_snapshot_state.py LIVE BACKUP (service must be stopped)")
    snapshot(sys.argv[1], sys.argv[2])
