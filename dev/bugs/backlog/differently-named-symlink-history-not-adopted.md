# History filed under a differently named symlink is never adopted from the real path

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ProjectStateRegistry.ts`
- **Severity:** low

## Symptom

If the repository was used through a symlink with a different basename (for
example `~/work -> ~/dev/ctrlyoke`), its history is filed under `work-<hash>`.
Opening the repo by its real path never adopts that history. That contradicts
the CHANGELOG's claim that such history "is moved to the shared location the
next time the project is opened". `ctrlyoke history relink <realPath> …` also
fails with `Source project state is missing project.json`. The problem goes away
if the user opens the repo through the symlinked path again.

## Steps to Reproduce

1. `fs.symlink(realRepo, sandbox/work)`.
2. Write `project.json` (statePath = `work`) under `legacyProjectKey(work)` with a
   `.runs/workflow/run-2026-01-02T00-00-00-000Z` folder.
3. `new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER).initialize(realRepo)`.
4. `<projectRoot>/.runs/workflow` is empty, expected `[run-2026-01-02T00-00-00-000Z]`.

## Root Cause

`findProjectHistory` (`ProjectStateRegistry.ts` ~304-308) only considers
`legacyProjectKey(stateRoot)` for the path passed in, plus keys whose slug
matches the basename of the typed path or the real path. A symlink with a
different name produces neither, so the legacy folder is never a candidate.
`relinkUserProject` calls `findProjectHistory(oldPath)` and fails the same way.

## Suggested Fix

When the slug scan finds nothing, fall back to scanning every
`<slug>-<hash12>` folder and matching `metadata.statePath` with
`statePathBelongsTo(..., canonicalRoot)`. That costs one `project.json` read per
project, under the registry lock. Record that the scan ran (for example in the
canonical `project.json`) so it happens at most once per project. If that is
not acceptable, narrow the CHANGELOG wording to "opened through the same
symlinked path".
