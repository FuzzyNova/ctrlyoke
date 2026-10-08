# Workspace Editor Language Intelligence Plan

**Status (2026-10-07):** Phase 2 managed backend is implemented (staging
Stage 13b), the Phase 4 manager backend and message plumbing are implemented
(staging Stage 15a), and Stage 14a applies rename/server workspace edits across open and
unopened workspace files. Rename confirmation uses the LSP request
`ctrlyoke/confirmWorkspaceRename` (params `{ fileCount }`, boolean result);
open-buffer edits use the `ctrlyoke/applyWorkspaceTextEdits` notification
(`{ uri, edits }`). The browser intercepts these messages on the LSP socket and
answers/applies them through the viewer modal and CodeMirror buffer. Its trust,
approval/hash renewal, lifecycle, cap/LRU, restart, and edit contracts have
automated coverage. Browser completion/hover/rename/diagnostics verification
remains a manual follow-up in both hosts. Phases 7a, 7-regex, and
7c are complete, as is phase 1 (staging Stages 12a and 12b). Later phases
remain.
The `SymbolIndex` port and `VsCodeSymbolIndex` (phase 7a) plus
`RegexSymbolIndex` (phase 7-regex, staging Stage 9) are complete, along with
the VS Code cold-start fallback and anchor warm-up. Remaining phases are ready
to implement in sequence.
Every code reference was re-audited against `src/` on 2026-10-07, after the
standalone server shipped. That pass corrected stale locations, fixed the
standalone trust claim, and added three things:

- the Language Servers settings UX and catalog decision (see
  "Settings section UX");
- the VS Code `#` cold-start fix (phase 7c, staging Stage I2);
- standalone warm-up rules.

Phase 5, the VS Code provider backend, is **dropped**.

**Sequencing:**
[`STANDALONE_STAGING_PLAN.md`](../active/STANDALONE_STAGING_PLAN.md) is the
authoritative order. Most of this plan runs **after** the standalone server
(Track C, Stages 12–17), so the `/ws/lsp` socket is added once, to the shared
server class. Two pieces run earlier:

- **Phase 0** (save conflicts) is independent Stage I1. It can land at any
  time and must land before the standalone release.
- **Phase 7a** (the `SymbolIndex` port and `VsCodeSymbolIndex`) lands inside
  decoupling Stage 5. **`RegexSymbolIndex` ships with standalone v1**
  (Stage 9).
- **Phase 7c** (the VS Code `#` cold-start fix) is independent Stage I2. It
  touches only `VsCodeSymbolIndex` and the VS Code completion composition, so
  it doesn't wait for any LSP stage.

**Related plans:**

- [`VSCODE_LSP_MCP_PLAN.md`](./VSCODE_LSP_MCP_PLAN.md): the diagnostics
  end-condition gate and the harness-facing IDE MCP. This plan narrows its
  harness scope (see "Harness side" below) and gives its diagnostics gate a
  host-neutral source.
- [`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md): its
  Phase 8 uses this plan's `SymbolIndex` port with `RegexSymbolIndex`. The
  one-off `LspSymbolClient` is not built. `LspSymbolIndex` (phase 7b here)
  later upgrades standalone `#` through the same port.
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../implemented/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md):
  the managed language-server host must stay in the Node-only graph. Phase 6
  item 4 of that plan is where `VsCodeSymbolIndex` and the completion core
  land.

## Problem

`WorkspaceFileEditor.tsx` is a CodeMirror 6 editor with syntax highlighting and
ctrlyoke's reference links, and no language intelligence at all. We want
standard LSP features in it: completion, hover, go to definition, find all
references, rename symbol, signature help, diagnostics, and formatting.

Separately, the AI harnesses could use LSP access (definitions, references,
diagnostics) during a step.

## Key facts that shape the design

1. **The workspace editor only ever runs in a browser that talks to a ctrlyoke
   Node process.** It is reached through `WorkspaceViewerModal` and reads/writes
   through `hostedApi.ts` → `/api/workspace-viewer/*` → `HostedWorkspaceViewerService`.
   The VS Code panel does not use it; there, links open the native editor.
   Every entry point is gated on `isStandalone`
   (`window.__ctrlyokeStandalone`, set by `standalone-shim.js` for any
   browser client). No setting enables it inside the VS Code panel.
   Today that Node process is the extension host, so the VS Code API is available.
   In the future standalone server (`ctrlyoke server`) it is not.
2. **VS Code's `vscode.execute*Provider` commands resolve a URI to VS Code's own
   `TextDocument`,** which is the on-disk content unless a VS Code editor holds
   unsaved changes. They cannot see the browser editor's unsaved buffer. Completion,
   the headline feature, is almost always requested at a position that exists only
   in the unsaved buffer.
3. **An LSP server supports one client.** A browser editor in two tabs, or on a
   phone and a laptop together, needs a host-side proxy. Raw-piping a server's stdio
   to a WebSocket does not work for more than one tab.
4. **Language servers run workspace code.** tsserver loads tsconfig plugins,
   rust-analyzer runs `build.rs` and proc macros, and gopls runs `go list`.
   Spawning one is a trust decision.
5. **The project already has most of the building blocks:**
   - `vscode-jsonrpc ^9` (used by `CopilotQuotaClient.ts`).
   - `ws` plus a token-gated hosted server (`CtrlYokeHostedServer.ts`, the
     shared options-object class both hosts build through
     `createHostedServerOptions`). It uses `noServer: true` and authenticates
     in one `upgrade` handler. That handler returns 404 for every path except
     `/ws`, then compares `?token=` timing-safe.
     - `/ws/lsp` needs a branch before that 404 check.
     - It also needs **its own `WebSocketServer`** (or at least its own
       `connection` handler). The existing `wss` `connection` handler
       (`setupWebSocket`) runs dashboard client registration and READY
       replay, and LSP sockets must never be emitted into it.
     - The token is per workspace (`ServerTokenStore`, keyed by project), but
       each server instance holds exactly one, so the check is unchanged.
   - Windows `.cmd` launcher resolution (`resolveCliCommand` in
     `src/core/harness/shared/CliLauncherResolver.ts`).
   - An `isWorkspaceTrusted` predicate on the orchestrator.
   - Secret redaction for hosted responses (`SecretRedactionMiddleware.ts`,
     `secretRedactionService.redactValue`). Dashboard WebSocket sends already
     go through `redactHostedTransportMessage` in `CtrlYokeHostedServer.ts`,
     which is the pattern the LSP proxy's outbound path should reuse.
   - The import/export UX pattern of `McpManagerSection.tsx`: scan, import,
     and a `FlyoutActionDropdown` "Save" export over `EXPORT_TARGET_IDS`.
6. **The viewer redacts secrets.** `HostedWorkspaceViewerService.readFile`
   returns secret-bearing files redacted and read-only. `saveFile` refuses
   content containing the redaction marker. A language server reads the real
   file from disk, so its replies (hover, completion, references previews) can
   contain values the browser was never sent.

## Options considered

| Option                                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. VS Code provider bridge only** (`vscode.execute*Provider` behind a host API)                                                           | Rejected as the **only** answer. Zero install and reuses the user's extensions, but it only works while VS Code is the host, so it is dead in standalone. It also cannot serve completion or rename against an unsaved browser buffer (fact 2). A navigation-only fallback was considered and **dropped on 2026-10-06** (see Open Question 1). |
| **A′. VS Code bridge that mirrors the browser buffer into VS Code's `TextDocument`** (apply a `WorkspaceEdit`, save with `document.save()`) | Rejected. The hidden VS Code document becomes dirty, there is no clean API to revert a document that isn't the active editor, saves race with `HostedWorkspaceViewerService.saveFile`'s atomic rename ("file is newer" conflicts), and dirty-document prompts appear on the desktop for edits made on a phone.                                 |
| **B. ctrlyoke-managed language servers** (host spawns real LSP servers; browser speaks LSP through a host proxy)                            | **Chosen as the primary path.** One implementation works in the VS Code-hosted server and in standalone. Full fidelity (completion and rename on unsaved buffers, since the proxy owns document sync). The cost is duplicate memory next to VS Code's own tsserver and an install story; both are mitigated below.                             |
| **C. Browser-only intelligence** (CodeMirror language packages, TS in a web worker)                                                         | Rejected as a general answer. Useful for single-file JS/TS niceties, but it cannot see `node_modules`, the project config, or other languages.                                                                                                                                                                                                 |
| **D. Build a ctrlyoke LSP MCP for harnesses**                                                                                               | Rejected. This space is already crowded, and harnesses are gaining native LSP support. See "Harness side".                                                                                                                                                                                                                                     |

## Decision

**The browser always speaks real LSP JSON-RPC.** The host decides what answers it:

```text
Browser (WorkspaceFileEditor)
  CodeMirror LSP client extension (per language server session)
    ↕ WebSocket /ws/lsp?server=<sessionId>  (token-gated, same rules as /ws)
ctrlyoke Node host (extension host or `ctrlyoke server`; one shared server class)
  LanguageIntelligenceHost         (src/server/lsp/, Node-only graph)
    ├── LspSessionProxy            — per-browser-connection LSP endpoint:
    │     answers `initialize` from cached server capabilities, rewrites
    │     request ids, ref-counts didOpen/didClose per URI, fans out
    │     publishDiagnostics, translates viewer paths ⇄ file:// URIs,
    │     enforces workspace-root containment on every URI in and out,
    │     redacts secrets in every message sent to the browser
    └── ManagedLanguageServerBackend
          spawns the configured server over stdio via vscode-jsonrpc,
          lazy start on first open, idle shutdown, global cap,
          crash restart w/ backoff
```

Using the protocol itself as the browser↔host contract means we don't invent a
parallel `WORKSPACE_EDITOR_HOVER`/`..._REFERENCES` message family. The managed
backend is a proxy rather than a translator. A future second backend could sit
behind the same protocol without any browser changes.

### Why a separate `/ws/lsp` socket rather than the dashboard `/ws`

LSP traffic is high-frequency (`didChange` per keystroke, completion per
keystroke), per-editor, and has its own id space. Putting it on the dashboard
socket would mix it into `WebviewMessageRouter` and READY/replay semantics that it
does not need. A second `WebSocketServer` path on the same HTTP server reuses the
token check and TLS unchanged.

### VS Code provider backend: dropped (2026-10-06)

An earlier revision planned a navigation-only `VsCodeProviderBackend`: an LSP
facade over `vscode.execute*Provider`, with positions mapped from the unsaved
buffer back to its saved baseline. It is **not built**. See Open Question 1.
If real usage ever justifies a zero-install tier, it can be added later behind
the same `/ws/lsp` protocol without changing the browser.

### Managed servers: configuration and installation

Configuration lives in `.ctrlyoke/settings.json` through `CtrlYokeConfigService`,
never `package.json`. It separates **what a server is** (its definition) from
**which server a project uses** (its selection):

```jsonc
"languageServers": {
  // Definitions: id → how to launch it.
  "definitions": {
    "vtsls": {
      "command": ["vtsls", "--stdio"],
      "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      "extensions": ["ts", "tsx", "js", "jsx", "mts", "cts"],
      "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json"]
    }
  },
  // Selection: language → server id (or false to disable), plus per-server
  // workspace/configuration settings.
  "use": { "typescript": "vtsls", "python": "pyright", "markdown": false },
  "settings": { "pyright": { "python.analysis.typeCheckingMode": "strict" } },
  // Lifecycle (user scope only — see Open Questions 3 and 4).
  "idleShutdownMinutes": 10,
  "maxRunning": 4,
  "startOnLaunch": false
}
```

`idleShutdownMinutes`, `maxRunning`, and `startOnLaunch` govern machine
resources, so they are user-scope settings.

- Add `SETTING_PATHS` entries for them (for example
  `"languageServers.idleShutdownMinutes"`).
- Add those entries to `WORKSPACE_FORBIDDEN_SETTING_ROOTS` in
  `CtrlYokeConfigService.ts`. That list matches an exact path or a dotted
  prefix, so it needs no new rule.

**Workspace scope can choose a server without being able to run arbitrary
commands.** Workspace scope may always set `use` and `settings`. `use` can only
name an id that resolves to a built-in default, a user-scope definition, or an
approved workspace definition. A project can therefore say "this repo uses
`vtsls`, not `typescript-language-server`" or "turn Markdown LSP off" with no
command in the repo. If the selected id isn't installed, the settings section says
"This workspace wants `vtsls`" next to its install action, and the editor falls
back to whatever else is available for that language.

A workspace can also add `definitions` of its own (a project-specific server,
or pinning `./node_modules/.bin/…`). Those are **declared, not trusted.** They
follow the secret-grants pattern
(`promptBatchApprovalForPendingWorkspaceSecretGrants` → `BatchApprovalModal`): the
first time a pending definition would be spawned, the user approves it in a
built-in modal. Approval is stored in user-scope state, keyed by workspace and a
hash of the definition's executable fields (`command`, `env`, and any
initialization option that names a path or plugin). If a pull changes the
command, it goes back to pending. This matches how VS Code handles `tasks.json`
auto-run and workspace `typescript.tsdk`. Unapproved definitions are never
spawned, and nothing in the workspace file is silently dropped.

Server resolution for a language, in order:

1. **`use` selection** (workspace, then user), resolved against user definitions,
   approved workspace definitions, then built-in defaults. `.cmd` resolution goes
   through `resolveCliCommand(commandName, args)` in `CliLauncherResolver.ts`
   on Windows. This is the cclsp `spawn EINVAL` gotcha in
   `dev/research/CCLSP_MCP_WINDOWS_SETUP.md`. When the result sets
   `requiresShellVerbatimArgs`, the spawner must pass
   `windowsVerbatimArguments`, as the harness launchers do.
2. **Built-in defaults** with no selection, shipped as data. This is the
   curated catalog from "Settings section UX": id, command with args,
   languages, extensions, root markers, install recipe, homepage. Each default
   is used only when its command resolves on `PATH`, in the ctrlyoke tool dir,
   or in the workspace's `node_modules/.bin`. Where several defaults cover one
   language, the table order decides.
3. **ctrlyoke tool dir** `<ctrlyokeStateHome>/lsp/`, where one-click install is
   supported **only for npm-distributed servers** (`typescript-language-server` +
   `typescript`, `pyright`, `vscode-langservers-extracted`, `yaml-language-server`,
   `bash-language-server`). These are installed with `npm install --prefix` into
   that directory. Native-binary servers (gopls, rust-analyzer, clangd, …) show
   copy-able install instructions and are picked up from `PATH`.
   A Mason/Zed-style binary downloader is an explicit **non-goal** for the first
   version: it brings per-platform asset matrices, checksum verification, and an
   update channel we would have to own.

**Import, like the MCP manager does.** A "Language Servers" settings section,
modeled on `McpManagerSection.tsx`, scans for language server definitions the user
already has and offers Import into ctrlyoke's registry. This reuses the existing
"scan → import into scope" mental model instead of inventing a new one. The full
UX, including where the catalog comes from, is in "Settings section UX" below.

### Lifecycle, cost, and safety

- **Lazy by default:** a server starts when the browser first opens a matching
  file, or on the first `#` query (see "Servers must be warm for `#`"). It never
  starts at extension activation.
  - `startOnLaunch: true` (user scope, default `false`) starts the servers
    selected for the workspace's detected languages when `ctrlyoke server`
    starts listening. The hook goes after `server.listen()` in
    `createNodeHostedServer` (`src/platform/NodeHostServices.ts`). It is still
    subject to the cap, and idle shutdown still applies.
  - The default stays lazy because the headline scenario has a phone driving a
    laptop, and tsserver alone is 300–800 MB. Warm-on-`#` with the regex
    fallback already makes the first `#` non-empty.
- **Idle shutdown:** a server stops after N minutes with no open documents
  (configurable, default about 10). This keeps the duplicate tsserver cost bounded
  to while someone actually has the hosted editor open.
- **One server per (server id, workspace root)**, shared across browser tabs
  through `LspSessionProxy`.
- **Global cap:** at most `maxRunning` servers (default 4) per host.
  - When the cap is hit, the host stops the least recently used server that
    has **no open documents**.
  - If every running server has open documents, the new language gets no
    session. The editor keeps its plain CodeMirror behavior, the settings
    section shows "limit reached", and `#` falls back to `RegexSymbolIndex`
    for that language.
  - The host never stops a server that has an open document.
- **Secret redaction on the way out:**
  - Every message `LspSessionProxy` sends to the browser goes through
    `secretRedactionService.redactValue`, the same boundary the hosted HTTP
    responses use (fact 6).
  - The proxy never sends `didOpen` for a file the viewer served redacted and
    read-only, so the language server never receives the redaction marker as
    buffer text.
  - Edits from rename or code actions that would write into such a file are
    rejected.
- **Trust gate:** never spawn in an untrusted workspace. Read the
  orchestrator's `isWorkspaceTrusted` predicate.
  - In VS Code it is `vscode.workspace.isTrusted`.
  - Standalone hardcodes `() => true` in `createNodeHostServices`. Running
    `ctrlyoke server` in a directory is the trust act, matching how
    standalone already runs workflows there. There is no server trust
    setting, and this plan doesn't add one.
  - Workspace-declared `definitions` still need the one-time approval
    described above in both hosts, so a cloned repo cannot launch an
    arbitrary command just because the server runs in it.
- **Path containment:** every URI the browser sends must resolve inside a
  workspace root. `HostedWorkspaceViewerService.safeResolve` is private, and it
  also admits the owned user-settings file, which LSP must not inherit.
  - Extract the workspace-root containment check into a shared helper and
    use it from both the viewer service and the proxy. Don't call
    `resolveWorkspacePath` and accept its exceptions.
  - Results that point outside the workspace roots (for example lib `.d.ts`
    files in a global install) are returned as read-only locations. The
    editor may preview them but never writes them.
- **Multi-file edits (rename, code actions):** Stage 14a applies rename results
  and server `workspace/applyEdit` requests in the proxy. The proxy applies the
  `WorkspaceEdit` itself. The open buffer is edited in the browser. Files that
  aren't open are written through `HostedWorkspaceViewerService` (same EOL
  preservation and atomic write), and then a `workspace/didChangeWatchedFiles`
  notification is sent. A rename that touches unopened files asks for confirmation
  with a file count in the browser (a built-in modal, per the native-vs-built-in
  modal policy). The proxy sends `ctrlyoke/confirmWorkspaceRename` as an LSP
  request with `{ fileCount }`; the browser replies with a boolean result.
  Edits to open buffers are sent as the LSP notification
  `ctrlyoke/applyWorkspaceTextEdits` with `{ uri, edits }`, then flow back to
  the proxy through the normal `didChange` stream. Code-action edits are applied
  when the server sends `workspace/applyEdit` after the user executes an action.

### Multiple tabs and external changes: best effort, never read-only

Two tabs (or a phone and a laptop) may have the same file open with different
unsaved edits. Both stay fully editable, and both get language features. This
matches two VS Code windows on one file.

- **One server-side document, re-synced on demand.** The language server holds a
  single version of each URI. `LspSessionProxy` tracks each tab's buffer and its
  own version counter, and remembers which tab's text the server currently holds.
  When a request (completion, hover, rename, …) comes from a tab whose buffer is
  not the one the server holds, the proxy first sends a full-text `didChange` with
  that tab's content, then forwards the request. Consecutive requests from one tab
  (the normal typing case) cost nothing extra. Only switching tabs pays for one
  full resync.
- **Diagnostics follow the buffer they were computed for.** A
  `publishDiagnostics` is delivered only to tabs whose buffer matches the synced
  text. Other tabs keep their previous diagnostics, marked stale, until their next
  request resyncs them.
- **Rename across tabs.** A `WorkspaceEdit` that touches a file open with unsaved
  edits in another tab is applied to that tab's buffer through its session (as an
  edit, not a reload), so the unsaved work survives.
- **Saves use optimistic concurrency (done, phase 0).** The read returns
  `modifiedAt`, and the save sends `baseModifiedAt`.
  `HostedWorkspaceViewerService.saveFile` throws `WorkspaceFileConflictError` on
  a stale base, and the `PUT /api/workspace-viewer/file` route maps that to 409.
  Types live in `src/types/HostedWorkspaceViewerTypes.ts`.
- **"This file changed on disk" (done, phase 0).**
  - `CtrlYokeHostedServer.broadcastWorkspaceFileChanged` sends
    `WORKSPACE_FILE_CHANGED` after a save.
  - External changes come from per-client watchers in the same class
    (`watchWorkspaceFile`/`unwatchWorkspaceFile`, route
    `POST /api/workspace-viewer/file/watch`), built on `FileWatcherFactory`.
  - Each client watches **one** file at a time (`watchedFilesByClient` is
    `Map<clientId, path>`), and watchers are ref-counted across clients.
  - The Reload / Compare / Keep mine banner lives in
    `WorkspaceExplorerPane.tsx`, not `WorkspaceFileEditor`.

  **The LSP proxy hooks into the same watcher events.** It sends
  `workspace/didChangeWatchedFiles` for the path and does not add a second
  watcher per file. A clean buffer that reloads in the browser reaches the
  server as an ordinary `didChange` from that tab.

### Browser side

- Use the official `@codemirror/lsp-client` (MIT, first-party). It covers
  completion, hover, signature help, definition/declaration/type-definition/
  implementation, references, rename, formatting, and diagnostics. Its `Transport`
  is only `send`/`subscribe`/`unsubscribe`, so a WebSocket adapter is a few lines,
  and its `Workspace` interface (`displayFile`/`requestFile`) is where cross-file
  navigation plugs into `workspaceViewerStore`. It has no document or workspace
  symbol UI. Send those two requests through the same client and render them with
  our own picker. `@marimo-team/codemirror-languageserver` is the maintained
  fallback if a gap shows up.
- `@codemirror/lsp-client` is not installed yet. When installing, re-verify its
  peer ranges against the installed `@codemirror/state` 6.7.x and
  `@codemirror/view` 6.43.x. The declared ranges are only `^6.5.4` and
  `^6.39.12`, so raise them if the client needs newer versions. All
  `@codemirror/*` packages live in the root `package.json`; the webview has no
  separate one.
- `WorkspaceFileEditor` gets one optional extension slot built from a
  `useLanguageIntelligence(filePath)` hook. The hook asks the host which session
  (if any) serves the file, opens `/ws/lsp`, and returns CodeMirror extensions.
  With no session the editor behaves exactly as it does today.
  - **The slot must be a `Compartment`.** Today the extension list is one
    `useMemo` keyed on `filePath`, `readOnly`, and three callbacks, and any
    change rebuilds the whole `EditorView`.
  - Feeding session extensions into that memo would tear down the view
    (cursor, undo history, LSP document) whenever the session connects or
    reconnects.
  - Reconfigure the compartment instead.
- This editor already uses two gestures to open a ctrlyoke reference link
  (`createWorkspaceReferenceClickHandlerExtension`): Ctrl/Cmd-click, and on
  touch a short tap (under 500 ms and 10 px) on a `.cm-link` span. Go to
  definition must not steal either gesture on `.cm-link` spans. Use F12 and
  the context menu for definition, and keep both link gestures as they are.
  On a phone, the context menu is the only way to reach definition.
- Cross-file navigation reuses
  `workspaceViewerStore.openToFile(path, startLine?, endLine?)`. Pass the LSP
  range's lines, converting from 0-based to 1-based.
- "Find all references" results render as a panel in the workspace viewer. Each
  row uses the existing `path#L10-L12` reference formatting, so a result can also
  be sent to a workflow as context.
- New context menu items in `useWorkspaceEditorContextMenu.tsx` (`src/ui/webview-react/hooks/`):
  Go to Definition, Find All References, Rename Symbol, Format Document. Each
  is gated on the capabilities the session advertised. Today the menu has
  Cut, Copy, Add Selection/File to ctrlyoke, and the Run/Load/Queue workflow
  actions for prompt files. LSP items go in their own group after Copy.

## Settings section UX (phase 4)

Decided 2026-10-07. The section is modeled on `McpManagerSection.tsx`. It
answers three questions: what servers exist, which one each language uses, and
what is installed. It applies wherever the settings drawer renders (VS Code
panel and browser). Its subtitle says what it powers: "Used by the browser
workspace editor and, in `ctrlyoke server`, by `#` symbol completions."

### Is there an LSP registry to pull from? Not one we can use as-is

There is no analog to `registry.modelcontextprotocol.io` (which
`McpDiscoveryUtils.ts` queries as `MCP_REGISTRY_URL`). The candidates, checked
2026-10-07:

| Source                                                      | What it has                                                                                                                                                                                                                                                                                                                               | Verdict                                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mason-registry** (mason.nvim)                             | 600 packages, 330 in category `LSP`, Apache-2.0, released several times a day as `registry.json.zip` on GitHub releases. Each entry has a purl source (`pkg:npm/…`, `pkg:github/…` with a per-platform asset matrix, `pkg:pypi/…`, …), `bin`, languages, licenses, homepage. **No launch arguments:** 0 of 330 LSP entries say `--stdio`. | Closest thing to a registry. Not usable alone, because a server started without its args fails. Half of its LSP entries are GitHub binaries that need the downloader we ruled out. |
| nvim-lspconfig `lsp/*.lua`                                  | `cmd` (with args), filetypes, root markers, Apache-2.0                                                                                                                                                                                                                                                                                    | Has launch args, but many `cmd`/`root_dir` values are Lua functions. Not machine-readable. Human reference only.                                                                   |
| Helix `languages.toml`                                      | `command` + `args` per server, file types, roots; MPL-2.0                                                                                                                                                                                                                                                                                 | Best single machine-readable source of command + args. No install info. Use it to seed and check our table, not as a runtime feed.                                                 |
| Microsoft LSP implementors page                             | A Markdown table of language, maintainer, repo                                                                                                                                                                                                                                                                                            | A link directory. No commands. Not useful.                                                                                                                                         |
| Claude Code official LSP plugins, opencode's built-ins, Zed | About 13 / 40 / N servers, as plugin `.lsp.json` files or code                                                                                                                                                                                                                                                                            | Good references for which servers matter and how opencode installs them (npm, GitHub release, toolchain command). Not a feed.                                                      |

**Decision: ship a curated catalog as data; don't consume a remote registry in
v1.**

- The catalog is the built-in defaults table this plan already calls for,
  extended to drive the UI. It has about 15–20 well-known servers covering
  TS/JS, Python, JSON/CSS/HTML, YAML, Bash, Markdown, Go, Rust, C/C++, C#,
  Java, Lua, TOML, and Dockerfile.
- Launch args are the one fact no registry supplies reliably, so they must be
  ours and must be tested.
- Each catalog entry carries `masonName` as a join key. A later "Browse more"
  tab over `registry.json.zip` can then add discovery without a data migration.
  - That tab is **deferred**, not planned.
  - It would only offer "Add with command prefilled from `bin`, args for you
    to fill in", plus a homepage link.
  - Revisit if users ask for servers outside the catalog more often than
    "Add server" by hand handles.

Catalog entry shape (project-owned, in `src/server/lsp/`, sent to the UI by
message so the webview never imports Node code):

```typescript
interface LanguageServerCatalogEntry {
  id: string; // also the `use` value, e.g. "typescript-language-server"
  displayName: string;
  description: string;
  homepage: string;
  license: string; // SPDX, shown in the row
  masonName?: string; // join key for a future mason-backed tab
  command: string[]; // executable + args, e.g. ["typescript-language-server", "--stdio"]
  languages: string[]; // LSP language ids
  extensions: string[]; // without the dot
  rootMarkers: string[];
  install: LanguageServerInstallRecipe;
  warmup?: LanguageServerWarmup; // anchor-document rule for `#` (see 7c / standalone)
}

type LanguageServerInstallRecipe =
  | { kind: "npm"; packages: string[]; bin: string } // one-click into the tool dir
  | {
      kind: "command";
      commands: Partial<Record<"win32" | "darwin" | "linux", string>>;
    }; // copyable
```

The catalog's `kind` values (`"npm"`, `"command"`) are flow-control strings,
so they go in `DashboardConstants.ts` as constants, as with every other kind
union.

### Do we only list what the user has installed? No: three different lists

1. **Catalog: everything we know how to run, with its install state.**
   - Every catalog entry is listed whether or not it is installed.
   - The host probes each command on `PATH`, in the tool dir
     (`<ctrlyokeStateHome>/lsp/node_modules/.bin`), and in the workspace's
     `node_modules/.bin`. It does this once per scan, not per render, and
     reports **Detected** with the resolved path or **Not installed**.
   - A detected entry already works with no further action, because
     built-in defaults resolve without being imported. That is resolution
     step 2 above.
2. **Local configs: definitions found in other tools' config files.** Like
   MCP's "Local configs" tab, this lists only what the scan finds, grouped by
   source, each with Import. It doesn't list servers that are merely
   installed.
3. **Managed servers: ctrlyoke's own `definitions`** in user and workspace
   scope. These are the imports and hand-added servers, with editing, deleting,
   and approval state.

### Do we link to where they can install? Yes, for every entry

- **npm-distributed entries:** an **Install** button.
  - It runs `npm install --prefix <ctrlyokeStateHome>/lsp <packages>` on the
    host and streams progress into the row.
  - Before it runs, a built-in confirmation modal names the packages and
    the directory.
  - The workspace can never trigger it.
  - If `npm` isn't on `PATH`, the button turns into the copyable command.
- **Everything else:** **Copy install command** for the host's OS (for
  example `go install golang.org/x/tools/gopls@latest`,
  `rustup component add rust-analyzer`, `winget install LLVM.LLVM`), plus a
  **Homepage** link.
- **After an install outside ctrlyoke:** a **Scan again** button re-probes
  the commands, the same affordance the MCP manager has.
- **A missing selected server** shows "This workspace wants `vtsls`" with that
  entry's install action inline. This is the `use` case from "Managed
  servers".

### Layout

Same two-column grid as `McpManagerSection` (`lg:grid-cols-2`, stacking on a
phone):

- **Left column, "Language servers":**
  - **Languages** strip: one row per detected workspace language with a
    server dropdown, plus "Off". It writes `languageServers.use.<language>`
    to the active scope through `UPDATE_GLOBAL_SETTING`, as MCP's defaults
    toggle does.
  - **Server rows:** catalog entries that are detected or selected, plus
    every managed definition. Each row shows:
    - name, id chip, language chips;
    - a **status badge**: running, starting, idle, stopped, not installed,
      limit reached, needs approval, crashed (with the last stderr line on
      hover);
    - a command summary.
  - **Row actions:**
    - Edit (managed definitions only).
    - Approve (pending workspace definitions; opens `BatchApprovalModal`).
    - Restart / Stop (running).
    - Delete (managed definitions).
    - In phase 6, the same `FlyoutActionDropdown` "Save" export.
  - Expanding a row shows command, args, resolved path, root markers, env
    keys, and the locations it was found in, like MCP's `ServerDetails`.
  - **Add server** opens a form: command plus args, languages, extensions,
    root markers, env. It mirrors `McpServerForm`.
- **Right column, "Discover & import":** two tabs, **Catalog** and **Local
  configs**, in the same tab-button style as MCP's Local configs / Registry.
  The Catalog tab has a filter box and the install actions above.

### Local config sources to scan

Verified 2026-10-07. Each format maps onto our definition shape:

| Source      | Location (workspace / user)                                                                                       | Shape                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen Code   | `.lsp.json` / none                                                                                                | top-level keys are names (the docs use language ids): `{ command, args, extensionToLanguage, env, initializationOptions, settings, trustRequired }` |
| Claude Code | none at project level; **installed plugins** carry `.lsp.json` or `plugin.json` `lspServers` (same shape as Qwen) | `{ command, args, extensionToLanguage: { ".go": "go" }, … }`. Unknown keys fail its validation, which matters for export.                           |

| Copilot CLI | `.github/lsp.json` (and root `lsp.json`, per the `lsp-setup` skill) / `~/.copilot/lsp-config.json` | `{ lspServers: { name: { command, args, fileExtensions: { ".ts": "typescript" }, env, rootUri, initializationOptions } } }` |
| opencode | `opencode.json` / `~/.config/opencode/opencode.json`, `lsp` key (`true` or an object) | `{ lsp: { name: { command: [exe, ...args], extensions: [".rs"], env, initialization, disabled } } }` |
| cclsp | `cclsp.json` or `CCLSP_CONFIG_PATH` | `{ servers: [ { extensions: ["py"], command: [exe, ...args], rootDir, initializationOptions } ] }` |

Re-checked 2026-10-07 against Anthropic's [code intelligence plugin guide](https://code.claude.com/docs/en/plugins/code-intelligence) and [LSP plugin component reference](https://code.claude.com/docs/en/plugins/components#lsp-servers): standalone `.lsp.json` is described at the plugin root, and `plugin.json`'s `lspServers` accepts inline configs or a plugin-relative JSON path. The docs do not describe a project-root `.lsp.json` loader. Keep Claude's export routed through the Qwen-compatible project `.lsp.json`; direct Claude support would require generating/installing a plugin.

- Our `command` is one array, matching opencode and cclsp.
- `extensionToLanguage` / `fileExtensions` maps convert to `extensions` plus
  `languages`.
- Resolve the Claude plugin directories from Claude Code's installed-plugins
  manifest at implementation time. Don't hardcode a cache path.

### Backend and message plumbing (mirror MCP, share what's shared)

| MCP piece                                                                                                   | Language-server counterpart                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/McpManagerService.ts`, dispatched from `WebviewMessageRouter`                                       | `src/ui/LanguageServerManagerService.ts`, same dispatch pattern                                                                                                                                                                                                       |
| `src/utils/McpDiscoveryUtils.ts` + `McpConfigPaths.ts`                                                      | `src/utils/LspDiscoveryUtils.ts` + `LspConfigPaths.ts` (descriptor list per source, like `getLocalConfigDescriptors`)                                                                                                                                                 |
| `MCP_REGISTRY_URL` search                                                                                   | catalog list plus a PATH/tool-dir probe (no network)                                                                                                                                                                                                                  |
| `HarnessMcpExporter.ts`                                                                                     | phase 6 `HarnessLspExporter.ts`                                                                                                                                                                                                                                       |
| `REQUEST_MCP_*` / `MCP_*_RESULT` in `DashboardConstants.ts`                                                 | `REQUEST_LSP_SERVERS`, `LSP_SERVERS_UPDATE` (definitions, catalog, probe results, live status), `REQUEST_LSP_LOCAL_SCAN`, `LSP_LOCAL_SCAN_RESULT`, `SAVE_LSP_DEFINITION`, `DELETE_LSP_DEFINITION`, `INSTALL_LSP_SERVER`, `LSP_INSTALL_PROGRESS`, `RESTART_LSP_SERVER` |
| `store/useMcpManagerStore.ts`                                                                               | `store/useLanguageServerStore.ts`                                                                                                                                                                                                                                     |
| `GLOBAL_SETTINGS_TABS.MCP_MANAGER`, mounted in `GlobalSettingsDrawer.tsx`; landmark in `settingsCatalog.ts` | `GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS`, same drawer; landmark `landmark:language-servers:servers`                                                                                                                                                                    |

- **Shared UI goes to `components/shared/` when the second user appears.**
  `ScopeBadge`, the target encode/decode helpers, the delete-location
  modal, and the export-group builder are currently module-local to
  `McpManagerSection.tsx`. Move them in phase 4, or in phase 6 for the export
  pieces. Don't copy them.
- **Live status needs a push, not a poll.** `LanguageIntelligenceHost` emits
  status changes, and the service forwards them as `LSP_SERVERS_UPDATE` to
  clients that have the section open.

## `#` symbol completions in the prompt editor

`CodeMirrorEditor.tsx`'s `#` trigger gets its items from the host, not the
browser:

1. `REQUEST_COMPLETIONS` goes to
   `PromptEditorSupportService.handleCompletionRequest`.
2. When the VS Code host has editor selections, it first sends a
   `COMPLETIONS_RESPONSE` with `partial: true` containing **only those
   selections** (`getHashSelectionCompletions`).
3. It then sends the final response: fuzzy-filtered selections plus workspace
   symbols (`getHashCompletions`).

`#` never returns files. Standalone has no host editor, so its `#` response
is symbols only.

### Current state (phase 7a and 7-regex done)

All symbol logic is host-neutral and lives in `src/completions/CompletionCore.ts`.
`CompletionHelpers.ts` only composes the core for the VS Code host.

| Piece                                                                              | Where                                                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `SymbolIndex`, `IndexedSymbol`, `LspSymbolKind` (1-based)                          | `src/completions/SymbolIndex.ts`                                                             |
| `#` entry points `getHashSelectionCompletions`, `getHashCompletions`               | `CompletionCore.ts`                                                                          |
| Full query plus 3-character prefix query (`SYMBOL_PREFIX_LENGTH`), deduped, ranked | `CompletionCore.ts` private `getSymbolCompletions` (above the port, so every index benefits) |
| `findSymbolKindForReference(viewerPath, name, startLine, endLine)`                 | `CompletionCore.ts`; called from `PromptEditorSupportService` to pick a `#sym:` chip icon    |
| `mapSymbolKindToCompletionKind`, `mapSymbolKindToReferenceKind`                    | `CompletionCore.ts`; both take `LspSymbolKind`                                               |
| `VsCodeSymbolIndex` (`kind + 1` conversion, done once)                             | `src/platform/VsCodeSymbolIndex.ts`; chosen in `CompletionHelpers.getCompletionCore`         |
| `RegexSymbolIndex`                                                                 | `src/completions/RegexSymbolIndex.ts`; chosen in `createNodeHostServices`                    |
| VS Code context menu `tryBuildSymbolReference`                                     | `ContextMenuReferenceCommands.ts`; now goes through `VsCodeSymbolIndex.documentSymbols`      |

`VsCodeSymbolIndex` calls only `vscode.executeWorkspaceSymbolProvider` and
`vscode.executeDocumentSymbolProvider`. It ignores `maxResults` and `signal`,
and **nothing falls back when it returns empty.**

### Implementations, in delivery order

1. **Done — 7a.** `VsCodeSymbolIndex` (extension-only).
2. **Done — 7-regex (2026-10-06).** `RegexSymbolIndex` (Node-only) is
   standalone v1's `#` source.
   - It scans source files by extension (TS/JS, Python, Go, Rust, Java, C#,
     and C/C++ patterns) and caches results per file by `mtimeMs`.
   - `endLine` comes from bracket matching in brace languages and from
     indentation in Python. When no end is found, `endLine = startLine`.
   - It becomes the per-language fallback in both hosts (7b and 7c).
3. **7c — VS Code cold start** (staging Stage I2). See below.
4. **Done — 7b, `LspSymbolIndex`** (Node-only, staging Stage 16, 2026-10-07).
   - It issues `workspace/symbol` and `textDocument/documentSymbol` through
     `LanguageIntelligenceHost`.
   - It fans out to every running or startable server for the workspace,
     within the global cap.
   - It merges the results and applies `maxResults`.
   - The first `#` query starts servers selected for languages with matching
     root markers. Startup stays asynchronous for the current query, so the
     regex index answers until each language has a ready server.
   - Catalog warm-up metadata opens one anchor per matching TS/JS config
     marker and keeps it open for the server lifetime. Symbol requests refresh
     managed-server idle activity.
   - Range-less workspace symbols are resolved when the server supports
     `workspaceSymbol/resolve`; unresolved entries are omitted.
   - Standalone `createNodeHostedServer` composes this with the existing
     `FallbackSymbolIndex`; VS Code composition remains unchanged.

The composition root picks the index per host. VS Code-hosted uses
`VsCodeSymbolIndex` with the regex fallback from 7c (Open Question 2).
Standalone uses the LSP index, falling back to the regex index per language.

### VS Code cold start: `#` is empty until a file of that language opens (phase 7c)

In the VS Code host, typing `#` before any `.ts`/`.tsx` file has been opened
returns no TypeScript symbols. They appear once one is opened. Tracked in
`dev/bugs/backlog/vscode-hash-symbols-empty-until-language-file-opened.md`.
Verified against the bundled `typescript-language-features` (10.0.0) on
2026-10-07:

- **The extension activates only on `onLanguage:*`** (plus `jsonc`, a few
  commands, a task type, and a walkthrough). There is no `workspaceContains`.
- **Even when active, its language providers register lazily.** The
  workspace-symbol provider registers only once a JS/TS document exists in
  `workspace.textDocuments` (`lazilyActivateClient` / the lazy provider
  registration in the bundle).
- **tsserver `navto` searches only loaded projects.**
  `js/ts.workspaceSymbols.scope` (`allOpenProjects` by default) sends no file,
  so tsserver searches whichever configured projects an open file has loaded.
  With none, the result is empty.
- **No VS Code or TypeScript setting preloads projects.**
  `enableProjectDiagnostics` loads closed files for diagnostics only after
  tsserver is already running. `workspaceSymbols.scope` doesn't help.
- **There is no `onWorkspaceSymbol` activation event, and
  `vscode.executeWorkspaceSymbolProvider` doesn't activate anything.** It only
  queries providers that are already registered.
- **`vscode.workspace.openTextDocument(uri)` without showing an editor is
  enough.**
  - It fires `onDidOpenTextDocument`, which triggers `onLanguage`
    activation and the lazy provider registration.
  - `BufferSyncSupport.listen()` syncs every document in
    `workspace.textDocuments`, not just tabs, so tsserver gets `open` and
    loads the project.
  - Tabs gate only diagnostics requests, so the hidden document produces no
    diagnostics.
- **A hidden document lives about 3 minutes.** The main thread holds
  `openTextDocument` models in `BoundModelReferenceCollection` (3 minutes,
  50 references, 80 MB). It then disposes them, the TS extension sends
  `close`, and tsserver may drop the project.
- **Other languages vary.** Extensions that activate on `workspaceContains`
  (for example rust-analyzer and gopls) usually answer with no file open.
  Pylance is unverified. The general rule is that a provider must be
  registered first, and most register on `onLanguage`.

**Fix, in two layers. Both are in VS Code host code only:**

1. **A regex fallback, so `#` is never empty.** Wrap the VS Code index in a
   `FallbackSymbolIndex(primary, fallback)` that lives next to the port in
   `src/completions/`.
   - When the primary returns zero symbols for a query, return the fallback's.
   - `documentSymbols` falls back the same way. It feeds the chip icon, which
     then shows a regex kind rather than none.
   - Compose it in `CompletionHelpers.getCompletionCore` with the
     `RegexSymbolIndex` the standalone host already uses, fed by the same
     completion file list.
   - The rule is zero results, not per language: VS Code results don't say
     which languages a provider covers, and the regex index lacks
     `containerName` quality. A per-language merge is not worth it here.
2. **Warm the language extensions on demand.**
   - On a `#` query, before calling the provider, `VsCodeSymbolIndex` makes
     sure one anchor document is open for each detected language family. For
     TS/JS, a workspace with `tsconfig.json`/`jsconfig.json` uses the first
     file the completion file list has with a matching extension under that
     config's directory.
   - It opens the anchor with `openTextDocument` and never shows it.
   - A family counts as covered when `workspace.textDocuments` already holds
     a document of that language, which is the normal case once the user has
     opened a file.
   - Re-opening is idempotent and cheap, so each `#` query that finds the
     family uncovered just opens the anchor again. That outlives the
     3-minute disposal without a timer.
   - The first query after a cold start usually still races project load. It
     answers from the regex fallback, and later keystrokes re-query and pick
     up VS Code's results once tsserver is ready. Don't block the response on
     project load.
   - Start with TS/JS, the case users hit. A small table in
     `VsCodeSymbolIndex` maps family → extensions → config markers, so Python
     or others can be added once someone confirms they need it.
   - Side effect: other extensions see the hidden document opening (ESLint
     may lint it). That is acceptable, and the same thing happens when any
     extension calls `openTextDocument`.

Documentation alone ("open a file of each language first") was considered and
rejected. The fallback fixes the empty case outright, and warm-up restores
full fidelity without user action.

### Standalone: servers must be warm for `#`

- **Opening a file isn't enough.** Starting servers on file open (see
  "Lifecycle") doesn't cover `#`, because `#` in the prompt editor never opens
  a workspace file.
- **The first `#` query starts servers.** It starts the servers selected for
  the workspace's detected languages (by root markers), within the global cap.
  `startOnLaunch` starts them when the server starts instead.
- **The regex index answers until a server is ready,** so the first `#` is
  never empty. Idle shutdown counts `#` queries as activity.
- **tsserver needs an open document.** `typescript-language-server`/`vtsls`
  answer `workspace/symbol` only from projects that an opened document has
  loaded, the same `navto` behavior as VS Code. On start, the host sends
  `didOpen` for one anchor document per root marker, using the same anchor
  rule as 7c. It keeps the anchor open while the server lives. Other servers
  may need similar per-server warm-up hooks in the defaults table.
- **Range fidelity.** The chip-icon lookup (`findSymbolKindForReference`)
  matches on name plus exact line range. It tries document symbols first, then
  workspace symbols, and `LspSymbolIndex` keeps that order. `workspace/symbol`
  may return `WorkspaceSymbol` entries without a range (LSP 3.17
  `location: { uri }` only).
  - Resolve them with `workspaceSymbol/resolve` when the server supports it.
  - Otherwise drop them from `#sym:` completions, since a `#sym:`
    reference needs a line range.

## Harness side

**Do not build a ctrlyoke LSP MCP server.** Four of the six harnesses already have
native LSP support (see research notes), and the MCP space is led by Serena, which
is far ahead of anything we would ship. Instead:

1. **Recommend, don't build.** For Codex CLI (no native LSP) and for anyone who
   wants symbol-level editing tools, point users at an established LSP MCP (Serena
   first, cclsp as the lightweight option). They install it through the existing MCP
   manager exactly like any other server. cclsp is already documented for all
   harnesses in `dev/research/CCLSP_MCP_WINDOWS_SETUP.md`.
2. **Export (later phase).** ctrlyoke's `languageServers` registry can be exported
   to harness-native LSP configs (`.lsp.json` for Claude/Qwen, `.github/lsp.json` or
   `~/.copilot/lsp-config.json` for Copilot, opencode's `lsp` block) and to a
   generated `cclsp.json`. The target shapes are in "Local config sources to
   scan". Claude Code's `.lsp.json` lives only in plugins, so its export target
   is the Qwen-compatible project `.lsp.json` or a generated plugin, not a
   project file Claude reads. Re-check that before building export. This is
   the same "Save to target" flyout `McpManagerSection` uses for MCP. The user defines a language server once and it
   powers the workspace editor and every harness. None of the harnesses except
   opencode auto-install servers, so ctrlyoke's tool dir plus export fills a real
   gap.
3. **Diagnostics gate stays in `VSCODE_LSP_MCP_PLAN.md`,** but its source becomes a
   host-neutral `DiagnosticsSource` port. The VS Code implementation uses
   `vscode.languages.getDiagnostics()` (in-process, fast). The Node implementation
   uses the managed backend's pull diagnostics. That makes `kind: "diagnostics"`
   work in standalone and CLI runs too. That plan's Phase 3 (a `ctrlyoke-ide` MCP)
   should be re-evaluated against harness-native LSP before it is built.
   As of 2026-10-06 none of `VSCODE_LSP_MCP_PLAN.md` is implemented. Its
   Phase 1 is a ROADMAP P1 item that doesn't depend on this plan. **Whoever
   builds it first defines `DiagnosticsSource` with the VS Code
   implementation**, so this plan's phase 6 only adds the Node implementation.

## Implementation phases

Staging numbers refer to
[`STANDALONE_STAGING_PLAN.md`](../active/STANDALONE_STAGING_PLAN.md).

0. **Done. Save conflicts and reload banner** (independent; **Stage I1**).
   This shipped before the standalone release.
   - `modifiedAt` on `WorkspaceFileResponse`.
   - `baseModifiedAt` on `WorkspaceFileSaveRequest`.
   - The save response returns the new `modifiedAt`.
   - The `PUT /api/workspace-viewer/file` route maps a stale save to 409.
     Today it maps errors only to 403/400/500.
   - `WORKSPACE_FILE_CHANGED` broadcast from saves, and from per-open-file
     watchers through `FileWatcherFactory` (in `CtrlYokeHostedServer`).
   - The reload/compare banner (in `WorkspaceExplorerPane.tsx`), and explorer
     directory refresh.
1. **Protocol spine** (**Done — Stage 12**, after the shared server class from
   Stage 7a).
   - A `/ws/lsp` branch in the server's `upgrade` handler, before the 404,
     with the same `?token=` check. It hands off to a **separate**
     `WebSocketServer` whose connections never reach the dashboard
     `setupWebSocket` handler.
   - A new `HostedServerOptions` field carries the `LanguageIntelligenceHost`,
     built in `createNodeHostServices` and in `extension.ts`'s hosted-server
     composition.
   - **Session lookup (decided 2026-10-07).** The hook learns which session
     serves a file from a token-gated HTTP route,
     `GET /api/lsp/session?path=<viewerPath>`, returning
     `{ session: { id, languageId } | null, reason? }` (`reason` covers "no
     server", "limit reached", "needs approval", "untrusted"). Types live in
     `src/types/HostedWorkspaceViewerTypes.ts`. The socket is then
     `/ws/lsp?server=<id>&token=…`; one socket per session serves every file
     of that language in the tab.
   - **Backend seam.** `LanguageIntelligenceHost` gets its server connections
     from an injected `LanguageServerBackend` interface (resolve a server for
     a path, start/obtain a `MessageConnection`). Stage 12 ships only the
     interface plus a test fake that speaks LSP over in-memory stdio streams;
     production composition passes a backend that resolves nothing, so the
     editor is unchanged until Stage 13 supplies `ManagedLanguageServerBackend`.
   - `LanguageIntelligenceHost` + `LspSessionProxy` in `src/server/lsp/`: id
     rewriting, didOpen ref-counting, URI ⇄ viewer-path translation,
     containment, and outbound secret redaction.
   - **Done — browser half (Stage 12b):** install `@codemirror/lsp-client`,
     share a reconnecting socket/client per session id, and wire the hook and
     client into `WorkspaceFileEditor` through a `Compartment`. Cross-file
     navigation returns the editor view after viewer-store navigation; LSP
     zero-based lines are converted to the viewer's one-based selection lines.
     Reconnect and session changes do not recreate the editor view.
   - A shared workspace-root containment helper extracted from
     `HostedWorkspaceViewerService.safeResolve`, without its user-settings
     exception.
   - Tests: proxy unit tests with a fake stdio server. A two-client test
     proves that ids don't collide, that a request from the non-synced tab
     triggers a full-text resync first, and that diagnostics reach only the
     tab whose buffer they describe. A redaction test proves that a secret
     value in a fake server's hover never reaches the client.
   - Add `src/server/lsp/LanguageIntelligenceHost.ts` to the Node-only entry
     list in `src/test/unit/SourceAuditCounters.test.ts`, next to
     `DashboardApplication.ts` and `NodeHostServices.ts`. The guard is a list
     of entry files whose reachable graph must not load `vscode`. It is not a
     directory allowlist.
2. **Managed backend** (**Stage 13**).
   - The `languageServers` schema (`definitions`, `use`, `settings`,
     `idleShutdownMinutes`, `maxRunning`, `startOnLaunch`) in
     `schemas/settings-schema.json` + `CtrlYokeSettings.ts`, followed by
     `npm run schema:update`. The three lifecycle keys go in
     `WORKSPACE_FORBIDDEN_SETTING_ROOTS`.
   - Workspace-definition approval through `UserInteractionPort.requestBatchApproval`
     (the `SecretGrantsTrustPrompt.ts` pattern).
   - The curated catalog (built-in defaults) with launch args checked against
     each server's docs and Helix `languages.toml`.
   - PATH, tool-dir, and workspace `node_modules/.bin` resolution through
     `resolveCliCommand`.
   - Spawn/idle/cap/restart lifecycle, `startOnLaunch`, and the trust gate.
     Stage 13b is implemented in `ManagedLanguageServerBackend`; tests cover
     trust refusal, remembered and hash-invalidated approvals, open-document
     protection, cap rejection, idle shutdown, LRU eviction, and crash restart.
     The conditional installed-TypeScript-server integration covers completion
     and hover through the proxy; the proxy's matching-diagnostics unit test
     covers diagnostics routing. The live browser feature path has not yet been
     manually exercised.
     Warm-on-`#` (first-`#` start and anchor documents) moved to phase 7b /
     Stage 16 on 2026-10-07, because `LspSymbolIndex` is its only consumer.

   This delivers completion, hover, definition, references, rename, signature
   help, formatting, and diagnostics.

3. **Editor UX** (**Done — Stage 14, 2026-10-07**). The editor context menu
   gates definition, references, rename, and formatting actions on the active
   session's advertised capabilities. F12 navigates to definitions; reference
   results use `path#L10-L12` rows, navigate through the viewer store, and can
   be inserted into a workflow as selection context. The existing Ctrl/Cmd-click
   and touch-tap `.cm-link` gestures remain reference navigation. Vitest covers
   capability hiding, F12 dispatch, result formatting/navigation/context
   insertion, and link gestures. Full verification passed: typecheck, lint, and
   `npm test` (extension 5,635 passing/4 pending, UI 3,476 passing, packaging
   80 passing).
4. **Language Servers settings section** (**Stage 15 — done 2026-10-07**).
   Full UX in "Settings section UX".
   - Languages strip (`use` per language) and server rows with live status
     pushed from the host.
   - Catalog tab: detected / not installed, npm one-click install into the
     tool dir with a confirmation, copyable per-OS install commands, homepage
     links, Scan again.
   - Local configs tab: scan/import from Qwen/Claude-plugin `.lsp.json`,
     Copilot `lsp.json`/`lsp-config.json`, opencode `lsp`, and `cclsp.json`.
   - Add/edit form for hand-written definitions, and Approve for pending
     workspace definitions.
   - Shared manager UI helpers are in `components/shared/` and used by both
     sections. The drawer tab and settings-search landmark are registered.
   - Verification passed: `npm run typecheck`, `npm run lint`, and `npm test`
     (extension 5,640 passing/4 pending, UI 3,489 passing, packaging 80 passing).
5. ~~**VS Code provider backend.**~~ **Dropped 2026-10-06.** See Open
   Question 1.
6. **Harness export** (**Stage 17**, done 2026-10-07): target-native exports
   for Qwen-compatible project `.lsp.json`, Copilot workspace/user configs,
   opencode workspace/user configs, and generated `cclsp.json`; the language
   server row has a shared Save flyout. `npm run typecheck` and `npm run lint`
   pass. A full `npm test` passed once (extension 5,646 passing/4 pending, UI
   3,490 passing, packaging 80 passing). The final run passed UI and packaging
   but hit the known `VsCodeDocuments > saves an open dirty document` race;
   that test passed in isolation. The Node `DiagnosticsSource` remains
   **Stage 17b, blocked** until `VSCODE_LSP_MCP_PLAN.md` Phase 1 defines the
   port.
7. **`SymbolIndex` port**, split across four stages:
   - **Done — 7a (2026-10-06).** `SymbolIndex`, `VsCodeSymbolIndex`, the
     one-time SymbolKind numbering conversion, and callers moved onto the
     port landed in decoupling **Stage 5b**. VS Code behavior is preserved.
   - **Done — 7-regex (2026-10-06).** `RegexSymbolIndex` ships with standalone
     **Stage 9** as standalone v1's `#` source.
   - **Done — 7c (2026-10-07).** VS Code cold start (independent **Stage I2**;
     see "VS Code cold start").
     - Add `FallbackSymbolIndex` in `src/completions/`, wrapping
       `VsCodeSymbolIndex` with `RegexSymbolIndex` in
       `CompletionHelpers.getCompletionCore`.
     - Add anchor-document warm-up for TS/JS in `VsCodeSymbolIndex`.
     - Tests:
       - Unit tests for `FallbackSymbolIndex`: primary empty → fallback;
         primary non-empty → primary only; same for `documentSymbols`.
       - A `VsCodeSymbolIndex` test with no TS document open: it calls
         `openTextDocument` on the anchor and never `showTextDocument`.
         With a TS document already open, it opens nothing.
   - **7b. `LspSymbolIndex`.** **Stage 16**, wired by the standalone
     composition root, with the regex index as the per-language fallback.
     Includes the warm-on-`#` rules from "Standalone: servers must be warm
     for `#`" (first-`#` start within the cap, anchor `didOpen` per root
     marker, `#` counts as idle activity).
     Reuse `FallbackSymbolIndex` if per-language fallback reduces to it;
     otherwise extend it rather than adding a second wrapper.
   - Tests: a golden test that each index produces identical `#sym:` insert
     text and icons for the same fixture symbols.

Phases 0–4 and phase 7b are host-neutral, so they work identically in the VS
Code-hosted server and in `ctrlyoke server`. `VsCodeSymbolIndex` and its 7c
warm-up are the only extension-only pieces.

## Open questions

All resolved on 2026-10-06:

1. **Should phase 5 (the VS Code fallback) exist at all? No. Dropped.**
   - The workspace editor runs only in browsers, and a browser connected to
     the VS Code-hosted server gets managed servers exactly like standalone.
     So the fallback would serve only users who are _in VS Code_, _using the
     browser editor_, _with no language server installed_. That is the
     smallest audience of any phase.
   - In return it would cost the hardest code in the plan: position mapping
     between the unsaved buffer and the saved baseline, which is correct only
     for navigation, and a second capability matrix to explain in the UI.
   - Phase 4's one-click npm install covers TS/JS, Python, JSON/CSS/HTML,
     YAML, and Bash.

   Revisit only if real usage shows hosted-browser users without servers
   asking for navigation. The `/ws/lsp` protocol boundary means it could be
   added later without browser changes.

2. **In VS Code-hosted mode, should `#` symbols ever come from managed
   servers? No.** `VsCodeSymbolIndex` is free and serves the VS Code panel
   as well, which never talks to managed servers. Starting a duplicate
   tsserver for `#` would double memory for no gain. Revisit per language only
   if VS Code's results prove worse.
   - _Corrected 2026-10-07:_ this answer originally called VS Code "already
     warm". It isn't until a document of the language has been opened.
   - Phase 7c closes that gap with the regex fallback and on-demand anchor
     documents, not with managed servers.
3. **Idle-shutdown default and a global cap.** `idleShutdownMinutes: 10` and
   `maxRunning: 4`.
   - Both are user-scope settings, since they govern machine resources.
   - Eviction picks the least recently used server with no open documents.
     A server with open documents is never stopped.
   - Warm-on-`#` respects the cap and answers from `RegexSymbolIndex` until a
     server is ready.

   The default of 4 covers a typical polyglot repo (TS + Python + JSON/YAML +
   one more) while bounding memory. tsserver alone is often 300–800 MB, and
   phones are driving laptops in this scenario.

Resolved on 2026-10-07:

4. **Should standalone start servers when it launches? Opt-in.**
   - `startOnLaunch` (user scope, default `false`) starts the selected
     servers after `server.listen()`.
   - By default servers start on the first file open or first `#` query, and
     the regex index covers the gap.
   - Eager start trades a few seconds of first-`#` fidelity for permanent
     memory on a machine that may be a laptop driven from a phone.
5. **Is there an LSP registry to pull from? Not one usable as-is.**
   - We ship a curated catalog as data, with launch args we own.
   - A mason-registry-backed "Browse more" tab is deferred, and catalog
     entries carry `masonName` so it can be added later.
   - The full reasoning is in "Settings section UX".
6. **Does the import list show only installed servers? No.**
   - The Catalog tab shows every curated entry with detected / not installed
     state.
   - Local configs shows only definitions found in other tools' config files.
   - Managed servers shows ctrlyoke's own definitions.
7. **Do we link to install? Yes.**
   - npm entries get one-click install.
   - Every other entry gets a copyable per-OS command plus a homepage link.

Resolved on 2026-09-24:

- **Two tabs on one file:** best effort and both editable, with a resync on
  tab switch, plus save-conflict detection and a reload banner. Read-only was
  rejected.
- **Workspace-scope commands:** workspaces select servers freely (`use`,
  `settings`). Workspace-declared `definitions` need one-time user approval,
  keyed on a hash of their executable fields.

## Research notes

Gathered 2026-09-24. Re-verify versions and support levels before implementing.

**CodeMirror clients.** `@codemirror/lsp-client` 6.3.0 (2026-09-17, MIT). Its source
moved to <https://code.haverbeke.berlin/codemirror/lsp-client> and the GitHub
mirror is archived. Announcement: <https://discuss.codemirror.net/t/codemirror-lsp-client/9309>.
Diagnostics landed in 6.1.0; symbol search is not documented. The alternative is
`@marimo-team/codemirror-languageserver` (actively maintained fork of
`codemirror-languageserver`).

**Harness-native LSP.**

| Harness         | Native LSP                            | Config                                                      | Auto-installs servers             |
| --------------- | ------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| Claude Code     | Yes (LSP tool)                        | plugins only (`.lsp.json` or `plugin.json` `lspServers`)    | No                                |
| Copilot CLI     | Yes                                   | `.github/lsp.json` › plugins › `~/.copilot/lsp-config.json` | No (`lsp-setup` skill scripts it) |
| Codex CLI       | No (openai/codex#8745)                | —                                                           | —                                 |
| opencode        | Yes, opt-in (`"lsp": true`)           | 30+ built-in server configs                                 | Yes                               |
| Qwen Code       | Experimental (`--experimental-lsp`)   | `.lsp.json` (Claude-compatible shape)                       | No                                |
| Antigravity CLI | Unverified (third-party reports only) | —                                                           | —                                 |

Operation coverage varies. Per the research, Claude Code's tool does not document
rename or diagnostics, Copilot CLI has rename but no diagnostics, and Qwen Code has
diagnostics but no rename.

**LSP MCP servers.** Serena (oraios/serena, about 30k stars, very active,
symbol-level read and edit tools). mcp-language-server (isaacphi, about 1.6k stars,
Go, one server per instance). cclsp (ktnyt/cclsp, about 675 stars, multi-server
config, fuzzy position matching for LLM-supplied coordinates).

**Install strategies elsewhere.** Zed auto-downloads everything. mason.nvim is an
opt-in package manager. Helix is PATH-only and has `hx --health` for diagnosis.
opencode auto-downloads. This plan's "PATH + npm one-click + hints" is a middle
ground between Helix and mason.

**VS Code providers.** All `vscode.execute*Provider` commands used here are in the
official commands reference. They operate on the live `TextDocument` (the disk
content unless VS Code itself holds unsaved edits). Virtual-scheme documents are
served inconsistently across language services (microsoft/vscode#49069), which is
why this plan rejects the buffer-mirroring variant A′. Precedent for bridging VS
Code providers out over a socket: `shillem.vscode-lsp-bridge` (experimental, built
for Claude Code's `.lsp.json`, macOS/Linux only).

**WebSocket proxying.** `vscode-ws-jsonrpc` lives in TypeFox/monaco-languageclient
(active). `qualified/lsp-ws-proxy` has been unmaintained since 2023 and appears to
use one process per connection. No maintained precedent was found for sharing one
server across several browser clients, so `LspSessionProxy` is custom work and the
main engineering risk in phase 1.

### Added 2026-10-07

**LSP catalogs.**

- **mason-registry** (<https://github.com/mason-org/mason-registry>,
  Apache-2.0).
  - Publishes `releases/latest/download/registry.json.zip` (about 75 KB
    zipped, 555 KB unzipped, several releases a day).
  - 600 packages, 330 in category `LSP`. Of those, 160 are GitHub binaries
    (126 with a `win_x64` asset), 84 npm, 29 PyPI, 21 cargo, 9 Go, and the
    rest other ecosystems.
  - `bin` names executables only. No entry carries launch args.
  - Entry licenses vary: mostly MIT/Apache-2.0, some GPL/AGPL, and 8
    `proprietary`.
- **nvim-lspconfig** (Apache-2.0): about 419 `lsp/*.lua` files with
  `cmd`/`filetypes`/`root_markers`, often as Lua functions.
- **Helix `languages.toml`** (MPL-2.0): about 170 `[language-server.*]`
  tables with `command` + `args`.
- **Microsoft implementors list** (`gh-pages/_implementors/servers.md`,
  CC-BY-4.0): links only.
- **opencode** (`packages/opencode/src/lsp/server.ts`): about 40 built-ins,
  each with an install strategy of npm/bun package, GitHub release download,
  or toolchain command.
- **`mason4agents`** reportedly reuses the mason registry for coding agents.
  Not inspected.

**Harness LSP config shapes.**

- Claude Code: <https://code.claude.com/docs/en/plugins-reference>
  (`lspServers`) and <https://code.claude.com/docs/en/plugins/code-intelligence>.
- Copilot CLI:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/add-lsp-servers>.
- opencode: <https://opencode.ai/docs/lsp/>. The docs say LSP is off by
  default, which conflicts with its auto-install code; re-check.
- Qwen Code: <https://qwenlm.github.io/qwen-code-docs/en/users/features/lsp/>.
- cclsp: <https://github.com/ktnyt/cclsp>.

**VS Code cold start.** Verified from the bundled
`extensions/typescript-language-features` 10.0.0 `package.json` and
`dist/extension.js`, and from vscode `main`:

- `lazyClientHost.ts` (lazy provider registration).
- `tsServer/bufferSyncSupport.ts`: `listen()` syncs all
  `workspace.textDocuments`, and `TabResourceTracker` gates diagnostics only.
- `languageFeatures/workspaceSymbols.ts`: `navto` with `file: undefined`
  under `allOpenProjects`.
- `workbench/api/browser/mainThreadDocuments.ts`:
  `BoundModelReferenceCollection` with a 3-minute, 50-reference, 80 MB limit.

The activation-events reference
(<https://code.visualstudio.com/api/references/activation-events>) has no
workspace-symbol event. Still unverified:

- Pylance's behavior with no `.py` file open.
- Whether re-opening a hidden document resets the 3-minute timer. 7c's
  per-query re-open doesn't depend on it.
