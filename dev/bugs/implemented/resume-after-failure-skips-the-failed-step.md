# Resume / `continue` after a failed step skips that step instead of re-running it

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/PromptQueue.ts` (`commitStepOutcomeAndAdvance`), `src/core/WorkflowInstance.ts` (`resume`, `executeContinuationAtRun`), `src/core/orchestration/WorkflowStartupPipeline.ts`
- **Resolution:** fixed in this commit

## Symptom

When a step fails and the workflow stops (`onFail: stopWorkflow`, the default
for script steps and end conditions, or `onError: stopWorkflow`), the run ends
in `error`. **Resume** in the dashboard, or `ctrlyoke continue`, then starts at
the step _after_ the failed one. The failed step is never re-run, and when
everything after it passes the run is reported as
`✓ Workflow completed successfully` / `completed` with a `failed` step still
in the middle.

The docs promise the opposite. `docs/workflows/error-handling.md` (the "Stop"
section) says: "When a step fails and the workflow stops … the run also offers
**Resume**, which runs the failed step again. Fix the cause first …". The code
comment in `WorkflowInstance.resume` (around line 2502) says the same:
"ERROR = the current step failed; retry it from the current (failed)
position."

## Steps to Reproduce

```sh
export CTRLYOKE_HOME=/tmp/cyb/home; mkdir -p /tmp/cyb/ws && cd /tmp/cyb/ws && git init -q
cat > g.ctrlyoke.yaml <<'EOF'
name: g
steps:
  - type: script
    name: a
    script: echo a
  - type: script
    name: b
    script: test -f ok.flag
  - type: script
    name: c
    script: echo c
EOF
ctrlyoke run g.ctrlyoke.yaml          # ✗ Workflow ended: error (b failed)
touch ok.flag                          # "fix the cause first"
ctrlyoke continue --workflow g --run 1 # ✓ Workflow completed successfully
ctrlyoke history steps --workflow g
#  0  a  completed
#  1  b  failed      <- never re-run
#  2  c  completed
```

The run file after the failure already has `_runtime.currentIndex: 2`.

## Root Cause

`PromptQueue.commitStepOutcomeAndAdvance` (`src/core/PromptQueue.ts`, around
line 1043) sets `currentIndex = max(currentIndex, stepIndex + 1)` for every
sequential outcome, FAILED included. `WorkflowExecutor.commitSequentialOutcome`
then fails the runtime, so an errored run persists `currentIndex` one past the
failed step. The startup pre-flight path (`finalizeFailedInFlightPrompt`) also
advances past the failed step.

Both continuation entry points then start from `currentIndex` unchanged:

- dashboard Resume: `WorkflowInstance.resume` → `executeLoadedPromptFile(undefined, true)` for `ERROR`;
- `ctrlyoke continue` / MCP / dashboard Continue: `RunLifecycleService.continueAtRun` → `WorkflowInstance.executeContinuationAtRun` → `executeLoadedPromptFile(undefined, true, …)`.

`WorkflowStartupPipeline.computeTargetRunIndices` and
`announceContinuation` (`continuationPreserveStepCount = currentIndex`) both
use that index, so nothing ever rewinds to the failed step. No test covers
resuming an errored run.

The persisted `currentIndex = failed + 1` in `ERROR` is load-bearing elsewhere:
`WorkflowStepRow.tsx` (`workflowContinuedAfterFailure`, `index < currentStep - 1`
under ERROR) and `usePromptStatus.ts` read it to tell the stopping failure from
an `onFail: continue` failure. Keep that representation for the settled ERROR
state and rewind only when a continuation starts.

## Suggested Fix

When a continuation starts from an `ERROR` run (both entry points above), find
the terminal failure that stopped it (the queue step at `currentIndex - 1` whose
result is FAILED with `terminalFailure !== false`; reuse
`selectTerminalFailure` in `src/cli/CliExitCode.ts` or move it somewhere shared
if that reads better) and rewind the queue to it: set `currentIndex` to that
index and reset its result to pending, through a small `PromptQueue` method,
before `computeTargetRunIndices` and the `EXECUTION_STARTED` announcement, so
the dashboard repaints the failed step as pending and its output gets a new
attempt/run index rather than overwriting the old one.

Scope notes:

- A failure under `onFail: continue` / `onError: continue` (`terminalFailure: false`) must stay settled.
- A failed parallel group: check how `reconcileGroupOutcomes` leaves `currentIndex` (past `endIndex`) and re-run the failed members, or at least the group, consistently with how Resume already treats a stopped group. If that is materially harder, handle sequential steps here and file the group case separately.
- A failed `finalStep` pass already has its own continuation path (`prepareFinalStepContinuation`); verify it re-runs the failed pass and leave it alone if it does.
- Stop is different: `finalizeCancelledPromptAfterStop` deliberately advances past the cancelled step ("advanced past cancelled step" log). Do not change Stop semantics in this fix.
