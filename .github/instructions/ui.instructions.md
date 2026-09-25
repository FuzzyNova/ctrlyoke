---
applyTo: "src/ui/**"
exclude: "src/ui/webview-react/**"
---

<purpose>
VS Code-side dashboard adapter layer. It owns panel/browser lifecycle, message routing, state replay, persistence helpers, notifications, and PTY coordination. The actual React UI lives under `src/ui/webview-react/` and has separate instructions.
</purpose>

<architecture>
This folder is mostly adapter code around three interfaces:

- `IDashboardProvider` = registry/broadcast events for whole workflows.
- `IDashboardSink` = fine-grained per-workflow/per-step updates.
- `PostMessageFn` = transport boundary to either the VS Code panel or a hosted browser client.

Key roles:

- **`DashboardBroadcastHub`** fans out shared events to all connected clients, but intentionally does **not** broadcast active-workflow selection or full session replay. Those are per-client operations.
- **`PostMessageDashboardSink`** is the single source of truth for `IDashboardSink` → message payload translation. If a sink method changes, update this file first and keep provider/server delegates thin.
- **`CtrlYokeWebviewProvider`** is the VS Code-specific shell: generates secure HTML, owns READY/RECONNECT lifecycle, queues prompt-editor insert requests until the panel is actually ready, and adds panel-only side effects around otherwise-shared sink behavior.
- **`WebviewMessageRouter`** is the inbound control plane. It uses a dispatch table plus a chained `routeQueue` so most UI mutations happen serially, but long-running workflow execution/resume paths are deliberately fire-and-forget so the queue does not deadlock.
- **`WebviewSettingsSync`** owns global settings, workflow-property syncing, harness availability, agent/skill discovery, and the `capabilities.json` file consumed by the external MCP server process.
- **`WorkflowSerializer`** owns workflow save/export/history flows and strips runtime-only working-file data by explicit allowlists before writing YAML/JSON.
- **`NotificationManager`** is just another hub client; notification payload construction lives in `notifications/CompletionNotificationFactory.ts` so browser and VS Code notifications share wording/rules.
  </architecture>

<terminology>
**Critical:** "Provider" has been renamed to "harness" throughout the codebase
- Old: copilot-cli provider, claude-cli provider
- New: copilot-cli harness, claude-cli harness
- Constants: HARNESS_IDS (not PROVIDER_IDS)
- Types: Harness type (from CtrlYokeTypes)
- Configuration: ctrlyoke.harness setting
- Always use "harness" in new code, comments, and messages
</terminology>

<criticalPatterns>
**Per-client replay vs broadcast:** `DashboardBroadcastHub` is for shared events only. Full workflow state, active workflow changes, and targeted startup completion go through per-client replay/send paths.

**Panel reconnect logic is deliberate:** `CtrlYokeWebviewProvider` sends `RECONNECT` with retry/backoff because VS Code can retain the old iframe across extension-host restarts. Do not “simplify” this by reassigning `webview.html`; that caused raw-HTML/blank-panel regressions.

**READY handling is asymmetric:** panel READY and browser READY differ. Browser READY may complete startup follow-up in the background to avoid blocking the shared router queue; panel READY also replays PTY/controller state and flushes queued editor inserts.

**Terminal ownership is multi-client:** `TerminalMessageHandlers` treats PTY sessions as controller/viewer state. Only the controller may send input/resize; ownership changes are broadcast with `TERMINAL_CONTROLLER_CHANGED`, and router READY / orchestrator switch-workflow replay paths must preserve that behavior.

**Everything describing "the current workflow" is client-scoped, INIT included:** always pass the right `clientId` when reading/updating working-file-backed properties, and never let a payload bound for one client be built from another's view. Browser clients and the panel routinely look at different workflows. The sharp edge is that `WorkflowOrchestrator.getInstanceForClient` _falls back to the panel's instance_ for a client with no binding, and `unregisterClient` drops a browser client's binding on **every** socket close — so an unqualified read at READY time silently substitutes the panel's workflow on every reconnect, which on a flaky mobile link repeatedly threw the browser off whatever the user was viewing. `WebviewSettingsSync.getCurrentState` is the cautionary example (it read `PANEL_CLIENT_ID` unconditionally); it now takes the receiving client's id and returns the empty state for an unbound non-panel client, letting `handleClientReady`'s replay be the only thing that sets a browser's view. Use the strict `getBoundInstance` (null, no fallback) for any new read that describes a specific client; the panel alone is entitled to the fallback, because that instance is its own lazily created default.

**A successful definition-mutation handler must echo its own client with `WorkflowMutationCoordinator.publishViewIdentity` (revisions only), never a full `RUN_VIEW_LOADED` snapshot (`refreshDefinitionMutationView`/`loadRunViewForClient`).** The client's `RUN_VIEW_LOADED` handler treats a snapshot as "the same view" (and preserves runtime + zundo undo/redo history) only when the incoming `definitionRevision` equals what it already has — but the write that triggered the echo always bumps that revision, so an echoed full snapshot is _always_ read as a genuine new view and unconditionally clears the client's entire zundo temporal stack (`useWorkflowStore.temporal.getState().clear()` in `workflowStore.loadWorkflow`), wiping past _and_ future. This isn't only a draft-vs-run distinction: `refreshDefinitionMutationView` only skips its `loadRunViewForClient` snapshot when the mutation's address is `"run"` (a promoted run — `invalidateRunViews` already broadcast identity-safe content there); a **draft/idle** workflow's address is not `"run"`, so every one of these handlers sent the wipe-triggering snapshot for as long as it used this call. `handleUndoRedoSync` was the first fixed; `handleUpdatePrompt`, `handleInsertWorkflowStep`, `handleUpdateFinalStep`, `handleDeletePrompt` (`WorkflowStepHandlers.ts`), and the `REORDER_PROMPTS` inline handler (`WebviewMessageRouter.ts`) all carried the identical bug — e.g. editing a step's harness override on an idle/draft workflow silently reset the undo stack right after `STEPS_EXTENDED` recorded the edit's entry, so Undo stayed disabled even though the edit itself worked. All now use identity-only publish on success. Reserve the full-snapshot path for when the client is genuinely learning a _new_ address (e.g. its first edit materializing a draft) or for correcting a client whose local optimistic state is known-wrong (e.g. `handleUndoRedoSync`'s catch path forces a full resync after a rejected write, since the client already applied that undo/redo locally before the server confirmed it).

The same trap exists one layer down, for run-addressed (promoted) definition writes: `WorkflowOrchestrator.applyRunAddressedMutation`'s `invalidation` parameter defaults to `"snapshot"` (broadcasts a full `RUN_VIEW_LOADED` to every viewer of that run, including the acting client) and must be passed `"properties"` explicitly for any write that doesn't change `steps`/`finalStep` — `updateWorkingFileProperties` and `updateWorkflowName` both do this now. Forgetting it (as `updateWorkflowName` originally did) reproduces the exact temporal-wipe symptom above for promoted runs specifically: renaming a saved run briefly enables Undo (the independent `WORKFLOW_NAME_UPDATED` broadcast lands first) and then the trailing `"snapshot"` invalidation's `RUN_VIEW_LOADED` echo clears it again. Note `syncStepsForUndoRedo`'s own run-addressed branch still correctly defaults to `"snapshot"` (it genuinely rewrites `steps`, which `invalidateRunViewProperties` deliberately excludes) — so undo/redo on an already-promoted run still clears its own temporal stack after every action; only the draft-address path and this rename path are fixed. Fully fixing the promoted-run undo/redo case would need the client's `RUN_VIEW_LOADED` handler to distinguish "content-identical echo of my own action" from "genuinely new content" rather than keying off revision equality alone.

**A workflow-property patch cannot express a delete by itself, and undo is the thing that breaks when you forget.** Every webview → extension message crosses as JSON, which drops members whose value is `undefined` — and `undefined` is exactly how `applyWorkflowPropertyWrites` is told to remove a property. So the sender lists the keys it is clearing beside the patch (`clearedWorkflowPropertyKeys` in the webview, `restoreClearedWorkflowProperties` in `src/utils/WorkflowPropertyPatch.ts` on arrival) and `UPDATE_WORKFLOW_PROPERTIES` / `UNDO_REDO_SYNC` both carry it. Two symptoms this cost: a patch that _only_ cleared arrived as `{}` and `handleUpdateWorkflowProperties` returned early without writing anything (moving Trusted External Roots back to "Inherit" persisted nothing), and `syncUndoRedo` could only ever overwrite a property, never take it back off the workflow — so every "set X on a workflow that had no X, then Undo" reverted on screen and left X on disk, for **seventeen** of the properties drawer's gestures. An undo snapshot is the complete normalized key set (`normalizeWorkflowProperties` fills every `WORKFLOW_PROPERTY_KEYS` entry), which is what makes its `undefined` members trustworthy as "this property was not set" rather than "this client didn't know about it". Relatedly, `syncUndoRedo` must project the snapshot through `WORKFLOW_PROPERTY_KEYS` and not a list written out here: it used to keep its own copy of fourteen keys, so `secrets`, `vars`, `errorBehavior`, `worktree` and `trustedExternalRoots` were undoable on screen and never written back, and anything added later inherited that gap silently. `WorkflowPropertiesPanelUndoRedo.test.tsx` drives every drawer control through a working-file simulator to keep all of this honest.

**Saving workflows is allowlist-based:** `WorkflowSerializer` intentionally persists only explicitly enumerated workflow/prompt fields. When adding a new persisted property, update the serializer allowlists or the UI will appear to work but saves will silently drop it.

**Save As owns bundle portability:** `WorkflowSerializer` is the write boundary for exported workflow definitions and their sibling `*.assets/` files. Keep `.ctrlyoke/prompts/` and `.ctrlyoke/attachments/` ignored only in a release where Save As bundles generated-store references; otherwise a newly created ignored dependency can leave a tracked workflow dangling on another clone. The analyzer remains write-free, while the serializer must preserve its stage-assets → workflow → manifest → prune ordering and fail safe when the manifest is absent or invalid.

**Capabilities file is external contract:** `WebviewSettingsSync.writeCapabilities()` feeds the separate MCP server process. If harness/model availability semantics change, keep this file in sync.

**Theme vars come from the panel:** `THEME_VARS_CAPTURED` is forwarded through `CtrlYokeWebviewProvider`/`WebviewMessageRouter` so hosted browser clients can mirror VS Code theme colors.

**Inline image previews are host-gated, workspace-wide:** `PromptEditorSupportService.handleFilePreviewUriRequest` resolves any harness-referenced image path (using the same `resolveNamedRelativePath` + trusted-root containment as `@`-references, so multi-root works) and returns a URI only when it lands inside an open workspace folder and is an allowed image type. Because that host-side check is the real security boundary, `CtrlYokeWebviewProvider.getImageResourceRoots()` deliberately puts **every workspace folder** on `localResourceRoots` (not just `.ctrlyoke/temp`+`attachments`) so the panel can stream any workspace image via `asWebviewUri`; the webview never constructs these URIs itself. Do not re-narrow `localResourceRoots` back to the `.ctrlyoke` dirs, and do not add a duplicate client-side allow-list — the gate belongs host-side, in `PromptEditorSupportService`.

**Opening a file must branch on whether a line was requested:** the `OPEN_FILE` handler (`PromptEditorSupportService.handleOpenFile`) uses `showTextDocument` **only** when a line target is present (a selection needs a text editor). With no line it opens via the `vscode.open` command so VS Code picks the editor by file type — otherwise binary files (images, PDFs) throw `CodeExpectedError: File seems to be binary and cannot be opened as text`. Clicking an inline image thumbnail hits this path, so it must never force a text editor.

**Output-capture completions (`@`/`#` picks that attach an Output-panel snapshot) always resolve to a fresh `@<path>`, which breaks the "trigger char stays in the document" convention every other completion in this system follows — both resolution paths must consume the trigger character, not just the placeholder text after it.** `NativeOutputCaptureCommand.ts`'s `findOutputPlaceholderRange()` and `CodeMirrorEditor.tsx`'s captureId `apply()` closure (webview) both search backward/replace from the trigger character's own position, not the position just after it — otherwise a `@`-triggered capture doubles into `@@path` and a `#`-triggered one (range capture, see `OUTPUT_PANEL_CONTEXT_CAPTURE_PLAN.md`) leaves a stray `#@path`. Both call sites share `OutputSnapshotService.savePendingOutputSnapshot()` for the actual attachment write (which returns a bare path, no leading `@`), so the `@` is only ever added once, at final-resolve time, by the caller that also strips the trigger. If you touch one of these two resolution paths, check the other stayed in sync.

**External file trust is centralized in `ExternalFileTrustPrompt.ts`:** `openResolvedTarget()` is the single dispatcher for opening an already-trusted path (directory reveal / line-selection / `vscode.open`) — `PromptEditorSupportService.handleOpenFile()` uses it for its trusted-path branch, and the shared `ctrlyoke.confirmExternalFileTrust` command uses it after approval, so both call sites open things identically. Do not inline a second copy of that open-dispatch logic; add a new open behavior there if one is ever needed. `confirmExternalFileTrust()` is the only place that shows the "Trust Parent Folder" modal and writes to **user-scope** `permissions.trustedExternalRoots` — both `PromptLinkProvider` (editor Ctrl+click, via the command) and the dashboard `OPEN_FILE` flow route through it rather than duplicating the confirm UX. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
</criticalPatterns>

<relatedFiles>
- `src/ui/CtrlYokeWebviewProvider.ts` — outer shell for HTML/bootstrap, READY/RECONNECT, panel-only behavior
- `src/ui/WebviewMessageRouter.ts` — inbound dispatch table and client-scoped routing rules
- `src/ui/WorkflowStepHandlers.ts` — step-definition mutations, workflow-property writes, undo/redo step synchronization, and stable-address run lifecycle actions delegated by the router
- `src/ui/PromptEditorSupportService.ts` — prompt-editor support handlers the router delegates to (completions, ref validation, pasted images, inline image previews, `OPEN_FILE`, prior-context preview, attachment token counts)
- `src/ui/HarnessFileMessageService.ts` — agent/skill file-manager handlers the router delegates to (enumerate, export/import, delete, sync-all, reveal target dir)
- `src/ui/McpManagerService.ts` — MCP registry, discovery, export, and harness-config removal handlers the router delegates to
- `src/ui/TerminalMessageHandlers.ts` — PTY input/resize/control handlers plus panel reconnect replay
- `src/ui/WebviewSettingsSync.ts` — settings/workflow-property sync plus capabilities.json generation
- `src/ui/PostMessageDashboardSink.ts` — canonical sink-to-message translation
- `src/ui/WorkflowSerializer.ts` — save/export/history logic and persistence allowlists
- `src/ui/notifications/CompletionNotificationFactory.ts` — shared notification event builder
- `src/ui/ExternalFileTrustPrompt.ts` — shared "Trust Parent Folder" confirm + trusted-open dispatch (dashboard `OPEN_FILE` and the `ctrlyoke.confirmExternalFileTrust` command)
- `src/ui/webview-react/` — actual React UI; see separate instructions
</relatedFiles>
