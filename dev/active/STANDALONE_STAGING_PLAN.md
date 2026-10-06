# Standalone Server Staging Plan

**Status (2026-10-06):** Stages 1–4 are complete; continue at Stage 5a.
This document only sets the order of work. It contains no design. The design lives
in the three plans below, and this file arranges their remaining work into
stages that can each be shipped on their own. All four documents were
re-audited against `src/` on 2026-10-06.

**Plans that own the content:**

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md):
  the shared foundation. It owns the Node-only runtime graph, host ports, the
  host-neutral router, and the dashboard application.
- [`STANDALONE_SERVER_PLAN.md`](STANDALONE_SERVER_PLAN.md): `ctrlyoke server`.
  It owns Node host composition, the shared HTTP/WebSocket server, launch UX,
  browser storage, themes, and packaging.
- [`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](../backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md):
  LSP in the browser workspace editor, and the `SymbolIndex` port.

This table replaces the "Cross-Plan Execution Order" table that used to live
in the decoupling plan. If a phase number in any of the three plans disagrees
with a stage here, this table wins.

## Is the order decoupling → standalone → LSP right?

**Yes, with three refinements.** We checked this against the code rather than
assuming it.

1. **Decoupling has to come first.** The standalone server needs to construct
   `WorkflowOrchestrator`, the dashboard router, and its services in a process
   where `vscode` cannot be loaded. The initial audit found four blockers:
   - `WebviewMessageRouter` imported `vscode` and made 16 `executeCommand`
     calls. Stage 3 has now removed that dependency.
   - `CtrlYokeWebviewProvider` is both the VS Code view and the only place
     that builds the dashboard application: router, settings sync, serializer,
     secret registry, and interaction port.
   - `CtrlYokeHostedServer` routes every message through that provider.
   - `CliIntegration` picks the PTY path by checking for VS Code
     (`"getExtensionContext" in platform`). Under a standalone adapter that
     check would silently send interactive steps to `stdio: inherit` instead
     of the dashboard terminal.

   None of these can be patched from the standalone side.

2. **Standalone comes before LSP.** LSP phases 0–4 are host-neutral and would
   already work in the VS Code-hosted browser today. Building them first would
   still be wrong, for three reasons:
   - The `/ws/lsp` socket would land in `CtrlYokeHostedServer` before
     Stage 7a turns that class into the shared server, so it would have to be
     reworked.
   - The settings section would build on `WebviewSettingsSync` before Stage 4
     decouples it.
   - The editor's language features matter most where there is no VS Code
     next to the browser, which is the standalone case.
3. **Three pieces move out of the LSP plan.**
   - **The VS Code half of the `SymbolIndex` port moves into decoupling
     (Stage 5).** It is exactly the seam Phase 6's completion core needs, and
     doing it later would mean refactoring `CompletionHelpers.ts` twice.
   - **`RegexSymbolIndex` ships with standalone v1 (Stage 9).** Standalone
     `#` symbol completion gets regex symbols first. The LSP plan later adds
     `LspSymbolIndex` on top, behind the same port.
   - **LSP phase 0 is independent.** That phase covers save conflicts and the
     reload banner, and it fixes a bug the hosted editor already has: two tabs
     silently overwrite each other's saves. It can land at any time and should
     land before the standalone release (Stage 11), because phone plus laptop
     is the standalone headline scenario.

## Staging Table

Each stage is sized for one session: implement, verify, commit. "Done when"
names the guard or test that proves it, not just the code change.

### Track A: Finish decoupling

| Stage | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owning plan / phase                        | Prerequisite | Done when                                                                                                                                                                                                                                                  |
| ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | **Done.** Node watcher (`chokidar@5`, bundled) plus a shared contract suite. Thread the existing `FileWatcherFactory` into `ExternalRunWatchSession` (×3) and `ExecutionRootCoordinationWatchSession` (×1).                                                                                                                                                                                                                                                                                                                      | Decoupling Phase 2                         | None         | One contract suite covers create/change/delete, atomic temp-file rename, glob filtering, and dispose, and runs against both implementations. `vscodeImportersReachableFromOrchestrator` drops 4 → 2; watcher calls outside `VsCodeFileWatcher` drop 5 → 1. |
|     2 | **Done.** Command/domain split and `PlatformAdapter` cleanup:<br>• Split `ExternalFileTrustPrompt` into a host-neutral approval module and a VS Code opener.<br>• Move `WorkflowCommandHandler` onto `DashboardHostActions` (`focusDashboard`, `openWorkspaceTarget`).<br>• Make `TemplateManager` take explicit paths.<br>• Replace the CliIntegration duck typing with an explicit `interactiveTerminal` capability.<br>• Delete `isVsCode()` and `openTextFile()`, and move `focusDashboard` into host actions.               | Decoupling Phase 3                         | Stage 1      | `vscodeImportersReachableFromOrchestrator` = 0 and `coreVsCodeAdapterConstructions` = 0, with both baselines lowered. A unit test proves a non-VS Code host declaring `embedded-pty` takes the PTY path and `inherit-stdio` takes stdio.                   |
|     3 | **Done.** Make the router host-neutral:<br>• Implement every `DashboardHostActions` call site from the Phase 4 table.<br>• Route run/pause/resume/stop and worktree merge directly to the orchestrator.<br>• Replace worktree-management notices with scoped error replies and remove routine success notices.                                                                                                                                                                                              | Decoupling Phase 4 (router half)           | Stage 2      | `WebviewMessageRouter.ts` has no `vscode` import and is removed from the boundary allowlist. The boundary `show*Message` baseline drops 46 → 41. Router tests use a fake `DashboardHostActions` with no optional methods and prove two-client reply scoping. |
|     4 | Decouple the shared UI services: `WorkflowSerializer`, `WebviewSettingsSync` (including extracting `ServerCertificateService`), `PromptEditorSupportService`, and `HarnessFileMessageService`. `KeyValueStore` gains `get`, which replaces `vscode.Memento`.                                                                                                                                                                                                                                                                     | Decoupling Phase 5 items 2–5               | Stage 3      | None of these four files imports `vscode` or `VsCodeWorkspaceRoot`. The serializer and settings tests run with Node host services.                                                                                                                         |
|     5 | Utilities and the completion core:<br>• Split `FileSystemUtils`.<br>• Build the Node completion core on `git ls-files` with a walker fallback.<br>• Add a project-owned completion-kind enum, used by Branch/SlashToken/Script helpers.<br>• Move the `package.json` watcher onto the factory.<br>• Add the **`SymbolIndex` port with `VsCodeSymbolIndex`** and LSP `SymbolKind` numbering (LSP plan phase 7a).<br>• Add the **`EditorContextSource` port with `VsCodeEditorContextSource`** for selections and output channels. | Decoupling Phase 6, plus LSP plan phase 7a | Stage 4      | `PromptEditorSupportService.getCompletionItems` reaches no `vscode` import. Golden tests show that, in VS Code, `#sym:` insert text and icons are unchanged and the panel's `#` partial response still lists the current editor selections.                |
|     6 | Extract `DashboardApplication` from `CtrlYokeWebviewProvider`, and make `CtrlYokeHostedServer` depend on the `DashboardClientEndpoint` interface instead of the provider.                                                                                                                                                                                                                                                                                                                                                        | Decoupling Phase 4 (application half)      | Stage 5      | A new `SourceAuditCounters` root asserts that `DashboardApplication.ts` and `CtrlYokeHostedServer.ts` reach no `vscode` load. The VS Code panel and the hosted browser still pass the existing two-tab scoping tests.                                      |

### Track B: Standalone server

| Stage | Work                                                                                                                                                                                                                                                                                                      | Owning plan / phase                                            | Prerequisite                         | Done when                                                                                                                                                                                                         |
| ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    7a | Node host services and the shared server:<br>• `createNodeHostServices(cwd)`, including `FileKeyValueStore`, a persisted `ServerTokenStore` over `OsCredentialStore`, and the chokidar factory.<br>• Turn `CtrlYokeHostedServer` into the one options-object server class over `DashboardClientEndpoint`. | Standalone Phases 5–7 (+ Decoupling Phase 7 items 1–4)         | Stage 6                              | An in-process test boots the server from Node host services alone, connects two WebSocket clients, and completes a workflow run. The VS Code-hosted server still passes its existing tests.                       |
|    7b | Browser rendering and storage:<br>• Static default themes, with a guard test.<br>• Shim `workspaceKey` plus `storageVersion`.<br>• Rename `vsCodeStateStorage` → `webviewStateStorage`.<br>• Host-aware 401/error page text.                                                                              | Standalone Phase 4 and "State Persistence"                     | Stage 7a                             | Every `var(--vscode-*)` the webview references has a default, enforced by a test. With no captured vars, the hosted server serves the defaults. Drafts from two workspaces served on the same port don't collide. |
|     8 | The `ctrlyoke server` command and launch UX:<br>• Flags.<br>• Tokenized URL, OSC 8 link, terminal QR, and TLS hint.<br>• `--open`.<br>• `--https` generates a cert through `ServerCertificateService`.<br>• npm package entries for `out/server/`, `out/ui/webview-react/`, and `out/runtime-deps/`.      | Standalone Phase 10                                            | Stage 7b                             | `npm pack` output runs `ctrlyoke server` from a clean temp directory, and a browser completes a workflow. The packaging test lists the new entries.                                                               |
|     9 | Standalone prompt-editor completions: files from the Stage 5 core, `#` symbols from **`RegexSymbolIndex`**, and empty selection completions.                                                                                                                                                              | Standalone Phase 8, plus LSP plan phase 7 (`RegexSymbolIndex`) | Stage 8                              | The golden `#sym:` test covers `RegexSymbolIndex` on the shared fixture. `@`, `#`, `~`, and `/` completions work in a standalone browser.                                                                         |
|    10 | Retire the Node-side shim: drop `registerCliAdapter`, remove the `vscode` alias from the cli/mcp/worker bundles, and delete `vscode-shim.ts`.                                                                                                                                                             | Decoupling Phase 8                                             | Stage 9                              | `esbuild.js` contains no `vscode-shim` alias. A metafile check fails if any Node bundle includes `vscode` or a `src/platform/VsCode*` file.                                                                       |
|    11 | Manual verification and user docs: `docs/` page for `ctrlyoke server`, the CLI reference, and the phone + laptop scenario.                                                                                                                                                                                | Standalone "Manual verification"                               | Stages 8–10 and Independent Stage I1 | The Track 3 checklist in the standalone plan passes on Windows and on Linux or macOS. Docs build and `npm run check:docs` passes.                                                                                 |

### Track C: Workspace editor language intelligence

| Stage | Work                                                                                                                                                 | Owning plan / phase                                    | Prerequisite                  | Done when                                                                                                                                       |
| ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|    12 | Protocol spine: `/ws/lsp` on the shared server, `LanguageIntelligenceHost`, `LspSessionProxy`, `useLanguageIntelligence`, and the CodeMirror client. | LSP phase 1                                            | Stage 8                       | Proxy unit tests pass against a fake stdio server, including the two-client test. Outbound LSP traffic is secret-redacted.                      |
|    13 | Managed backend: the `languageServers` schema, approval of workspace definitions, built-in defaults, lifecycle, the cap, and the trust gate.         | LSP phase 2                                            | Stage 12                      | TypeScript completion, hover, rename, and diagnostics work in the browser editor in both hosts. The cap and idle shutdown are covered by tests. |
|    14 | Editor UX: context menu, references panel, multi-file rename confirmation, F12, and capability gating.                                               | LSP phase 3                                            | Stage 13                      | Every menu item is hidden when the session doesn't advertise its capability.                                                                    |
|    15 | Language Servers settings section: status, npm one-click install, install hints, and scan/import.                                                    | LSP phase 4                                            | Stage 13                      | Scanning finds `.lsp.json`, Copilot, opencode, and cclsp configs, and imports them into the chosen scope.                                       |
|    16 | `LspSymbolIndex` for standalone `#`, with the regex index as the per-language fallback.                                                              | LSP phase 7b                                           | Stages 9 and 13               | The golden test covers all three indexes. Standalone `#` returns LSP symbols when a server is available.                                        |
|    17 | Harness export and the `DiagnosticsSource` Node implementation.                                                                                      | LSP phase 6, coordinated with `VSCODE_LSP_MCP_PLAN.md` | Stage 13; that plan's Phase 1 | `kind: "diagnostics"` works in a standalone run. Export writes each harness-native LSP config.                                                  |

### Independent stages (not on the critical path)

| Stage | Work                                                                                                                                                                                                                  | Owning plan / phase | Prerequisite                                                                                              | Done when                                                                                                                                                                 |
| ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    I1 | Save conflicts and reload banner:<br>• `modifiedAt`/`baseModifiedAt` and 409 on a stale save.<br>• `WORKSPACE_FILE_CHANGED` broadcast, and a viewer refresh on external change.<br>• Reload/Compare/Keep-mine banner. | LSP phase 0         | None in the VS Code-hosted server (VS Code watcher). Standalone external-change detection needs Stage 7a. | A two-tab test: the second save returns 409, and the other tab reloads silently when it has no unsaved edits or shows the banner when it does. Must land before Stage 11. |

## Notes

- **Track A session split (2026-10-06).** Stages 3, 4, and 5 are each too
  large for one session, so they run as sub-stages in this order. Each
  sub-stage commits on its own, and the parent stage's "done when" applies
  once its last sub-stage lands.
  - **3a done:** define the full `DashboardHostActions`, add the VS Code
    implementation, and move every host-native router call site (every row
    except run/pause/resume/stop, `MERGE_WORKTREE`, and the five worktree
    `show*Message` calls) onto it, with `unsupported` replies.
  - **3b done:** extension commands and the router call the same orchestrator
    run/pause/resume/stop methods; merge calls the orchestrator directly with
    scoped failures. Worktree errors use scoped replies, routine success
    notices were removed, and the router has no `vscode` import.
  - **4a done:** `KeyValueStore.get`, `WorkflowSerializer`, and
    `HarnessFileMessageService` use host-neutral ports and tests with Node host fakes.
  - **4b:** `WebviewSettingsSync`, `ServerCertificateService`,
    `HostedServerControl`, and `PromptEditorSupportService`'s own direct
    `vscode`/`VsCodeWorkspaceRoot` uses (it still reaches `vscode` through
    `CompletionHelpers` until Stage 5b).
  - **5a done:** split `FileSystemUtils`, add `COMPLETION_ITEM_KINDS`, extract the
    shared search walker, and move `ScriptCommandCompletionHelpers` onto
    injected roots and the watcher factory.
  - **5b:** `CompletionCore`, the `SymbolIndex` and `EditorContextSource`
    ports with their VS Code implementations, and the golden tests.
- **Phase 5 of the LSP plan (the navigation-only VS Code provider backend) is
  dropped.** It isn't scheduled. The reasoning is in that plan's resolved open
  questions.
- **Each stage updates its owning plan's status lines in the same commit.**
  This file only needs a change when the order changes.
- **`npm run test:harness` is never part of any stage's "done when".**
  `npm test` plus the named guards are the bar.
- **`VSCODE_LSP_MCP_PLAN.md` Phase 1 (diagnostics end condition) is a
  separate ROADMAP P1 item.** It doesn't depend on this sequence. It should
  define the `DiagnosticsSource` port with a VS Code implementation, so that
  Stage 17 only adds the Node implementation.
