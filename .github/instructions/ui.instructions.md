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
- Builds and sends `INIT`, `GLOBAL_SETTINGS_UPDATED`, `MODEL_OPTIONS_UPDATE`, `HARNESS_STATUS_UPDATE`, `AGENTS_UPDATE`, `SKILLS_UPDATE` messages
- Tracks harness availability for all 5 harnesses
- Discovers agents (`AgentDiscovery`) and skills (`SkillDiscovery`) in background
- Handles all settings change messages from webview (harness, model, agent, execution mode, resume session, dynamic queue, workflow properties, set-as-default, get/update config)
- Config read/write gated to `flightpath.*` keys (security allowlist)

**WebviewMessageRouter:** Dispatch table replacing a monolithic switch statement.
- Routes all incoming webview messages via a `Map<string, handler>` dispatch table
- Serializes handlers through a `routeQueue` promise chain (prevents concurrent execution)
- Delegates to `WebviewSettingsSync`, `WorkflowSerializer`, or orchestrator commands

**WorkflowSerializer:** Workflow persistence operations.
- Save workflow to disk (YAML or JSON), strips runtime/working-file-only fields
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
- **Harness status states (shown when idle):**
  - `$(compass) FlightPath - Initializing...` — checking availability
  - `$(compass) FlightPath - Waiting for Copilot (N/M)` — polling
  - `$(compass-active) FlightPath - Ready`
  - `$(warning) FlightPath - Setup Required`
- Uses `vscode.ThemeColor` for background colors

**Icons:** Custom icon system in `src/ui/icons/`
- SVG source files: append.svg, append-next.svg, from-template.svg, load-from-file.svg, queue-from-file.svg
- Auto-converted to CSS via `npm run generate-icons` (runs as part of precompile)
- Output: `src/ui/webview-react/custom-icons.css`
- Usage: `<i class="custom-icon icon-{name}"></i>`
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
**Five harnesses tracked:**
- COPILOT_CLI: GitHub Copilot CLI executable
- COPILOT_CHAT: GitHub Copilot Chat extension
- CLAUDE_CLI: Claude Code CLI executable
- CODEX_CLI: Codex CLI executable
- OPENCODE_CLI: OpenCode CLI executable

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
- All harness model options include a `{ value: "none", label: "None (skip --model flag)" }` entry (except Copilot Chat)
</harnessAvailability>

<criticalPatterns>
**vscodeApi capture:** Must happen BEFORE React modules load (acquireVsCodeApi only callable once)
**CSP policy:** Nonce-based script-src (no unsafe-inline), style-src allows inline (Tailwind), img-src allows data URIs and https
**Circular dependency:** FlightPathWebviewProvider created first, `setWorkflowOrchestrator()` called after
**Resource URIs:** All assets loaded via `webview.asWebviewUri()` for security
**Message validation:** Validate harness IDs against `VALID_HARNESSES` in WebviewSettingsSync (5 entries)
**routeQueue:** All webview messages are serialized through a chained promise — never process two messages concurrently
**No emoji:** Use codicons or custom-icons only
</criticalPatterns>

<relatedFiles>
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
