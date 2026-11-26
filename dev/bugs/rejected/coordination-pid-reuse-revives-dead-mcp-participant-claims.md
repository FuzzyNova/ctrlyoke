# A reused PID revives a crashed MCP participant's path claims and silently revokes newer claims

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, fold-level repro against `out/`)
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`isParticipantLive` ~116-131, `foldCoordinationEntries` ~352-447, `closeRunParticipants` ~575)
- **Resolution:** rejected: not reachable through the registry; the write that grants the newer claim compacts the dead participant away (regression test added)

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

## Decision

**Write a leave entry the first time a participant is observed dead**
(2026-11-26). When a fold's caller, or `closeRunParticipants`, judges a
participant dead, it appends a leave entry for it, so a later PID reuse cannot
revive it or its claims. This fits the append-only log and needs no
persisted-format change. Add a regression test for the repro above:
dead → leave written → pid alive again → B still holds `src`.

Accepted gap: an observer whose `process.kill(pid, 0)` returns `EPERM` and so
treats every PID as alive never writes the leave entry. It can still see a
revived ghost until another observer records the death. The rejected options
were process start time (needs new cross-platform plumbing and a format bump)
and a grant-time fold (harder to reason about); revisit them only if the
EPERM case shows up in practice. Severity stays low.

## Outcome

**Not reachable end to end** (2026-11-26). The repro only works on a bare
`foldCoordinationEntries` call. Every board write goes through
`CoordinationParticipantRegistry`, whose store runs
`compactDepartedParticipants` and `compactSettledClaims` with the registry's
own liveness fold on every append. The write that grants B's claim therefore
judges A dead and drops A's joins and its claim from the board in the same
transaction, so a later PID reuse finds nothing to revive. Running the repro
against the registry (A written with pid 111, B granted while 111 is dead,
then 111 alive again) leaves `src` held by B, and B's release succeeds.

The planned leave-on-first-death entry would duplicate what compaction already
does, so it was not added. The regression test
`a reused PID cannot revive a dead MCP participant's claim over a newer grant`
in `src/test/unit/ExecutionRootCoordination.test.ts` keeps that guarantee.

What remains is narrower and was accepted: if A's PID is reused before any
write happens, A looks alive and keeps the paths it already held until the
reusing process exits. No newer grant can exist in that window, so nothing is
revoked. The `EPERM` observer gap is unchanged.
