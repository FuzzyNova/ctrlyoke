# MCP Status Reports Workflow Model for Cross-Harness Steps

- **Found:** 2026-11-08 by smell-hunt pass 3
- **Area:** `src/mcp-server.ts`
- **Resolution:** fixed in this commit

## Symptom

`workflow_status` and `append_step` reported the workflow's model for a step
running on a different harness, even though the step would use that harness's
configured model. A recorded runtime model could also be hidden by the authored
workflow value.

## Steps to Reproduce

1. Set a workflow harness and model.
2. Add a step with a different harness and no model override.
3. Call `workflow_status`; it reports the workflow model instead of the model
   configured for the step's harness.

## Root Cause

`resolveEffectiveStepSettings` in `src/mcp-server.ts` used
`step.model ?? workflow.model ?? null`, omitting runtime model precedence and
harness-scoped workflow model inheritance. `OutputHistoryManager` had the same
model fallback, while the CLI implemented the intended rule independently.

## Suggested Fix

Single-source effective step harness/model resolution in
`src/types/ExecutionPropertyResolver.ts` and use it from MCP, CLI and run-history
summary projection.
