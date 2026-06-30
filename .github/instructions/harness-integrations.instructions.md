---
applyTo: "src/core/harness/CliIntegration.ts, src/core/harness/CliLogMonitor.ts, src/core/harness/PtyProcessManager.ts"
---

<purpose>
Core CLI-harness runtime orchestration shared by every non-chat harness.
</purpose>

<architecture>
- `CliIntegration` is the workflow-facing entry point, but most behavior now lives in composed services created by `createServices()`. Prefer changing the smallest service (`CliPromptPreparer`, `CliExecutionRunner`, `CliTransportCoordinator`, etc.) instead of adding more branches/state to `CliIntegration`.
- Keep provider-specific behavior behind `ICliProvider`. If a change only applies to one harness, add or adjust a provider method; do not branch on harness ID inside `CliIntegration`.
- `buildCliArgs()` returns provider base args only. `CliIntegration` appends permission args, interactive notification-hook args, and headless user-hook args later in the run; providers should not duplicate that wiring inside `buildCliArgs()`.
</architecture>

<interactiveExecution>
- Interactive reuse is split across files: `CliIntegration` decides whether a PTY can be reused, while `CliExecutionRunner` performs inject mode against the existing PTY/log path. If a spawn-time property changes, retire the PTY instead of forcing reuse.
- PTY handoff is intentionally noisy internally: `CliIntegration` sets `suppressPtyExitSessionId` so expected shutdowns during mode changes do not surface as prompt failures.
- Do not remove the inject-mode focus/write timing. The `\x1b[I` focus-in sequence plus short delays before text and Enter are required for Copilot-style TUIs to accept injected input reliably.
</interactiveExecution>

<logAndTerminalFlow>
- `CliLogMonitor` runs parser-driven log polling and the optional notification monitor together. When a notification monitor exists, hook completion is authoritative and log completion is only for streaming/drain; preserve that priority.
- After completion or PTY exit, `CliLogMonitor` still drains late log entries. That drain is what preserves final tool events and context-window updates.
- `PtyProcessManager` is the singleton for both AI and shell sessions. The `expectedController` / `controllerClientId` flow prevents multiple webviews from racing for the same terminal; keep it intact when editing terminal-start messages.
- Reconnect behavior depends on each PTY session’s `reconnectBuffer`. If output bypasses the PTY manager, reconnects and hosted-dashboard replay break.
- The dropdown "terminal still running" icon is driven by a **global** `ACTIVE_TERMINAL_WORKFLOWS` broadcast (single source: `PtyProcessManager.getWorkflowIdsWithRunningSessions()` → `WorkflowOrchestrator.getActiveTerminalWorkflowRefs()`), **not** the per-client terminal `sessions` store. A browser/hosted client only hydrates `sessions` for the workflow it is currently viewing (`replayWorkflowStateTo` replays terminals per-viewed-workflow), so the store can never tell it which *other* workflows have live terminals. The orchestrator re-broadcasts the set on every `TERMINAL_STARTED`/`TERMINAL_ENDED` (wired at the `setPtyPostMessage` chokepoint in `extension.ts`) and sends it per-client in `replayWorkflowStateTo` and the `GET_WORKFLOWS_LIST` reply. Refs carry `workingFilePath` so recent-list rows (keyed by working file path) match without prior hydration. Keep these broadcast/replay points in sync if you touch PTY lifecycle messaging.
</logAndTerminalFlow>

<cleanup>
- Workflow cleanup is two-phase: `getAdditionalCleanupFilePaths()` removes disposable provider artifacts, then `cleanupWorkspaceArtifacts()` restores provider-owned workspace files. Do not delete settings/config files early; parallel workflows may still depend on them.
- Windows shell/process quirks stay centralized in `PtyProcessManager` and `CliTransportCoordinator`; avoid duplicating shell resolution or spawn-env logic in providers.
</cleanup>
