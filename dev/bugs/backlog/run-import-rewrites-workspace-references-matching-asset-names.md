# Run import rewrites unrelated `@file` references that share an attachment's name

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/`)
- **Area:** `src/core/orchestration/RunBundleImporter.ts` (asset placement ~405-430, `rewriteAssetReferences` ~438-451, `normalizeReferenceAssetPath` ~470-475)
- **Severity:** medium

## Symptom

Importing a run bundle silently changes prompts that reference a workspace file with
the same relative name as a bundled asset. Example: a run whose prompt is
`Compare @.ctrlyoke/attachments/README.md with @README.md`, where both files exist with
different content.

- Exported prompt: `Compare @./assets/README.md with @README.md` (correct).
- Imported prompt: `Compare @.ctrlyoke/attachments/README.md with @.ctrlyoke/attachments/README.md`.

After import, the second reference points at the attachment instead of the workspace's
`README.md`. A rerun or continue of the imported run then feeds the model the wrong file.
The rewrite is applied to every string in both the definition and `run.ctrlyoke.json`.

## Steps to Reproduce

1. In a workspace, attach a file named `README.md` (stored under `.ctrlyoke/attachments/`),
   and also have a different workspace `README.md`.
2. Run a one-step workflow whose prompt references both, as above, then
   `ctrlyoke export` it.
3. `ctrlyoke import <bundle>` into a fresh workspace and read the imported definition.
   `@README.md` has been rewritten to the attachment path.

## Root Cause

The replacement map is keyed by `normalizeReferenceAssetPath("assets/README.md")`, which
strips the `assets/` prefix to `README.md` (~416-419, ~470-475). `rewriteAssetReferences`
normalizes every parsed reference path the same way before the lookup. A plain
`@README.md`, which has no `assets/` prefix at all, therefore normalizes to the same key
and gets rewritten. The exporter always writes asset references as `@./assets/<name>`,
so only references carrying that prefix are bundle assets.

## Suggested Fix

Rewrite a reference only when its path, after removing a leading `./` and converting
backslashes, starts with `assets/`. Keep the prefix in the map keys, or check for it
before the lookup, instead of stripping it on both sides. Add a unit test in the
importer tests with an asset and a same-named workspace reference in one prompt.
