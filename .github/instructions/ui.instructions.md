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

**Workflow properties are client-scoped:** always pass the right `clientId` when reading/updating working-file-backed properties. Browser clients and the panel can be looking at different workflows.

**Saving workflows is allowlist-based:** `WorkflowSerializer` intentionally persists only explicitly enumerated workflow/prompt fields. When adding a new persisted property, update the serializer allowlists or the UI will appear to work but saves will silently drop it.

**Capabilities file is external contract:** `WebviewSettingsSync.writeCapabilities()` feeds the separate MCP server process. If harness/model availability semantics change, keep this file in sync.

**Theme vars come from the panel:** `THEME_VARS_CAPTURED` is forwarded through `CtrlYokeWebviewProvider`/`WebviewMessageRouter` so hosted browser clients can mirror VS Code theme colors.

**Inline image previews are host-gated, workspace-wide:** `PromptEditorSupportService.handleFilePreviewUriRequest` resolves any harness-referenced image path (using the same `resolveNamedRelativePath` + trusted-root containment as `@`-references, so multi-root works) and returns a URI only when it lands inside an open workspace folder and is an allowed image type. Because that host-side check is the real security boundary, `CtrlYokeWebviewProvider.getImageResourceRoots()` deliberately puts **every workspace folder** on `localResourceRoots` (not just `.ctrlyoke/temp`+`attachments`) so the panel can stream any workspace image via `asWebviewUri`; the webview never constructs these URIs itself. Do not re-narrow `localResourceRoots` back to the `.ctrlyoke` dirs, and do not add a duplicate client-side allow-list — the gate belongs host-side, in `PromptEditorSupportService`.

**Opening a file must branch on whether a line was requested:** the `OPEN_FILE` handler (`PromptEditorSupportService.handleOpenFile`) uses `showTextDocument` **only** when a line target is present (a selection needs a text editor). With no line it opens via the `vscode.open` command so VS Code picks the editor by file type — otherwise binary files (images, PDFs) throw `CodeExpectedError: File seems to be binary and cannot be opened as text`. Clicking an inline image thumbnail hits this path, so it must never force a text editor.

**External file trust is centralized in `ExternalFileTrustPrompt.ts`:** `openResolvedTarget()` is the single dispatcher for opening an already-trusted path (directory reveal / line-selection / `vscode.open`) — `PromptEditorSupportService.handleOpenFile()` uses it for its trusted-path branch, and the shared `ctrlyoke.confirmExternalFileTrust` command uses it after approval, so both call sites open things identically. Do not inline a second copy of that open-dispatch logic; add a new open behavior there if one is ever needed. `confirmExternalFileTrust()` is the only place that shows the "Trust Parent Folder" modal and writes to **user-scope** `permissions.allowedExternalFileRoots` — both `PromptLinkProvider` (editor Ctrl+click, via the command) and the dashboard `OPEN_FILE` flow route through it rather than duplicating the confirm UX. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
</criticalPatterns>

<relatedFiles>
- `src/ui/CtrlYokeWebviewProvider.ts` — outer shell for HTML/bootstrap, READY/RECONNECT, panel-only behavior
- `src/ui/WebviewMessageRouter.ts` — inbound dispatch table and client-scoped routing rules
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
