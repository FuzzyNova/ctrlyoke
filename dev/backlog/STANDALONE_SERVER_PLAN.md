# Standalone FlightPath Server Plan

## Overview

Expose the existing `src/ui/webview-react/` React dashboard as a browser-accessible web app. Two delivery modes are planned, both built on a shared `IDashboardProvider` interface:

1. **VS Code-Hosted Server** — an HTTP/WebSocket server started _inside_ the running VS Code extension process via an "Enable Server" button in the webview. The live `WorkflowOrchestrator` instance is the server backend. Browser tabs connect as additional clients alongside the existing VS Code sidebar panel. All VS Code capabilities remain available (file pickers, Copilot Chat harness, settings integration) because the server _is_ the extension.

2. **Standalone Server** (`flightpath server` CLI subcommand) — a fully independent Node.js process with no VS Code dependency. Useful for headless/CI scenarios and remote access where VS Code is not running. The only exclusions are capabilities that are inherently VS Code-specific (file pickers, Copilot Chat harness).

`IDashboardProvider` is already present in the current codebase. The remaining shared prerequisite is finishing the multi-client dashboard fan-out (`IDashboardProvider` + `IDashboardSink`) and removing the remaining VS Code-only seams needed for standalone mode.

## Mode Comparison

| Feature                    | `flightpath run` (CLI) | VS Code-Hosted Server   | `flightpath server` (standalone) | VS Code Extension |
| -------------------------- | ---------------------- | ----------------------- | -------------------------------- | ----------------- |
| Parallel workflows         | No — single run        | **Yes**                 | **Yes**                          | **Yes**           |
| Full dashboard webview     | No — terminal output   | **Yes**                 | **Yes**                          | **Yes**           |
| Workflow switcher dropdown | No                     | **Yes**                 | **Yes**                          | **Yes**           |
| Run history                | No                     | **Yes**                 | **Yes**                          | **Yes**           |
| File picker dialogs        | No                     | No (browser limitation) | No (path input only)             | Yes               |
| `copilot-chat` harness     | No                     | **Yes**                 | No (VS Code UI automation)       | Yes               |
| Requires VS Code open      | No                     | **Yes**                 | No                               | Yes               |
| Headless / CI use          | Yes                    | No                      | **Yes**                          | No                |

## Goals

- Finish the shared dashboard transport seam (`IDashboardProvider` + `IDashboardSink`) so one orchestrator can drive the VS Code panel and browser clients simultaneously
- Serve the existing React webview at `http://localhost:<port>` in any browser with zero React code changes
- Full feature parity with the VS Code dashboard (parallel workflows, switcher, history, all message types)
- Replace VS Code-specific APIs with browser-compatible equivalents via a minimal shim (standalone only)
- Reuse `WorkflowOrchestrator` directly in both modes — no parallel orchestration logic
- Support light and dark themes out of the box

## Non-Goals

- Real-time multi-user collaboration (each server instance = one workspace)
- Remote workflow execution beyond what the CLI already supports
- A full VS Code extension replacement
- Supporting the `copilot-chat` harness in the standalone server (directly automates VS Code's UI)

## Current Codebase Audit (2026-04-03)

### Already in place

- `src/ui/IDashboardProvider.ts` already exists.
- `src/ui/FlightPathWebviewProvider.ts` already implements `IDashboardProvider`.
- `src/types/IDashboardSink.ts` already exists for per-step/live-output dashboard updates.
- `src/ui/DashboardBroadcastHub.ts` now exists and implements both `IDashboardProvider` and `IDashboardSink`.
- `src/flightpath/WorkflowOrchestrator.ts` now routes registry and CLI-watch updates through the shared broadcast hub and exposes `addDashboardProvider()` / `removeDashboardProvider()`.
- `src/flightpath/WorkflowInstance.ts` now receives the shared `IDashboardSink` instead of casting the first provider to `FlightPathWebviewProvider`.
- `src/ui/WebviewMessageRouter.ts` now supports scoped reply callbacks, and `src/ui/FlightPathWebviewProvider.ts` exposes `routeMessage(...)` / `routeExternalMessage(...)` for hosted clients.
- `RUNNER_IDS.SERVER` and `MESSAGE_TYPES.ENABLE_SERVER` / `DISABLE_SERVER` now exist.
- The React app already depends only on the `window.vscodeApi` contract (`postMessage`, `getState`, `setState`), so the browser shim approach is still valid.

### Still missing before implementation

- `WorkflowOrchestrator.buildWorkflowInstance()` still hard-codes `new VsCodeAdapter(this.context)`, which blocks standalone reuse of the current constructor path.
- `PromptFileWatcher` and `CliWatchSession` still create VS Code file watchers directly.
- `WebviewSettingsSync` still uses `vscode.workspace.workspaceFolders` directly for agent/skill/workspace discovery.
- There is no hosted/standalone server code yet, no `flightpath.enableServer` command, no `flightpath.serverPort` setting, and no `_internalRouteMessage` command.
- `express`, `ws`, `fast-glob`, and `ignore` are not installed. (`chokidar` is already present.)
- Hosted-server request/response messages such as completions, file-ref validation, and attachment token counts must reply to the requesting WebSocket client only; they cannot be blindly broadcast to every connected tab.
- The hosted-server UI control still needs to be added to the React shell, along with running URL/status display.

### Readiness verdict

- **VS Code-hosted server:** **ready to implement now.** The shared broadcast sink/provider cleanup and callable hosted-router surface are in place, so Phase 2 can start with `FlightPathHostedServer`, command/setting wiring, and the webview control.
- **Standalone server:** not ready until that same cleanup is complete and the watcher / `PlatformAdapter` seams are threaded through the orchestration layer.

---

## Architecture

### VS Code-Hosted Server

```
VS Code Extension Process (running normally)
  ├── FlightPathWebviewProvider  — existing VS Code sidebar panel
  ├── WorkflowOrchestrator       — already running, manages all workflows
  │     └── notifyX() → Dashboard broadcast hub (Phase 1 target state)
  ├── FlightPathWebviewProvider  — implements IDashboardProvider (VS Code panel)
  └── FlightPathHostedServer     — NEW: implements IDashboardProvider (HTTP + WS)
        ├── HTTP: serves React app assets (same Vite bundle)
        └── WS: browser tabs connect here, receive same orchestrator events
```

After Phase 1, the orchestrator and workflow instances publish through the shared broadcast hub so the VS Code panel and hosted browser tabs see identical live state.

Since `FlightPathHostedServer` runs inside the extension process, its hosted router can still invoke VS Code commands/services directly; it just needs a callable router surface rather than a fake webview re-dispatch command.

### Standalone Server

```
Browser (1..N tabs)
  ↕ HTTP (React app assets)
  ↕ WebSocket (bidirectional, same MESSAGE_TYPES protocol as VS Code)
Standalone FlightPath Server (Node.js — no VS Code)
  ├── FlightPathServer        — HTTP + WS, connection registry, broadcast
  ├── StandaloneServerAdapter — PlatformAdapter impl (modeled on CliAdapter)
  ├── WorkflowOrchestrator    — REUSED unchanged (after IDashboardProvider refactor)
  └── CliIntegration + CLI harnesses (copilot-cli, claude-cli, codex-cli — unchanged)
```

### Multi-tab Model (both modes)

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

| Pattern                          | Where It Exists                          | How Server Uses It                                                                                                    |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IDashboardProvider` interface   | `src/ui/IDashboardProvider.ts`           | Already present; both server implementations plug into this surface                                                   |
| `IDashboardSink` interface       | `src/types/IDashboardSink.ts`            | Existing live step/output sink; needs a broadcast-capable implementation before hosted tabs can mirror the sidebar   |
| `WorkflowOrchestrator` registry  | `src/flightpath/WorkflowOrchestrator.ts` | Already stores `IDashboardProvider[]` and `addDashboardProvider()`, but most notify paths still target the first provider |
| `WebviewMessageRouter`           | `src/ui/WebviewMessageRouter.ts`         | Hosted server can reuse its logic only after exposing a direct callable entrypoint and preserving per-connection replies |
| `PlatformAdapter` interface      | `src/platform/PlatformAdapter.ts`        | `StandaloneServerAdapter` is the third implementation; this seam also needs file-watcher support                     |
| `vscode-shim` alias              | `esbuild.js` CLI bundle                  | Standalone server bundle uses the same `alias: { vscode: 'src/platform/vscode-shim.ts' }`                             |
| Commander.js subcommands         | `src/cli.ts`                             | `server` added as `program.command('server')` (standalone only)                                                       |
| `setRuntimeMode`                 | `src/cli.ts` line 27                     | Standalone server should call `setRuntimeMode(RUNNER_IDS.SERVER)` once that constant exists                           |

---

## VS Code Dependencies Inventory

### Structural VS Code Dependencies (not used by server)

| File                                          | Why Irrelevant                                  |
| --------------------------------------------- | ----------------------------------------------- |
| `src/extension.ts`                            | Extension activation — not used by server       |
| `src/ui/StatusBarManager.ts`                  | VS Code status bar — no equivalent needed       |
| `src/completions/PromptCompletionProvider.ts` | VS Code IntelliSense in text editor             |
| `src/completions/PromptLinkProvider.ts`       | VS Code document links — CodeMirror has its own |
| `src/flightpath/harness/chat/`                | Automates VS Code's Copilot Chat UI             |

### VS Code Dependencies Requiring Server Equivalents

| File                                                | VS Code API Used                                                   | Server Approach                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/ui/FlightPathWebviewProvider.ts`               | `vscode.WebviewView`, `webview.postMessage()`, `notifyX()` methods | Replaced by `FlightPathServer` + WebSocket broadcast                   |
| `src/flightpath/WorkflowOrchestrator.ts`            | `vscode.ExtensionContext`, `VsCodeAdapter`, primary-provider assumptions | Finish provider fanout, add a broadcast sink for `WorkflowInstance`, and inject adapter/context cleanly for server use |
| `src/ui/WebviewMessageRouter.ts`                    | `vscode.commands.executeCommand()` + webview-local reply channel   | Hosted server needs a callable router wrapper; standalone needs a WebSocket router with per-connection replies |
| `src/ui/WebviewSettingsSync.ts`                     | `vscode.workspace.workspaceFolders`, command execution, `ConfigurationUtils` | Move workspace discovery behind adapter/constructor inputs; keep settings reads routed through `ConfigurationUtils` |
| `src/utils/ConfigurationUtils.ts`                   | `vscode.workspace.getConfiguration()`                              | Already bypassed when called through `CliAdapter.getConfig()`          |
| `src/flightpath/orchestration/PromptFileWatcher.ts` | `vscode.workspace.createFileSystemWatcher()`                       | `chokidar` (already in dependencies)                                   |
| `src/flightpath/orchestration/CliWatchSession.ts`   | `vscode.workspace.createFileSystemWatcher()` (multiple watchers)   | Same watcher abstraction; inject adapter into constructor              |
| `src/completions/CompletionHelpers.ts`              | `vscode.workspace.findFiles()`, Git extension                      | Node.js `fs` + `fast-glob` + `ignore`                                  |

### Already Platform-Agnostic (zero changes)

- `src/flightpath/PromptQueue.ts` / `WorkflowExecutor.ts`
- `src/flightpath/PromptFileParser.ts` / `EndConditionEvaluator.ts`
- `src/flightpath/harness/CliIntegration.ts` + all CLI harnesses
- `src/ui/webview-react/**` — entire React app and all stores
- `src/types/**` — MESSAGE_TYPES, EXECUTION_STATES, WorkflowSummary, etc.

---

## Implementation Plan

### Phase 1 — Finish Shared Dashboard Fanout (completed for hosted-server work)

**Completed**

- `src/ui/IDashboardProvider.ts` already exists.
- `FlightPathWebviewProvider` already `implements IDashboardProvider`.
- `DashboardBroadcastHub` now single-sources fanout across `IDashboardProvider` + `IDashboardSink`.
- `WorkflowOrchestrator` now publishes registry/CLI-watch updates through the hub and passes the hub into `WorkflowInstance` as the dashboard sink.
- `src/types/IDashboardSink.ts` already exists for the finer-grained `WorkflowInstance` update surface.
- `WebviewMessageRouter` now supports scoped reply callbacks so targeted bootstrap/request-response traffic can stay client-local.
- `FlightPathWebviewProvider.routeExternalMessage(...)` now exposes the hosted-server routing seam directly.
- `RUNNER_IDS.SERVER` and hosted-server message types now exist.

**Still deferred**

1. Thread `PlatformAdapter`-based watcher creation through `PromptFileWatcher` and `CliWatchSession`.
2. Stop hard-coding `VsCodeAdapter` creation in the reusable orchestration path.
3. Move workspace/agent/skill discovery out of direct `vscode.workspace` usage where standalone mode needs it.

**Implementation notes**

- The remaining deferred items are primarily **standalone-server prep**, not blockers for the VS Code-hosted server.
- Do not duplicate provider/sink methods across multiple classes if the broadcast hub can single-source that fanout.

---

### Phase 2 — VS Code-Hosted Server

**New files**

- `src/server/FlightPathHostedServer.ts`
- `src/server/HostedServerRouter.ts` (or an equivalent wrapper/factory around `WebviewMessageRouter`)

Starts an HTTP + WebSocket server inside the running VS Code extension process. The live `WorkflowOrchestrator` remains the backend, but hosted tabs are **not** just another broadcast target — they also need a per-connection request/response channel.

**Design**

- `FlightPathHostedServer` implements `IDashboardProvider` and registers with the shared broadcast hub from Phase 1 so all global workflow events reach browser tabs.
- Each WebSocket client gets its own reply callback for client-scoped messages such as completions, attachment token counts, and file-ref validation.
- Reuse `WebviewMessageRouter` logic by exposing a direct callable entrypoint (for example `FlightPathWebviewProvider.routeExternalMessage(message, reply)` or a shared router factory). Do **not** rely on a synthetic `flightpath._internalRouteMessage` command unless one is intentionally added and tested.
- Hosted mode can keep using the in-process VS Code services for prompt file selection, output panel commands, open file, Git diff, settings sync, and completions because the server is still running inside the extension.
- Add duplicate-start protection, explicit stop/dispose, and extension deactivation cleanup.

**Extension wiring**

- Register `flightpath.enableServer` and `flightpath.disableServer` commands.
- Add `MESSAGE_TYPES.ENABLE_SERVER` (and a stop counterpart if needed) for the dashboard button.
- Add `flightpath.serverPort` setting in `package.json`.
- Surface the running URL in the dashboard/status UI.

**Dashboard UI placement**

- Put the hosted-server control in `src/ui/webview-react/components/layout/SettingsDrawer.tsx`, in the always-visible footer next to the existing global toggles.
- Do **not** put it in `src/ui/webview-react/components/layout/Header.tsx`. The header cluster is workflow-local (save, undo/redo, run/pause/stop), while server start/stop is workspace/global transport state.
- Keep the server control outside any CLI-managed read-only disable wrapper. Viewing a CLI-managed workflow should not prevent starting or stopping the hosted server.
- When the server is running, the same footer cluster should also surface the active URL (or copy/open-browser affordances) so the control and its status stay together.

**Theme**

Since the extension is running, the hosted server can either inject actual VS Code theme variables into the served HTML or map the active theme to the Phase 4 fallback CSS files. Pick one approach and keep it shared with the standalone theme assets where possible.

> **Key advantage over standalone**: No standalone harness limitations and no replacement for VS Code-only commands. The hosted server is primarily a transport + connection-management layer over the existing extension runtime.

---

### Phase 3 — WebSocket Shim (browser side, shared)

**New file:** `src/server/standalone-shim.js` (plain JS — injected directly into HTML before React loads)

```javascript
(function () {
  let _state = JSON.parse(sessionStorage.getItem("fpState") || "{}");
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener("open", () => {
    pending.forEach((m) => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener("message", (e) => {
    // useMessageHandler already listens on window.addEventListener('message', ...)
    window.dispatchEvent(
      new MessageEvent("message", { data: JSON.parse(e.data) })
    );
  });

  // Reconnect on server restart (development convenience)
  ws.addEventListener("close", () => setTimeout(() => location.reload(), 1500));

  window.vscodeApi = {
    postMessage(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    getState() {
      return _state;
    },
    setState(s) {
      _state = s;
      sessionStorage.setItem("fpState", JSON.stringify(s));
    },
  };
})();
```

**Why `sessionStorage`?** Matches VS Code's `setState` semantics — cleared on tab close, persisted through refresh.

---

### Phase 4 — CSS Theme Defaults

**New files:** `src/server/themes/vscode-default-dark.css`, `src/server/themes/vscode-default-light.css`

All `--vscode-*` variables referenced in `tailwind.config.js` must be defined. Complete variable list:

| Group             | Variables                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor            | `--vscode-editor-background`, `--vscode-editor-foreground`                                                                                                                                                              |
| Button            | `--vscode-button-background`, `--vscode-button-foreground`, `--vscode-button-hoverBackground`, `--vscode-button-secondaryBackground`, `--vscode-button-secondaryForeground`, `--vscode-button-secondaryHoverBackground` |
| Input             | `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-input-placeholderForeground`                                                                                               |
| Dropdown          | `--vscode-dropdown-background`, `--vscode-dropdown-foreground`, `--vscode-dropdown-border`                                                                                                                              |
| List              | `--vscode-list-hoverBackground`, `--vscode-list-activeSelectionBackground`, `--vscode-list-activeSelectionForeground`                                                                                                   |
| Panel             | `--vscode-panel-background`, `--vscode-panel-border`, `--vscode-sideBar-background`, `--vscode-sideBarSectionHeader-background`, `--vscode-sideBarSectionHeader-border`                                                 |
| Scrollbar         | `--vscode-scrollbarSlider-background`, `--vscode-scrollbarSlider-hoverBackground`, `--vscode-scrollbarSlider-activeBackground`                                                                                          |
| Badge             | `--vscode-badge-background`, `--vscode-badge-foreground`                                                                                                                                                                |
| Progress          | `--vscode-progressBar-background`                                                                                                                                                                                       |
| Focus border      | `--vscode-focusBorder`                                                                                                                                                                                                  |
| Diff              | `--vscode-diffEditor-insertedLineBackground`, `--vscode-diffEditor-removedLineBackground`, `--vscode-diffEditor-insertedTextBackground`, `--vscode-diffEditor-removedTextBackground`                                    |
| Terminal ANSI     | `--vscode-terminal-ansiGreen/Red/Yellow/Blue/Magenta/Cyan/White/Black` + Bright variants (16 total)                                                                                                                     |
| Foreground tokens | `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-disabledForeground`, `--vscode-errorForeground`, `--vscode-icon-foreground`                                                                          |
| Fonts             | `--vscode-font-family`, `--vscode-font-size`, `--vscode-font-weight`, `--vscode-editor-font-family`, `--vscode-editor-font-size`                                                                                        |
| Codicons          | `--vscode-codicon-font-path`                                                                                                                                                                                            |

**Codicon path:** Vite copies codicons to `out/ui/webview-react/codicons/codicon.ttf`. Set:

```css
--vscode-codicon-font-path: url("/codicons/codicon.ttf");
```

Values sourced from VS Code's `src/vs/platform/theme/common/colorRegistry.ts` for Default Light+ and Default Dark+.

**Theme selection priority:**

1. `?theme=light|dark` query parameter
2. `Sec-CH-Prefers-Color-Scheme` request header
3. Default: dark

---

### Phase 5 — StandaloneServerAdapter (standalone)

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

### Phase 6 — HTTP / WebSocket Server (standalone)

**New file:** `src/server/FlightPathServer.ts`

`FlightPathServer` implements `IDashboardProvider` — it is the server-side equivalent of `FlightPathWebviewProvider`.

```typescript
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import { StandaloneServerAdapter } from "./StandaloneServerAdapter";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { WorkflowSummary } from "../types/FlightPathTypes";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import { setRuntimeMode } from "../utils/RuntimeMode";
import { RUNNER_IDS } from "../types/DashboardConstants";

export class FlightPathServer implements IDashboardProvider {
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ server: this.httpServer });
  private connections = new Set<WebSocket>(); // all active tabs
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
    this.app.use("/theme", express.static(path.join(__dirname, "themes")));
    this.app.get("/standalone-shim.js", (_req, res) =>
      res.sendFile(path.join(__dirname, "standalone-shim.js"))
    );
    this.app.get("*", (req, res) => {
      const theme = (req.query.theme as string) ?? this.detectTheme(req);
      res.send(this.buildHtml(theme, webviewDist));
    });
  }

  private buildHtml(theme: string, webviewDist: string): string {
    const index = fs.readFileSync(path.join(webviewDist, "index.html"), "utf8");
    return index.replace(
      "</head>",
      `<link rel="stylesheet" href="/theme/${theme}.css">
       <script src="/standalone-shim.js"></script>
       </head>`
    );
  }

  // ── WebSocket connection handling ─────────────────────────────────────────
  private setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      if (!this.isAllowedOrigin(req)) {
        ws.close(4003, "Forbidden");
        return;
      }

      this.connections.add(ws);

      // New tab: send full current state (all running workflows + active workflow data)
      this.sendInitialState(ws);

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        this.router.route(msg);
      });

      ws.on("close", () => this.connections.delete(ws));
    });
  }

  private sendInitialState(ws: WebSocket) {
    const send = (msg: unknown) => ws.send(JSON.stringify(msg));
    // Mirror FlightPathWebviewProvider's READY → INIT handshake
    // Send settings, workflow summaries, active workflow state
    this.settingsSync.sendToClient(send);
    send({
      type: MESSAGE_TYPES.WORKFLOWS_LIST,
      workflows: this.orchestrator.getWorkflowSummaries(),
    });
    const active = this.orchestrator.getActiveWorkflow();
    if (active) active.sendFullStateToDashboard(); // broadcasts via IDashboardProvider
  }

  listen() {
    this.httpServer.listen(this.config.port, "127.0.0.1", () => {
      console.log(`FlightPath server at http://localhost:${this.config.port}`);
      if (this.config.open) open(`http://localhost:${this.config.port}`);
    });
  }
}
```

**Webview dist path:** Vite outputs to `out/ui/webview-react/` (confirmed in `vite.config.ts` line 44).

---

### Phase 7 — WebSocket Message Router (standalone)

**New file:** `src/server/WebSocketMessageRouter.ts`

Handles all webview → server messages. The existing `WebviewMessageRouter.ts` cannot be reused directly because 9 handlers call `vscode.commands.executeCommand()`. The server router replaces those with direct `WorkflowOrchestrator` method calls.

**The handler mapping:**

| Message Type           | VS Code Handler                                 | Server Handler                          |
| ---------------------- | ----------------------------------------------- | --------------------------------------- |
| `RUN`                  | `executeCommand("flightpath.run")`              | `orchestrator.run(filePath)`            |
| `PAUSE`                | `executeCommand("flightpath.pause")`            | `orchestrator.pause()`                  |
| `RESUME`               | `executeCommand("flightpath.resume")`           | `orchestrator.resume()`                 |
| `STOP`                 | `executeCommand("flightpath.stop")`             | `orchestrator.stop()`                   |
| `PAUSE_WORKFLOW`       | `orchestrator.pauseWorkflow(id)`                | Same — direct call                      |
| `RESUME_WORKFLOW`      | `orchestrator.resumeWorkflow(id)`               | Same — direct call                      |
| `STOP_WORKFLOW`        | `orchestrator.stopWorkflow(id)`                 | Same — direct call                      |
| `SWITCH_WORKFLOW`      | `orchestrator.setActiveWorkflow(id)`            | Same — direct call                      |
| `GET_WORKFLOWS_LIST`   | `orchestrator.getWorkflowSummaries()`           | Same — direct call                      |
| `LOAD_WORKFLOW`        | `executeCommand + file load`                    | `orchestrator.loadWorkflow(filePath)`   |
| `GET_RECENT_WORKFLOWS` | History service                                 | Same — direct call                      |
| `SELECT_FILE`          | `executeCommand("flightpath.selectPromptFile")` | Respond with no-op or path input prompt |
| `EDIT_FILE`            | Opens VS Code editor                            | no-op                                   |
| `SHOW_OUTPUT`          | Reveals Output panel                            | no-op                                   |
| `OPEN_GIT_CHANGE`      | VS Code diff editor                             | no-op or OS file open                   |
| `revealInExplorer`     | VS Code explorer                                | `open` / `xdg-open` (OS)                |
| All other messages     | Platform-agnostic                               | Same implementation                     |

All the non-`executeCommand` handlers in `WebviewMessageRouter` (`EXECUTE_PROMPT`, `UPDATE_PROMPT`, `REORDER_PROMPTS`, `UNDO_PROMPT_CHANGES`, etc.) are called on the orchestrator/instance directly and can be ported verbatim.

> **Future refactor (Phase 8):** Extract an abstract `BaseMessageRouter` from `WebviewMessageRouter` containing all platform-agnostic handlers. `WebviewMessageRouter` and `WebSocketMessageRouter` extend it, each providing only their transport/command differences. This eliminates duplication but is not required for the initial implementation.

---

### Phase 8 — CompletionService (File + Symbol Completions) (standalone)

**New file:** `src/server/CompletionService.ts`

The webview CodeMirror sends completion requests via WebSocket. The server responds using Node.js APIs instead of VS Code APIs.

#### File and Directory Completions

Replace `vscode.workspace.findFiles()` + Git extension `checkIgnore()`:

```typescript
import fg from "fast-glob";
import ignore from "ignore";

export class CompletionService {
  private ig = ignore();

  constructor(private cwd: string) {
    // Load all .gitignore files (including nested), correct base-path per file
    const gitignoreFiles = fg.sync("**/.gitignore", { cwd, dot: true });
    for (const f of gitignoreFiles) {
      const content = fs.readFileSync(path.join(cwd, f), "utf8");
      const dir = path.dirname(f);
      this.ig.add(
        dir === "."
          ? content
          : content
              .split("\n")
              .map((l) => (l ? `${dir}/${l}` : l))
              .join("\n")
      );
    }
  }

  async getFiles(filterText: string): Promise<PlainCompletionItem[]> {
    const allFiles = await fg("**/*", {
      cwd: this.cwd,
      dot: false,
      ignore: [".git/**"],
      onlyFiles: false,
      markDirectories: true,
    });
    return allFiles
      .filter((f) => !this.ig.ignores(f))
      .filter(
        (f) => !filterText || f.toLowerCase().includes(filterText.toLowerCase())
      )
      .map((f) => buildCompletionItem(f));
  }
}
```

#### Symbol Completions

**Option A (default) — Smart regex heuristic** scanning source files by extension:

```typescript
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  ts: /^(?:export\s+)?(?:(?:abstract|default)\s+)?(?:class|function\*?|const|let|var|interface|type|enum|namespace|module)\s+(\w+)/gm,
  py: /^(?:class|def|async\s+def)\s+(\w+)/gm,
  go: /^(?:func(?:\s+\([^)]+\))?\s+|type\s+|var\s+|const\s+)(\w+)/gm,
  rs: /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|type|const|static|mod)\s+(\w+)/gm,
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

### Phase 9 — File Watching (standalone)

**New file:** `src/server/ServerFileWatcher.ts`

Replace `vscode.workspace.createFileSystemWatcher()`. `chokidar` is **already in `package.json` dependencies** (`chokidar@^5.0.0`):

```typescript
import chokidar from "chokidar";

export class ServerFileWatcher {
  watch(
    pattern: string,
    cwd: string,
    callbacks: { onChange: (p: string) => void }
  ) {
    return chokidar
      .watch(pattern, { cwd, ignoreInitial: true })
      .on("change", callbacks.onChange)
      .on("add", callbacks.onChange)
      .on("unlink", callbacks.onChange);
  }
}
```

Add an optional `createFileWatcher(pattern)` method to `PlatformAdapter` — `VsCodeAdapter` returns a VS Code watcher, `StandaloneServerAdapter` returns a `ServerFileWatcher`. Route all internal file watcher construction through this seam.

**Two callers require attention:**

1. **`PromptFileWatcher`** — if constructed directly inside `WorkflowOrchestrator` or `WorkflowInstance`, route through `PlatformAdapter.createFileWatcher()`.

2. **`CliWatchSession`** — watches three separate paths internally using `vscode.workspace.createFileSystemWatcher()` directly: the working file, the lock file, and the history run files. All three must be replaced with `adapter.createFileWatcher()`. Inject `PlatformAdapter` into `CliWatchSession`'s constructor (it currently takes only callbacks and paths).

> **Note on VS Code-hosted server**: `CliWatchSession` is unaffected in the hosted server — it runs inside the extension process where `vscode.workspace.createFileSystemWatcher()` works normally. The `IDashboardProvider[]` broadcast model means watch-mode output (`CLI_WATCH_OUTPUT`) and step progress updates stream to all connected browser tabs identically to the VS Code sidebar. Controls are disabled in watch mode based on `WorkflowSummary` state, which is broadcast to all clients — no special handling needed.

---

### Phase 10 — CLI Integration (`flightpath server`) (standalone)

Add `server` as a Commander.js subcommand in `src/cli.ts`, following the same pattern as `run`:

```typescript
// src/cli.ts
program
  .command("server")
  .description("Start the FlightPath browser dashboard")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("-d, --cwd <path>", "Workspace root directory")
  .option("--theme <light|dark>", "Default theme", "dark")
  .option("--open", "Open browser automatically")
  .option("-H, --harness <harness>", "Default harness", "copilot-cli")
  .option("-m, --model <model>", "Default model")
  .option(
    "--allow-tool <pattern>",
    "Allow tool (repeatable)",
    collectRepeatable,
    []
  )
  .option(
    "--deny-tool <pattern>",
    "Deny tool (repeatable)",
    collectRepeatable,
    []
  )
  .option("--allow-all-tools", "Dangerously allow all tools")
  .action(async (options) => {
    const { FlightPathServer } = await import("./server/FlightPathServer");
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
├── IDashboardProvider.ts              ← Existing shared provider interface
└── DashboardBroadcastHub.ts           ← NEW: shared fanout for IDashboardProvider + IDashboardSink (Phase 1)

src/types/
└── IDashboardSink.ts                  ← Existing live-step sink interface

src/server/
│   # ── Shared (VS Code-hosted + standalone) ──────────────────────────────
├── standalone-shim.js                 ← Browser-side VS Code API shim (Phase 3)
├── themes/
│   ├── vscode-default-dark.css        ← Full --vscode-* definitions (Phase 4)
│   └── vscode-default-light.css       ← Full --vscode-* definitions (Phase 4)
│   # ── VS Code-hosted server ──────────────────────────────────────────────
├── FlightPathHostedServer.ts          ← HTTP + WS inside the extension; implements IDashboardProvider (Phase 2)
│   # ── Standalone server ────────────────────────────────────────────────
├── FlightPathServer.ts                ← Standalone HTTP + WS; implements IDashboardProvider (Phase 6)
├── StandaloneServerAdapter.ts         ← PlatformAdapter impl (Phase 5)
├── WebSocketMessageRouter.ts          ← Routes webview messages (standalone only) (Phase 7)
├── CompletionService.ts               ← File/dir/symbol completions (Phase 8)
├── LspSymbolClient.ts                 ← (optional) LSP stdio client (Phase 8)
└── ServerFileWatcher.ts               ← chokidar-based file watcher (Phase 9)

src/cli/ServerCommand.ts               ← resolveServerConfig() for `flightpath server` (Phase 10)
src/cli.ts                             ← Add program.command('server') block (Phase 10)

src/flightpath/WorkflowOrchestrator.ts ← Finish provider fanout and stop primary-provider-only routing (Phase 1)
src/flightpath/WorkflowInstance.ts     ← Use the shared broadcast sink instead of first-provider casting (Phase 1)
src/ui/FlightPathWebviewProvider.ts    ← Reuse existing provider implementation + expose hosted-router entrypoint (Phase 2)
src/extension.ts                       ← Update: register flightpath.enableServer command (Phase 2)
src/platform/PlatformAdapter.ts        ← Update: add optional createFileWatcher() (Phase 9)
```

---

## Build Changes

### esbuild — no new bundle target

Current repo state:

- `chokidar` is already installed.
- `express`, `ws`, `fast-glob`, and `ignore` are **not** installed yet.

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

Notes:

- `express` + `ws` are needed as soon as the hosted server work starts.
- `fast-glob` + `ignore` are only required once the standalone completion service lands.
- Add `flightpath.serverPort` setting and `RUNNER_IDS.SERVER` in the same plumbing pass so the doc and runtime surface stay aligned.

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

The protocol (`MESSAGE_TYPES`, `WebviewMessageTypes`) is unchanged at the payload level. The only transport change is `vscode.postMessage` → `ws.send` (shim handles this), **but** hosted/standalone server implementations must preserve the existing distinction between:

- **broadcast state updates** (workflow summaries, step progress, CLI output, active-workflow changes), and
- **client-scoped replies** (completions, token counts, validation, other request/response messages).

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

| Harness        | Works in Server? | Notes                                |
| -------------- | ---------------- | ------------------------------------ |
| `copilot-cli`  | ✅ Yes           | Spawns process, no VS Code dep       |
| `claude-cli`   | ✅ Yes           | Spawns process, no VS Code dep       |
| `codex-cli`    | ✅ Yes           | Spawns process, no VS Code dep       |
| `copilot-chat` | ❌ No            | Automates VS Code's Chat UI directly |

Server validates harness at startup and rejects `copilot-chat` with a clear error.

---

## State Persistence

| VS Code mechanism   | Standalone replacement                   |
| ------------------- | ---------------------------------------- |
| `vscode.setState()` | `sessionStorage.setItem('fpState', ...)` |
| `vscode.getState()` | `sessionStorage.getItem('fpState')`      |

Handled entirely by the Phase 3 shim. No changes to any store.

---

## Implementation Order

### Track 1 — Shared Foundation (required for both modes)

1. **Dashboard broadcast hub** (Phase 1) — done; `IDashboardProvider` / `IDashboardSink` fanout and hosted-router reply scoping are now in place
2. **Adapter / watcher seam** (Phase 1 follow-up) — add `PlatformAdapter.createFileWatcher()`, thread adapter-driven watcher creation into `PromptFileWatcher` and `CliWatchSession`, and stop hard-coding `VsCodeAdapter` in the reusable orchestration path
3. **Build/runtime plumbing** — partial; `RUNNER_IDS.SERVER` and hosted-server message types exist, but `express` / `ws` and standalone completion deps still need to be added when implementation starts

### Track 2 — VS Code-Hosted Server (delivers browser access without leaving VS Code)

4. **`FlightPathHostedServer`** (Phase 2) — HTTP + WS inside the extension; registers with the shared dashboard hub; sends targeted initial state on connect
5. **Hosted router bridge** (Phase 2) — expose reusable `WebviewMessageRouter` logic with per-connection replies; avoid blind broadcast of request/response messages
6. **Extension/UI wiring** (Phase 2) — `flightpath.enableServer` / `flightpath.disableServer`, `flightpath.serverPort`, deactivation cleanup, and a SettingsDrawer-footer server toggle with URL/status display
7. **Shim + theme assets** (Phases 3–4) — `standalone-shim.js`, browser smoke test, and shared fallback theme CSS used by hosted tabs

### Track 3 — Standalone Server (headless / CI / no VS Code)

8. **`StandaloneServerAdapter`** (Phase 5) — mirror `CliAdapter`; always `cliExecutionMode: "headless"`
9. **`FlightPathServer`** (Phase 6) — HTTP + WS, connection registry, broadcast hub wiring, targeted initial-state sync
10. **`WebSocketMessageRouter`** (Phase 7) — all message handlers; replace VS Code command execution with direct orchestrator/service calls while keeping reply scoping correct
11. **`CompletionService`** (Phase 8) — file/dir completions with fast-glob + ignore; regex symbol heuristic
    - **Optional:** `LspSymbolClient` — LSP stdio client
12. **`ServerFileWatcher`** + `PlatformAdapter.createFileWatcher()` seam (Phase 9) — chokidar, verify every watcher construction path
13. **`flightpath server` CLI command** (Phase 10) — `program.command('server')` + `resolveServerConfig()` + `RUNNER_IDS.SERVER`
14. **esbuild + package.json** — add externals, deps, npm script
15. **Manual testing** — VS Code-hosted: open browser tab alongside sidebar, parallel workflows, pause/resume/stop; standalone: same from CLI, theme switching, completions

---

## Open Questions

1. **`WorkflowOrchestrator` construction strategy**: For the hosted-server milestone, should we keep the current `vscode.ExtensionContext` constructor and introduce a factory/builder for standalone later, or do the full adapter-first constructor refactor up front? The latter is cleaner for standalone; the former gets hosted mode moving sooner.

2. **Broadcast hub shape**: Should the shared fanout object be a single class implementing both `IDashboardProvider` and `IDashboardSink`, or two small collaborators owned by one registry? Either works, but the plan assumes a single source of truth so `WorkflowOrchestrator` and `WorkflowInstance` stop hand-picking a "primary" provider.

3. **Hosted router reuse**: Expose `WebviewMessageRouter` through a public method/factory, or add a deliberately private command surface for hosted-server re-entry? The recommended path is a direct callable API, because request/response routing must stay connection-scoped.

4. **File picker (`SELECT_FILE`) in standalone**: Hosted mode can keep the existing VS Code picker. Standalone still needs a decision between:
   - **A**: typed path / explicit workspace-relative input for MVP
   - **B**: small `GET /api/files?q=...` endpoint + inline picker in the dashboard
   - **C**: future drag-and-drop UX

5. **Recent workflow history storage**: VS Code stores this in `context.globalState`. The standalone server needs a file-based equivalent (for example `.flightpath/.history/recent.json` in the workspace or `~/.flightpath/history.json`). Determine where `WorkflowOrchestrator` currently reads/writes recent workflows and mirror that behavior.
