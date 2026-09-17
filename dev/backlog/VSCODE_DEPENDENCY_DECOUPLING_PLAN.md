# VS Code Dependency Decoupling Plan

**Status (2026-07-29):** Proposed. This is the shared-foundation plan for making
`ctrlyoke run` and the future `ctrlyoke server` use a Node-only runtime graph
instead of depending on the CLI esbuild `vscode-shim`.

**Related plans:**

- [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md)
- [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md)

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

## Non-Goals

- Removing VS Code from the extension entry point or VS Code-native features.
- Supporting multi-root standalone workspaces in the first release.
- Reimplementing VS Code editor, Quick Pick, workspace trust, or status bar in
  Node.
- Building a generic remote command-execution protocol.
- Preserving the current internal constructor signatures; the project is
  pre-release and should prefer the cleaner architecture.

## Audit Method and Snapshot

The audit parsed production `.ts`/`.tsx` files with the TypeScript AST, excluding
tests, comments, and declarations.

### Summary

| Finding                                                        | Count |
| -------------------------------------------------------------- | ----: |
| Production files importing `vscode`                            |    39 |
| Files directly accessing `vscode.window` or `vscode.workspace` |    33 |
| Direct `window`/`workspace` member accesses                    |   248 |
| `vscode.window` accesses                                       |   163 |
| `vscode.workspace` accesses                                    |    85 |
| Native `show*Message()` calls                                  |   116 |
| Direct `workspaceFolders` reads                                |    39 |
| Direct `createFileSystemWatcher()` calls                       |     5 |

This is broader than the prior standalone-plan audit. Adapter construction and
watchers are load-bearing blockers, but they are not the only VS Code seams in
the standalone-reachable graph.

### Audit blind spot: a `vscode`-free import list is not a host-neutral one

An import/member scan cannot see code that reaches VS Code **through the
injected adapter**. `PlatformAdapter` already declares `log()`, `warn()`,
`error()`, `showProgress()`, and `showChoice()`, all documented as mapping to
`vscode.window.show*Message` in `VsCodeAdapter`. Nineteen call sites use them:

| File                                 | Calls | Kind                                |
| ------------------------------------ | ----: | ----------------------------------- |
| `src/core/WorkflowInstance.ts`       |     9 | `log`/`warn`/`error`                |
| `src/core/WorkflowExecutor.ts`       |     3 | `log`/`warn`/`error`                |
| `src/core/PromptFileParser.ts`       |     3 | `log`/`warn`/`error`                |
| `src/core/EndConditionHandler.ts`    |     2 | `showChoice` — **blocks execution** |
| `src/core/harness/CliIntegration.ts` |     2 | `warn` ×1, `showChoice` ×1          |

None of these files appear in any table above, and all of them are in the
standalone-reachable graph. `EndConditionHandler` is the sharpest case: it halts
a workflow on a native modal that, in the hosted server, renders only on the
host machine. Both of its sites are **deleted rather than ported** — one is
dead code, the other overrides declared `endCondition.onFail` policy. See
`../implemented/BROWSER_USER_FEEDBACK_PLAN.md` Phase 2.5.

**Corollary for every stage: triage before porting.** Some VS Code UI in
reusable code should simply be removed — it duplicates a typed reply that
already exists, announces routine success the dashboard already shows, or asks
at runtime what workflow config already declares. Deleting a site is strictly
cheaper than giving it a message type, a browser renderer, and a headless
fallback. Apply the triage table in `../implemented/BROWSER_USER_FEEDBACK_PLAN.md` Phase 2
before writing any adapter for a call site.

Treat "file has no `vscode` import" as a necessary but insufficient exit
criterion. The real criterion is that reusable code has no path to a host UI
except through an injected capability port whose headless implementation is
defined. See
[`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md) Phase 2.5.

## Exhaustive `window` / `workspace` Inventory

### VS Code boundary files — calls may remain

These files are valid native integrations. Their shared types and domain logic
must move out if a Node path needs them, and standalone code must not import the
files themselves.

| File                                              | Direct APIs                                                                                                                                                                                                                                                           | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/completions/ContextMenuReferenceCommands.ts` | `activeTextEditor` ×4, `showWarningMessage` ×6                                                                                                                                                                                                                        | Keep as Explorer/SCM/editor context-menu integration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/completions/PromptCompletionProvider.ts`     | `activeTextEditor` ×2, `workspaceFolders` ×1                                                                                                                                                                                                                          | Keep as VS Code IntelliSense adapter; extract reusable completion index/query logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/completions/PromptLinkProvider.ts`           | `workspaceFolders` ×1                                                                                                                                                                                                                                                 | Keep as VS Code document-link adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/completions/WorkspaceReferencePaths.ts`      | `asRelativePath` ×1, `getWorkspaceFolder` ×1                                                                                                                                                                                                                          | Keep beside context-menu integration; shared path rules stay in `WorkspaceViewerPath`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/dev/DevCommands.ts`                          | active editor ×1, terminal ×1, webview panel ×1, errors ×6, information ×4, warnings ×2, quick pick ×1, documents/editors ×8, roots ×3                                                                                                                                | Keep dev-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/extension.ts`                                | theme/provider events ×2, errors ×16, information ×2, warnings ×2, input box ×1, quick pick ×2, documents/editors ×4, trust/folder events ×2, roots ×6 — counts corrected 2026-09-02 (original audit undercounted quick pick as ×1 and missed the input box entirely) | Keep as the VS Code composition root, **except** `ctrlyoke.activatePro`'s `showInputBox` and `ctrlyoke.deactivatePro`'s `showQuickPick`-as-confirm — both duplicate a form/modal that already exists in `LicenseSection.tsx` and violate the native-vs-built-in-modal policy above; fix both to match `ctrlyoke.manageLicense`'s existing `openPanel()` + `openGlobalSettingsTab("license")` pattern instead. `ctrlyoke.selectPromptFile`'s quick pick (file picker, no existing webview duplicate) and `ctrlyoke.activateOfflinePro`'s `showOpenDialog` (the file-picker carve-out) remain legitimately native. |
| `src/platform/VsCodeAdapter.ts`                   | six accesses for native messages and editor opening                                                                                                                                                                                                                   | Keep as an explicit implementation boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/platform/VsCodeWorkspaceRoot.ts`             | configuration, workspace file, and `workspaceFolders` ×4                                                                                                                                                                                                              | Keep as the multi-root VS Code resolver input adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/scm/ScmCommitCommand.ts`                     | errors ×2, information ×2, warning ×1, progress ×1, roots ×1                                                                                                                                                                                                          | Keep as a VS Code command facade; commit generation stays in shared services.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/ui/CtrlYokeWebviewProvider.ts`               | `workspaceFolders` ×1                                                                                                                                                                                                                                                 | Keep as VS Code webview lifecycle/URI composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/ui/ExternalFileTrustPrompt.ts`               | information ×1, warnings ×2, quick pick ×1, editor opening ×1, workspace trust ×1                                                                                                                                                                                     | Keep a VS Code trust implementation; move neutral path-policy types/rules out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/ui/NotificationManager.ts`                   | native messages ×3 and window focus state                                                                                                                                                                                                                             | Keep as the VS Code completion-notification sink.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/ui/StatusBarManager.ts`                      | `createStatusBarItem` ×1                                                                                                                                                                                                                                              | Keep as an optional VS Code status sink; remove its construction from shared orchestrator code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Shared/reusable files — direct calls must be removed

| File                                               | Direct APIs                                                                                                                                                                                                              | Replacement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/completions/CompletionHelpers.ts`             | `findFiles` ×2, `workspaceFolders` ×1, `asRelativePath` ×3, `visibleTextEditors` ×1                                                                                                                                      | Split a Node-capable workspace completion index from VS Code active-editor/SCM enrichment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/core/orchestration/ExecutionRootCoordinationWatchSession.ts` (×1) and `src/core/orchestration/ExternalRunWatchSession.ts` (×3) — the file called `CliWatchSession.ts` in the original audit no longer exists under that name (corrected 2026-09-17) | `createFileSystemWatcher` ×4                                                                                                                                                                                             | Inject a host-neutral watcher factory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/core/orchestration/PromptFileLoader.ts`       | `showErrorMessage` ×5                                                                                                                                                                                                    | Inject/scoped user feedback; keep parse errors as returned data where possible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/core/orchestration/PromptFileWatcher.ts`      | `createFileSystemWatcher` ×1                                                                                                                                                                                             | Inject the watcher factory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/core/orchestration/TemplateImporter.ts`       | errors ×4, information ×2, warning ×1, quick pick ×1, document/editor ×2, `workspace.fs` ×5                                                                                                                              | Split import/file operations from VS Code selection/confirmation/opening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/core/orchestration/WorkflowCommandHandler.ts` | errors ×8, information ×3, warnings ×2, inputs ×2, quick picks ×2, documents/editors ×10, `workspace.fs` ×4                                                                                                              | Move domain operations into shared services; keep a VS Code command UI facade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/WorkflowOrchestrator.ts`                 | messages ×7, quick pick ×1, watcher ×1                                                                                                                                                                                   | Inject platform, feedback, watcher, status, and host actions once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/ui/ExternalFileTrustPrompt.ts`                | modal `showWarningMessage` ×1, `showInformationMessage` ×1, `showQuickPick` ×1, plus `openTextDocument`/`showTextDocument`/`executeCommand` in `openResolvedTarget` — new finding, 2026-09-02, not in the original audit | **File splits into two dispositions, not one.** The trust-decision UI — `confirmExternalFileTrust`'s "Trust Parent Folder" confirmation and `promptBatchApprovalForPendingWorkspaceExternalRoots`'s batch-approval picker — is a Shared/reusable-table item per the native-vs-built-in-modal policy above: both convert to the `UserInteractionPort`/`WebviewUserInteractionPort`/`BatchApprovalModal` pattern already shipped for `SecretGrantsTrustPrompt.ts`, with **no native fallback retained**, exactly as detailed in `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md`'s "Approval Flow" and "Trust Parent Folder Dialog" sections (superseding this row's original "browser gets a separate `Modal.tsx`-based dialog" framing — it is one implementation, not two). `openResolvedTarget`'s document-opening calls are a separate, legitimately native concern (opening a file in the VS Code editor) that stays in this boundary table — the browser equivalent is `WorkspaceFileEditor`, already listed elsewhere in this plan as the correct browser pattern for opening a reference. **Not blocked on Phase 4/the standalone-router work** — its two dashboard-originated callers (`PromptEditorSupportService.handleOpenPromptFile`, and the sibling `OPEN_FILE`-handling method around line 1211) already receive `ctx: WebviewClientContext` and simply don't thread it through; its two non-dashboard callers (`extension.ts`'s `ctrlyoke.confirmExternalFileTrust` command and, once staged, `ContextMenuReferenceCommands.ts`'s four context-menu commands) need a panel-reveal-then-await-READY step first, since a webview-only dialog has nothing to render into if the panel was never opened (see `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` for the concrete call sites). This reuses the client-scoped typed-message pattern Phase 5 item 1 already shipped (2026-07-24 to 2026-08-06) for `WorkflowMutationCoordinator`/`WorkflowStepHandlers`/`UndoRedoCoordinator`/terminal handlers, not new plumbing. |
| `src/ui/McpManagerService.ts`                      | native messages ×8                                                                                                                                                                                                       | Return typed results or emit scoped feedback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/ui/PromptEditorSupportService.ts`             | roots ×5, documents ×2, editor ×1, error ×1                                                                                                                                                                              | Inject workspace context and document host; use workspace-viewer HTTP path in browsers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/ui/TerminalMessageHandlers.ts`                | `showWarningMessage` ×2 — **resolved 2026-08-06**                                                                                                                                                                        | Emit client-scoped typed failure/feedback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/ui/UndoRedoCoordinator.ts`                    | native messages ×5 — **resolved 2026-08-06**                                                                                                                                                                             | Emit typed undo/redo results to the initiating client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/ui/WebviewMessageRouter.ts`                   | roots ×2 and temporary-document/editor calls ×2                                                                                                                                                                          | Make the router host-neutral and inject domain-specific host actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/ui/WebviewSettingsSync.ts`                    | roots ×2 and `showOpenDialog` ×1                                                                                                                                                                                         | Inject workspace context; keep browser selection in `FileBrowserModal`, native selection behind a host action. **This is the OS-file-picker carve-out from the native-vs-built-in-modal policy above — the native `showOpenDialog` path is a permanent, intentional keep, not a step toward an eventual modal-only end state.** `handleBrowseAndAddExternalRoot` specifically is not blocked on that host-action port — its `WebviewMessageRouter.ts:1943-1948` call site already passes `ctx.postMessage`; the handler just doesn't use it (confirmed 2026-09-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/ui/WorkflowMutationCoordinator.ts`            | `showErrorMessage` ×1 — **resolved 2026-08-02**                                                                                                                                                                          | Use its existing client-scoped failure contract exclusively.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/ui/WorkflowSerializer.ts`                     | roots ×11, errors ×5, information ×2, warning ×1, open dialogs ×2, save dialog ×1, document/editor ×2                                                                                                                    | Inject workspace/state/file services; move native dialogs/opening to host actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/ui/WorkflowStepHandlers.ts`                   | `showErrorMessage` ×5 — **resolved 2026-08-02**                                                                                                                                                                          | Emit scoped typed operation results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/utils/AttachmentBuilders.ts`                  | `workspace.fs` ×2                                                                                                                                                                                                        | Use Node filesystem primitives behind neutral helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/utils/DiscoveryUtils.ts`                      | `workspaceFolders` ×1                                                                                                                                                                                                    | Accept explicit root/named-root inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/utils/FileSystemUtils.ts`                     | `textDocuments` ×1, `showWarningMessage` ×1                                                                                                                                                                              | Split VS Code dirty-document handling from neutral JSON/file helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/utils/Log.ts`                                 | output channel and configuration-change listener                                                                                                                                                                         | Inject/configure log sinks; VS Code output channel is one sink, console/file are Node sinks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Other `vscode` imports

Six additional production files import `vscode` without a direct
`window`/`workspace` access:

| File                                                  | Dependency                                                                           | Disposition                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/completions/PromptPropertyCompletionProvider.ts` | completion types/classes                                                             | Keep extension-only.                                                                                        |
| `src/core/TemplateManager.ts`                         | `ExtensionContext`, `ConfigurationTarget`, `VsCodeAdapter`, VS Code workspace folder | Refactor to explicit extension path, workspace root, parser/platform, and config writer.                    |
| `src/ui/HarnessFileMessageService.ts`                 | commands and URI                                                                     | Inject host actions; keep filesystem/harness logic shared.                                                  |
| `src/utils/AgentDiscovery.ts`                         | `WorkspaceFolder` type                                                               | Accept a root path or project-owned named-root type.                                                        |
| `src/utils/SkillDiscovery.ts`                         | `WorkspaceFolder` type                                                               | Accept a root path or project-owned named-root type.                                                        |
| `src/utils/ModelRegistry.ts`                          | `EventEmitter` and Language Model API                                                | Use the project emitter and inject an optional VS Code LM-model source; CLI model discovery remains shared. |

## Target Architecture

```text
extension.ts
  -> createVsCodeHostServices(context)
       -> native editor/dialog/trust/status/notification implementations

cli.ts / ServerCommand.ts
  -> createNodeHostServices(cwd, config)
       -> Node filesystem/watch/log implementations
       -> console or browser feedback implementations

Shared application
  -> WorkflowOrchestrator(options)
  -> shared dashboard message router
  -> shared serializers/settings/domain services
  -> dashboard transport (VS Code postMessage or WebSocket)
```

The shared application depends on project-owned interfaces and data only. It
does not accept `vscode.ExtensionContext`, `vscode.WorkspaceFolder`,
`vscode.Uri`, `vscode.FileSystemWatcher`, or VS Code command IDs.

## Capability Boundaries

Avoid turning `PlatformAdapter` into a broad god interface. Keep workspace and
runtime identity there, and introduce small capability ports where behavior has
different lifecycles or semantics.

### `PlatformAdapter`

Keep:

- workspace root(s) and named roots;
- extension/package asset root;
- execution/runtime identity needed by harness integration.

**Remove, once their 19 callers move to dedicated ports:** `log()`, `warn()`,
`error()`, `showProgress()` → `UserFeedbackSink`; `showChoice()` → the
interaction port. Deleting the declarations is part of the work, not a
follow-up — leaving them on the interface is precisely what lets "decoupled"
core code keep opening native dialogs, and no import-boundary lint rule will
catch it.

`openTextFile()` and `focusDashboard()` are already optional host actions and
should move to `DashboardHostActions` for consistency rather than staying as
optional adapter methods.

Avoid `isVsCode()` branches in domain logic when composition can provide the
right implementation directly.

### Watcher factory

Use a project-owned watcher contract:

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

- VS Code implementation adapts `RelativePattern` and URI events.
- Node implementation adapts `chokidar`.
- Callers receive normalized absolute string paths.
- Watcher ownership/disposal is explicit.
- **Site list corrected 2026-09-17 — there are seven production sites, not
  five:** `ExternalRunWatchSession` ×3, `ExecutionRootCoordinationWatchSession`
  ×1, `PromptFileWatcher` ×1, the orchestrator `runner.json` watcher ×1, and
  `ScriptCommandCompletionHelpers.ts:424` ×1 (a `**/package.json` watcher in
  the completion layer, which belongs to Phase 6 rather than Phase 2). The
  orchestrator's site moves in Phase 1; see that phase's item 9.

### User feedback and interactions

Follow
[`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md). Do not use
diagnostic logging as a user-notification substitute.

### Dashboard host actions

Make the shared router depend on domain-specific capabilities rather than
calling `vscode.commands.executeCommand()`:

```typescript
interface DashboardHostActions {
  openWorkspaceTarget(target: WorkspaceOpenTarget): Promise<ActionResult>;
  openContentPreview(content: ContentPreview): Promise<ActionResult>;
  selectWorkspacePath?(
    request: PathSelectionRequest
  ): Promise<string | undefined>;
  revealOutput?(): Promise<void>;
}
```

Prefer direct orchestrator/domain-service calls for run/pause/resume/stop and
workflow mutations. Only genuinely host-native operations belong in this port.

The browser already demonstrates the correct pattern:

- file/directory selection uses `FileBrowserModal`;
- context-reference links use `WorkspaceFileEditor` in hosted mode;
- VS Code panel links use native editor commands.

### Logging

Split formatting/levels from output:

- `VsCodeOutputChannelLogSink`;
- `ConsoleLogSink`;
- existing file/session logging where applicable.

Shared code imports a project logger only. Configuration changes are pushed into
the logger from each composition root instead of the logger subscribing to
`vscode.workspace` itself.

### Model discovery

Split registry aggregation from sources:

- CLI model sources run in every host;
- VS Code LM API source is optional and extension-only;
- standalone uses CLI/static sources;
- subscriptions use the existing project emitter pattern, not
  `vscode.EventEmitter`.

## Cross-Plan Execution Order (canonical)

The three plans each carry their own phase numbering, and
`STANDALONE_SERVER_PLAN.md` additionally carries two internally inconsistent
lists (its "Next Steps" puts the watcher seam second and the shared router
third; its older "Implementation Order" puts them tenth and eighth, and omits
browser feedback entirely). **This table is the single authoritative sequence.**
Where a per-plan phase number disagrees with a stage here, this table wins.

| Stage | Work                                     | Owning plan / phase                           | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----: | ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 | Dependency guards + baselines            | This plan, Phase 0 (absorbs Feedback Phase 5) | CI fails on a new `vscode` import in a shared group, a new `show*Message`, or a 20th adapter-UI call                                                                                                                                                                                                                                                                                                                                                              |
|     1 | Toast queue + `ToastViewport`            | Feedback Phase 1                              | `showToast()` renders; panel shows no duplicate; browser-delivery decision recorded                                                                                                                                                                                                                                                                                                                                                                               |
|     2 | Host composition (orchestrator options)  | This plan, Phase 1                            | **Gate corrected 2026-09-17:** `WorkflowOrchestrator.ts` contains no `vscode` import and no VS Code type in its constructor or public surface, and `new VsCodeAdapter` appears only in `extension.ts`. A _runtime_ "instantiates with no `vscode` module loadable" test is not reachable at this stage — 9 files in the orchestrator's transitive value-import graph still import `vscode` after Phase 1 items 1–7 (measured 2026-09-17 following value imports only), and each is owned by later Phase 1/stage work. That test arrives with Stage 12; the enforceable gate here is the shrink-only import-graph counter from Phase 0 item 3. |
|     3 | Watcher factory                          | This plan, Phase 2                            | All five sites use the port; create/change/delete/dispose contract tests pass on both impls                                                                                                                                                                                                                                                                                                                                                                       |
|     4 | Feedback port + adapter migration        | Feedback Phases 2 and 2.5                     | Adapter-UI counter is 0; no run can block on an unanswerable prompt                                                                                                                                                                                                                                                                                                                                                                                               |
|     5 | Command UI / domain split                | This plan, Phase 3                            | Domain ops callable headlessly; VS Code pickers confined to command facades                                                                                                                                                                                                                                                                                                                                                                                       |
|     6 | Reusable router + client-scoped feedback | This plan Phase 4 **∪** Feedback Phase 3      | One router serves both transports; two-tab test proves no cross-client leakage — **partially done:** the Feedback Phase 3 half (client-scoped feedback / Phase 5 item 1 below) landed 2026-07-24 to 2026-08-06 with a passing two-tab test; the Phase 4 half ("one router serves both transports") has not — `WebviewMessageRouter` is still constructed only by `CtrlYokeWebviewProvider.ts`, not reused by a standalone WebSocket server (confirmed 2026-08-11) |
|     7 | Shared UI services                       | This plan, Phase 5                            | Serializer/settings/editor-support take injected roots and services                                                                                                                                                                                                                                                                                                                                                                                               |
|     8 | Utilities, completions, `Log`            | This plan, Phase 6                            | `Log` writes through injected sinks; discovery takes explicit roots                                                                                                                                                                                                                                                                                                                                                                                               |
|     9 | Interactive choices                      | Feedback Phase 4                              | Every interaction has a defined headless fallback and disconnect behavior                                                                                                                                                                                                                                                                                                                                                                                         |
|    10 | Standalone composition                   | This plan Phase 7 + Standalone Phases 5–9     | Standalone server boots from Node host services and the shared router                                                                                                                                                                                                                                                                                                                                                                                             |
|    11 | `ctrlyoke server` CLI + launch UX        | Standalone Phase 10                           | Tokenized URL/QR/TLS hint printed; Open Question 1 resolved                                                                                                                                                                                                                                                                                                                                                                                                       |
|    12 | Retire the Node-side shim                | This plan, Phase 8                            | CLI/server bundle graph contains no `vscode`; alias and shim deleted                                                                                                                                                                                                                                                                                                                                                                                              |

Notes on the merges:

- **Stage 0 absorbs `BROWSER_USER_FEEDBACK_PLAN.md` Phase 5.** That plan
  scheduled its `show*Message` lint rule last; this plan schedules equivalent
  guards first, with the explicit rationale that the baseline must not grow
  during refactoring. Landing the same rule at both ends is contradictory —
  the rule goes in at Stage 0 with a shrink-only allowlist.
- **Stage 6 is one piece of work, not two.** This plan's Phase 5 item 1
  (`WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`,
  terminal handlers → typed/scoped results) and the feedback plan's Phase 3
  (thread `WebviewClientContext` into those same delegates) describe the same
  edits to the same files. Do them once.
- **Stage 1 is independent** of Stages 2–3 and can run in parallel; it is pure
  React plus one handler gate.
- **Stage 4 gates Stage 10.** `StandaloneServerAdapter` cannot implement
  `PlatformAdapter` until Stage 4 removes the five UI methods.
- `Log.ts` imports `vscode` but is not decoupled until Stage 8. It must be on
  the Stage 0 allowlist from day one; that entry is expected to be long-lived.

## Implementation Plan

### Phase 0 — Add dependency guards

1. Define shared and VS Code-only path groups.
2. Add lint/source-audit rules that reject `vscode` imports in shared groups.
3. **DONE —** Add an explicit temporary allowlist matching this audit. The
   shrink-only transitive-import-graph guard rooted at
   `WorkflowOrchestrator.ts` is in
   `src/test/unit/SourceAuditCounters.test.ts`, using the named baselines
   `vscodeImportersReachableFromOrchestrator` (10 files),
   `orchestratorDirectVsCodeImports` (1),
   `orchestratorVsCodeConstructorParams` (0),
   `workflowInstanceDirectVsCodeImports` (0), and
   `coreVsCodeAdapterConstructions` (1). The graph ignores `import type`
   edges, which are erased at runtime — `CliIntegration.ts` reaches
   `VsCodeAdapter` only that way.
4. Make the allowlist shrink-only.
5. Add a bundle/metafile check for the Node server entry graph.
6. **DONE —** Add a **shrink-only counter for adapter-mediated host UI** —
   `platform.log|warn|error|showProgress|showChoice` call sites, baseline 19.
   An import-graph rule cannot see these, so without a separate counter the
   `vscode`-import metric can reach zero while core code still opens native
   modals.

**DONE —** the absorbed `BROWSER_USER_FEEDBACK_PLAN.md` Phase 5 rule (a
shrink-only direct `show*Message` audit, baselines 49 boundary / 63 reusable)
landed alongside item 6. Both counters live in
`src/test/unit/SourceAuditCounters.test.ts`, count `ts.CallExpression` nodes
rather than lines, and fail in _both_ directions so a baseline cannot go stale.
The seven-file boundary allowlist there is the `show*Message` split only — it is
not the item 3 `vscode`-import allowlist.

This lands before refactoring so the measured baseline cannot grow.

### Phase 1 — Introduce host composition

**Item list re-derived from the current source on 2026-09-17.** The original
list cited line numbers from an older tree, undercounted the adapter
constructions, and stopped short of the seams that actually hold the `vscode`
import in place.

The test-first host-boundary guard is now in place in
`src/test/unit/SourceAuditCounters.test.ts`. Phase 1 items 1–8 landed on
2026-09-17: the orchestrator now accepts a project-owned dependencies object,
has no `ExtensionContext` field or constructor parameter, and receives its
platform, status sink, disposable registry, and workspace state store from the
extension composition root. The guard therefore records
`orchestratorVsCodeConstructorParams` at 0 and
`coreVsCodeAdapterConstructions` at 1; the reachable value-import graph
shrunk from 13 to 9 because the orchestrator no longer reaches
`StatusBarManager`, `VsCodeAdapter`, or `VsCodeSecretStore`. Its direct
`vscode` import remains 1 for the watcher and other later Phase 1 work. Step 9
and later stages remove the remaining importers. The
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
   disposable handles, leaving the runner watcher as its only retained VS Code
   dependency. The measured direct-import baseline remains `1` and the
   transitive importer baseline remains `9`; both still account for the
   intentionally retained watcher and its dependencies.
9. **Pulled forward from Phase 2 item 4:** convert the `runner.json` watcher
   (lines 6743-6757) to the `FileWatcherFactory` contract with a VS Code
   implementation, because it is the orchestrator's last remaining direct
   `vscode` use. Phase 2 keeps the chokidar implementation and the other six
   sites. Its polling fallback (`pollRunnerJsonDiscovery`, every 1s) and its
   deliberate `onDidCreate` + `onDidChange` duality must survive the move —
   both exist because VS Code 1.133 on Windows did not deliver recursive
   events below an external `RelativePattern` base.

**Exit gate.** `src/core/WorkflowOrchestrator.ts` contains no `vscode` import
and no VS Code type in its constructor or public surface; `new VsCodeAdapter`
appears nowhere outside `extension.ts`. See the Stage 2 row above for why the
runtime "no `vscode` module loadable" instantiation test is a Stage 12 gate
rather than this one, and Phase 0 item 3 for the shrink-only counter that
enforces this stage.

Do not keep a VS Code-context default constructor: it would preserve the import
and allow standalone tests to miss hidden construction.

### Phase 2 — Replace all watcher calls

1. Add VS Code and chokidar watcher implementations.
2. Inject the factory into `PromptFileWatcher`.
3. Inject it into `ExternalRunWatchSession` (three watchers) and
   `ExecutionRootCoordinationWatchSession` (one).
4. ~~Replace the orchestrator `runner.json` watcher.~~ **Moved into Phase 1
   (item 9) on 2026-09-17** — it is the orchestrator's last direct `vscode`
   use, so Phase 1's exit gate cannot be met without it. Phase 2 inherits the
   contract and adds the chokidar implementation.
5. Test create/change/delete normalization, atomic rename behavior, and
   disposal.

### Phase 3 — Split command UI from domain operations

1. Extract shared operations from `WorkflowCommandHandler`.
2. Extract template copy/import/overwrite operations from `TemplateImporter`.
3. Refactor `TemplateManager` to accept explicit paths, parser/platform, and
   config services.
4. Keep VS Code `InputBox`, `QuickPick`, native documents, and post-operation
   actions in thin extension command facades.
5. Expose browser equivalents through existing React modals and typed router
   requests.
6. Give headless CLI/server paths explicit defaults or unsupported results for
   operations that require user input.

### Phase 4 — Make the existing router reusable

1. Refactor `WebviewMessageRouter` into a host-neutral dashboard router (rename
   only if it improves clarity).
2. Inject workspace context, host actions, feedback, settings, serializer, and
   domain services.
3. Replace command execution for run/pause/resume/stop with direct orchestrator
   methods.
4. Keep legacy VS Code editor/diff behavior inside the VS Code host actions.
5. Reuse this router from both `CtrlYokeWebviewProvider` and the standalone
   WebSocket server.
6. Preserve `WebviewClientContext` reply scoping and READY/replay semantics.

Do **not** add a parallel `WebSocketMessageRouter` or copy handlers into a
`BaseMessageRouter` hierarchy. Transport already enters through a scoped send
callback; host actions are the missing seam.

### Phase 5 — Decouple shared UI services

Migrate in dependency order:

1. **DONE 2026-07-24 to 2026-08-06 (commits `6b1e8040`, `aad4be61`,
   `effbc9be`), confirmed against `src/` on 2026-08-11.**
   `WorkflowMutationCoordinator`, `WorkflowStepHandlers`,
   `UndoRedoCoordinator`, and terminal handlers to typed/scoped results. Every
   public method on `WorkflowMutationCoordinator` and `WorkflowStepHandlers`
   takes `ctx: WebviewClientContext` and replies only through
   `ctx.postMessage`/`ctx.emit`; `TerminalMessageHandlers` is scoped the same
   way; `UndoRedoCoordinator` takes an explicit `postMessage`/`clientId` per
   call, with `WebviewMessageRouter` passing only the initiating client, not a
   broadcast. `aad4be61` removed the last direct `show*Message` calls from
   exactly these four files (see the now-resolved rows in the inventory table
   above). A two-tab isolation test exists at
   `CoreFeedbackMigration.test.ts:25-45` (one client receives the scoped
   failure, the other receives nothing) — this is a representative test for
   the shared `WebviewClientContext` scoping, not a dedicated per-file test
   for the terminal/undo-redo paths specifically. This was also
   [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md)
   Phase 3 (the same edit set, done once per the Stage 6 merge note above) —
   **Stage 6 in the canonical table above is not fully done from this alone**:
   its "one router serves both transports" half is Phase 4, and
   `WebviewMessageRouter` is still constructed only by
   `CtrlYokeWebviewProvider.ts` — no standalone WebSocket server reuses it yet
   (confirmed 2026-08-11: zero non-test/non-VS Code construction sites).
2. `McpManagerService` and `HarnessFileMessageService` to returned result types
   and host actions.
3. `WorkflowSerializer` to explicit workspace root, state store, filesystem,
   feedback, and optional path selection/opening capabilities.
4. `WebviewSettingsSync` to explicit roots and browser/native picker
   capabilities.
5. `PromptEditorSupportService` to explicit roots, completion service, trust
   policy, and document host.

### Phase 6 — Decouple utilities and completions

1. Split `FileSystemUtils` into neutral file/JSON helpers and a VS Code
   `saveIfDirty` helper.
2. Replace `workspace.fs` in attachment builders with neutral/Node operations.
3. Pass roots into discovery utilities, agent discovery, and skill discovery.
4. Extract a Node-capable completion index; layer VS Code active selection,
   visible editors, symbols, and SCM ignore support on top only in the extension.
5. Split model registry sources and replace `vscode.EventEmitter`.
6. Refactor `Log` to host-provided sinks.

### Phase 7 — Standalone application/server composition

1. Build Node host services from one canonical `cwd`.
2. Reuse the shared router, orchestrator, settings, serializers, and domain
   services.
3. Extract common HTTP/WebSocket/token/TLS/workspace-viewer route installers
   from `CtrlYokeHostedServer` rather than copying its implementation.
4. Construct `HostedWorkspaceViewerService` with one
   `ResolverWorkspaceFolder` for standalone; preserve its named-root contract.
5. Add browser feedback and static theme sources.
6. Add the `ctrlyoke server` CLI composition/command.

### Phase 8 — Retire the Node-side shim

1. Verify `ctrlyoke run`, `validate`, `commit`, and `server` with the real Node
   module graph.
2. Remove `registerCliAdapter()` compatibility reads after all config callers
   use `CtrlYokeConfigService`/injected config.
3. Remove the CLI esbuild alias to `src/platform/vscode-shim.ts`.
4. Delete the shim when no bundle target consumes it.
5. Fail CI if the Node bundle graph contains the `vscode` package or a
   VS Code-only source path.

The browser-side `standalone-shim.js` remains. It replaces
`acquireVsCodeApi()` in the browser and is unrelated to the Node-side
`vscode-shim.ts`.

## Testing Strategy

### Contract tests

Run the same suites against VS Code and Node implementations where practical:

- workspace root/named-root behavior;
- watcher create/change/delete/dispose;
- user feedback and headless choice fallback;
- document open unsupported/supported behavior;
- logger sinks;
- model-source aggregation.

### Shared application tests

- instantiate `WorkflowOrchestrator` with no VS Code module available;
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

Only the first is blocking; the rest can be answered inside their stage.

1. ~~**Stage 2 landing strategy.**~~ **Decided 2026-07-29: test-first.** Write
   the "instantiate `WorkflowOrchestrator` with no `vscode` module available"
   test before touching the constructor, and let it drive the shape of the
   dependency object. It is the only real exit gate for the stage, and having it
   red from the start prevents the refactor from drifting toward a signature
   that merely compiles. A permanent context-based default remains ruled out.
   **Amended 2026-09-17:** the test that leads has to be the *static* one — a
   shrink-only `vscode`-import/graph guard plus a constructor-signature
   assertion — because a runtime load test cannot pass until Stage 12 (16
   files in the orchestrator's transitive graph still import `vscode`, all
   owned by later stages). The test-first ordering is unchanged; only the form
   of the test is. The measured baseline is 10 value-importers; an unfiltered
   scan says 16, because the three completion helpers are reached only through
   a `import type` edge from `WebviewMessageTypes.ts` and are erased at
   runtime.
2. **`DashboardHostActions` shape.** The sketch has four methods. Confirm
   against the actual VS Code-only router call sites that this is sufficient and
   that nothing generic (a command-ID passthrough) creeps back in.
3. **`Log` sink configuration.** Shared code must not subscribe to
   `vscode.workspace` for log-level changes, so each composition root pushes
   configuration in. Confirm the push model covers runtime level changes in the
   extension without a listener in `Log` itself.
4. **`PlatformAdapter.isVsCode()`.** The plan says to avoid `isVsCode()`
   branches in domain logic, but `CliIntegration` uses it to choose terminal vs
   piped execution. Does that become an injected execution capability, or is it
   the one legitimate remaining branch?

## Acceptance Criteria

- `WorkflowOrchestrator` and `WorkflowInstance` have no `vscode` import or
  `ExtensionContext` dependency.
- **DONE 2026-08-02 —** `PlatformAdapter` no longer declares `log`, `warn`,
  `error`, `showProgress`, or `showChoice`, and the adapter-mediated host-UI
  counter is zero.
- No reusable code path can block execution on a prompt whose headless behavior
  is undefined.
- The five watcher sites use the project watcher contract.
- Shared dashboard routing and services have no direct VS Code commands,
  window, workspace, URI, or editor dependencies.
- One router implementation serves VS Code postMessage and WebSocket
  transports.
- Node composition uses one root without fabricating VS Code workspace objects.
- Valid VS Code-native integrations remain native and extension-only.
- `ctrlyoke run` and `ctrlyoke server` do not require `vscode-shim.ts`.
- CI enforces the import and bundle boundaries.
- Browser feedback satisfies
  [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md).
