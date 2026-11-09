# `priorContext` schema description still documents the removed `{ workflowKey, runRef }` form

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, docs-vs-code sweep)
- **Area:** `schemas/workflow-schema.json` (`$defs.executionProperties.priorContext.description`, ~770) and its generated copies (`docs/reference/workflow-schema.md`, `src/types/generated/SchemaDescriptions.ts`, `WorkflowSchemaOutline.ts`)
- **Resolution:** fixed in this commit

## Symptom

The description (also shown in IntelliSense hovers and the generated reference page) says
"`{ workflowKey, runRef }` imports the complete terminal output from one run in this workspace".
That object fails validation: `$defs.priorContextRunSource` has `additionalProperties: false`,
`required: ["workflow"]`, and properties `workflow` and `run`. The description also omits the
`finalStepAll` / `finalStepPrevious` keywords in `priorContextKeyword`.

## Steps to Reproduce

Read the description at `schemas/workflow-schema.json:770` and compare with
`$defs.priorContextRunSource` and `$defs.priorContextKeyword`.

## Root Cause

b0aa2691c (`feat: select prior-context runs by workflow name and run number`) replaced
`{ workflowKey, runRef }` with `{ workflow, run? }` and updated `docs/workflows/context-files.md`,
but not this description.

## Suggested Fix

Rewrite the clause to describe `{ workflow, run? }` (workflow key or name; run number or run ref,
defaulting to the latest completed run — verify the exact default in the prior-context resolver)
and mention every keyword in `priorContextKeyword`. Description-only, so no schema bump; run
`npm run schema:update` and `npm run check:docs`.
