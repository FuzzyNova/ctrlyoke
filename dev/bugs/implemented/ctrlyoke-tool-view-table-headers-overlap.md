# ctrlyoke tool views: table header labels overlap and columns are poorly distributed

- **Found:** 2026-09-29 by user, during the MCP tool-call display visual test
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/WorkflowStatusView.tsx`, `AppendStepView.tsx`
- **Resolution:** fixed in this commit

## Symptom

- `workflow_status` header renders `Sta` + `Name` overlapping ("StaName"); the "Status" label collides with "Name".
- `append_step` header renders `PositionName` run together; "Position" collides with "Name".
- Column widths don't fit the content. In `workflow_status` the Harness column takes half the table width even though every row is a single short value (`claude-cli`), squeezing the Name column so prompts wrap into tall cells. In `append_step` the Harness / model column is a fixed quarter of the width for a value like `Workflow default`, while the Prompt column, which needs the space, gets what is left.

## Steps to Reproduce

1. Run a workflow whose step calls `mcp__ctrlyoke__workflow_status` and `mcp__ctrlyoke__append_step`.
2. Look at the tool-call rows in the output pane.
3. Header labels overlap the next column's header, and the Harness columns are much wider than their content.

## Root Cause

Both tables use `table-fixed`, which sizes columns from the first row's declared widths and splits any leftover width equally among columns with no width.

- `WorkflowStatusView.tsx:84-87`: `#` is `w-8`, Status is `w-5` (1.25rem, sized for an icon but the header is the word "Status"), and Name and Harness have no width, so they split the remainder 50/50.
- `AppendStepView.tsx:71-74`: Position is `w-14` (3.5rem), too narrow for "Position"; Name is `w-1/5`, Harness / model is `w-1/4`, and Prompt takes the rest.

With `table-fixed`, overflowing header text spills into the next cell instead of widening the column.

## Suggested Fix

- Give short-content columns (`#`, Status, Harness) a fixed or content-fit width and let Name / Prompt take the remaining space (e.g. `w-px whitespace-nowrap` on the narrow columns, or drop `table-fixed` so the browser sizes them from content).
- Shorten the headers (`#` for Position; an icon-only header with `aria-label` for Status) or clip an over-long header with `truncate` instead of letting it overlap.
- Check the other `ctrlyoke-tools` tables at narrow widths too.
