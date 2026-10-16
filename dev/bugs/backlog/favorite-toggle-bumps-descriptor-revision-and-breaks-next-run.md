# Toggling a workflow favorite bumps its revision and makes the next Run fail

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (reproduced at the repository level with a scratch script against `out/`)
- **Area:** `src/ui/WorkflowSerializer.ts`, `src/core/orchestration/WorkflowLineageRepository.ts`, `src/ui/WebviewMessageRouter.ts`
- **Severity:** medium

## Symptom

Open a workflow, star (or unstar) it in the recent-workflows list, then press
Run, Re-run, Continue, Start new run, or Set start position. The action fails
with `Descriptor revision conflict: expected N, found N+1`. Retrying works once
the client has picked up the new revision some other way.

A timing variant: starring a lineage between `allocateRun` and
`finalizeAllocatedRun` makes publishing fail with
`Descriptor revision conflict while publishing run`, so the run does not start
and a `.creating-*` directory is left behind.

## Steps to Reproduce

1. Client holds `descriptorRevision` 1.
2. Toggle favorite → disk revision is now 2.
3. Run with the client's revision → `Descriptor revision conflict: expected 1, found 2`.

## Root Cause

- `WorkflowSerializer.handleToggleFavorite` (around line 1429) calls
  `WorkflowLineageRepository.updateDescriptor` (around line 559), which always
  writes `revision: descriptor.revision + 1`.
- The `TOGGLE_WORKFLOW_FAVORITE` handler in `WebviewMessageRouter.ts` (around
  line 2105) never republishes the client's view identity, unlike the rename
  handler just above it (`publishViewIdentity`), and the write is not recorded
  in `DefinitionAuthorLedger`.
- `Header.tsx` / `workflowMutation.ts` then send the stale revision as
  `expectedDescriptorRevision`, and `RunLifecycleService.executeDraftAtAddress`,
  `seedNewRun` etc. reject it.

## Suggested Fix

Favorite is display-only metadata and should not participate in optimistic
concurrency: give `updateDescriptor` (or a dedicated metadata-only method used
for favorite) a path that does not bump `revision`. Check every other
`updateDescriptor` caller and keep bumping only where the definition-relevant
content changes. Add a test that a favorite toggle leaves the revision unchanged
and a subsequent run with the prior revision succeeds.
