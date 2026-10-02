# A participant's own overlapping claim hides another participant's conflicting claim

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli) reading `ExecutionRootCoordination.ts`; reproduced with a `CoordinationParticipantRegistry` script
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`CoordinationParticipantRegistry.claimPaths`, `foldCoordinationEntries`)
- **Severity:** medium

## Symptom

`claim_paths` grants a claim that overlaps a path another live participant
already holds, as long as the caller itself holds some *other* claim that
overlaps the new path and was recorded earlier. Both participants then appear
to own the overlapping files, and the advisory board no longer warns the second
agent away from them.

## Steps to Reproduce

1. Participant A claims `src/a.ts` (granted).
2. Participant B claims `src/b.ts` (granted).
3. Participant A claims `src`.
4. Expected: denied, owner B (`src` contains B's `src/b.ts`).
5. Actual: `{ granted: ["src"], denied: [] }`. The fold now holds
   `src/a.ts` (A), `src/b.ts` (B) and `src` (A), so A's directory claim covers B's file.

Reproduced on 2026-10-01 against HEAD `b83951218` with a small `tsx` script driving
`CoordinationParticipantRegistry` (two MCP participants, the sequence above).

## Root Cause

Both conflict checks take the **first** overlapping claim, then only compare
its owner:

- `claimPaths` (~line 886):
  ```ts
  const owner = fold.claims.find((claim) => pathsOverlap(claim.path, claimPath))?.owner;
  if (owner && owner.participantId !== participant.participantId) { denied… } else { granted… }
  ```
- `foldCoordinationEntries` (~line 397) has the same `find(...)` followed by an
  owner comparison when it replays CLAIM entries.

Claims come back in insertion order, so if the caller's own overlapping claim
(`src/a.ts`) comes first, `find` stops there and never sees B's `src/b.ts`.
The fold replay repeats the same mistake, so the granted entry is also accepted
when the log is folded later. Ordering decides the outcome: if B's claim had
come first, A would have been denied.

## Suggested Fix

Search for a conflicting claim (one that overlaps **and** has a different
owner) rather than the first overlapping claim. Put this in one helper used by
both `claimPaths` and `foldCoordinationEntries`, so the live check and the
replay can't drift, e.g.
`findConflictingClaim(claims, path, participantId): CoordinationClaim | undefined`.
Add regression tests in `src/test/unit/ExecutionRootCoordination.test.ts`:
the repro above (both via the registry and via `foldCoordinationEntries` over
hand-built entries), the same scenario with globs (`src/*.ts` vs `src/b.ts`), and a
check that re-claiming a path overlapping only your own claims is still granted.
