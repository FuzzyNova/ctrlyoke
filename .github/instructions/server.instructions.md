---
applyTo: "src/server/**"
---

<purpose>
Express/WebSocket server that hosts the FlightPath dashboard in a plain browser tab. Activated via `flightpath.enableServer` command (or `flightpath.server.enabled` config auto-start). Configured with `flightpath.server.port` (default 3000).
</purpose>

<architecture>
**FlightPathHostedServer** implements `IDashboardProvider` and self-registers with `DashboardBroadcastHub` in its constructor, receiving every orchestrator event alongside the VS Code webview.

```
WorkflowOrchestrator
  └─ DashboardBroadcastHub
       ├─ FlightPathWebviewProvider  (VS Code panel)
       └─ FlightPathHostedServer     (browser tab, registered at construction)
```

Constructor signature:
```typescript
constructor(hub: DashboardBroadcastHub, webviewProvider: FlightPathWebviewProvider, port: number)
```

`dispose()` calls `hub.removeClient(this)` and tears down all WebSocket connections, the WSS, and the HTTP server.
</architecture>

<dashboardProviderImpl>
All `IDashboardProvider` methods call `this.broadcast(message)` to fan out to every open WebSocket connection.

**Exceptions — methods that must never broadcast to browser clients:** `notifyActiveWorkflowChanged`, `updateFileSelected`, and `updateSessionRestored` are all deliberate no-ops. Each browser client's active-workflow view is driven exclusively by `replayWorkflowStateTo()` scoped to that connection. Broadcasting any of these would cause every open browser tab to jump to whatever workflow the VS Code sidebar just loaded. The hub already routes `ACTIVE_WORKFLOW_CHANGED` only to the panel client, but the no-ops guard against future hub changes and prevent the same class of bug in the file-selected/session-restored paths.

**Theme vars:** `updateThemeVars(vars)` caches the latest snapshot and broadcasts `THEME_VARS_UPDATED`. Called from `extension.ts` via `setThemeVarsCapturedCallback` after VS Code captures CSS custom properties from its own webview.
</dashboardProviderImpl>

<httpRoutes>
| Route | Handler |
|---|---|
| `GET /` and `GET /index.html` | `buildHtml()` — patched index.html |
| `GET /standalone-shim.js` | Serves `standalone-shim.js` from `__dirname/server/` |
| Static assets | `express.static` over `out/ui/webview-react/` (`index: false`) |
| Any other path | SPA fallback → `buildHtml()` |

**`buildHtml()` transformations on `out/ui/webview-react/index.html`:**

1. Removes `{{typoUri}}` script tag (VS Code-only spellchecker)
2. Replaces `{{codiconsUri}}`, `{{customIconsUri}}` with server-relative paths (`/codicons/codicon.css`, `/custom-icons.css`)
3. Replaces `{{logoUri}}` with empty string
4. Strips `crossorigin` attribute from Vite module `<script>` tags
5. Adds `data-aff-uri`/`data-dic-uri` attributes to `<body>` for spell-check dictionaries
6. Replaces the VS Code CSP `<meta>` with a browser-compatible policy; `connect-src` explicitly allows `ws://localhost:{port}`
7. Injects a `<style>` block with cached CSS custom properties (`:root { ... }`) so the browser is themed before React renders
8. Injects `<script src="/standalone-shim.js"></script>` before `</head>` so `window.vscodeApi` exists before any React module runs
</httpRoutes>

<websocketProtocol>
WebSocket endpoint: `ws://localhost:{port}/ws` (path `/ws`).

**On connection:**
1. Client added to `this.connections` (a `Set<WebSocket>`)
2. A scoped `send` function is created (checks `ws.readyState === WebSocket.OPEN`)
3. `sendInitialState()` fires:
   - Sends a synthetic `READY` message through `webviewProvider.routeExternalMessage()` — this triggers the same initial-state flow used by the VS Code webview
   - Immediately pushes `THEME_VARS_UPDATED` with cached vars (client can style itself without a round-trip)
   - Posts `CAPTURE_THEME_VARS` to the VS Code webview to refresh the theme snapshot

**Inbound messages:** routed via `webviewProvider.routeExternalMessage(msg, send, clientTag)` where `clientTag` is `"browser:N"`. This is the same `WebviewMessageRouter` used by the VS Code panel — no duplicate routing logic.

**On close:** connection removed from `this.connections`.
</websocketProtocol>

<standaloneShim>
`standalone-shim.js` is a self-executing browser script injected into every page served by the hosted server. It replaces the VS Code `acquireVsCodeApi()` pattern with a WebSocket bridge.

**What it does:**
- Opens `ws://{location.host}/ws`
- Queues outbound messages in `pending[]` until the socket is open
- Inbound `themeVarsUpdated` messages are applied directly to `document.documentElement.style` (bypasses React; avoids flash)
- All other inbound messages are dispatched as `window.dispatchEvent(new MessageEvent("message", { data: msg }))` — consumed by `useMessageHandler` in the React app
- On socket close: `setTimeout(() => location.reload(), 1500)` for development convenience (server restart)
- Exposes `window.vscodeApi` with `postMessage`, `getState`, and `setState` matching the VS Code webview API shape; `getState`/`setState` persist to `sessionStorage` under key `"fpState"`

**Must be injected before React modules.** `buildHtml()` inserts the `<script>` tag immediately before `</head>`.
</standaloneShim>

<lifecycle>
```typescript
// Start
const server = new FlightPathHostedServer(hub, webviewProvider, port);
const url = server.listen(); // binds 0.0.0.0:{port}
webviewProvider.setRunningServerUrl(url);
webviewProvider.setThemeVarsCapturedCallback((vars) => server.updateThemeVars(vars));
webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });

// Stop
server.dispose();
webviewProvider.setRunningServerUrl(undefined);
webviewProvider.setThemeVarsCapturedCallback(undefined);
```

`listen()` returns the URL string (`http://localhost:{port}`). The server is never started in the constructor — call `listen()` explicitly.
</lifecycle>

<conventions>
- **Single broadcast method:** all `IDashboardProvider` implementations call `this.broadcast(message)` — never write to individual connections directly except in `sendInitialState()` (scoped send needed there).
- **No active-view broadcasts:** never broadcast `ACTIVE_WORKFLOW_CHANGED`, `FILE_SELECTED`, or `SESSION_RESTORED` to browser clients; each client's active view is owned by its connection-scoped `replayWorkflowStateTo()` flow.
- **Theme vars flow:** VS Code webview captures CSS vars → `setThemeVarsCapturedCallback` fires → `updateThemeVars()` caches + broadcasts → new clients get the cache immediately in `sendInitialState()`.
- **HTML patching:** all VS Code URI placeholders (`{{...}}`) must be handled in `buildHtml()`; never leave unresolved placeholders reaching the browser.
- **Path resolution:** `resolveWebviewDist()` uses `path.join(__dirname, "ui", "webview-react")` — esbuild sets `__dirname` to `out/` at runtime.
- **Connection IDs:** `clientTag` format is `"browser:N"` where N increments per connection; used in router for scoped logging and reply routing.
</conventions>

<relatedFiles>
- `src/ui/IDashboardProvider.ts` — interface implemented by FlightPathHostedServer
- `src/ui/DashboardBroadcastHub.ts` — fan-out hub; `addClient`/`removeClient` manage server registration
- `src/ui/FlightPathWebviewProvider.ts` — `routeExternalMessage()` routes browser messages; `setThemeVarsCapturedCallback()` wires theme capture; `setRunningServerUrl()` updates UI
- `src/extension.ts` — `flightpath.enableServer` / `flightpath.disableServer` commands; auto-start on `flightpath.server.enabled`
- `src/types/DashboardConstants.ts` — `MESSAGE_TYPES` constants used in broadcast payloads
- `src/ui/webview-react/` — the React app being served (Vite output in `out/ui/webview-react/`)
</relatedFiles>
