# `ctrlyoke server` never initializes the PTY manager, so interactive steps silently don't launch

- **Found:** 2026-10-10 by backlog audit (static reading; not yet reproduced with a live harness)
- **Area:** `src/platform/NodeHostServices.ts`, `src/core/harness/shared/CliTransportCoordinator.ts`, `src/core/harness/PtyProcessManager.ts`
- **Resolution:** fixed in this commit

## Symptom

Under the standalone `ctrlyoke server`, a step that runs in interactive mode should launch the
harness in an embedded terminal in the hosted dashboard. Static reading says no harness process
is spawned and no terminal appears, and nothing reports an error.

## Steps to Reproduce

1. `ctrlyoke server` in a workspace with a workflow whose step resolves to interactive execution.
2. Start the workflow from the hosted dashboard.
3. Expected (from the code): no terminal, no harness process, and the step stays waiting for completion.

## Root Cause

`createNodeHostedServer` in `NodeHostServices.ts` (`~:120`) builds its `CliAdapter` with
`interactiveTerminal: INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY`. As a result, `CliExecutionRunner`
(`~:594`) takes the PTY branch, not the inherited-stdio branch that `ctrlyoke run` uses. That
branch, `CliTransportCoordinator` `~:213`, does
`const ptyManager = this.deps.getPtyManager?.() ?? getPtyProcessManager(); if (ptyManager) { … }`
and has no `else`. `getPtyProcessManager()` returns the singleton, which is only created by
`initPtyProcessManager()`, and that is called from exactly one place: `src/extension.ts` (`~:534`).
The Node host never calls it, so the manager is `null` and the spawn is skipped silently.

## Suggested Fix

1. Mirror the extension's wiring in `createNodeHostedServer`: call `initPtyProcessManager()` once
   the orchestrator hub exists, then call `setPtyPostMessage()` so it broadcasts through
   `orchestrator.getDashboardBroadcastHub()` and calls `broadcastActiveTerminalWorkflows()` on
   `TERMINAL_STARTED`/`TERMINAL_ENDED`, as `extension.ts` (`~:590-608`) does. Register it with
   the host's disposables. Extract that block into a shared helper rather than duplicating it.
2. Make the null-manager branch in `CliTransportCoordinator` fail loudly: throw, or fail the step
   with a clear reason, instead of returning as if the spawn had happened.
3. Add a test that `createNodeHostedServer` leaves `getPtyProcessManager()` non-null, and a
   coordinator test that a missing manager fails the step.
