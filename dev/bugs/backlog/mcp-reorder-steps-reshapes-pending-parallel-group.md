# `reorder_steps` changes which steps belong to a pending parallel group, and its contract says "pending" but requires the running step

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`reorderStepsAtRun`), `src/core/ParallelGroupTopology.ts`, `src/types/McpToolDefinitions.ts` (`reorder_steps` description), `src/cli/StepCommands.ts`
- **Severity:** high

## Symptom

**Group membership is reshuffled.** Queue `[done, inflight, g1, g2, tail]` with
`parallelGroups: [{id:"G",startIndex:2,endIndex:3}]`:

- `reorder_steps {"indices":[1,4,2,3]}` ("run tail, then the group") reports success. The order
  becomes `[done, inflight, tail, g1, g2]`, but `G` stays at 2..3, so `G` is now `{tail, g1}` and
  `g2` runs alone afterwards.
- `[1,2,4,3]` pulls `tail` into `G` and pushes `g2` out.

Expected: groups move as whole blocks, so `G = {g1, g2}` at 3..4.

**The contract is wrong.** The tool description (and the skill text generated from it) says
"Provide every pending step's zero-based index". Following it with the running step at index 1
(`{"indices":[4,3,2]}`) fails with "Pending reorder must contain exactly 4 indices". Only
`[1,4,3,2]`, which includes the running step, succeeds, and the error message doesn't explain why.

Both reproduced with `node out/mcp-server.js --tool reorder_steps` against a scratch run with a
live runner lock.

## Steps to Reproduce

1. Run a workflow whose queue has a pending parallel group followed by another pending step.
2. Call `reorder_steps` to move the trailing step before the group.
3. Read the run file: `parallelGroups` still points at the old slots, which now hold different
   steps.

## Root Cause

When the caller passes no group ranges, `reorderStepsAtRun` computes
`pendingGroups ?? buildPendingGroupRanges(...)` (`RunContinuationService.ts:~1028-1029`) from the
current positions and goes down `reorderPendingTopologyWithRanges`, which treats groups as fixed
slots. The block-preserving path in `ParallelGroupTopology.ts:~612-668` is never reached from the MCP
or CLI (`StepCommands.ts:~149`) callers. Separately, the count check (`ParallelGroupTopology.ts:~553`)
counts the running head as "pending", which contradicts `McpToolDefinitions.ts:~419-432`.

## Suggested Fix

- For callers that pass only indices (MCP, CLI), use the block-preserving reorder so a complete
  group moves as one unit. Keep the slot-based ranges only for the dashboard, which sends explicit
  ranges on purpose.
- Make the contract consistent: accept the indices of not-yet-started steps and add the running
  head(s) internally, or fix the description and name the exact expected index set in the error.
  Prefer the former. Update `McpServer.test.ts` expectations accordingly.
- Tests: moving a trailing step before a group keeps the group's members, and reorder with only
  not-started indices succeeds.
