# Standalone ctrlyoke Server Plan

**Status (updated 2026-07-29):** VS Code-hosted server is **shipped**. Standalone
`ctrlyoke server` is **not started** (Phases 5–10 unimplemented) and is **deferred out of
v0.1.0** — see [`RELEASE_PLAN.md`](../active/RELEASE_PLAN.md) §2.11. The inert `server.standalonePort` UI row
has been removed from `ServerSection.tsx`; the type/schema/default (`4748`) are retained so
standalone can re-surface the port from its own CLI surface later with no config migration.
This document is the standalone implementation backlog for after v0.1.0.

The shared prerequisites are now specified in two focused plans:

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
  is the exhaustive `vscode` audit and the authoritative plan for composition,
  watchers, shared routing, services, utilities, and retiring the Node-side shim.
- [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md) covers
  hosted/standalone operational toast and interaction parity.

Where older sketches in this document propose a duplicate standalone router or
rely on `vscode-shim.ts`, the focused decoupling plan supersedes them.

## Overview

Expose the existing `src/ui/webview-react/` React dashboard as a browser-accessible web app. Two delivery modes are planned, both built on a shared `IDashboardProvider` interface:

1. **VS Code-Hosted Server** — an HTTP/WebSocket server started _inside_ the running VS Code extension process via an "Enable Server" button in the webview. The live `WorkflowOrchestrator` instance is the server backend. Browser tabs connect as additional clients alongside the existing VS Code sidebar panel. The process can still use VS Code services, while browser-facing interactions branch to visible web surfaces where a native window would appear only on the host machine.

2. **Standalone Server** (`ctrlyoke server` CLI subcommand) — a fully independent Node.js process with no VS Code dependency. Useful for headless/CI scenarios and remote access where VS Code is not running. VS Code-native dialogs/editors are replaced by browser surfaces such as `FileBrowserModal` and `WorkspaceFileEditor`. All six harnesses are CLI-based, so every harness remains usable in the standalone server.

`IDashboardProvider` and the hosted browser transport are already implemented in the current codebase. The remaining work is now almost entirely on the standalone side: removing the last VS Code-only seams from orchestration, adding the `ctrlyoke server` CLI subcommand, and reusing the hosted server's token/TLS/browser shim behavior in a plain Node.js process.

## Mode Comparison

| Feature                    | `ctrlyoke run` (CLI) | VS Code-Hosted Server | `ctrlyoke server` (standalone) | VS Code Extension |
| -------------------------- | -------------------- | --------------------- | ------------------------------ | ----------------- |
| Parallel workflows         | No — single run      | **Yes**               | **Yes**                        | **Yes**           |
| Full dashboard webview     | No — terminal output | **Yes**               | **Yes**                        | **Yes**           |
| Workflow switcher dropdown | No                   | **Yes**               | **Yes**                        | **Yes**           |
| Run history                | No                   | **Yes**               | **Yes**                        | **Yes**           |
| File/directory selection   | No                   | Web modal             | Web modal                      | Native dialog     |
| Requires VS Code open      | No                   | **Yes**               | No                             | Yes               |
| Headless / CI use          | Yes                  | No                    | **Yes**                        | No                |

## Goals

- Finish the shared dashboard transport seam (`IDashboardProvider` + `IDashboardSink`) so one orchestrator can drive the VS Code panel and browser clients simultaneously
- Serve the existing React webview at `http://localhost:<port>` in any browser with minimal React code changes; browser-mode storage must be explicitly abstracted away from VS Code webview state APIs
- Full feature parity with the VS Code dashboard (parallel workflows, switcher, history, all message types)
- Replace VS Code-specific host APIs with injected Node/browser capabilities;
  keep `standalone-shim.js` only as the browser transport/state replacement for
  `acquireVsCodeApi()`
- Reuse `WorkflowOrchestrator` directly in both modes — no parallel orchestration logic
- Support light and dark themes out of the box

## Non-Goals

- Real-time multi-user collaboration (each server instance = one workspace)
- Remote workflow execution beyond what the CLI already supports
- A full VS Code extension replacement

## Current Codebase Audit (updated 2026-07-05)

### Already in place

- `src/ui/IDashboardProvider.ts`, `src/types/IDashboardSink.ts`, and `src/ui/DashboardBroadcastHub.ts` are in place and already driving multi-client fanout.
- `src/core/WorkflowOrchestrator.ts` and `src/core/WorkflowInstance.ts` already publish through the shared dashboard hub instead of treating the VS Code webview as a special sink.
- `src/server/CtrlYokeHostedServer.ts` is implemented (now ~1,500 lines) and already serves the Vite webview bundle over HTTP plus WebSocket, with token-gated HTML/API access (`requireToken` middleware), TLS support (`https.createServer` via an optional `tlsConfig`), a configurable `bindAddress`, and browser push-notification plumbing (`WebPushService`).
- `src/server/standalone-shim.js` is implemented and already handles per-tab state, reconnects, READY replay, theme var application, and pre-React message buffering.
- `src/ui/CtrlYokeWebviewProvider.ts` already exposes `routeExternalMessage(...)` and browser-client registration hooks, so hosted browser clients reuse the existing router instead of needing a separate hosted-server router class.
- `src/extension.ts` already registers `ctrlyoke.enableServer`, `ctrlyoke.disableServer`, and `ctrlyoke.regenerateServerToken`, auto-starts the hosted server when `server.enabled` is true, and forwards theme recapture events on color-theme changes.
- `DashboardConstants.ts`, `useMessageHandler.ts`, `settingsStore.ts`, and `ServerSection.tsx` already handle `SERVER_STARTED`, `SERVER_STOPPED`, theme capture messages, token regeneration, available LAN IPs, TLS certificate download, and browser-side QR display.
- `CtrlYokeConfigService` + file-backed config are already in place, and `CtrlYokeSettings` already includes `server.port`, `server.standalonePort`, `server.bindAddress`, `server.theme`, and `server.tls`.
- `express`, `ws`, `qrcode`, `selfsigned`, and the server static-file copy step in `esbuild.js` are already present in the repo, so the hosted-server runtime plumbing is no longer theoretical.
- **`src/server/HostedWorkspaceViewerService.ts` is a fully vscode-free workspace-viewer backend.** Its constructor takes project-owned named roots (no `vscode.ExtensionContext` or adapter) and it implements file tree listing, file read/write, copy/move, git status, file diff, stage/unstage/discard, commit/push/pull, commit log (`getCommitLog`), and git-ref diffs (`getGitRefDiff`). `CtrlYokeHostedServer.ts` mounts all of this behind token-gated `/api/workspace-viewer/*` routes (`tree`, `file`, `entry`, `copy`, `move`, `status`, `diff`, `git-ref-diff`, `commit-log`, `stage`, `unstage`, `discard`, `commit`, `push`, `pull`, …). The standalone server can pass one basename/`cwd` named root and reuse the service without implementing VS Code multi-root discovery.
- **`OPEN_GIT_CHANGE` is now marked legacy** in `DashboardConstants.ts`. The browser path for viewing a commit/ref diff (`~<hash>` references, commit history "View Diff") goes through `workspaceViewerStore.openToGitRef()` → `GET /api/workspace-viewer/git-ref-diff` → `HostedWorkspaceViewerService.getGitRefDiff()`, which is vscode-free end-to-end. Only the VS Code-native diff editor path still uses `OPEN_GIT_CHANGE` → `ctrlyoke.openGitChange`.
- **`src/completions/ContextReferenceBuilder.ts` is now fully vscode-free.** The one vscode-dependent helper (`toWorkspaceRelativeReferencePath`, used only by `ContextMenuReferenceCommands.ts`) was split into `src/completions/WorkspaceReferencePaths.ts`. The `@`/`#`/`~` reference-syntax builders (including `buildGitReference()`) are reusable as-is by any future standalone completion/router code.

### Still missing before implementation

**VS Code-hosted server (Phases 2–4):**

- Implemented. The hosted browser server, shim, tokenized URL flow, TLS support, theme forwarding, and webview/store wiring are already working in the extension.
- `HostedServerRouter.ts` is no longer needed as a separate concept; `CtrlYokeWebviewProvider.routeExternalMessage(...)` is the routing seam.
- The remaining work in this document should be treated as **standalone-server implementation**, not hosted-server implementation.

**Standalone server (Phases 5–10) — verified against `src/` on 2026-07-29:**

_Orchestration seams (Track 1 — shared prerequisites, still all open):_

- `WorkflowOrchestrator` still constructs `new VsCodeAdapter(...)` internally at
  **5 sites** (integration factory, parser, session manager, command evaluator,
  and `WorkflowInstance`). Its constructor takes `vscode.ExtensionContext` and
  it also constructs the VS Code status-bar and command helpers. Standalone
  reuse requires a full injected host-services/options object, not another
  standalone-only constructor.
- There are **5 direct `vscode.workspace.createFileSystemWatcher()` calls** in
  reusable orchestration paths: `CliWatchSession` ×3, `PromptFileWatcher` ×1,
  and the orchestrator's `runner.json` watcher ×1. They must use a
  project-owned watcher factory accepting `(basePath, glob)` and emitting string
  paths.
- The broader AST audit found **39 production files importing `vscode`**, with
  **33 files** directly accessing `vscode.window`/`vscode.workspace` (248 member
  accesses). This includes shared router, serializer, settings, completion,
  discovery, logging, and template paths that the earlier audit did not cover.
  See `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` for the exhaustive disposition.
- There are **116 native `showErrorMessage`/`showWarningMessage`/
  `showInformationMessage` calls**. Sixty-three are in reusable/shared code and
  currently leave hosted-browser users without equivalent feedback. See
  `BROWSER_USER_FEEDBACK_PLAN.md`.
- **Plus 19 adapter-mediated host-UI calls** that no `vscode`-import audit can
  see: `PlatformAdapter.log/warn/error/showProgress/showChoice` in
  `WorkflowInstance` ×9, `WorkflowExecutor` ×3, `PromptFileParser` ×3,
  `EndConditionHandler` ×2, and `CliIntegration` ×2. The two
  `EndConditionHandler.showChoice()` sites **block workflow execution** on a
  modal that renders only on the host machine, so a browser-driven run stalls
  with no visible cause. This is the sharpest hosted-parity defect that exists
  today and it is not a standalone-only problem.

_Standalone-only pieces (Track 3, none exist yet):_

- `src/cli.ts` exposes only `run`, `validate`, and `commit` — there is still **no `ctrlyoke server`
  subcommand**.
- `StandaloneServerAdapter`, `CtrlYokeServer`, `CompletionService`,
  `ServerFileWatcher`, and `LspSymbolClient` **do not exist** (`src/server/` contains only the
  hosted server + its helpers: `CtrlYokeHostedServer`, `HostedWorkspaceViewerService`,
  `HostedServerMessageFactory`, `HostedServiceWorkerScript`, `WebPushService`, `PngIconService`,
  `RuntimeDependencyPaths`).
- Phase 4 theme CSS (`src/server/themes/vscode-default-{dark,light}.css`) **does not exist**.
  The hosted server never needed it (it captures live `--vscode-*` vars from the VS Code webview
  and injects them); standalone has no webview to capture from, so static theme defaults are a
  genuine standalone-only gap.
- `fast-glob`, `ignore`, `vscode-jsonrpc`, and `open` are **not installed** (verified against
  `package.json`). `chokidar@^5`, `express@^5`, `ws@^8`, `qrcode@^1.5`, and `selfsigned@^5` **are**
  present. `fast-glob` + `ignore` are needed for completions (Phase 8); `open` for `--open`
  (Phase 10); `vscode-jsonrpc` only if the optional LSP symbol client ships.
- `src/server/standalone-shim.js` already backs `getState()` / `setState()` with
  per-tab `localStorage` keys plus a last-state recovery fallback; drafts do not
  rely on `sessionStorage`. The React adapter is still named
  `vsCodeStateStorage.ts`, and explicit workspace/storage-version scoping plus
  focused persistence tests remain open.
- Standalone launch UX does not exist: no terminal URL banner, OSC-8 clickable link, terminal QR
  code, or token-persistence story outside VS Code secret storage.

### Readiness verdict

- **VS Code-hosted server:** shipped; treat it as the reference implementation for standalone.
- **Standalone server (Phases 5–10): not started.** The load-bearing blockers are
  in Track 1 (shared foundation): host composition in `WorkflowOrchestrator`,
  the five direct watcher sites, VS Code dependencies in the shared dashboard
  router/services, and the absence of a CLI/server entrypoint. The workspace-viewer feature set (file browser, git
  status/diff/stage/commit/push/pull, commit history, git-ref diffs) is already a vscode-free
  service (`HostedWorkspaceViewerService`, constructed from project-owned named
  roots) that Phase 6/7 can reuse. Net: meaningful but bounded — risk
  concentrates in host composition and shared-router/service decoupling, which
  touch live execution and every dashboard command.

### Next Steps (post-v0.1.0, in dependency order)

> The authoritative cross-plan sequence is the **Cross-Plan Execution Order**
> table in
> [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md).
> The list below is the standalone-oriented view of that same order.

Do these roughly in order; steps 1–3 are the shared foundation and unblock everything else.

1. **Add dependency guards and host composition.** Follow
   `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`: make `WorkflowOrchestrator` accept a
   project-owned dependency/options object, construct `VsCodeAdapter` only in
   `extension.ts`, inject status/lifecycle capabilities, and remove all five
   internal adapter constructions. Do not keep a context-based default.
2. **Watcher seam.** Introduce a narrow watcher factory and route the five
   reusable call sites through it: `CliWatchSession` ×3,
   `PromptFileWatcher` ×1, and the orchestrator runner watcher ×1. Design it
   around `(basePath, glob)`, not `vscode.RelativePattern`.
3. **Shared router/services off VS Code.** Inject workspace context, feedback,
   host actions, filesystem/state services, and direct orchestrator commands
   into the existing router and its delegates. Reuse that router for WebSocket
   clients; do not create a duplicate `WebSocketMessageRouter`.
4. **Browser user feedback.** Land the visible toast queue and operational
   feedback protocol from `BROWSER_USER_FEEDBACK_PLAN.md`. This fixes the
   existing hosted-browser gap and supplies the standalone feedback sink. It
   also narrows `PlatformAdapter`, which step 5 depends on to compile, and
   resolves the execution-blocking `showChoice` sites — so it is a hard
   prerequisite for step 5, not a parallel nicety.
5. **Install standalone deps & add the entrypoint:** `fast-glob`, `ignore`, `open` (and
   `vscode-jsonrpc` only if the LSP symbol client ships). Then build the standalone pieces
   modeled on `CtrlYokeHostedServer` — Node host services/adapter (Phase 5),
   `CtrlYokeServer` (Phase 6), shared message-router composition (Phase 7),
   `CompletionService` (Phase 8), and `ServerFileWatcher` (Phase 9).
6. **Standalone-only rendering/storage gaps:** author `src/server/themes/vscode-default-{dark,light}.css`
   (Phase 4 — no VS Code webview to capture live vars from) and rename/wrap
   `vsCodeStateStorage.ts` as platform-neutral `webviewStateStorage`; retain the
   shim's existing `localStorage` behavior and decide whether canonical-root
   scoping/versioning is needed beyond its per-origin/per-tab keys.
7. **`ctrlyoke server` CLI command + launch UX** (Phase 10): `program.command("server")` +
   `resolveServerConfig()`, tokenized local/LAN URL banner, OSC-8 clickable link, terminal QR
   (reuse `qrcode`), and an HTTPS cert hint. Resolve the token-persistence model (Open Question 1)
   before shipping.
8. **Retire the Node-side shim.** Remove the CLI esbuild alias and
   `vscode-shim.ts` after `run`, `validate`, `commit`, and `server` all use the
   Node-only graph. Keep browser `standalone-shim.js`.
9. **Manual verification** per the Implementation Order Track 3 list: npm-installed CLI launch,
   browser + phone clients, token gating, reconnects, TLS, parallel workflows, watch mode,
   completions, and unsaved workspace-viewer draft recovery across tab close/reopen.

### Standalone CLI UX Requirements

- `ctrlyoke server` must ship as a subcommand of the existing npm CLI binary (`bin.ctrlyoke -> out/cli.js`), not as a second executable.
- The command should default from config where possible: `server.standalonePort`, `server.bindAddress`, `server.tls`, and standalone theme choice.
- It should accept CLI overrides for the server settings that make sense outside VS Code: at minimum port, bind address, TLS enablement/cert/key paths, optional auto-open, and explicit token behavior.
- On successful startup it should print:
  - a plain URL
  - a clickable terminal hyperlink when stdout is a TTY that supports OSC 8
  - LAN URLs when bound to `0.0.0.0`
  - a terminal QR code for the selected public URL
  - a certificate-install hint when HTTPS is enabled for phone access
- Token-based access should be preserved in standalone mode. The hosted server's current pattern is the baseline: token required for HTML, API, and WebSocket access; standalone should reuse the same request-validation rules rather than inventing a second auth flow.

---

## Architecture

### VS Code-Hosted Server

```
VS Code Extension Process (running normally)
  ├── CtrlYokeWebviewProvider  — existing VS Code sidebar panel
  ├── WorkflowOrchestrator       — already running, manages all workflows
  │     └── notifyX() → Dashboard broadcast hub (Phase 1 target state)
  ├── CtrlYokeWebviewProvider  — implements IDashboardProvider (VS Code panel)
  └── CtrlYokeHostedServer     — NEW: implements IDashboardProvider (HTTP + WS)
        ├── HTTP: serves React app assets (same Vite bundle)
        └── WS: browser tabs connect here, receive same orchestrator events
```

After Phase 1, the orchestrator and workflow instances publish through the shared broadcast hub so the VS Code panel and hosted browser tabs see identical live state.

Since `CtrlYokeHostedServer` runs inside the extension process, host actions may
still delegate to VS Code where that behavior is meaningful. Browser-originated
selection, editor navigation, feedback, and confirmations must use browser
surfaces or scoped protocol replies rather than opening an invisible native
window on the host machine.

### Standalone Server

```
Browser (1..N tabs)
  ↕ HTTP (React app assets)
  ↕ WebSocket (bidirectional, same MESSAGE_TYPES protocol as VS Code)
Standalone ctrlyoke Server (Node.js — no VS Code)
  ├── CtrlYokeServer        — HTTP + WS, connection registry, broadcast
  ├── StandaloneServerAdapter — PlatformAdapter impl (modeled on CliAdapter)
  ├── WorkflowOrchestrator    — reused after host-capability injection
  └── CliIntegration + CLI harnesses (copilot-cli, claude-cli, codex-cli — unchanged)
```

### Multi-tab Model (both modes)

One server instance = one `WorkflowOrchestrator` managing all parallel workflows. Multiple browser tabs connect as separate WebSocket clients but observe the **same orchestrator state**. When any orchestrator event fires (workflow added, step advance, state change), the server broadcasts to **all connected tabs**.

This mirrors VS Code behavior: opening the ctrlyoke sidebar in multiple panels shows the same state.

### Key Insight: The Shim Pattern

The React app communicates with VS Code through a single narrow interface:

```typescript
// Set once before React loads
window.vscodeApi = acquireVsCodeApi();
// Returns: { postMessage(msg), getState(), setState(state) }
```

By injecting a **WebSocket shim** in place of `acquireVsCodeApi()`, the entire contract is satisfied without touching a single React file. The existing `useMessageHandler` hook already listens on `window.addEventListener('message', ...)` — the shim reuses this via `dispatchEvent(new MessageEvent(...))`.

### Existing Patterns Reused

| Pattern                                                    | Where It Exists                                                                    | How Server Uses It                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDashboardProvider` interface                             | `src/ui/IDashboardProvider.ts`                                                     | Already present; both server implementations plug into this surface                                                                                                                                                                    |
| `IDashboardSink` interface                                 | `src/types/IDashboardSink.ts`                                                      | Existing live step/output sink; needs a broadcast-capable implementation before hosted tabs can mirror the sidebar                                                                                                                     |
| `WorkflowOrchestrator` registry                            | `src/core/WorkflowOrchestrator.ts`                                                 | Shared provider/sink fanout is already in place; the remaining issue is adapter/watcher construction for non-VS Code runtime                                                                                                           |
| `WebviewMessageRouter`                                     | `src/ui/WebviewMessageRouter.ts`                                                   | Hosted clients already enter through a callable, client-scoped route; inject host actions and reuse the same router in standalone                                                                                                      |
| `PlatformAdapter` interface                                | `src/platform/PlatformAdapter.ts`                                                  | Node host composition can reuse `CliAdapter` behavior for one root, while watcher/feedback/document actions stay in narrow capability ports                                                                                            |
| Node-side `vscode-shim` alias                              | `esbuild.js` CLI bundle                                                            | Temporary compatibility only; standalone exit criteria require removing this alias. Browser `standalone-shim.js` is separate and remains.                                                                                              |
| Commander.js subcommands                                   | `src/cli.ts`                                                                       | `run`, `validate`, and `commit` exist today; `server` still needs to be added as a subcommand                                                                                                                                          |
| `setRuntimeMode`                                           | `src/cli.ts` line 27                                                               | Standalone server calls `setRuntimeMode(RUNNER_IDS.SERVER)` — `RUNNER_IDS.SERVER` already exists in `DashboardConstants.ts`                                                                                                            |
| `HostedWorkspaceViewerService` + `/api/workspace-viewer/*` | `src/server/HostedWorkspaceViewerService.ts`, `src/server/CtrlYokeHostedServer.ts` | Already vscode-free and constructed from project-owned named roots; standalone supplies one basename/`cwd` root and reuses the service/routes for file tree, git status/diff/stage/commit/push/pull, commit history, and git-ref diffs |

---

## VS Code Dependencies Inventory

The exhaustive 2026-07-29 inventory and per-file disposition live in
[`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md).
The tables below are only the standalone-oriented summary.

### Structural VS Code Dependencies (not used by server)

| File                                              | Why Irrelevant                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/extension.ts`                                | Extension activation — not used by server                                                       |
| `src/ui/StatusBarManager.ts`                      | VS Code status bar — no equivalent needed                                                       |
| `src/completions/PromptCompletionProvider.ts`     | VS Code IntelliSense in text editor                                                             |
| `src/completions/PromptLinkProvider.ts`           | VS Code document links — CodeMirror has its own                                                 |
| `src/completions/ContextMenuReferenceCommands.ts` | Explorer/SCM/Timeline right-click commands — no equivalent UI surface in a browser-only server  |
| `src/completions/WorkspaceReferencePaths.ts`      | `toWorkspaceRelativeReferencePath()` — only consumer is `ContextMenuReferenceCommands.ts` above |

### VS Code Dependencies Requiring Server Equivalents

| File                                          | VS Code API Used                                                                               | Server Approach                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/ui/CtrlYokeWebviewProvider.ts`           | `vscode.WebviewView`, `webview.postMessage()`, `notifyX()` methods                             | Replaced by `CtrlYokeServer` + WebSocket broadcast                                                        |
| `src/core/WorkflowOrchestrator.ts`            | `vscode.ExtensionContext`, five internal `VsCodeAdapter` constructions, status/command helpers | Accept injected host services only; keep VS Code construction in `extension.ts`                           |
| `src/ui/WebviewMessageRouter.ts`              | VS Code command execution, workspace reads, and native content-preview opening                 | Inject host actions and direct orchestration services; reuse this same client-scoped router in standalone |
| `src/ui/WebviewSettingsSync.ts`               | `vscode.workspace.workspaceFolders`, command execution, native folder dialog                   | Inject workspace context/host actions; browser selection remains in `FileBrowserModal`                    |
| `src/utils/ConfigurationUtils.ts`             | `vscode.workspace.getConfiguration()`                                                          | **Done** — now reads from `CtrlYokeConfigService` (file-based config). No VS Code dependency remaining.   |
| `src/core/orchestration/PromptFileWatcher.ts` | `vscode.workspace.createFileSystemWatcher()`                                                   | `chokidar` (already in dependencies)                                                                      |
| `src/core/orchestration/CliWatchSession.ts`   | `vscode.workspace.createFileSystemWatcher()` ×3                                                | Inject the project watcher factory                                                                        |
| `src/core/WorkflowOrchestrator.ts` (watcher)  | `vscode.workspace.createFileSystemWatcher()` for `runner.json`                                 | Route through the watcher factory; accept a plain base-path/glob pair                                     |
| `src/completions/CompletionHelpers.ts`        | `vscode.workspace.findFiles()`, Git extension                                                  | Node.js `fs` + `fast-glob` + `ignore`                                                                     |

### Already Platform-Agnostic (zero or minimal changes)

- `src/core/PromptQueue.ts` / `WorkflowExecutor.ts`
- `src/core/PromptFileParser.ts` / `EndConditionEvaluator.ts`
- `src/core/harness/CliIntegration.ts` + all CLI harnesses
- `src/ui/webview-react/**` — React components and most stores are reusable, but the browser storage backend must not assume VS Code's `getState()` / `setState()` semantics
- `src/types/**` — MESSAGE_TYPES, EXECUTION_STATES, WorkflowSummary, etc.
- `src/completions/ContextReferenceBuilder.ts` — pure `@`/`#`/`~` reference-syntax builders, fully vscode-free as of the `WorkspaceReferencePaths.ts` split
- `src/server/HostedWorkspaceViewerService.ts` — vscode-free workspace-viewer backend (file tree, git status/diff/stage/commit/push/pull, commit history, git-ref diffs); already powers the hosted server's `/api/workspace-viewer/*` routes and is reusable verbatim for standalone

---

## Implementation Plan

### Phase 1 — Finish Shared Dashboard Fanout (completed for hosted-server work)

**Completed**

- `src/ui/IDashboardProvider.ts` already exists.
- `CtrlYokeWebviewProvider` already `implements IDashboardProvider`.
- `DashboardBroadcastHub` now single-sources fanout across `IDashboardProvider` + `IDashboardSink`.
- `WorkflowOrchestrator` now publishes registry/CLI-watch updates through the hub and passes the hub into `WorkflowInstance` as the dashboard sink.
- `src/types/IDashboardSink.ts` already exists for the finer-grained `WorkflowInstance` update surface.
- `WebviewMessageRouter` now supports scoped reply callbacks so targeted bootstrap/request-response traffic can stay client-local.
- `CtrlYokeWebviewProvider.routeExternalMessage(...)` now exposes the hosted-server routing seam directly.
- `RUNNER_IDS.SERVER` and hosted-server message types now exist.

**Still deferred**

1. Thread the project watcher factory through all five watcher sites.
2. Stop hard-coding `VsCodeAdapter` creation in the reusable orchestration path.
3. Move workspace/agent/skill discovery out of direct `vscode.workspace` usage where standalone mode needs it.

**Implementation notes**

- The remaining deferred items are primarily **standalone-server prep**, not blockers for the VS Code-hosted server.
- Do not duplicate provider/sink methods across multiple classes if the broadcast hub can single-source that fanout.

---

### Phase 2 — VS Code-Hosted Server

Status: implemented in the current repo. The details below are retained as
reference for shared extraction and standalone composition, not as code to copy.

**Implemented files**

- `src/server/CtrlYokeHostedServer.ts`

Starts an Express + WebSocket server inside the running VS Code extension process. The live `WorkflowOrchestrator` remains the backend; browser tabs are additional `IDashboardProvider` consumers alongside the VS Code sidebar panel.

#### New message types (add to `DashboardConstants.ts`)

```typescript
SERVER_STARTED: "serverStarted"; // extension → webview: { url: string }
SERVER_STOPPED: "serverStopped"; // extension → webview
THEME_VARS_CAPTURED: "themeVarsCaptured"; // webview → extension: { vars: Record<string, string> }
THEME_VARS_UPDATED: "themeVarsUpdated"; // extension → hosted WS clients: { vars: Record<string, string> }
```

#### Store additions (`settingsStore`)

```typescript
serverUrl: string | null;  // set by SERVER_STARTED, cleared by SERVER_STOPPED
setServerUrl: (url: string | null) => void;
```

#### `useMessageHandler` additions

```typescript
case MESSAGE_TYPES.SERVER_STARTED:
  settingsStore.setServerRunning(true);
  settingsStore.setServerUrl(message.url);
  break;
case MESSAGE_TYPES.SERVER_STOPPED:
  settingsStore.setServerRunning(false);
  settingsStore.setServerUrl(null);
  break;
```

#### Theme forwarding — capture from webview, inject into browser HTML

The VS Code webview is the only context where all `--vscode-*` CSS variables are live. On webview init and on `vscode.window.onDidChangeActiveColorTheme`, the React app extracts them:

```typescript
// In App.tsx (or a dedicated hook) — fires once on mount and on theme change
function captureThemeVars() {
  const style = window.getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  // Walk all CSS custom properties; filter to --vscode-* only
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
          for (const prop of rule.style) {
            if (prop.startsWith("--vscode-")) {
              vars[prop] = style.getPropertyValue(prop).trim();
            }
          }
        }
      }
    } catch {
      /* cross-origin sheet, skip */
    }
  }
  vscodeApi.postMessage({ type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars });
}
```

The extension stores the snapshot in `CtrlYokeHostedServer`. On theme change (`vscode.window.onDidChangeActiveColorTheme`), re-trigger capture by posting a `CAPTURE_THEME_VARS` message to the VS Code webview, then broadcast the new vars to all connected browser clients as `THEME_VARS_UPDATED`. Browser clients apply the vars via the shim:

```javascript
// In standalone-shim.js
case 'themeVarsUpdated':
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(msg.vars)) style.setProperty(k, v);
  break;
```

When a new browser client connects, inject the cached vars as an inline `<style>:root { ... }</style>` block in the served HTML (before `standalone-shim.js`). This gives the browser client the exact same theme as the VS Code sidebar — custom themes included — with live updates on theme change. **Phase 4 static CSS files are only needed for the standalone server.**

#### `CtrlYokeHostedServer` design

```typescript
// src/server/CtrlYokeHostedServer.ts
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { CtrlYokeWebviewProvider } from "../ui/CtrlYokeWebviewProvider";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import { MESSAGE_TYPES } from "../types/DashboardConstants";

export class CtrlYokeHostedServer implements IDashboardProvider {
  private app = express();
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections = new Set<WebSocket>();
  private cachedThemeVars: Record<string, string> = {};
  private port: number;

  constructor(
    private hub: DashboardBroadcastHub,
    private webviewProvider: CtrlYokeWebviewProvider,
    port: number
  ) {
    this.port = port;
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.setupRoutes();
    this.setupWebSocket();
    hub.addProvider(this);
  }

  // ── IDashboardProvider — broadcast all orchestrator events ────────────────
  postMessage(message: unknown): void {
    this.broadcast(message);
  }
  notifyWorkflowAdded(summary) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }
  notifyWorkflowDismissed(id) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId: id });
  }
  notifyWorkflowSummaryUpdated(summary) {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });
  }
  notifyActiveWorkflowChanged(id) {
    this.broadcast({
      type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
      workflowId: id,
    });
  }

  // ── Theme var snapshot (fed from VS Code webview capture) ─────────────────
  updateThemeVars(vars: Record<string, string>): void {
    this.cachedThemeVars = vars;
    this.broadcast({ type: MESSAGE_TYPES.THEME_VARS_UPDATED, vars });
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────
  private setupRoutes(): void {
    const webviewDist = this.resolveWebviewDist();
    this.app.use(express.static(webviewDist));
    this.app.get("/standalone-shim.js", (_req, res) =>
      res.sendFile(path.join(__dirname, "standalone-shim.js"))
    );
    this.app.get("*", (_req, res) => res.send(this.buildHtml(webviewDist)));
  }

  private buildHtml(webviewDist: string): string {
    const index = fs.readFileSync(path.join(webviewDist, "index.html"), "utf8");
    const themeBlock = this.buildThemeStyleBlock();
    return index.replace(
      "</head>",
      `${themeBlock}<script src="/standalone-shim.js"></script></head>`
    );
  }

  private buildThemeStyleBlock(): string {
    const vars = Object.entries(this.cachedThemeVars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return vars ? `<style>:root {\n${vars}\n}</style>\n` : "";
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  private setupWebSocket(): void {
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      this.sendInitialState(ws);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        // Route through the VS Code webview's message router — replies go back to this client only
        this.webviewProvider.routeExternalMessage(msg, (reply) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
        });
      });
      ws.on("close", () => this.connections.delete(ws));
    });
  }

  private sendInitialState(ws: WebSocket): void {
    // Full bootstrap: let the webview provider send its INIT payload to this client
    this.webviewProvider.routeExternalMessage(
      { type: MESSAGE_TYPES.READY },
      (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      }
    );
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(message);
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  listen(): string {
    this.httpServer.listen(this.port, "127.0.0.1");
    return `http://localhost:${this.port}`;
  }

  dispose(): void {
    this.hub.removeProvider(this);
    for (const ws of this.connections) ws.close();
    this.connections.clear();
    this.wss.close();
    this.httpServer.close();
  }

  private resolveWebviewDist(): string {
    // Vite outputs to out/ui/webview-react/ relative to the extension root
    return path.join(path.dirname(__dirname), "ui", "webview-react");
  }
}
```

#### `HostedServerRouter.ts`

Not needed as a separate file — `CtrlYokeWebviewProvider.routeExternalMessage(message, reply)` is the callable entrypoint. Each WebSocket client passes its own `reply` callback, giving per-connection request/response without any shared state.

#### `WebviewSettingsSync` — wire up actual start/stop

This is now implemented. `WebviewSettingsSync` persists `server.enabled`, `WebviewMessageRouter` routes enable/disable requests, and `extension.ts` owns the hosted server lifetime plus `SERVER_STARTED` / `SERVER_STOPPED` broadcast:

```typescript
// extension.ts — preferred: extension owns the server lifetime
context.subscriptions.push(
  vscode.commands.registerCommand("ctrlyoke.enableServer", async () => {
    if (hostedServer) return; // already running
    const port = configService.get("server").port ?? 3000;
    hostedServer = new CtrlYokeHostedServer(
      broadcastHub,
      webviewProvider,
      port
    );
    const url = hostedServer.listen();
    webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STARTED, url });
  }),
  vscode.commands.registerCommand("ctrlyoke.disableServer", async () => {
    hostedServer?.dispose();
    hostedServer = undefined;
    webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STOPPED });
  })
);
```

`WebviewSettingsSync.handleEnableServer` / `handleDisableServer` now delegate through the registered extension commands rather than trying to own server lifetime directly.

#### Theme change listener (extension.ts)

```typescript
context.subscriptions.push(
  vscode.window.onDidChangeActiveColorTheme(() => {
    // Ask the VS Code webview to re-capture CSS vars
    webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
  })
);
```

This is also implemented: the webview captures theme vars, the router forwards `THEME_VARS_CAPTURED`, and the hosted server rebroadcasts `THEME_VARS_UPDATED`.

#### Hosted-server completion checklist

- [x] `express` / `ws` runtime and typings are installed
- [x] `ctrlyoke.enableServer` / `ctrlyoke.disableServer` are registered in `extension.ts`
- [x] `SERVER_STARTED`, `SERVER_STOPPED`, `THEME_VARS_CAPTURED`, `THEME_VARS_UPDATED`, and `CAPTURE_THEME_VARS` exist in `DashboardConstants.ts`
- [x] `settingsStore` tracks `serverUrl`, available LAN IPs, and selected display IP
- [x] `useMessageHandler` handles hosted-server lifecycle and theme-capture messages
- [x] `ServerSection.tsx` displays the URL, copy action, LAN IP selector, TLS certificate download, token regeneration, and browser-side QR code
- [x] Hosted server auto-starts when `server.enabled === true`
- [x] Theme recapture is triggered on VS Code theme changes

#### `standalone-shim.js` (shared, Phase 3)

This file already exists and is already shared by the hosted server. Standalone should reuse it instead of forking the browser bridge.

> **Key advantage over standalone:** the hosted process can delegate
> appropriate operations to the live extension runtime. Browser-visible
> interactions still need host-aware paths: web-native pickers/editors already
> do this, and operational feedback/confirmations are covered by
> `BROWSER_USER_FEEDBACK_PLAN.md`.

---

### Phase 3 — WebSocket Shim (browser side, shared)

> **Status:** already implemented and already used by the hosted server. Reuse it for standalone.

**Shared file:** `src/server/standalone-shim.js` (plain JS — injected directly into HTML before React loads)

```javascript
(function () {
  const workspaceKey =
    new URLSearchParams(location.search).get("workspaceKey") || "default";
  const stateKey = `ctrlyoke:${workspaceKey}:webviewState`;
  let _state = JSON.parse(localStorage.getItem(stateKey) || "{}");
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener("open", () => {
    pending.forEach((m) => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);

    // Theme var updates: apply directly to :root without going through React
    if (msg.type === "themeVarsUpdated") {
      const style = document.documentElement.style;
      for (const [k, v] of Object.entries(msg.vars)) style.setProperty(k, v);
      return;
    }

    // All other messages: dispatch to useMessageHandler via window.addEventListener('message', ...)
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
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
      localStorage.setItem(stateKey, JSON.stringify(s));
    },
  };
})();
```

**Why `localStorage` in standalone?** Standalone has no VS Code webview lifecycle to restore state after the browser tab is closed. Use browser `localStorage`, scoped by a server-provided `workspaceKey`, for durable UI preferences and unsaved workspace viewer drafts. Keep true connection/session data in memory or `sessionStorage`; do not put auth tokens, live workflow state, terminal buffers, or orchestrator snapshots in localStorage.

**Migration note:** The hosted server can continue using the shared shim, but standalone should treat the shim's `getState()` / `setState()` implementation as the browser storage backend. If `src/ui/webview-react/utils/vsCodeStateStorage.ts` exists, it should be renamed or wrapped as a platform-neutral `webviewStateStorage` helper so Zustand stores are not semantically tied to VS Code.

**Why `themeVarsUpdated` is handled outside React?** Patching `document.documentElement.style` is a CSS-level operation, not state. Routing it through React's message dispatch and store would add round-trip latency with no benefit. The React app never reads these vars directly — Tailwind's CSS custom property references (`var(--vscode-*)`) pick them up automatically from the DOM.

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

### Phase 5 — Node host services (standalone)

**Possible new file:** `src/server/StandaloneServerAdapter.ts`

Prefer reusing/extracting the single-root workspace/config behavior already in
`CliAdapter` rather than copying its `getConfig()` switch into a third class.
Compose that platform behavior with Node watcher, feedback, log, document/host
action, and lifecycle services described in
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`.

```typescript
export interface StandaloneServerConfig {
  port: number;
  cwd: string;
  theme: "light" | "dark";
  open: boolean;
  harness: string;
  model?: string;
  allowedTools: string[];
  deniedTools: string[];
  allowAllTools: boolean;
  scriptTimeout: number;
  timeout: number;
}

// NOTE: this sketch assumes `PlatformAdapter` has already been narrowed. Today
// the interface still *requires* log/warn/error/showProgress/showChoice, so
// this class does not compile until the feedback-port migration lands. That
// ordering dependency is real: Phase 5 cannot start before
// BROWSER_USER_FEEDBACK_PLAN Phase 2.
export class StandaloneServerAdapter implements PlatformAdapter {
  constructor(private config: StandaloneServerConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    // Reuse an extracted Node config mapping shared with CliAdapter.
    // Server composition fixes cliExecutionMode to "headless".
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }
  getExtensionPath(): string {
    /* same logic as CliAdapter */
  }
  isVsCode?(): boolean {
    return false;
  }
  // User feedback, logging, watchers, and browser interactions are separate
  // narrow host capabilities rather than additional PlatformAdapter methods.
}
```

**`cliExecutionMode: "headless"`** — `CliIntegration` reads this to decide whether to create a VS Code terminal or spawn a child process with `stdio: 'pipe'`. The server always uses the pipe path so output can be captured and forwarded to the webview over WebSocket.

---

### Phase 6 — HTTP / WebSocket Server (standalone)

**New file:** `src/server/CtrlYokeServer.ts`

`CtrlYokeServer` implements the dashboard sink/provider contracts and composes
the shared application without a VS Code webview. Extract common
HTTP/WebSocket/token/TLS/workspace-viewer route installers from
`CtrlYokeHostedServer` so the new server does not fork its current behavior.

The code below is historical/illustrative only. It predates the hosted server's
security, reconnect, multi-client, route, and liveness behavior and must not be
copied as an implementation.

```typescript
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import { StandaloneServerAdapter } from "./StandaloneServerAdapter";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { WorkflowSummary } from "../types/CtrlYokeTypes";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import { setRuntimeMode } from "../utils/RuntimeMode";
import { RUNNER_IDS } from "../types/DashboardConstants";

export class CtrlYokeServer implements IDashboardProvider {
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
  // These mirror the notify* methods in CtrlYokeWebviewProvider

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
    // Mirror CtrlYokeWebviewProvider's READY → INIT handshake
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
      console.log(`ctrlyoke server at http://localhost:${this.config.port}`);
      if (this.config.open) open(`http://localhost:${this.config.port}`);
    });
  }
}
```

**Webview dist path:** Vite outputs to `out/ui/webview-react/` (confirmed in `vite.config.ts` line 44).

> **Reference implementation note:** the sketch above predates
> `CtrlYokeHostedServer.ts` growing into the real reference implementation. The
> standalone server must share/extract its token gate, static assets, TLS,
> heartbeat/liveness, browser identity, replay scoping, and workspace-viewer
> route installation instead of copying the old sketch or duplicating the
> current server. Standalone constructs `HostedWorkspaceViewerService` with one
> named `cwd` root; hosted extension composition continues passing all VS Code
> named roots.

---

### Phase 7 — Shared Dashboard Message Router (standalone)

**Refactor:** `src/ui/WebviewMessageRouter.ts`

The existing router already accepts a scoped send callback for browser
connections. Remove its VS Code command/workspace/editor dependencies through
injected host actions and direct orchestrator/domain-service calls, then reuse
the same router in standalone. Do not add a parallel
`src/server/WebSocketMessageRouter.ts`.

**The handler mapping:**

| Message Type           | VS Code Handler                                     | Server Handler                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN`                  | `executeCommand("ctrlyoke.run")`                    | `orchestrator.run(filePath)`                                                                                                                                                                                                                                                                                                                                               |
| `PAUSE`                | `executeCommand("ctrlyoke.pause")`                  | `orchestrator.pause()`                                                                                                                                                                                                                                                                                                                                                     |
| `RESUME`               | `executeCommand("ctrlyoke.resume")`                 | `orchestrator.resume()`                                                                                                                                                                                                                                                                                                                                                    |
| `STOP`                 | `executeCommand("ctrlyoke.stop")`                   | `orchestrator.stop()`                                                                                                                                                                                                                                                                                                                                                      |
| `PAUSE_WORKFLOW`       | `orchestrator.pauseWorkflow(id)`                    | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `RESUME_WORKFLOW`      | `orchestrator.resumeWorkflow(id)`                   | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `STOP_WORKFLOW`        | `orchestrator.stopWorkflow(id)`                     | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `SWITCH_WORKFLOW`      | `orchestrator.setActiveWorkflow(id)`                | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `GET_WORKFLOWS_LIST`   | `orchestrator.getWorkflowSummaries()`               | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `LOAD_WORKFLOW`        | `executeCommand + file load`                        | `orchestrator.loadWorkflow(filePath)`                                                                                                                                                                                                                                                                                                                                      |
| `GET_RECENT_WORKFLOWS` | History service                                     | Same — direct call                                                                                                                                                                                                                                                                                                                                                         |
| `SELECT_FILE`          | `executeCommand("ctrlyoke.selectPromptFile")`       | Browser opens the existing web-native `FileBrowserModal`                                                                                                                                                                                                                                                                                                                   |
| `EDIT_FILE`            | Opens VS Code editor                                | Browser opens the selected file in `WorkspaceFileEditor`                                                                                                                                                                                                                                                                                                                   |
| `SHOW_OUTPUT`          | Reveals Output panel                                | Dashboard changes its own panel/layout state                                                                                                                                                                                                                                                                                                                               |
| `OPEN_GIT_CHANGE`      | `executeCommand("ctrlyoke.openGitChange")` (legacy) | **Largely superseded** — ref/commit diffs already go through `workspaceViewerStore.openToGitRef()` → `GET /api/workspace-viewer/git-ref-diff`, backed by the vscode-free `HostedWorkspaceViewerService.getGitRefDiff()`. Mount the same route/service for standalone; only a single-file VS Code diff-editor fallback (if any callers remain) needs no-op/OS-open handling |
| `revealInExplorer`     | VS Code explorer                                    | `open` / `xdg-open` (OS)                                                                                                                                                                                                                                                                                                                                                   |
| All other messages     | Platform-agnostic                                   | Same implementation                                                                                                                                                                                                                                                                                                                                                        |

All platform-agnostic handlers (`EXECUTE_PROMPT`, `UPDATE_PROMPT`,
`REORDER_PROMPTS`, addressed mutations, undo/redo, and replay) remain in place.
VS Code-native behavior such as opening an editor is implemented by the VS Code
host actions. Hosted/standalone browser links continue using the workspace
viewer and its HTTP APIs.

The entire `/api/workspace-viewer/*` family is already implemented against
`HostedWorkspaceViewerService`; extract a shared route installer so both server
modes mount one implementation.

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

> **Superseded (2026-09-24)** by the `SymbolIndex` port in
> [`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](../backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md).
> Standalone `#sym:` completions come from the shared managed language-server host
> (`LspSymbolIndex`). Option A below survives only as `RegexSymbolIndex`, the
> per-language fallback when no server is available. Option B's one-off
> `LspSymbolClient` is not built.

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
# .ctrlyoke/server.config.yaml
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

Add a narrow project-owned watcher/factory contract — the VS Code
implementation adapts a VS Code watcher and the Node implementation adapts
`ServerFileWatcher`. Route all internal file watcher construction through this
seam without exposing `vscode.RelativePattern`, `vscode.Uri`, or
`vscode.FileSystemWatcher`.

**Three callers require attention (five watchers total):**

1. **`PromptFileWatcher`** — inject the watcher factory through
   `WorkflowInstance`.

2. **`CliWatchSession`** — watches three separate paths internally using
   `vscode.workspace.createFileSystemWatcher()` directly: the working file, the
   lock file, and the history run files. Inject the watcher factory and replace
   all three.

3. **`WorkflowOrchestrator`** — replace the `runner.json` create/change watcher.

> **Note on VS Code-hosted server**: `CliWatchSession` is unaffected in the hosted server — it runs inside the extension process where `vscode.workspace.createFileSystemWatcher()` works normally. The `IDashboardProvider[]` broadcast model means watch-mode output (`CLI_WATCH_OUTPUT`) and step progress updates stream to all connected browser tabs identically to the VS Code sidebar. Controls are disabled in watch mode based on `WorkflowSummary` state, which is broadcast to all clients — no special handling needed.

---

### Phase 10 — CLI Integration (`ctrlyoke server`) (standalone)

Add `server` as a Commander.js subcommand in `src/cli.ts`, following the same pattern as `run`:

```typescript
// src/cli.ts
program
  .command("server")
  .description("Start the ctrlyoke browser dashboard")
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
    const { CtrlYokeServer } = await import("./server/CtrlYokeServer");
    const server = new CtrlYokeServer(resolveServerConfig(options));
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
├── CtrlYokeHostedServer.ts          ← HTTP + WS inside the extension; implements IDashboardProvider (Phase 2)
│   # ── Standalone server ────────────────────────────────────────────────
├── CtrlYokeServer.ts                ← Standalone HTTP + WS; implements IDashboardProvider (Phase 6)
├── StandaloneServerAdapter.ts         ← Optional single-root PlatformAdapter specialization (Phase 5)
├── CompletionService.ts               ← File/dir/symbol completions (Phase 8)
├── LspSymbolClient.ts                 ← (optional) LSP stdio client (Phase 8)
└── ServerFileWatcher.ts               ← chokidar-based file watcher (Phase 9)

src/cli/ServerCommand.ts               ← resolveServerConfig() for `ctrlyoke server` (Phase 10)
src/cli.ts                             ← Add program.command('server') block (Phase 10)

src/core/WorkflowOrchestrator.ts     ← Accept injected host services; no vscode import (shared foundation)
src/core/WorkflowInstance.ts         ← Reuse injected platform/watcher/feedback services
src/ui/WebviewMessageRouter.ts       ← Shared panel/WebSocket router with injected host actions (Phase 7)
src/ui/CtrlYokeWebviewProvider.ts    ← VS Code webview composition over the shared router
src/extension.ts                       ← Update: register ctrlyoke.enableServer command (Phase 2)
src/platform/                         ← VS Code/Node host-service implementations
```

---

## Build Changes

### esbuild — no new bundle target

Current repo state:

- `chokidar` is already installed.
- `express` and `ws` are already installed and already used by the hosted server.
- `qrcode` is already installed and can be reused for both browser QR rendering and terminal QR output.
- `fast-glob` and `ignore` are **not** installed yet.

The standalone server should be added to the existing `src/cli.ts` entry point (same binary, same bundle). No second npm bin is needed.

If bundle size or native-module resolution becomes an issue, `express` / `ws` can be moved to `external`, but that is not required for the hosted server and should be decided based on the final standalone bundle behavior:

```javascript
// esbuild.js — optional cliCtx change if we decide not to bundle express/ws
external: ['node-pty', 'express', 'ws'],
```

The existing Node-side `vscode-shim.ts` alias is temporary compatibility for the
current CLI bundle. It is not the standalone architecture: after shared
decoupling, remove the alias and fail the CLI/server bundle if its graph reaches
`vscode` or a VS Code-only source file. Browser `standalone-shim.js` remains.

### package.json — new runtime dependencies

```json
"dependencies": {
  "fast-glob": "^3.x",
  "ignore": "^5.x",
  "open": "^10.x"
}
```

Notes (verified against `package.json`, 2026-07-05):

- `express@^5.2.1`, `ws@^8.20.0`, `chokidar@^5.0.0`, `qrcode@^1.5.4`, and `selfsigned@^5.5.0`
  are already present.
- `fast-glob` + `ignore` are only required once the standalone completion service (Phase 8) lands.
- `open` is only required for the `--open` browser-launch flag (Phase 10).
- `RUNNER_IDS.SERVER` already exists. The missing runtime plumbing is the CLI subcommand that uses it.

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
- Browser `localStorage` is shared across tabs for the same origin/workspace key. Persisted UI preferences and workspace viewer drafts should be treated as client-local browser state, not orchestrator state. For MVP, use last-write-wins across tabs; a later hardening pass can listen for `storage` events and warn when two tabs edit the same unsaved file draft.

---

## Security Considerations

- **Localhost-only by default**: Bind to `127.0.0.1`; require explicit opt-in for `0.0.0.0`
- **Token-based access already exists in the hosted server**: HTML entry, JSON APIs, and WebSocket handshake all require the server token. Standalone should reuse the same token gate.
- **Standalone token UX still needs a decision**: per-process ephemeral token, persisted token file, explicit `--token`, and `--regenerate-token` behavior are not designed yet.
- **Terminal discoverability is part of security UX**: when the tokenized server starts, print the exact tokenized URL, a clickable hyperlink, and a QR code so phone access does not require the user to copy secrets manually.
- **WebSocket origin check**: still worth adding as defense-in-depth, but token validation is the primary gate today
- **CSP**: Set `connect-src ws://localhost:<port>`; serve shim as a static file to avoid `'unsafe-inline'`
- **No eval**: Shim uses `JSON.parse`

---

## Harness Compatibility

| Harness           | Works in Server? | Notes                                                                               |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `copilot-cli`     | ✅ Yes           | Spawns process, no VS Code dep                                                      |
| `claude-cli`      | ✅ Yes           | Spawns process, no VS Code dep                                                      |
| `codex-cli`       | ✅ Yes           | Spawns process, no VS Code dep                                                      |
| `opencode-cli`    | ✅ Yes           | Spawns process, no VS Code dep                                                      |
| `qwen-cli`        | ✅ Yes           | Spawns process, no VS Code dep                                                      |
| `antigravity-cli` | ✅ Yes           | Spawns process, no VS Code dep (replaces `gemini-cli` — see `RELEASE_PLAN.md` §2.5) |

All six harnesses spawn processes and have no VS Code dependency, so the standalone
server needs no harness allowlist or startup rejection path.

> **Harness-list note:** `WorkflowOrchestrator` currently still builds a `geminiCliIntegration`
> (`WorkflowOrchestrator.ts:227`). The Gemini→Antigravity swap is tracked separately in
> `RELEASE_PLAN.md` §2.5 / `ANTIGRAVITY_CLI_HARNESS_PLAN.md`; standalone should inherit whatever the
> final CLI-harness list is at implementation time rather than re-deriving it here.

---

## State Persistence

Standalone mode changes the storage model. The VS Code sidebar can persist through VS Code's webview state API, but a standalone browser tab needs browser-native storage. Do not rely on `sessionStorage` for editor drafts because it disappears when the tab closes.

| State category                                  | VS Code / hosted extension behavior                                             | Standalone server behavior                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Zustand persisted UI state (`uiStore`)          | `vscode.getState()` / `vscode.setState()` via the webview state storage adapter | `localStorage` through the shim, scoped by `workspaceKey`                                               |
| Prompt editor webview state (`editorStore`)     | Existing root webview state object                                              | Same shim contract, backed by scoped `localStorage`                                                     |
| Workspace viewer unsaved drafts (`fileDrafts`)  | Persisted through the shared webview state storage adapter                      | Persisted through scoped `localStorage`, so closing/reopening a browser tab does not lose unsaved edits |
| Live workflow/orchestrator state                | Extension/orchestrator memory plus `.ctrlyoke/.queue` and `.ctrlyoke/.history`  | Server/orchestrator memory plus `.ctrlyoke/.queue` and `.ctrlyoke/.history`; never browser localStorage |
| Recent workflow list / server-level preferences | VS Code context/global state or ctrlyoke config service                         | File-backed storage, likely `.ctrlyoke/server-state.json` or `~/.ctrlyoke/server-state.json`            |
| Auth token / TLS secrets                        | VS Code secret/global storage + config                                          | Server-side token file or ephemeral CLI token; never browser localStorage                               |

Implementation requirements:

1. Rename or wrap `src/ui/webview-react/utils/vsCodeStateStorage.ts` as a platform-neutral helper such as `webviewStateStorage.ts`. The helper may still call `window.vscodeApi.getState()` / `setState()`, but the name should reflect the abstraction rather than VS Code specifically.
2. **Already implemented:** `src/server/standalone-shim.js` reads/writes
   `getState()` / `setState()` through per-tab `localStorage` keys and maintains
   a last-state fallback for close/reopen recovery. Keep `sessionStorage` only
   for the tab identity.
3. Decide whether the current origin + tab-ID scope is sufficient for
   standalone. If not, have `CtrlYokeServer` inject a non-secret stable
   `workspaceKey` derived from the canonical root and include it in the storage
   key.
4. Keep storage values client-local. Browser storage is for UI layout, prompt/editor draft state, and workspace viewer unsaved file drafts. It is not an authoritative source for workflows, run history, source-control status, token secrets, or files on disk.
5. Add a `storageVersion` field inside the persisted root object. The first standalone release can start at version `1`; future migrations can clear or transform stale draft formats safely.
6. Add tests for both storage modes: VS Code-style shim state and standalone browser `localStorage` state. At minimum, cover `uiStore`, `editorStore`, and `workspaceViewerStore.fileDrafts`.

---

## Implementation Order

> **Superseded as a sequence.** This section predates the split into three
> plans: it omits browser feedback entirely and orders the watcher seam (item 10) and shared router (item 8) _after_ standalone composition, contradicting
> the "Next Steps" list above and the shared-foundation dependencies. Use the
> **Cross-Plan Execution Order** table in
> [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
> as the authoritative sequence. The Track 3 entries below remain useful as a
> checklist of standalone-specific deliverables.

### Track 1 — Shared Foundation (required for both modes)

1. **Dashboard broadcast hub** (Phase 1) — done; `IDashboardProvider` / `IDashboardSink` fanout and hosted-router reply scoping are now in place
2. **Host composition / watcher seam** (Phase 1 follow-up) — inject the platform
   and narrow host capabilities into the reusable orchestration path; thread the
   watcher factory through all five watcher sites
3. **Build/runtime plumbing** — partial; `RUNNER_IDS.SERVER`, hosted-server message types, shim copying, and server deps already exist, but standalone completion deps and CLI/server wiring are still missing

### Track 2 — VS Code-Hosted Server (delivers browser access without leaving VS Code)

4. **Hosted server reference implementation** — complete; extract/reuse
   `CtrlYokeHostedServer` transport, security, liveness, assets, and route
   behavior rather than copying it

### Track 3 — Standalone Server (headless / CI / no VS Code)

5. **Node host services** (Phase 5) — reuse `CliAdapter` single-root/config
   behavior where possible; compose headless execution, watcher, feedback, log,
   and host actions without copying its config mapping
6. **`CtrlYokeServer`** (Phase 6) — HTTP + WS, connection registry, broadcast hub wiring, targeted initial-state sync, and reuse of the existing hosted HTML/shim/token behavior
7. **Browser storage backend** — retain the shim's implemented per-tab
   `localStorage`/last-state recovery, rename/wrap the React storage helper away
   from `vsCodeStateStorage`, decide whether an additional canonical-root key is
   necessary, and verify `uiStore`, prompt drafts, and
   `workspaceViewerStore.fileDrafts` outside VS Code
8. **Shared dashboard router** (Phase 7) — remove VS Code dependencies from the
   existing router, replace commands with direct orchestrator/services or
   injected host actions, and reuse it for WebSocket clients
9. **`CompletionService`** (Phase 8) — file/dir completions with `fast-glob` + `ignore`; regex symbol heuristic
10. **`ServerFileWatcher`** + project watcher factory (Phase 9) — chokidar,
    verify every watcher construction path
11. **`ctrlyoke server` CLI command** (Phase 10) — `program.command('server')` + `resolveServerConfig()` + `RUNNER_IDS.SERVER`
12. **Standalone launch UX** — print tokenized local/LAN URLs, OSC-8 clickable links, terminal QR code, and HTTPS certificate guidance when applicable
13. **Manual testing** — standalone first: launch from npm-installed CLI, open browser and phone clients, verify token gating, reconnects, TLS, parallel workflows, watch mode, completions, and unsaved workspace viewer draft recovery after browser tab close/reopen

---

## Open Questions

1. **Standalone token persistence**: should `ctrlyoke server` generate a fresh token per launch, persist one in `~/.ctrlyoke`, accept `--token`, or support both persisted and ephemeral modes?

2. **Standalone CLI surface**: which `ServerSection` settings become first-class CLI flags for v1? At minimum this likely includes `--port`, `--bind-address`, `--https`, `--cert`, `--key`, `--open`, and maybe `--theme`.

3. **File picker enhancements**: `FileBrowserModal` is the standalone/hosted
   baseline. Should a later release also support typed paths, search, or
   drag-and-drop?

4. **Recent workflow history storage**: VS Code stores this in `context.globalState`. The standalone server needs a file-based equivalent (for example `.ctrlyoke/.history/recent.json` in the workspace or `~/.ctrlyoke/history.json`).

5. **Standalone theme model**: should browser clients use a static light/dark theme from config/CLI, or should the server eventually support per-client theme preference independent of the process default?

6. **Standalone browser storage scope**: should `workspaceKey` be only a hash of the canonical workspace root, or should it include port/server identity to avoid collisions when multiple standalone servers serve the same workspace with different config?

7. **Unsaved draft conflict behavior**: if two browser tabs edit the same workspace viewer file draft before either saves, is MVP last-write-wins acceptable, or should the UI detect `localStorage` `storage` events and show a conflict warning?
