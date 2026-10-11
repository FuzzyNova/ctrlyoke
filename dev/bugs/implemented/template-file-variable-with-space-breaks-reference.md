# A picked template file path containing a space breaks the `@{file:name}` reference, so the spec is never attached

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script through `TemplateManager.createWorkflow` and `parseAtReferences`)
- **Area:** `src/core/TemplateManager.ts` (`replaceVariables`)
- **Resolution:** fixed in this commit

## Symptom

Create a workflow from the Spec-Driven Loop or Template Starter template and
pick a spec file whose path contains a space, e.g. `docs/my spec.md`. The
generated prompt contains `@docs/my spec.md`. An unquoted `@` reference stops
at whitespace, so the runtime attaches `docs/my` (missing) and the spec is
silently dropped. `docs/workflows/templates.md` promises that `@{file:name}`
"becomes a normal file reference".

## Steps to Reproduce

1. `TemplateManager.createWorkflow("spec-driven-loop", { specFile: "docs/my spec.md" })`.
2. The prompt line is `@docs/my spec.md`; `parseAtReferences(prompt)` returns
   `['docs/my']`.
3. Expected: `@"docs/my spec.md"`, which resolves to the file.

## Root Cause

`TemplateManager.replaceVariables` (~502-507) substitutes the raw value for
every placeholder. The picked workspace-relative path is passed through
unquoted by `TemplateModal.tsx` (`applyPickedPath`) and the
`TEMPLATE_FILE_SELECTED` handling in `WorkflowSerializer.ts`. Reference
quoting is never applied.

## Suggested Fix

In `replaceVariables`, when a placeholder is immediately preceded by `@`,
emit the value through `quoteReferencePath()` from
`src/completions/ContextReferenceBuilder.ts` (the single source for reference
quoting). Leave non-reference uses (scripts, prose) raw. Make sure this still
composes with the YAML-safe value substitution (`substituteVariablesInValues`)
so a quoted path inside a YAML scalar stays valid YAML. Tests in
`src/test/unit/TemplateManager.test.ts`: a `specFile` with a space yields a
prompt whose `parseAtReferences` returns the full path; also an `@{dir}`
directory variable with a space.
