# Bug Drain 1: Host Lifecycle, Settings & Dashboard Interaction Plan

**Status:** Backlog, ready to run
**Priority:** P1
**Runs as:** plan 1 of 4 in a parallel bug drain. Each plan runs through
`out/templates/workflows/spec-driven-loop.ctrlyoke.yaml` in its own git worktree.
The orchestrator reads this plan, queues one `append_step` per step below, and
then reviews.

## Goal and scope

This plan owns the extension-host lifecycle around the hosted dashboard server
(start, stop, dispose, access gating, completion notifications), the settings
read/write path (`FileConfigBackend`, `CtrlYokeConfigService`,
`WebviewSettingsSync`, the router's settings and snapshot-content handlers),
the Antigravity provider's machine-global `hooks.json` handling, a few
self-contained core fixes (instance registry idle checks, `CliLogMonitor`
settle races, history-search cursor rollback, near-limit warning text), the
React dashboard's undo/snapshot plumbing and input handling (keyboard, touch,
modal Escape, file picker, language-server editor, script-step execution
preview), and two build scripts (`dev-host.mjs` / `package-install.mjs`
quoting, `strip-dev-commands.mjs` backup). 24 bugs, about 27 effort points.

**Orchestrator note (2026-10-14):** Steps 5 and 14 were already fixed on this
branch before the drain started (`730b164ed fix: reload settings after
external file changes`, `1d7841123 fix: format quota reset warnings for local
time`; both docs are in `dev/bugs/implemented/`). They are not queued. 22 bugs
remain across the other 16 steps.

## File ownership

Plans 2, 3 and 4 run **at the same time** in other worktrees and own other
files. A step in this plan may edit only the files listed here (plus their
tests, new files it creates, and user-facing docs). If a fix truly cannot be
made without touching a file owned by another plan, keep that edit minimal
(an import or a one-line call site at most) and name the file and the reason
in the commit message so the merge is expected.

Files this plan owns:

```
package.json
scripts/dev-host.mjs
scripts/package-install.mjs
scripts/spawn-windows-shim.mjs                      (new)
scripts/strip-dev-commands.mjs
src/config/CtrlYokeConfigService.ts
src/config/FileConfigBackend.ts
src/core/harness/antigravity/AntigravityCliProvider.ts
src/core/harness/antigravity/AntigravityNotificationMonitor.ts
src/core/harness/CliLogMonitor.ts
src/core/harness/shared/usage/UsageSelectionAssist.ts
src/core/orchestration/HistorySearchIndexService.ts
src/core/orchestration/WorkflowInstanceRegistry.ts
src/extension.ts
src/platform/VsCodeWorkspaceRoot.ts
src/platform/WorkspaceRootResolver.ts
src/scripts/ctrlyoke-antigravity-hook.js
src/server/CtrlYokeHostedServer.ts
src/server/lsp/LanguageIntelligenceHost.ts
src/ui/NotificationManager.ts
src/ui/notifications/CompletionNotificationFactory.ts
src/ui/webview-react/components/editor/PromptEditor.tsx
src/ui/webview-react/components/output/OutputRow.tsx
src/ui/webview-react/components/settings/LanguageServersSection.tsx
src/ui/webview-react/components/shared/Modal.tsx
src/ui/webview-react/components/workflow/WorkflowFilePickerModal.tsx
src/ui/webview-react/hooks/useLongPress.ts
src/ui/webview-react/hooks/useOutputUndoActions.ts
src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts
src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts
src/ui/webview-react/utils/executionPreview.ts
src/ui/webview-react/utils/promptUndo.ts
src/ui/webview-react/utils/scriptStepProperties.ts  (new)
src/ui/webview-react/utils/time.ts
src/ui/WebviewMessageRouter.ts
src/ui/WebviewSettingsSync.ts
src/utils/FutureTimeFormat.ts                       (new)
```

Files other plans own that this plan's fixes sit next to, and must **not**
edit: `src/cli.ts`, `src/mcp-server.ts`, `src/platform/NodeFileWatcher.ts`
(plan 4); `src/utils/AtomicFileUtils.ts`, `src/types/WebviewMessageTypes.ts`,
`src/ui/webview-react/store/executionPreviewStore.ts`,
`src/ui/webview-react/hooks/useMessageHandler.ts`,
`src/ui/webview-react/components/prompts/WorkflowStep.tsx`,
`src/ui/webview-react/components/prompts/PromptChipRail.tsx`,
`src/utils/HarnessLspExporter.ts`, `src/utils/WorkspaceSnapshotService.ts`
(plan 3); `src/core/harness/shared/SettingsJsonMcpTracker.ts`,
`src/utils/WorkflowLockManager.ts`, `src/core/WorkflowOrchestrator.ts`
(plan 2). Importing from these is fine; editing them is not.

## Steps

Steps run one after another in this worktree, so a later step sees the
earlier steps' commits. The order keeps every shared file's edits sequential:
`CtrlYokeHostedServer.ts` (steps 1-3), `extension.ts` (1, 5, 7),
`WebviewSettingsSync.ts` / `WebviewMessageRouter.ts` (4, 5, 11),
`AntigravityCliProvider.ts` (6, 7), `useOutputUndoActions.ts` (10, 11).

### Step 1: Hosted server start/stop lifecycle

- **Fixes:** `dev/bugs/backlog/disable-server-during-startup-orphans-listening-server.md`,
  `dev/bugs/backlog/failed-hosted-server-listen-leaks-undisposed-server.md`
- **Files:** `src/server/CtrlYokeHostedServer.ts` (`listen`, `dispose`,
  `onListening`, constructor side effects), `src/extension.ts`
  (`enableServer`, `disableServer`).
- **Approach:** add a `disposed` flag set in `dispose()`. `listen()` checks it
  after `await enforceRemoteBindBeforeListen()` and resolves `undefined`; the
  listening callback closes the HTTP server if disposal happened meanwhile.
  Make a rejected `listen()` roll back the constructor-time registrations
  (`hub.addClient`, heartbeat interval, memory context) or move them onto the
  listening path, so the CLI and MCP callers are covered too. In
  `enableServer`, keep a local `const server`, use it after every await,
  and once `listen()` settles verify `hostedServer === server`; if not,
  dispose `server` and return without posting `SERVER_STARTED`. Route both
  failure branches (rejection and `undefined`) through one local cleanup
  helper (dispose, reset reference, clear `unprotectServerToken`).
- **Tests:** `src/test/unit/CtrlYokeHostedServerPortFallback.test.ts`: stub
  `canUseRemoteAccess` with a delayed promise, dispose during the delay,
  assert the HTTP server never listens. `src/test/unit/CtrlYokeHostedServer.test.ts`:
  a `listen()` that rejects with `EADDRNOTAVAIL` leaves the hub without the
  client and the heartbeat cleared.
- **Tricky:** `listen()` resolving `undefined` is currently dead in
  `extension.ts`; after this step it becomes the disposed-during-startup path,
  so keep the extension branch and give it a real meaning. Read
  `server.instructions.md` and `extension.instructions.md` first.

### Step 2: Hosted server sockets and HTTP access gating

- **Fixes:** `dev/bugs/backlog/hosted-lsp-websockets-not-closed-on-dispose.md`,
  `dev/bugs/backlog/hosted-http-routes-skip-remote-access-entitlement.md`
- **Files:** `src/server/CtrlYokeHostedServer.ts`,
  `src/server/lsp/LanguageIntelligenceHost.ts`.
- **Approach (LSP):** in `dispose()`, close every `lspWss.clients` socket
  (or a tracked `Set<WebSocket>`) before `lspWss.close()`. Use 1001 "going
  away" so the browser transport reconnects to a restarted server; also make
  `LanguageIntelligenceHost.dispose()` invalidate sessions rather than
  silently disposing proxies, if that does not double-close.
- **Approach (entitlement):** one gate for HTTP and WS: after the token check
  in `requireToken` / `requireTokenForPage` (or a single app-level middleware
  ahead of `setupRoutes()`), `await this.isClientAllowed(req.socket.remoteAddress)`
  and return 403 when false. Loopback must stay a fast short-circuit.
- **Tests:** `src/test/unit/CtrlYokeHostedServer.test.ts`: open `/ws/lsp`,
  dispose, assert the client sees a close event; a non-loopback request to a
  `requireToken` route gets 403 when `begin()` returns false and 200 when it
  returns true. `src/test/unit/LanguageIntelligenceHost.test.ts` for the
  dispose change.
- **Tricky:** the pre-auth body-parser middleware runs before the token
  check; do not let the new gate parse bodies for unauthenticated callers. A
  non-loopback REST request now starts the remote-access trial; that is the
  intended behaviour. Check whether `docs/guide/` describes remote access /
  trial start and update it if so.

### Step 3: Completion notifications deduped forever

- **Fixes:** `dev/bugs/backlog/completion-notifications-deduped-per-run-forever.md`
- **Files:** `src/ui/notifications/CompletionNotificationFactory.ts` (export
  a `notificationIdentityPrefix(summary)` helper), `src/ui/NotificationManager.ts`,
  `src/server/CtrlYokeHostedServer.ts` (its own `notifiedEventIds` set at
  ~:313, pruning at ~:658, check at ~:2541 has the same flaw).
- **Approach:** clear a summary's keys by prefix when the workflow leaves a
  terminal state (back to running) and when a step re-enters running;
  `notifyWorkflowDismissed` computes the prefix from the cached summary
  before deleting it. Apply the same rule in the hosted server through the
  shared helper; do not duplicate the prefix format.
- **Tests:** `src/test/unit/NotificationManager.test.ts`: complete, append,
  complete again shows two toasts; rewind and re-run a step shows the step
  toast again; dismiss clears the keys. `src/test/unit/CompletionNotificationFactory.test.ts`
  for the helper.

### Step 4: UPDATE_GLOBAL_SETTING write failures surfaced

- **Fixes:** `dev/bugs/backlog/update-global-setting-handler-drops-async-promise.md`
- **Files:** `src/ui/WebviewMessageRouter.ts` (await the handler),
  `src/ui/WebviewSettingsSync.ts` (`handleUpdateGlobalSetting`).
- **Approach:** the router entry awaits the call. Wrap `configService.set` and
  the post-write work in try/catch; on failure report through the user
  feedback sink (same pattern as `reportStatuslineFailure`) and still call
  `handleGlobalSettingsLoadRequest(postMessage)` so the client resyncs.
- **Tests:** `src/test/unit/WebviewSettingsSync.test.ts`: `set` rejects, user
  is notified, settings are reloaded; a router test that the handler's
  rejection is awaited.

### Step 5: Settings file hand edits picked up live

**Already done** in `730b164ed` before this drain ran; not queued.

- **Fixes:** `dev/bugs/backlog/settings-file-hand-edits-ignored-until-reload.md` [M]
- **Files:** `src/config/FileConfigBackend.ts`, `src/config/CtrlYokeConfigService.ts`,
  `src/extension.ts` (watcher wiring), `src/ui/WebviewSettingsSync.ts` (push
  reloaded settings to the dashboard).
- **Approach:** add a cache invalidation API on the backend (`invalidate()`
  per path) and a change event on the config service. In the extension, watch
  both `<stateRoot>/.ctrlyoke/settings.json` and `~/.ctrlyoke/settings.json`
  through the existing `FileWatcherFactory` (`src/core/HostPorts.ts`); on
  change, invalidate, re-merge, and push to the dashboard the same way a
  drawer write does. As a cheap safety net, have `getAll()` compare the file's
  mtime (and size) with the cached load and reload when it changed; that also
  covers the CLI and MCP hosts without editing `cli.ts` / `mcp-server.ts`.
- **Tests:** `src/test/unit/CtrlYokeConfigService.test.ts`: write the file on
  disk, `getAll()` returns the new value; invalid JSON on disk keeps the last
  good value and surfaces the error as today. `src/test/unit/WebviewSettingsSync.test.ts`:
  a change event posts a settings reload.
- **Tricky:** the backend's own `set()` triggers the watcher too, so make the
  reload idempotent (no feedback loop, no duplicate toast). Debounce bursts
  from editors that write via rename. Settings that only apply at startup
  (server bind address, port) stay startup-only: say so in
  `docs/guide/settings.md` and in the schema `description` if the reference
  page is generated (then `npm run schema:update`). Read `config.instructions.md`.

### Step 6: Antigravity: never replace an unreadable hooks.json

- **Fixes:** `dev/bugs/backlog/antigravity-invalid-global-hooks-json-silently-replaced.md`
- **Files:** `src/core/harness/antigravity/AntigravityCliProvider.ts`
  (`readHooksFile`, `writeGlobalHooksConfig`, `writeHooksFile`,
  `cleanupWorkspaceArtifacts`).
- **Approach:** `readHooksFile` returns `{}` only on `ENOENT`; any other read
  error, parse error or non-object value throws `Cannot safely update
  ${hooksPath}: ...` (same wording as `SettingsJsonMcpTracker.readProjectConfig`).
  The cleanup path catches and logs so teardown is never blocked. Write via
  temp file and rename; use the existing atomic write helper from
  `src/utils/AtomicFileUtils.ts` by import only.
- **Tests:** `src/test/unit/AntigravityCliProvider.test.ts`: seed invalid
  JSON, assert the file is byte-for-byte untouched and the start fails with
  the error; cleanup with invalid JSON logs and resolves.
- **Tricky:** do not move `SettingsJsonMcpTracker`'s reader into a shared
  helper in this plan (plan 2 owns that file). A shared helper can be a
  follow-up.

### Step 7: Antigravity: reclaim orphaned global hook groups

- **Fixes:** `dev/bugs/backlog/antigravity-global-hooks-left-behind-after-abnormal-exit.md` [M]
- **Files:** `src/core/harness/antigravity/AntigravityCliProvider.ts`,
  `src/core/harness/antigravity/AntigravityNotificationMonitor.ts`
  (`buildHookConfig` uses its workspace root), `src/scripts/ctrlyoke-antigravity-hook.js`,
  `src/extension.ts` (activation sweep).
- **Approach:** record owner metadata (PID, owner token, `workspaceRoot`,
  written-at) per `ctrlyoke-*` group in a ctrlyoke-owned sidecar next to
  `hooks.json` (e.g. `~/.gemini/config/ctrlyoke-hooks-owners.json`). Under the
  same `withFileLock` in `writeGlobalHooksConfig`, drop every `ctrlyoke-*`
  group whose owner PID is dead or that has no sidecar entry. Reuse
  `isProcessAlive` / `isOwnerStale` from `src/utils/LockSafetyPrimitives.ts`
  rather than inventing new liveness rules. Run the same sweep once on
  extension activation (best effort, logged, never throws). Defense in depth:
  pass the registered workspace root to the hook script as an extra argv and
  have it print `{}` and exit when the payload's `workspacePaths` do not
  include it.
- **Tests:** `src/test/unit/AntigravityCliProvider.test.ts`: a group with a
  dead-PID owner and a group with no sidecar entry are removed on the next
  write, a live owner's group and user groups are kept.
  `src/test/unit/AntigravityNotificationMonitor.test.ts`: generated command
  includes the workspace root argv. A small test for the hook script's
  mismatch exit if the script has existing coverage.
- **Tricky:** the CLI has no activation hook in this plan's files; the
  write-path sweep covers it, so do not edit `src/cli.ts`. Depends on step 6's
  safe reader: a sweep must never rewrite a file it could not parse. Read
  `harness-cli-providers.instructions.md` and `scripts.instructions.md`.

### Step 8: Core settle and idle-state guards

- **Fixes:** `dev/bugs/backlog/cancelling-instances-disposed-as-idle-mid-cancel.md`,
  `dev/bugs/backlog/cli-log-monitor-handlers-armed-during-post-completion-drain.md`
- **Files:** `src/core/orchestration/WorkflowInstanceRegistry.ts`,
  `src/core/harness/CliLogMonitor.ts`.
- **Approach (registry):** replace the three hand-written state lists
  (`createWorkflow` duplicate and idle checks, `unregisterClient` idle check)
  with `isExecutionOwnerState`.
- **Approach (monitor):** once `completed = true`, clear `timeoutHandle` and
  `cancellationInterval` before `await drainLogEvents()`, and add a single
  settle-once guard that `resolveFailure`, the timeout callback, the
  cancellation branch and the PTY-exit branch all check.
- **Tests:** `src/test/unit/WorkflowInstanceRegistry.test.ts`: a CANCELLING
  instance survives `unregisterClient` and `createWorkflow`.
  `src/test/unit/CliLogMonitor.test.ts`: timeout, cancellation and PTY exit
  during the drain each still return `success: true` (use fake timers).
- **Tricky:** read `harness-integrations.instructions.md` and
  `orchestration.instructions.md`. Do not shorten the drain in this step
  unless a test pins it; it is optional in the bug doc.

### Step 9: History search refused snapshot leaves stale cursor

- **Fixes:** `dev/bugs/backlog/history-search-refused-snapshot-leaves-stale-cursor-skipping-matches.md`
- **Files:** `src/core/orchestration/HistorySearchIndexService.ts`.
- **Approach:** make the shared `seenDedupeKeys` and the retained cursor
  change together. Have `storeSnapshot` report whether it stored the results;
  on refusal in `extendSnapshotAndRespond`, either roll back the keys this
  scan added (have `scanForMatches` return them) or drop the stale snapshot's
  cursor so the next request rescans. Fix or remove the misplaced
  `admissionsCommitted` so one place decides commit vs rollback.
- **Tests:** `src/test/unit/HistorySearchIndexService.test.ts`: inject a small
  `MAX_SNAPSHOT_RESULTS`, complete an extension that is refused, extend again
  from the old snapshot, `totalCount` unchanged and the final group's rows
  present.
- **Tricky:** the cancelled-scan rollback fix described in
  `orchestration.instructions.md` must keep working; run its existing tests.

### Step 10: Prompt undo exclusion with absolute event paths

- **Fixes:** `dev/bugs/backlog/prompt-undo-absolute-paths-not-excluded-after-undo.md`
- **Files:** `src/ui/webview-react/utils/promptUndo.ts`,
  `src/ui/webview-react/hooks/useOutputUndoActions.ts`.
- **Approach:** add one `excludeUndoneCandidates(candidates, redoInstructions,
  workspaceRoot)` helper in `promptUndo.ts` that normalizes both sides to
  workspace-relative keys (prefer `candidate.instruction?.path` when present),
  and use it at all three call sites (`buildUndoDialogInputForPrompt`,
  `computePromptChangeSummary`, workflow change data in the hook).
- **Tests:** `src/ui/webview-react/test/utils/promptUndo.test.ts`: absolute
  Windows event path + `workingDirectory` + relative snapshot/redo path for
  both functions; header count and dialog list exclude the undone file.

### Step 11: Snapshot-content request watchdog

- **Fixes:** `dev/bugs/backlog/snapshot-content-request-never-times-out-and-is-cached.md`
- **Files:** `src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts`,
  `src/ui/webview-react/hooks/useOutputUndoActions.ts`,
  `src/ui/webview-react/components/output/OutputRow.tsx`,
  `src/ui/WebviewMessageRouter.ts`.
- **Approach:** follow the request/response pattern in
  `webview-react-hooks.instructions.md` (model: `useRunViewLoadWatchdog`):
  reissue with the same `requestId` on an interval, cap attempts, and on every
  terminal path remove the listener and delete the `pending` entry, then
  reject. Callers show a toast instead of hanging. The router's
  validation-failure branch replies with no content when a string `requestId`
  is present.
- **Tests:** `src/ui/webview-react/test/hooks/useWorkspaceSnapshotContent.test.ts`
  (dropped request is reissued then rejected; a later call sends a fresh
  request), `src/ui/webview-react/test/hooks/useOutputUndoActions.test.ts`
  (failure toast), `src/test/unit/WebviewMessageRouter.test.ts` (malformed
  request still gets a reply).
- **Tricky:** a reply payload type change would touch
  `src/types/WebviewMessageTypes.ts` (plan 3). Avoid it: an absent-content
  reply should fit the existing type; if not, make the minimal edit and call
  it out in the commit.

### Step 12: Script-step execution preview matches the save path

- **Fixes:** `dev/bugs/backlog/script-step-execution-preview-ignores-unsaved-and-mode.md`
- **Files:** new `src/ui/webview-react/utils/scriptStepProperties.ts`,
  `src/ui/webview-react/components/editor/PromptEditor.tsx`,
  `src/ui/webview-react/utils/executionPreview.ts`.
- **Approach:** move PromptEditor's script `scriptProperties` /
  `clearProperties` logic into one shared helper that returns the properties
  to set and the keys to clear (including `executionMode` from
  `editor.scriptExecutionMode`, `shell`, `env`, `color`, `secrets`). Use it in
  both the save path and `getExecutionPreviewEditorSnapshot`.
- **Tests:** `src/ui/webview-react/test/utils/executionPreview.test.ts`: saved
  step with `executionMode`, `shell`, non-default `onPass`; unedited snapshot
  keeps them; edited back to defaults clears them; unsaved shell/env apply.
  Keep existing PromptEditor save tests passing (they pin the refactor).
- **Tricky:** `executionPreviewStore.ts` is plan 3's; do not edit it.

### Step 13: Language server command argv round-trip

- **Fixes:** `dev/bugs/backlog/language-server-edit-splits-command-path-with-spaces.md`
- **Files:** `src/ui/webview-react/components/settings/LanguageServersSection.tsx`.
- **Approach:** quote-aware `formatArgv` / `parseArgv` helpers (local to the
  component or a small webview util), used for the form value, the save
  parse, and the row display. When the command field was not modified, keep
  the original array verbatim.
- **Tests:** `src/ui/webview-react/test/components/settings/LanguageServersSection.test.tsx`:
  edit only extensions on a definition with `C:\Program Files\...`; saved
  command unchanged. Round-trip a quoted argument typed by the user.

### Step 14: Near-limit warning reset time in local time

**Already done** in `1d7841123` before this drain ran; not queued.

- **Fixes:** `dev/bugs/backlog/near-limit-warning-shows-raw-iso-reset-time.md`
- **Files:** new `src/utils/FutureTimeFormat.ts`,
  `src/ui/webview-react/utils/time.ts`,
  `src/core/harness/shared/usage/UsageSelectionAssist.ts`.
- **Approach:** move the pure formatting core of `formatFutureTime` (local
  time, short weekday for resets more than a day away) into
  `src/utils/FutureTimeFormat.ts` with no DOM or VS Code imports, re-export or
  wrap it from `time.ts` so webview callers are unchanged, and use it in
  `formatResetTime`.
- **Tests:** `src/test/unit/UsageSelectionAssist.test.ts` (update the pinned
  message; make it timezone-independent by injecting or computing the
  expected string with the same helper), `src/ui/webview-react/test/utils/time.test.ts`.
- **Tricky:** confirm the webview bundle can import from `src/utils/`
  (check other webview imports of `src/utils`/`src/types`); if not, keep the
  helper under `src/types/` or similar shared location instead. Update any
  example text in `docs/guide/usage-and-stats.md` that shows the ISO form.
  Capturing the D19 screenshot needs a live run; leave it, and mention it in
  the commit body.

### Step 15: Dashboard keyboard handling

- **Fixes:** `dev/bugs/backlog/ctrl-shift-z-redo-ignored-for-uppercase-key.md`,
  `dev/bugs/backlog/escape-in-settings-modal-closes-settings-drawer.md`
- **Files:** `src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts`,
  `src/ui/webview-react/components/shared/Modal.tsx`.
- **Approach:** lowercase `e.key` once in the undo/redo handler. Register
  Modal's Escape listener in the capture phase, skip if `e.defaultPrevented`,
  otherwise `preventDefault()` then `onClose`, so the drawer's existing guard
  ignores it and nested modals close one at a time.
- **Tests:** `src/ui/webview-react/test/hooks/useUndoRedoKeyHandler.test.ts`
  (`Z`+Ctrl+Shift redoes; `Z`+Ctrl undoes), `src/ui/webview-react/test/components/shared/Modal.test.tsx`,
  `src/ui/webview-react/test/components/layout/GlobalSettingsDrawer.test.tsx`
  (Escape in Set secret closes only the dialog).
- **Tricky:** capture-phase Escape must not break CodeMirror or inputs inside
  a modal that handle Escape themselves (e.g. closing an autocomplete);
  check modals that embed editors.

### Step 16: Dashboard touch and file picker

- **Fixes:** `dev/bugs/backlog/use-long-press-leaks-timer-on-multi-touch.md`,
  `dev/bugs/backlog/workflow-file-picker-preselects-hidden-file.md`
- **Files:** `src/ui/webview-react/hooks/useLongPress.ts`,
  `src/ui/webview-react/components/workflow/WorkflowFilePickerModal.tsx`.
- **Approach:** `onTouchStart` calls `cancel()` first and returns when
  `e.touches.length > 1`; add an unmount cleanup effect. In the picker, derive
  the effective selection from `filteredFiles` and use it for both the row
  highlight and the submitted path; stop seeding from the unfiltered list.
- **Tests:** `src/ui/webview-react/test/hooks/useLongPress.test.ts` (two
  touchstarts + touchend, fake timers, callback never fires; unmount clears),
  `src/ui/webview-react/test/components/workflow/WorkflowFilePickerModal.test.tsx`
  (hidden git-ignored first file; query excludes first file).

### Step 17: Build scripts: Windows path quoting and strip backup

- **Fixes:** `dev/bugs/backlog/dev-host-unquoted-paths-break-on-spaces-windows.md`,
  `dev/bugs/backlog/strip-dev-commands-backup-overwritten-on-rerun.md`
- **Files:** new `scripts/spawn-windows-shim.mjs` (+ `scripts/spawn-windows-shim.test.mjs`),
  `scripts/dev-host.mjs`, `scripts/package-install.mjs`,
  `scripts/strip-dev-commands.mjs`, `package.json` (scripts block only).
- **Approach (quoting):** one helper that, on Windows, spawns
  `ComSpec /d /s /c "<quoted command line>"` with `windowsVerbatimArguments`
  (cross-spawn style quoting and caret escaping), and plain `shell: false`
  elsewhere. Use it for `code.cmd` in `dev-host.mjs` (including `compile()`)
  and for every command in `package-install.mjs`.
- **Approach (strip):** `stripDevCommands()` refuses to run when
  `package.json.backup` exists, with a message pointing at
  `npm run restore-package`. Preferably also wrap `vsce package` in a script
  that restores in `finally`, so a failed packaging never leaves
  `package.json` stripped.
- **Tests:** `scripts/spawn-windows-shim.test.mjs` (paths with spaces, `&`,
  `^`, quotes produce the right command line; wire it into whatever runner the
  other `scripts/*.test.mjs` use: the `test:packaging` list in `package.json`),
  and a new `scripts/strip-dev-commands.test.mjs` in the same list (existing
  backup is never overwritten). There is no `StripDevCommands.test.ts`.
- **Tricky:** do not change `contributes.configuration` in `package.json`
  here (Step 18 owns that edit). `npm test` cannot exercise a real
  `code` launch; test the command-line builder, not the spawn.

### Step 18: Out-of-workspace `ctrlyoke.workspaceDirectory` requires external-root approval

- **Fixes:** `dev/bugs/backlog/workspace-directory-setting-widens-trusted-roots-without-approval.md` [M, security]
- **Decision (Nathan, 2026-10-14):** keep the ability to point the state root
  outside the open folders, but such a root must pass the existing
  external-root approval before it widens file access. Do not ignore
  workspace-level values. Follow the bug doc's Suggested Fix.
- **Files:** `src/platform/WorkspaceRootResolver.ts`,
  `src/platform/VsCodeWorkspaceRoot.ts`, `src/extension.ts`, `package.json`
  (`capabilities.untrustedWorkspaces.restrictedConfigurations` only),
  `docs/guide/settings.md`. `src/utils/FileAccessPolicy.ts` and
  `src/config/ExternalRootsTrustStore.ts` are unowned and may be edited if
  the approval needs wiring there.
- **Approach:** keep the state-root locator unchanged and separate it from the
  containment roots. An outside root becomes a requested external root that
  goes through the same `ExternalRootsTrustStore` prompt and record as
  `permissions.trustedExternalRoots`. Until it is approved, LSP, hosted viewer,
  prompt links and context-menu containment use only the open folders.
- **Tests:** `src/test/unit/WorkspaceRootResolver.test.ts` and
  `FileAccessPolicy` tests. `../..` and absolute outside values still resolve
  the state root but do not grant `reason: "workspace"` access. After approval,
  access is granted through the external-roots path. A declined approval grants
  nothing.
- **Tricky:** run this step after Step 17, which deliberately leaves
  `package.json` `contributes.configuration` alone for this step.

## Rules every queued step follows

1. **Self-contained.** Each step runs in a fresh session with no memory of
   earlier steps. Read the bug doc(s) named in the step, the code it cites,
   and the routed `.github/instructions/*.instructions.md` file for each area
   touched (see the table in `CLAUDE.md`). Re-check the cited line numbers;
   earlier steps may have moved them.
2. **Verify before fixing.** If the code no longer shows the bug (already
   fixed elsewhere, or the root cause is wrong), do not invent a fix: `git mv`
   the doc to `dev/bugs/rejected/`, replace its `**Severity:**` line with a
   one-line `**Resolution:**` reason, and commit that alone.
3. **Fix and test.** Fix the root cause and add or update tests that fail
   without the fix. Core, orchestration, harness, server and config tests go
   in `src/test/**`; dashboard tests in `src/ui/webview-react/test/**`.
4. **Stay in this plan's files** (see File ownership). Any unavoidable edit to
   another plan's file is minimal and named in the commit message.
5. **`npm test` passes.** Run it once, piped to keep the end
   (`npm test 2>&1 | Select-Object -Last 40` in PowerShell), and read the
   `TEST SUMMARY:` block; do not rerun the suite to check. Also run
   `npm run typecheck` and `npm run lint`. Never run `npm run test:harness`.
6. **Move the bug doc.** `git mv` each fixed doc from `dev/bugs/backlog/` to
   `dev/bugs/implemented/` and replace its `**Severity:**` line with
   `**Resolution:** fixed in this commit`.
7. **Docs.** If the change alters anything a user sees or types, update the
   hand-written page under `docs/` in the same commit (generated reference
   pages only via `npm run schema:update`), and run `npm run check:docs`.
8. **Commit.** Commit the step's own work on the current branch with a plain
   conventional-commit message (`fix: ...`), no attribution or trailer lines.
   Do not create branches. Do not stash.
9. **Never leave a bug open.** If a fix hits a choice the bug doc doesn't
   settle, decide it yourself:
   - Fail closed on security.
   - Prefer the smallest change a user would notice.
   - Follow existing conventions.
   - If another plan's file must change, make the edit minimal and name it in
     the commit message.

   Before moving the doc, record the choice in a short `## Decision` paragraph
   in it. A bug leaves `dev/bugs/backlog/` only as fixed (`implemented/`) or as
   not real (`rejected/`). It is never skipped, deferred, or left for Nathan.

## Done criteria

- Every bug doc listed under Steps is in `dev/bugs/implemented/` or
  `dev/bugs/rejected/` (24 docs, including Step 18; steps 5 and 14's two
  were already in `implemented/` when the drain started).
- `npm test` passes on the final commit, and no file owned by plans 2-4 was
  edited except where a commit message calls it out.
