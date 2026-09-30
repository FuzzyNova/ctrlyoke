# Saving a workflow deletes another workflow's bundle assets when both share a name stem

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced by bundling the real analyzer and writer against a temp workspace
- **Area:** `src/utils/WorkflowBundleAnalyzer.ts` (`deriveAssetsDirectory` ~1013, `finalizeCopyPlan` ~679 and ~738), `src/utils/WorkflowBundleWriter.ts` (prune and empty-directory removal ~110-131)
- **Resolution:** fixed in this commit

## Symptom

`deriveAssetsDirectory` strips `.ctrlyoke.json`, `.ctrlyoke.yaml`, `.ctrlyoke.yml` and
`.prompt.md`, so `fix.ctrlyoke.yaml`, `fix.ctrlyoke.json` and `fix.prompt.md` in one
directory all map to the same `fix.assets/`. The manifest there does not record which
workflow owns it, so Save As of any sibling treats every manifest entry it does not
itself reference as its own stale asset.

## Steps to Reproduce

1. Save As `workflows/fix.ctrlyoke.yaml` with a prompt referencing
   `@.ctrlyoke/attachments/shot.png`. This creates `workflows/fix.assets/shot.png` and a
   manifest listing it.
2. Save As a different, plain workflow (no generated references) to
   `workflows/fix.ctrlyoke.json`.
3. Approve the save (the preview only says "1 managed asset will be removed").
4. `shot.png`, the manifest and `fix.assets/` are deleted; `fix.ctrlyoke.yaml` now
   references a missing file.

The same happens when the second workflow has its own copies: every manifest entry of the
first workflow becomes a prune candidate.

## Root Cause

The assets directory is derived from the stem alone, and `pruneCandidates` is
"manifest files this save does not reference" with no ownership check.

## Suggested Fix

Give the directory an owner. Record the owning workflow's file name in the manifest
(bump `BUNDLE_MANIFEST_VERSION` if the shape changes; treat a manifest without an owner
as owned by the destination only when no other same-stem workflow file exists beside
it), and when the manifest belongs to a different workflow, don't adopt or prune it:
either block the save with a clear blocker naming the conflicting sibling, or derive a
distinct directory (e.g. keep the format suffix: `fix.ctrlyoke.json.assets/`). Blocking
is simplest and keeps existing bundle paths stable. Also skip `removeDirectoryWhenEmpty`
when this save never managed the directory. Test with a same-stem yaml/json pair.
