#!/usr/bin/env python3
"""Bounded, fail-closed launchd lifecycle checks for Bob. Never print secrets."""
import argparse
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

def run(*args):
    return subprocess.run(args, text=True, capture_output=True)

def job(domain, label):
    result = run('launchctl', 'print', f'{domain}/{label}')
    if result.returncode:
        if run('launchctl', 'print', domain).returncode:
            raise RuntimeError('Cannot inspect launchd domain')
        if 'Could not find service' not in result.stderr:
            raise RuntimeError('Cannot determine launchd service state')
        return False, None
    match = re.search(r'^\s*pid = ([1-9][0-9]*)\s*$', result.stdout, re.M)
    return True, int(match[1]) if match else None

def processes():
    result = run('ps', '-axo', 'pid=,ppid=,comm=')
    if result.returncode:
        raise RuntimeError('Cannot inspect process table')
    table = {}
    for line in result.stdout.splitlines():
        try:
            pid, parent, command = line.strip().split(None, 2)
            table[int(pid)] = (int(parent), command)
        except ValueError:
            continue
    return table

def descendants(table, root):
    found = {root} if root else set()
    while True:
        expanded = found | {pid for pid, (parent, _) in table.items() if parent in found}
        if expanded == found:
            return found
        found = expanded

def runtime_pids(table, live):
    found = set()
    for pid, (_, command) in table.items():
        if not re.search(r'(node|python[^/]*)$', command):
            continue
        result = run('lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn')
        if result.returncode:
            if pid in processes():
                raise RuntimeError(f'Cannot inspect runtime ownership for PID {pid}')
            continue
        paths = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
        if not paths:
            raise RuntimeError(f'Missing working directory for PID {pid}')
        if any(Path(p).resolve() == live.resolve() for p in paths):
            found.add(pid)
    return found

def ports_free():
    try:
        for port in (8081, 9239):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False

def wait_ports(timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ports_free():
            return
        time.sleep(1)
    raise RuntimeError('Guard ports 8081/9239 unavailable; refusing bootstrap')

def stop(domain, label, live, timeout):
    loaded, pid = job(domain, label)
    table = processes()
    known = descendants(table, pid) | runtime_pids(table, live)
    for root in list(known):
        known |= descendants(table, root)
    if loaded:
        result = run('launchctl', 'bootout', f'{domain}/{label}')
        if result.returncode:
            raise RuntimeError('launchd bootout failed')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        loaded, pid = job(domain, label)
        table = processes()
        remaining = known.intersection(table) | runtime_pids(table, live)
        if not loaded and not remaining:
            return
        time.sleep(1)
    raise RuntimeError('Runtime writers remain; refusing restore/restart')

def wait_ready(domain, label, timeout, stable=10):
    deadline = time.monotonic() + timeout
    previous, since = None, None
    while time.monotonic() < deadline:
        loaded, pid = job(domain, label)
        table = processes()
        def node(p):
            return p in table and Path(table[p][1]).name == 'node'
        children = tuple(sorted(p for p, (parent, _) in table.items() if parent == pid and node(p)))
        current = (pid, children) if loaded and node(pid) and children else None
        if current is None or current != previous:
            since = time.monotonic() if current else None
            previous = current
        elif time.monotonic() - since >= stable:
            print(f'Stable launcher PID {pid}; agent PID(s): {children}')
            return
        time.sleep(1)
    raise RuntimeError('No stable Node launcher and agent within startup deadline')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stop', 'ports', 'ready', 'pid'))
    parser.add_argument('--domain', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--live', type=Path, required=True)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if args.action == 'stop':
        stop(args.domain, args.label, args.live, args.timeout)
    elif args.action == 'ports':
        wait_ports(args.timeout)
    elif args.action == 'ready':
        wait_ready(args.domain, args.label, args.timeout)
    else:
        _, pid = job(args.domain, args.label)
        if pid:
            print(pid)

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError) as exc:
        print(f'Lifecycle check failed: {exc}', file=sys.stderr)
        raise SystemExit(1)
