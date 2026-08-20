---
applyTo: "src/core/harness/CliIntegration.ts, src/core/harness/CliLogMonitor.ts, src/core/harness/PtyProcessManager.ts"
---

<purpose>
Core CLI-harness runtime orchestration shared by every harness.
</purpose>

<architecture>
- `CliIntegration` is the workflow-facing entry point, but most behavior now lives in composed services created by `createServices()`. Prefer changing the smallest service (`CliPromptPreparer`, `CliExecutionRunner`, `CliTransportCoordinator`, etc.) instead of adding more branches/state to `CliIntegration`.
- Keep provider-specific behavior behind `ICliProvider`. If a change only applies to one harness, add or adjust a provider method; do not branch on harness ID inside `CliIntegration`.
- `buildCliArgs()` returns provider base args only. `CliIntegration` appends permission args, interactive notification-hook args, and headless user-hook args later in the run; providers should not duplicate that wiring inside `buildCliArgs()`.
- `execution.strictContextResolution` has two symmetric per-step chokepoints in two files: `CliIntegration.initializeExecutionSession` gates before `session.preparePrompt`, while `WorkflowExecutor` gates before `getIntegrationForPrompt`. Both must use the shared resolution predicate and formatter. The mode switches on diagnostic code—not stored severity or the presence of any diagnostic—because `prepared.diagnostics` is mixed with advisory codes that must not block. Secrets remain a separate whole-workflow pre-step-1 `preflightWorkflowSecrets` check, and `secret check` never reads this setting. When adding a prompt diagnostic code, decide deliberately whether it joins `CONTEXT_RESOLUTION_DIAGNOSTIC_CODES` — only "a declared reference failed to resolve" belongs there. `prompt.secret.interpolation-ignored` is the cautionary case: `${secret:NAME}` in prompt text used to throw unconditionally, which hard-failed runs whose prompts merely *documented* the syntax, so it is now an advisory that never blocks in either mode.
</architecture>

<interactiveExecution>
- Interactive reuse is split across files: `CliIntegration` decides whether a PTY can be reused, while `CliExecutionRunner` performs inject mode against the existing PTY/log path. If a spawn-time property changes, retire the PTY instead of forcing reuse.
- MCP server properties are normalized after effective-prompt resolution and before spawn, so a later queued `/mcp:<server>` reference changes the normalized `mcpServers` snapshot; the existing inject-compatibility comparison must then retire the PTY and spawn with the newly attached server.
- PTY handoff is intentionally noisy internally: `CliIntegration` sets `suppressPtyExitSessionId` so expected shutdowns during mode changes do not surface as prompt failures.
- Do not remove the inject-mode focus/write timing. The `\x1b[I` focus-in sequence plus short delays before text and Enter are required for Copilot-style TUIs to accept injected input reliably.
- `ICliProvider.getInteractiveSpawnEnv()` has two independent call sites in `CliTransportCoordinator`: `executeStandaloneInteractiveProcess()` (CLI-only, non-VS Code path) and `startInteractiveProcess()` (the real VS Code PTY path, used by `PtyProcessManager.spawnPty()`). Both must merge it in — it was previously only wired into the standalone path, so the VS Code PTY path silently ran every interactive session with just `process.env` + caller-supplied hook vars, dropping Copilot's OTel export override (`buildOtelSpawnEnv()`, context-window tracking went dark with no error) and Claude's `CLAUDECODE` deletion. When adding a new provider-level interactive env override, grep both call sites — don't assume one covers the other.
</interactiveExecution>

<logAndTerminalFlow>
- `CliLogMonitor` runs parser-driven log polling and the optional notification monitor together. When a notification monitor exists, hook completion is authoritative and log completion is only for streaming/drain; preserve that priority.
- After completion or PTY exit, `CliLogMonitor` still drains late log entries. That drain is what preserves final tool events and context-window updates.
- `CliLogMonitor` calls `parser.readNewLines()` from **four unsynchronized places** — the `fs.watch` callback (`pump.watch`, whose handler is `async` and never awaited), the initial read, every catch-up read (background-work hold, completion, cancellation), and the drain loop — so overlapping invocations are normal, not exceptional. A parser whose read offset advances only *after* an `await` will therefore hand the same byte range to two callers and re-emit the whole turn, with different synthetic event IDs so nothing downstream can dedupe it. Parsers that read synchronously (offset assigned in the same tick as `statSync`/`readSync`) are safe by construction; anything using `fs.promises` must serialize itself. `AntigravityTranscriptReader.readRecords()` does this with a per-path promise chain — copy that shape rather than reintroducing async offset tracking.
- `PtyProcessManager` is the singleton for both AI and shell sessions. The `expectedController` / `controllerClientId` flow prevents multiple webviews from racing for the same terminal; keep it intact when editing terminal-start messages.
- Reconnect behavior depends on each PTY session’s `reconnectBuffer`. If output bypasses the PTY manager, reconnects and hosted-dashboard replay break.
- The dropdown "terminal still running" icon is driven by a **global** `ACTIVE_TERMINAL_WORKFLOWS` broadcast (single source: `PtyProcessManager.getWorkflowIdsWithRunningSessions()` → `WorkflowOrchestrator.getActiveTerminalWorkflowRefs()`), **not** the per-client terminal `sessions` store. A browser/hosted client only hydrates `sessions` for the workflow it is currently viewing (`replayWorkflowStateTo` replays terminals per-viewed-workflow), so the store can never tell it which *other* workflows have live terminals. The orchestrator re-broadcasts the set on every `TERMINAL_STARTED`/`TERMINAL_ENDED` (wired at the `setPtyPostMessage` chokepoint in `extension.ts`) and sends it per-client in `replayWorkflowStateTo` and the `GET_WORKFLOWS_LIST` reply. Refs carry `workingFilePath` so recent-list rows (keyed by working file path) match without prior hydration. Keep these broadcast/replay points in sync if you touch PTY lifecycle messaging.
</logAndTerminalFlow>

<cleanup>
- Workflow cleanup is two-phase: `getAdditionalCleanupFilePaths()` removes disposable provider artifacts, then `cleanupWorkspaceArtifacts()` restores provider-owned workspace files. Do not delete settings/config files early; parallel workflows may still depend on them.
- Windows shell/process quirks stay centralized in `PtyProcessManager` and `CliTransportCoordinator`; avoid duplicating shell resolution or spawn-env logic in providers.
</cleanup>
