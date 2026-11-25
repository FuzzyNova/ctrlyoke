# A reused PID revives a crashed MCP participant's path claims and silently revokes newer claims

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, fold-level repro against `out/`)
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`isParticipantLive` ~116-131, `foldCoordinationEntries` ~352-447, `closeRunParticipants` ~575)
- **Severity:** low (needs PID reuse or observers that disagree about liveness; fix needs a design decision)

## Symptom

The coordination board is replayed with each participant's liveness as it is
_now_. If an MCP participant crashes without leaving, another participant is
granted its paths. If the crashed participant's PID is later reused by an
unrelated process, the next fold judges the crashed participant alive again.
Its original claim wins, the newer grant is dropped without notice, and
`release_paths` from the newer holder reports `notHeld`. The ghost holds the
paths until the unrelated process exits.

The same thing happens when an observer's `process.kill(pid, 0)` returns
`EPERM` (a sandboxed reader) and it treats every PID as alive.

## Steps to Reproduce

Fold level (compiled `out/`, `foldCoordinationEntries` with an injected
liveness check):

1. Participant A (pid 111, via MCP) claims `src`. Mark pid 111 dead.
2. Participant B (pid 222) claims `src`. The fold grants it: claims are `src:B`.
3. Mark pid 111 alive again (PID reuse). Fold again: claims are `src:A`, A is
   listed live, and B's claim is gone.

**Expected:** a granted claim stays granted, and a participant seen dead stays
gone.

## Root Cause

- `isParticipantLive` (~116-131) judges MCP participants on PID alone. That is
  deliberate (Decision 2 of `dev/implemented/EXECUTION_ROOT_COORDINATION_PLAN.md`:
  nothing heartbeats an MCP participant on a timer). The plan named heartbeat
  staleness as the backstop, but that backstop was dropped.
- `foldCoordinationEntries` replays every entry with current liveness, and its
  claim branch skips a later conflicting claim (`if (existing) continue;`), so
  an earlier claimant coming back to life revokes the later one retroactively.
- `closeRunParticipants` (~575) writes leave entries only for live
  participants, so a crashed participant never gets one.

## Suggested Fix

Needs a design choice; options:

- Write a leave entry the first time a participant is observed dead (in the
  fold's caller or in `closeRunParticipants`), so it can never revive.
- Record the process start time alongside the PID and treat a mismatch as dead.
- Make the fold judge each claim once, using the claimant's liveness when the
  conflicting claim was granted, so later liveness changes cannot revoke a
  grant.
