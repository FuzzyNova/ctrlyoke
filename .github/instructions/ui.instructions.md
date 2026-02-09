---
applyTo: "src/ui/**"
exclude: "src/ui/webview-react/**"
---

<purpose>
UI provider layer that bridges extension and React webview. Manages status bar, webview lifecycle, message routing, and resource loading. The actual UI implementation is in src/ui/webview-react/ (see webview-react.instructions.md).
</purpose>

<architecture>
**FlightPathWebviewProvider:** Single unified provider (replaced old FlightPathDashboardProvider and FlightPathSettingsProvider)
- Implements vscode.WebviewViewProvider for sidebar panel
- Loads React app from out/ui/webview-react/
- Handles message routing between extension and React UI
- Manages harness availability checks
- Discovers available agents
- Injects webview resource URIs into Vite-built HTML

**StatusBarManager:** Status bar item manager

- Updates based on queue state and harness status
- Icons: $(compass) idle, $(compass-dot) running, $(debug-pause) paused, $(check) success, $(error) error
- Colors: ThemeColor for automatic theme adaptation
- Progress: Current = completed (not sent), displays "N/M" counter
- Auto-hide: Success hides after 5s, errors require acknowledgment

**Icons:** Custom icon system in src/ui/icons/

- SVG source files (not copied to output)
- Auto-converted to CSS via npm run generate-icons
- Output: src/ui/webview-react/custom-icons.css
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
**Four harnesses tracked:**
- COPILOT_CLI: GitHub Copilot CLI executable
- COPILOT_CHAT: GitHub Copilot Chat extension
- CLAUDE_CLI: Claude Code CLI executable  
- CODEX_CLI: Codex CLI executable

**Availability checks:**

- CLI harnesses: Execute --version command
- Chat harness: Check VS Code extension activation
- Status: "checking" → "available" | "unavailable"
- Results cached and sent to webview for harness dropdown

**Model availability:**

- Copilot: Dynamic discovery via ModelRegistry (vscode.lm API)
- Claude: Static list from CLAUDE_CLI_MODEL_LABELS
- Codex: Static list from CODEX_CLI_MODEL_LABELS
  </harnessAvailability>

<criticalPatterns>
**vscodeApi capture:** Must happen BEFORE React modules load (acquireVsCodeApi only callable once)
**CSP policy:** script-src for vscodeApi, style-src for Tailwind inline styles, img-src for data URIs
**Circular dependency:** FlightPathWebviewProvider created first, setFlightPathManager() called after
**Resource URIs:** All assets loaded via webview.asWebviewUri() for security
**Message validation:** Validate harness IDs against VALID_HARNESSES constant
**No emoji:** Use codicons or custom-icons only
</criticalPatterns>

<relatedFiles>
- src/ui/webview-react/ - React UI implementation (separate instructions file)
- FlightPathManager.ts - Orchestration, calls webview update methods
- DashboardConstants.ts - MESSAGE_TYPES, EXECUTION_STATES, HARNESS_IDS
- ModelRegistry.ts - Runtime model discovery
- ModelConstants.ts - Model display names and mappings
- TemplateManager.ts - Workflow template discovery
- AgentDiscovery.ts - Agent file discovery
</relatedFiles>
