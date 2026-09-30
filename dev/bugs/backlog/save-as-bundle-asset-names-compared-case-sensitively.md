# Save As bundle compares asset names case-sensitively, so case-only collisions overwrite or delete files

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced by bundling the real analyzer and writer against temp workspaces on Windows
- **Area:** `src/utils/WorkflowBundleAnalyzer.ts` (`getExistingNames` ~1004, `chooseAssetName` ~827, `managedNames`/`pruneCandidates` in `finalizeCopyPlan` ~733), `src/utils/WorkflowBundleWriter.ts` (`isSerializedReference` ~205, prune `unlink` ~176)
- **Severity:** high (data loss on Windows and default macOS; the saved workflow can point at a missing or wrong file with no warning)

## Symptom

Save As copies generated-store references (`.ctrlyoke/attachments/`, `.ctrlyoke/prompts/`)
into a sibling `<workflow>.assets/` directory. Every name comparison in that flow is
case-sensitive, but NTFS and default APFS are not. There are three results, all reproduced:

1. **A user's own file is overwritten.** `fix.assets/Notes.txt` ("USER OWNED", no
   manifest entry) plus a source `.ctrlyoke/attachments/notes.txt`. The plan picks
   `notes.txt` because `existingNames.has("notes.txt")` is false, and the staged rename
   replaces `Notes.txt`. The design says an unmanifested file is never overwritten; a
   hash-suffixed name should have been chosen.
2. **Save deletes the asset it just published.** `fix.assets/` holds `Notes.txt` with a
   manifest `["Notes.txt"]`. The new source is `notes.txt` with different content. The
   writer publishes `notes.txt` (over `Notes.txt`, the same file). `Notes.txt` is still a
   prune candidate because `managedNames` has `notes.txt`, not `Notes.txt`, and the
   case-sensitive `isSerializedReference` misses it too, so the writer `unlink`s
   `Notes.txt`, deleting the new asset. End state: only the manifest (listing
   `notes.txt`), the prompt references `@./fix.assets/notes.txt`, the file is missing,
   `warnings` is empty.
3. **Two different sources collapse into one file.** Prompt
   `one @.ctrlyoke/attachments/Notes.md two @.ctrlyoke/prompts/notes.md` with different
   contents ("AAA"/"BBB"). `usedNames` treats `Notes.md` and `notes.md` as distinct, the
   refs become `./wf.assets/Notes.md` and `./wf.assets/notes.md`, and the second rename
   overwrites the first: both references load "BBB".

## Steps to Reproduce

See the three setups above; save each with Save As to `workflows/fix.ctrlyoke.json`
(or `wf.ctrlyoke.json`) on Windows.

## Root Cause

`getExistingNames`, `chooseAssetName`'s `usedNames`/`existingNames`/`managedNames` sets,
the `managedNames` filter that builds `pruneCandidates`, and the writer's
`isSerializedReference` all compare raw strings.

## Suggested Fix

Fold names for comparison on case-insensitive platforms with the existing shared helper
(`foldPathForCompare`/`PathCasing`), keeping the original spelling for what is written:
key `usedNames`, `existingNames` and the manifest set by the folded name, and build
`pruneCandidates` by folded comparison. As defense in depth, have the writer skip a prune
target that resolves to the same file as any destination published in this save
(folded path compare, or `dev`/`ino`). Tests (they only fail on a case-insensitive
filesystem, which is the Windows/macOS CI and dev machines): one per case above.
