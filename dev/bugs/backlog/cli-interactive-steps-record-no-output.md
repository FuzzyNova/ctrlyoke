# CLI interactive steps record no output: no log monitor, response is a placeholder string

- **Found:** 2026-10-04 by Claude (claude-cli), while auditing CLI output parity with the user
- **Area:** `src/core/harness/shared/CliExecutionRunner.ts`, `src/core/harness/shared/CliTransportCoordinator.ts`
- **Severity:** high

## Symptom

A step run interactively by the standalone CLI (`ctrlyoke run --interactive`, or a TTY run
whose step resolves to `executionMode: interactive`) leaves no record of what the agent did:

- The attempt has no structured events: no tool calls, diffs, text, thinking, or steers.
  `ctrlyoke history show` and the dashboard's history view show only the step header and
  prompt.
- The step's recorded response is the literal string `"Interactive session ended"`, not the
  agent's reply. Anything that reads the response sees that placeholder. That includes
  end-condition scripts that check the step's output and later steps that pull in the prior
  response as context.
- No token, context-window, or cost stats are recorded for the attempt.

The only copies of the session are the terminal scrollback, which disappears if the harness
draws in the alternate screen, and the harness's own session log on disk, which ctrlyoke
never reads. The same workflow run interactively from VS Code records everything.

## Steps to Reproduce

1. In a TTY, run a one-step workflow with `ctrlyoke run --interactive <file>` using any
   harness (all six set `usesInteractiveNotificationMonitor: true`).
2. Let the agent make a tool call and answer, so the stop hook ends the session.
3. Run `ctrlyoke history show <workflow> --step 1`. It shows the prompt, no events, and the
   response `Interactive session ended`.
4. Run the same step interactively from the VS Code dashboard. Its history has the full
   event stream and the real response.

## Root Cause

`CliExecutionRunner.executeInTerminal` (around line 605) branches on host:

- **VS Code** (`isVsCodeContext()`):
  1. spawns the PTY;
  2. discovers the session log through `createInteractiveStartupCoordinator().resolveSession`;
  3. persists the session id;
  4. tails the log with `monitorLogFile` → `CliLogMonitor`, which emits structured events,
     the parsed response, and token stats.
- **Standalone CLI**: returns early into `executeInteractiveCliProcess` →
  `CliTransportCoordinator.executeStandaloneInteractiveProcess` (around line 140). That
  path:
  1. spawns the harness with `stdio: "inherit"`;
  2. waits only on the notification monitor's stop/error hook (`monitorForCompletion`);
  3. kills the TUI on stop;
  4. reports `onResponseComplete("Interactive session ended")` (around line 294).

  It never runs session-log discovery or `CliLogMonitor`, so no events, response text, or
  usage ever reach `WorkflowExecutor`'s capture, history, or the CLI emitters.

## Suggested Fix

Give the standalone interactive path the same log pipeline as the VS Code path, and keep only
the spawn mechanism different:

1. Factor the transport-independent half of `executeInTerminal` into a shared helper:
   - stale stop-file cleanup;
   - `HookEventMonitor`;
   - `resolveSession` discovery;
   - `persistResolvedSessionId`;
   - `monitorLogFile`.

   Both hosts call the helper after starting their process. Discovery already works from
   `startTime`, the prompt, and the run id, none of which depend on the PTY.

2. In the standalone path, run discovery and `CliLogMonitor` concurrently with the inherited
   process. Let the log monitor's completion own the response and stats, as in VS Code. The
   stop hook still terminates the TUI, and the log monitor drains to the final entry before
   resolving.
3. Delete the `"Interactive session ended"` placeholder. If discovery fails, record the
   attempt as failed with a reason instead of passing off a placeholder as the response.
4. Feed the monitor the dispatched prompt (`dispatchedPromptText`), as the headless pumps do,
   so the echoed prompt is not classified as a steer.
5. Tests: a standalone interactive integration test with a fake harness that writes a session
   log and a stop notification. Assert that the attempt's events, response text and tokens
   reach history, and that an end condition reading the step output sees the real response.

Live CLI rendering of those events is not part of this fix: the harness TUI already shows
them, and interactive runs install no headless renderer (see
`cli-interactive-run-hides-headless-step-output.md`).
