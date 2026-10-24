# Mindcraft Bob V2 receipt retention — source-only opt-in

This change is a **separate review branch based on Mindcraft CE PR #6**.
No live Bob or NewEarth service has been modified. This is a proposed
producer-side remedy for PR #6's hard 1 MiB JSONL cap. The old behavior
remains the default and existing runtime APIs remain unchanged.

## How it works

- Unset `BOB_BRAIN_V2_EVENT_LOG`: **all receipts disabled**, as before.
- Set that absolute private file path but leave
  `BOB_BRAIN_V2_ROTATE_LOG` unset: **original cap** applies; the writer stops
  at 1 MiB, as before.
- Explicitly set `BOB_BRAIN_V2_ROTATE_LOG=1` **in addition to the log path**:
  when a complete JSONL event would overflow the active file cap, the writer
  closes it and rotates the bounded archive ring:
  active -> `.1` -> `.2` -> `.3` -> `.4`, then reopens a new active
  file in append-only mode. The oldest `.4` is removed at next rotation.
- Archive names are fixed local file names; no external commands, network
  listeners, Minecraft writes or extra model calls. Existing/symlinked/
  world-readable archive files cause a safe failure rather than overwrite.
- All records remain version-1 JSONL with stable trace_id/event_id.
  The companion BobBot V2 review PR reads the same bounded archive ring by
  inode and keeps independent durable cursors.

## Limitations and operator acceptance

- **Bounded retention, not lossless indefinite storage:** the oldest file
  falls out of the ring under sustained load. If V2 has not consumed it,
  evidence can be lost; the observer records an unrecoverable gap.
- This source changes the *potential* behavior of a producer; it does NOT
  install/restart or enable it. Owner must explicitly approve the Mindcraft
  code deployment, its environment and any Bob restart.
- Do not assume a test branch is live. Reconcile PR #6 against its base and
  test with a **separate temp file** before enabling on Bob.
- Event files should be mode 0600/0640 and inaccessible to unauthenticated
  users. Parent directories require narrowly scoped read/traverse ACLs for
  the observer account; never use chmod 777.
- When rotating, the producer may omit records if the filesystem is full,
  the rotation fails, or consumers fall behind the 5-segment ring.
- No log path, Discord token, user/guild ID or SSH key belongs in this
  public repository. Configure all actual paths/credentials privately.

## Suggested production check (requires owner approval later)

Simulate 20+ rotations on a disposable JSONL file, verify records and
ordering in the V2 trace store, verify `.4` disappears only after bounded
retention, ensure `.1` and active remain readable to V2, run a
simulated Discord outage, and verify Bob's agent loop remains responsive.

No claim of live verification is made by CI or this document.
