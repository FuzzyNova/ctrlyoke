# Visual Studio Extension Plan

**Status (2026-09-28):** Proposed and researched. Not started. **Blocked on the standalone
server:** `STANDALONE_SERVER_PLAN.md` and `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` through
Stage 11 of the decoupling plan's canonical order.

**Related plans:**

- [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md): the Node process this
  extension hosts.
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../implemented/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md): the
  canonical stage order and the `DashboardHostActions` port this plan implements for a
  third host.
- [`CLI_DISTRIBUTION_PLAN.md`](./CLI_DISTRIBUTION_PLAN.md): the one-artifact, one-version
  rule. The VSIX follows it too.

## Question

What would it take for ctrlyoke to run as an extension for Visual Studio, the Windows IDE (not
VS Code)?

The fallback, which needs no Visual Studio work, is to finish the standalone server. Visual
Studio users then run `ctrlyoke server` and use the dashboard in a browser next to the IDE.

## Short Answer

**A Visual Studio extension is feasible and much cheaper than it sounds, but only after the
standalone server exists.** The work is not "port ctrlyoke to Visual Studio." It is "put a
thin native shell around `ctrlyoke server`":

1. **A small C# VSIX.** It uses the VSSDK, or VisualStudio.Extensibility in its in-process
   "hybrid" mode. It opens a tool window that hosts a **WebView2** control.
2. **The unmodified Node sidecar.** The extension launches `ctrlyoke server` as a child
   process on a loopback port, and WebView2 navigates to the tokenized URL. The React
   dashboard, the orchestrator, node-pty terminals and harness execution all run exactly as
   they do in the standalone browser case. No C# port of any core logic is needed.
3. **Two thin bridges** make it feel native rather than like a browser tab:
   - A **theme bridge:** Visual Studio colours become `--vscode-*` CSS variables.
   - A **host-actions channel:** open a file at a line in the VS editor, native folder
     picker, solution root, notifications.

A shipping extension already uses this architecture: Windsurf (Codeium) for Visual Studio. Its
`ChatToolWindow : ToolWindowPane` hosts a WebView2 that loads `http://127.0.0.1:{port}`. It
also maps VS theme colours to CSS variables literally named `--vscode-*`
([source](https://github.com/Exafunction/WindsurfVisualStudio/blob/main/CodeiumVS/Windows/ChatToolWindow.cs)).

Almost all of the cost is in the prerequisite standalone server work, which is valuable on its
own anyway. Beyond that, the Visual Studio-specific cost is:

- a new toolchain: C#, MSBuild, VSIX signing, and a Windows-only CI job;
- about four small host features;
- one React change: a host-capability model instead of the current `isStandalone` boolean.

### Is it worth it over "just use a browser"?

The user's framing is correct: functionally, the browser fallback is about 90% of the
extension. The extension adds these things:

| Benefit                                                    | Browser fallback                  | VS extension |
| ---------------------------------------------------------- | --------------------------------- | ------------ |
| Dashboard docked in the IDE, themed to match               | No, separate window, static theme | Yes          |
| Click a context reference or file link → VS editor at line | No, opens `WorkspaceFileEditor`   | Yes          |
| Workspace root follows the open solution                   | No, manual `--cwd`                | Yes          |
| No terminal command to start the server                    | No                                | Yes          |
| Marketplace discoverability for Visual Studio users        | No                                | Yes          |
| Native folder picker                                       | No, `FileBrowserModal`            | Yes          |

**Recommendation:** ship the standalone server first and document the browser workflow for
Visual Studio users. Start this plan only if there is demand, or if Marketplace discovery
matters commercially. Phase 1 below is a cheap spike that de-risks everything else. Run it
as soon as `ctrlyoke server` boots, even if the full extension is deferred.

## Research Findings

Research was done 2026-09-28. Confidence is noted where a claim could not be confirmed from
primary sources.

### Extension models

- **VisualStudio.Extensibility** is the new, out-of-process .NET SDK. Its
  [overview](https://learn.microsoft.com/en-us/visualstudio/extensibility/visualstudio.extensibility/visualstudio-extensibility?view=visualstudio)
  (updated 2026-04) still labels it **preview**, and its own comparison chart marks scenario
  breadth as incomplete compared with the VSSDK. It requires VS 2022 17.9 or later.
- **Its out-of-process UI ("Remote UI") cannot host WebView2.** Remote UI is XAML
  data-binding only, with no custom controls and no code-behind
  ([docs](https://learn.microsoft.com/en-us/visualstudio/extensibility/visualstudio.extensibility/inside-the-sdk/remote-ui)).
  A Microsoft maintainer's WebView2 prototype "stays invisible", and they recommended
  in-process hosting instead ([VSExtensibility#297](https://github.com/microsoft/VSExtensibility/issues/297)).
  No roadmap item for web tool windows was found.
- **Hybrid in-process mode** is Microsoft's documented answer to "the new SDK doesn't
  support what I need"
  ([guide](https://learn.microsoft.com/en-us/visualstudio/extensibility/visualstudio.extensibility/get-started/in-proc-extensions?view=visualstudio)).
  The extension is written against VisualStudio.Extensibility but runs in `devenv.exe` on
  .NET Framework 4.7.2, with full VSSDK access. This is the recommended model here: new-SDK
  commands and settings, plus a classic `ToolWindowPane` for WebView2.
- **VS 2026 (v18) is GA** (Nov 2025; 18.10.x in Sept 2026). Compatibility is now tied to the
  API version: a VSIX with install target `[17.0,)` loads in both VS 2022 and VS 2026
  without being rebuilt
  ([compatibility model](https://learn.microsoft.com/en-us/visualstudio/extensibility/migration/extension-compatibility?view=visualstudio)).
  One VSIX covers both.

### WebView2

- **The runtime is guaranteed:** VS 2026 setup requires the WebView2 runtime
  ([system requirements](https://learn.microsoft.com/en-us/visualstudio/releases/2026/vs-system-requirements)),
  and Windows 11 includes it.
- **Known issues to design around:**
  - **User data folder.** Set it explicitly, one per `devenv` process. The default location
    under Program Files can fail. Two VS instances sharing a folder produced a blank view in
    [vs-agentic#18](https://github.com/adospace/vs-agentic/issues/18).
  - **Keyboard and focus.** WebView2 does not forward accelerators to the WPF host by
    default. `AllowHostInputProcessing` helps but then Tab and Escape must be handled by
    hand. Windsurf has a crash bug tied to VS moving focus into the panel
    ([#65](https://github.com/Exafunction/WindsurfVisualStudio/issues/65)).
  - **White flash.** Set `DefaultBackgroundColor` from the VS theme before the first
    navigation.
- **Two ways to load the UI:**
  - navigate to a loopback HTTP server, which is supported; or
  - `SetVirtualHostNameToFolderMapping` plus `chrome.webview.postMessage`
    ([local content guide](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)).

### Theming

- There is no VS equivalent of VS Code's injected `--vscode-*` variables. The host must build
  them from `VSColorTheme.GetThemedColor(...)` / `EnvironmentColors` and re-send them on
  `VSColorTheme.ThemeChanged`
  ([colors guide](https://learn.microsoft.com/en-us/visualstudio/extensibility/ux-guidelines/colors-and-styling-for-visual-studio)).
- CSS `prefers-color-scheme` follows the Windows setting, not the VS theme, so it cannot
  replace this bridge.
- Microsoft says the set of themes is not stable across versions
  ([VSExtensibility#324](https://github.com/microsoft/VSExtensibility/issues/324)). Map from
  resource keys, never from theme names.

### Node, terminals and IPC

- **VS's own `node.exe`** (under `MSBuild\Microsoft\VisualStudio\NodeJs`) is private and
  undocumented, and it has gone stale before (Node 12 in VS 2019,
  [TypeScript#54686](https://github.com/microsoft/TypeScript/issues/54686)). **Do not depend
  on it.**
- **node-pty uses N-API** (`node-addon-api`), so one prebuilt binary works across Node
  versions. Bundling a separate Node runtime does not create an ABI-matching problem.
- **Precedent:** GitHub Copilot for VS spawns a Node sidecar (`copilot-language-server`) over
  stdio JSON-RPC
  ([.NET blog](https://devblogs.microsoft.com/dotnet/building-github-copilot-into-visual-studio/)).
  Its lesson: **proxy configuration must be set twice**, once for .NET and once for Node.
  `StreamJsonRpc` is Microsoft's stdio JSON-RPC library, and VS LSP clients use it.
- **No public terminal API** exists for Visual Studio's integrated terminal in either SDK. It
  shares components with Windows Terminal, not xterm.js
  ([announcement](https://devblogs.microsoft.com/visualstudio/say-hello-to-the-new-visual-studio-terminal/)).
  This does not matter: ctrlyoke already renders harness PTYs in its own React xterm.

### Distribution

- **VS Marketplace VSIX size limit: undocumented** (open question in
  [vsmarketplace#1541](https://github.com/microsoft/vsmarketplace/issues/1541)). This is a
  real risk (see Phase 1).
- Signing needs a CA-issued certificate; self-signed certificates are rejected.
- ARM64 is a first-class target for VS 2026.
- Current (2026) paid-extension mechanics on the Marketplace could not be verified. It does
  not matter much, because ctrlyoke already licenses through its own `LicenseService`, not
  marketplace billing.

### Competitor landscape (Visual Studio, not VS Code)

- **Windsurf/Codeium:** WebView2 plus a local server (confirmed from source).
- **Cline:** only an unofficial community port (WebView2 plus a Node sidecar).
- **Continue, Supermaven, Augment:** no Visual Studio version.
- **Copilot Chat for VS and Tabnine:** UI technology not verified.

Visual Studio is under-served by agentic workflow tools, which is the case for doing this at
all.

## What ctrlyoke Already Has

Audited against `src/` on 2026-09-28.

- **The React client needs no transport changes.** It only depends on the
  `{postMessage, getState, setState}` contract on `window.vscodeApi`
  (`src/ui/webview-react/hooks/useVsCodeApi.ts`).
  - `src/server/standalone-shim.js` already provides that contract over a tokenized
    WebSocket, including READY buffering, reconnects, per-tab state, and live
    `themeVarsUpdated` application to `:root` plus the `vscode-dark` / `vscode-light` /
    `vscode-high-contrast` body class.
  - A WebView2 that navigates to the server URL gets all of this for free.
- **Token auth:**
  - `?token=` or the `x-ctrlyoke-token` header (`CtrlYokeHostedServer.requestHasValidToken`);
  - WebSocket close code 4401 on an invalid token.
- **Theme transport is already a message:** `THEME_VARS_UPDATED` plus an initial
  `<style>` block (`CtrlYokeHostedServer.buildThemeStyleBlock` / `updateThemeVars`). Today the
  only source is the VS Code webview's `CAPTURE_THEME_VARS` round trip. **No static or
  external theme source exists yet**, and `server.theme` is in the schema but no code reads
  it.
- **Secrets:** `OsCredentialStore` already uses Windows Credential Manager, and it is the
  `CliAdapter` default. The license and server token work outside VS Code once the trial state
  has a non-`Memento` store. The standalone server needs that anyway.
- **Harness hooks and MCP configs call a bare `node` from `PATH`**
  (`CliNotificationMonitor.buildNodeCommand`, `CliMcpConfigGenerator`). Hook scripts resolve
  from `platform.getExtensionPath()`. The npm-installed harness CLIs need Node too. **A system
  Node ≥ 22.12 on `PATH` is already a hard requirement for any ctrlyoke host.**

**Gaps that are standalone-server prerequisites, not Visual Studio work:**

- **`ctrlyoke server` does not exist.** `CtrlYokeHostedServer` is constructed only in
  `extension.ts`. It routes through `CtrlYokeWebviewProvider.routeExternalMessage` and
  captures its theme from the VS Code webview.
- **Dashboard PTY terminals depend on a VS Code `ExtensionContext`.**
  - `CliIntegration.isVsCodeContext()` is `"getExtensionContext" in platform`. It chooses the
    `PtyProcessManager` path at `CliExecutionRunner.ts`.
  - Without it, interactive runs fall back to `stdio: "inherit"` (the `ctrlyoke run` path).
  - `initPtyProcessManager` is only called from `extension.ts`.
  - The standalone server must key this on "a PTY manager is available". This matters to the
    Visual Studio host too, because interactive harness terminals are the product.
  - Make sure `STANDALONE_SERVER_PLAN.md` Phase 5 covers it.
- **`PlatformAdapter.isVsCode()`** is declared and implemented but has no callers, and its
  doc comment ("create a vscode.Terminal") is stale. Delete it as part of decoupling-plan
  Open Question 4 rather than giving it a third-host meaning.

## Target Architecture

```text
devenv.exe (Visual Studio 2022 17.9+ / 2026)
└─ CtrlYoke.VisualStudio.vsix  (C#, hybrid in-proc, .NET Framework 4.7.2)
   ├─ AsyncPackage / extension entry: commands, settings, solution events
   ├─ SidecarHost ── spawns ──► node <ext>/out/cli.js server --host visualstudio ...
   │     ▲  stdio JSON-RPC (StreamJsonRpc ↔ vscode-jsonrpc)
   │     │  host → node:  setThemeVars, setWorkspaceRoot, shutdown
   │     │  node → host:  ready{url}, openFile, pickFolder, notify, focusDashboard
   ├─ ThemeBridge   VSColorTheme → --vscode-* map → setThemeVars
   └─ DashboardToolWindow : ToolWindowPane
        └─ WebView2 ── navigates ──► http://127.0.0.1:<port>/?token=…
                                      (standalone-shim.js + React dashboard, unchanged)

node sidecar = the standalone `ctrlyoke server`, unchanged except:
   --host visualstudio → composes a `JsonRpcHostActions` (DashboardHostActions over stdio)
   and advertises host capabilities to clients
```

### Decisions

1. **Load the UI from the sidecar's loopback server, not virtual-host plus `postMessage`.**
   - The shim, token auth, reconnect and READY replay already exist and are tested.
   - A `chrome.webview` transport would duplicate the shim's buffering and state logic, and
     would add C# relaying of every dashboard message.
   - Browser tabs and the docked panel then share one server, which the standalone server
     supports as multi-client.
   - Revisit only if the spike finds a real problem with loopback in WebView2, such as
     enterprise proxy or loopback policy.
2. **Host-native actions travel over the sidecar's stdio, not through the WebView.** The
   React client asks the server as it does today (the typed router request). The server's
   injected `DashboardHostActions` implementation forwards the request to C#. This is exactly
   the decoupling plan's host-actions port with a third implementation. **There is no generic
   command passthrough**, in line with the plan's Open Question 2.
3. **Theme reaches browsers through the server.** C# pushes `setThemeVars` to the sidecar,
   which reuses `updateThemeVars` → `THEME_VARS_UPDATED`. The docked panel and any extra
   browser tabs stay in sync, and the standalone server gains the pluggable theme source it
   needs anyway: static defaults for plain `ctrlyoke server`, host-pushed for Visual Studio.
4. **Hybrid in-process model**, not pure out-of-process. Pure out-of-process cannot host
   WebView2 today. Revisit if Microsoft ships web tool windows for Remote UI.
5. **One sidecar per VS instance, one root per sidecar.** This matches the standalone
   single-root decision. On a solution or folder change, the C# host either restarts the
   sidecar with the new root or tells it to rebind, whichever is cleaner once the standalone
   server exists.

## Implementation Plan

### Phase 0: Prerequisites (not Visual Studio work)

- Decoupling-plan stages 0–11: `ctrlyoke server` boots from Node host services and the
  shared router.
- **PTY-backed interactive runs in the standalone server** (see the gap above).
- A **file-backed license trial state store** that replaces `context.globalState`.
- Three **standalone CLI hooks** for any embedding host. Add them to
  `STANDALONE_SERVER_PLAN.md` Phase 10 rather than inventing them here:
  - `--port 0`, which picks a free port;
  - a **machine-readable ready line** on stdout (`{"event":"ready","url":…}`), with the token
    delivered on stdout and never on the command line;
  - a **parent-PID watchdog** (`--parent-pid`), so an orphaned sidecar exits when
    `devenv.exe` dies.

### Phase 1: Feasibility spike (1–3 days, throwaway)

Build a minimal VSIX whose tool window is a WebView2 pointed at a manually started
`ctrlyoke server`. Record results in this doc. **Exit questions:**

1. Does an interactive harness terminal work inside the VS-hosted WebView2? Check typing,
   Ctrl+C, arrow keys, paste, and IME. VS accelerators must not steal keys while xterm has
   focus. Check Escape and Tab behaviour, and whether it is safe to dock, undock, float or
   switch to another tab of the tool window while a PTY streams.
2. Measure the VSIX size with the full `out/` payload: the React dist is about 48 MB
   including dictionaries and codicons, `cli.js` is 8 MB, plus runtime deps and node-pty
   prebuilds for x64 and arm64. Upload a private or unlisted test extension to confirm the
   Marketplace accepts it. **If the limit is the blocker,** the fallback is a small VSIX that
   uses the npm-installed `ctrlyoke` (see Phase 6).
3. Check that the per-process user data folder avoids the two-instance blank-view bug.
4. First-paint theme: confirm `DefaultBackgroundColor` plus the initial style block avoids a
   white flash.

### Phase 2: Sidecar lifecycle (C#)

- **Resolve Node.** Use the `ctrlyoke.nodePath` setting, then `PATH`, and require ≥ 22.12,
  matching `engines.node`. If Node is missing, show an info bar with install guidance and a
  link to the browser fallback docs. Bundling `node.exe` (about 86 MB) is **not** v1: the
  hooks, the MCP configs and most harness CLIs need Node on `PATH` regardless, so bundling it
  would not remove the requirement.
- Spawn the sidecar with the solution or folder root as `--cwd`, and prepend the extension's
  `bin/` to the child `PATH`. In VS Code this is done by `environmentVariableCollection`.
  Here the sidecar must do the equivalent for the harness processes it spawns. That belongs
  in the Node host services, so `ctrlyoke server` does the same.
- Handle the ready handshake, a crash with a backoff restart, a "sidecar stopped" state in
  the tool window (native WPF, since the web UI is gone), and clean shutdown on VS exit.
- **Proxy:** forward the VS proxy settings into the sidecar environment (the Copilot-for-VS
  lesson).
- **Log** the sidecar's stderr to a VS Output window pane. ctrlyoke's own session logs stay
  in `.ctrlyoke/logs/`.

### Phase 3: Theme bridge

- **One source of truth for the mapping:** a JSON table in the repo from `--vscode-*` variable
  name to VS resource key (`EnvironmentColors.*`, `CommonControlsColors.*`,
  `TreeViewColors.*`, …).
  - It covers exactly the variable set the React app consumes. The `@theme` block in `styles/globals.css` has about
    125 references, and xterm reads `--vscode-terminal-*` through `readVsCodeTheme()`.
  - A Node test fails when the React app starts using a `--vscode-*` variable that has
    neither a mapping nor a fallback in the Phase 4 static theme of `STANDALONE_SERVER_PLAN.md`.
- Also send the synthetic `--cy-color-theme-kind` and the body class (dark, light, or high
  contrast), derived from the background luminance and `SystemParameters.HighContrast`.
- Re-push on `VSColorTheme.ThemeChanged`. Use Windsurf's `ChatToolWindow.cs` as the reference
  implementation.

### Phase 4: Host capabilities in the React client

- **Replace the boolean `isStandalone`** (`useVsCodeApi.ts`; about 30 call sites) with a
  **host capability set** advertised in the server's initial state. For example:
  `nativeOpenFile`, `nativeFolderPicker`, `nativeNotifications`, `serverSettingsSection`,
  `vsCodeCommands`.
  - Components branch on capabilities, not on host identity. VS Code, the hosted or
    standalone browser, and Visual Studio are then configurations, not a three-way `if`.
  - Constants go in `DashboardConstants.ts`.
- This is worth doing even without Visual Studio: the VS Code-hosted browser and the
  standalone browser already differ in ways the boolean hides.
- **The Visual Studio panel advertises native open and picker.** Additional browser tabs
  connected to the same sidecar do not, because they are clients of the same server. **The
  capability set is per client, not per server.** The WebView2 client identifies itself,
  for example with a host-issued client key on its URL.

### Phase 5: Host actions (C# side of `DashboardHostActions`)

| Action                                    | Visual Studio implementation                                          | Notes                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `openWorkspaceTarget` (file, line, range) | `VsShellUtilities.OpenDocument` + caret/selection                     | Main reason the extension beats the browser                  |
| `selectWorkspacePath`                     | Native folder or file dialog                                          | OS-picker carve-out from the decoupling plan's modal policy  |
| `openContentPreview`                      | Temporary read-only document, or decline and let the web UI render it | Decide per call site                                         |
| Diff for git refs or worktrees            | `IVsDifferenceService`                                                | Optional; `WorkspaceFileEditor`'s git-ref diff already works |
| Completion notification (VS unfocused)    | Info bar or Windows toast                                             | Mirrors `NotificationManager`'s focus rule                   |
| `focusDashboard`                          | Show the tool window                                                  |                                                              |

**Confirmations, approvals and secret entry stay in the built-in React modals**, per the
decoupling plan's native-versus-built-in-modal policy. No native VS dialogs for them.

### Phase 6: Packaging, CI and release

- **Repository layout.** Put the C# project in the repo so it shares one version with the
  extension and CLI (`CLI_DISTRIBUTION_PLAN.md`), under a new top-level `hosts/visualstudio/`
  folder. It stays out of `src/`, so it does not affect the TypeScript toolchains.
- **Build.** Use a Windows CI job with the VS SDK build tools. The VSIX embeds the same `out/`
  payload that the VS Code extension ships: `cli.js`, `server/`, `scripts/`, `ui/`,
  `runtime-deps`, and node-pty prebuilds for x64 and arm64.
- **Install target** `[17.9,)`, which covers VS 2022 17.9+ and VS 2026. Architectures: amd64
  and arm64.
- **Signing:** needs a CA-issued certificate, which is new release-checklist work.
- **If the size limit bites** (Phase 1), ship a thin VSIX that runs the npm-installed
  `ctrlyoke` (`npm i -g ctrlyoke`). The info bar offers the install command, and a version
  check refuses a mismatched CLI.
- **Licensing and telemetry:**
  - `LicenseService` works unchanged in the sidecar.
  - Telemetry needs a host tag (`visualstudio`) with the same opt-out semantics as the
    other hosts.
  - `@vscode/extension-telemetry` is VS Code-only, so this depends on the telemetry
    abstraction chosen for the standalone server.
- **Docs:** add a `docs/` page for Visual Studio setup, including the Node requirement and
  the browser fallback.

### Phase 7 (later, optional): Editor integration

These are the VS Code features that sit outside the dashboard. None of them is needed for v1.

- **Solution Explorer context menu:** "Add to ctrlyoke prompt" and "Run workflow". This is the
  equivalent of `ContextMenuReferenceCommands`. Reuse `ContextReferenceBuilder`, which has no
  `vscode` dependency, through a host-to-sidecar request.
- **Prompt-file IntelliSense** for `.ctrlyoke.yaml` / `.prompt.md`:
  - VS supports LSP clients (`ILanguageClient`), so this should come from the language
    server in `WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md` / `VSCODE_LSP_MCP_PLAN.md`, if
    that exists.
  - A C# reimplementation of `src/completions/` is **not** an option (DRY).
  - The JSON schema alone gives some YAML and JSON validation through VS's built-in schema
    support.
- **Commit-message generation** for VS's Git Changes window. There is no public extension
  point for the message box; investigate before promising it.
- **Status-bar queue indicator:** a VS status bar text item fed by the sidecar.

## Non-Goals

- Porting any orchestration, harness or UI logic to C#. C# is a shell only.
- The pure out-of-process VisualStudio.Extensibility model (cannot host WebView2 today).
- Visual Studio for Mac (retired) or JetBrains Rider (a different platform; could reuse the
  same "WebView plus sidecar" shape later).
- Multi-root: one solution or folder per VS instance is one root, matching the standalone
  server.
- Driving Visual Studio's integrated terminal (there is no public API, and it is not needed).
- A second transport inside the React client (`chrome.webview` bridge). See Decision 1.

## Risks

| Risk                                                        | Likelihood     | Mitigation                                                             |
| ----------------------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| Marketplace rejects a VSIX of about 100 MB                  | Unknown        | Phase 1 upload test; thin VSIX plus npm CLI fallback                   |
| xterm keyboard or focus problems inside a VS tool window    | Medium         | Phase 1 spike; `AllowHostInputProcessing` and explicit key handling    |
| Users without Node                                          | Medium         | Info bar guidance; the requirement already applies to the harness CLIs |
| C# and MSBuild toolchain and signing cost for one developer | High (certain) | Keep the C# surface tiny; everything testable lives in Node            |
| VisualStudio.Extensibility API churn (still preview)        | Low–Medium     | Use hybrid mode; lean on the stable VSSDK surface for the tool window  |
| Theme mapping drifts as the React app adds variables        | Medium         | Phase 3 mapping-coverage test                                          |

## Testing

- **Node (Mocha):**
  - JSON-RPC host-actions contract tests against a fake host;
  - ready handshake, `--port 0` and parent-PID watchdog tests on `ctrlyoke server`;
  - theme-mapping coverage test.
- **React (Vitest):** capability-set branching, meaning the Visual Studio client opens files
  natively and browser tabs on the same server do not.
- **C#:** a minimal unit test project for Node resolution and ready-line parsing. Everything
  else is covered by a manual smoke checklist on VS 2022 and VS 2026, x64 and arm64:
  - dock and undock during a run;
  - theme switch;
  - solution switch;
  - VS crash leaves no orphaned sidecar;
  - two VS instances open at once.

## Open Questions

1. **Demand gate.** Is there enough Visual Studio demand to take on a second IDE toolchain,
   or does the documented browser workflow suffice until users ask? This decides whether the
   plan moves past the Phase 1 spike.
2. **Solution change:** restart the sidecar, or add a rebind-root capability to the standalone
   server? This depends on how expensive orchestrator start-up turns out to be.
3. **Open Folder mode versus `.sln`:** is the root the solution directory or the git top level
   (`git rev-parse --show-toplevel`)? ctrlyoke's state and run storage key on the workspace
   root, so pick one rule and apply it everywhere.
4. **Bundled Node in v2?** Revisit only if the Node-missing info bar turns out to be a
   meaningful drop-off. Bundling does not remove the need for Node on `PATH` for hooks
   unless hook commands also switch to an absolute node path, which would affect every host.
