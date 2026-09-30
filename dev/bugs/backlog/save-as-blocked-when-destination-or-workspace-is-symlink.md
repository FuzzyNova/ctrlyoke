# Save As is blocked for a plain workflow when the destination directory or workspace root is a symlink/junction

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced with a directory junction on Windows
- **Area:** `src/utils/WorkflowBundleAnalyzer.ts` (`finalizeCopyPlan` ~672, `validateExportDirectory` ~862-886, `resolveInlineReference` ~608, `analyzeLonePromptFile` ~368)
- **Severity:** medium (save refused; no data loss)

## Symptom

1. A workflow with nothing to bundle cannot be saved into a directory reached through a
   symlink/junction: the plan gets blocker `assets-directory-symlink`, even though
   `resolveSafeExportPath` accepts the destination and nothing needs copying. The same
   happens when the workspace itself is opened through a junction and you save to
   `<root>/x.ctrlyoke.yaml`.
2. With the workspace opened through a junction (or on macOS under `/tmp` →
   `/private/tmp`), every `@.ctrlyoke/attachments/...` reference is blocked as
   `external-inline-reference`.

## Steps to Reproduce

1. Inside the workspace, create a junction `link` → `real`.
2. Save As `link/x.ctrlyoke.yaml` with a plain prompt (no `@` references).
3. Observed: blocker `assets-directory-symlink`; the save is refused.

## Root Cause

`finalizeCopyPlan` always calls `validateExportDirectory`, even when `plan.copies` is
empty, and `validateExportDirectory` rejects a symlink at the first existing ancestor of
the not-yet-created assets directory, not only at or below the assets directory. For
item 2, sources are `realpath`'d but `trustedRoots` are not, so a canonical source never
lies under a non-canonical root.

## Suggested Fix

Skip directory validation when there are no copies and no prune candidates. Only reject
a symlink at or below the assets directory itself; the realpath containment check
already covers ancestors. Compare canonical sources against `realpathRoots(trustedRoots)`
(the helper already exists). Tests with a junction/symlinked destination directory and a
symlinked workspace root.
