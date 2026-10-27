#!/usr/bin/env python3
"""Observe new Minecraft status messages after launch; never modify game state."""
import argparse
import os
import re
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("log")
parser.add_argument("--offset", type=int, default=0)
parser.add_argument("--timeout", type=int, default=300)
args = parser.parse_args()
status = re.compile(r"status pos=\\((-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)")
start = time.monotonic()
position = None
offset = args.offset
saw_status = False
while time.monotonic() - start < args.timeout:
    try:
        size = os.stat(args.log).st_size
        if size < offset:
            offset = 0
        with open(args.log, "rb") as f:
            f.seek(offset)
            chunk = f.read()
            offset = f.tell()
        for match in status.finditer(chunk.decode("utf-8", errors="replace")):
            saw_status = True
            current = tuple(float(v) for v in match.groups())
            if position is None:
                position = current
                print(f"LOGIN STATUS OBSERVED: {position}", flush=True)
            elif sum((a-b)**2 for a,b in zip(position,current)) >= 4:
                print(f"GAME MOVEMENT VERIFIED: {position} -> {current}", flush=True)
                sys.exit(0)
    except FileNotFoundError:
        pass
    time.sleep(2)
print("SMOKE CHECK FAILED: " + ("no movement >=2 blocks" if saw_status else "no fresh status pos= line"), file=sys.stderr)
sys.exit(1)
