---
applyTo: "src/extension.ts, src/mcp-server.ts"
---

<purpose>
These two files are process entry points, not general-purpose dumping grounds.

- `src/extension.ts` wires the VS Code-side control plane at activation time.
- `src/mcp-server.ts` is a separate stdio binary used by AI harnesses and commit-message generation; it must stay usable without `vscode`.

Keep them focused on startup/shutdown wiring, cross-subsystem handoff, and process-boundary contracts. Push feature logic into the owning subsystem instead of growing either entry point.
</purpose>

<extensionActivation>
`activate()` has a meaningful order. Preserve these dependencies when editing startup:

1. Configure `configService` backends **before** `Log.initialize(context)` so startup logging sees the real file-backed settings.
2. Kick off `initializeModelRegistry()` early, but do not block activation on it.
3. Workspace bootstrap happens before orchestrator creation:
   - initialized workspace: fire-and-forget `WorkspaceInitializer.initializeIfNeeded()` and `TempFileManager.cleanupOrphanedFiles()`
   - uninitialized workspace: capture `pendingInitWorkspaceRoot` only
4. Create/register `CtrlYokeWebviewProvider` **before** PTY/orchestrator setup.
5. Initialize `PtyProcessManager` with the panel postMessage first, then create `WorkflowOrchestrator`.
6. If workspace init is pending, call `workflowOrchestrator.setWorkspaceInitPending(...)` **before** `initialize()`.
7. After both objects exist, wire cross-references:
   - `webviewProvider.setWorkflowOrchestrator(...)`
   - `webviewProvider.setHub(...)`
   - `setPtyPostMessage(hub.postMessage)` to upgrade PTY fan-out from panel-only to all dashboard clients
8. Register `NotificationManager` as a hub client and share the orchestrator's `OutputHistoryManager` with the webview provider.
9. Call `workflowOrchestrator.initialize()` fire-and-forget. The webview is allowed to resolve before harness detection finishes.
10. Only after core wiring: theme listener, completion/link providers, `initializeCompletionHelpers(context)`, LM tools, then command registration.

Current activation assumes the **first workspace folder** is the workspace root for config backend setup, initialization, workflow discovery, and several commands. If multi-root behavior changes, update those paths together.
</extensionActivation>

<extensionPatterns>
Important `extension.ts` conventions:

- `workflowOrchestrator`, `webviewProvider`, `hostedServer`, and `notificationManager` are intentionally module-scoped so registered commands can close over them. Do not move them into a separate service locator.
- Everything VS Code should auto-dispose belongs in `context.subscriptions`. The notable exceptions are:
  - `hostedServer`, disposed manually by `disableServer` and `deactivate()`
  - `notificationManager`, owned through `DashboardBroadcastHub.addClient(...)`
- `registerLanguageModelTools(context)` always registers the same four LM tools: queue status, append queue, capabilities, and read output. Their MCP twins live in `mcp-server.ts`; keep semantics aligned.
- `registerCommands(context)` is the single production command-wiring point. Keep it orchestration-only:
  - context-menu commands save dirty files before delegating
  - the hosted server auto-start check runs **after** command registration
  - dev commands are last and stay behind `IS_DEV_MODE`
- Shared command IDs, context keys, queue positions, execution states, and message types belong in `src/types/DashboardConstants.ts`, not as new literals here.
- `ScmCommitCommand` is instantiated once inside `registerCommands()` and owns SCM-specific UX; `extension.ts` should only register/delegate to it.
  </extensionPatterns>

<deactivation>
`deactivate()` is intentionally small:

1. ask `PtyProcessManager` to gracefully stop AI CLI sessions first
2. dispose the hosted server and clear the module-scoped reference
3. dispose the orchestrator

Do not duplicate cleanup already handled by `context.subscriptions`; PTY hard-kill fallback and other disposables run there after deactivation returns.
</deactivation>

<mcpServer>
`mcp-server.ts` is a standalone CJS/stdin-stdout process. Treat it as an external contract.

- Never import `vscode` or extension-only helpers here.
- Keep the local path constants in sync with `ConfigurationUtils.PATH_CONSTANTS`; they are duplicated on purpose to avoid a VS Code dependency.
- Use file logging only (`CTRLYOKE_DIAGNOSTIC_LOGS=true` or `NODE_ENV=development`). Do not write operational logs to stdout/stderr because stdout is the MCP transport and many TUIs capture stderr.
- The first four tools mirror the LM tools from `extension.ts`; `ctrlyoke_global_status` and `ctrlyoke_submit_commit_message` are MCP-only.
- Active working file resolution is a two-step contract:
  1. prefer `CTRLYOKE_WORKING_FILE` so a harness session targets its exact workflow
  2. otherwise scan `.ctrlyoke/.working/` and prefer running / recent files as a fallback
- Queue appends are protected twice on purpose:
  - `operationQueue` serializes append requests within this process
  - `withFileLock(...)` protects the working file across processes
- Append validation is best-effort against `.ctrlyoke/capabilities.json`; that file is produced by the VS Code-side settings sync and may be absent early in workspace setup.
- `ctrlyoke_submit_commit_message` writes to `CTRLYOKE_COMMIT_OUTPUT` when present; this is the structured capture path used by commit-message generation.
  </mcpServer>

<relatedFiles>
- `src/ui/CtrlYokeWebviewProvider.ts` — panel shell and outbound UI transport
- `src/core/WorkflowOrchestrator.ts` — main lifecycle owner created by `activate()`
- `src/core/QueueOperations.ts` — shared queue/read/append logic mirrored by LM tools
- `src/scm/ScmCommitCommand.ts` — SCM command implementation registered from `extension.ts`
</relatedFiles>
