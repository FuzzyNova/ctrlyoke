---
applyTo: "src/server/**"
---

<purpose>
Hosted browser server for the ctrlyoke dashboard. It serves the Vite webview build to normal browsers, bridges browser clients onto the same message protocol the VS Code sidebar uses, and exposes the workspace-viewer / browser-notification APIs.
</purpose>

<architecture>
**CtrlYokeHostedServer** is both a dashboard client and a dashboard sink.

- It registers itself with `DashboardBroadcastHub` in the constructor, so orchestrator broadcasts reach browser clients without special-case wiring.
- Per-client state replay is **not** broadcast. `notifyActiveWorkflowChanged`, `updateFileSelected`, and `updateSessionRestored` must stay connection-scoped because browser tabs are hydrated through `WorkflowOrchestrator.replayWorkflowStateTo(...)`.
- All `IDashboardSink` message shapes are single-sourced in `src/ui/PostMessageDashboardSink.ts`; `CtrlYokeHostedServer` should keep one-line delegates instead of rebuilding payloads.
- Browser inbound messages go through `CtrlYokeWebviewProvider.routeExternalMessage(...)`, so the hosted browser and the VS Code panel share the same router and workflow commands.

Key supporting pieces:

- `HostedWorkspaceViewerService` — workspace-scoped file/Git operations plus commit-message generation
- `WebPushService` — VAPID keys + push subscription persistence under `.ctrlyoke/notifications/`
- `HostedServiceWorkerScript` — injects `DashboardConstants` values into the raw service-worker template at request time
- `PngIconService` — shared in-memory colorized PNG renderer for hosted app icons
</architecture>

<authAndTransport>
- HTML, manifest, API routes, SPA fallback, and WebSocket connections require the server token.
- Static assets, icons, `/standalone-shim.js`, `/ctrlyoke-service-worker.js`, and `/cert` stay public because the browser fetches them without query params after the initial HTML load.
- Token validation accepts `x-ctrlyoke-token` header or `?token=...`; WebSocket auth is query-param only and unauthorized sockets are closed with code `4401`.
- `listen()` retries with port `0` on `EADDRINUSE`, stores the final public URL including token, and reports LAN IPs only when bound to `0.0.0.0`.
</authAndTransport>

<browserBridge>
`standalone-shim.js` is the browser replacement for `acquireVsCodeApi()`.

- It must be injected **before** React modules in `buildHtml()`.
- It opens `/ws?token=...`, sends `READY`, buffers inbound messages until React posts its own `READY`, and re-sends the latest `READY` after reconnects so the new socket gets targeted replay.
- Per-tab state is isolated with `sessionStorage` tab IDs and `localStorage` keys derived from that tab ID; do not collapse this to a single global browser state.
- Theme updates bypass React: the shim applies `THEME_VARS_UPDATED` directly to `:root` and `body` classes to avoid startup flashes and dark-mode mismatches.
</browserBridge>

<htmlAndAssets>
`CtrlYokeHostedServer.buildHtml()` is the browser-only patch layer over the Vite output.

- Replace VS Code URI placeholders there, not in the React bundle.
- Keep the standalone shim injection, CSP rewrite, theme-style injection, manifest link, and hosted icon links together in this method.
- Icon URLs intentionally get `bg`/`fg` query params for cache busting when hosted icon colors change.
- `resolveWebviewDist()` assumes runtime `__dirname` is `out/`; keep hosted asset lookups relative to that output layout.
</htmlAndAssets>

<workspaceViewer>
`HostedWorkspaceViewerService` is the security boundary for browser file/Git access.

- `safeResolve()` is symlink-aware and must reject anything outside the workspace, including transfer destinations and parent-directory escapes.
- Text reads reject binary files and files over 2 MB; writes preserve the original file's EOL convention and use a sibling temp file for atomic replacement.
- Git commands use `execFile`, never shell strings. Paths passed to Git are normalized to forward slashes with `toGitPath()`.
- The service owns directory tree/file read-save plus delete/copy/move, SCM status/diff/stage/unstage/discard, push/pull, and browser-side commit-message generation.
- `generateCommitMessage()` reuses `src/git/CommitMessageGenerator.ts` and records provenance through `commitMessageGenerationTracker`; keep that path aligned with the SCM commit-message flow instead of inventing a browser-only implementation.
</workspaceViewer>

<notifications>
- Hosted completion notifications are deduped per server instance via `notifiedEventIds` before broadcasting or sending push.
- `WebPushService` serializes registry updates through an internal promise queue; do not bypass it with ad hoc file I/O.
- Expired push subscriptions (404/410) are removed automatically during send attempts.
- `ctrlyoke-service-worker.js` is a placeholder template, not the final script. Message-type constants and icon paths are injected by `HostedServiceWorkerScript`, so avoid hardcoding duplicated literals into the template.
</notifications>

<testing>
Current unit coverage is concentrated in:

- `src/test/unit/HostedWorkspaceViewerService.test.ts`
- `src/test/unit/HostedServiceWorkerScript.test.ts`
- `src/test/unit/CtrlYokeHostedServer.test.ts` (message-factory shape only, not full server integration)

If you change route contracts, path-safety logic, or service-worker placeholder behavior, update these focused tests before reaching for broader integration coverage.
</testing>

<relatedFiles>
- `src/extension.ts` — start/stop/regenerate-token commands and theme-capture hookup
- `src/ui/PostMessageDashboardSink.ts` — single source of truth for sink payload shapes
- `src/ui/CtrlYokeWebviewProvider.ts` — shared external-message routing and browser-client registration
- `src/core/WorkflowOrchestrator.ts` — per-client replay path browsers depend on
- `src/types/HostedWorkspaceViewerTypes.ts` — API contracts shared with the React workspace viewer
</relatedFiles>
