# Bundle manifest write failure still prunes old assets

- **Found:** 2026-10-02 by bug-hunt final step (source review + temp-dir repro)
- **Area:** `src/utils/WorkflowBundleWriter.ts`
- **Resolution:** fixed in this commit

## Symptom

When "Save As" bundles a workflow and the `.ctrlyoke-assets.json` manifest
write fails (EPERM, read-only file, AV lock), the writer warns
`Could not update bundle manifest "...": ... Existing and new assets were left in place.`
It then prunes the previous save's managed assets anyway. The old manifest
stays on disk and still lists the deleted files. The newly copied assets are
not in any manifest, so ctrlyoke treats them as user-owned from then on.

## Steps to Reproduce

1. Create `wf.assets/old.png` and a read-only `wf.assets/.ctrlyoke-assets.json`
   (`owner: "wf.ctrlyoke.yaml"`, `files: ["old.png"]`).
2. Call `writeWorkflowBundle` with a plan that copies `new.png`, with
   `pruneCandidates: ["old.png"]`.
3. Observe: the warning says assets were left in place, but `old.png` is
   deleted. The manifest still reads `files: ["old.png"]`, and `new.png` is
   unmanaged.
4. On the next save, `chooseAssetName` treats `new.png` as a user file and
   writes `new-<hash8>.png`, which leaves `new.png` as a permanent orphan.

## Root Cause

In `writeWorkflowBundle` (`src/utils/WorkflowBundleWriter.ts`, about lines
86–124) the manifest `writeFileAtomic` failure is caught and turned into a
warning. Control then falls through to `pruneManagedAssets(...)`
unconditionally. Pruning is only safe once the new manifest has been published.
`ui.instructions.md` requires bundle pruning to fail safe when the manifest is
absent or invalid. The only test (`WorkflowBundleWriter.test.ts`, "warns when
manifest replacement fails…") checks the warning and the saved workflow, but
never checks pruning or what is on disk.

## Suggested Fix

Track whether the manifest write succeeded and skip `pruneManagedAssets` when
it failed, so the warning text becomes true. Extend the existing test to
assert that the prior asset still exists after a manifest write failure.
