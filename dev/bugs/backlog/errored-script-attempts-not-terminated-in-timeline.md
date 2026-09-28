# Errored script-step attempts are never closed in the run timeline

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/orchestration/ScriptExecutionReporter.ts`
- **Severity:** medium

## Symptom

When a script step errors (for example on timeout, or with an unsupported script type), the run
records `attemptStarted` for each attempt but never records `attemptTerminated`:

- `events.jsonl` for a timed-out step with `errorBehavior {onError: retry, maxRetries: 2}` contains
  three `attemptStarted` events and no `attemptTerminated`.
- `ctrlyoke run --json` reports `lastAttempt: {"terminalState": null, "reason": null}`.
- The same applies to a single errored step under the default stop policy, including a
  `finalStep`.

Separately, retried script attempts are labelled `startReason: "initial"` instead of `retry`.

## Steps to Reproduce

1. Create a script step `{type: script, script: "node -e \"setTimeout(()=>{},5000)\"", timeoutSec: 1, errorBehavior: {onError: retry, maxRetries: 2}}`.
2. `node out/cli.js run wf.ctrlyoke.yaml --headless --json`
3. Inspect `lastAttempt` in the JSON, and grep the run's `events.jsonl` for `attemptTerminated`.

## Root Cause

- `WorkflowExecutor.handleEvaluationError` (around line 3455) and `failStepForInternalError`
  (around line 3522) call `runtime.failAttempt`. Neither calls
  `outputHistoryManager.recordAttemptTerminal`, which the normal script-completion path does
  (around line 2747).
- `ScriptExecutionReporter.ts` (around line 240) hardcodes `startReason: "initial"`.

## Suggested Fix

Record the terminal attempt, with its failure reason, in both error paths, ideally through one
helper shared with the normal completion path. Pass the real start reason into the reporter
instead of the literal, using the existing constant. Add executor tests asserting the terminal
event and `lastAttempt` for an errored and retried script step.
