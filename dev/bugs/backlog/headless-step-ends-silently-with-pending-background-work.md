# Headless step ends silently while its agent is waiting on background work

- **Found:** 2026-10-23 by the workflow-orchestrator step (claude-cli) of the subagent output attribution run, reviewing codex-cli headless steps
- **Area:** `src/core/harness/shared/HeadlessLogTail.ts`, `src/core/harness/CliLogMonitor.ts`, `src/core/harness/shared/interfaces/ILogParser.ts`
- **Severity:** medium

## Symptom

In a headless step, an agent sometimes starts a slow command (a full `npm test`)
in the background and ends its turn to "check back when it finishes". Headless
completion is process exit, so the harness exits, the background command dies
with it, and the step is marked **completed**. Nothing in the output, step
status or notifications says that work was abandoned.

In the subagent output attribution run, 5 of 12 codex-cli headless steps in the
first round ended this way: uncommitted edits, no test result, status
`completed`. The orchestrator only found out by diffing the tree on its next
review.

## Steps to Reproduce

1. Run a headless step (any harness) whose prompt says to run a command that
   outlives the agent's tool timeout "in the background and read the log when
   it ends".
2. The agent launches it and ends its turn.
3. The step completes normally; the command never finished and the working
   tree holds whatever the agent left uncommitted.

## Root Cause

There are two parts:

- **Agent knowledge.** Nothing tells a headless agent that its process ends
  with its turn. Interactive TUIs stay alive after a turn ends, which is what
  models expect. codex-cli can't wait in the background in either mode. The
  workflow-orchestrator and workflow-composer agent templates now say so, and
  `workflow_status` reports each step's `executionMode`. A prompt that no
  orchestrator wrote still gets no warning.
- **No exit-time check.** `HeadlessLogTail` drives `CliLogEventPump`, which
  calls `parser.trackBackgroundWorkState`. So for a log-sourced headless run,
  a parser that tracks background tasks (claude-cli, copilot-cli and
  antigravity-cli implement it) already knows a task is still pending.
  Stdout-sourced runs, such as claude-cli headless, would need the same tracking
  on the stdout path. But the class doc in `HeadlessLogTail.ts` states
  headless has no background-work hold, and nothing reads
  `hasPendingBackgroundWork()` when the process exits. Only `CliLogMonitor`
  (interactive) consults it. codex-cli, qwen-cli and opencode-cli don't track
  background work at all. For codex this is moot, since it has no background
  tool and the agent simply ends its turn while expecting to be woken.

## Suggested Fix

- At headless process exit, if the parser reports `hasPendingBackgroundWork()`,
  emit a visible warning row ("ended with N background tasks still running;
  they were stopped") and record it on the attempt. That makes the abandoned
  work obvious in the dashboard, the CLI and `read_output`.
- Consider a one-line headless note in the prompt context ctrlyoke already
  adds, so every headless agent knows that its session ends when it ends its
  turn, that background commands are killed, and that it must poll in the
  foreground. That covers codex, where no tracking signal exists.
- Whether a pending task at exit should fail the step or only warn is a
  product decision; warning is the safe first cut.
