# Status reporting ignores a running final step: appended steps show as running and `ctrlyoke status` prints `3/2`

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script calling `CtrlYokeMCPServer.invokeTool` against a temporary run)
- **Area:** `src/utils/StepStatusDerivation.ts` (`deriveStepStatusesFromRuntime`), `src/core/orchestration/GlobalWorkflowStatusService.ts`
- **Resolution:** fixed in this commit

## Symptom

While a workflow's `finalStep` is running, `_runtime.currentIndex` equals
`steps.length`, and any step the final step appends lands at `currentIndex`.
`dev/bugs/implemented/final-step-mcp-mutations-reject-first-appended-step.md`
already established this. Two status surfaces don't account for it:

1. **`workflow_status` and other step-status views mark the first appended step
   as running.** Take steps `[done, done, A(pending), B(pending)]` with
   `currentIndex: 2` and the final step running. `workflow_status` reports
   `['completed','completed','running','pending']`. Step 2 has not started;
   only the final step is running. The same derivation feeds `read_output`
   status, the external-run watch coordinator and the dashboard's external-run
   chips (`useMessageHandler.ts`).
2. **`global_status` / `ctrlyoke status` report a position past the end.** A
   2-step run whose final step is running returns `currentStep: 3,
   totalSteps: 2`, which the CLI table prints as `3/2`. After the final step
   appends two steps it reports `3/4`, naming a pending step as current.

## Steps to Reproduce

1. Create a run working file with two completed steps,
   `executionState: "running"`, `currentIndex: 2` and
   `_runtime.finalStep.phase: "finalStep"`.
2. Call `workflow_status`: no step is running, yet `steps[2]` (once appended)
   is `running`.
3. Call `global_status` (or run `ctrlyoke status`): `currentStep` is 3 of 2.

## Root Cause

- `src/utils/StepStatusDerivation.ts:144`: `deriveStepStatusesFromRuntime`
  paints `index === currentIndex` as in flight without checking the final-step
  phase. `hasInFlightStep` in the same file already encodes the correct rule
  ("A running final step sits after the queue, so steps appended at that
  position have not started"), but this function doesn't use it.
  Callers: `src/mcp-server.ts` (workflow_status, read_output),
  `ExternalRunWatchCoordinator.ts`, `useMessageHandler.ts`.
- `src/core/orchestration/GlobalWorkflowStatusService.ts:198`:
  `currentStep: runtime.currentIndex + 1` ignores `runtime.finalStep?.phase`.

## Suggested Fix

- Give `deriveStepStatusesFromRuntime` the final-step phase and replace the
  bare `index === currentIndex` test with
  `index === currentIndex && hasInFlightStep(executionState, finalStepPhase)`.
  Pass `_runtime.finalStep?.phase` from every caller. A step whose own
  `startedAt` is set stays in flight, so parallel groups are unaffected.
- In `GlobalWorkflowStatusService`, report the final-step phase explicitly
  rather than `currentIndex + 1`: for example, `currentStep: null` plus a
  final-step indicator/pass number, with labels from
  `src/utils/FinalStepLabels.ts`. Never report a position beyond
  `totalSteps`. Update `ctrlyoke status` (`src/cli/CliStatusCommand.ts:200`)
  and `docs/reference/mcp-tools.md` (`currentStep` description, ~line 120) to
  match.
