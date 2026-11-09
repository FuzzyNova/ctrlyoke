# Workspace-mode split history never merges definition anchors, so runs become untrusted

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ProjectStateRegistry.ts`
- **Severity:** medium

## Symptom

In `runHistoryLocation: workspace` mode, a project whose user-state folder was
split across a symlinked and a real path (the case 3d06f3557 fixes) keeps the
canonical folder and ignores the legacy one. Runs whose definition anchor lives
only under the legacy key then verify as `unrecorded` (untrusted, needs review).
A run whose newer anchor lives under the legacy key shows as `changed-outside`,
and restoring it brings back the stale definition. The console warning also
claims the canonical folder "has the more recent run" when neither folder has
any runs.

## Steps to Reproduce

1. Write `project.json` under both `projectKey(realRepo)` and `legacyProjectKey(linkedRepo)`.
2. Create run A in `realRepo/.ctrlyoke/.runs/workflow/`; `verifyRunDefinitionFile(runA)` → trusted (creates the baseline).
3. Create run B, `anchorRunDefinitionOnDisk(runB)`, then move its
   `.definition-anchors/workflow/<runRef>.json` from the canonical folder to the legacy-key folder.
4. `new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.WORKSPACE).initialize(linkedRepo)`.
5. `(await verifyRunDefinitionFile(runB)).verdict.status` is `unrecorded`, expected `trusted`.

## Root Cause

In workspace mode the runs live in `<repo>/.ctrlyoke/.runs`, which is the same
folder under either spelling. The definition anchors still live in the user
project folder, which releases before 3d06f3557 keyed by spelling.
`latestProjectRunTimestamp` only looks at `.runs` inside the user folder. In
workspace mode that is always empty, so both candidates have
`latestRunAt = undefined`. `compareRecency` (`ProjectStateRegistry.ts` ~356-365)
then computes `-Infinity - -Infinity = NaN`, the canonical folder always wins,
and `adoptSplitProjectHistory` returns early without merging anything.

## Suggested Fix

When neither candidate has runs in the user folder (the workspace-mode shape),
merge `.definition-anchors/**` from the legacy folder into the canonical one,
keeping the anchor with the newer `recordedAt` per file. Make `compareRecency`
return 0 instead of `NaN` when both timestamps are missing, and only print the
"more recent run" warning when a run timestamp actually decided it.
