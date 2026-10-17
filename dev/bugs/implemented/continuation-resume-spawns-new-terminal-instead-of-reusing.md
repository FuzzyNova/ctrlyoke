# Continuation resuming an older session spawns a new terminal instead of reusing the running one

- **Found:** 2026-10-17 by user report, investigated with Claude Code
- **Area:** `src/core/WorkflowInstance.ts`, `src/core/harness/CliIntegration.ts`, `src/core/harness/shared/CliTransportCoordinator.ts`
- **Resolution:** fixed in this commit

## Symptom

With `execution.reuseRunningTerminal` on (the default):

1. Step 1 runs interactively and its TUI stays open.
2. Step 2 runs with **New Session** and opens a second terminal.
3. The start position is set to step 2, and step 2 is switched to **Resume**, which resumes step 1's session.
4. Continue re-runs step 2.

Expected: step 2 is sent to step 1's still-running terminal.

Actual: step 1's terminal is killed ("Process closed — replaced by a new session") and its tab stays behind. Step 2's original terminal is also retired, even though its conversation is unrelated. A third terminal is then spawned with `--resume` of step 1's session.

Separately, whenever an integration replaced its own PTY with a `--resume` of the same AI session, the dead tab stayed in the terminal rail, so tabs for one conversation piled up.

## Root Cause

1. **Integrations were selected by spawn identity only.** Step 2's fresh session called `claimSpawnIdentityKey`, which moved step 1's integration into `unkeyedExecutionIntegrations` on the assumption that "no prompt can select them again". At settlement, unkeyed integrations are never retained, so step 1's integration went into `lastRunIntegrations`. The continuation's `beginExecution` then closed it with `SUPERSEDED`. The resuming step 2 was handed step 2's own integration (the only one under the key). Its running session did not match the requested one, so `shouldReuseRunningTerminal` declined, and the restart branch in `runExecutionSession` retired that unrelated PTY and spawned a new one.
2. **Tab removal existed on only one path.** `TERMINAL_REMOVED` was sent only by `WorkflowInstance.releaseConflictingAiSession`, which handles takeovers between sibling integrations. When an integration retired its own PTY to restart the same conversation, it sent nothing.

## Fix

- `claimSpawnIdentityKey` re-keys the displaced integration to `<key>::superseded:<n>`. It is now retained across passes like any other integration.
- `WorkflowExecutor.resolveResumedAiSessionId` resolves the session a prompt will resume and passes it through `getIntegrationForPrompt`. `WorkflowInstance.reclaimSupersededConversation` then promotes the superseded integration that still holds that session back to the key. The startup pipeline also re-selects when the cached integration does not hold the requested session.
- `retainedIntegrationArtifactContexts` and the PTY-exit callback now look up integrations by identity rather than by map key, because keys move.
- `CliTransportCoordinator.terminateCurrentPtySession` accepts `removeTerminalTab`. `CliIntegration` sets it on its restart retirements when the replacement resumes the session the retired PTY held. The `TERMINAL_REMOVED` payload has one builder, `buildTerminalRemovedMessage`.
- Follow-up: a prompt resuming a session that no live terminal holds no longer restarts on the spawn identity's integration when that integration keeps a reusable terminal for another conversation. It gets a new integration, and the unrelated terminal is superseded instead of killed (`WorkflowInstance.spawnIdentityHoldsAnotherConversation`).
