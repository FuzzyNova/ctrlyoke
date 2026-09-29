# Schema bump rewrites cross-schema $refs to paths the bundled extension schema cannot resolve

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `scripts/schema-bump.mjs`, `esbuild.js`
- **Resolution:** fixed in this commit

## Symptom

This is latent until the next `npm run schema:bump`. After bumping either
schema, VS Code validation and completion of `.ctrlyoke/settings.json` break
for every property that references the workflow schema (`harnessId`, `agent`,
skills, secrets, `mcpServers`, hooks, end-condition/error-behavior defaults,
…). The editor reports "Unable to load schema" for those `$ref`s.

## Steps to Reproduce

1. In a scratch copy of the repo (e.g. a temp `git worktree`), run
   `node scripts/schema-bump.mjs workflow`.
2. `schemas/settings-schema.json` now contains refs such as
   `"$ref": "../v2/workflow.json#/$defs/harnessId"` (about 20 of them). Before,
   they were `"workflow.json#/$defs/harnessId"`.
3. `node esbuild.js` copies it to `out/schemas/settings-schema.json`, which is
   what `package.json` `contributes.jsonValidation` registers for settings files.
4. VS Code resolves a relative `$ref` against the schema file's own URI, so it
   looks for `out/v2/workflow.json`. Nothing creates that file: `esbuild.js`
   only writes the local alias `out/schemas/workflow.json`. Bumping `settings`
   instead produces the same failure with `../v1/workflow.json`.

The website copy keeps working because `$id`-based resolution maps
`../v2/workflow.json` onto the published URL. The AJV tests and doc generators
strip the version path. So nothing in `npm test` catches this.

## Root Cause

`syncCrossSchemaRefs` in `scripts/schema-bump.mjs` writes versioned relative
refs (`../v<N>/<file>.json#`) that are only valid against the published URL
layout. The extension bundle (`esbuild.js` copy step) keeps the flat
`out/schemas/` layout and only aliases `workflow.json` next to the settings
schema.

## Suggested Fix

Make the bundled copy resolvable regardless of the versioned refs. The simplest
option: when `esbuild.js` copies `settings-schema.json` into `out/schemas/`,
rewrite `"(../vN/)?workflow.json#` refs to the local `workflow.json#` alias.
The extension always ships the current pair, so that is the correct target.
Alternatively, emit `out/v<N>/workflow.json` for the referenced version. Add a
test (e.g. in `scripts/schema-bump.test.mjs` or a build-level test) that bumps
a temp copy, runs the out-copy step, and asserts that every relative `$ref` in
the out copies resolves to an existing file relative to that file's path.
