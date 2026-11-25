# Run bundle import skips the inner files' schema-version checks and restamps them

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced against `out/`)
- **Area:** `src/core/orchestration/RunBundleReader.ts`, `src/core/orchestration/RunBundleImporter.ts`, `src/utils/PersistedSchemaGuard.ts`
- **Severity:** medium (latent until the next workflow-definition or timeline format bump; then a silent downgrade of imported runs)

## Symptom

Importing a run bundle checks only the bundle's own `run.json`
`schemaVersion`. A bundle whose `workflow.ctrlyoke.json` declares a newer
workflow-definition format, or whose `manifest.json` declares a newer timeline
format, is imported as if it were current:

- the imported run file's top-level `schemaVersion` is rewritten to this
  build's `WORKFLOW_DEFINITION` version (1) while its content keeps the newer
  fields;
- a fresh current-format timeline manifest is created and the bundle's events
  are appended to it.

Every other read path refuses newer files (`normalizeParsedWorkingFile` in
`WorkingFileManager.ts`, `PromptFileParser.ts`), which is the contract in
`CLAUDE.md`: a file written by a newer ctrlyoke stays read-only.
`RUN_BUNDLE_SCHEMA_VERSION` is not tied to the inner formats and
`scripts/schema-bump.mjs` does not bump it, so the first future format bump
lets a newer exporter's bundle be relabeled as format 1 by an older importer.

## Steps to Reproduce

Probe (workspace history mode): a bundle with `run.json` bundle schema 2,
`workflow.ctrlyoke.json` = `{ "schemaVersion": 2, "steps": [{ "prompt": "x", "futureField": 1 }] }`
and `manifest.json` `schemaVersion: 99`.

- Actual: `imported`; run file top-level `schemaVersion: 1`, `futureField`
  kept; timeline manifest `schemaVersion: 3`.
- Expected: refused with `NewerSchemaError` (CLI exit 2), like opening that
  workflow file or a newer run directly.

## Root Cause

- `readRunBundleHeader` (`src/core/orchestration/RunBundleReader.ts` ~95-115)
  validates only `manifest.schemaVersion` of `run.json`.
- `RunBundleImporter.importRun` (~125-300) and `RunMaterializer`
  (~101-131) never check the inner definition/run/timeline versions.
- `prepareRunFileForWrite` (`src/utils/PersistedSchemaGuard.ts` ~211-235)
  asserts only `_runtime` and unconditionally overwrites the top-level
  `schemaVersion`, so no writer notices a newer definition.

## Suggested Fix

In `readRunBundleHeader`, before any state is allocated, call
`assertWritableSchema` for `WORKFLOW_DEFINITION` on the bundled definition and
run file, `RUN_FILE` on the run file's `_runtime`, and `TIMELINE` on the
bundled timeline manifest. Also make `prepareRunFileForWrite` assert
`WORKFLOW_DEFINITION` on the top-level `schemaVersion` so no writer can
restamp a newer definition. Add fixture tests for each refused version.
