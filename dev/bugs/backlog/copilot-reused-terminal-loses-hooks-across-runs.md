# Copilot step never completes when sent to a terminal kept from an earlier run

- **Found:** 2026-11-28 by Copilot CLI, investigating run `phone-refresh-2026-11-28T02-02-54-018/run-2026-11-28T02-09-34-998Z`
- **Area:** `src/core/WorkflowInstance.ts` (`settleWorkflowExecution` retention, `restoreRetainedExecutionIntegrations`), `src/core/harness/shared/CliExecutionRunner.ts` (`executeInRunningTerminal`), `src/core/harness/copilot/CopilotHarnessAdapter.ts`
- **Severity:** high

## Symptom

After a Copilot workflow completes, appending a step from the dashboard and
continuing sends the prompt into the still-open Copilot terminal. Copilot
answers and goes idle, but the step stays **running** forever. No background
task is involved and no idle backstop fires; the run only ends if the user
stops it.

## Evidence

The background-work tracking was not involved. The Copilot session log
(`~/.copilot/session-state/33645cc4-…/events.jsonl`, Copilot 1.0.115) has no
`executionMode: "async"` launches and no `system.notification` events, so
`CopilotLogParser`'s pending set stayed empty and no hold was logged.

The cause is missing hooks:

| Time (UTC) | Event |
| --- | --- |
| 02:09:36–02:10:20 | Step 1: Copilot runs `sessionStart`, `userPromptSubmitted`, and `agentStop` hooks (the only 3 `hook.start` events in the log). |
| 02:11:04 | Workflow completes. The PTY is kept in `liveReusableIntegrations`, but Copilot does not opt into `shouldRetainWorkflowArtifactsForReuse()`, so `cleanupRetainedIntegrationArtifacts` deletes its `.github/hooks/ctrlyoke-*.json` file. |
| 02:18:21 | Append continuation: "Restored live reusable integration", then "Sent prompt to existing PTY session". |
| 02:18:31 | Copilot `assistant.turn_end`. **No `hook.start` and no hook-debug log entry**, so ctrlyoke never sees `agentStop`. |
| 02:33:35–02:34:03 | Another turn typed into the same session. Again, no hooks fire. |

Copilot reads `.github/hooks/` when a hook fires, not once at process start:
hooks deleted under the live process simply stop running. The comment on
`IHarnessAdapter.shouldRetainWorkflowArtifactsForReuse` ("Most CLIs load hooks
at process startup") does not hold for Copilot.

## Steps to Reproduce

1. Run a one-step Copilot workflow in interactive mode with terminal reuse enabled and wait for it to complete.
2. Without closing the terminal, append a step in the dashboard and continue the run.
3. The prompt is sent to the existing Copilot TUI and Copilot finishes, but the step stays running.

Sent turns *within* one run work, because hook files are deleted only when the
run settles.

## Root Cause

`executeInRunningTerminal` rewrites only the per-turn hook context file
(`lastInteractiveContext.hookContextFile`). It assumes the hook registration
written at spawn still exists. Across runs it does not: the retention branch
in `WorkflowInstance` (`retainIntegration` → `cleanupRetainedIntegrationArtifacts`)
removes it for every provider that does not retain artifacts. Copilot
deliberately does not retain them, because an idle hook file in
`.github/hooks/` would fire in unrelated Copilot sessions (see the
`getLiveProcessFilePaths` gotcha in `harness-adapters.instructions.md`).

## Suggested Fix

Reinstall the provider's hook registration before a turn is sent into a
restored PTY, rather than keeping files around while the terminal is idle:

- Give the adapter a hook to restore the hook files it wrote at spawn, for
  example by remembering the planned hook-file contents and paths. Call it from
  `executeInRunningTerminal` (or from `restoreRetainedExecutionIntegrations`)
  when the artifacts were cleaned since the last turn. Register the restored
  paths so the next settlement deletes them again.
- Otherwise, as a fallback, treat a restored integration whose artifacts were
  cleaned as non-reusable (`markInteractiveContextNotReusable`) so the step
  relaunches with `--resume` and gets fresh hooks. This is simpler, but it
  restarts the TUI.

Check Claude/Codex/Qwen/OpenCode for the same gap: any provider whose sent
turns depend on files removed by `cleanupWorkflowArtifacts` will lose
completion the same way.
