# MCP docs tell agents to include the running step in `reorder_steps`, which the handler rejects

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `docs/reference/mcp-tools.md` (Step mutations)
- **Resolution:** fixed in this commit

## Symptom

`docs/reference/mcp-tools.md` says: "`reorder_steps` takes `indices`: all
pending steps' absolute zero-based indices in the desired execution order.
When a step is running, include it first in that order."

Following that fails. With run state `[completed, running(1), pending(2), pending(3)]`,
`reorder_steps {indices: [1, 3, 2]}` returns
`Error: Reorder indices must contain exactly 2 not-yet-started step indices (2, 3)`.
The tool's own description (`McpToolDefinitions.ts`) correctly says to list
every not-yet-started step. Reproduced with a temporary test.

## Steps to Reproduce

1. While a step is running, call `reorder_steps` with the running index first,
   as the docs instruct.
2. Observe the error.

## Root Cause

`RunContinuationService.reorderStepsAtRun` treats running and started steps as
fixed and requires `indices` to be exactly the not-yet-started set. The docs
line is stale.

## Suggested Fix

Change the docs line to: list only not-yet-started steps; never include running
or completed steps. Also, the CLI error for a run with nothing pending reads
"must contain exactly 0 not-yet-started step indices ()". Consider a clearer
"no steps are pending, so there is nothing to reorder" message in
`reorderStepsAtRun` (shared by MCP and `ctrlyoke step reorder`).
