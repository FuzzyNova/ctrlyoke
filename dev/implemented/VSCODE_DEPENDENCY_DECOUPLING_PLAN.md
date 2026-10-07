# VS Code Dependency Decoupling Plan

**Status (2026-10-06): Implemented.** Staging Track A (Stages 1–6, run as
sub-stages 3a–5c) is complete, and Phases 0–6 are done. The two phases that
only the standalone server can finish moved to
[`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md) when this
plan closed: Phase 7 is that plan's Phases 5–6 plus its Phase 10 guard root
(Stage 7a), and Phase 8 is its Phase 11 (Stage 10). Done:

- Phase 0 (dependency guards).
- Phase 1 (host composition).
- Phase 2 (Node watcher and remaining watcher sites).
- Phase 3 (command/domain split and adapter cleanup).
- Phase 4: the router half (Stage 3) and the application half (Stage 6,
  `DashboardApplication` + `DashboardClientEndpoint`).
- Phase 5 (shared UI services, Stage 4) and Phase 6 (utilities and the
  completion core, Stage 5).
- Router detail from Stage 3: `DashboardHostActions` owns native dashboard
  actions, `WebviewMessageRouter` receives host actions and named roots, and
  missing optional capabilities return scoped typed `unsupported` results.
  Run controls and worktree merge dispatch directly to the orchestrator;
  worktree errors use scoped replies.
- Every prerequisite from
  [`BROWSER_USER_FEEDBACK_PLAN.md`](./BROWSER_USER_FEEDBACK_PLAN.md).
- An early pass that removed `vscode` from the runtime graphs of the
  standalone CLI and the MCP server (see "CLI runtime graph" below).

Every table below was re-audited against `src/` on 2026-10-06. Where an older
dated note disagrees with "Current snapshot", the snapshot is correct.

This is the shared foundation that lets `ctrlyoke run` and the future
`ctrlyoke server` use a Node-only runtime graph instead of the CLI esbuild
`vscode-shim`.

**Sequencing:** [`STANDALONE_STAGING_PLAN.md`](../active/STANDALONE_STAGING_PLAN.md)
is the only authoritative order for this plan,
[`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md), and
[`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](../backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md).
This plan's phases mapped to staging Stages 1–6 (Track A). Phases 7 and 8
moved to the standalone plan (Stages 7a and 10).

**Related plans:**

- [`BROWSER_USER_FEEDBACK_PLAN.md`](./BROWSER_USER_FEEDBACK_PLAN.md)
  (implemented)
- [`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md)
- [`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](../backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md):
  supplies the `SymbolIndex` port that Phase 6 item 4 adopts.
- [`VISUAL_STUDIO_EXTENSION_PLAN.md`](../backlog/VISUAL_STUDIO_EXTENSION_PLAN.md): a
  third `DashboardHostActions` host, built on the standalone server.

## Decision

Use one adapter-first/shared application core and compose host capabilities at
the entry point. Do not create a second standalone message router or preserve a
`WorkflowOrchestrator` constructor that silently creates `VsCodeAdapter`
instances.

The extension may continue using native VS Code APIs in extension-only
composition, editor integration, commands, completions, status-bar, trust, and
notification files. The standalone and CLI module graphs must not import those
files.

### Native-vs-built-in-modal policy (decided 2026-09-02)

Default to the shared, host-neutral, in-house React modal for **approval
prompts, confirmation dialogs, and secret/API-key/license-key entry** —
never build a native VS Code implementation of one of these just to "match"
an existing native version, and never plan a native-first/browser-later
sequence for one. If the built-in modal solves the problem as well as a
native dialog would, the native dialog is dead weight to remove, not a
parity target to keep. The reference implementation already exists and
predates this policy: `SecretGrantsTrustPrompt.ts`'s workspace secret-grant
batch approval is built entirely on `UserInteractionPort` →
`WebviewUserInteractionPort` → `BatchApprovalModal.tsx`, with **no** native
`showQuickPick`/`showWarningMessage` implementation at all, and it already
renders identically in the VS Code panel and a browser-connected
hosted-dashboard client. New approval/confirmation/secret-entry UI (see the
corrected `ExternalFileTrustPrompt.ts` row below, and
`TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md`'s "Approval Flow"/"Trust Parent
Folder Dialog" sections) follows this same pattern from the start.

**Licensing was checked against this policy on 2026-09-02 — correcting an
earlier, wrong claim in this same review that "licensing already checked
out."** That check only looked at `LicenseSettingsHandlers.ts` and
`LicenseSection.tsx` (the webview side, which is genuinely fine: both
`ACTIVATE_LICENSE_KEY` and the deactivate flow are already built-in modals —
see `LicenseSection.tsx` lines ~237-271 for the key-entry form and
~454-498 for the deactivate confirm modal) and missed `extension.ts`'s three
Command Palette license commands entirely. Two of them were real violations
of this policy, found 2026-09-02 and **fixed 2026-09-11**:

- **`ctrlyoke.activatePro`** used to show a native `showInputBox`
  (password-masked) for pasting a license key and call
  `licenseService.activateWithKey()` directly — a second, native-only
  implementation of the form that already exists in `LicenseSection.tsx`.
- **`ctrlyoke.deactivatePro`** used to show a native `showQuickPick` used as
  a single-choice confirm ("Deactivate" or dismiss) and call
  `licenseService.deactivate()` directly — duplicating the confirm modal
  that already exists in `LicenseSection.tsx`.

Both now share `ctrlyoke.manageLicense`'s pattern via one `openLicensePanel`
helper (`extension.ts`, in `registerCommands`): `workflowOrchestrator.openPanel()`

- `webviewProvider.awaitPanelReady()` + `webviewProvider.openGlobalSettingsTab("license")`,
  no native dialog at all — instead of running a second, divergent
  implementation of a flow the webview already owns. All three commands
  (`activatePro`, `deactivatePro`, `manageLicense`) now register the same
  helper, which also closed a pre-existing race where `manageLicense` called
  `openGlobalSettingsTab` without waiting for `awaitPanelReady()` first (the
  other two already awaited it). `ctrlyoke.activateOfflinePro` (native
  `showOpenDialog` for the license file) is the legitimate OS-file-picker
  carve-out and needed no change — it is already reachable from a connected
  webview client too, via `LicenseSection.tsx`'s narrowly-scoped
  `EXECUTE_VSCODE_COMMAND` bridge (`WebviewMessageRouter.ts:1639-1648`, which
  only ever forwards `ACTIVATE_OFFLINE_PRO`, nothing else).

There are exactly two carve-outs, both already reflected in the inventory
below, and neither is scheduled to move to a built-in modal:

1. **The native OS file/folder picker in the VS Code panel**
   (`vscode.window.showOpenDialog`/`showSaveDialog`). The native OS picker is
   objectively better than `FileBrowserModal` — thumbnails, recent
   locations, OS-level search, drive/network browsing. The VS Code panel
   keeps it. The browser/hosted dashboard has no OS picker to call and keeps
   `FileBrowserModal` for the same action. **This is a permanent, intentional
   divergence**, not an unfinished parity gap to unify later — see the
   `WebviewSettingsSync.ts` row.
2. **Native toast/status-bar notifications.** These are a different
   capability tier from modals (non-blocking, no decision to make) and are
   governed by `BROWSER_USER_FEEDBACK_PLAN.md`'s toast-queue work, not this
   policy.

If a future call site looks like it needs a third carve-out, treat that as a
decision to raise explicitly, not a default — the bar is "the built-in modal
genuinely cannot do the job," not "the native version already exists."

For the first standalone release, one process owns one repository/root:

- `getWorkspaceRoot()` is the configured `cwd`;
- `getWorkspaceRoots()` contains that root;
- `getNamedWorkspaceRoots()` contains one basename/path pair;
- no `.code-workspace` parsing or multi-root UI is required;
- shared path contracts still use forward-slash viewer paths so the standalone
  simplification does not fork downstream code.

## Goals

- Make reusable orchestration, routing, settings, serialization, discovery, and
  logging code compile and run without `vscode`.
- Reuse one message router and one set of domain services in the VS Code panel,
  VS Code-hosted browser, and standalone browser.
- Keep valid VS Code-native behavior at an explicit boundary.
- Replace no-op shim behavior with real Node implementations or explicit
  unsupported-capability results.
- Make the single-root standalone assumption an intentional composition choice,
  not a fake `workspaceFolders` value hidden inside a shim.
- Add automated dependency boundaries so future shared code cannot reintroduce
  `vscode`.

## VS Code Behavior Is Preserved

**This plan changes where code lives, not what the extension does.** When it
is complete, the VS Code extension must behave exactly as it does today. Every
VS Code-native feature keeps a VS Code implementation; only the host-neutral
core loses its `vscode` imports. Specifically:

- **Every `package.json` menu and command contribution stays registered and
  working.** This includes:
  - `ctrlyoke.runSubmenu`: run, load, queue, and queue-next, from the
    Explorer, editor title, and editor tab context menus.
  - The "Add … to ctrlyoke" items in the Explorer, editor, line-number,
    Output, SCM resource/folder, and Timeline context menus.
  - `scm/title` generate/cancel commit message.

  Their files (`extension.ts`, `ContextMenuReferenceCommands.ts`,
  `NativeOutputCaptureCommand.ts`, `ScmCommitCommand.ts`,
  `CtrlyokeCliCommands.ts`) are in the boundary table and keep their native
  code. Stage 3 extracts the run/pause/resume/stop command bodies so the
  router and these commands share one implementation. The commands themselves
  stay registered.

- **Context-menu inserts still reach the dashboard.**
  `ContextMenuReferenceCommands` pushes file, directory, selection, symbol,
  SCM, timeline, and output references into the prompt editor through
  `ContextMenuPromptEditorInsertSink`. `CtrlYokeWebviewProvider` implements
  that sink today. After Stage 6 the provider keeps implementing it and
  forwards to `DashboardApplication`, including the pending-insert queue that
  waits for panel READY.
- **Opening things from the panel stays native.** These all keep calling the
  same VS Code APIs as today:
  - file links and the current prompt file;
  - export previews;
  - commit and ref diffs (`OPEN_GIT_CHANGE`);
  - worktree diffs and worktree folders;
  - reveal in OS, the Output panel, and the MCP gallery;
  - the offline-license file picker.

  They are reached through the VS Code implementation of
  `DashboardHostActions` instead of an `executeCommand` string inside the
  router. The native OS file picker in the panel is a permanent carve-out.

- **Editor-derived completions keep working in the panel:**
  - `#selection:` and current-selection completions, plus output-channel
    references, through `VsCodeEditorContextSource` (Phase 6 item 4).
  - `#sym:` symbols through `VsCodeSymbolIndex`.
  - VS Code editor IntelliSense, links, and property completions in
    `.ctrlyoke.yaml`/`.prompt.md` files, which stay in the extension-only
    providers.
- **These keep their `src/platform/VsCode*` or boundary implementations:**
  the status bar, native completion notifications, workspace trust,
  multi-root folders, the VS Code output channel, telemetry, and secret
  storage.

Each stage is guarded by the existing extension-host test suite plus that
stage's golden and regression tests. A stage that changes visible VS Code
behavior is a bug, not a trade-off. The manual check for every Track A stage
is to exercise the menus above in a dev host (`npm run dev:host:start`).

## Non-Goals

- Removing VS Code from the extension entry point or VS Code-native features.
- Supporting multi-root standalone workspaces in the first release.
- Reimplementing VS Code editor, Quick Pick, workspace trust, or status bar in
  Node.
- Building a generic remote command-execution protocol.
- Preserving the current internal constructor signatures; the project is
  pre-release and should prefer the cleaner architecture.

## Audit Method and Snapshot

The audit parses production `.ts`/`.tsx` files with the TypeScript AST and
excludes tests, comments, declarations, and `src/ui/webview-react/**`. The
shrink-only counters in `src/test/unit/SourceAuditCounters.test.ts` now enforce
the numbers below, so a change that moves any of them must update that file's
baselines in the same commit.

### Current snapshot (2026-10-06)

| Measure                                                                      | 2026-07-29 audit | 2026-10-06                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| Production files importing `vscode`                                          |               39 | 32, plus `VsCodeTelemetry.ts` via `@vscode/extension-telemetry`; Stage 4b removed the settings-sync and prompt-editor imports |
| Direct `show*Message` in reusable code                                       |               63 | **0** (`directMessage.reusable`)                                                                                              |
| Direct `show*Message` in boundary files                                      |               49 | **41** across 7 allowlisted files (`directMessage.boundary`); Stage 3b removed five router notices                            |
| Adapter-mediated host UI (`platform.log/warn/error/showProgress/showChoice`) |               19 | **0** (`adapterUi`); the methods are deleted from `PlatformAdapter`                                                           |
| `vscode` value-importers reachable from `WorkflowOrchestrator.ts`            |               13 | **0** (`vscodeImportersReachableFromOrchestrator`)                                                                            |
| Direct `vscode` imports in `WorkflowOrchestrator.ts` / `WorkflowInstance.ts` |            1 / 0 | 0 / 0                                                                                                                         |
| `new VsCodeAdapter` outside `extension.ts`                                   |                6 | **0** (`coreVsCodeAdapterConstructions`)                                                                                      |
| Production `createFileSystemWatcher` calls outside `VsCodeFileWatcher.ts`    |                7 | **0** (all seven production watcher sites use `FileWatcherFactory`)                                                           |
| `src/cli.ts` / `src/mcp-server.ts` runtime graph loads `vscode`              |              yes | **no**, enforced statically. The esbuild shim alias is still present (Phase 8)                                                |

Phase 3 removed the last `vscode` import reachable from the orchestrator.
`WorkflowCommandHandler` uses `DashboardHostActions`, and the orchestrator
imports external-root approvals from `ExternalRootsApproval.ts`.

| File                                               | Owning phase / stage                        |
| -------------------------------------------------- | ------------------------------------------- |
| `src/core/orchestration/WorkflowCommandHandler.ts` | Host-neutral through `DashboardHostActions` |
| `src/ui/ExternalRootsApproval.ts`                  | Host-neutral approval and trust decisions   |

### Lesson that still applies: a `vscode`-free import list is not a host-neutral one

An import scan can't see code that reaches VS Code **through an injected
adapter**. Nineteen of those sites existed, and two of them blocked execution
on a native modal that only rendered on the host machine. All of them are
gone. `PlatformAdapter` no longer declares the methods, and the `adapterUi`
counter guards against their return. The rule for every remaining phase still
holds:

- **Triage before porting.** Delete a call site that duplicates a typed reply,
  announces routine success, or asks at runtime what config already declares,
  instead of building a host port for it. Use the triage table in
  `./BROWSER_USER_FEEDBACK_PLAN.md` Phase 2.
- **"No `vscode` import" is necessary but not sufficient.** Reusable code must
  have no path to host UI except through an injected port whose headless
  behavior is defined.

Phase 3 replaced that host-identity check with the explicit
`interactiveTerminal` capability. A non-VS Code host with an embedded
dashboard PTY now selects the PTY path, while the CLI selects inherited stdio.

## Inventory (re-audited 2026-10-06)

### VS Code boundary files (calls may remain)

These are legitimate native integrations. Standalone and CLI graphs must not
import them. Any shared types or domain logic they hold must move out once a
Node path needs it.

| File(s)                                                                                                                                   | Native use                                                                                                                           | Disposition                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                                                                                                                        | composition root; 19 direct `show*Message`; commands; trust/folder events                                                            | Keep. The license-command policy violations were fixed on 2026-09-11. Its unused `?? 3000` hosted-port fallback disagrees with the `server.port` default of 4747, so Stage 7a removes it when server options move into one place. |
| `src/platform/VsCode*.ts` (`Adapter`, `FileWatcher`, `LogOutputChannel`, `SecretStore`, `UserFeedbackSink`, `WorkspaceRoot`, `Telemetry`) | implementations of project ports                                                                                                     | Keep as the explicit implementation boundary.                                                                                                                                                                                     |
| `src/platform/VsCodeDashboardHostActions.ts`                                                                                              | dashboard focus and native target opening                                                                                            | Keep as the VS Code implementation of `DashboardHostActions`.                                                                                                                                                                     |
| `src/ui/ExternalFileTrustPrompt.ts`                                                                                                       | native editor and Explorer opening                                                                                                   | Keep as the VS Code opener; trust decisions live in `ExternalRootsApproval.ts`.                                                                                                                                                   |
| `src/completions/ContextMenuReferenceCommands.ts`, `WorkspaceReferencePaths.ts`                                                           | Explorer/SCM/editor context menus; `executeDocumentSymbolProvider`                                                                   | Keep. The symbol lookup can switch to `VsCodeSymbolIndex` (Phase 6) but stays extension-only.                                                                                                                                     |
| `src/completions/PromptCompletionProvider.ts`, `PromptLinkProvider.ts`, `PromptPropertyCompletionProvider.ts`                             | VS Code editor language features                                                                                                     | Keep. After Phase 6 they become thin adapters over the Node completion core.                                                                                                                                                      |
| `src/ui/CtrlyokeCliCommands.ts`, `src/ui/NativeOutputCaptureCommand.ts`, `src/scm/ScmCommitCommand.ts`, `src/dev/DevCommands.ts`          | command registration, terminals, active editor                                                                                       | Keep.                                                                                                                                                                                                                             |
| `src/ui/StatusBarManager.ts`, `src/ui/NotificationManager.ts`                                                                             | status bar, native completion notifications                                                                                          | Keep as optional sinks.                                                                                                                                                                                                           |
| `src/ui/CtrlYokeWebviewProvider.ts`                                                                                                       | `WebviewView`, `asWebviewUri`, panel lifecycle                                                                                       | Keep as the VS Code view transport: HTML, nonce, panel READY/reconnect, theme capture, and queued prompt-editor inserts. Shared routing and dashboard services live in `DashboardApplication`.                                    |
| `src/ui/DashboardApplication.ts`                                                                                                          | No VS Code imports; composes shared router, delegates, secret registry, interaction port, history search, and browser-client cleanup | Done / Phase 4                                                                                                                                                                                                                    | Implements `DashboardClientEndpoint`; constructed in `extension.ts` from host services, actions, and the injected `TemplateManager`. |

### Reusable code that still depends on VS Code

| File                                                                           | Current coupling                                                                                                                                                                                                                                                                                         | Phase / stage  | Replacement                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/orchestration/ExternalRunWatchSession.ts`                            | `createFileSystemWatcher` ×3 (`:156`, `:284`, `:343`). `ExternalRunWatchCoordinator.ts:542` constructs it without a factory, even though the coordinator already holds one.                                                                                                                              | 2 / 1          | Pass the coordinator's `FileWatcherFactory` through.                                                                                                                            |
| `src/core/orchestration/ExecutionRootCoordinationWatchSession.ts`              | `createFileSystemWatcher` ×1 (`:79`). `WorkflowOrchestrator.ts:4906` constructs it without a factory.                                                                                                                                                                                                    | 2 / 1          | Pass the orchestrator's factory through.                                                                                                                                        |
| `src/ui/ExternalFileTrustPrompt.ts`                                            | Native file/selection opening via `vscode` editor and Explorer APIs.                                                                                                                                                                                                                                     | Done / Phase 3 | Trust decisions and pending-root approval moved to `ExternalRootsApproval.ts`; this file owns `openResolvedTarget` and the VS Code trust-and-open command wrapper.              |
| `src/core/orchestration/WorkflowCommandHandler.ts` (96 lines)                  | No host API imports; receives `DashboardHostActions`.                                                                                                                                                                                                                                                    | Done / Phase 3 | Focus and prompt-file opening go through the injected `focusDashboard` and `openWorkspaceTarget` actions.                                                                       |
| `src/core/TemplateManager.ts`                                                  | No VS Code dependency; receives explicit extension path, workspace-root resolver, and `PlatformAdapter`.                                                                                                                                                                                                 | Done / Phase 3 | The extension composition root constructs and injects the instance into `CtrlYokeWebviewProvider`.                                                                              |
| `src/ui/WebviewMessageRouter.ts`                                               | **Resolved — Stage 3b:** run/pause/resume/stop call shared orchestrator methods; merge calls `mergeManagedWorktreeAtRun` directly and scopes failures to the initiator; worktree management returns typed scoped errors and omits routine success notices. No `vscode` import or direct messages remain. | Done / 3b      | Router tests cover direct dispatch and two-client reply scope.                                                                                                                  |
| `src/ui/WebviewSettingsSync.ts`                                                | Workspace and certificate/server operations previously used direct VS Code APIs.                                                                                                                                                                                                                         | Done / 4b      | Injected roots, `selectWorkspacePath?`, `HostedServerControl`, and the extracted host-neutral `ServerCertificateService`; browser certificate download remains available.       |
| `src/ui/WorkflowSerializer.ts`                                                 | No host API imports. Explicit workspace roots, `KeyValueStore`, and `DashboardHostActions`; picker requests carry filters/default paths.                                                                                                                                                                 | Done / 4a      | VS Code retains native pickers, last export/browse directories, and editor opening; browser clients retain their own picker.                                                    |
| `src/ui/PromptEditorSupportService.ts`                                         | Host-neutral dashboard prompt editor support, with injected `CompletionCore`; no runtime `vscode` load.                                                                                                                                                                                                  | Done / 5b      | Completion and symbol lookups use the injected core and ports; the rooted source-audit guard holds this boundary.                                                               |
| `src/ui/HarnessFileMessageService.ts`                                          | No host API imports. Directory reveal goes through optional `DashboardHostActions.revealInOs`.                                                                                                                                                                                                           | Done / 4a      | When reveal is unsupported, the scoped reply carries the directory path and the browser opens it in the workspace viewer.                                                       |
| `src/utils/FileSystemUtils.ts`                                                 | `saveIfDirty` read `workspace.textDocuments`. Every `readJsonFile` user therefore imported a `vscode` file.                                                                                                                                                                                              | Done / 5a      | `saveIfDirty` now lives in `src/platform/VsCodeDocuments.ts`; neutral JSON/file helpers remain.                                                                                 |
| `src/completions/CompletionHelpers.ts`                                         | VS Code completion composition, conversion, configuration subscription, and output-channel slug.                                                                                                                                                                                                         | Done / 5c      | Contains only the VS Code composition root and adapter helpers; all completion discovery and ranking lives in `CompletionCore`, with symbols/editor context behind their ports. |
| `src/completions/BranchCompletionHelpers.ts`, `SlashTokenCompletionHelpers.ts` | only `vscode.CompletionItemKind` (1 and 3 uses)                                                                                                                                                                                                                                                          | Done / 5a      | Use project-owned `COMPLETION_ITEM_KINDS`; VS Code completion conversion maps those kinds in one place.                                                                         |
| `src/completions/ScriptCommandCompletionHelpers.ts`                            | `workspaceFolders`, `createFileSystemWatcher("**/package.json")` (`:424`)                                                                                                                                                                                                                                | Done / 5a      | Receives named roots and `FileWatcherFactory`; contains no `vscode` import.                                                                                                     |
| `src/server/HostedWorkspaceViewerService.ts`                                   | Owned the bounded non-git `walkSearchFiles` fallback used by viewer search.                                                                                                                                                                                                                              | Done / 5a      | The viewer and completion core share `src/utils/WorkspaceSearchFileWalker.ts`; the viewer search regression tests remain unchanged.                                             |

### Resolved since the original audit

`WorkflowOrchestrator.ts`, `WorkflowInstance.ts`, `PromptFileLoader.ts`,
`PromptFileWatcher.ts`, `McpManagerService.ts`, `TerminalMessageHandlers.ts`,
`UndoRedoCoordinator.ts`, `WorkflowMutationCoordinator.ts`,
`WorkflowStepHandlers.ts`, `AttachmentBuilders.ts`, `DiscoveryUtils.ts`,
`AgentDiscovery.ts`, `SkillDiscovery.ts`, `ModelRegistry.ts`, `Log.ts`, and
`TelemetryReporter.ts` no longer import `vscode`.
`src/core/orchestration/TemplateImporter.ts` was deleted in `5e5d09bfd`
(2026-08-17, native template import flow retired).

## Target Architecture

```text
extension.ts                          ServerCommand.ts (ctrlyoke server)
  createVsCodeHostServices(context)     createNodeHostServices(cwd)
    VsCodeAdapter                         CliAdapter (single root)
    VsCodeFileWatcherFactory              chokidar FileWatcherFactory
    VsCodeUserFeedbackSink …              Console + hosted WS feedback sinks
    VS Code DashboardHostActions          browser-only DashboardHostActions
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
Shared application (no vscode in its graph)
  WorkflowOrchestrator(dependencies)
  DashboardApplication(host services, host actions)
    WebviewMessageRouter + delegates (settings, serializer, editor support, …)
    client registry (READY/replay, per-client scoping)
        ▲                                  ▲
  CtrlYokeWebviewProvider            CtrlYokeHostedServer (shared HTTP/WS class)
  (VS Code view transport)           used by both hosts via DashboardClientEndpoint

cli.ts run/validate/commit/history/…
  CliAdapter + ConsoleUserFeedbackSink → WorkflowInstance directly (no dashboard)
```

The shared application depends on project-owned interfaces and data only. It
never accepts `vscode.ExtensionContext`, `vscode.WorkspaceFolder`,
`vscode.Uri`, `vscode.FileSystemWatcher`, `vscode.Memento`, or VS Code command
IDs.

## Capability Boundaries

Don't turn `PlatformAdapter` into a broad god interface. Keep workspace and
runtime identity there. Where behavior has its own lifecycle or semantics, add
a small capability port instead. Most ports already exist in
`src/core/HostPorts.ts`: `FileWatcherFactory`, `KeyValueStore`,
`DisposableRegistry`, and `StatusBarSink`. `UserFeedbackSink` lives in
`src/core/`, and `UserInteractionPort` in `src/ui/`.

### `PlatformAdapter`

Current members (2026-10-06): required `interactiveTerminal`,
`getWorkspaceRoot`, `getWorkspaceRoots`, `getNamedWorkspaceRoots`,
`getExtensionPath`; optional `getSecretStore`, `getConfig`, and
`getApprovedExternalFileRoots`. `openTextFile`, `focusDashboard`, and
`isVsCode` have been removed. The five UI methods (`log`, `warn`, `error`,
`showProgress`, `showChoice`) were deleted on 2026-08-02.

Phase 3 made these changes:

- **Delete `isVsCode?()`.** Only `VsCodeAdapter` implements it, and nothing
  calls it.
- **Delete `openTextFile?()`.** Only `VsCodeAdapter` implements it, and
  nothing calls it.
- **Move `focusDashboard?()` to `DashboardHostActions`.** It is called from
  `WorkflowOrchestrator.ts:4708` and `WorkflowExecutor.ts:4954`. The
  orchestrator receives the host actions through its dependencies object, as
  it already receives the platform.
- **Add a required `interactiveTerminal: InteractiveTerminalMode`** whose
  values are `embedded-pty` and `inherit-stdio`, defined as a constant object
  in `DashboardConstants.ts`. It replaces
  `CliIntegration.isVsCodeContext()`, the `"getExtensionContext" in
this.platform` check, and the `runtimeState.isVsCodeContext` plumbing into
  `CliExecutionRunner.executeInTerminal`. Rename that function's `standalone`
  local to match.
  - The real question is "does a dashboard terminal exist to attach the
    harness TUI to?", not "is this VS Code?".
  - `VsCodeAdapter` and the standalone server answer `embedded-pty`.
    `PtyProcessManager` and `TerminalMessageHandlers` are already
    host-neutral.
  - `CliAdapter` answers `inherit-stdio`.

  **This decision resolves Open Question 4.**

Keep the `cliExecutionMode` config read (`CliAdapter.getConfig`). It is a
separate setting: headless versus interactive. It doesn't decide where an
interactive session renders.

### Watcher factory

The contract exists in `src/core/HostPorts.ts:80-90`:

```typescript
interface FileWatcher {
  onDidCreate(listener: (path: string) => void): Disposable;
  onDidChange(listener: (path: string) => void): Disposable;
  onDidDelete(listener: (path: string) => void): Disposable;
  dispose(): void;
}

interface FileWatcherFactory {
  create(basePath: string, glob: string): FileWatcher;
}
```

- `VsCodeFileWatcherFactory` (`src/platform/VsCodeFileWatcher.ts`) and
  `NodeFileWatcherFactory` (`src/platform/NodeFileWatcher.ts`) implement the
  port. `extension.ts` constructs the VS Code implementation and threads it
  through the orchestrator → `WorkflowInstanceRegistry` → `WorkflowInstance` →
  `PromptFileWatcher`, and into `ExternalRunWatchCoordinator`, which now owns
  the `runner.json` watcher.
- **Node implementation: re-add `chokidar@5` (decided 2026-10-06).**
  - It was removed in `d30015831` (2026-07-29) only because nothing used it.
  - It is the right tool here. Every ctrlyoke write goes through
    `writeFileAtomic` (a temp file plus a rename), and chokidar normalizes
    those renames. Raw `fs.watch` reports them inconsistently across
    platforms.
  - It handles recursive watching on Linux.
  - It is bundled by esbuild, so the npm package keeps zero runtime
    dependencies.
  - Glob matching uses chokidar's own `ignored` predicate plus `minimatch`,
    which `glob` already brings in. Make it an explicit dependency if it is
    imported directly.
  - Raw recursive `fs.watch` was rejected: it is inconsistent on Linux, and
    each caller would have to re-derive rename handling.
- Callers receive normalized absolute string paths. Watcher ownership and
  disposal are explicit.
- No production site outside `VsCodeFileWatcher.ts` calls
  `vscode.workspace.createFileSystemWatcher` directly; all seven production
  watcher sites use `FileWatcherFactory`.
- With no factory (`ctrlyoke run`), `PromptFileWatcher` polls. That stays the
  CLI's behavior. The standalone server injects the chokidar factory.

### User feedback and interactions

Done. See
[`BROWSER_USER_FEEDBACK_PLAN.md`](./BROWSER_USER_FEEDBACK_PLAN.md).

- `UserFeedbackSink` implementations: `CompositeUserFeedbackSink`,
  `ConsoleUserFeedbackSink` (CLI), `VsCodeUserFeedbackSink`, and
  `HostedWebSocketUserFeedbackSink`.
- `UserInteractionPort` implementations: `WebviewUserInteractionPort` and
  `NullUserInteractionPort`.

New code reuses these. Don't use diagnostic logging as a substitute for user
notifications.

### Dashboard host actions

The shared router depends on domain-specific capabilities instead of calling
`vscode.commands.executeCommand()`. The shape below is **derived from every
current `executeCommand`/native call site in `WebviewMessageRouter.ts`** and
its delegates. **It resolves Open Question 2.**

```typescript
interface DashboardHostActions {
  /** Open a file/selection in the host's editor. */
  openWorkspaceTarget(target: WorkspaceOpenTarget): Promise<ActionResult>;
  /** Show generated content (export preview, generated diff text). */
  openContentPreview(content: ContentPreview): Promise<ActionResult>;
  /** Native file/folder/save picker — the OS-picker carve-out. */
  selectWorkspacePath?(
    request: PathSelectionRequest
  ): Promise<string | undefined>;
  revealOutput?(): Promise<void>;
  focusDashboard?(): void;
  /** Open a folder (worktree, worktree owner) in a new host window. */
  openFolderWindow?(absolutePath: string): Promise<ActionResult>;
  /** Native multi-file diff (worktree branch vs base, single git change). */
  openGitDiff?(request: GitDiffRequest): Promise<ActionResult>;
  revealInOs?(absolutePath: string): Promise<ActionResult>;
  browseMcpGallery?(): Promise<void>;
  reloadHost?(): Promise<void>;
}
```

Rules:

- **Optional means host-native.** When a method is absent, the router replies
  to the initiating client with a typed `unsupported` result. The browser
  already has its own surface for each case:
  - `FileBrowserModal` for selection;
  - `WorkspaceFileEditor` for opening files;
  - `workspaceViewerStore.openToWorktreeDiff`/`openToGitRef` for diffs;
  - the workspace viewer for reveal.

  No method takes a command ID, and no generic passthrough is allowed.

- **Domain operations are not host actions.** They become direct orchestrator
  or service calls in the shared router.

| Router call site (2026-10-06)                                          | Becomes                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RUN` / `PAUSE` / `RESUME` / `STOP` → `ctrlyoke.run/pause/resume/stop` | direct orchestrator calls (extract the command bodies from `extension.ts` into shared methods) |
| `SELECT_FILE` → `ctrlyoke.selectPromptFile`                            | `selectWorkspacePath?` + `orchestrator.loadWorkflow`                                           |
| `APPEND_FILE` without a path → `ctrlyoke.appendFromDashboard`          | `selectWorkspacePath?` + the shared append operation                                           |
| `EDIT_FILE` → `ctrlyoke.editCurrentPromptFile`                         | `openWorkspaceTarget`                                                                          |
| `SHOW_OUTPUT` → `ctrlyoke.showOutputPanel`                             | `revealOutput?`                                                                                |
| `OPEN_GIT_CHANGE` (legacy) → `ctrlyoke.openGitChange`                  | `openGitDiff?`                                                                                 |
| `OPEN_WORKTREE`, worktree owner → `ctrlyoke.openWorktree(Owner)`       | `openFolderWindow?`                                                                            |
| `VIEW_WORKTREE_DIFF` → `ctrlyoke.viewWorktreeDiff`                     | `openGitDiff?` (browser: `openToWorktreeDiff`)                                                 |
| `MERGE_WORKTREE` → `ctrlyoke.mergeWorktree`                            | direct `orchestrator.mergeManagedWorktreeAtRun`, failure as a scoped reply                     |
| worktree-management `show*Message` ×5                                  | scoped typed replies (delete/convert per the feedback triage)                                  |
| `EXPORT_CONTENT_PREVIEW` → `openTextDocument`/`showTextDocument`       | `openContentPreview`                                                                           |
| `workbench.mcp.browseServers`                                          | `browseMcpGallery?`                                                                            |
| `ctrlyoke.activateOfflinePro` bridge                                   | `selectWorkspacePath?` + the license service (keeps the OS-picker carve-out)                   |
| `workbench.action.reloadWindow`                                        | `reloadHost?`                                                                                  |
| `HarnessFileMessageService` → `revealFileInOS`                         | `revealInOs?`                                                                                  |
| `WebviewSettingsSync` → enable/disable server, regenerate token        | `HostedServerControl` port (not a dashboard host action)                                       |

### Dashboard application (the composition seam the router alone doesn't fix)

A host-neutral router is not enough on its own. Today
`CtrlYokeWebviewProvider` is both the VS Code `WebviewViewProvider` and the
**only** place that builds the dashboard application:
`TemplateManager(context)`, `SecretRegistryService`,
`WebviewUserInteractionPort`, `WebviewSettingsSync`, `WorkflowSerializer`,
`WebviewMessageRouter`, `HistorySearchService`, and the browser-client
registry (`unregisterBrowserClient`, which also releases PTY controllers).
`CtrlYokeHostedServer` reaches that application only through
`webviewProvider.routeExternalMessage`, `unregisterBrowserClient`, and
`postMessage(CAPTURE_THEME_VARS)`.

Phase 4 extracts a host-neutral `DashboardApplication`:

- It owns the delegates above and the client registry.
- It is constructed by each composition root from host services plus
  `DashboardHostActions`.
- It exposes a narrow endpoint for transports:

```typescript
interface DashboardClientEndpoint {
  routeClientMessage(
    message: unknown,
    reply: PostMessageFn,
    clientTag?: string
  ): Promise<void>;
  disconnectClient(clientTag: string): void;
  /** VS Code-hosted only: ask the panel to re-capture theme variables. */
  requestThemeCapture?(): void;
}
```

`CtrlYokeWebviewProvider` becomes a VS Code view transport that forwards panel
messages to the same endpoint. `CtrlYokeHostedServer` takes a
`DashboardClientEndpoint` instead of the provider, which is what lets
standalone reuse the hosted server class unchanged. See
`STANDALONE_SERVER_PLAN.md` Phase 6.

### Logging (done 2026-10-04)

- `Log.ts` writes through an injected `LogOutputSink`.
- `src/platform/VsCodeLogOutputChannel.ts` owns the output channel.
- Runtime level and diagnostic-file changes are **pushed** to
  `Log.setLogLevel`/`Log.setDiagnosticFileLogging`:
  - by `channel.onDidChangeLogLevel` and `configService.subscribe` in the
    extension;
  - once at `Log.initializeCli` in the CLI.

`Log` has no listener of its own. **This resolves Open Question 3.** The
standalone server uses the CLI's file logging. It adds no console sink,
because terminal output belongs to the launch banner.

### Model discovery (done 2026-10-04)

`ModelRegistry` uses the project `TypedEmitter`. It never used the Language
Model API, so there is no VS Code source to split out.

## Cross-Plan Execution Order

Moved on 2026-10-06 to
[`STANDALONE_STAGING_PLAN.md`](../active/STANDALONE_STAGING_PLAN.md), which now
also sequences the language-intelligence plan.

Older notes in this file refer to the previous table's stage numbers. Here is
how those map, so the history still reads correctly:

| Old stage | Work                                     | Outcome                                                                                         |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0         | Dependency guards                        | Done                                                                                            |
| 1, 4, 9   | Toast queue, feedback port, interactions | Done (`BROWSER_USER_FEEDBACK_PLAN.md`)                                                          |
| 2         | Host composition                         | Done, 2026-09-17                                                                                |
| 3         | Watcher factory                          | Done, 2026-10-06                                                                                |
| 5         | Command UI/domain split                  | Staging Stage 2                                                                                 |
| 6         | Reusable router                          | The client-scoped half is done. The router half is Stage 3, and the application half is Stage 6 |
| 7         | Shared UI services                       | Staging Stage 4                                                                                 |
| 8         | Utilities, completions, `Log`            | `Log` is done. Completions are Stage 5                                                          |
| 10–11     | Standalone composition and CLI           | Staging Stages 7a–9                                                                             |
| 12        | Retire the Node-side shim                | Staging Stage 10                                                                                |

## Implementation Plan

### Phase 0 — Add dependency guards (complete)

**Status (2026-10-06):** complete. The guards are **rooted graph checks**
rather than path-group lint rules. Path groups (items 1–2 of the original
list) were dropped as unnecessary. A path rule can't tell `core/` code that
reaches `vscode` through a re-export from code that doesn't, and a graph
rooted at the real entry points can. Every guard lives in
`src/test/unit/SourceAuditCounters.test.ts`. All of them count
`ts.CallExpression`/import nodes, and they fail in **both** directions, so a
baseline can't go stale.

| Guard                                                                 | Root / scope                                                            | Baseline (2026-10-06) | Goes to 0 at     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------: | ---------------- |
| `vscodeImportersReachableFromOrchestrator` (explicit allowlist)       | `WorkflowOrchestrator.ts`, value imports only (`import type` erased)    |                     0 | —                |
| `orchestratorDirectVsCodeImports`                                     | `WorkflowOrchestrator.ts`                                               |                     0 | —                |
| `orchestratorVsCodeConstructorParams`                                 | orchestrator constructor                                                |                     0 | —                |
| `workflowInstanceDirectVsCodeImports`                                 | `WorkflowInstance.ts`                                                   |                     0 | —                |
| `coreVsCodeAdapterConstructions`                                      | `src/core/**`                                                           |                     0 | —                |
| `adapterUi` (`platform.log/warn/error/showProgress/showChoice`)       | all production code                                                     |                     0 | —                |
| `directMessage.reusable` / `.boundary` (`vscode.window.show*Message`) | all production code; 7-file boundary allowlist                          |                0 / 41 | Stage 3 complete |
| `webviewToast`                                                        | webview toast call sites outside the host-aware dispatcher              |                     1 | —                |
| CLI/MCP runtime graph loads `vscode`                                  | `src/cli.ts`, `src/mcp-server.ts`, including package `require()` graphs |                  `[]` | —                |
| Dashboard/server runtime graph loads `vscode`                         | `src/ui/DashboardApplication.ts`, `src/server/CtrlYokeHostedServer.ts`  |                  `[]` | Stage 6 complete |

New guards are added by the stage that makes them true:

- **Stage 6 added** `src/ui/DashboardApplication.ts` and
  `src/server/CtrlYokeHostedServer.ts` as roots that must reach no `vscode`
  load.
- **Stage 7a** adds `src/cli/ServerCommand.ts`.
- **Stage 10** adds the esbuild metafile check (Phase 8 item 5).

### Phase 1 — Introduce host composition

**Item list re-derived from the current source on 2026-09-17.** The original
list cited line numbers from an older tree, undercounted the adapter
constructions, and stopped short of the seams that actually hold the `vscode`
import in place.

The test-first host-boundary guard is now in place in
`src/test/unit/SourceAuditCounters.test.ts`. Phase 1 items 1–9 landed on
2026-09-17: the orchestrator now accepts a project-owned dependencies object,
has no `ExtensionContext` field or constructor parameter, and receives its
platform, status sink, disposable registry, and workspace state store from the
extension composition root. The guard therefore records
`orchestratorVsCodeConstructorParams` at 0 and
`coreVsCodeAdapterConstructions` at 1; the reachable value-import graph
shrunk from 13 to 8 because the orchestrator no longer reaches
`StatusBarManager`, `VsCodeAdapter`, or `VsCodeSecretStore`. Its direct
`vscode` import is now 0 because the runner watcher is supplied through the
`FileWatcherFactory` port. Later stages remove the remaining importers. The
`workflowInstanceDirectVsCodeImports` baseline is already zero and guards
against regression.

1. **DONE 2026-09-17.** Replace
   `WorkflowOrchestrator(context, dashboardProvider, userFeedbackSink, runnerHostIdentity, licenseService, userInteractionPort)`
   with a single project-owned `WorkflowOrchestratorDependencies` object.
2. **DONE 2026-09-17.** Construct one `VsCodeAdapter` in `extension.ts` and
   inject it into the orchestrator and its shared collaborators. The two
   extension-only `getSecretStore()` calls now reuse that instance. The six
   orchestrator constructions are gone; `TemplateManager.ts` and
   `CtrlYokeWebviewProvider.ts` remain explicitly owned by later/out-of-scope
   work.
3. **DONE 2026-09-17.** Remove the shared orchestrator's `ExtensionContext`
   field and replace its workspace-state write with the injected
   `KeyValueStore` port.
4. **DONE 2026-09-17.** Inject an optional `StatusBarSink`; move queue context
   updates onto that sink, remove the orchestrator's `StatusBarManager` and
   `LicenseService` dependencies, and leave status-bar disposal with
   `extension.ts` through `context.subscriptions`.
5. **DONE 2026-09-17.** Use the injected `DisposableRegistry` for the
   orchestrator's harness-status subscriptions; `extension.ts` adapts it to
   `context.subscriptions`.
6. **DONE 2026-09-17.** Pass the injected `PlatformAdapter` to
   `WorkflowInstance`; its signature and VS Code-free implementation remain
   unchanged.
7. **DONE 2026-09-17.** Replace `currentWorkspaceFolder:
vscode.WorkspaceFolder | undefined` (declared line 455, read at ~45 sites,
   always as `.uri.fsPath`) with an injected `() => string | undefined`
   resolver. The resolver is sampled once during construction, preserving the
   previous field's semantics. `platform.getWorkspaceRoot()` is **not** a
   drop-in substitute: it falls back to `process.cwd()`, whereas this field is
   `undefined` when no folder is open and roughly a dozen branches depend on
   that distinction.
8. **DONE 2026-09-17.** Move the orchestrator's remaining direct VS Code calls
   out: `vscode.workspace.isTrusted` → an injected `isWorkspaceTrusted`
   predicate whose headless default is `true`; the dashboard command → the
   existing `platform.focusDashboard?.()`; and the native picker → the
   `ctrlyoke.resumeSession` command facade, with the orchestrator exposing
   `listResumableSessions()` and `resumeSessionFromWorkingFile(filePath)`.
   The two no-workspace/no-sessions feedback exits remain in the orchestrator,
   while the picker stays natively rendered under the file-picker carve-out,
   exactly like `ctrlyoke.selectPromptFile`. The orchestrator's two
   non-watcher `vscode.Disposable` wrappers were also replaced with host-neutral
   disposable handles. Item 9 removes the remaining direct import.
9. **DONE 2026-09-17. Pulled forward from Phase 2 item 4:** convert the
   `runner.json` watcher
   (lines 6743-6757) to the `FileWatcherFactory` contract with a VS Code
   implementation, because it is the orchestrator's last remaining direct
   `vscode` use. Phase 2 keeps the chokidar implementation and converts its
   five remaining sites; the completion-layer watcher remains owned by Phase 6.
   Its polling fallback (`pollRunnerJsonDiscovery`, every 1s) and its
   deliberate `onDidCreate` + `onDidChange` duality must survive the move —
   both exist because VS Code 1.133 on Windows did not deliver recursive
   events below an external `RelativePattern` base.

**DONE 2026-09-17 — Phase 1 complete. Exit-gate evidence:**
`src/core/WorkflowOrchestrator.ts` contains no `vscode` import
and no VS Code type in its constructor or public surface; `new VsCodeAdapter`
appears nowhere outside `extension.ts`. The source audit records 0 direct
orchestrator imports and 8 reachable importers. See the Stage 2 row above for why the
runtime "no `vscode` module loadable" instantiation test is a Stage 12 gate
rather than this one, and Phase 0 item 3 for the shrink-only counter that
enforces this stage.

The eight files remaining in the orchestrator's reachable `vscode` set at the
end of Phase 1 were owned by these later stages (the four struck through were
decoupled early on 2026-10-04 — see "CLI runtime graph" below — leaving 4):

| File                                                              | Owning stage                         |
| ----------------------------------------------------------------- | ------------------------------------ |
| `src/core/orchestration/ExecutionRootCoordinationWatchSession.ts` | Stage 3 — watcher factory            |
| `src/core/orchestration/ExternalRunWatchSession.ts`               | Stage 3 — watcher factory            |
| ~~`src/core/orchestration/PromptFileWatcher.ts`~~                 | Stage 3 — watcher factory            |
| `src/core/orchestration/WorkflowCommandHandler.ts`                | Stage 5 — command UI/domain split    |
| `src/ui/ExternalFileTrustPrompt.ts`                               | Stage 4 — feedback/interaction ports |
| ~~`src/utils/AttachmentBuilders.ts`~~                             | Stage 8 — utilities and completions  |
| ~~`src/utils/Log.ts`~~                                            | Stage 8 — injected logging sinks     |
| ~~`src/utils/ModelRegistry.ts`~~                                  | Stage 8 — model-source aggregation   |

### CLI runtime graph (done early, 2026-10-04)

A user ran `out/cli.js` as plain `tsc` output (which `compile-tests` emits
before esbuild overwrites it) and it crashed with `Cannot find module
'vscode'`: the shim alias only exists in the esbuild bundle. Five files in the
CLI's runtime graph loaded `vscode`, so they were pulled forward from Stages
3 and 8:

- `Log.ts` → host-neutral `LogOutputSink`; the channel, its level mapping, and
  runtime level/`diagnostics.verboseLogging` updates live in
  `src/platform/VsCodeLogOutputChannel.ts` (Phase 6 item 6). The settings
  listener now follows `configService` — the old VS Code configuration event
  never fired, since that setting lives in `.ctrlyoke/settings.json`.
- `ModelRegistry.ts` → `TypedEmitter` (Phase 6 item 5's emitter half; it uses no
  Language Model API, so there is no source to split).
- `AttachmentBuilders.ts` → Node `fs`; the VS Code-only `getWorkspaceSymbols`
  moved into `CompletionHelpers.ts`, its only caller (Phase 6 item 2).
- `PromptFileWatcher.ts` → `FileWatcherFactory`, threaded through
  `WorkflowInstance`; with no factory (the CLI) it polls, as it effectively did
  under the shim's no-op watcher (Phase 2 item 2).
- **New finding:** `TelemetryReporter.ts` imported `@vscode/extension-telemetry`,
  which itself requires `vscode` — invisible to any source import scan. It is
  now a host-neutral `TelemetrySink` registry; the package is imported only by
  `src/platform/VsCodeTelemetry.ts`.

`SourceAuditCounters.test.ts` now asserts that neither `src/cli.ts` nor
`src/mcp-server.ts` reaches a `vscode` load, following runtime imports,
re-exports, dynamic imports, and installed packages' `require()` graphs. This
is the static half of Phase 8 item 5 for those two entries; the shim alias is
still in place.

Phase 1's gate is specifically the absence of a `vscode` import in
`WorkflowOrchestrator.ts`; it is not a runtime test that makes the `vscode`
module unavailable. That broader graph gate belongs to Stage 12.

Do not keep a VS Code-context default constructor: it would preserve the import
and allow standalone tests to miss hidden construction.

### Phase 2 — Node watcher and the remaining watcher sites (Staging Stage 1)

**Done 2026-10-06.** Both watcher implementations and the shared contract
suite are in place; the remaining direct VS Code watcher belongs to Phase 6.

1. **Done.** Re-add `chokidar@^5` and implement `NodeFileWatcherFactory` in
   `src/platform/NodeFileWatcher.ts`. `basePath` + `glob` map to a chokidar
   watch on `basePath`, filtered by `minimatch` against the base-relative,
   forward-slash path. Use `ignoreInitial: true`. Emit absolute paths.
2. ~~Inject the factory into `PromptFileWatcher`.~~ **Done 2026-10-04.**
3. **Done.** Inject the factory into `ExternalRunWatchSession` (three watchers). Its
   constructor at `ExternalRunWatchCoordinator.ts:542` passes the factory the
   coordinator already holds. Also inject it into
   `ExecutionRootCoordinationWatchSession` (one watcher, constructed at
   `WorkflowOrchestrator.ts:4906`).
4. ~~Replace the orchestrator `runner.json` watcher.~~ **Done 2026-09-17**
   (Phase 1 item 9). It now lives in
   `ExternalRunWatchCoordinator.ts:296-312`.
5. **Done.** Add one contract suite that runs against both factories:
   - create, change, and delete;
   - a `writeFileAtomic` temp-file + rename reported as a create or change of
     the target, never as a delete;
   - glob filtering;
   - `dispose()` stops all events.

   The VS Code half runs in the extension-host suite, and the Node half in
   unit tests.

6. **Done.** Lower `vscodeImportersReachableFromOrchestrator` to 2 and remove both
   sessions from the allowlist.

Keep the runner watcher's polling fallback (`pollRunnerJsonDiscovery`) and its
`onDidCreate` + `onDidChange` duality. Both exist because of VS Code 1.133
Windows behavior, and the chokidar implementation must not tempt anyone to
remove them.

### Phase 3 — Command/domain split and adapter cleanup (Staging Stage 2)

**DONE 2026-10-06 — Phase 3 complete.** `WorkflowOrchestrator` reaches no
`vscode` imports, and `src/core/**` constructs no `VsCodeAdapter`.

1. Split `ExternalFileTrustPrompt.ts`:
   - Move `promptBatchApprovalForPendingWorkflowExternalRoots`, the
     pending-root helpers, and the trust decision into a host-neutral
     `src/ui/ExternalRootsApproval.ts`. It takes a `UserInteractionPort` and
     an `isWorkspaceTrusted` predicate in place of `workspace.isTrusted`.
   - `openResolvedTarget` stays in the VS Code file and becomes that host's
     `openWorkspaceTarget`.
   - The orchestrator imports only the new module. **Done.**
2. Define `DashboardHostActions` in `src/core/HostPorts.ts`, starting with
   `focusDashboard` and `openWorkspaceTarget`. Add it to
   `WorkflowOrchestratorDependencies` and move `WorkflowCommandHandler` onto
   it. **Done.**
3. Refactor `TemplateManager` to take `extensionPath`, a workspace-root
   resolver, and the injected platform. `CtrlYokeWebviewProvider` (Stage 6:
   `DashboardApplication`) receives the instance instead of building it from
   `ExtensionContext`. `coreVsCodeAdapterConstructions` drops to 0. **Done.**
4. `PlatformAdapter` changes:
   - Delete `isVsCode` and `openTextFile`.
   - Move `focusDashboard` to host actions and update `WorkflowOrchestrator`
     and `WorkflowExecutor`. **Done.**
   - Add `interactiveTerminal`, replacing `CliIntegration.isVsCodeContext()`
     and `runtimeState.isVsCodeContext` (see "Capability Boundaries"). **Done.**
5. Keep VS Code `InputBox`, `QuickPick`, native documents, and post-operation
   actions in thin command facades in `extension.ts`. `TemplateImporter`'s
   share of this item disappeared when the file was deleted.
6. Headless CLI paths keep explicit defaults or return unsupported results
   for operations that need user input. Every one of them exists today, so
   this is a regression check, not new work.

### Phase 4 — Host-neutral router and dashboard application (Staging Stages 3 and 6)

**Status (2026-10-06):** Complete. Router Stage 3 and the dashboard
application Stage 6 are done.

**Router half (Stage 3):**

1. **Stage 3a and 3b complete.** Host-native rows use injected
   `DashboardHostActions`; run/pause/resume/stop use the same orchestrator
   methods from commands and router; merge calls `mergeManagedWorktreeAtRun`
   directly. The VS Code merge command retains its native error reporting.
2. **Done.** Inject `DashboardHostActions`, workspace roots (a
   `() => NamedRoot[]` resolver instead of `VsCodeWorkspaceRoot`), and the
   existing feedback and interaction ports into the router.
3. **Done.** Removed routine worktree success notices. Worktree failures return
   typed replies scoped to the initiating client, and the dashboard surfaces
   replies carrying an error. Removed the router from the boundary allowlist;
   the Phase 0 boundary baseline is 41.
4. **Done.** Router tests use a fake `DashboardHostActions` with **no** optional
   methods. Every host-native message produces a typed `unsupported` reply;
   direct orchestration and two-client worktree reply scoping are covered.

**Application half (Stage 6, after Phases 5 and 6 made the delegates
host-neutral):**

5. **Done.** Extract `src/ui/DashboardApplication.ts` from `CtrlYokeWebviewProvider`. It
   owns the router, delegates, secret registry, interaction port, history
   search, and client registry, and implements `DashboardClientEndpoint`.
6. **Done.** `CtrlYokeWebviewProvider` owns the VS Code view lifecycle: HTML,
   nonce, `asWebviewUri`, panel READY/reconnect, and theme capture. It
   forwards messages to the application.
7. **Done.** `CtrlYokeHostedServer` takes a `DashboardClientEndpoint` instead of
   `CtrlYokeWebviewProvider`. Theme recapture goes through
   `requestThemeCapture?`.
8. **Done.** Preserve `WebviewClientContext` reply scoping and READY/replay semantics.
   The existing two-tab scoping tests must pass unchanged.

Don't add a parallel `WebSocketMessageRouter`, and don't copy handlers into a
`BaseMessageRouter` hierarchy.

### Phase 5 — Decouple shared UI services (Staging Stage 4)

1. **DONE 2026-07-24 to 2026-08-06** (commits `6b1e8040`, `aad4be61`,
   `effbc9be`): `WorkflowMutationCoordinator`, `WorkflowStepHandlers`,
   `UndoRedoCoordinator`, and the terminal handlers now return typed, scoped
   results. The two-tab isolation test is in `CoreFeedbackMigration.test.ts`.
   This was also `BROWSER_USER_FEEDBACK_PLAN.md` Phase 3.
2. **DONE — Stage 4a.** `McpManagerService` is host-neutral and replies through
   `ctx.emit`; `HarnessFileMessageService` uses `revealInOs?`, with a browser
   workspace-viewer fallback when the host does not support OS reveal.
3. **DONE — Stage 4a.** `WorkflowSerializer` receives explicit roots, a
   `KeyValueStore` with `get<T>(key): T | undefined`, `selectWorkspacePath?`,
   and `openWorkspaceTarget`; native picker defaults, filters, and remembered
   directories are preserved.
4. **DONE — Stage 4b.** `WebviewSettingsSync` gets explicit roots, `selectWorkspacePath?` (which
   keeps the OS-picker carve-out), the `HostedServerControl` port, and the
   extracted `src/server/ServerCertificateService.ts`. The certificate service
   takes an explicit `certDir` and holds the CA and LAN-SAN generation from
   `:1640-1728`.
5. **DONE — Stage 4b, direct host boundary.** `PromptEditorSupportService` gets
   explicit roots and `openWorkspaceTarget`; it still reaches VS Code
   transitively through `CompletionHelpers` until Stage 5b.

### Phase 6 — Decouple utilities and completions (Staging Stage 5)

1. **Done — Stage 5a.** Split `FileSystemUtils`. Neutral JSON/file helpers stay
   in the shared file; `saveIfDirty` moves to `src/platform/VsCodeDocuments.ts`.
2. ~~Replace `workspace.fs` in attachment builders.~~ **Done 2026-10-04.**
3. ~~Pass roots into discovery utilities, agent discovery, and skill
   discovery.~~ **Done.** All three take explicit roots.
4. **Done — Stage 5b. Node completion core.**
   - Build a host-neutral `src/completions/CompletionCore.ts` from the parts
     of `CompletionHelpers.ts` that have no VS Code dependency. It lists files
     with `getGitTrackedFiles` (`GitUtils.ts`, `git ls-files --cached
--others --exclude-standard`), and falls back to a walker outside git. Extract
     `walkSearchFiles` from `HostedWorkspaceViewerService` into a shared
     utility, so the viewer search and completions use one implementation.
     **Done — Stage 5a:** extracted as `WorkspaceSearchFileWalker.ts`. **Don't add
     `fast-glob` or `ignore`**: git already implements gitignore semantics,
     and the extracted walker is the fallback.
   - **Done — Stage 5a.** Use project-owned completion kinds from
     `COMPLETION_ITEM_KINDS` in `BranchCompletionHelpers` and
     `SlashTokenCompletionHelpers`; the VS Code conversion maps them in one
     place.
   - The VS Code providers map items to `vscode.CompletionItem`.
   - **Live editor state goes through an optional `EditorContextSource`
     port**, not through the providers:
     - `getSelections()` feeds `#selection:` completions and the `#`
       `partial` response.
     - `getVisibleOutputChannels()` feeds output-channel `@` completions.
     - Both read `vscode.window.visibleTextEditors` today, in
       `CompletionHelpers.ts` `getSelectionCompletions` and
       `getOutputChannelCompletions`.
     - The **dashboard** path (`PromptEditorSupportService` →
       `getHashSelectionCompletions`) uses them as well as the VS Code editor
       providers. So the port is injected into the completion core, and the
       VS Code composition root supplies `VsCodeEditorContextSource`.
     - Standalone supplies none, so its selection and output-channel lists
       are empty.
     - Golden test: the panel's `#` partial response still lists the current
       VS Code selections.
   - **Symbols go through the `SymbolIndex` port** from
     `WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`:
     - Implement `VsCodeSymbolIndex` here, with the one-time 0-based
       `vscode.SymbolKind` → 1-based `LspSymbolKind` conversion.
     - Change `mapSymbolKindToCompletionKind`/`mapSymbolKindToReferenceKind`
       to take `LspSymbolKind`.
     - `getWorkspaceSymbolCandidates`' full-query plus 3-character-prefix
       strategy stays **above** the port in the completion core, so every
       index gets it.
     - `findSymbolKindForReference` takes a viewer path, not a `vscode.Uri`.
   - **Done — Stage 5c:** remove pre-core implementations from
     `CompletionHelpers.ts`; keep its VS Code composition/conversion helpers;
     import `PlainCompletionItem` from `CompletionCore`; and move behavior
     coverage onto fake `CompletionWorkspace` instances in
     `CompletionCore.test.ts`.
   - Golden test: `#sym:` insert text and icons are unchanged in VS Code. The
     shared completion-kind icon map is consumed by the webview and golden
     test, and an extension-host test covers VS Code-to-LSP kind conversion.
5. ~~Split model registry sources.~~ **Done 2026-10-04.**
6. ~~Refactor `Log` to host-provided sinks.~~ **Done 2026-10-04.**
7. **Done — Stage 5a.** Give `ScriptCommandCompletionHelpers`' `**/package.json`
   watcher the `FileWatcherFactory` and injected roots.

### Phase 7 — Standalone application/server composition (moved)

**Moved on 2026-10-06** to `STANDALONE_SERVER_PLAN.md` Phases 5–6 and its
Phase 10 guard-root bullet (staging Stage 7a). The obligations as they stood:

`STANDALONE_SERVER_PLAN.md` Phases 5–7 own the details. The decoupling
obligations are:

1. Build Node host services from one canonical `cwd`
   (`createNodeHostServices`). There is no `.code-workspace` parsing and no
   fabricated `vscode.WorkspaceFolder`.
2. Construct `WorkflowOrchestrator` and `DashboardApplication` from those
   services, with a browser-only `DashboardHostActions` that implements only
   `openWorkspaceTarget` and `openContentPreview` (as scoped replies that the
   browser renders in the workspace viewer).
3. Reuse `CtrlYokeHostedServer` through `DashboardClientEndpoint`. Construct
   `HostedWorkspaceViewerService` with one named root.
4. Add `src/cli/ServerCommand.ts` as a guard root.

### Phase 8 — Retire the Node-side shim (moved)

**Moved on 2026-10-06** to `STANDALONE_SERVER_PLAN.md` Phase 11 (staging
Stage 10), which is now the authoritative copy. The items as they stood:

1. Verify `ctrlyoke run`, `validate`, `commit`, `history`, `status`, `step`,
   `secret`, and `server` with the real Node module graph. The CLI/MCP static
   guard already passes.
2. Remove `registerCliAdapter()`/`unregisterCliAdapter()` and their two
   callers in `cli.ts` (`:911` and `:2339`). The only remaining reader is the
   shim's own `getConfiguration`.
3. Remove the `vscode` → `src/platform/vscode-shim.ts` alias from **all four**
   Node bundles in `esbuild.js`: `cli`, `mcp-server`,
   `historySearchRebuildWorker`, and `historySearchMatcherWorker`.
4. Delete `vscode-shim.ts`.
5. Fail the build if any Node bundle's metafile contains the `vscode` package,
   `@vscode/extension-telemetry`, or a `src/platform/VsCode*` file.

The browser-side `standalone-shim.js` remains. It replaces
`acquireVsCodeApi()` in the browser and is unrelated to the Node-side
`vscode-shim.ts`.

## Testing Strategy

### Contract tests

Run the same suites against VS Code and Node implementations where practical:

- workspace root/named-root behavior;
- watcher create/change/delete/dispose, including atomic rename (Stage 1);
- user feedback and headless choice fallback;
- `DashboardHostActions`: every optional method absent → typed `unsupported`
  reply, never an exception (Stage 3);
- `interactiveTerminal` selects the PTY path for any adapter that declares
  `embedded-pty` (Stage 2);
- `KeyValueStore` get/update on the extension memento and the Node file store
  (Stage 4).

### Shared application tests

- instantiate `WorkflowOrchestrator` and `DashboardApplication` from Node host
  services (Stage 7a);
- run/load/validate a workflow using a temporary single root;
- route every dashboard message through an in-memory transport;
- verify request-scoped versus broadcast replies with two clients;
- verify file-watch recovery and CLI watch sessions;
- verify template and serializer operations using Node filesystem services.

### Build tests

- build the extension and CLI/server bundles;
- inspect the server/CLI metafile for forbidden VS Code modules/files;
- run `node out/cli.js --help`, `validate`, and a representative headless run;
- start the standalone server from the packed npm artifact, not only source.

### Regression tests

- VS Code native file links still open in an editor.
- Hosted browser links still open `WorkspaceFileEditor`.
- VS Code native dialogs remain available from the panel.
- Hosted/standalone browser path selection remains web-native.
- Extension multi-root behavior remains unchanged.
- Standalone stays intentionally single-root.

## Open Questions

None remain open. All of them were resolved by 2026-10-06:

1. **Stage 2 landing strategy.** Decided on 2026-07-29 and amended on
   2026-09-17: test-first, using the _static_ guard (a shrink-only graph plus a
   constructor-signature assertion). The runtime "no `vscode` module
   loadable" check comes from the Phase 8 metafile gate and the CLI/MCP
   static graph guard. Phase 1 shipped this way.
2. **`DashboardHostActions` shape.** Resolved on 2026-10-06 from the 16
   current `executeCommand` sites, the 5 native document/dialog sites in the
   router and its delegates, and the two orchestrator `focusDashboard`
   callers. See the interface and call-site table in "Dashboard host actions".
   Two required methods and eight optional host-native ones, with no command
   passthrough. Server enable/disable/regenerate-token is a separate
   `HostedServerControl` port, because it is not a dashboard-host concern.
3. **`Log` sink configuration.** Resolved by the 2026-10-04 implementation.
   Composition roots push changes in (`Log.setLogLevel`,
   `Log.setDiagnosticFileLogging`), and `Log` has no listener of its own. See
   "Logging".
4. **`PlatformAdapter.isVsCode()`.** Resolved on 2026-10-06: delete it, since
   it has no callers. The real branch is `CliIntegration`'s duck-typed
   `isVsCodeContext()`, which becomes the explicit `interactiveTerminal`
   capability (`embedded-pty` | `inherit-stdio`). The question was never
   "is this VS Code?" but "is there a dashboard terminal?". The standalone
   server answers `embedded-pty`. See "Capability Boundaries".

## Acceptance Criteria

- **DONE 2026-09-17:** `WorkflowOrchestrator` and `WorkflowInstance` have no
  `vscode` import or `ExtensionContext` dependency.
- **DONE 2026-08-02:** `PlatformAdapter` no longer declares `log`, `warn`,
  `error`, `showProgress`, or `showChoice`, and `adapterUi` is 0.
- **DONE 2026-08-17:** no reusable code path can block execution on a prompt
  whose headless behavior is undefined (`BROWSER_USER_FEEDBACK_PLAN.md`
  Phase 4).
- **DONE 2026-10-04:** `src/cli.ts` and `src/mcp-server.ts` reach no `vscode`
  load.
- **DONE — Stage 2:** `vscodeImportersReachableFromOrchestrator` and
  `coreVsCodeAdapterConstructions` are 0.
- **DONE — Stages 1 and 5:** all seven production watcher sites use `FileWatcherFactory` (zero direct
  `vscode.workspace.createFileSystemWatcher` calls outside `VsCodeFileWatcher.ts`), and a contract suite
  passes against both the VS Code and chokidar implementations (Stages 1
  and 5).
- **DONE — Stage 2:** `PlatformAdapter` has no `isVsCode`, `openTextFile`, or `focusDashboard`;
  `interactiveTerminal` is explicit (Stage 2).
- **DONE — Stage 6:** `WebviewMessageRouter`, its delegates, and `DashboardApplication` have no
  direct VS Code commands, window, workspace, URI, `Memento`, or editor
  dependencies (Stages 3–6).
- **DONE — Stage 6:** One `DashboardApplication` and one `CtrlYokeHostedServer` class serve the
  VS Code panel and the VS Code-hosted browser. The standalone browser
  reuses both in Stage 7a (standalone plan).
- **Moved to the standalone plan (Stage 7a):** Node composition uses one
  root without fabricating VS Code workspace objects.
- **DONE:** valid VS Code-native integrations stay native and
  extension-only; `npm test` passes with no changed VS Code behavior.
- **Moved to the standalone plan (Stage 10, its Phase 11):** no Node bundle
  aliases `vscode-shim.ts`, and the metafile check fails on any `vscode`
  package or `src/platform/VsCode*` file.
