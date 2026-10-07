# Standalone ctrlyoke Server Plan

**Status (2026-10-06):** The VS Code-hosted server has **shipped**. The
standalone `ctrlyoke server` is **not started, but it is ready to implement**
once its decoupling prerequisites land. Every fact in this document was
re-audited against `src/` on 2026-10-06, and every open question has a
decision. ROADMAP lists it as a P2 item for milestone 0.4.

**Sequencing:** [`STANDALONE_STAGING_PLAN.md`](STANDALONE_STAGING_PLAN.md) is
the only authoritative order of work. The standalone work is staging Track B
(Stages 7a–11). It starts after Track A (decoupling, Stages 1–6). The phase
numbers in this document describe structure only.

**Related plans:**

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../implemented/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
  is the authoritative plan for host ports, the host-neutral router,
  `DashboardApplication`, the Node watcher, and retiring the Node-side shim.
  It also holds the full `vscode` inventory, which this document no longer
  duplicates.
- [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md)
  is implemented. It provides the toast and interaction parity standalone
  depends on.
- [`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](../backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md)
  owns the `SymbolIndex` port. Standalone v1 ships its `RegexSymbolIndex`, and
  the LSP plan adds `LspSymbolIndex` later.
- [`CLI_DISTRIBUTION_PLAN.md`](../backlog/CLI_DISTRIBUTION_PLAN.md). The
  standalone server ships inside the existing npm `ctrlyoke` package.

## Overview

Expose the existing `src/ui/webview-react/` React dashboard as a
browser-accessible web app. There are two delivery modes. Both run the same
dashboard application and the same HTTP/WebSocket server class.

1. **VS Code-hosted server (shipped).** `ctrlyoke.enableServer` starts
   `CtrlYokeHostedServer` inside the extension host. The live
   `WorkflowOrchestrator` is the backend, and browser tabs connect as extra
   clients alongside the VS Code panel.
2. **Standalone server (`ctrlyoke server`).** A plain Node.js process with no
   VS Code dependency, for headless machines, remote access, and phone + laptop
   use when VS Code isn't running. Browser surfaces replace VS Code-native
   dialogs and editors: `FileBrowserModal`, `WorkspaceFileEditor`, and the
   workspace viewer's diff views. All six harnesses are CLI-based, so all of
   them work.

## Mode Comparison

| Feature                    | `ctrlyoke run` (CLI) | VS Code-Hosted Server | `ctrlyoke server` (standalone) | VS Code Extension |
| -------------------------- | -------------------- | --------------------- | ------------------------------ | ----------------- |
| Parallel workflows         | No — single run      | **Yes**               | **Yes**                        | **Yes**           |
| Full dashboard             | No — terminal output | **Yes**               | **Yes**                        | **Yes**           |
| Workflow switcher dropdown | No                   | **Yes**               | **Yes**                        | **Yes**           |
| Run history                | `ctrlyoke history`   | **Yes**               | **Yes**                        | **Yes**           |
| File/directory selection   | No                   | Web modal             | Web modal                      | Native dialog     |
| Interactive harness TUI    | User's own terminal  | Dashboard terminal    | Dashboard terminal             | Dashboard / PTY   |
| Requires VS Code open      | No                   | **Yes**               | No                             | Yes               |
| Headless / CI use          | Yes                  | No                    | **Yes**                        | No                |

## Goals

- Serve the existing React dashboard from a VS Code-free process, using the
  same dashboard application, router, and server class as the hosted mode.
- Keep full feature parity with the VS Code dashboard: parallel workflows, the
  switcher, history, the workspace viewer, the source-control views, and every
  message type.
- Reuse `WorkflowOrchestrator` directly. There is no parallel orchestration
  logic.
- Keep the hosted server's security model: tokens, TLS, and the Pro gate on
  remote access.
- Ship in the existing npm `ctrlyoke` binary with no new runtime npm
  dependencies. Everything is bundled.

## Non-Goals

- Real-time multi-user collaboration. Each server instance serves one
  workspace.
- Multi-root standalone workspaces. One process owns one `cwd` root.
- A full VS Code replacement.
- Typed-path, search, or drag-and-drop additions to `FileBrowserModal`. These
  are tracked separately if wanted (Open Question 3).

## Current Codebase Audit (2026-10-06)

### Already in place

- **Dashboard fanout.** `IDashboardProvider`, `IDashboardSink`, and
  `DashboardBroadcastHub` drive multi-client fanout. The orchestrator and
  workflow instances publish only through the hub.
- **`CtrlYokeHostedServer.ts` (2,815 lines)** is the reference
  implementation. It is free of `vscode` imports except for one _type_ import
  of `CtrlYokeWebviewProvider`. It provides:
  - Express + `ws` with `noServer: true` and an `upgrade` handler. The handler
    returns 404 for any path except `/ws` and 401 unless `?token=` matches,
    using a timing-safe comparison (`c58b78580`).
  - Token-gated HTML and APIs (`x-ctrlyoke-token` header or `?token=`). The
    JSON body parser is skipped for requests without a valid token.
  - Optional TLS that reads existing cert/key paths, plus a `/cert` download.
  - A 30 s heartbeat with a 60 s application-ack timeout.
  - Port fallback across `server.fallbackPorts`, with sibling-server
    detection.
  - Web push (`WebPushService`, VAPID keys under `ctrlyokeStateHome()`).
  - The Pro gate on remote (non-loopback) access (`getRemoteAccess`,
    `onRemoteAccessBlocked`).
  - Theme-var injection and the whole `/api/workspace-viewer/*` family.
- **`HostedWorkspaceViewerService.ts` (3,179 lines)** is free of `vscode` and
  is built from project-owned named roots. It covers:
  - the tree, search, and file read/write (atomic, EOL-preserving,
    redaction-aware);
  - copy, move, and delete;
  - git status, diff, stage, unstage, discard, commit, push, pull, and
    commit-message generation;
  - commit log, file history, ref, worktree, and checkout diffs.
- **`standalone-shim.js` (808 lines).** The shim provides:
  - per-tab state in `localStorage["fpState-<tabId>"]`, mirrored to
    `fpState-last`, with the tab ID in `sessionStorage` and reclaimed from
    `fpLastTabId`;
  - backoff reconnects plus watchdog and heartbeat probes;
  - a certificate/connection banner after 5 failed connects;
  - READY replay and pre-React buffering;
  - config injected through `HostedStandaloneShimScript.ts`;
  - `window.__ctrlyokeStandalone = true`, which the webview reads as "running
    in a browser", for both hosted and standalone.
- **Host ports and decoupling progress:**
  - `WorkflowOrchestrator` takes a project-owned
    `WorkflowOrchestratorDependencies`, has no `vscode` import, and is
    constructed only in `extension.ts`.
  - `PlatformAdapter` no longer has UI methods.
  - `CliAdapter` already implements a single-root `PlatformAdapter` (`cwd`,
    one basename named root, and `OsCredentialStore`).
  - `src/cli.ts` and `src/mcp-server.ts` reach no `vscode` load at runtime.
  - Browser feedback (toasts, scoped replies, interactions) is complete.
- **Portable building blocks:**
  - `ServerTokenStore` works over any `SecretStore`, including
    `OsCredentialStore` and `FallbackSecretStore`.
  - `LicenseService` is host-neutral.
  - `PtyProcessManager` and `TerminalMessageHandlers` are host-neutral, so
    standalone gets the dashboard terminal.
  - `getGitTrackedFiles` (`GitUtils.ts`) already backs `/api/workflow-files`
    and the default completion file list.
- **`RUNNER_IDS.SERVER`** exists (`DashboardConstants.ts:3551`).
- **Recent workflows** come from run storage
  (`WorkflowLineageRepository.listLineageKeys()`), not from VS Code
  `globalState`.

### Still missing

**Shared prerequisites.** These are owned by the decoupling plan and
sequenced as staging Stages 1–6:

- `WebviewMessageRouter` imports `vscode` and makes 16 `executeCommand`
  calls.
- `CtrlYokeWebviewProvider` is the only composition root for the dashboard
  application.
- `CtrlYokeHostedServer` routes through the provider.
- `WorkflowSerializer`, `WebviewSettingsSync`, `PromptEditorSupportService`,
  and `CompletionHelpers` still read `vscode.workspace.workspaceFolders`.
- `CliIntegration` picks the PTY path by checking for VS Code. A standalone
  adapter would currently fall through to `stdio: inherit`.
- `ExternalRunWatchSession` and `ExecutionRootCoordinationWatchSession` call
  `createFileSystemWatcher` directly, and the Node `FileWatcherFactory` has no
  implementation yet. `chokidar` was removed as unused in `d30015831`.

**Standalone-only pieces (none exist yet):**

- No `ctrlyoke server` subcommand. Today's commands are `run`, `rerun`,
  `append`, `continue`, `validate`, `about`, three `trust-*` commands,
  `commit`, `status`, `history …`, `step …`, and `secret …`.
- No `createNodeHostServices`, no Node `KeyValueStore` implementation, and no
  `src/cli/ServerCommand.ts`.
- No static theme defaults. `src/server/themes/` doesn't exist. With no
  captured vars, the hosted server emits an empty style block, and
  `server.theme` (`auto|light|dark`) has no runtime consumer.
- No `workspaceKey` or `storageVersion` in the shim. `fpState-*` keys are
  scoped only by origin, so two workspaces served on the same port at
  different times restore each other's drafts. The React adapter is still
  named `vsCodeStateStorage.ts`.
- TLS certificate generation lives in `WebviewSettingsSync.ts:1640-1728`,
  rooted at the VS Code workspace.
- **npm packaging.** `scripts/build-npm-package.mjs`'s `NPM_PACKAGE_ENTRIES`
  doesn't include `out/server/`, `out/ui/webview-react/`, or
  `out/runtime-deps/` (needed by `PngIconService`). `esbuild.js`'s
  `copyServerPlugin` runs only for the extension bundle.
- No launch UX: no terminal URL banner, OSC 8 link, terminal QR, or TLS hint.
- The 401 error page tells users to "Open the ctrlyoke panel in VS Code".

**Corrections to older versions of this plan:**

- `server.standalonePort` **doesn't exist**. Standalone uses `server.port`
  (default 4747) and `server.fallbackPorts`, like the hosted server.
- `.ctrlyoke/.queue` and `.ctrlyoke/.history` no longer exist. Run storage is
  `WorkflowPaths.runsRoot(stateRoot)` under the user-scoped project state root.
- `fast-glob`, `ignore`, and `vscode-jsonrpc` aren't needed for standalone:
  - git already provides gitignore-aware file lists;
  - `vscode-jsonrpc ^9` is already installed for other reasons;
  - the one-off `LspSymbolClient` is superseded.

### Readiness verdict

Standalone needs no new architecture. Every remaining blocker is one of
these:

- a named decoupling stage with an exit guard;
- a small, well-specified standalone stage.

The risk is concentrated in staging Stage 6, where `DashboardApplication` is
extracted from `CtrlYokeWebviewProvider`. That stage touches every dashboard
message path, and the existing two-tab scoping tests are its safety net.

## Architecture

```text
Browser (1..N tabs, phone + laptop)
  ↕ HTTPS/HTTP: token-gated HTML, /api/*, /api/workspace-viewer/*
  ↕ WebSocket /ws?token=…&clientId=…  (MESSAGE_TYPES protocol, unchanged)
ctrlyoke server  (src/cli/ServerCommand.ts, plain Node)
  createNodeHostServices(cwd)
    CliAdapter (single root, interactiveTerminal: embedded-pty)
    NodeFileWatcherFactory (chokidar), FileKeyValueStore
    Console + HostedWebSocket feedback sinks, ServerTokenStore(OsCredentialStore)
    LicenseService, ServerCertificateService
  WorkflowOrchestrator(dependencies)
  DashboardApplication(host services, browser-only DashboardHostActions)
  CtrlYokeHostedServer(options, endpoint = DashboardApplication)
    HostedWorkspaceViewerService (one named root)
  CliIntegration + all six CLI harnesses (unchanged)
```

The VS Code-hosted server has the same lower half. The differences are that
`extension.ts` composes it, `CtrlYokeWebviewProvider` is a second transport
into the same `DashboardApplication`, and the endpoint supports
`requestThemeCapture`.

### Multi-tab model (both modes)

- One server is one `WorkflowOrchestrator`. Every tab is a separate WebSocket
  client observing the same state.
- Broadcast updates go to every client. Request/response replies stay scoped
  to the client that asked (`WebviewClientContext`).
- A tab that closes is unregistered (`disconnectClient`), which also releases
  any terminal controller it held. The orchestrator keeps running.

### The browser shim pattern

The React app talks to its host only through
`window.vscodeApi = { postMessage, getState, setState }`. `standalone-shim.js`
supplies that object over the WebSocket, so React code is host-agnostic.
Theme-var updates are applied straight to `:root` without going through
React.

## Implementation Plan

### Phases 1–3: dashboard fanout, the hosted server, and the browser shim (complete)

These phases shipped with the VS Code-hosted server. They are summarized here
because standalone reuses them as-is. Earlier revisions of this document
carried code sketches for them; the code is now the reference.

- **Phase 1, fanout.**
  - `DashboardBroadcastHub` is the single fanout point across
    `IDashboardProvider` and `IDashboardSink`.
  - The router supports scoped replies.
  - `RUNNER_IDS.SERVER` and the server message types exist (`SERVER_STARTED`,
    `SERVER_STOPPED`, `THEME_VARS_CAPTURED`, `THEME_VARS_UPDATED`,
    `CAPTURE_THEME_VARS`).
- **Phase 2, the hosted server.** `CtrlYokeHostedServer` provides:
  - `ctrlyoke.enableServer`, `ctrlyoke.disableServer`, and
    `ctrlyoke.regenerateServerToken`;
  - auto-start on `server.autoStart`;
  - `ServerSection.tsx` (URL, copy, LAN IP selector, QR, TLS cert download,
    token regeneration);
  - live theme capture from the VS Code webview, re-captured on theme change.
- **Phase 3, the shim.** `standalone-shim.js` handles per-tab state,
  reconnects, READY replay, theme vars, and the connection banner (see the
  audit above).

### Phase 4: CSS theme defaults (Stage 7b)

Standalone has no VS Code webview to capture `--vscode-*` variables from.

1. Add `src/server/themes/vscode-default-dark.css` and
   `vscode-default-light.css`. Take their values from VS Code's current
   default themes, **Dark 2026** and **Light 2026** (`2026-dark.json` and
   `2026-light.json` in the built-in `theme-defaults` extension, which
   include Dark Modern/Light Modern). Don't translate the theme JSON: a theme
   file only lists its explicit colors, and VS Code's color registry derives
   the rest.
   - **The source values are already captured.**
     [`dev/reference/vscode-css-vars-defaultdark.json`](../reference/vscode-css-vars-defaultdark.json)
     (Dark 2026) and
     [`vscode-css-vars-defaultlight.json`](../reference/vscode-css-vars-defaultlight.json)
     (Light 2026) hold the 955 computed `--vscode-*` values from a real VS Code
     1.140 webview, dumped with the dev-only `ctrlyoke.dumpCssVars` command
     (`src/dev/DevCommands.ts`). To refresh them after a VS Code theme update,
     switch theme, rerun the dump, and rename its output to the matching file.
   - Generate the two CSS files from those dumps rather than hand-copying
     values, so a refreshed dump is a one-command update. Keep every captured
     variable, matching what the hosted server serves from a live capture.
   - The dumps were taken on Windows, so `--vscode-font-family` and
     `--vscode-editor-font-family` name Segoe/Consolas. Replace them with
     cross-platform stacks during generation.
   - Set `--vscode-codicon-font-path` to the served codicon asset.
   - Named VS Code themes beyond this pair, captured from the user's own VS
     Code, are a follow-up:
     [`STANDALONE_THEME_SNAPSHOTS_PLAN.md`](../backlog/STANDALONE_THEME_SNAPSHOTS_PLAN.md).
2. **Generate the variable list rather than hand-maintaining it.** The webview
   references about 130 distinct `var(--vscode-*)` names after the Tailwind 4
   migration. A unit test collects every `var(--vscode-…)` in
   `src/ui/webview-react/**` and fails if either theme file doesn't define it.
   This replaces the hand-written variable table in older revisions, which was
   already stale.
3. **Theme selection** is decided below (Open Question 5):
   - `server.theme: "auto"` (the default) serves both files under
     `@media (prefers-color-scheme: …)`, so each client follows its own OS
     setting.
   - `"light"` and `"dark"` force one theme.
   - A `?theme=light|dark` query parameter overrides the setting per client.
   - No `Sec-CH-Prefers-Color-Scheme` header sniffing.
4. **The hosted server uses the same defaults as its fallback.** When no vars
   have been captured yet, it serves the default CSS. Captured vars
   (`buildThemeStyleBlock`) still win once they exist. This closes today's
   empty-style-block gap and gives `server.theme` its first runtime consumer.
   The body class from `resolveThemeBodyClass` follows the chosen theme.
5. Copy `src/server/themes/` in `copyServerPlugin`.

### Phase 5: Node host services (Stage 7a)

Add `src/platform/NodeHostServices.ts` with
`createNodeHostServices({ cwd, mode })`. It returns the same service set that
`extension.ts` builds for VS Code, with a Node implementation of each:

| Service                     | Node implementation                                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlatformAdapter`           | `CliAdapter`. Don't add a third adapter class. The server passes `cliExecutionMode: "headless"` for non-interactive steps and `interactiveTerminal: "embedded-pty"` (decoupling Phase 3), so interactive steps open in the dashboard terminal.                                                                              |
| `FileWatcherFactory`        | `NodeFileWatcherFactory` (chokidar, decoupling Phase 2)                                                                                                                                                                                                                                                                     |
| `KeyValueStore`             | `FileKeyValueStore`: JSON at `<projectStateRoot(cwd)>/host-state.json`, written with `writeFileAtomic`. It holds `ctrlyoke.loadedWorkflows` and the serializer's last export/browse directories, which the VS Code host keeps in `workspaceState`/`Memento`. It lives in user-scoped project state, never in the workspace. |
| `UserFeedbackSink`          | `CompositeUserFeedbackSink` of `ConsoleUserFeedbackSink` and `HostedWebSocketUserFeedbackSink`                                                                                                                                                                                                                              |
| `UserInteractionPort`       | `WebviewUserInteractionPort` over the hub. With no client connected, `canPrompt()` is false, so the existing headless fallbacks apply.                                                                                                                                                                                      |
| `DisposableRegistry`        | A simple array that is disposed on `SIGINT`/`SIGTERM`.                                                                                                                                                                                                                                                                      |
| `StatusBarSink`             | omitted                                                                                                                                                                                                                                                                                                                     |
| `isWorkspaceTrusted`        | `() => true`. The server is an explicit launch inside `cwd`, matching the CLI. Workspace secret grants and external roots keep their own approval flows.                                                                                                                                                                    |
| `DashboardHostActions`      | Browser-only: `openWorkspaceTarget` and `openContentPreview` reply so the browser opens the workspace viewer, and every optional method is absent.                                                                                                                                                                          |
| Secrets, token, and license | `OsCredentialStore` (with `FallbackSecretStore`) → `ServerTokenStore` and `LicenseService`                                                                                                                                                                                                                                  |
| Logging                     | `Log.initializeCli(<logsDir>, verbose)`, the same file log as `ctrlyoke run`                                                                                                                                                                                                                                                |

Build everything from one canonical `cwd`: no `.code-workspace` parsing and no
fabricated `vscode.WorkspaceFolder`. Construct `WorkflowOrchestrator` and
`DashboardApplication` from these services exactly as `extension.ts` does.

Process lifecycle: call `setRuntimeMode(RUNNER_IDS.SERVER)`. On
`SIGINT`/`SIGTERM`, stop the server, dispose the orchestrator (which releases
`runner.json` locks), and exit 0. A second `Ctrl+C` forces exit.

### Phase 6: one shared HTTP/WebSocket server class (Stage 7a)

Don't write a second `CtrlYokeServer` class. **Generalize
`CtrlYokeHostedServer` and use it in both hosts.**

1. Replace the 14 positional constructor parameters with one
   `HostedServerOptions` object:
   - `hub`, `endpoint: DashboardClientEndpoint`, `getOrchestrator`;
   - `port`, `fallbackPorts`, `bindAddress`, `tls`;
   - `workspaceRoot`, `namedWorkspaceRoots`, `token`;
   - `remoteAccess: { isAllowed, onBlocked }`, `runnerHostIdentity`,
     `onSiblingServerDetected`;
   - `themeDefaults`, `hostKind`.

   Both composition roots pass their own options. This also removes
   `extension.ts`'s dead `?? 3000` port fallback (the schema default is 4747).

2. `endpoint` is the decoupling plan's `DashboardClientEndpoint`.
   `requestThemeCapture` is only present in the VS Code host.
3. Make host-specific text depend on `hostKind`. The 401 page should say
   "Open the ctrlyoke panel in VS Code" (hosted) or "Use the URL printed by
   `ctrlyoke server`" (standalone).
4. **Remote access stays Pro-gated in standalone.**
   `remoteAccess.isAllowed = () => licenseService.hasRemoteAccess()`, and
   `onBlocked` prints a terminal notice and sends `USER_FEEDBACK` instead of
   the VS Code upsell modal. Loopback access is always allowed.
5. Standalone constructs `HostedWorkspaceViewerService` with one named
   `{ name: basename(cwd), path: cwd }` root.

### Phase 7: shared dashboard message router (Stages 3 and 6)

The decoupling plan's Phase 4 owns this work. Its "Dashboard host actions"
call-site table maps every current VS Code command to a direct orchestrator
call or an optional host action.

In standalone, every host-native message gets a typed `unsupported` reply, and
the browser uses its existing surface:

| Message                                   | Standalone behavior                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `RUN`/`PAUSE`/`RESUME`/`STOP`             | Direct orchestrator call (same as VS Code after Stage 3)                       |
| `SELECT_FILE`, `APPEND_FILE` without path | The browser opens `FileBrowserModal`                                           |
| `EDIT_FILE`, `OPEN_FILE`                  | `WorkspaceFileEditor` in the workspace viewer                                  |
| `OPEN_GIT_CHANGE` (legacy)                | Never sent by a browser; `openToGitRef` → `/api/workspace-viewer/git-ref-diff` |
| `VIEW_WORKTREE_DIFF`                      | `openToWorktreeDiff` → `/api/workspace-viewer/worktree-diff`                   |
| `OPEN_WORKTREE`                           | `unsupported`. Shows the path with a copy action                               |
| `MERGE_WORKTREE`                          | Direct orchestrator call (same as VS Code)                                     |
| `SHOW_OUTPUT`                             | Dashboard-local output view                                                    |
| Reveal in OS, MCP gallery, reload window  | `unsupported`. The UI hides these actions when the host doesn't advertise them |

The browser needs to know what the host supports before rendering those
actions. The INIT payload therefore gains a `hostCapabilities` list derived
from the methods present on `DashboardHostActions`. It is a single source of
truth: the browser never hard-codes host checks.

### Phase 8: prompt-editor completions (Stage 9)

1. **Files (`@`):** use the host-neutral completion core from decoupling
   Phase 6 item 4 (`git ls-files --cached --others --exclude-standard`, with
   the extracted walker outside git). There are no new dependencies.
2. **Symbols (`#`):** use `RegexSymbolIndex` from the language-intelligence
   plan's `SymbolIndex` port.
   - It scans source files by extension and caches results per file by
     `mtime`.
   - It must produce `#sym:` values with exact `startLine`/`endLine` ranges.
     For brace languages the end line comes from bracket matching; Python
     uses indentation. When no end can be found, the start line is used.
   - The LSP plan later adds `LspSymbolIndex` through the same port (staging
     Stage 16). The one-off `LspSymbolClient` from older revisions isn't
     built.
3. **Selections:** in VS Code, `#` sends a `partial` response with the
   current editor selections, and then selections plus symbols. Standalone has
   no host editor, so the selection list is always empty and the response is
   symbols only.
4. **Git refs (`~`), slash commands (`/`), secrets (`!`), and prior context
   (`$`):** these are already host-neutral, or become so in Stage 5.

### Phase 9: file watching

**Folded into decoupling Phase 2 (staging Stage 1).** That phase adds the
chokidar `NodeFileWatcherFactory` and its contract suite. Standalone only
injects it. `PromptFileWatcher`, `ExternalRunWatchSession` (formerly
`CliWatchSession`), `ExecutionRootCoordinationWatchSession`, and the
`runner.json` watcher in `ExternalRunWatchCoordinator` all go through the
factory.

### Phase 10: the `ctrlyoke server` command and launch UX (Stage 8)

Add a `server` subcommand in a new `src/cli/ServerCommandDefinitions.ts`,
following the existing `*CommandDefinitions.ts` pattern. Config resolution
goes in `src/cli/ServerCommand.ts`. Flags override `server.*` settings
(Open Question 2):

| Flag                   | Setting / behavior                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `-d, --cwd <path>`     | Workspace root. Default: `process.cwd()`                                                            |
| `-p, --port <n>`       | `server.port` (4747). `server.fallbackPorts` still apply unless `--strict-port` is given            |
| `--strict-port`        | Fail instead of falling back                                                                        |
| `--bind <addr>`        | `server.bindAddress`. Default `127.0.0.1`. Non-loopback stays subject to the Pro remote-access gate |
| `--https`/`--no-https` | `server.tls.enabled`                                                                                |
| `--cert <path>`        | `server.tls.certPath`                                                                               |
| `--key <path>`         | `server.tls.keyPath`                                                                                |
| `--theme <mode>`       | `server.theme` (`auto`, `light`, `dark`)                                                            |
| `--open`               | Open the tokenized URL in the default browser                                                       |
| `--regenerate-token`   | Rotate the persisted token before starting                                                          |
| `--verbose`            | Diagnostic file logging, as with `ctrlyoke run`                                                     |

- **Token handling** (Open Question 1):
  - `CTRLYOKE_SERVER_TOKEN` overrides the persisted token.
  - It is deliberately an **environment variable, not a flag**, because
    process arguments are visible to other local users.
- **`--https` with no cert:** `ServerCertificateService` (extracted in Stage 4)
  generates the CA-signed LAN certificate into
  `<ctrlyokeStateHome>/certs/`, just as the hosted settings flow does for user
  scope. Generation stays behind the same Pro remote-access check, because TLS
  only matters for LAN clients.
- **Startup output:**
  - the plain URL;
  - an OSC 8 hyperlink when stdout is a TTY;
  - LAN URLs when bound to `0.0.0.0`;
  - a terminal QR code (from `qrcode`, already a dependency) for the public
    URL;
  - when HTTPS is on, a hint to install the certificate from `/cert` on the
    phone.
- **`--open`:** add `open@^10` (bundled, so it adds no runtime dependency).
  Don't hand-roll this. Passing a URL with `&` in its token query through
  `cmd /c start` on Windows is a known trap.
- **Packaging:**
  - Add `out/server/`, `out/ui/webview-react/`, and `out/runtime-deps/` to
    `NPM_PACKAGE_ENTRIES` and the packaging test.
  - Make the server-asset copy part of the CLI build.
  - Add a `"server": "node out/cli.js server"` convenience script.
  - Document the command in `docs/cli/ctrlyoke.md`.
- **Guard root:** add `src/cli/ServerCommand.ts` to
  `src/test/unit/SourceAuditCounters.test.ts` as a root that must reach no
  `vscode` load, next to the existing `cli.ts`, `mcp-server.ts`,
  `DashboardApplication.ts`, and `CtrlYokeHostedServer.ts` roots. (Moved here
  from the decoupling plan's Phase 7 item 4 when that plan was closed.)

### Phase 11: retire the Node-side shim (Stage 10)

Moved here from the decoupling plan's Phase 8 when that plan was closed on
2026-10-06. Its Track A work is done, so this is the only decoupling work
left, and it depends on `server` shipping first.

1. Verify `ctrlyoke run`, `validate`, `commit`, `history`, `status`, `step`,
   `secret`, and `server` with the real Node module graph. The CLI/MCP static
   guard already passes.
2. Remove `registerCliAdapter()`/`unregisterCliAdapter()` and their two
   callers in `cli.ts` (`:911` and `:2339` on 2026-10-06). The only remaining
   reader is the shim's own `getConfiguration`.
3. Remove the `vscode` → `src/platform/vscode-shim.ts` alias from **all four**
   Node bundles in `esbuild.js`: `cli`, `mcp-server`,
   `historySearchRebuildWorker`, and `historySearchMatcherWorker`.
4. Delete `vscode-shim.ts`.
5. Fail the build if any Node bundle's metafile contains the `vscode` package,
   `@vscode/extension-telemetry`, or a `src/platform/VsCode*` file.

The browser-side `standalone-shim.js` remains. It replaces
`acquireVsCodeApi()` in the browser and is unrelated to the Node-side
`vscode-shim.ts`.

## File Structure (new or changed)

```text
src/cli/ServerCommandDefinitions.ts   NEW: Commander definition for `server`
src/cli/ServerCommand.ts              NEW: config resolution, lifecycle, launch banner
src/platform/NodeHostServices.ts      NEW: createNodeHostServices(cwd)
src/platform/NodeFileWatcher.ts       NEW (decoupling Stage 1): chokidar factory
src/platform/FileKeyValueStore.ts     NEW: JSON KeyValueStore under project state
src/server/ServerCertificateService.ts NEW (Stage 4): extracted from WebviewSettingsSync
src/server/themes/vscode-default-{dark,light}.css  NEW
src/server/CtrlYokeHostedServer.ts    CHANGED: options object + DashboardClientEndpoint
src/server/standalone-shim.js         CHANGED: workspaceKey + storageVersion
src/ui/DashboardApplication.ts        NEW (decoupling Stage 6)
src/ui/webview-react/utils/webviewStateStorage.ts  RENAMED from vsCodeStateStorage.ts
src/completions/RegexSymbolIndex.ts   NEW (Stage 9)
scripts/build-npm-package.mjs, esbuild.js  CHANGED: ship server + webview assets
```

## Build Changes

- **No new bundle target.** `ctrlyoke server` lives in the existing `cli.js`
  bundle and npm `bin`.
- **New bundled dependencies:** `chokidar@^5` (decoupling Stage 1) and
  `open@^10`. Both are bundled by esbuild, so the npm package keeps zero
  runtime dependencies. `express`, `ws`, `qrcode`, and `selfsigned` are
  already present. No `fast-glob` or `ignore`.
- **Server asset copying.** Today `copyServerPlugin` runs only on the
  extension context. Make the CLI build copy the same server assets plus
  `themes/`. The webview build output is already shared under `out/`.
- **The Node-side `vscode-shim.ts` alias** is retired in Stage 10 (Phase 11
  below), after `server` ships. The browser `standalone-shim.js` remains.

## Message Protocol Compatibility

The protocol (`MESSAGE_TYPES`, `WebviewMessageTypes`) is unchanged at the
payload level. The only addition is the `hostCapabilities` list in the INIT
payload (Phase 7). Both server modes keep the existing distinction between:

- **broadcast state updates** (workflow summaries, step progress, CLI output,
  active-workflow changes), and
- **client-scoped replies** (completions, validation, typed failures, and
  other request/response messages).

## Security Considerations

- **Localhost by default.** Bind to `127.0.0.1`, and require an explicit
  `--bind`/`server.bindAddress` to listen on the LAN. Non-loopback clients go
  through the same Pro remote-access gate as the hosted server.
- **Token.** It is required for HTML, APIs, and the WebSocket upgrade, using
  the same middleware and timing-safe check as the hosted server.
  - It is persisted per machine in the OS credential store.
  - It is rotated with `--regenerate-token`.
  - `CTRLYOKE_SERVER_TOKEN` overrides it.
  - It never goes in browser storage.
- **Launch output is part of the security UX.** Printing the tokenized URL,
  the OSC 8 link, and a QR code means phone users never have to type the
  secret.
- **The existing hosted hardening applies unchanged:**
  - upgrade-time authentication;
  - no JSON body parsing for requests without a valid token;
  - secret redaction middleware;
  - icon-color validation before HTML injection;
  - workspace-root containment in `HostedWorkspaceViewerService`.
- **CSP:** serve the shim as a static file (no `'unsafe-inline'`). The hosted
  server's existing policy applies.

## Harness Compatibility

All six harnesses in `HARNESS_IDS` (`copilot-cli`, `claude-cli`, `codex-cli`,
`opencode-cli`, `qwen-cli`, `antigravity-cli`) spawn processes and have no
VS Code dependency. Interactive steps attach to the dashboard terminal through
`PtyProcessManager` once `interactiveTerminal` is explicit (decoupling
Phase 3). No harness allowlist or startup rejection is needed.

## State Persistence

| State                                                | VS Code panel / hosted                                                                         | Standalone                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Zustand UI state, prompt-editor state, `fileDrafts`  | webview state / shim `localStorage`                                                            | shim `localStorage`, scoped by `workspaceKey`               |
| Live workflow and orchestrator state                 | orchestrator memory and run storage                                                            | same                                                        |
| Run history and recent workflows                     | `runsRoot(stateRoot)` lineages                                                                 | same                                                        |
| Loaded-workflow list, last export/browse directories | `workspaceState` (`Memento`)                                                                   | `FileKeyValueStore` at `<projectStateRoot>/host-state.json` |
| Server token and TLS material                        | VS Code secret storage; `~/.ctrlyoke/certs` or `<workspace>/.ctrlyoke/certs` by settings scope | OS credential store; `<ctrlyokeStateHome>/certs`            |

Implementation requirements (Stage 7b):

1. Rename `src/ui/webview-react/utils/vsCodeStateStorage.ts` to
   `webviewStateStorage.ts` and export `webviewRawStorage`. Update `uiStore.ts`
   and `workspaceViewerStore.ts`.
2. Have the server inject `workspaceKey = projectKey(stateRoot)`
   (`ProjectStatePaths.ts`, `<slug>-<hash12>`). It is non-secret and stable.
   Inject it through the existing `__CTRLYOKE_HOSTED_CONNECTION_CONFIG__`
   placeholder.
   - The shim's keys become `fpState-<workspaceKey>-<tabId>` and
     `fpState-<workspaceKey>-last`.
   - The tab-ID keys are scoped the same way.
   - The hosted server injects the same key, so this fixes the collision
     problem for both modes.
3. Add `storageVersion: 1` to the persisted root object. When the version
   doesn't match, start clean rather than migrating.
4. Tests: `uiStore`, `editorStore`, and `workspaceViewerStore.fileDrafts`
   round-trip through the shim, and two different `workspaceKey`s on one
   origin don't collide.

## Manual Verification (Stage 11)

Run this on Windows and on one of Linux or macOS, from the **packed npm
artifact**:

- Launch `ctrlyoke server`. Check the banner URL, the OSC 8 link, the QR code,
  and `--open`.
- Open a desktop browser and a phone. Check token rejection without `?token=`
  and the remote-access gate on a LAN bind.
- Run with `--https`: certificate install on the phone and the reconnect
  banner.
- Run parallel workflows, the switcher, history, and an interactive step in
  the dashboard terminal.
- Check watch mode and an external run's live updates (chokidar).
- Check `@`/`#`/`~`/`/` completions.
- Check workspace-viewer edit, save, and conflict (Stage I1), plus git
  stage/commit/push.
- Check that unsaved drafts survive closing and reopening the tab, and don't
  leak between two workspaces served on the same port.
- Check that `Ctrl+C` exits cleanly with no stale `runner.json`.

## Open Questions (all resolved 2026-10-06)

1. **Token persistence.** **Decided:** persisted, through `ServerTokenStore`
   over `OsCredentialStore`, the same class the hosted server uses over VS Code
   secret storage. Phone bookmarks and scanned QR codes keep working across
   restarts. `--regenerate-token` rotates it. `CTRLYOKE_SERVER_TOKEN`
   overrides it for CI and scripted use. It is an environment variable rather
   than `--token` because process arguments are visible to other local users.
   No separate ephemeral mode: the env override covers it.
2. **CLI surface.** **Decided:** see the Phase 10 flag table. The flags map
   1:1 onto `server.*` settings, plus `--cwd`, `--open`, `--strict-port`,
   `--regenerate-token`, and `--verbose`. Older sketches had
   `--harness/--model/--allow-tool` flags; these are dropped. The server isn't
   a run, and workflows carry their own harness configuration.
3. **File picker enhancements.** **Decided: out of scope** for standalone v1.
   `FileBrowserModal` already works in the hosted server. Typed paths, search,
   and drag-and-drop are general dashboard improvements, to be filed in
   `QUICK_PICKER_IMPROVEMENTS_PLAN.md` if wanted.
4. **Recent workflow history storage.** **Moot.** Recent workflows already
   come from run-storage lineages in every host. The only host state left
   (`ctrlyoke.loadedWorkflows` and the serializer's last directories) goes in
   `FileKeyValueStore` (Phase 5).
5. **Theme model.** **Decided:** per client, following each browser's
   `prefers-color-scheme` under the default `server.theme: "auto"`. The
   setting or `--theme` forces one theme, and `?theme=` overrides per client.
   The hosted server falls back to the same defaults until it has captured
   vars (Phase 4).
6. **Browser storage scope.** **Decided:** `workspaceKey = projectKey(stateRoot)`.
   It doesn't include the port or server identity. The same workspace should
   restore the same drafts whatever port it lands on, and the origin already
   separates different ports. It applies to the hosted server too (State
   Persistence).
7. **Unsaved draft conflicts between tabs.** **Decided:** drafts are already
   per-tab (`fpState-<…>-<tabId>`), so tabs never overwrite each other's
   drafts. The real conflict is at save time. That is handled by the language
   intelligence plan's Phase 0: `modifiedAt`/`baseModifiedAt`, 409 on a stale
   save, and a reload/compare banner. It is staged as independent Stage I1
   and required before the standalone release. No `storage`-event listener.
