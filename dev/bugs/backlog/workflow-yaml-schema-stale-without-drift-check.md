# Committed `workflow-schema.yaml` is stale and no check catches the drift

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `schemas/workflow-schema.yaml`, `scripts/generate-yaml-schema.mjs`, `package.json` (`check:docs`)
- **Severity:** low

## Symptom

`schemas/workflow-schema.yaml` is generated from `schemas/workflow-schema.json`
and must never be hand-edited (`.github/instructions/core.instructions.md`).
The committed copy still lists `opus[1m]` and `sonnet[1m]` in the step `model`
enum. ~23183bfeb ("discover Claude Code and Codex models at runtime") removed
both from the JSON schema but did not commit the regenerated YAML.

Because `precompile` runs `npm run generate-schema`, every `npm run compile`
rewrites the file. This leaves a working-tree change that has nothing to do
with the task at hand. An agent can commit it by accident in an unrelated
commit, or a `committed` end condition can fail on it.

Every other generated schema artifact has a `--check` mode wired into
`npm run check:docs` (`generate-schema-docs`, `generate-schema-ui-descriptions`,
`generate-workflow-schema-outline`, `generate-prompt-markdown-injection`).
`generate-yaml-schema.mjs` has none, so nothing flagged this drift.

## Steps to Reproduce

1. On a clean tree, run `npm run generate-schema`.
2. `git diff --stat` shows `schemas/workflow-schema.yaml | 2 --`: the
   `opus[1m]` and `sonnet[1m]` entries are removed.
3. `npm run check:docs` passes on the unregenerated tree.

## Root Cause

`scripts/generate-yaml-schema.mjs` writes `schemas/workflow-schema.yaml`
unconditionally and has no `--check` flag. `check:docs` in `package.json`
doesn't include it. So a schema change committed without
`npm run schema:update` leaves the YAML stale without any failure.

## Suggested Fix

1. Run `npm run generate-schema` and commit the regenerated YAML.
2. Add a `--check` mode to `scripts/generate-yaml-schema.mjs`, following the
   existing `--check` scripts such as `generate-workflow-schema-outline.mjs`.
   It should generate in memory, compare with the file on disk, print which
   file is stale and the command that fixes it, and exit non-zero without
   writing. Cover it in `scripts/generate-yaml-schema.test.mjs`.
3. Add `node scripts/generate-yaml-schema.mjs --check` to `check:docs` in
   `package.json`.
