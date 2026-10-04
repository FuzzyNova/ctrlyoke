# `reorder_steps` quietly overrides an order that splits a parallel group and can falsely report "already matched"

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`reorderStepsAtRun` ~887-956), `src/core/ParallelGroupTopology.ts` (~627-665), `src/mcp-server.ts` (`mutationResponse` ~1399-1413)
- **Resolution:** fixed in this commit

## Symptom

Take a queue `[done, inflight(running), g1, g2, tail]`, where parallel group
`G` covers indices 2..3. This was reproduced against a temporary run file:

| `indices` sent | Effective result | MCP response |
| --- | --- | --- |
| `[2,4,3]` (g1, tail, g2) | unchanged `[…, g1, g2, tail]` | `changed:false` with the note "the step list already matched what you asked for", which is false |
| `[3,4,2]` (g2, tail, g1) | `[…, g2, g1, tail]` | `success:true, changed:true`, although tail was not placed between the members |

## Root Cause

`reorderStepsAtRun` only checks that `indices` is a permutation of the
unstarted steps. With no explicit group ranges, which is always the case for
MCP and the CLI, the topology helper moves a whole group to the position of
its first-listed member and moves any interleaved steps after it. Nothing
reports that the request was changed. `mutationResponse` derives its
"already matched" note purely from the revision being unchanged.

Moving groups as whole blocks is intentional (see
`dev/bugs/implemented/mcp-reorder-steps-reshapes-pending-parallel-group.md`).
The bug is that the caller is never told.

## Suggested Fix

Choose one:

- reject an order that splits a group's members, with an error that names
  the group and its indices; or
- return the effective order and say when it differs from the request.

Either way, emit the "already matched" note only when the request really
matched. Not queued, because this is a behaviour decision.

## Decision

Decided 2026-10-03 by Nathan: reject. `reorderStepsAtRun` refuses an order that puts any other step between a parallel group's members, with an error that names the group and its member indices, and changes nothing. A valid order that moves a whole group stays allowed. Show `mutationResponse`'s "already matched" note only when the requested order equals the current order, not just because the revision is unchanged. CLI and dashboard reorder paths that send explicit group ranges keep their current behaviour, and they should go through the same validation.
