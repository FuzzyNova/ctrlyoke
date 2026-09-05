# MCP Output Paging Plan

**Status:** Implemented 2026-09-05
**Priority:** P2

Harvested from the rejected [`MCP_CONTROL_SURFACE_PLAN.md`](../rejected/MCP_CONTROL_SURFACE_PLAN.md),
which was rejected for its lifecycle tools. This piece is unrelated to lifecycle
control: it is a read-path fix to a tool that already exists and stays entirely
within the current run's scope.

## Problem

The following describes the behavior before paging was implemented.

`read_output` in `src/mcp-server.ts` has no paging. A caller either names
explicit indices or gets every prompt in the run. For each requested index it
returns the full `responseText` from `RunOutputResolver.resolveLatestAttempts`.

For a long workflow this means a step that wants "what did the previous step
conclude" pulls back the entire response history into its context window. There is
no way to read a bounded tail, and no way to resume where a previous read stopped.

**Sequencing note (2026-09-05):** [`MCP_STEP_MUTATION_PLAN.md`](../backlog/MCP_STEP_MUTATION_PLAN.md)
completed the naming pass and moved every tool name behind an exported constant. This plan was
implemented against the final `read_output` tool, so the schema was edited once. Names below use
the final names.

## Scope

The implementation adds cursor-based reads to `read_output` only.

- An opaque cursor plus a caller-supplied limit, returning a `nextCursor` when
  more output remains.
- A bounded-tail mode so a caller can ask for the last N **characters** of a
  step's output without paging forward through all of it. (Characters only —
  line-based slicing was considered and dropped: it would need a second unit in
  the schema for no use case the Problem statement raises. See Design below,
  which is the authoritative definition.)
- Preserve the existing behavior when no cursor or limit is supplied, so current
  workflows are unaffected.

`RunOutputResolver` already streams the run timeline in a single bounded-memory
pass; the cursor rides that existing traversal rather than introducing a
second read path or materializing the JSONL history.

## Design

`RunOutputResolver.resolveLatestAttempts` (`src/core/orchestration/RunOutputResolver.ts`)
already does the one bounded-memory pass this plan asks for: it walks the
manifest's JSONL timeline once and, for each requested target, accumulates
`STREAMING_CHUNK` events onto `responseText` in memory as it goes
(`RunOutputResolver.ts:420-427`). By the time it returns, each resolved target
already holds its complete `responseText` string. So there is no second
traversal to add — paging is a **post-resolution slice of that string**, not a
new streaming or seeking mode. This keeps the "no additional full traversal"
acceptance criterion trivially true: the existing single pass is unchanged,
and the new logic runs only after it completes.

### Input schema additions (`read_output`)

- `cursor` (string, optional) — opaque. Internally a stringified character
  offset into the target's `responseText`; encoding is not a compatibility
  surface and may change, so it must always be passed back exactly as
  received, never constructed by the caller.
- `limit` (number, optional) — maximum characters to return starting at
  `cursor` (or at 0 when `cursor` is omitted).
- `tail` (number, optional) — return the last N characters instead of paging
  forward from `cursor`. Mutually exclusive with `cursor`/`limit`; passing
  `tail` with either of the others is a validation error.

**All three are valid only when `indices` names exactly one step.** The
Problem statement's use case is "what did the previous step conclude" —
one step, a potentially-huge response. Paging N steps' outputs at once has
no motivating use case here, and would force an opaque per-index cursor
encoding (e.g. a JSON map of index → offset) for a caller need that doesn't
exist. If `indices` has zero or more than one entry and any of `cursor`,
`limit`, or `tail` is supplied, the tool returns a validation error rather
than silently ignoring the paging arguments.

### Behavior

- No `cursor`/`limit`/`tail` supplied: reproduces today's response exactly
  (full `responseText`, no `nextCursor` field) — this is the existing
  multi-index path and is unaffected by any of the above.
- `tail: N`: `responseText` becomes `fullText.slice(-N)`. No `nextCursor` —
  tail reads are not resumable by design (there's nothing "after" the tail).
- `cursor`/`limit` (single index only): `responseText` becomes
  `fullText.slice(offset, offset + limit)`, where `offset` is `0` or the
  decoded `cursor`. If `offset + limit < fullText.length`, the response
  includes `nextCursor` encoding `offset + limit`; otherwise `nextCursor` is
  omitted, signaling the caller has reached the end.
- `limit` without `cursor`: reads the first `limit` characters, same
  `nextCursor` rule as above. `cursor` without `limit`: reads to the end from
  that offset (no further `nextCursor`).

### Response shape

Each entry in `outputs[]` gains an optional `nextCursor: string` field,
present only when the slice returned did not reach the end of that step's
`responseText`. Everything else in the existing response is unchanged.

## Non-goals

- No new tools. This modifies one existing tool's input/output schema.
- No cross-workflow or cross-run reads, and no new addressing input. The tool
  reads whichever run `resolveRun` returns from `CTRLYOKE_WORKING_FILE`; a
  cursor is a position within that run's output, never a way to name another
  one. See the scoping constraint in
  `.github/instructions/extension.instructions.md`.
- No lifecycle control of any kind.

## Acceptance criteria

- A caller can read a bounded slice of one step's output and resume from a cursor.
- Omitting the new parameters reproduces today's response exactly.
- The implementation adds no additional full traversal of the run timeline.
