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
- `postMessage()` drops `STARTUP_COMPLETE` before broadcasting instead of forwarding it like every other hub message. `DashboardBroadcastHub.notifyStartupComplete()` fires the instant the *panel's* auto-load settles, with no regard for whether a given browser socket's own `READY` has reached the front of `WebviewMessageRouter`'s serialized `routeQueue` yet (a slow startup — many harnesses/worktrees to probe — can leave it seconds behind). Forwarding that broadcast to a browser that hasn't been replayed yet races ahead of its own `SESSION_RESTORED`/`WORKFLOWS_LIST`; `useMessageHandler`'s `STARTUP_COMPLETE` handler then sees no `fileName`/`activeWorkflowWorkingFilePath` and fires `CLEAR_WORKFLOW`, silently dropping the browser tab onto a blank new workflow instead of its most-recent session. Every browser client already gets its own correctly-sequenced `STARTUP_COMPLETE` from `WebviewMessageRouter.completeBrowserReadyAfterStartup()` once its replay actually finishes, so the hub broadcast is pure redundancy for browsers — safe to swallow here, must stay wired for the panel (via `PostMessageDashboardSink`, not this class).

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
- `listen()` retries with port `0` on `EADDRINUSE`, stores the final public URL including token, and reports LAN IPs only when bound to `0.0.0.0`. This retry is silent at the socket layer — `getPortFallbackInfo()` is the only signal that it happened (`{ requestedPort, actualPort }`, `null` when the configured port bound directly). That info has to be threaded by hand through every hop that doesn't already carry `serverUrl`: `extension.ts`'s `enableServerCommand` reads it after `listen()` resolves and both shows a `showWarningMessage` and forwards it on `SERVER_STARTED`; `CtrlYokeWebviewProvider.setRunningServerUrl()` takes it as a third param so a reconnecting panel (webview reload) still gets it replayed via `WebviewRouterCallbacks.getPortFallback`; `settingsStore.portFallback` clears on `SERVER_STOPPED`. `ServerSection.tsx` only renders the persistent warning when `portFallback.requestedPort === server.port`, so editing the port field away from the conflicting value silently retires a stale warning instead of needing an explicit dismiss action.
- In dev builds only (`IS_DEV_MODE`), `listen()`/`dispose()` mirror the running server's URL (including token) to `.ctrlyoke/dev/server-url.txt` (gitignored) via `writeDevServerUrlFile()`/`clearDevServerUrlFile()`, so an agent driving Playwright can read the live URL off disk instead of a human pasting it every session. If port collision identifies a live sibling for the same workspace, the sibling URL is written too, but the non-running instance must preserve that file through its immediate `dispose()`; only the instance that owns the running server clears the file on disposal. Keep that ownership distinction intact if you touch this path.
- Two auth middlewares exist on purpose: `requireToken` (plain-text 401, used by JSON API routes so client fetch error handling stays predictable) and `requireTokenForPage` (themed HTML 401 via `sendUnauthorizedPage()`, used only by `/`, `/index.html`, and the SPA fallback — the routes a human actually lands on in a browser tab). `sendNotFoundPage()` renders the same themed template for public-but-missing resources like a TLS-disabled `/cert`. Both delegate to `HostedErrorPageTemplate.buildHostedErrorPage()`, which reuses `buildThemeStyleBlock()`/`resolveThemeBodyClass()` so the error page matches the current VS Code theme instead of flashing unstyled. Keep new browser-navigable routes on the themed helpers rather than reintroducing bare `res.status(401/404).send("...")` text.
</authAndTransport>

<browserBridge>
`standalone-shim.js` is the browser replacement for `acquireVsCodeApi()`.

- It must be injected **before** React modules in `buildHtml()`.
- It opens `/ws?token=...`, sends `READY`, buffers inbound messages until React posts its own `READY`, and re-sends the latest `READY` after reconnects so the new socket gets targeted replay.
- Connection liveness has two layers: the server's protocol ping/pong plus an application heartbeat/ack, and the shim's visible-page inbound watchdog plus foreground probe. Timing and message names come from `HOSTED_CONNECTION_LIVENESS` / `MESSAGE_TYPES` and are injected by `HostedStandaloneShimScript`; keep both sides aligned there rather than hardcoding raw-shim values. The shim must be able to abandon a socket still reported as `OPEN` because iOS can omit its close event after a mobile/VPN route change.
- **Outbound messages are never queued across a disconnect.** `pendingOutbound` is flushed the instant a socket opens — which is exactly when the extension host has just restarted — so queuing a user command there replays a pre-outage click into a freshly started extension. That is how a stale "Re-run" launched a whole workflow seconds after VS Code came back, looking like ctrlyoke auto-started a run on launch. Only the READY handshake (React posts it before the first socket exists) and shim connection diagnostics may wait in `pendingOutbound`; everything else posted while the socket is down is dropped with a warning, and the reconnect's full state replay re-syncs the client. Do not "fix" the dropped messages by re-queuing them.
- Per-tab state is isolated with `sessionStorage` tab IDs and `localStorage` keys derived from that tab ID; do not collapse this to a single global browser state.
- Because browser/PWA closes can clear `sessionStorage`, `standalone-shim.js` also keeps `fpLastTabId`, an open-tab heartbeat registry, and a `fpState-last` fallback so unsent prompt drafts survive a one-tab close/reopen without forcing live tabs to share one state object.
- Theme updates bypass React: the shim applies `THEME_VARS_UPDATED` directly to `:root` and `body` classes to avoid startup flashes and dark-mode mismatches.
  </browserBridge>

<htmlAndAssets>
`CtrlYokeHostedServer.buildHtml()` is the browser-only patch layer over the Vite output.

- Replace VS Code URI placeholders there, not in the React bundle.
- Keep the standalone shim injection, CSP rewrite, theme-style injection, manifest link, and hosted icon links together in this method.
- Icon URLs intentionally get `bg`/`fg` query params for cache busting when hosted icon colors change.
- `resolveWebviewDist()` assumes runtime `__dirname` is `out/`; keep hosted asset lookups relative to that output layout.
- Server-rendered markup (the themed error page, the service worker script) lives in its own real `.js`/`.html` file under `src/server/` — not a template literal inside a `.ts` file — so it gets normal editor syntax highlighting/linting. `HostedErrorPageTemplate.ts` and `HostedServiceWorkerScript.ts` both follow the same read-template/`replaceAll`-placeholder-tokens pattern (`__CTRLYOKE_X__`), throwing if a placeholder goes missing from the template. Any new template file needs three additions or it silently won't ship: the `serverStaticFiles` list in `esbuild.js`'s `copyServerPlugin` (copies `src/server/*` → `out/server/*`), the two candidate-path lookups in the loader (`out/server/<file>` for the esbuild-bundled `extension.js`/`cli.js`/`mcp-server.js` runtime where `__dirname` is `out/`, and `out/<file>` relative to a plain-`tsc`-compiled module under `out/server/` where `__dirname` is already `out/server/`), and a `!out/server/<file>` allowlist line in `.vscodeignore` (everything under `out/` is ignored by default for the packaged VSIX).
  </htmlAndAssets>

<workspaceViewer>
`HostedWorkspaceViewerService` is the security boundary for browser file/Git access.

- `safeResolve()` is symlink-aware and must reject anything outside the workspace, including transfer destinations and parent-directory escapes.
- Text reads reject binary files and files over 2 MB; writes preserve the original file's EOL convention and use a sibling temp file for atomic replacement.
- Git commands use `execFile`, never shell strings. Paths passed to Git are normalized to forward slashes with `toGitPath()`.
- The service owns directory tree/file read-save plus delete/copy/move, SCM status/diff/stage/unstage/discard, push/pull, and browser-side commit-message generation.
- `generateCommitMessage()` reuses `src/git/CommitMessageGenerator.ts` and records provenance through `commitMessageGenerationTracker`; keep that path aligned with the SCM commit-message flow instead of inventing a browser-only implementation.
- **Multi-root**: the constructor takes `namedRoots: ResolverWorkspaceFolder[]` (from `getVsCodeNamedWorkspaceRoots()`, threaded through `CtrlYokeHostedServer`'s constructor from `extension.ts`). When more than one root is open, `listDirectory("")` returns a virtual top level (`isRootsList: true` in `WorkspaceTreeResponse`) listing every root by folder name instead of the primary root's contents, and every path below that level is folder-name-prefixed (`root2/src/index.ts`) — the folder-name-prefixed viewer-path convention owned by `WorkspaceViewerPath.ts` (`src/platform/`) and shared with references (`PromptLinkProvider`, `WebviewMessageRouter`, `ContextExpander`) and the snapshot/undo layer. `relativePath()` (absolute→viewer) and `resolveAgainstRoots()` (viewer→absolute) are thin wrappers over that module's `toViewerPath`/`fromViewerPath` — do not re-implement prefix slicing here. `fromViewerPath` handles the bare-root-name case (navigating to a root's own top level, which has no `/` for the general resolver to key off) so the name resolves to that root's toplevel instead of being joined onto the primary root as a literal subdirectory. `safeResolve()` still resolves against `this.trustedRoots` (all named roots) rather than a single `workspaceRoot` once multi-root.
- **Multi-repo** (a multi-root workspace whose roots span several git repos): repos are discovered by git toplevel via `discoverRepos()` (`src/utils/WorkspaceRepoDiscovery.ts`), the single source of repo identity shared with the snapshot/undo layer — roots inside the same repo collapse to one entry, a root nested below its toplevel maps to that repo, and non-repo roots drop out. When a root IS its own toplevel, `discoverRepos` keeps the root's own `fsPath` as `rootPath` (not git's realpath) so it stays identical to the trusted-root path used for prefixing. The service caches the result (`repoCache`) with a short TTL (`REPO_CACHE_TTL_MS`): `namedRoots` is fixed per instance but the discovered repo set is not — a `git init`/`.git` removal inside an existing root changes discovery without changing the roots (so nothing reconstructs the service), and the TTL picks that up within a few seconds while keeping discovery off the hot path for bursts of SCM calls. Every git op runs `-C <repo toplevel>`, resolved either from a `repoId` (`resolveRepoRoot()`, for the repo-scoped ops `getStatus`/`commit`/`push`/`pull`/`getCommitLog`/`checkout*`/`getGitRefDiff`/`generateCommitMessage`) or inferred from the file's path (`requireRepoRootForPath()`, for the path-carrying ops `getDiff`/`stageFile`/`unstageFile`/`discardFile`) — the latter throws "File is not inside a git repository" for a path in no repo instead of handing git a broken pathspec. `getStatus(repoId?)` aggregates every repo when `repoId` is omitted (what the explorer needs to color all roots) and scopes to one repo when set (the SCM pane's repo selector). `parsePorcelainV1()` maps each git-repo-relative path back to a viewer path via `relativePath()` (plain single-root, folder-name-prefixed multi-root) and drops files outside every trusted root. Repo ids are exposed to clients via `GET /api/workspace-viewer/repos`, whose response also carries `prefixRepoIds` — the authoritative viewer-path-prefix (root folder name) → repo-id map from `mapRootPrefixesToRepos()` — so the client defaults its repo selector to the open file without reverse-engineering the mapping from `label`/`id` (which diverge from the prefix for roots below their toplevel or sharing a repo). The repo-scoped routes accept an optional `repo` param.
  </workspaceViewer>

<notifications>
- Hosted completion notifications are deduped per server instance via `notifiedEventIds` before broadcasting or sending push.
- `WebPushService` serializes registry updates through an internal promise queue; do not bypass it with ad hoc file I/O.
- `PngIconService` loads `@resvg/resvg-wasm` from `out/runtime-deps/node_modules/` on purpose. Keep `@resvg/resvg-wasm` isolated from the esbuild bundles rather than re-inlining it into `out/extension.js`.
- Expired push subscriptions (404/410) are removed automatically during send attempts.
- `ctrlyoke-service-worker.js` is a placeholder template, not the final script. Message-type constants and icon paths are injected by `HostedServiceWorkerScript`, so avoid hardcoding duplicated literals into the template.
</notifications>

<testing>
Current unit coverage is concentrated in:

- `src/test/unit/HostedWorkspaceViewerService.test.ts`
- `src/test/unit/HostedServiceWorkerScript.test.ts`
- `src/test/unit/CtrlYokeHostedServer.test.ts` (message-factory shape only, not full server integration)

If you change route contracts, path-safety logic, or service-worker placeholder behavior, update these focused tests before reaching for broader integration coverage.

`HostedStandaloneShimScript.test.ts` evaluates the _rendered_ shim in a `vm` sandbox (fake `WebSocket`/storage/document) to cover real shim behavior, not just template substitution. It therefore reads `out/server/standalone-shim.js`, which is copied by `npm run compile:extension` — **not** by `compile-tests`/`npm test`. Edit `src/server/standalone-shim.js`, run only `compile-tests`, and the suite silently exercises the previous copy: shim tests pass or fail against stale code with nothing reporting why. Run `npm run compile:extension` after touching the shim.
</testing>

<relatedFiles>
- `src/extension.ts` — start/stop/regenerate-token commands and theme-capture hookup
- `src/ui/PostMessageDashboardSink.ts` — single source of truth for sink payload shapes
- `src/ui/CtrlYokeWebviewProvider.ts` — shared external-message routing and browser-client registration
- `src/core/WorkflowOrchestrator.ts` — per-client replay path browsers depend on
- `src/types/HostedWorkspaceViewerTypes.ts` — API contracts shared with the React workspace viewer
</relatedFiles>
