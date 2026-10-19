# Workflow files cannot name their workflow

- **Found:** 2026-10-19 by Nathan, while retaking the landing hero
- **Area:** `schemas/workflow-schema.json`, `src/core/PromptQueue.ts`, `src/core/orchestration/PromptFileLoader.ts`
- **Resolution:** fixed in this commit

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

The lineage descriptor's `workflowName` stays the only place a workflow's name is stored at
runtime, and the heading-row rename keeps writing only there. The authored file's `name` is
copied into the descriptor on load and written back on Save:

- **Schema.** An optional root `name` on the multi-step root branch (beside `steps`), not in
  `workflowOnlyProperties`: single-step roots share those properties, and there a root `name`
  already labels the step. It has no `maxLength`, because a heading-row rename is uncapped and
  Save must never write a file that fails to load. `.prompt.md` frontmatter gets its own `name`
  (one line, cut to 100 characters like `description`).
- **Load.** `PromptFileParser` puts the name on `PromptFile.name`. `PromptFileLoader.loadPromptFile`
  sets it as the queue's name before `createWorkingFile`, which already prefers that name over
  the file stem, so it becomes the new descriptor's `workflowName`. It is never copied into the
  draft or run file. Template loads ignore it, because the template dialog supplies the name.
- **Save.** `buildAuthoredWorkflow` takes the descriptor name and writes it as the root `name`.
  Save As (and its save-path check) and the run bundle's `workflow.ctrlyoke.json` pass it; Save
  as Template does not.
- **Everywhere else** (recent workflows, history, search, MCP, notifications) already reads the
  descriptor, so nothing changes there. The CLI prints file paths, not workflow names.
- **Hero capture.** Replay (`RunReplaySession.materializeWorkflow`) writes the bundle's lineage
  name as the materialized file's root `name`, so `media/shots/hero.capture.ts` no longer renames
  the workflow in the heading row.
