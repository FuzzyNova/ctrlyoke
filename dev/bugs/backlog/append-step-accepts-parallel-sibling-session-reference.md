# `append_step` / `edit_step` accept a parallel member whose numeric `sessionId` or `priorContext` targets a sibling

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script calling `CtrlYokeMCPServer.invokeTool`)
- **Area:** `src/core/PromptFileParser.ts` (`getParallelReferenceErrors`), `src/mcp-server.ts` (`handleAppendStep`, `edit_step`), `src/core/orchestration/RunContinuationService.ts`
- **Severity:** medium

## Symptom

A workflow file whose parallel group contains a member with
`resumeSession: true, sessionId: <sibling step number>` is rejected at load:
"Numeric sessionId reference N cannot target a sibling in parallel group". The
same rule applies to numeric `priorContext` references. Siblings run
concurrently, so the referenced session or output does not exist yet when the
member starts.

The MCP mutation tools don't apply this rule. On a 2-step run,

```
append_step {
  steps: [{ parallel: [ { prompt: "P1" },
                        { prompt: "P2", resumeSession: true, sessionId: 3 } ] }],
  position: "end"
}
```

succeeds and writes group `[2..3]`, with P2 resuming the session of its own
sibling P1. `edit_step` can introduce the same shape on a pending member. The
runtime doesn't guard against it either, so the member starts with a session
or prior-context reference that cannot be satisfied.

## Steps to Reproduce

1. Start a run with two steps.
2. Call `append_step` with the payload above.
3. Observe success. Loading the same shape from a YAML file fails validation.

## Root Cause

The sibling-reference rule exists only in the private
`PromptFileParser.getParallelReferenceErrors` (`src/core/PromptFileParser.ts`
~1191-1262). `handleAppendStep` (`src/mcp-server.ts`), the
`appendStepsToRun` / `appendStepsToActiveParallelGroup` / `editStepAtRun`
transactions in `RunContinuationService.ts`, and the dashboard append/edit
paths never run it on the resulting topology.

## Suggested Fix

Extract the rule into a shared, pure topology validator (next to the other
parallel-group helpers, e.g. `ParallelGroupTopology.ts`) that takes the steps
and the parallel groups and returns the errors. Have `PromptFileParser` call
it, and run it on the post-mutation topology in the append, join-group and
edit transactions. Reject the mutation with the same message the parser uses.
Joining a live group with `parallelWithCurrent` must be validated too, because
a joined member referencing an existing member is the same error.
