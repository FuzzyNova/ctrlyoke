# Standalone FlightPath Server Plan

## Overview

Expose the existing `src/ui/webview-react/` React dashboard as a browser-accessible web app backed by a standalone HTTP/WebSocket server. The server delivers **full feature parity with the VS Code extension** — including parallel workflow execution, the workflow switcher dropdown, run history, and all message types. The only exclusions are capabilities that are inherently VS Code-specific (file pickers, Copilot Chat harness).

The server is added as a new `server` subcommand to the existing `flightpath` CLI binary.

## Mode Comparison

| Feature | `flightpath run` (CLI) | `flightpath server` (standalone) | VS Code Extension |
|---------|----------------------|----------------------------------|-------------------|
| Parallel workflows | No — single run | **Yes** | **Yes** |
| Full dashboard webview | No — terminal output | **Yes** | **Yes** |
| Workflow switcher dropdown | No | **Yes** | **Yes** |
| Run history | No | **Yes** | **Yes** |
| File picker dialogs | No | No (path input only) | Yes |
| `copilot-chat` harness | No | No (VS Code UI automation) | Yes |

## Goals

- Serve the existing React webview at `http://localhost:<port>` in any browser with zero React code changes
- Full feature parity with the VS Code dashboard (parallel workflows, switcher, history, all message types)
- Replace VS Code-specific APIs with browser-compatible equivalents via a minimal shim
- Reuse `WorkflowOrchestrator` directly — no parallel orchestration logic
- Support light and dark themes out of the box

## Non-Goals

- Real-time multi-user collaboration (each server instance = one workspace)
- Remote workflow execution beyond what the CLI already supports
- A full VS Code extension replacement
- Supporting the `copilot-chat` harness (directly automates VS Code's UI)

---

## Architecture

```
Browser (1..N tabs)
  ↕ HTTP (React app assets)
  ↕ WebSocket (bidirectional, same MESSAGE_TYPES protocol as VS Code)
Standalone FlightPath Server (Node.js)
  ├── FlightPathServer        — HTTP + WS, connection registry, broadcast
  ├── StandaloneServerAdapter — PlatformAdapter impl (modeled on CliAdapter)
  ├── WorkflowOrchestrator    — REUSED unchanged (after IDashboardProvider refactor)
  └── CliIntegration + CLI harnesses (copilot-cli, claude-cli, codex-cli — unchanged)
```

### Multi-tab Model

One server instance = one `WorkflowOrchestrator` managing all parallel workflows. Multiple browser tabs connect as separate WebSocket clients but observe the **same orchestrator state**. When any orchestrator event fires (workflow added, step advance, state change), the server broadcasts to **all connected tabs**.

This mirrors VS Code behavior: opening the FlightPath sidebar in multiple panels shows the same state.

### Key Insight: The Shim Pattern

The React app communicates with VS Code through a single narrow interface:

```typescript
// Set once before React loads
window.vscodeApi = acquireVsCodeApi();
// Returns: { postMessage(msg), getState(), setState(state) }
```

By injecting a **WebSocket shim** in place of `acquireVsCodeApi()`, the entire contract is satisfied without touching a single React file. The existing `useMessageHandler` hook already listens on `window.addEventListener('message', ...)` — the shim reuses this via `dispatchEvent(new MessageEvent(...))`.

### Existing Patterns Reused

| Pattern | Where It Exists | How Server Uses It |
|---------|----------------|--------------------|
| `PlatformAdapter` interface | `src/platform/PlatformAdapter.ts` | `StandaloneServerAdapter` is the third implementation |
| `vscode-shim` alias | `esbuild.js` CLI bundle | Server bundle uses the same `alias: { vscode: 'src/platform/vscode-shim.ts' }` |
| `WorkflowOrchestrator` | `src/flightpath/WorkflowOrchestrator.ts` | Reused after `IDashboardProvider` refactor (see Phase 2) |
| Commander.js subcommands | `src/cli.ts` | `server` added as `program.command('server')` |
| `setRuntimeMode` | `src/cli.ts` line 21 | Server calls `setRuntimeMode(RUNNER_IDS.SERVER)` |

---

## VS Code Dependencies Inventory

### Structural VS Code Dependencies (not used by server)

| File | Why Irrelevant |
|------|---------------|
| `src/extension.ts` | Extension activation — not used by server |
| `src/ui/StatusBarManager.ts` | VS Code status bar — no equivalent needed |
| `src/completions/PromptCompletionProvider.ts` | VS Code IntelliSense in text editor |
| `src/completions/PromptLinkProvider.ts` | VS Code document links — CodeMirror has its own |
| `src/flightpath/harness/chat/` | Automates VS Code's Copilot Chat UI |

### VS Code Dependencies Requiring Server Equivalents

| File | VS Code API Used | Server Approach |
|------|-----------------|----------------|
| `src/ui/FlightPathWebviewProvider.ts` | `vscode.WebviewView`, `webview.postMessage()`, `notifyX()` methods | Replaced by `FlightPathServer` + WebSocket broadcast |
| `src/flightpath/WorkflowOrchestrator.ts` | `vscode.ExtensionContext`, `FlightPathWebviewProvider` | Refactored to depend on `IDashboardProvider` interface (Phase 2) |
| `src/ui/WebviewMessageRouter.ts` | `vscode.commands.executeCommand()` (9 handlers) | `WebSocketMessageRouter` calls `WorkflowOrchestrator` methods directly |
| `src/ui/WebviewSettingsSync.ts` | `vscode.workspace.getConfiguration()` | Reads from `StandaloneServerAdapter.getConfig()` |
| `src/utils/ConfigurationUtils.ts` | `vscode.workspace.getConfiguration()` | Already bypassed when called through `CliAdapter.getConfig()` |
| `src/flightpath/orchestration/PromptFileWatcher.ts` | `vscode.workspace.createFileSystemWatcher()` | `chokidar` (already in dependencies) |
| `src/completions/CompletionHelpers.ts` | `vscode.workspace.findFiles()`, Git extension | Node.js `fs` + `fast-glob` + `ignore` |

### Already Platform-Agnostic (zero changes)

- `src/flightpath/WorkflowInstance.ts`
- `src/flightpath/PromptQueue.ts` / `WorkflowExecutor.ts`
- `src/flightpath/PromptFileParser.ts` / `EndConditionEvaluator.ts`
- `src/flightpath/harness/CliIntegration.ts` + all CLI harnesses
- `src/ui/webview-react/**` — entire React app and all stores
- `src/types/**` — MESSAGE_TYPES, EXECUTION_STATES, WorkflowSummary, etc.

---

## Implementation Plan

### Phase 1 — WebSocket Shim (browser side)

**New file:** `src/server/standalone-shim.js` (plain JS — injected directly into HTML before React loads)

```javascript
(function () {
  let _state = JSON.parse(sessionStorage.getItem('fpState') || '{}');
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener('open', () => {
    pending.forEach(m => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener('message', e => {
    // useMessageHandler already listens on window.addEventListener('message', ...)
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
  });

  // Reconnect on server restart (development convenience)
  ws.addEventListener('close', () => setTimeout(() => location.reload(), 1500));

  window.vscodeApi = {
    postMessage(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    getState() { return _state; },
    setState(s) {
      _state = s;
      sessionStorage.setItem('fpState', JSON.stringify(s));
    },
  };
})();
```

**Why `sessionStorage`?** Matches VS Code's `setState` semantics — cleared on tab close, persisted through refresh.

---

### Phase 2 — Extract `IDashboardProvider` Interface (Refactor)

**This is the critical architectural enabler.** `WorkflowOrchestrator` currently takes `FlightPathWebviewProvider` (a VS Code class) as a constructor parameter and calls `notifyX()` methods on it to push state to the webview.

To reuse `WorkflowOrchestrator` in the server without modification, extract its dependency on `FlightPathWebviewProvider` into a minimal interface:

**New file:** `src/ui/IDashboardProvider.ts`

```typescript
import type { WorkflowSummary } from '../types/FlightPathTypes';

/**
 * Platform-agnostic interface for pushing workflow state updates to the dashboard.
 * Implemented by FlightPathWebviewProvider (VS Code) and FlightPathServer (standalone).
 */
export interface IDashboardProvider {
  notifyWorkflowAdded(summary: WorkflowSummary): void;
  notifyWorkflowDismissed(workflowId: string): void;
  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void;
  notifyActiveWorkflowChanged(workflowId: string): void;
  postMessage(message: unknown): void;
}
```

**Update `WorkflowOrchestrator`:**
- Change constructor parameter from `FlightPathWebviewProvider` to `IDashboardProvider`
- No other changes — all `dashboardProvider.notifyX()` calls remain identical

**Update `FlightPathWebviewProvider`:**
- Add `implements IDashboardProvider` (it already has all these methods — zero implementation changes)

**Update `WorkflowOrchestrator` constructor** to remove `vscode.ExtensionContext` if it is only used for VS Code-specific concerns (file watching, CLI watch session storage). If `ExtensionContext` is also used for extension path resolution, pass that via `PlatformAdapter.getExtensionPath()` instead.

> This is a clean pre-release refactor. The interface is tiny (5 methods) and the only mechanical changes are the `implements` keyword and the constructor parameter type. Zero business logic changes.

---

### Phase 3 — CSS Theme Defaults

**New files:** `src/server/themes/vscode-default-dark.css`, `src/server/themes/vscode-default-light.css`

All `--vscode-*` variables referenced in `tailwind.config.js` must be defined. Complete variable list:

| Group | Variables |
|-------|-----------|
| Editor | `--vscode-editor-background`, `--vscode-editor-foreground` |
| Button | `--vscode-button-background`, `--vscode-button-foreground`, `--vscode-button-hoverBackground`, `--vscode-button-secondaryBackground`, `--vscode-button-secondaryForeground`, `--vscode-button-secondaryHoverBackground` |
| Input | `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-input-placeholderForeground` |
| Dropdown | `--vscode-dropdown-background`, `--vscode-dropdown-foreground`, `--vscode-dropdown-border` |
| List | `--vscode-list-hoverBackground`, `--vscode-list-activeSelectionBackground`, `--vscode-list-activeSelectionForeground` |
| Panel | `--vscode-panel-background`, `--vscode-panel-border`, `--vscode-sideBar-background`, `--vscode-sideBarSectionHeader-background`, `--vscode-sideBarSectionHeader-border` |
| Scrollbar | `--vscode-scrollbarSlider-background`, `--vscode-scrollbarSlider-hoverBackground`, `--vscode-scrollbarSlider-activeBackground` |
| Badge | `--vscode-badge-background`, `--vscode-badge-foreground` |
| Progress | `--vscode-progressBar-background` |
| Focus border | `--vscode-focusBorder` |
| Diff | `--vscode-diffEditor-insertedLineBackground`, `--vscode-diffEditor-removedLineBackground`, `--vscode-diffEditor-insertedTextBackground`, `--vscode-diffEditor-removedTextBackground` |
| Terminal ANSI | `--vscode-terminal-ansiGreen/Red/Yellow/Blue/Magenta/Cyan/White/Black` + Bright variants (16 total) |
| Foreground tokens | `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-disabledForeground`, `--vscode-errorForeground`, `--vscode-icon-foreground` |
| Fonts | `--vscode-font-family`, `--vscode-font-size`, `--vscode-font-weight`, `--vscode-editor-font-family`, `--vscode-editor-font-size` |
| Codicons | `--vscode-codicon-font-path` |

**Codicon path:** Vite copies codicons to `out/ui/webview-react/codicons/codicon.ttf`. Set:
```css
--vscode-codicon-font-path: url('/codicons/codicon.ttf');
```

Values sourced from VS Code's `src/vs/platform/theme/common/colorRegistry.ts` for Default Light+ and Default Dark+.

**Theme selection priority:**
1. `?theme=light|dark` query parameter
2. `Sec-CH-Prefers-Color-Scheme` request header
3. Default: dark

---

### Phase 4 — StandaloneServerAdapter

**New file:** `src/server/StandaloneServerAdapter.ts`

The third `PlatformAdapter` implementation, modeled directly on `CliAdapter`. Maps server config (CLI flags + optional config file) to the same `getConfig()` key names that `ConfigurationUtils` uses internally.

```typescript
export interface StandaloneServerConfig {
  port: number;
  cwd: string;
  theme: 'light' | 'dark';
  open: boolean;
  harness: string;
  model?: string;
  allowedTools: string[];
  deniedTools: string[];
  allowAllTools: boolean;
  scriptTimeout: number;
  timeout: number;
}

export class StandaloneServerAdapter implements PlatformAdapter {
  constructor(private config: StandaloneServerConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    // Same switch/case as CliAdapter.getConfig() — maps config properties
    // to ConfigurationUtils key names.
    // Key difference: cliExecutionMode always returns "headless"
    // (server spawns child processes, not VS Code terminals)
  }

  getWorkspaceRoot(): string { return this.config.cwd ?? process.cwd(); }
  getExtensionPath(): string { /* same logic as CliAdapter */ }
  isVsCode?(): boolean { return false; }
  log/warn/error/showProgress: console.*
  showChoice: async () => undefined  // headless — no interactive prompts
}
```

**`cliExecutionMode: "headless"`** — `CliIntegration` reads this to decide whether to create a VS Code terminal or spawn a child process with `stdio: 'pipe'`. The server always uses the pipe path so output can be captured and forwarded to the webview over WebSocket.

---

### Phase 5 — HTTP / WebSocket Server

**New file:** `src/server/FlightPathServer.ts`

`FlightPathServer` implements `IDashboardProvider` — it is the server-side equivalent of `FlightPathWebviewProvider`.

```typescript
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { WorkflowOrchestrator } from '../flightpath/WorkflowOrchestrator';
import { StandaloneServerAdapter } from './StandaloneServerAdapter';
import type { IDashboardProvider } from '../ui/IDashboardProvider';
import type { WorkflowSummary } from '../types/FlightPathTypes';
import { MESSAGE_TYPES } from '../types/DashboardConstants';
import { setRuntimeMode } from '../utils/RuntimeMode';
import { RUNNER_IDS } from '../types/DashboardConstants';

export class FlightPathServer implements IDashboardProvider {
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ server: this.httpServer });
  private connections = new Set<WebSocket>();  // all active tabs
  private adapter: StandaloneServerAdapter;
  private orchestrator: WorkflowOrchestrator;

  constructor(private config: StandaloneServerConfig) {
    setRuntimeMode(RUNNER_IDS.SERVER);
    this.adapter = new StandaloneServerAdapter(config);
    // WorkflowOrchestrator takes IDashboardProvider — this server IS the provider
    this.orchestrator = new WorkflowOrchestrator(this.adapter, this);
    this.setupRoutes();
    this.setupWebSocket();
  }

  // ── IDashboardProvider implementation ─────────────────────────────────────
  // These mirror the notify* methods in FlightPathWebviewProvider

  notifyWorkflowAdded(summary: WorkflowSummary) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }
  notifyWorkflowDismissed(workflowId: string) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId });
  }
  notifyWorkflowSummaryUpdated(summary: WorkflowSummary) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });
  }
  notifyActiveWorkflowChanged(workflowId: string) {
    this.broadcast({ type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, workflowId });
  }
  postMessage(message: unknown) {
    this.broadcast(message);
  }

  // ── Broadcast to all connected tabs ───────────────────────────────────────
  private broadcast(message: unknown) {
    const json = JSON.stringify(message);
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────
  private setupRoutes() {
    const webviewDist = path.resolve(this.getWebviewDistDir());

    this.app.use(express.static(webviewDist));
    this.app.use('/theme', express.static(path.join(__dirname, 'themes')));
    this.app.get('/standalone-shim.js', (_req, res) =>
      res.sendFile(path.join(__dirname, 'standalone-shim.js'))
    );
    this.app.get('*', (req, res) => {
      const theme = (req.query.theme as string) ?? this.detectTheme(req);
      res.send(this.buildHtml(theme, webviewDist));
    });
  }

  private buildHtml(theme: string, webviewDist: string): string {
    const index = fs.readFileSync(path.join(webviewDist, 'index.html'), 'utf8');
    return index.replace('</head>',
      `<link rel="stylesheet" href="/theme/${theme}.css">
       <script src="/standalone-shim.js"></script>
       </head>`
    );
  }

  // ── WebSocket connection handling ─────────────────────────────────────────
  private setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      if (!this.isAllowedOrigin(req)) { ws.close(4003, 'Forbidden'); return; }

      this.connections.add(ws);

      // New tab: send full current state (all running workflows + active workflow data)
      this.sendInitialState(ws);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.router.route(msg);
      });

      ws.on('close', () => this.connections.delete(ws));
    });
  }

  private sendInitialState(ws: WebSocket) {
    const send = (msg: unknown) => ws.send(JSON.stringify(msg));
    // Mirror FlightPathWebviewProvider's READY → INIT handshake
    // Send settings, workflow summaries, active workflow state
    this.settingsSync.sendToClient(send);
    send({ type: MESSAGE_TYPES.WORKFLOWS_LIST, workflows: this.orchestrator.getWorkflowSummaries() });
    const active = this.orchestrator.getActiveWorkflow();
    if (active) active.sendFullStateToDashboard(); // broadcasts via IDashboardProvider
  }

  listen() {
    this.httpServer.listen(this.config.port, '127.0.0.1', () => {
      console.log(`FlightPath server at http://localhost:${this.config.port}`);
      if (this.config.open) open(`http://localhost:${this.config.port}`);
    });
  }
}
```

**Webview dist path:** Vite outputs to `out/ui/webview-react/` (confirmed in `vite.config.ts` line 44).

---

### Phase 6 — WebSocket Message Router

**New file:** `src/server/WebSocketMessageRouter.ts`

Handles all webview → server messages. The existing `WebviewMessageRouter.ts` cannot be reused directly because 9 handlers call `vscode.commands.executeCommand()`. The server router replaces those with direct `WorkflowOrchestrator` method calls.

**The handler mapping:**

| Message Type | VS Code Handler | Server Handler |
|-------------|----------------|----------------|
| `RUN` | `executeCommand("flightpath.run")` | `orchestrator.run(filePath)` |
| `PAUSE` | `executeCommand("flightpath.pause")` | `orchestrator.pause()` |
| `RESUME` | `executeCommand("flightpath.resume")` | `orchestrator.resume()` |
| `STOP` | `executeCommand("flightpath.stop")` | `orchestrator.stop()` |
| `PAUSE_WORKFLOW` | `orchestrator.pauseWorkflow(id)` | Same — direct call |
| `RESUME_WORKFLOW` | `orchestrator.resumeWorkflow(id)` | Same — direct call |
| `STOP_WORKFLOW` | `orchestrator.stopWorkflow(id)` | Same — direct call |
| `SWITCH_WORKFLOW` | `orchestrator.setActiveWorkflow(id)` | Same — direct call |
| `GET_WORKFLOWS_LIST` | `orchestrator.getWorkflowSummaries()` | Same — direct call |
| `LOAD_WORKFLOW` | `executeCommand + file load` | `orchestrator.loadWorkflow(filePath)` |
| `GET_RECENT_WORKFLOWS` | History service | Same — direct call |
| `SELECT_FILE` | `executeCommand("flightpath.selectPromptFile")` | Respond with no-op or path input prompt |
| `EDIT_FILE` | Opens VS Code editor | no-op |
| `SHOW_OUTPUT` | Reveals Output panel | no-op |
| `OPEN_GIT_CHANGE` | VS Code diff editor | no-op or OS file open |
| `revealInExplorer` | VS Code explorer | `open` / `xdg-open` (OS) |
| All other messages | Platform-agnostic | Same implementation |

All the non-`executeCommand` handlers in `WebviewMessageRouter` (`EXECUTE_PROMPT`, `UPDATE_PROMPT`, `REORDER_PROMPTS`, `UNDO_PROMPT_CHANGES`, etc.) are called on the orchestrator/instance directly and can be ported verbatim.

> **Future refactor (Phase 8):** Extract an abstract `BaseMessageRouter` from `WebviewMessageRouter` containing all platform-agnostic handlers. `WebviewMessageRouter` and `WebSocketMessageRouter` extend it, each providing only their transport/command differences. This eliminates duplication but is not required for the initial implementation.

---

### Phase 7 — CompletionService (File + Symbol Completions)

**New file:** `src/server/CompletionService.ts`

The webview CodeMirror sends completion requests via WebSocket. The server responds using Node.js APIs instead of VS Code APIs.

#### File and Directory Completions

Replace `vscode.workspace.findFiles()` + Git extension `checkIgnore()`:

```typescript
import fg from 'fast-glob';
import ignore from 'ignore';

export class CompletionService {
  private ig = ignore();

  constructor(private cwd: string) {
    // Load all .gitignore files (including nested), correct base-path per file
    const gitignoreFiles = fg.sync('**/.gitignore', { cwd, dot: true });
    for (const f of gitignoreFiles) {
      const content = fs.readFileSync(path.join(cwd, f), 'utf8');
      const dir = path.dirname(f);
      this.ig.add(dir === '.' ? content : content.split('\n')
        .map(l => l ? `${dir}/${l}` : l).join('\n'));
    }
  }

  async getFiles(filterText: string): Promise<PlainCompletionItem[]> {
    const allFiles = await fg('**/*', {
      cwd: this.cwd, dot: false, ignore: ['.git/**'], onlyFiles: false, markDirectories: true,
    });
    return allFiles
      .filter(f => !this.ig.ignores(f))
      .filter(f => !filterText || f.toLowerCase().includes(filterText.toLowerCase()))
      .map(f => buildCompletionItem(f));
  }
}
```

#### Symbol Completions

**Option A (default) — Smart regex heuristic** scanning source files by extension:

```typescript
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  ts:   /^(?:export\s+)?(?:(?:abstract|default)\s+)?(?:class|function\*?|const|let|var|interface|type|enum|namespace|module)\s+(\w+)/gm,
  py:   /^(?:class|def|async\s+def)\s+(\w+)/gm,
  go:   /^(?:func(?:\s+\([^)]+\))?\s+|type\s+|var\s+|const\s+)(\w+)/gm,
  rs:   /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|type|const|static|mod)\s+(\w+)/gm,
  // ... java, kt, cs, rb, swift, php, c, cpp
};
```

Results cached per file by `mtime`. No new dependencies.

**Option B (opt-in) — User-supplied LSP server:**

```yaml
# .flightpath/server.config.yaml
symbolLanguageServer:
  command: "typescript-language-server"
  args: ["--stdio"]
```

**New file:** `src/server/LspSymbolClient.ts` — spawns the process, speaks LSP JSON-RPC over stdio, maps `SymbolInformation[]` → `PlainCompletionItem[]`. Falls back to Option A if unavailable. Uses `vscode-jsonrpc` npm package.

#### Selection Completions

Not supported in standalone mode — returns empty array. The `#selection:` syntax still works; the autocomplete shortcut that pre-fills current editor selection range is the only loss.

---

### Phase 8 — File Watching

**New file:** `src/server/ServerFileWatcher.ts`

Replace `vscode.workspace.createFileSystemWatcher()`. `chokidar` is **already in `package.json` dependencies** (`chokidar@^5.0.0`):

```typescript
import chokidar from 'chokidar';

export class ServerFileWatcher {
  watch(pattern: string, cwd: string, callbacks: { onChange: (p: string) => void }) {
    return chokidar.watch(pattern, { cwd, ignoreInitial: true })
      .on('change', callbacks.onChange)
      .on('add', callbacks.onChange)
      .on('unlink', callbacks.onChange);
  }
}
```

If `WorkflowOrchestrator` constructs `PromptFileWatcher` internally (VS Code variant), the construction path needs to go through `PlatformAdapter`. Add an optional `createFileWatcher(pattern)` method to `PlatformAdapter` — `VsCodeAdapter` returns a VS Code watcher, `StandaloneServerAdapter` returns a `ServerFileWatcher`. This is the cleanest seam.

---

### Phase 9 — CLI Integration (`flightpath server`)

Add `server` as a Commander.js subcommand in `src/cli.ts`, following the same pattern as `run`:

```typescript
// src/cli.ts
program
  .command('server')
  .description('Start the FlightPath browser dashboard')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('-d, --cwd <path>', 'Workspace root directory')
  .option('--theme <light|dark>', 'Default theme', 'dark')
  .option('--open', 'Open browser automatically')
  .option('-H, --harness <harness>', 'Default harness', 'copilot-cli')
  .option('-m, --model <model>', 'Default model')
  .option('--allow-tool <pattern>', 'Allow tool (repeatable)', collectRepeatable, [])
  .option('--deny-tool <pattern>', 'Deny tool (repeatable)', collectRepeatable, [])
  .option('--allow-all-tools', 'Dangerously allow all tools')
  .action(async (options) => {
    const { FlightPathServer } = await import('./server/FlightPathServer');
    const server = new FlightPathServer(resolveServerConfig(options));
    server.listen();
  });
```

**New file:** `src/cli/ServerCommand.ts` — `resolveServerConfig()` logic (mirrors `resolveRunConfig()` in `src/cli.ts`).

`RUNNER_IDS.SERVER` must be added to `src/types/DashboardConstants.ts`.

---

## File Structure

```
src/ui/
└── IDashboardProvider.ts          ← NEW: extracted interface (Phase 2)

src/server/
├── FlightPathServer.ts            ← HTTP + WS server; implements IDashboardProvider
├── StandaloneServerAdapter.ts     ← PlatformAdapter impl (modeled on CliAdapter)
├── WebSocketMessageRouter.ts      ← Routes webview messages to WorkflowOrchestrator
├── CompletionService.ts           ← File/dir/symbol completions (no VS Code)
├── LspSymbolClient.ts             ← (optional) LSP stdio client
├── ServerFileWatcher.ts           ← chokidar-based file watcher
├── standalone-shim.js             ← Browser-side VS Code API shim
└── themes/
    ├── vscode-default-dark.css    ← Full --vscode-* definitions (dark)
    └── vscode-default-light.css   ← Full --vscode-* definitions (light)

src/cli/ServerCommand.ts           ← resolveServerConfig() for `flightpath server`
src/cli.ts                         ← Add program.command('server') block

src/flightpath/WorkflowOrchestrator.ts  ← Update: IDashboardProvider instead of FlightPathWebviewProvider
src/ui/FlightPathWebviewProvider.ts     ← Update: add `implements IDashboardProvider`
src/platform/PlatformAdapter.ts         ← Update: add optional createFileWatcher()
```

---

## Build Changes

### esbuild — no new bundle target

The `server` command is added to `src/cli.ts` (same entry point, same bundle). `express` and `ws` go in `external` — installed in `node_modules`, not bundled:

```javascript
// esbuild.js — update cliCtx
external: ['node-pty', 'express', 'ws'],
```

The existing `vscode-shim` alias handles all `vscode` imports in the server code automatically.

### package.json — new runtime dependencies

```json
"dependencies": {
  "express": "^4.x",
  "ws": "^8.x",
  "fast-glob": "^3.x",
  "ignore": "^5.x"
}
```

Optional:
```json
"vscode-jsonrpc": "^8.x"   // only if LspSymbolClient is implemented
```

### package.json — convenience script

```json
"server": "node out/cli.js server"
```

---

## Message Protocol Compatibility

The protocol (`MESSAGE_TYPES`, `WebviewMessageTypes`) is unchanged. All existing message types work over WebSocket with the same payload shapes. The only transport change is `vscode.postMessage` → `ws.send` (shim handles this).

Full message coverage including multi-workflow types:
- `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `WORKFLOW_SUMMARY_UPDATED`, `ACTIVE_WORKFLOW_CHANGED`
- `GET_WORKFLOWS_LIST`, `WORKFLOWS_LIST`, `SWITCH_WORKFLOW`
- `PAUSE_WORKFLOW`, `RESUME_WORKFLOW`, `STOP_WORKFLOW`
- All other existing message types

---

## Multi-Tab Connection Handling

- **One server = one `WorkflowOrchestrator`** managing all parallel workflows
- **Multiple browser tabs** = multiple WebSocket connections, all subscribing to the same orchestrator
- All orchestrator events broadcast to `connections: Set<WebSocket>` (all open tabs see the same state)
- New tab connects → receives full initial state: settings, `WORKFLOWS_LIST`, active workflow data
- Tab closes → removed from connection set; orchestrator continues running

---

## Security Considerations

- **Localhost-only by default**: Bind to `127.0.0.1`; `--host 0.0.0.0` for remote access (explicit opt-in)
- **No authentication in v1**: Developer tool
- **WebSocket origin check**: Validate `Origin` header matches `localhost:<port>` on connect
- **CSP**: Set `connect-src ws://localhost:<port>`; serve shim as a static file to avoid `'unsafe-inline'`
- **No eval**: Shim uses `JSON.parse`

---

## Harness Compatibility

| Harness | Works in Server? | Notes |
|---------|-----------------|-------|
| `copilot-cli` | ✅ Yes | Spawns process, no VS Code dep |
| `claude-cli` | ✅ Yes | Spawns process, no VS Code dep |
| `codex-cli` | ✅ Yes | Spawns process, no VS Code dep |
| `copilot-chat` | ❌ No | Automates VS Code's Chat UI directly |

Server validates harness at startup and rejects `copilot-chat` with a clear error.

---

## State Persistence

| VS Code mechanism | Standalone replacement |
|-------------------|----------------------|
| `vscode.setState()` | `sessionStorage.setItem('fpState', ...)` |
| `vscode.getState()` | `sessionStorage.getItem('fpState')` |

Handled entirely by the Phase 1 shim. No changes to any store.

---

## Implementation Order

1. **`IDashboardProvider` interface** — extract from `FlightPathWebviewProvider`; update `WorkflowOrchestrator` constructor; add `implements` to `FlightPathWebviewProvider` (1 hour)
2. **Theme CSS files** — audit `tailwind.config.js`, create both theme files with correct codicon path `/codicons/codicon.ttf` (2–3 hours)
3. **Shim** — `standalone-shim.js`, smoke-test in browser with a mock WS (1 hour)
4. **`StandaloneServerAdapter`** — mirror `CliAdapter`; always `cliExecutionMode: "headless"` (1.5 hours)
5. **`FlightPathServer`** — HTTP + WS, connection registry, broadcast, `sendInitialState`, implements `IDashboardProvider` (3 hours)
6. **`WebSocketMessageRouter`** — all message handlers; `vscode.commands.executeCommand()` replaced with direct orchestrator calls (4 hours)
7. **`CompletionService`** — file/dir completions with fast-glob + ignore; regex symbol heuristic (3 hours)
7a. **`LspSymbolClient`** _(optional)_ — LSP stdio client (2 hours)
8. **`ServerFileWatcher`** + `PlatformAdapter.createFileWatcher()` seam — chokidar, verify `PromptFileWatcher` usage path (1.5 hours)
9. **`flightpath server` CLI command** — `program.command('server')` + `resolveServerConfig()` + `RUNNER_IDS.SERVER` constant (1 hour)
10. **esbuild + package.json** — add externals, deps, npm script (30 min)
11. **Manual testing** — parallel workflows from browser, switcher dropdown, pause/resume/stop per workflow, theme switching, completions (2 hours)

Total: ~21 hours of implementation work.

---

## Open Questions

1. **`WorkflowOrchestrator` and `vscode.ExtensionContext`**: The constructor currently takes `vscode.ExtensionContext`. Audit which parts of `WorkflowOrchestrator` actually use it. If it's only used for `context.extensionPath` → replace with `adapter.getExtensionPath()`. If it's used for `context.globalStorageUri` (CLI watch sessions) → pass only that path via config. The goal is removing the `ExtensionContext` param entirely.

2. **`PromptFileWatcher` construction path**: Determine whether `WorkflowOrchestrator` or `WorkflowInstance` constructs `PromptFileWatcher` directly. If so, route it through `PlatformAdapter.createFileWatcher()` (add the optional method). If it's constructed via `ExtensionContext` removal (from Q1), it may be handled at the same time.

3. **File picker (`SELECT_FILE`)**: Server has no file dialog. Options:
   - **A** (MVP): no-op + console message; user passes `--cwd` to set workspace
   - **B**: Serve a simple `GET /api/files?q=...` REST endpoint that returns file list; dashboard could show an inline path picker
   - **C**: Future UX — drag-and-drop `.flightpath.yaml` onto the dashboard

4. **`WebviewSettingsSync`**: Broadcasts extension settings to the webview on connect. Verify it only calls `adapter.getConfig()` (via `ConfigurationUtils`) and not `vscode.workspace.getConfiguration()` directly. If it calls VS Code APIs directly, those specific calls need to be routed through the adapter.

5. **Recent workflow history storage**: VS Code stores this in `context.globalState`. The server needs a file-based equivalent (e.g., `~/.flightpath/history.json` or `.flightpath/.history/recent.json` in the workspace). Determine where `WorkflowOrchestrator` reads/writes recent workflow history and what needs to change.
