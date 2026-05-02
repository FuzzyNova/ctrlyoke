---
applyTo: "src/extension.ts, src/mcp-server.ts"
---

<purpose>
VS Code extension entry point (`extension.ts`) and standalone MCP server binary (`mcp-server.ts`). `extension.ts` wires every subsystem together at activation time. `mcp-server.ts` is a separate stdio process — it never imports `vscode` and is compiled independently.
</purpose>

<activationOrder>
`activate()` runs these steps in strict order. Do not reorder them.

1. `Log.initialize(context)` — creates the output channel; must come first so all subsequent logging works.
2. `initializeModelRegistry()` — fire-and-forget; unblocks IntelliSense immediately.
3. `WorkspaceInitializer.initializeIfNeeded()` — creates `.flightpath/` on first run; fire-and-forget.
4. `TempFileManager.cleanupOrphanedFiles()` — purges stale temp prompt files from prior sessions; fire-and-forget.
5. `configService.setUserBackend / setWorkspaceBackend` — must happen before any code reads settings.
6. `new FlightPathWebviewProvider(context)` + `registerWebviewViewProvider` — panel must exist before orchestrator is created.
7. `initPtyProcessManager(webviewProvider.postMessagePublic)` — PTY must be initialized after the webview but before the orchestrator.
8. `new WorkflowOrchestrator(context, webviewProvider)` — creates all seven harness integrations.
9. `webviewProvider.setWorkflowOrchestrator / setHub` — cross-reference wiring after both objects exist.
10. `setPtyPostMessage(hub.postMessage)` — upgrades PTY to broadcast through the hub (replaces the panel-only reference from step 7).
11. `new NotificationManager(() => workflowOrchestrator)` + `hub.addClient(notificationManager)` — registers notification manager as a dashboard sink for VS Code toast notifications.
12. `webviewProvider.setOutputHistoryManager` — shares the single OutputHistoryManager instance with the webview provider.
13. `vscode.lm.registerMcpServerDefinitionProvider` — guarded by `typeof … === "function"` for API availability.
14. `workflowOrchestrator.initialize()` — fire-and-forget; lets `resolveWebviewView()` run immediately.
15. `onDidChangeActiveColorTheme` subscription — theme change listener.
16. Completion providers (`PromptCompletionProvider` with `@`, `#`, `~`, `$` triggers; `PromptPropertyCompletionProvider`; `PromptLinkProvider`) and `initializeCompletionHelpers`.
17. `registerLanguageModelTools(context)` — four LM tools.
18. `registerCommands(context)` — all commands, auto-start hosted server if `configService.get("server")?.enabled`, then dev commands (`registerDevCommands`) only when `IS_DEV_MODE`.
    </activationOrder>

<disposableRegistration>
**Rule:** Every disposable that VS Code should clean up on deactivation must be pushed to `context.subscriptions`.

- Webview provider, PTY manager, MCP provider, theme-change listener, all completion providers, all LM tools — pushed individually or in one `push(...)` call.
- Commands are collected into locals then pushed in a **single batched** `context.subscriptions.push(cmd1, cmd2, …)` at the end of `registerCommands()`.
- Detector integrations (created inside `WorkflowOrchestrator`) are registered via the `context` passed to the orchestrator constructor — not directly in `activate()`.
- `notificationManager` is NOT in subscriptions; it is registered as a hub client via `hub.addClient()` and is disposed when the orchestrator (and hub) are disposed.
- `hostedServer` (module-level `let`) is NOT in subscriptions; it is disposed manually in both `deactivate()` and `disableServer` command handler.
- Dev commands are pushed inside `registerDevCommands()` using the same `context` reference.
  </disposableRegistration>

<commandRegistration>
All production commands live in `registerCommands(context: vscode.ExtensionContext)`, called from `activate()`.

**Pattern for each command:**

```typescript
const myCommand = vscode.commands.registerCommand(
  "flightpath.myCommand",
  async () => {
    await workflowOrchestrator.myMethod();
  }
);
```

- Commands that need a `uri` argument (context menu) receive it as the first parameter: `async (uri: vscode.Uri) => { … }`.
- Context-menu commands always call `saveIfDirty(uri.fsPath)` before executing.
- Commands that open the dashboard panel call `vscode.commands.executeCommand("flightpath.dashboard.focus")`.
- Server commands (`enableServer`, `disableServer`) access the module-level `hostedServer` variable directly.
- All registered `Disposable` instances are pushed in a single batch at the end of the function.
- Dev commands are conditionally registered **after** the batch push, inside `if (IS_DEV_MODE)`.
  </commandRegistration>

<languageModelTools>
Four LM tools registered via `registerLanguageModelTools(context)`. Each tool is wrapped in try/catch — failure is non-fatal (logged as warning).

| Tool ID                   | Operation                                              |
| ------------------------- | ------------------------------------------------------ |
| `flightpath_queue_status` | Read active queue state                                |
| `flightpath_append_queue` | Append steps; resumes execution if queue was completed |
| `flightpath_capabilities` | Return available harnesses and models                  |
| `flightpath_read_output`  | Read AI response text from completed prompts           |

All four are pushed to `context.subscriptions` as a single batch. Both `flightpath_queue_status` and `flightpath_append_queue` require `workflowOrchestrator.getActivePromptQueue()` to be non-null; return a structured error string when it is null rather than throwing.
</languageModelTools>

<moduleScope>
Three module-level variables in `extension.ts`:

```typescript
let workflowOrchestrator: WorkflowOrchestrator; // set in activate(), used in commands
let webviewProvider: FlightPathWebviewProvider; // set in activate(), used in commands
let hostedServer: FlightPathHostedServer | undefined; // managed by enableServer/disableServer commands
let notificationManager: NotificationManager | undefined; // registered as hub client, not in subscriptions
```

These are intentionally module-scoped (not passed as parameters) because commands are registered as closures that capture them. Never extract them into a separate module.
</moduleScope>

<deactivation>
`deactivate()` is **async** (`export async function deactivate(): Promise<void>`).

1. `getPtyProcessManager()?.gracefulShutdownAllAiCliSessions()` — sends Ctrl+C twice to all active AI CLI PTY sessions and waits 500ms, preventing "improper shutdown" warnings from AI CLIs on next launch.
2. `hostedServer?.dispose()` then set to `undefined`.
3. `workflowOrchestrator.dispose()` — tears down all seven detector integrations, active workflow instances, and settings hooks trackers.

After `deactivate()` resolves, VS Code disposes `context.subscriptions` — this triggers `PtyProcessManager.dispose()` as the hard-kill fallback for any sessions not yet dead. Do not repeat those disposals here.
</deactivation>

<mcpServer>
`mcp-server.ts` is compiled as a **standalone CJS binary** (`flightpath-mcp`). It never imports `vscode`.

**Entry point:**

```typescript
const server = new FlightPathMCPServer();
server.start().catch(() => process.exit(1));
```

**Environment variables consumed:**

| Variable                     | Default         | Purpose                                             |
| ---------------------------- | --------------- | --------------------------------------------------- |
| `FLIGHTPATH_WORKSPACE`       | `process.cwd()` | Workspace root for `.flightpath/.queue/` discovery  |
| `FLIGHTPATH_WORKING_FILE`    | scan queue dir  | Explicit working file path                          |
| `FLIGHTPATH_MAX_QUEUE_SIZE`  | `100`           | Max queue entries (0 = unlimited)                   |
| `FLIGHTPATH_UNLIMITED_MODE`  | `false`         | Bypass size limit entirely                          |
| `FLIGHTPATH_DIAGNOSTIC_LOGS` | `false`         | Write to `.flightpath/logs/flightpath-mcp-<ts>.log` |
| `NODE_ENV`                   | —               | `development` also enables diagnostic logging       |

**Transport:** `StdioServerTransport` (stdin/stdout). The TUI captures stderr, so all internal logging writes to the log file — never to stderr or stdout.

**Concurrency:** `operationQueue` (a chained `Promise`) serializes all `flightpath_append_queue` calls to prevent race conditions on the working file. The gate promise always resolves (never rejects) so a failed operation does not block subsequent ones.

**Tools exposed by `mcp-server.ts` (five tools):**

| Tool ID                      | Operation                                                   |
| ---------------------------- | ----------------------------------------------------------- |
| `flightpath_queue_status`    | Read active queue state                                     |
| `flightpath_append_queue`    | Append steps; resumes execution if queue was completed      |
| `flightpath_capabilities`    | Return available harnesses and models                       |
| `flightpath_read_output`     | Read AI response text from completed prompts                |
| `flightpath_global_status`   | Read status of ALL workflows in the workspace queue (MCP-only — not a LM tool in `extension.ts`) |

The first four share the same tool IDs as the LM tools registered in `extension.ts`. `flightpath_global_status` is exclusive to the MCP server; it is not registered as a VS Code LM tool.

**Path constants** in `mcp-server.ts` are redefined as local `const` strings (no import from `ConfigurationUtils`) — the server cannot depend on VS Code extension utilities. Keep them in sync with `ConfigurationUtils.PATH_CONSTANTS`.
</mcpServer>

<devMode>
`IS_DEV_MODE` (from `src/utils/BuildConfig.ts`) is replaced at build time by esbuild. Dev commands are registered only when `IS_DEV_MODE === true` and are never declared in `package.json`. They are stripped entirely in production builds via `scripts/strip-dev-commands.mjs`.
</devMode>
