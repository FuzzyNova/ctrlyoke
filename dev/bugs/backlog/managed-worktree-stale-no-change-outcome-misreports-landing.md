# A landed managed-worktree continuation is reported as "no-changes" after a kept no-change turn

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against the real `WorktreeManager`)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`completeManagedNoChange`, landed path of `completeManagedRun`, `removeAfterLanding`)
- **Severity:** medium

## Symptom

Turn 1 of a managed-worktree run makes no changes and settles with
`keep: true`. A continuation (append run) of the same run then makes changes
and settles without keep. That settlement returns and persists
`landingOutcome: "no-changes"` with the message "Managed no-change branch
changed before deletion; it was kept.", although it actually landed
(`autoCommitted: true`, `changedFileCount: 1`, the branch tip is the new
commit). The LANDED runtime state written a moment earlier is overwritten with
NO_CHANGES, and the ownership record keeps `recoveryOutcome: "no-changes"`
permanently, which is then copied into later `WorktreeInfo`s.

## Steps to Reproduce

1. `ensureManagedWorktree` for runRef `run-1` in a scratch repo.
2. `completeManagedRun(info, { keep: true })` with no edits → `no-changes`, kept.
3. Release the lease, then `ensureManagedWorktree` again with the same identity
   (the append continuation).
4. Write `second.txt` in the worktree and `completeManagedRun(info, {})`.
5. Result: `{"landingOutcome":"no-changes","autoCommitted":true,"changedFileCount":1,"message":"Managed no-change branch changed before deletion; it was kept."}`;
   the record still has `recoveryOutcome: "no-changes"`.

Without `keep` on turn 1 the no-change turn deletes the branch and the record
field does not survive, so only the kept case triggers this.

## Root Cause

- `completeManagedNoChange` (keep branch, `WorktreeManager.ts` ~1200) persists
  `recoveryOutcome: NO_CHANGES` on the record; nothing ever clears it.
- The landed path in `completeManagedRun` builds
  `landedRecord = { ...record, ... }` (~806-813), carrying the stale field.
- `removeAfterLanding` (~1259, ~1275, ~1296, ~1320-1323) infers the reported
  outcome, and whether to run no-change branch deletion, from
  `record.recoveryOutcome === NO_CHANGES`, so a real landing is treated as
  no-change. (The `keep: true` landed return hard-codes LANDED, so only the
  remove-directory path misreports.)

## Suggested Fix

Clear `recoveryOutcome` when building `landedRecord`, and preferably make
`removeAfterLanding` take the landing outcome as an explicit parameter instead
of inferring it from a persisted record field. Optionally also clear it when
`ensureManagedWorktree` re-provisions the record to READY.

Test in `src/test/unit/WorktreeManager.test.ts`, mirroring "settles a
no-change append after a landed turn without deleting its branch": a kept
no-change turn, then an append with changes and no keep → `landingOutcome ===
"landed"`, branch not deleted, and no `recoveryOutcome` on the record.
