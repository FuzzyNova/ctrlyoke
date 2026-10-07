# Workspace Editor Language Intelligence Plan

**Status (2026-10-06):** Proposed and decided. The `SymbolIndex` port and
`VsCodeSymbolIndex` (phase 7a) plus `RegexSymbolIndex` (phase 7-regex, staging
Stage 9) are complete. Remaining phases are ready to implement in sequence.
Every code reference was re-audited against `src/` on 2026-10-06, and every
open question is resolved. Phase 5, the VS Code provider backend, is **dropped**.

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

**Related plans:**

- [`VSCODE_LSP_MCP_PLAN.md`](./VSCODE_LSP_MCP_PLAN.md): the diagnostics
  end-condition gate and the harness-facing IDE MCP. This plan narrows its
  harness scope (see "Harness side" below) and gives its diagnostics gate a
  host-neutral source.
- [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md): its
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
   - `ws` plus a token-gated hosted server (`CtrlYokeHostedServer.ts`). It
     uses `noServer: true` and authenticates in an `upgrade` handler that
     currently returns 404 for every path except `/ws`, so a second path is
     one branch in that handler.
   - Windows `.cmd` launcher resolution (`resolveCliCommand` in
     `src/core/harness/shared/CliLauncherResolver.ts`).
   - An `isWorkspaceTrusted` predicate on the orchestrator.
   - Secret redaction for hosted responses (`SecretRedactionMiddleware.ts`,
     `secretRedactionService`).
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
  // Lifecycle (user scope only — see Open Question 3).
  "idleShutdownMinutes": 10,
  "maxRunning": 4
}
```

`idleShutdownMinutes` and `maxRunning` govern machine resources, so they are
user-scope settings. Add both to `WORKSPACE_FORBIDDEN_SETTING_ROOTS` in
`CtrlYokeConfigService.ts` rather than inventing a new rule.

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
   through `CliLauncherResolver` on Windows. This is the cclsp `spawn EINVAL`
   gotcha in `dev/research/CCLSP_MCP_WINDOWS_SETUP.md`.
2. **Built-in defaults** with no selection, shipped as data (a table of
   well-known servers: id, command, languages, extensions, root markers, install
   hint). Each default is used only when its command resolves on `PATH` or in the
   ctrlyoke tool dir. Where several defaults cover one language, the table order
   decides.
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
already has: `.lsp.json` (Claude Code and Qwen Code share this shape),
`.github/lsp.json` and `~/.copilot/lsp-config.json` (Copilot CLI), opencode's `lsp`
config, and `cclsp.json` (`CCLSP_CONFIG_PATH` or the default location). It offers
Import into ctrlyoke's registry. This reuses the existing "scan → import into
scope" mental model instead of inventing a new one.

### Lifecycle, cost, and safety

- **Lazy:** a server starts when the browser first opens a matching file, never at
  extension activation.
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
- **Trust gate:** never spawn in an untrusted workspace (`isWorkspaceTrusted`,
  which defaults to `true` headlessly the same way the orchestrator's does). In
  standalone, spawning follows the server's own trust setting.
- **Path containment:** every URI the browser sends is resolved through the same
  `safeResolve` rules as `HostedWorkspaceViewerService`. Results that point outside
  the workspace roots (for example lib `.d.ts` files in a global install) are
  returned as read-only locations. The editor may preview them but never writes them.
- **Multi-file edits (rename, code actions):** the proxy applies the
  `WorkspaceEdit` itself. The open buffer is edited in the browser. Files that
  aren't open are written through `HostedWorkspaceViewerService` (same EOL
  preservation and atomic write), and then a `workspace/didChangeWatchedFiles`
  notification is sent. A rename that touches unopened files asks for confirmation
  with a file count in the browser (a built-in modal, per the native-vs-built-in
  modal policy).

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
- **Saves use optimistic concurrency.** `WorkspaceFileResponse` gains
  `modifiedAt`; today it has none. `WorkspaceFileSaveRequest` gains a
  `baseModifiedAt`, and the save response returns the new `modifiedAt`. If disk has
  changed since then, `HostedWorkspaceViewerService.saveFile` returns 409 instead
  of overwriting, and the editor offers Overwrite / Reload / Compare. (Compare
  reuses the existing diff pane.)
- **"This file has been modified. Reload?"** A successful save broadcasts a
  `WORKSPACE_FILE_CHANGED` dashboard message (path, new `modifiedAt`, originating
  client id). Changes from outside ctrlyoke (a harness, git, another editor) come
  from the existing `FileWatcherFactory` port (`src/core/HostPorts.ts`). The VS
  Code-hosted server can use `VsCodeFileWatcherFactory` today. Standalone uses
  the chokidar implementation from decoupling Phase 2 (staging Stage 1).
  - Watch only files open in some tab: one watcher per open path,
    ref-counted. Don't watch the whole tree.
  - The same broadcast also refreshes that file's directory in any open
    explorer. Today the explorer refreshes only after its own operations or a
    manual refresh.
  - Tree entries already carry `modifiedAt` (`stat.mtimeMs`), so the file
    response reuses the same field and units.
    Every other tab with that file open reacts:
  - no unsaved edits: reload silently and keep the cursor and scroll position;
  - unsaved edits: show a non-blocking banner, "This file changed on disk.
    Reload / Compare / Keep mine". "Keep mine" means the next save goes through
    the 409 path above.

  The proxy sends `workspace/didChangeWatchedFiles` for the path either way.

None of this is LSP-specific. The save conflict and reload banner fix a gap the
workspace editor has today: a second tab currently overwrites the first one's save
without warning. They can ship ahead of phase 1.

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
- Re-verify `@codemirror/lsp-client`'s peer ranges against the installed
  `@codemirror/state` 6.7.x and `@codemirror/view` 6.43.x when installing.
  All `@codemirror/*` packages live in the root `package.json`; the webview
  has no separate one.
- `WorkspaceFileEditor` gets one optional extension slot built from a
  `useLanguageIntelligence(filePath)` hook. The hook asks the host which session
  (if any) serves the file, opens `/ws/lsp`, and returns CodeMirror extensions.
  With no session the editor behaves exactly as it does today.
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
- New context menu items in `useWorkspaceEditorContextMenu.tsx`: Go to Definition,
  Find All References, Rename Symbol, Format Document. Each is gated on the
  capabilities the session advertised.

## `#` symbol completions in the prompt editor (standalone)

`CodeMirrorEditor.tsx`'s `#` trigger gets its items from the host, not the
browser:

1. `REQUEST_COMPLETIONS` goes to
   `PromptEditorSupportService.handleCompletionRequest`.
2. When the VS Code host has editor selections, it first sends a
   `COMPLETIONS_RESPONSE` with `partial: true` containing **only those
   selections** (`getHashSelectionCompletions`).
3. It then sends the final response: selections plus workspace symbols
   (`getHashCompletions`, the exported entry point).

`#` never returns files. Standalone has no host editor, so its `#` response
is symbols only. Today these host call sites depend on VS Code for symbols:

| Call site (`src/completions/CompletionHelpers.ts` unless noted)                                                                        | Uses                                                                   | Purpose                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `getHashCompletions` (exported) → `getSymbolCompletions` → `getWorkspaceSymbolCandidates` → `getWorkspaceSymbols` (all module-private) | `vscode.executeWorkspaceSymbolProvider`                                | `#sym:` completion items                                    |
| `findSymbolKindForReference(uri: vscode.Uri, …)` (exported; called by `PromptEditorSupportService.validateContextReference`)           | `executeDocumentSymbolProvider`, then `executeWorkspaceSymbolProvider` | the symbol-kind icon on an already-inserted `#sym:` chip    |
| `ContextMenuReferenceCommands.ts` `tryBuildSymbolReference`                                                                            | `executeDocumentSymbolProvider`                                        | VS Code editor context menu (a boundary file; stays native) |

`getWorkspaceSymbolCandidates` issues the full query plus a 3-character
prefix query and deduplicates the results. That strategy compensates for
providers that match strictly, so it belongs **above** the port, in the
completion core, where every index benefits from it.

In standalone none of these exist. Earlier revisions of
`STANDALONE_SERVER_PLAN.md` planned a regex heuristic plus a one-off
`LspSymbolClient`. This plan replaces both with one port that has three
implementations:

```typescript
interface SymbolIndex {
  workspaceSymbols(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]>;
  documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]>;
}

interface IndexedSymbol {
  name: string;
  kind: LspSymbolKind; // project-owned, LSP numbering (1-based)
  viewerPath: string; // forward-slash workspace-relative, same as #sym: paths
  startLine: number; // 1-based, inclusive — the #sym: range convention
  endLine: number;
  containerName?: string;
}
```

- **Implementations, in delivery order:**
  1. **`VsCodeSymbolIndex`** (extension-only). It wraps the two execute
     commands exactly as today, so VS Code behavior doesn't change. It lands
     in decoupling Stage 5.
  2. **Done — 7-regex (2026-10-06).** `RegexSymbolIndex` (Node-only) is
     standalone v1's `#` source and the per-language fallback for later LSP
     integration.
     - It scans source files by extension (TS/JS, Python, Go, Rust, Java,
       C#, and C/C++ patterns) and caches results per file by `mtime`.
     - `endLine` comes from bracket matching in brace languages and from
       indentation in Python. When no end is found, `endLine = startLine`.
     - After the LSP stages it stays as the per-language fallback.
  3. **`LspSymbolIndex`** (Node-only). It lands in staging Stage 16.
     - It issues `workspace/symbol` and `textDocument/documentSymbol` through
       `LanguageIntelligenceHost`.
     - It fans out to every running or startable server for the workspace,
       within the global cap.
     - It merges the results and applies `maxResults`.

  The composition root picks one index per host: VS Code-hosted uses
  `VsCodeSymbolIndex` (Open Question 2). Standalone uses the LSP index,
  falling back to the regex index per language.

- **The callers become host-neutral.** `getSymbolCompletions` and
  `findSymbolKindForReference` take a `SymbolIndex` instead of calling
  `vscode.commands`, and they build `#sym:` values from `IndexedSymbol`.
  `findSymbolKindForReference` takes a viewer path instead of a `vscode.Uri`.
  This is `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 6 item 4 (the
  Node-capable completion core), and this plan supplies its symbol half.
- **SymbolKind numbering.** `vscode.SymbolKind` is 0-based and LSP `SymbolKind` is
  1-based (`File` is 0 in VS Code and 1 in LSP). `mapSymbolKindToCompletionKind`
  (module-private) and `mapSymbolKindToReferenceKind` (exported, also used by
  `ContextMenuReferenceCommands.ts`) currently take `vscode.SymbolKind`. Convert
  to the project-owned LSP numbering in `VsCodeSymbolIndex`, once, and change the
  mappers to take `LspSymbolKind`. Converting anywhere else gives off-by-one icons
  and reference kinds.
- **Servers must be warm for `#`.** Starting on file open only (see "Lifecycle")
  is not enough, because `#` in the prompt editor doesn't open a workspace file.
  The first `#` query starts the servers selected for the workspace's detected
  languages (by root markers), within the global cap. Until a language's
  server is ready, that query answers from `RegexSymbolIndex`, so the first `#`
  is never empty. Idle shutdown counts `#` queries as activity.
- **tsserver only searches loaded projects.** `typescript-language-server`/`vtsls`
  answer `workspace/symbol` from projects that some opened document has loaded.
  With no file open, results are empty. On start, the host opens one anchor
  document per root marker (for example, the first `include`d file of each
  `tsconfig.json`) and keeps it open while the server lives. Other servers may
  need similar per-server "warm-up" hooks in the defaults table.
- **Range fidelity.** The chip-icon lookup matches on name plus exact line range,
  which is why it falls back to workspace symbols today (see the
  `findSymbolKindForReference` doc comment). Keep that fallback order in
  `LspSymbolIndex`. `workspace/symbol` may return `WorkspaceSymbol` entries
  without a range (LSP 3.17 `location: { uri }` only). Resolve them with
  `workspaceSymbol/resolve` when the server supports it, and otherwise drop them
  from `#sym:` completions, since a `#sym:` reference needs a line range.

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
   generated `cclsp.json`. This is the same "Save to target" flyout
   `McpManagerSection` uses for MCP. The user defines a language server once and it
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
     watchers through `FileWatcherFactory`.
   - The reload/compare banner in `WorkspaceFileEditor`, and explorer
     directory refresh.
1. **Protocol spine** (**Stage 12**, after the shared server class from
   Stage 7a).
   - A `/ws/lsp` branch in the server's `upgrade` handler, with the same
     token check.
   - `LanguageIntelligenceHost` + `LspSessionProxy` in `src/server/lsp/`: id
     rewriting, didOpen ref-counting, URI ⇄ viewer-path translation,
     containment, and outbound secret redaction.
   - The `useLanguageIntelligence` hook and a CodeMirror client wired into
     `WorkspaceFileEditor`.
   - Tests: proxy unit tests with a fake stdio server. A two-client test
     proves that ids don't collide, that a request from the non-synced tab
     triggers a full-text resync first, and that diagnostics reach only the
     tab whose buffer they describe. A redaction test proves that a secret
     value in a fake server's hover never reaches the client.
   - Add `src/server/lsp/` to the Node-only guard roots.
2. **Managed backend** (**Stage 13**).
   - The `languageServers` schema (`definitions`, `use`, `settings`,
     `idleShutdownMinutes`, `maxRunning`) in `schemas/settings-schema.json` +
     `CtrlYokeSettings.ts`, followed by `npm run schema:update`.
   - Workspace-definition approval through `UserInteractionPort.requestBatchApproval`
     (the `SecretGrantsTrustPrompt.ts` pattern).
   - Built-in defaults table; PATH/tool-dir resolution through
     `resolveCliCommand`.
   - Spawn/idle/cap/restart lifecycle and the trust gate.

   This delivers completion, hover, definition, references, rename, signature
   help, formatting, and diagnostics.

3. **Editor UX** (**Stage 14**). Context menu items, the references panel,
   rename confirmation for multi-file edits, F12, and capability gating.
4. **Language Servers settings section** (**Stage 15**).
   - Status per server: running, idle, missing, or limit reached.
   - npm one-click install into the tool dir.
   - Install hints for native servers.
   - Scan/import from cclsp and harness-native configs.
5. ~~**VS Code provider backend.**~~ **Dropped 2026-10-06.** See Open
   Question 1.
6. **Harness export + `DiagnosticsSource` port** (**Stage 17**, coordinated
   with `VSCODE_LSP_MCP_PLAN.md`; see "Harness side" item 3).
7. **`SymbolIndex` port**, split across three stages:
   - **Done — 7a (2026-10-06).** `SymbolIndex`, `VsCodeSymbolIndex`, the
     one-time SymbolKind numbering conversion, and callers moved onto the
     port landed in decoupling **Stage 5b**. VS Code behavior is preserved.
   - **Done — 7-regex (2026-10-06).** `RegexSymbolIndex` ships with standalone
     **Stage 9** as standalone v1's `#` source.
   - **7b. `LspSymbolIndex`.** **Stage 16**, wired by the standalone
     composition root, with the regex index as the per-language fallback.
   - Tests: a golden test that each index produces identical `#sym:` insert
     text and icons for the same fixture symbols.

Phases 0–4 and phase 7b are host-neutral, so they work identically in the VS
Code-hosted server and in `ctrlyoke server`. `VsCodeSymbolIndex` is the only
extension-only piece.

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
   servers? No.** `VsCodeSymbolIndex` is free, already warm, and serves the
   VS Code panel as well, which never talks to managed servers. Starting a
   duplicate tsserver for `#` would double memory for no gain. Revisit per
   language only if VS Code's results prove worse.
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
| Claude Code     | Yes (LSP tool)                        | `.lsp.json`, plugins                                        | No                                |
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
