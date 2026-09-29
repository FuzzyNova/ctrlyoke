# ctrlyoke tool views: harness shown as raw id (`claude-cli`) instead of display name (`Claude Code`)

- **Found:** 2026-09-29 by user, during the MCP tool-call display visual test
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/` (`WorkflowStatusView.tsx`, `workflowStatusModel.ts`, `GlobalStatusView.tsx`, `globalStatusModel.ts`, `AppendStepView.tsx`), `src/types/DashboardConstants.ts` (`HARNESS_INFO`)
- **Severity:** low

## Symptom

The Harness column in `workflow_status` shows `claude-cli`; the user-facing name is "Claude Code". The same raw ids appear in the `global_status` rows and in the `workflow_status` summary line, and an explicit `harness` on an `append_step` step is shown as the id as well.

## Steps to Reproduce

1. Call `mcp__ctrlyoke__workflow_status` in a `claude-cli` workflow.
2. The Harness column reads `claude-cli`.

## Root Cause

The views render whatever string the tool returned:

- `WorkflowStatusView.tsx:97,116` uses `status.metadata.harness ?? "workflow harness"` directly.
- `workflowStatusModel.ts:92,104,127` puts the raw id in the summary and search text.
- `GlobalStatusView.tsx:59` and `globalStatusModel.ts:100` do the same with `workflow.harness`.
- `AppendStepView.tsx:100-102` joins `step.harness` and `step.model` raw.

`HARNESS_INFO` in `src/types/DashboardConstants.ts` already maps each harness id to `name` / `shortName`, and `list_harnesses` results already carry a `displayName`, but none of these views use the map. There is also no shared "id to display name" helper on the webview side: `src/cli.ts:2328` and `src/types/CompatibilityTypes.ts:248` each inline `HARNESS_INFO[id]?.name ?? id`.

## Suggested Fix

Add one shared helper (for example `getHarnessDisplayName(id)` next to `HARNESS_INFO`, falling back to the raw id for unknown values) and use it in these views and their model summary/search text, so find-in-output matches what is displayed. Point `cli.ts` and `CompatibilityTypes.ts` at the same helper. Use `shortName` where space is tight (e.g. the narrow Harness column). Note that ids for unknown or future harnesses must still render as-is.
