---
applyTo: "src/ui/**"
exclude: "src/ui/webview-react/**"
---

<purpose>
UI provider layer that bridges extension and React webview. Manages status bar, webview lifecycle, message routing, and resource loading. The actual UI implementation is in src/ui/webview-react/ (see webview-react.instructions.md).
</purpose>

<architecture>
**FlightPathWebviewProvider:** Coordination hub — lifecycle/HTML generation and public update API.
- Implements `vscode.WebviewViewProvider` for sidebar panel
- Loads React app from `out/ui/webview-react/` (Vite-built)
- Injects webview resource URIs into HTML (assets, typo.js, codicons, custom-icons.css, spell-check dictionaries, logo)
- `localResourceRoots`: webview-react dir + images dir
- Constructs and holds three delegate classes; harness availability driven by WorkflowOrchestrator via `notifyHarnessAvailability()` (not polled in constructor)
- Listens for model registry updates (`onModelsLoaded`) and config changes to forward to webview

**WebviewSettingsSync:** Settings/config management and broadcast.

- Builds and sends `INIT`, `GLOBAL_SETTINGS_UPDATED`, `MODEL_OPTIONS_UPDATE`, `HARNESS_STATUS_UPDATE`, `AGENTS_UPDATE`, `SKILLS_UPDATE`, `WORKFLOW_PROPERTIES_UPDATE`, `WORKFLOW_LOADED`, `WORKFLOW_UNLOADED`, `CONFIG_VALUE` messages
- Tracks harness availability for all 7 harnesses (including Qwen CLI and Gemini CLI)
- Discovers agents (`AgentDiscovery`) and skills (`SkillDiscovery`) in background
- Handles all settings change messages from webview (harness, model, agent, execution mode, resume session, dynamic queue, workflow properties, hooks, MCP servers, set-as-default, get/update config)
- Handles hooks property: reads via `ConfigurationUtils.getDefaultHooks()`, persists via `ConfigurationUtils.setDefaultHooks()`
- Handles MCP servers property: reads/persists via `ConfigurationUtils`, exposes `handleMcpServersChange()` for default MCP server updates
- `writeCapabilities()` writes MCP server capabilities to `.flightpath/capabilities.json` for external MCP server process validation
- Config read/write gated to `flightpath.*` keys (security allowlist)

**WebviewMessageRouter:** Dispatch table replacing a monolithic switch statement.

- Routes all incoming webview messages via a `Map<string, handler>` dispatch table (~70 message types)
- Serializes handlers through a `routeQueue` promise chain (prevents concurrent execution)
- Delegates to `WebviewSettingsSync`, `WorkflowSerializer`, or orchestrator commands
- MCP discovery routes: `REQUEST_MCP_LOCAL_SERVERS`, `REQUEST_MCP_REGISTRY`, `REQUEST_MCP_WORKSPACE_SERVERS`, `SAVE_MCP_WORKSPACE_SERVERS`, `CHANGE_MCP_SERVERS`
- Terminal I/O routes: `TERMINAL_INPUT`, `TERMINAL_RESIZE`, `TERMINAL_SPAWN_SHELL`, `TERMINAL_RESTART_SHELL`, `TERMINAL_CLOSE_SHELL`
- Multi-workflow routes: `GET_WORKFLOWS_LIST`, `SWITCH_WORKFLOW`, `PAUSE_WORKFLOW`, `RESUME_WORKFLOW`, `STOP_WORKFLOW`, `STOP_CLI_RUN`
- Undo/redo routes: `UNDO_PROMPT_CHANGES`, `REDO_PROMPT_CHANGES`, `UNDO_WORKFLOW_CHANGES`, `REDO_WORKFLOW_CHANGES`

**WorkflowSerializer:** Workflow persistence operations.

- Save workflow to disk (YAML or JSON), strips runtime/working-file-only fields
- Field whitelisting: only known fields persisted (WORKFLOW_FIELDS includes harness, model, agent, resumeSession, mcpServers, hooks, sessionId, endCondition; PROMPT_FIELDS includes corresponding per-prompt fields)
- Export output as markdown
- New workflow creation (template modal: select, create, browse variables, set default)
- Workflow history (recent workflows, load, remove, clear)
- Run history (load, clear)

**StatusBarManager:** Status bar item (`flightpath.openPanel` command).

- **Queue execution states:**
  - `$(compass) FlightPath` — idle (default)
  - `$(compass-dot) FlightPath N/M` — running (prominentBackground)
  - `$(debug-pause) FlightPath N/M` — paused (warningBackground)
  - `$(check) FlightPath Complete` — completed, auto-hides after 5s
  - `$(error) FlightPath Error` — error (errorBackground)
- **Harness status states (shown when idle via `HarnessDetailedStatus`):**
  - `$(compass) FlightPath - Initializing...` — checking availability
  - `$(compass) FlightPath - Waiting for Copilot (N/M)` — polling with attempt count
  - `$(compass-active) FlightPath - Ready`
  - `$(warning) FlightPath - Setup Required`
- `HarnessDetailedStatus` interface: `initializationStatus`, `isReady`, `message`, optional `pollingAttempts`/`maxPollingAttempts`
- `updateStatusBar()` accepts optional `copilotStatus: HarnessDetailedStatus` for dynamic idle-state display
- Uses `vscode.ThemeColor` for background colors

**Icons:** Custom icon system in `src/ui/icons/`

- Workflow action SVGs: append.svg, append-next.svg, from-template.svg, load-from-file.svg, queue-from-file.svg
- Harness SVGs in `icons/harnesses/`: claude.svg, codex.svg, copilot-chat.svg, copilot-cli.svg, gemini.svg, opencode.svg, qwen.svg
- Auto-converted to CSS via `npm run generate-icons` (runs as part of precompile)
- Output: `src/ui/webview-react/custom-icons.css`
- Usage: `<i class="custom-icon icon-{name}"></i>`

**FlightPathMcpServerProvider:** Dynamic MCP server injection for copilot-chat harness.

- Implements `vscode.McpServerDefinitionProvider`
- Converts user-defined `McpServerConfig[]` into `vscode.McpStdioServerDefinition[]` for VS Code's MCP subsystem
- `setActiveServers()` called by WorkflowExecutor when chat prompt starts; manages only user-defined servers
- `provideMcpServerDefinitions()` returns active server definitions to VS Code
- CLI harnesses use `CliMcpConfigGenerator` instead (pass `--mcp-config` flags)
- The built-in "flightpath" MCP server is NOT managed here — registered unconditionally via `registerLanguageModelTools()` at extension activation
  </architecture>

<terminology>
**Critical:** "Provider" has been renamed to "harness" throughout the codebase
- Old: copilot-cli provider, copilot-chat provider, claude-cli provider
- New: copilot-cli harness, copilot-chat harness, claude-cli harness
- Constants: HARNESS_IDS (not PROVIDER_IDS)
- Types: Harness type (from FlightPathTypes)
- Configuration: flightpath.harness setting
- Always use "harness" in new code, comments, and messages
</terminology>

<webviewLifecycle>
**Initialization:**
1. FlightPathWebviewProvider.resolveWebviewView() called when panel opens
2. Load index.html from out/ui/webview-react/ (Vite-built React app)
3. Replace asset paths (/assets/) with webview URIs
4. Inject vscodeApi capture script BEFORE React modules
5. Update CSP meta tag for webview restrictions
6. Send initial state when webview sends READY message

**Message flow:**

- Extension → Webview: view.webview.postMessage()
- Webview → Extension: vscodeApi.postMessage() → handleWebviewMessage()
- Message types defined in DashboardConstants.ts (MESSAGE_TYPES)

**State management:**

- Extension is source of truth for all state
- Webview requests changes via messages
- Configuration changes trigger sendInitialState()
- Model registry updates trigger sendModelOptionsUpdate()
  </webviewLifecycle>

<harnessAvailability>
**Seven harnesses tracked:**
- COPILOT_CLI: GitHub Copilot CLI executable
- COPILOT_CHAT: GitHub Copilot Chat extension
- CLAUDE_CLI: Claude Code CLI executable
- CODEX_CLI: Codex CLI executable
- OPENCODE_CLI: OpenCode CLI executable
- QWEN_CLI: Qwen Code CLI executable
- GEMINI_CLI: Gemini CLI executable

**Availability checks:**

- CLI harnesses: Execute --version command
- Chat harness: Check VS Code extension activation
- Status: "checking" → "available" | "unavailable"
- Results cached in `WebviewSettingsSync.harnessStatus` and sent to webview for harness dropdown
- `notifyHarnessAvailability(harnessId, available)` on `WebviewSettingsSync` updates status and pushes `HARNESS_STATUS_UPDATE`

**Model availability:**

- Copilot Chat: Dynamic discovery via ModelRegistry (vscode.lm API)
- Copilot CLI: CLI-supported model IDs from ModelRegistry
- Claude CLI: Static list from `CLAUDE_CLI_MODEL_LABELS`
- Codex CLI: Static list from `CODEX_CLI_MODEL_LABELS`
- OpenCode CLI: Dynamic IDs from `getOpenCodeModelIdsSync()`
- Qwen CLI: Static list from `QWEN_CLI_MODEL_LABELS`
- Gemini CLI: Static list from `GEMINI_CLI_MODEL_LABELS`
- All harness model options include a `{ value: "none", label: "None (skip --model flag)" }` entry (except Copilot Chat)
  </harnessAvailability>

<criticalPatterns>
**vscodeApi capture:** Must happen BEFORE React modules load (acquireVsCodeApi only callable once)
**CSP policy:** Nonce-based script-src (no unsafe-inline), style-src allows inline (Tailwind), img-src allows data URIs and https
**Circular dependency:** FlightPathWebviewProvider created first, `setWorkflowOrchestrator()` called after
**Resource URIs:** All assets loaded via `webview.asWebviewUri()` for security
**Message validation:** Validate harness IDs against `VALID_HARNESSES` in WebviewSettingsSync (7 entries)
**routeQueue:** All webview messages are serialized through a chained promise — never process two messages concurrently
**No emoji:** Use codicons or custom-icons only
</criticalPatterns>

<relatedFiles>
- `src/ui/FlightPathMcpServerProvider.ts` — dynamic MCP server injection for copilot-chat harness
- `src/ui/WebviewSettingsSync.ts` — settings/config management and harness availability tracking
- `src/ui/WebviewMessageRouter.ts` — dispatch table for all webview → extension messages
- `src/ui/WorkflowSerializer.ts` — save/export/template/history operations
- `src/ui/webview-react/` — React UI implementation (separate instructions file)
- `src/flightpath/WorkflowOrchestrator.ts` — calls webview update methods and `notifyHarnessAvailability()`
- `src/types/DashboardConstants.ts` — MESSAGE_TYPES, EXECUTION_STATES, HARNESS_IDS, HARNESS_STATUS_STRINGS
- `src/utils/ModelRegistry.ts` — runtime model discovery
- `src/utils/ModelConstants.ts` — model display names and static model lists
- `src/flightpath/TemplateManager.ts` — workflow template discovery
- `src/utils/AgentDiscovery.ts` — agent file discovery
- `src/utils/SkillDiscovery.ts` — skill file discovery
</relatedFiles>
