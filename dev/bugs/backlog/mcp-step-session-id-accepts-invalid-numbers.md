# MCP `append_step`/`edit_step` accept any number as `sessionId`; a fractional one crashes session resolution

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/McpToolDefinitions.ts`, `src/mcp-server.ts` (`handleAppendStep`, `handleStepEdit`), `src/utils/SessionResolver.ts` (`resolveNumericReference`)
- **Severity:** medium

## Symptom

A numeric `sessionId` is a 1-based step number. The workflow schema allows it
only as an integer of at least 1 (`schemas/workflow-schema.json`,
`executionProperties.sessionId`), so a workflow file can't contain any other
number. The MCP tools persist any number:

- `sessionId: 1.5` is persisted. When the step dispatches,
  `SessionResolver.resolveNumericReference` computes `refIndex = 0.5`. That
  passes the bounds check, `allPrompts[0.5]` is `undefined`, and the next line
  throws `TypeError: Cannot read properties of undefined (reading '_runtime')`
  on the dispatch path (`WorkflowExecutor.resolveResumedAiSessionId`).
- `sessionId: 0`, or a later or out-of-range step such as `99`, is persisted.
  The step then quietly starts a new session (the executor resolves with
  `logWarnings = false`), while the `append_step` response's
  `effectiveSettings` reports `resumeSession: true`.

## Steps to Reproduce

1. In a running workflow with two steps, call `append_step` with
   `position: "end"` and steps
   `{ prompt: "a", sessionId: 1.5, resumeSession: true }`,
   `{ prompt: "b", sessionId: 0, resumeSession: true }`.
2. The call succeeds and the working file stores `sessionId: 1.5` and `0`.
3. Call `SessionResolver.resolve` for the first appended step (or let it
   dispatch): it throws `Cannot read properties of undefined (reading
'_runtime')`.

## Root Cause

- `src/utils/McpToolDefinitions.ts` (around lines 285-289): the append schema
  declares `sessionId: { type: "number" }` with no integer check or minimum.
  `edit_step` (around lines 345-348) takes `string | number`.
  `McpSchemaValidator` has no `integer` type, so neither would be enforced
  anyway.
- `handleAppendStep` / `handleStepEdit` (`src/mcp-server.ts`) and
  `RunContinuationService.assertIncomingStepsHaveRequiredContent` check only
  the step content, never `sessionId`.
- `SessionResolver.resolveNumericReference` (`src/utils/SessionResolver.ts`,
  around lines 169-193) range-checks `refIndex` but never checks that it is an
  integer.

## Suggested Fix

- In the MCP handlers, reject a numeric `sessionId` that is not an integer
  `>= 1`. The error should name the step and the rule, matching the
  workflow schema's constraint. Apply this to every appended step, including
  members of a `{ parallel: [...] }` item, and to `edit_step`'s updates. Add
  `minimum: 1` to the tool schemas, so the description agents read matches.
- Leave range checking against the step's own position to the resolver,
  because a step's absolute index can change after reorders. But make
  `resolveNumericReference` treat a non-integer `refNumber` as invalid
  (warn and start a new session, as it does for out-of-range values) instead
  of indexing with it.
- Tests in `src/test/unit/McpServer.test.ts` (append and edit rejecting `1.5`
  and `0`; a valid integer still accepted) and `src/test/unit/SessionResolver*`
  (a fractional reference returns `undefined` without throwing).
