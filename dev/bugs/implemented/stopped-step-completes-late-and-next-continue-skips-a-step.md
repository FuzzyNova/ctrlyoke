# A stopped step completes late, and the next Continue skips a step

- **Found:** 2026-10-23 by Nathan, stopping a hung Copilot step (session log `ctrlyoke-1792759723098.log`)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/PromptQueue.ts`
- **Resolution:** fixed in this commit

## Symptom

1. Stop a running CLI step (step 6 of 7) whose harness has not reported completion yet.
2. Step 6 shows the stopped styling, then flips to completed about two seconds later.
3. Continue does not run step 7. The run completes at once and step 7 shows as stopped.
4. Set Start Position on step 7, then Continue, and step 7 runs.

The log shows the late completion, then the executor's loop moving on to step 7:

```
14:50:13.657 [WorkflowInstance] Queue execution fully stopped - advanced past cancelled step 5
14:50:15.747 updateWorkingFile requested ... persistSuccessfulPromptRuntime
14:50:15.821 [inst:c7132f61] Step 6 completed (attempt 1)
14:50:16.671 [WorkflowExecutor] Workflow stopped before executing next prompt
14:50:16.967 [inst:c7132f61] Queue state stopped (step 7/7)
14:50:36.254 [PromptQueue] Restored queue from working file: 7 prompts, currentIndex=7 ...
14:50:36.640 Workflow started - workflow.ctrlyoke.json, 7 step(s), next target: none
```

## Root Cause

A CLI harness's `sendPrompt()` resolves only when the response does. Here the Copilot step was
stuck (see `copilot-read-powershell-completion-leaves-shell-pending.md`) and resolved with success
after Stop killed the PTY. `WorkflowInstance.stop()` had already cancelled step 6 and moved
`currentIndex` past it, and then three things went wrong:

1. `WorkflowExecutor.executeWithStreaming()` calls the `onPromptSent` callback after `sendPrompt()`
   resolves, and `PromptQueue.markStepAsSent()` overwrote step 6's `cancelled` result with `sent`.
2. `executeTargetContract()` treated the success as a completion: it completed the attempt, sent a
   completed status to the dashboard, and `executeTarget()` no longer saw a cancelled result, so the
   outcome was `completed`.
3. `commitSequentialOutcome()` only stops the loop for a pause, so the queue loop went on and
   claimed step 7 while the run was stopped. `executeTargetContract()` refused to run it, the
   outcome came back `cancelled`, and `commitStepOutcomeAndAdvance()` cancelled step 7 and moved
   `currentIndex` to 7. The next Continue then had nothing left to run.

## Fix

- `executeTargetContract()` treats a successful response that arrives after the user stopped the
  run as a stop (`runtime.stopped`). It goes through the stopped-by-user path, which records the
  partial output and keeps the step cancelled.
- `markStepAsSent()` no longer overwrites a cancelled result.
- The queue loop does not claim another step while the run is stopped or stopping.
