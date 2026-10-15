# Bug Drain 4: Core Utilities, CLI/MCP Surfaces and Workspace Viewer

**Status:** Implemented 2026-10-15. All 19 bug docs are in
`dev/bugs/implemented/` (step 7 was fixed before the drain, in `e45a21ab8`).
The review pass fixed four problems in the queued steps' work:
- **Excerpt reads (step 8):** every non-first-line `#selection` was broken, and over-cap line ranges were refused outright. Excerpts now use `splitLines`/`streamFileLines`.
- **Codex custom mode (step 4):** `permissions.codexSandboxMode` had been made dead for every workflow. Codex now clamps to read-only only when a whole write-capable tool is denied.
- **OSC recovery (step 10):** it could emit text twice.
- **Coordination board (step 2):** recovering from a corrupt board reset its sequence numbers and dropped live claims. It now salvages every entry that parses.
**Runs as:** plan 4 of 4 in a parallel bug drain. Each plan runs through
`out/templates/workflows/spec-driven-loop.ctrlyoke.yaml` in its own git
worktree. The orchestrator reads this plan, queues one `append_step` per step
below, in the order given, and then reviews.
**Size:** 19 bug docs, 26 effort points (S = 1, M = 2), 14 steps.

## Goal and scope

This plan owns a set of self-contained subsystems that the other three plans do
not touch:

- the cross-process file lock (`FileLockUtils`) and the orchestration stores
  that depend on it (the history-search rebuild worker, the execution-root
  coordination board, external-run watch discovery);
- the `ctrlyoke commit` CLI path and commit-message generation;
- the standalone host's file watcher and script-command completions;
- the MCP server's step reporting and its dashboard tool views;
- prompt-reference expansion and attachment token counting;
- two standalone utilities (the streaming terminal sanitizer and the Windows
  CLI launcher resolver);
- a group of dashboard React fixes: shared form editors, the Duplicate Workflow
  dialog, and the hosted workspace viewer's Explorer and Source Control panes.

The common thread is races and missing guards: stale-response handling, lock
ownership, non-atomic writes, unbounded buffering and over-broad permissions.

## File ownership

Plans 1, 2 and 3 run **in parallel** with this one, in other worktrees, and
own other files. A step in this plan must not edit a file owned by another plan.
If a fix truly needs one, keep that edit to the minimum, and name the file and
the reason in the commit message so the merge is expected. Files that no plan
lists (for example `src/types/DashboardConstants.ts`, `src/utils/AtomicFileUtils.ts`
imports, or `WorkspaceFileEditor.tsx`) may be edited when a step needs them;
keep those edits small and additive, because another plan may touch the same
shared file.

This plan may edit:

```
src/cli.ts
src/cli/commitcommand.ts
src/completions/scriptcommandcompletionhelpers.ts
src/core/harness/shared/clilauncherresolver.ts
src/core/orchestration/executionrootcoordinationstore.ts
src/core/orchestration/externalrunwatchcoordinator.ts
src/core/orchestration/historysearchrebuildworker.ts
src/git/commitmessagegenerator.ts
src/mcp-server.ts
src/platform/nodefilewatcher.ts
src/ui/prompteditorsupportservice.ts
src/ui/webview-react/components/output/ctrlyoke-tools/heightestimators.ts
src/ui/webview-react/components/output/ctrlyoke-tools/readoutputview.tsx
src/ui/webview-react/components/output/ctrlyoke-tools/workflowstatusview.tsx
src/ui/webview-react/components/shared/keyvaluerowseditor.tsx
src/ui/webview-react/components/shared/mcpserverform.tsx
src/ui/webview-react/components/workflow/duplicateworkflowdialog.tsx
src/ui/webview-react/components/workspace-viewer/workspaceexplorerpane.tsx
src/ui/webview-react/components/workspace-viewer/workspacesourcecontrolpane.tsx
src/ui/webview-react/hooks/useattachmenttokencount.ts
src/ui/webview-react/store/workspaceviewerstore.ts
src/utils/contextexpander.ts
src/utils/ctrlyoketoolviews/readoutputmodel.ts
src/utils/ctrlyoketoolviews/workflowstatusmodel.ts
src/utils/filelockutils.ts
src/utils/filetokenestimator.ts
src/utils/mcptooldefinitions.ts
src/utils/terminaloutputsanitizer.ts
```

(Paths are lowercased here; the real files use the repo's casing, e.g.
`src/utils/FileLockUtils.ts`.) Plus each step's tests under `src/test/**` and
`src/ui/webview-react/test/**`, and `docs/reference/mcp-tools.md` (hand-written,
step 7).

Files this plan must **not** edit, because another plan owns them and is
changing them at the same time. The ones most likely to tempt a step here are:

- `src/server/CtrlYokeHostedServer.ts`, `src/extension.ts`,
  `src/ui/WebviewMessageRouter.ts` (plan 1)
- `src/core/harness/shared/ExecutionPlanBuilder.ts`, every
  `*CliProvider.ts`, `CopilotToolPermissionMapper.ts`,
  `src/platform/NodeHostServices.ts`, `src/utils/WorkflowLockManager.ts`,
  `src/utils/WorkflowPaths.ts` (plan 2)
- `src/core/orchestration/ExecutionRootLeaseManager.ts`,
  `src/utils/AtomicFileUtils.ts`, `src/ui/webview-react/utils/hostedApi.ts`,
  `src/ui/webview-react/store/uiStore.ts`,
  `src/ui/webview-react/hooks/useMessageHandler.ts`,
  `src/types/WebviewMessageTypes.ts` (plan 3)

Importing from those files is fine; changing them is not.

## Ordered steps

Steps run one after another in this worktree. The order keeps every pair of
steps that share a file adjacent and sequential: the two `FileLockUtils` bugs
are one step, and the coordination store (which uses the lock) comes after it;
both commit steps; both script-completion steps; both `PromptEditorSupportService`
steps; and the three `workspaceViewerStore` bugs in steps 13 and 14.

### Step 1: File lock liveness and ownership (M + M)

- **Fixes:** `dev/bugs/backlog/file-lock-goes-stale-while-holder-still-working.md`,
  `dev/bugs/backlog/file-lock-stale-break-race-deletes-fresh-lock.md`
- **Files:** `src/utils/FileLockUtils.ts`,
  `src/core/orchestration/historySearchRebuildWorker.ts`
- **Approach:** one owner-token design fixes both bugs.
  1. Write a unique token (pid plus `randomUUID()`) as the lock payload.
  2. `releaseLock` removes the lock only if its payload still holds our token.
     Tolerate `ENOENT`, and `Log.warn` when the token is someone else's (the
     lock was stolen).
  3. Heartbeat: while the `withFileLock` action runs, `fs.utimes` the lock
     every `LOCK_STALE_MS / 3`, and clear the interval in `finally`. Use
     `.unref()` so the timer never keeps a process alive.
  4. Stale break: remember the token (and `ino`/`mtimeMs`) read at judgement
     time, rename to a unique tombstone, then read the tombstone. If it is not
     the file that was judged stale, another waiter took a fresh lock in
     between: restore it if the path is still free (`link` or `open('wx')` and
     rewrite), otherwise treat the lock as held and keep polling.
  5. Optionally treat a lock whose payload PID is alive (`process.kill(pid, 0)`
     succeeds, same host) as not stale. Old-format payloads (`pid timestamp`)
     must still parse, so a lock left by an older build is reclaimable.
  6. Defense in depth in `historySearchRebuildWorker.ts`: `cleanupRebuildDirs`
     skips `rebuild-*` directories younger than a threshold (a named constant).
- **Tests:** `src/test/unit/FileLockUtils.test.ts`. Use a reduced stale window
  or fake timers. (a) A holder whose action runs longer than `LOCK_STALE_MS`
  keeps a waiter out until it releases. (b) Using the injectable `open`/`rename`
  ops, pause waiter B between stat and rename while A breaks the stale lock;
  assert the two actions never overlap. (c) A holder whose lock was stolen does
  not delete the new owner's lock on release. Add a rebuild-worker test for the
  young-directory skip if the worker has a seam for it.
- **Tricky:** `withFileLock` has more than 20 callers (usage stores, lineage
  repository, `WorkflowPaths`, the lease manager and more), several in files
  other plans own. Keep the public signature unchanged so no caller needs an
  edit. Read the whole `npm test` summary: a regression here shows up far from
  this file. Check `src/test/**` for tests that assert the old payload format.

### Step 2: Coordination board atomic rewrite and duplicate external-run sessions (S + S)

- **Fixes:** `dev/bugs/backlog/coordination-board-non-atomic-rewrite-wedges-board.md`,
  `dev/bugs/backlog/external-run-watch-concurrent-discovery-leaks-duplicate-session.md`
- **Files:** `src/core/orchestration/ExecutionRootCoordinationStore.ts`,
  `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Approach (board):** replace the in-place `fs.writeFile` of `board.jsonl`
  with `writeFileAtomic` (import it; do not edit `AtomicFileUtils.ts`, which
  plan 3 owns). Make `readEntries` skip an unparseable **trailing** line with a
  `Log.warn`. A corrupt line in the middle should move the board aside to
  `board.jsonl.corrupt-<ts>` and start fresh instead of throwing on every call.
- **Approach (watch):** add `pendingStarts: Map<string, Promise<boolean>>` and
  send every start path through one wrapper that returns the in-flight promise
  or `true` when a session is already registered, and clears the entry in
  `finally`. Re-check `externalRunSessions.has(workflowId)` right before the
  `set`, and `dispose()` the session in the superseded branch.
- **Tests:** `src/test/unit/ExecutionRootCoordinationStore.test.ts` seeds a
  truncated final line and asserts `read()` and `append()` both recover.
  `src/test/unit/ExternalRunWatchCoordinator.test.ts` fires
  `handleRunnerJsonEvent` twice concurrently and asserts one session starts and
  every watcher and interval is disposed with the coordinator.
- **Tricky:** the board store runs inside `withFileLock`, so it depends on
  step 1 having landed. That is why it comes second.

### Step 3: `ctrlyoke commit` never initializes the run-history location (S)

- **Fixes:** `dev/bugs/backlog/cli-commit-run-history-location-not-initialized.md`
- **Files:** `src/cli.ts`, `src/cli/CommitCommand.ts`
- **Approach:** prefer the "better fix": route `commitCommand` through the shared
  CLI bootstrap (`bootstrapCliWorkspace`), or pull config bootstrap plus
  `initializeRunHistoryLocation(...)` into one helper that `run` and `commit`
  both call, so no subcommand can skip the freeze again. Fall back to the
  minimal fix (call `initializeRunHistoryLocation(configService.get("storage").runHistoryLocation)`
  right after the workspace backend is set, guarded by
  `isRunHistoryLocationInitialized()`) only if the bootstrap does work `commit`
  must not do.
- **Tests:** `src/test/unit/CliCommitCommand.test.ts`. Call
  `resetRunHistoryLocationForTests()` first so the suite-wide freeze in
  `src/test/suite/index.ts` cannot hide the bug, run the commit bootstrap path,
  and assert the location is initialized. Restore the global freeze afterwards
  so later tests are unaffected.

### Step 4: Commit-message generation runs with allow-all permissions (M)

- **Fixes:** `dev/bugs/backlog/commit-message-generation-runs-with-allow-all-permissions.md`
- **Files:** `src/git/CommitMessageGenerator.ts`
- **Decision (Nathan, 2026-10-14):** least privilege on every harness. Edit the
  mappers where needed. Never fall back to allow-all.
- **Approach:** in `buildCommitWorkflowOverrides`, replace
  `PERMISSION_MODES.ALLOW_ALL` with `PERMISSION_MODES.CUSTOM`:
  - allow read-only tools (read/grep/glob or each harness's equivalent) so the
    model can read files for context;
  - native MCP mode: also allow the `submit_commit_message` MCP tool;
  - skill mode: also allow only the ctrlyoke CLI commit-message command
    pattern;
  - shell and write/edit tools are explicitly denied.

  Then check each harness's permission mapper. Confirm that this custom mode
  gives deny-by-default in a headless run on all six harnesses.
- **Tests:** `src/test/unit/CommitMessageGenerator.test.ts`. Replace the test
  that pins `ALLOW_ALL` with one that pins the restricted permissions for each
  MCP mode.
- **Tricky:** if a harness's mapper cannot express that allowlist, extend that
  mapper minimally so it can. The mappers live under `src/core/harness/<harness>/`
  and several are owned by plan 2. Add a mapper unit test, and name each
  cross-plan file in the commit message. Do not settle for a broader mode on
  any harness.

### Step 5: Script completion erases `npm run` without a trailing space (S)

- **Fixes:** `dev/bugs/backlog/script-completion-npm-run-without-trailing-space-erases-prefix.md`
- **Files:** `src/completions/ScriptCommandCompletionHelpers.ts`
- **Approach:** detect the run prefix in one place. Have
  `parseScriptCompletionContext` return the run match (manager and script
  prefix), and have `getScriptCommandCompletions` use it instead of parsing
  `beforeCursor` again. Require `run\b` plus whitespace before entering
  script-name mode, so `npm run` falls through to full mode and `npm runx` is
  not treated as `run`.
- **Tests:** `src/test/unit/ScriptCommandCompletionHelpers.test.ts`. Cover
  `npm run`, `pnpm run` and `yarn run` with no trailing space, and assert
  `text.slice(0, from) + insertText` is a valid full command.

### Step 6: NodeFileWatcher watches the whole subtree (M)

- **Fixes:** `dev/bugs/backlog/node-file-watcher-watches-whole-subtree-for-single-file.md`
- **Files:** `src/platform/NodeFileWatcher.ts`,
  `src/completions/ScriptCommandCompletionHelpers.ts`, plus one new shared
  constant for the always-excluded heavy directories (`node_modules`, `.git`
  and others mirroring VS Code's default `files.watcherExclude`). Put it in
  `src/types/DashboardConstants.ts` unless an existing constant already lists
  them; search first.
- **Approach:** derive the watch scope from the glob inside
  `NodeFileWatcher`, so the callers in files owned by other plans
  (`CtrlYokeHostedServer.ts`, `NodeHostServices.ts`) need no edit. A literal
  basename watches that one file. A one-level glob uses `depth: 0`. In every
  case pass an `ignored` predicate that prunes the excluded directories and any
  directory that cannot match, and set `followSymlinks: false`. In
  `ensurePackageJsonWatchers`, exclude `node_modules` from the
  `**/package.json` watch (or watch only the discovered files) and keep the
  handle so it can be disposed.
- **Tests:** add a contract case to `src/test/helpers/fileWatcherContract.ts`
  (a basename watch does not report changes in subdirectories). It runs against
  both `src/test/unit/NodeFileWatcher.test.ts` and
  `src/test/suite/VsCodeFileWatcher.test.ts`, so the VS Code implementation
  must pass it too. Add a Node-only test that `node_modules` is not watched.
- **Tricky:** `PromptFileWatcher` also passes `dirname(file)` plus a basename;
  it needs no change once `NodeFileWatcher` scopes itself. Watcher tests are
  timing-sensitive; use the contract helper's existing wait utilities, not
  fixed sleeps.

### Step 7: MCP reports script steps as `(script) <cmd>` prompts (M)

> **Already fixed before this drain started** in commit `e45a21ab8`
> ("fix: distinguish script steps in MCP output"); the doc is in
> `dev/bugs/implemented/`. The orchestrator did not queue this step. The final
> review checks that `ReadOutputView.tsx`/`heightEstimators.ts` render
> script rows consistently.

- **Fixes:** `dev/bugs/backlog/mcp-script-step-prompt-format-invites-fake-script-appends.md`
- **Files:** `src/mcp-server.ts`, `src/utils/McpToolDefinitions.ts`,
  `src/utils/ctrlyokeToolViews/workflowStatusModel.ts`,
  `src/utils/ctrlyokeToolViews/readOutputModel.ts`,
  `src/ui/webview-react/components/output/ctrlyoke-tools/WorkflowStatusView.tsx`,
  `src/ui/webview-react/components/output/ctrlyoke-tools/ReadOutputView.tsx`,
  `src/ui/webview-react/components/output/ctrlyoke-tools/heightEstimators.ts`,
  `docs/reference/mcp-tools.md`
- **Approach:** in `workflow_status` and `read_output`, report script steps with
  explicit fields (`type: "script"`, `script: "<cmd>"`) instead of putting
  `(script) …` in `prompt`. Single-source the step-type string as a constant.
  In `append_step` and `edit_step`, reject a prompt that starts with
  `(script) ` with an error saying script steps cannot be appended, and say the
  same in the `append_step` tool description. Update the tool-view models and
  views to read the new shape. Show "Script" (or no harness) for script steps
  instead of a harness name, and keep the height estimators in line with the
  rendered rows.
- **Tests:** `src/test/unit/McpServer.test.ts` (new output shape; rejection of a
  `(script) ` prompt) and
  `src/ui/webview-react/test/components/output/ctrlyokeStatusToolViews.test.tsx`
  (script rows render as Script). The views must still render older results
  saved in `events.jsonl` with the `(script)` prefix; cover that too.
- **Docs:** update the `steps[]` bullet in `docs/reference/mcp-tools.md`
  (hand-written, not generated) and run `npm run check:docs`.

### Step 8: `#selection` / `#sym` excerpts read the whole file uncapped (M)

- **Fixes:** `dev/bugs/backlog/selection-symbol-excerpts-read-whole-file-uncapped.md`
- **Files:** `src/utils/ContextExpander.ts`, `src/utils/FileTokenEstimator.ts`,
  `src/ui/PromptEditorSupportService.ts`
- **Approach:** in `buildAttachmentXml`, `fs.stat` first. For a line-range
  excerpt, stream with `readline` over `fs.createReadStream`, stop at `endLine`,
  and abort with a clear skip reason past a byte cap. A symbol excerpt needs the
  file to find the symbol, so refuse it above the cap with the same clear
  reason. Single-source the cap (reuse `MAX_CONTENT_SIZE` or add an excerpt cap
  next to it). In the live counter, give excerpt refs an estimate path that
  never loads an over-cap file (a size-based approximation, as
  `estimateFileTokens` already does for full-file refs).
- **Tests:** `src/test/contextExpander.test.ts` pins the cap for `#selection`
  and `#sym` in `expandContextSplit`; `src/test/unit/PromptEditorSupportService.test.ts`
  pins the counter path. Stub `fs.stat` to report a huge size instead of
  writing a large fixture.

### Step 9: Attachment token-count refs stuck pending after a lost request (S)

- **Re-verify first (quick):** confirm `pendingRequests` in
  `useAttachmentTokenCount.ts` is still a bare `Set` cleared only by the
  response listener, and that the no-workspace branch in
  `handleAttachmentTokenCountRequest` still replies with `counts: {}`. If both
  are already fixed, `git mv` the doc to `dev/bugs/rejected/` with a one-line
  **Resolution:** and stop.
- **Fixes:** `dev/bugs/backlog/attachment-token-count-refs-stuck-pending-after-lost-request.md`
- **Files:** `src/ui/webview-react/hooks/useAttachmentTokenCount.ts`,
  `src/ui/PromptEditorSupportService.ts`
- **Approach:** make `pendingRequests` a `Map<string, { sentAt, attempts }>`.
  Treat a ref older than a few seconds as not pending, so it is requested again;
  after a capped number of attempts, retire it by caching 0. This is the
  reissue-and-retire rule in `webview-react-hooks.instructions.md`, with
  `useRunViewLoadWatchdog` as the worked example. On the backend, reply 0 for
  every requested ref in the no-workspace branch, and wrap the setup before the
  per-ref loop in `try/catch` so a response is always sent.
- **Tests:** `src/ui/webview-react/test/hooks/useAttachmentTokenCount.test.ts`
  (send, never answer, advance fake timers, assert a reissue, then assert
  retirement after the cap); `src/test/unit/PromptEditorSupportService.test.ts`
  (no-workspace reply covers every ref; a throwing setup still replies).

### Step 10: Streaming sanitizer stalls on an unterminated OSC (S)

- **Fixes:** `dev/bugs/backlog/streaming-sanitizer-stalls-on-unterminated-osc.md`
- **Files:** `src/utils/TerminalOutputSanitizer.ts`
- **Approach:** add `MAX_PENDING_ESCAPE_LENGTH` (a few KB, enough for real OSC 8
  links and titles). Past it, drop the unterminated OSC introducer and release
  the rest through `sanitizeTerminalOutput`. Accept C1 ST (`0x9C`) as an OSC
  terminator, end an OSC at a newline, and apply the same rule in
  `ANSI_ESCAPE_SEQUENCE_PATTERN` so the non-greedy branch cannot span lines.
- **Tests:** `src/test/unit/TerminalOutputSanitizer.test.ts`. Cover the bug's
  unit repro (`push('a\x1B]0;t')` then `push('line1\n')` must release
  `line1`), many chunks after an unterminated OSC, a `0x9C`-terminated OSC, and
  that a valid OSC 8 hyperlink split across chunks still strips cleanly.

### Step 11: Windows launcher lookup failure cached for the process lifetime (S)

- **Re-verify first (quick):** confirm `getCliLauncher` still caches the
  fallback `direct` launcher with no `resolvedPath` unconditionally. If not,
  `git mv` the doc to `dev/bugs/rejected/` with a one-line **Resolution:**.
- **Fixes:** `dev/bugs/backlog/windows-launcher-lookup-failure-cached-for-process-lifetime.md`
- **Files:** `src/core/harness/shared/CliLauncherResolver.ts`
- **Approach:** keep the in-flight promise so concurrent callers share one
  probe. After it settles, delete the cache entry when the result is a fallback
  `direct` launcher with no `resolvedPath`, or when it rejected, but only if the
  entry is still the same promise (as `RetryableAsyncCache` does). Optionally
  export `invalidateCliLauncher(commandName)`. Do not wire it into callers in
  plan-2 files.
- **Tests:** `src/test/unit/CliLauncherResolver.test.ts`. Stub the metadata
  probe to fail once and then succeed, and assert the second `resolveCliCommand`
  returns the resolved launcher. Assert that a successful resolution is still
  cached (the probe runs once).

### Step 12: Shared form editors and the Duplicate dialog (S + S + S)

- **Fixes:** `dev/bugs/backlog/key-value-bulk-edit-changes-discarded-unless-exited.md`,
  `dev/bugs/backlog/mcp-server-form-edit-splits-whitespace-arguments.md`,
  `dev/bugs/backlog/duplicate-dialog-enter-skips-pending-guard.md`
- **Files:** `src/ui/webview-react/components/shared/KeyValueRowsEditor.tsx`,
  `src/ui/webview-react/components/shared/McpServerForm.tsx`,
  `src/ui/webview-react/components/workflow/DuplicateWorkflowDialog.tsx`
- **Approach:**
  - Bulk edit: commit on blur and on unmount (the minimum fix), through
    `commitRows` so `lastCommittedValueRef` is set. Blur fires on mousedown
    before the form's Save click, which covers saving while still in bulk mode.
  - MCP args: in `mcpServerFormStateToServer`, keep `originalServer.args` when
    `form.args` still equals the joined string `serverToMcpServerFormState`
    produced, and re-tokenize only when the user edited the field.
  - Duplicate dialog: put the in-flight guard inside `handleSubmit` (read
    `useUiStore.getState()` there), so Enter and the button are both covered.
    Do not edit `uiStore.ts` (plan 3).
- **Tests:** `KeyValueRowsEditor.test.tsx` (blur and unmount commit the parsed
  record); `McpServerForm.test.ts` (submit while in bulk mode saves the new env;
  args containing spaces and empty-string args round-trip through an unrelated
  edit); `DuplicateWorkflowDialog.test.tsx` (two Enters post exactly one
  `CREATE_WORKFLOW_VARIANT`). All under `src/ui/webview-react/test/components/`.
- **Tricky:** `McpServerForm.test.ts` covers two of these bugs, which is why
  they share a step.

### Step 13: Explorer save overwrites in-flight edits and other files (M)

- **Fixes:** `dev/bugs/backlog/explorer-save-overwrites-in-flight-edits-and-other-file.md`
- **Files:** `src/ui/webview-react/store/workspaceViewerStore.ts`,
  `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
  (and `WorkspaceFileEditor.tsx`, unowned, only if a change there is needed)
- **Approach:** change `markFileSaved` to `markFileSaved(path, savedContent)`:
  do nothing unless `selectedFilePath === path`; set
  `originalFileContent = savedContent`; recompute
  `fileDirty = fileContent !== savedContent`; leave `fileContent` alone; delete
  the draft only when it equals `savedContent`. In `handleSave`, capture the path
  and content up front, ignore Ctrl+S while `fileSaving`, and after the await
  update `modifiedAtRef` only if the same file is still selected. Otherwise keep
  the returned mtime in a per-path map that the next open of that path consumes.
- **Tests:** `src/ui/webview-react/test/store/workspaceViewerStore.test.ts`
  (path-aware `markFileSaved`); a new
  `src/ui/webview-react/test/components/workspace-viewer/WorkspaceExplorerPane.save.test.tsx`
  with a deferred save mock for (a) typing during an in-flight save and (b)
  switching files during an in-flight save; adjust `WorkspaceViewerModal.test.tsx`
  if it calls the old signature.

### Step 14: Workspace viewer diff responses are not request-sequenced (S + S)

- **Fixes:** `dev/bugs/backlog/open-to-worktree-diff-has-no-stale-response-guard.md`,
  `dev/bugs/backlog/scm-file-diff-loads-not-request-sequenced.md`
- **Files:** `src/ui/webview-react/store/workspaceViewerStore.ts`,
  `src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx`
- **Approach:** in the store, add a worktree-diff request counter. Increment it
  in `openToWorktreeDiff`, `selectDiff`, `clearDiff` and `openToGitRef`, and
  return early after the await and in `catch` when the sequence has moved on.
  Make `setDiffData` path-aware as a backstop, and have `selectDiff` clear the
  previous file's content. In the SCM pane, add a request-sequence ref to
  `selectFileDiff` following the explorer's `fileLoadRequestSeqRef` /
  `isCurrentRequest` pattern, and apply it in `catch` and `finally` too, so a
  superseded request neither writes content nor clears `diffLoading`.
- **Tests:** `workspaceViewerStore.test.ts` (two `openToWorktreeDiff` calls
  resolved out of order, the later one wins; `selectDiff` while one is pending
  is not overwritten). New
  `src/ui/webview-react/test/components/workspace-viewer/WorkspaceSourceControlPane.test.tsx`
  (two `workspaceDiff` promises resolved out of order; `diffLoading` stays true
  until the latest settles). Mock `hostedApi`; do not edit it (plan 3).
- **Tricky:** runs after step 13 because both change `workspaceViewerStore.ts`.

## Decisions

None. Nathan settled the open question on 2026-10-14: Step 4 uses least
privilege on every harness and edits mappers where needed. Any other judgment
call is settled by the step itself under rule 8. The orchestrator must not
skip or defer a bug.

## Rules every queued step follows

1. **Self-contained.** Each step runs in a fresh session with no memory of
   earlier steps. Read the bug doc(s) named in the step, the routed
   `.github/instructions/*.instructions.md` for the files touched, and the code,
   before editing.
2. **Fix and test.** Fix the root cause and add or update tests that would have
   caught the bug.
3. **`npm test` passes.** Run it once and read the `TEST SUMMARY:` block at the
   end (`npm test 2>&1 | tail -40` in a POSIX shell, or
   `npm test 2>&1 | Select-Object -Last 40` in PowerShell). Never run
   `npm run test:harness`. Also run `npm run lint` and `npm run typecheck`, plus
   `npm run check:docs` if a doc changed.
4. **Move the bug doc.** `git mv` each fixed doc from `dev/bugs/backlog/` to
   `dev/bugs/implemented/`, replacing its `**Severity:**` line with
   `**Resolution:** fixed in this commit`. A bug found not to be real goes to
   `dev/bugs/rejected/` with a one-line `**Resolution:**` reason.
5. **User-facing docs.** If behavior a user can see or type changes, update the
   hand-written `docs/` page in the same commit (step 7 does this for
   `docs/reference/mcp-tools.md`).
6. **Stay in your files.** Edit only files this plan owns (or unowned shared
   files, minimally). Name any unavoidable edit to another plan's file in the
   commit message.
7. **Commit your own work** on the current branch with a plain
   conventional-commit message (`fix: ...`) and no attribution or trailer
   lines. Do not create a branch.
8. **Never leave a bug open.** If a fix hits a choice the bug doc doesn't
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

Every bug doc listed in the steps above is in `dev/bugs/implemented/` or
`dev/bugs/rejected/`, with no exceptions. `npm test` passes on the final commit.
