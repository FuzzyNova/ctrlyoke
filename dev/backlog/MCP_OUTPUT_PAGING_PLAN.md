# MCP Output Paging Plan

**Status:** Proposed
**Priority:** P2

Harvested from the rejected [`MCP_CONTROL_SURFACE_PLAN.md`](../rejected/MCP_CONTROL_SURFACE_PLAN.md),
which was rejected for its lifecycle tools. This piece is unrelated to lifecycle
control: it is a read-path fix to a tool that already exists and stays entirely
within the current run's scope.

## Problem

`ctrlyoke_read_output` in `src/mcp-server.ts` has no paging. A caller either names
explicit indices or gets every prompt in the run. For each requested index it
returns the full `responseText` from `RunOutputResolver.resolveLatestAttempts`.

For a long workflow this means a step that wants "what did the previous step
conclude" pulls back the entire response history into its context window. There is
no way to read a bounded tail, and no way to resume where a previous read stopped.

## Scope

Add cursor-based reads to `ctrlyoke_read_output` only.

- An opaque cursor plus a caller-supplied limit, returning a `nextCursor` when
  more output remains.
- A bounded-tail mode so a caller can ask for the last N characters/lines of a
  step's output without paging forward through all of it.
- Preserve the existing behavior when no cursor or limit is supplied, so current
  workflows are unaffected.

`RunOutputResolver` already streams the run timeline in a single bounded-memory
pass; the cursor should ride that existing traversal rather than introducing a
second read path or materializing the JSONL history.

## Non-goals

- No new tools. This modifies one existing tool's input/output schema.
- No cross-workflow or cross-run reads. The tool stays bound by
  `resolveSelectedRun`'s pin/selector contract — see the scoping constraint in
  `.github/instructions/extension.instructions.md`.
- No lifecycle control of any kind.

## Coordination

The VS Code LM twin of this tool is registered in `src/extension.ts`
(`registerLanguageModelTools`). Keep the two schemas aligned when this lands.

## Acceptance criteria

- A caller can read a bounded slice of one step's output and resume from a cursor.
- Omitting the new parameters reproduces today's response exactly.
- The implementation adds no additional full traversal of the run timeline.
- MCP and LM tool schemas stay in sync.
