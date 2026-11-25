# `history show` marks every condition and setup script attempt as unterminated

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/RunOutputResolver.ts`, `src/cli/HistoryInspectionCommands.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke history show` reports every preCondition, endCondition and
worktree-setup script attempt as interrupted, even when the script ran to
completion and passed:

- Text output ends each such attempt with
  `⚠ Attempt did not terminate before the recorded history ended`, directly
  under `✔ Passed — End condition passed (stdout is empty) → continue` and
  `Exit code: 0`.
- `--json` records carry `"unterminated": true`.
- `--json --summary` records carry `"state": "unterminated"`.

The docs (`docs/cli/ctrlyoke.md`, "history show") define the `unterminated`
marker as "attempts interrupted before their terminal event", so agents and CI
scripts that inspect history with `--json` see a false interruption on every
step that has a condition or worktree setup.

## Steps to Reproduce

1. Run any workflow whose step has an `endCondition` script, e.g.
   `endCondition: { script: "true" }`, to completion.
2. `ctrlyoke history show --workflow <key> --step 0 --json`
3. The AI attempt record has `unterminated: false`; the `phase: "endCondition"`
   record has `unterminated: true` and `output.exitCode: 0`,
   `output.scriptVerdict.outcome: "passed"`.

Observed on a real 29-step run: `events.jsonl` held 41
`attemptStarted|endCondition`, 11 `attemptStarted|preCondition` and 1
`attemptStarted|worktreeSetup` events, each with a `scriptExecutionRecorded`,
but zero `attemptTerminated` events with a phase. All 41 non-phase AI attempts
that finished had their `attemptTerminated`.

## Root Cause

Condition and setup scripts are recorded by
`ScriptExecutionReporter` (`src/core/orchestration/ScriptExecutionReporter.ts:375-398`):
`saveExecutionOutput` plus `recordScriptExecution`, but never
`OutputHistoryManager.recordAttemptTerminal`. `attemptTerminated` events also
carry no `phase` (`OutputHistoryManager.ts:637-651`).

`RunOutputResolver` keys attempts by target, run, attempt **and phase**
(`getAttemptKey`, `RunOutputResolver.ts:1792`) and only sets
`state.terminated` on `ATTEMPT_TERMINATED` (`RunOutputResolver.ts:599-603`).
So a phase attempt is never terminated, and `createSettledAttemptEvent`
(`RunOutputResolver.ts:660`) reports `unterminated: !state.terminated &&
!state.continuation` = `true`. `HistoryInspectionCommands.ts:1139` and `:1858`
turn that into the `unterminated` state and the warning.

## Suggested Fix

Treat a recorded `scriptExecutionRecorded` (the script's completion record) as
the terminal event for phase-scoped script attempts in `RunOutputResolver`, so
existing run histories also render correctly: e.g. set `state.terminated`
(or exclude from `unterminated`) when a phase attempt has received
`SCRIPT_EXECUTION`. With no `terminalState` the `--summary` state would then
fall back to `unknown` (`HistoryInspectionCommands.ts:1140`); derive a terminal
state from the script result instead (completed for a finished script,
cancelled when `scriptVerdict` is absent because it was cancelled). A condition script that really was cut off (no
`scriptExecutionRecorded`) must still report `unterminated: true`.

Add a `RunOutputResolver.test.ts` case (endCondition attempt with
`attemptStarted` + `cliOutputRecorded` + `scriptExecutionRecorded` → settled
with `unterminated: false`; without `scriptExecutionRecorded` → `true`) and a
`HistoryInspectionCommands.test.ts` case asserting no "did not terminate"
warning and `state` not `unterminated` in `--summary` for a passed end
condition.
