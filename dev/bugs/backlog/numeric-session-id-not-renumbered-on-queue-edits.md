# A numeric `sessionId` keeps its old step number when steps are inserted, removed, or reordered

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced against the compiled MCP server
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`appendStepsToRun` ~407-416, `removeStepAtRun` ~857, `reorderStepsWithOrder` ~988), dashboard insert/delete/drag-reorder paths, `ExecutionPreviewService.ts` (~805-818)
- **Severity:** medium

## Symptom

A step's numeric `sessionId` is a 1-based position, resolved at execution time
as `allSteps[sessionId - 1]`. Nothing renumbers it when the queue changes
shape. Example, steps
`[done, in-flight, "implement", "fixup" {resumeSession: true, sessionId: 3}]`:

- `append_step` at position 2 inserts "research". "fixup" now has index 4 but
  still says `sessionId: 3`, which is "research", so it resumes the wrong
  conversation.
- `remove_step` on the referenced step re-targets the reference to the next
  step, or to the step itself, which silently starts a fresh session.
- `reorder_steps` (and dashboard drag-reorder / insert / delete) re-target it
  silently.

`workflow_status` doesn't report `sessionId`, so an orchestrating agent can't
notice. `spec-orchestrator.agent.md` combines `resumeSession`/`sessionId` with
positional `append_step` and `reorder_steps`, so this is a common pattern.

## Root Cause

References are positional and no queue-mutation path rewrites them. Grepped
`PromptQueue`, `ParallelGroupTopology`, `RunContinuationService`.

## Suggested Fix (needs a decision)

Choose one:

- (a) Have every structural edit renumber numeric `sessionId` references. Pick
  a rule for a removed target: clear it, or refuse the removal.
- (b) Resolve references to a stable `stepId` internally and keep the 1-based
  number only as the authoring syntax.

Either way, apply it in one shared helper used by the MCP, CLI `step`, and
dashboard mutation paths, and consider exposing `sessionId` in
`workflow_status`. Not queued: this needs a design decision.

## Decision

Decided 2026-10-03 by Nathan: option (a), renumber on edit. One shared helper, called by every structural queue edit (MCP `append_step`/`remove_step`/`reorder_steps`, CLI `step`, dashboard insert/delete/drag-reorder), rewrites numeric `sessionId` references so they keep pointing at the same step. Apply the same rule to numeric `priorContext` references. Removing a step that another unstarted step references by number is **refused**, with an error naming the referencing step(s). Expose `sessionId` in `workflow_status`.
