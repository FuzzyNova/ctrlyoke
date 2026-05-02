---
applyTo: "src/server/**"
---

<purpose>
Express/WebSocket server that hosts the FlightPath dashboard in a plain browser tab (and as a PWA). Activated via `flightpath.enableServer` command (or `flightpath.server.enabled` config auto-start). Configured with `flightpath.server.port` (default 3000).
</purpose>

<architecture>
**FlightPathHostedServer** implements both `IDashboardProvider` and `IDashboardSink`, and self-registers with `DashboardBroadcastHub` in its constructor, receiving every orchestrator event alongside the VS Code webview.

```
WorkflowOrchestrator
  └─ DashboardBroadcastHub
       ├─ FlightPathWebviewProvider  (VS Code panel)
       └─ FlightPathHostedServer     (browser tab, registered at construction)
```

Constructor signature:

```typescript
constructor(
  hub: DashboardBroadcastHub,
  webviewProvider: FlightPathWebviewProvider,
  getOrchestrator: () => WorkflowOrchestrator,
  port: number,
  workspaceRoot: string,
  token: string,
  bindAddress: string = "127.0.0.1",
  tlsConfig?: { certPath: string; keyPath: string }
)
```

`dispose()` calls `hub.removeClient(this)`, clears the heartbeat interval, closes all WebSocket connections, the WSS, and the HTTP server.

**Supporting services** (instantiated in constructor):
- `WebPushService` — manages VAPID keys and push subscriptions persisted under `.flightpath/notifications/`
- `HostedWorkspaceViewerService` — workspace-scoped file read/write and git operations for the browser editor
- `PngIconService` (singleton `pngIconService`) — renders SVG icons to PNG (180×180 and 512×512) via `@resvg/resvg-wasm`

**Supporting modules:**
- `HostedServerMessageFactory.ts` — `createHostedHarnessStatusUpdate()` builds harness status messages used by `notifyHarnessAvailability`
- `HostedServiceWorkerScript.ts` — `buildHostedServiceWorkerScript()` injects `DashboardConstants` placeholders into `flightpath-service-worker.js` at request time
</architecture>

<security>
All API routes and the HTML entry point require authentication. Static assets (JS/CSS/fonts, shim, service worker, icons) are served without a token because the browser fetches them without query params after loading the entry HTML.

**Token validation** (`requestHasValidToken()`): checks `x-flightpath-token` request header, then `?token=` query param.

**Unauthenticated routes** (public, no sensitive data): `/standalone-shim.js`, `/flightpath-service-worker.js`, `/cert`, `/favicon.svg`, `/app-icon.svg`, `/apple-touch-icon.png`, `/app-icon.png`, static assets via `express.static`.

**Token-required routes**: `/`, `/index.html`, `/manifest.webmanifest`, `/api/*`, SPA fallback.

**WebSocket**: token required as `?token=` query param on connection; connections without a valid token are closed with code 4401.

**TLS**: optional; pass `tlsConfig` to enable HTTPS/WSS. A `/cert` route (no token) serves the public certificate for iOS trust installation.

**Bind address**: defaults to `127.0.0.1` (loopback only). Set to `0.0.0.0` for LAN access.
</security>

<dashboardProviderImpl>
All `IDashboardProvider` methods call `this.broadcast(message)` to fan out to every open WebSocket connection.

**Exception — method that must never broadcast to browser clients:** `notifyActiveWorkflowChanged` is a deliberate no-op. Each browser client's active-workflow view is driven exclusively by `replayWorkflowStateTo()` scoped to that connection. Broadcasting this would cause every open browser tab to jump to whatever workflow the VS Code sidebar just loaded.

**IDashboardSink delegation:** All `IDashboardSink` methods delegate to an internal `PostMessageDashboardSink` instance constructed with `(msg) => this.broadcast(msg)`. Message shapes are single-sourced in `PostMessageDashboardSink` — add new methods there first, then add a one-liner delegate in `FlightPathHostedServer`.

**Theme vars:** `updateThemeVars(vars)` caches the latest snapshot and broadcasts `THEME_VARS_UPDATED`. Called from `extension.ts` via `setThemeVarsCapturedCallback` after VS Code captures CSS custom properties from its own webview.

**Completion notifications:** `notifyWorkflowSummaryUpdated` and `updateStepStatus` detect completion transitions and call `dispatchCompletionNotification()`, which broadcasts a `NOTIFICATION_EVENT` message and optionally sends a Web Push notification (when `notifications.browser.mode === "push"`). Deduplication is done via `notifiedEventIds` set.
</dashboardProviderImpl>

<httpRoutes>
Routes are registered in this order (first match wins):

**No token required:**
| Route | Handler |
|---|---|
| `GET /standalone-shim.js` | Serves `standalone-shim.js` — `Cache-Control: no-store` |
| `GET /cert` | Downloads TLS cert as `flightpath.cer` (404 if TLS not configured) |
| `GET /flightpath-service-worker.js` | `buildHostedServiceWorkerScript()` with injected constants |
| `GET /favicon.svg` | Colorized SVG (colors from `configService.getAll().server`) — `no-store` |
| `GET /app-icon.svg` | Colorized SVG — `no-store` |
| `GET /apple-touch-icon.png` | `PngIconService.getSmall()` — 180×180 PNG — `no-store` |
| `GET /app-icon.png` | `PngIconService.getLarge()` — 512×512 PNG — `no-store` |
| Static assets | `express.static` over `out/ui/webview-react/` (`index: false`) |

**Token required:**
| Route | Handler |
|---|---|
| `GET /manifest.webmanifest` | PWA manifest JSON with icon URLs and `start_url` containing token |
| `GET /api/notifications/vapid-public-key` | `WebPushService.getPublicKey()` |
| `GET /api/notifications/subscriptions` | `WebPushService.listSubscriptions()` |
| `POST /api/notifications/subscriptions` | `WebPushService.upsertSubscription()` |
| `DELETE /api/notifications/subscriptions/:id` | `WebPushService.removeSubscription()` |
| `GET /` and `GET /index.html` | `buildHtml()` — patched index.html — `no-store` |
| `GET /api/workflow-files` | `{ workspaceRoot, files }` from `findWorkflowFilesInWorkspace` |
| `GET /api/workspace-viewer/tree` | `HostedWorkspaceViewerService.listDirectory(?path=)` |
| `GET /api/workspace-viewer/file` | `HostedWorkspaceViewerService.readFile(?path=)` |
| `PUT /api/workspace-viewer/file` | `HostedWorkspaceViewerService.saveFile({ path, content })` — 5 MB limit |
| `GET /api/workspace-viewer/status` | `HostedWorkspaceViewerService.getStatus()` — git porcelain + sync counts |
| `GET /api/workspace-viewer/diff` | `HostedWorkspaceViewerService.getDiff(?path=)` |
| `POST /api/workspace-viewer/stage` | `HostedWorkspaceViewerService.stageFile({ path })` |
| `POST /api/workspace-viewer/unstage` | `HostedWorkspaceViewerService.unstageFile({ path })` |
| `POST /api/workspace-viewer/discard` | `HostedWorkspaceViewerService.discardFile({ path })` |
| `POST /api/workspace-viewer/commit` | `HostedWorkspaceViewerService.commit({ message })` |
| `POST /api/workspace-viewer/push` | `HostedWorkspaceViewerService.push()` |
| `POST /api/workspace-viewer/pull` | `HostedWorkspaceViewerService.pull()` |
| SPA fallback (any unmatched path) | `buildHtml()` |

**`buildHtml()` transformations on `out/ui/webview-react/index.html`:**

1. Replaces `{{typoUri}}` with `/typo.js` (Vite-copied static asset)
2. Replaces `{{codiconsUri}}`, `{{customIconsUri}}` with server-relative paths
3. Replaces `{{logoUri}}` with `/flightpath-icon.svg`
4. Strips `crossorigin` from Vite module `<script>` tags
5. Injects `class`, `data-aff-uri`, `data-dic-uri`, `data-logo-uri` on `<body>`; class is `vscode-dark`/`vscode-light`/`vscode-high-contrast` derived from cached theme vars
6. Replaces the VS Code CSP `<meta>` with a browser-compatible policy; `connect-src` allows the request host's WebSocket URL plus localhost loopback forms
7. Before `</head>`: injects theme `<style>` block (`:root { ... }`), PWA icon `<link>` tags with cache-busting color params, `<link rel="manifest">` with token, `<script src="/standalone-shim.js">`
</httpRoutes>

<websocketProtocol>
WebSocket endpoint: `ws://localhost:{port}/ws?token={token}` (path `/ws`).

**On connection:**
1. Token validated — closes with code 4401 if invalid
2. Client added to `this.connections` and `socketLiveness` WeakMap
3. `clientTag` assigned as `"browser:N"` (incremented per connection)
4. `sendInitialState()` fires: pushes `THEME_VARS_UPDATED` with cached vars, requests `CAPTURE_THEME_VARS` from VS Code webview
5. **Does NOT inject a synthetic `READY`** — standalone shim owns registration by sending `READY` when socket opens

**Inbound messages:** routed via `webviewProvider.routeExternalMessage(msg, send, clientTag)` — same `WebviewMessageRouter` as the VS Code panel.

**Heartbeat:** ping/pong every 30s. Connections that do not respond to a ping are terminated on the next interval.

**On close:** connection removed from `this.connections`, `webviewProvider.unregisterBrowserClient(clientTag)` called.
</websocketProtocol>

<standaloneShim>
`standalone-shim.js` is a self-executing browser script injected into every page. It replaces `acquireVsCodeApi()` with a WebSocket bridge.

**What it does:**
- Generates a stable per-tab ID (`fpTabId`) in `sessionStorage`; state persisted to `localStorage` under `fpState-{tabId}` (tabs are independent)
- Opens `ws://{location.host}/ws?token={token}` (token extracted from current URL)
- Queues outbound messages until socket is open; reconnects without reloading; flushes queue after reconnect
- Sends `READY` on socket open (registers browser client before React mounts)
- Re-sends latest `READY` after reconnect so new WS client ID is registered and receives targeted replay
- Suppresses reconnects while document is hidden or in Safari page cache (`pagehide`/`pageshow`)
- 1800ms watchdog detects sockets stuck in `CONNECTING` (iOS Safari bug) — abandons stale socket and retries
- Buffers non-theme inbound messages until React sends `READY` (prevents drop before `useMessageHandler` installs)
- `themeVarsUpdated` applied directly to `document.documentElement.style` and `document.body.classList` (bypasses React; avoids flash)
- All other inbound messages dispatched as `window.dispatchEvent(new MessageEvent("message", { data: msg }))`
- Sets `window.__flightpathStandalone = true`
- Exposes `window.vscodeApi` with `postMessage`, `getState`, `setState`

**Must be injected before React modules.** `buildHtml()` inserts it immediately before `</head>`.
</standaloneShim>

<lifecycle>
```typescript
// Start
const server = new FlightPathHostedServer(hub, webviewProvider, getOrchestrator, port, workspaceRoot, token, bindAddress, tlsConfig);
const url = await server.listen(); // returns "http(s)://{host}:{port}/?token={token}"
webviewProvider.setRunningServerUrl(url);
webviewProvider.setThemeVarsCapturedCallback((vars) => server.updateThemeVars(vars));
webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });

// Stop
server.dispose();
webviewProvider.setRunningServerUrl(undefined);
webviewProvider.setThemeVarsCapturedCallback(undefined);
```

`listen()` is async and returns the full public URL including token. If the configured port is in use, it retries with port `0` (OS-assigned). Binds to `bindAddress` (default `127.0.0.1`). When `bindAddress === "0.0.0.0"`, `getAvailableIps()` returns non-loopback IPv4 addresses for LAN display.
</lifecycle>

<conventions>
- **Single broadcast method:** all `IDashboardProvider` implementations call `this.broadcast(message)` — never write to individual connections directly except in `sendInitialState()`.
- **No active-view broadcasts:** never broadcast `ACTIVE_WORKFLOW_CHANGED`, `FILE_SELECTED`, or `SESSION_RESTORED` to browser clients; each client's active view is owned by its connection-scoped `replayWorkflowStateTo()` flow.
- **Theme vars flow:** VS Code webview captures CSS vars → `setThemeVarsCapturedCallback` fires → `updateThemeVars()` caches + broadcasts → new clients get the cache in `sendInitialState()`.
- **HTML patching:** all VS Code URI placeholders (`{{...}}`) must be resolved in `buildHtml()`; never leave unresolved placeholders reaching the browser.
- **Path resolution:** `resolveWebviewDist()` uses `path.join(__dirname, "ui", "webview-react")` — esbuild sets `__dirname` to `out/` at runtime.
- **Connection IDs:** `clientTag` format is `"browser:N"` where N increments per connection.
- **Icon colorization:** SVG icons apply `iconBgColor`/`iconFgColor` from `configService.getAll().server` at request time. PNGs are generated via `PngIconService` (cached; regenerated only when colors change). Cache-busting color params are appended to icon URLs in HTML/manifest so browsers pick up color changes.
- **Workspace viewer security:** `HostedWorkspaceViewerService.safeResolve()` rejects any path that escapes the workspace root (symlink-aware). All git operations run with `execFile` (no shell injection). Max file read: 2 MB; binary files are rejected.
- **Push notification deduplication:** `notifiedEventIds` set prevents the same event from firing more than once per server instance. Stale subscriptions (404/410 responses) are removed automatically by `WebPushService.sendNotification()`.
</conventions>

<relatedFiles>
- `src/ui/IDashboardProvider.ts` — interface implemented by `FlightPathHostedServer`
- `src/ui/DashboardBroadcastHub.ts` — fan-out hub; `addClient`/`removeClient` manage server registration
- `src/ui/FlightPathWebviewProvider.ts` — `routeExternalMessage()`, `setThemeVarsCapturedCallback()`, `setRunningServerUrl()`
- `src/ui/notifications/CompletionNotificationFactory.ts` — builds `CompletionNotificationEvent` payloads for push/browser notifications
- `src/extension.ts` — `flightpath.enableServer` / `flightpath.disableServer` commands; auto-start on `flightpath.server.enabled`
- `src/types/DashboardConstants.ts` — `MESSAGE_TYPES`, `HOSTED_ICON_PATHS`, `HOSTED_ICON_FILES`, `SERVICE_WORKER_BADGE_MESSAGE_TYPES`, `BROWSER_NOTIFICATION_MODES`
- `src/types/HostedWorkspaceViewerTypes.ts` — request/response types for workspace viewer API
- `src/types/IconColorDefaults.ts` — `ICON_BG_COLOR_DEFAULT`, `ICON_FG_COLOR_DEFAULT`
- `src/ui/webview-react/` — the React app being served (Vite output in `out/ui/webview-react/`)
</relatedFiles>
