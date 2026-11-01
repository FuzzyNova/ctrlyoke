# `append_step` docs say a numeric position inserts before that step, but positions inside a parallel group land after the group

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `docs/reference/mcp-tools.md`, `src/utils/McpToolDefinitions.ts`, `CHANGELOG.md`
- **Severity:** low

## Symptom

- `docs/reference/mcp-tools.md:52` says a numeric `position` is "a zero-based
  index — insert before that step".
- The `append_step` tool's own `position` description
  (`src/utils/McpToolDefinitions.ts:446`), which every agent reads, says the
  same: "a zero-based step index to insert them before that step".

But a numeric position that falls inside a parallel group is relocated after
the whole group. With a group at steps 2-4, `position: 3` inserts at index 5.
Agents planning around the documented behavior misplace steps and can't tell
why.

The `[Unreleased]` changelog entry (added in ~3ce39d144) says this happens
for positions "inside a running parallel group". The code relocates for
**any** parallel group, running or not, so that entry is also inaccurate.

## Steps to Reproduce

1. Have a workflow with a parallel group at steps 2-4 (pending or running).
2. Call `append_step` with `position: 3`.
3. The step lands at index 5, after the group, not before step 3.

## Root Cause

`RunContinuationService.appendStepsToRun`
(`src/core/orchestration/RunContinuationService.ts:463-494`) resolves numeric
positions through `resolveParallelGroupInsertIndex(...,
PARALLEL_GROUP_INSERT_POSITIONS.AFTER)`, which moves any index with
`group.startIndex < index <= group.endIndex` to `group.endIndex + 1`
(`src/core/ParallelGroupTopology.ts:270-305`). The docs and tool description
predate or ignore that relocation.

## Suggested Fix

Update the `position` description in `McpToolDefinitions.ts` and the
`mcp-tools.md` bullet (and `docs/workflows/dynamic-workflows.md` if it
restates it) to say an index inside a parallel group inserts after that group.
Correct the `[Unreleased]` changelog wording to drop "running". Check whether a
test pins the tool description text and update it.
