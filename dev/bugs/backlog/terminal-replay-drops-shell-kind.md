# Workflow terminal replay drops the session's shell kind

- **Found:** 2026-11-10 by smell-hunt pass 12 (code review, not a user report)
- **Area:** `src/core/WorkflowOrchestrator.ts` (`replayTerminalSessionsTo`)
- **Severity:** low

## Symptom

When the dashboard (a hosted tab or the panel switching to a workflow) has a
workflow's PTY sessions replayed to it, every `TERMINAL_STARTED` message lacks
`shellKind`. The dashboard then falls back to guessing the shell from the step
name (`inferShellKind` in `src/ui/webview-react/utils/terminalPresentation.ts`),
so an embedded shell whose name doesn't spell out the shell gets the generic
terminal icon and compact label instead of the PowerShell/bash one it had
before the reconnect.

## Steps to Reproduce

1. Start a workflow and open an embedded shell in its terminal rail.
2. Open the same workflow in a hosted browser tab (or re-bind the panel to it),
   which replays its PTY sessions through `replayTerminalSessionsTo`.
3. The replayed `TERMINAL_STARTED` carries no `shellKind`.

## Root Cause

`TerminalStartedMessage` is hand-built from a live `PtySession` in six places.
Four of them copy `shellKind` (`TerminalMessageHandlers.reconnectPanel`,
`handleSpawnShell`, `handleRestartShell`, and
`CliTransportCoordinator`'s reuse refresh, plus `WorkflowInstance`'s
parallel-group adoption). The orchestrator's replay copy
(`WorkflowOrchestrator.replayTerminalSessionsTo`) lists every other field but
omits `shellKind`.

## Suggested Fix

Build the message from a session through one shared helper so every replay
path carries the same fields, and cover `shellKind` in the replay test.
