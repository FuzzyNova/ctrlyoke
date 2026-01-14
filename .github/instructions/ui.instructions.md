---
applyTo: "src/ui/**"
---

<purpose>
Status bar, dashboard WebView, settings panel, template management. Three-panel dashboard: Prompts List + CLI Output + Prompt Editor.
</purpose>

<statusBarManager>
**Icons:** `$(compass)` idle, `$(compass-dot)` running, `$(debug-pause)` paused, `$(check)` success (auto-hide 5s), `$(error)` error
**Colors:** ThemeColor for automatic adaptation (prominentBackground, warningBackground, errorBackground)
**Progress:** Current = completed (not sent), displays "N/M" counter
</statusBarManager>

<dashboardProvider>
**Template:** `dashboard.html` with `{{placeholders}}` for URIs. Includes CodeMirror editor, token counter, spell check.
**State sync:** Extension is source of truth, webview requests changes via MESSAGE_TYPES
**Update methods:** File loaded, execution state/progress, step status, CLI output/streaming, queue extension, prompt edit/delete, model options
**Message handlers:** Command-mapped (NEW_PROMPT, RUN, etc.) + direct (EXPORT_OUTPUT, EXECUTE_PROMPT, UPDATE_PROMPT, DELETE_PROMPT, completions)
**Layout:** Three-panel responsive (prompts + output + editor), collapsible, swappable, modal for templates
</dashboardProvider>

<settingsProvider>
**Responsibilities:** Provider/model selection (4 providers with separate models), agent, execution mode, dynamic queue toggle
**Provider availability:** Checks CLI executables and VS Code extensions, shows status in dropdown
**Model selection:** Dynamic (Copilot from ModelRegistry) vs static (Claude/Codex lists)
**Cross-view sync:** Both dashboard and settings listen to configuration changes (not direct messages)
</settingsProvider>

<webviewAssets>
**Source:** `src/ui/webview/` → `out/ui/webview/` (build copies all)
**HTML templates:** dashboard.html, settings.html (placeholders replaced at runtime)
**Styles:** shared.scss (common), dashboard.scss/settings.scss (specific, compiled to CSS), custom-icons.css (auto-generated from SVG)
**Scripts:** dashboard.js, settings.js, codemirror-editor.js, codemirror-loader.js, gpt-tokenizer-bundle.js, typo.js
**Assets:** dictionaries/ (spell check), codicons/ (VS Code icons)
**DashboardConstants.ts:** Compiled separately (no VS Code imports), shared by TypeScript and JavaScript
</webviewAssets>

<criticalPatterns>
**Icon system:** NEVER use emoji. ALWAYS use codicons: `<i class="codicon codicon-{name}"></i>`. Custom icons via data URI in custom-icons.css.
**CSP:** All resources via webview URIs, no inline scripts/eval, icons as data URIs
**Theme:** All colors via `--vscode-*` variables for light/dark/high-contrast
**State:** Extension is source of truth, webview cleared on reload, editor persisted in memento
**Progress:** Current = completed (not sent), total can grow with dynamic queue
**Auto-hide:** Success hides after 5s, errors require acknowledgment
**Circular dependency:** Dashboard created first, `setFlightPathManager()` called after to set reference
</criticalPatterns>

<relatedFiles>
- FlightPathManager.ts - Orchestration, calls update methods
- PromptQueue.ts - State machine, events
- TemplateManager.ts - Workflow templates
- CompletionHelpers.ts - Autocomplete for `@file`, `#file:`
- ModelRegistry.ts - Available models per provider
- ModelConstants.ts - Model display names
- DashboardConstants.ts - MESSAGE_TYPES, EXECUTION_STATES, etc.
</relatedFiles>
