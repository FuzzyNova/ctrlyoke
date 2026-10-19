# Workflow files cannot name their workflow

- **Found:** 2026-10-19 by Nathan, while retaking the landing hero
- **Area:** `schemas/workflow-schema.json`, `src/core/PromptQueue.ts`, `src/core/orchestration/PromptFileLoader.ts`
- **Severity:** high (pre-release: authors of `.ctrlyoke.yaml` files have no way to set the title they see)

## Symptom

Loading `.ctrlyoke/workflows/notes-tagging-and-search-api.ctrlyoke.json` shows
`notes-tagging-and-search-api` in the heading row. Someone editing the file has nothing to write
in it that changes that. Steps don't have this problem, because a step's `name` is shown
throughout the dashboard.

## Steps to Reproduce

1. Write a workflow file `my-flow.ctrlyoke.yaml` with any steps.
2. Load it in the dashboard (Open workflow menu → Load from File...).
3. The heading row shows `my-flow`. The only way to change it is the heading row's
   "Edit workflow name", and that name never reaches the file.

## Root Cause

- The schema has no workflow-level name. `workflowOnlyProperties` holds `maxSteps`, `worktree`,
  `vars`, `trustedExternalRoots` and similar; only steps (`promptStep`/`scriptStep`) and
  `_templateMeta` (the template picker's label) have a `name`.
- On load, `PromptFileLoader` passes the file name as `displayName`, and
  `PromptQueue.createWorkingFile` derives the workflow name from it
  (`PromptQueue.extractWorkflowName`, which strips `.ctrlyoke.json/.yaml/.yml` and `.prompt.md`).
- A rename in the heading row goes to the lineage descriptor (`workflow.json` in run storage,
  `syncWorkflowName`), not to the authored file, so it is lost when the file is loaded fresh,
  shared or committed.

## Suggested Fix

- Add an optional root `name` (display name, like a step's `name`, with the same `maxLength`)
  to `workflowOnlyProperties`, and `npm run schema:update`. `.prompt.md` frontmatter needs the
  same field, or a reuse of `description`.
- On load, prefer the file's `name` over the file stem. Decide what a heading-row rename does:
  writing it back to the authored file is the least surprising, since that file is what the
  author edits.
- Keep it consistent everywhere a workflow name shows: recent workflows, history, CLI output,
  MCP, and the run bundle (`RunBundleExporter` exports the lineage name today).
- The hero capture renames the workflow in the heading row before recording
  (`media/shots/hero.capture.ts`), which this would replace with a `name` in the fixture.
