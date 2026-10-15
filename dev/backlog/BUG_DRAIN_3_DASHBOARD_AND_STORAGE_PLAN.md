# Bug Drain 3: Dashboard State and Local Storage I/O

> **Status:** Proposed. Written 2026-10-14 against current `main`.
>
> **Plan 3 of 4.** The four bug-drain plans run **in parallel**, each through
> `out/templates/workflows/spec-driven-loop.ctrlyoke.yaml` in its own git worktree. The
> orchestrator reads this plan, queues one `append_step` per step in §3 (in order), then
> reviews the result.
>
> **Size:** 22 bug docs, 26 effort points, 18 steps.

---

## 1. Goal and scope

This plan drains the backlog bugs in two loosely coupled areas. The first is the **React
dashboard's client state and its message handling**: `useMessageHandler`, `uiStore`, the
execution-preview and MCP-manager stores, the template modal, the workflow header, the steps
panel context menus, `DiffView`, the hosted commit-history pane, and the small input and
link helpers. The second is **local persistence and I/O on the extension side**: the
lifetime usage store, the workspace git snapshot, the execution-root lease file, the
Windows credential store, the MCP/LSP config exporters and the MCP registry, the
end-condition regex guard, `ParallelGroupRun` worker dispatch, OpenCode permission
collision discovery, and the Antigravity log/tool parsers. Every fix is local to the files
listed in §2. None of them changes the workflow schema or the settings schema.

---

## 2. File ownership

Plans 1, 2 and 4 run **at the same time** as this plan, in other worktrees, and own other
files. A step in this plan **must not edit a file owned by another plan**. If a fix
genuinely cannot be made without touching one, keep that edit to the smallest possible
change and name the file and the reason in the commit message, so the merge is expected.
Files owned by no plan (for example `McpManagerSection.tsx`, `LocalInputs.tsx`,
`OpenCodeToolPermissionMapper.ts`, `EndConditionEvaluator.ts`) may be edited when a fix
needs them, but prefer keeping the change inside the owned files below.

Test files for the owned sources (under `src/test/**` and `src/ui/webview-react/test/**`)
belong to this plan as well.

**Owned by this plan:**

```
src/core/ParallelGroupRun.ts
src/core/harness/antigravity/AntigravityLogParser.ts
src/core/harness/antigravity/AntigravityToolEventBuilder.ts
src/core/harness/opencode/OpenCodeInlineConfig.ts
src/core/harness/shared/BaseLogParser.ts
src/core/harness/shared/usage/LifetimeUsageStore.ts
src/core/harness/shared/usage/WorkspaceStatsService.ts
src/core/orchestration/ExecutionRootLeaseManager.ts
src/core/orchestration/HistoryTrashRepository.ts
src/platform/OsCredentialStore.ts
src/types/WebviewMessageTypes.ts
src/ui/McpManagerService.ts
src/ui/WorkflowSerializer.ts
src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx
src/ui/webview-react/components/output/DiffView.tsx
src/ui/webview-react/components/prompts/FinalStepFooter.tsx
src/ui/webview-react/components/prompts/ParallelGroupPanel.tsx
src/ui/webview-react/components/prompts/PromptChipRail.tsx
src/ui/webview-react/components/prompts/WorkflowStep.tsx
src/ui/webview-react/components/prompts/WorkflowStepRow.tsx
src/ui/webview-react/components/workflow/TemplateModal.tsx
src/ui/webview-react/components/workflow/WorkflowStatus.tsx
src/ui/webview-react/components/workspace-viewer/WorkspaceCommitHistoryPane.tsx
src/ui/webview-react/hooks/useCommitHistoryContextMenu.tsx
src/ui/webview-react/hooks/useFinalStepContextMenu.tsx
src/ui/webview-react/hooks/useLatestStepOutput.ts
src/ui/webview-react/hooks/useLocalInput.ts
src/ui/webview-react/hooks/useMessageHandler.ts
src/ui/webview-react/hooks/useStepContextMenu.tsx
src/ui/webview-react/store/executionPreviewStore.ts
src/ui/webview-react/store/uiStore.ts
src/ui/webview-react/store/useMcpManagerStore.ts
src/ui/webview-react/utils/cliCommandFileLinks.ts
src/ui/webview-react/utils/hostedApi.ts
src/ui/webview-react/utils/stepContextMenuItems.ts
src/utils/AtomicFileUtils.ts
src/utils/HarnessLspExporter.ts
src/utils/HarnessMcpExporter.ts
src/utils/McpDiscoveryUtils.ts
src/utils/McpRegistryFileManager.ts
src/utils/ScriptComparison.ts
src/utils/ScriptComparisonAsync.ts
src/utils/ScriptRegexWorker.ts
src/utils/WorkspaceSnapshotService.ts
```

**Owned by other plans; do not edit.** The ones this plan's fixes are most likely to brush
against:

| File | Owner | Why a step might be tempted |
| --- | --- | --- |
| `package.json` | plan 1 | Adding a TOML library (step 8). Do not; see step 8. |
| `src/ui/WebviewMessageRouter.ts` | plan 1 | Message routing for MCP search / delete (steps 9, 12). Routing already forwards whole payloads, so no change is needed. |
| `src/ui/webview-react/components/output/OutputRow.tsx` | plan 1 | Passes `workingDirectory` to CLI links (step 15). No change needed. |
| `src/ui/webview-react/utils/executionPreview.ts` | plan 1 | Neighbour of `executionPreviewStore` (step 14). |
| `src/ui/webview-react/components/shared/McpServerForm.tsx` | plan 4 | Inline duplicate-id error (step 9). Optional; skip it. |
| `src/core/harness/opencode/OpenCodeCliProvider.ts` | plan 2 | Caller of the collision resolver (step 10). |
| `src/core/harness/shared/CliMcpConfigGenerator.ts` | plan 2 | MCP config neighbour (step 8). |
| `src/utils/WorkflowPaths.ts` | plan 2 | Not needed by any step here. |
| `src/server/CtrlYokeHostedServer.ts` | plan 1 | Error body of the checkout endpoint (step 16). Parse it client-side instead. |

The full list of other plans' files is in the orchestrating workflow's task text.

---

## 3. Ordered steps

Steps run one after another in this worktree. Steps 1-11 are extension-side and touch
disjoint files. Steps 12-18 are dashboard-side and several of them share
`useMessageHandler.ts`, `uiStore.ts` and `WebviewMessageTypes.ts`; their order below is the
order to apply them, and each should rebase cleanly on the one before because it edits a
different handler.

Every step follows the rules in §5.

### Step 1: Windows CredMan read errors treated as missing

- **Bug:** `dev/bugs/backlog/windows-credman-read-errors-treated-as-missing.md`
- **Files:** `src/platform/OsCredentialStore.ts`
- **Fix:** In `WindowsCredentialBackend.readCredential`, return `undefined` only for exit
  44 (or reuse `isMissingCredential(result)`), and call `throwCommandFailure("CredMan", result)`
  for any other non-zero exit, as the macOS and Linux backends do. Then `get()`, `keys()`,
  the index mutations and `readChunkCount` fail loudly. Also make `keys()` rethrow when the
  index exists but does not parse, so a corrupt index is not overwritten by the next
  `store()`.
- **Tests:** `src/test/unit/OsCredentialStore.test.ts`. Use a fake runner that returns exit
  45 (and separately exit 1) for the `#count` target and for the index target. Assert that
  `get()`, `store()` and `keys()` reject and that the index map is unchanged.

### Step 2: Execution lease torn write wedges acquisitions

- **Bug:** `dev/bugs/backlog/execution-lease-file-torn-write-wedges-acquisitions.md`
- **Files:** `src/core/orchestration/ExecutionRootLeaseManager.ts`
- **Fix:** Write the lease with `writeFileAtomic` (as `updateHeartbeat` already does)
  instead of `open("wx")` + `writeFile`. Extract one tolerant lease reader shared by
  `readLiveLeases` and `inspectLeases`; in the acquire path, unlink a lease that cannot be
  parsed (a malformed lease cannot prove a live owner).
- **Tests:** `src/test/unit/ExecutionRootLeaseManager.test.ts`. Put an empty and a
  truncated `<token>.json` in `leasesRoot`, then assert `acquireLease` succeeds and the bad
  files are gone.

### Step 3: Inline regex comparison can hang the host

- **Bug:** `dev/bugs/backlog/inline-regex-comparison-catastrophic-backtracking-hangs-host.md`
- **Files:** `src/utils/ScriptComparisonAsync.ts`, `src/utils/ScriptComparison.ts`,
  `src/utils/ScriptRegexWorker.ts`
- **Fix:** Stop choosing the guard by input length. Send every `matches` comparison through
  the deadline-guarded worker (`compareRegexInWorker`), whatever the length. Keep the
  synchronous `compareScriptOutputInline` for non-regex operators only. Update the doc
  comment in `ScriptComparison.ts` that claims cost scales with input length. If worker
  start-up cost is a concern, reuse one lazily created worker rather than adding a `vm`
  path. Do not add Node flags (that would touch `package.json`/launch scripts).
- **Tests:** `src/test/unit/scriptComparison.test.ts`. Replace the test that pins the
  inline path for short input. Add `^(a+)+$` against a ~40-char non-matching string and
  expect the timeout reason. Keep the existing long-input timeout test.
- **Tricky:** `compareScriptOutputInline` may have other synchronous callers (completions,
  preview). Grep for them; any sync caller that evaluates user regexes on the host thread
  must not regress. If one exists and cannot go async, leave it and note it in the commit.

### Step 4: Promoted parallel group stays serialized after anchor settles

- **Bug:** `dev/bugs/backlog/promoted-parallel-group-stays-serialized-after-anchor-settles.md`
- **Files:** `src/core/ParallelGroupRun.ts`
- **Fix:** In `settleAdoptedMember`, after `releaseAdoptionWaiter()`, call
  `this.startAvailableWorkers()` when the run has started and fail-fast has not just
  triggered (put it in the `else` of the fail-fast branch).
- **Tests:** `src/test/unit/ParallelGroupRun.test.ts`. Width 2, one adopted anchor,
  pending `["one", "two"]`. Settle the anchor while `"one"` is blocked; assert `"two"` starts
  before `"one"` is released. Add a fail-fast variant asserting no new worker starts.

### Step 5: Antigravity log tail and tool-success scraping

- **Bugs:** `dev/bugs/backlog/antigravity-go-log-tail-splits-partial-lines.md`,
  `dev/bugs/backlog/antigravity-tool-success-scraped-from-exit-code-text.md`
- **Files:** `src/core/harness/shared/BaseLogParser.ts`,
  `src/core/harness/antigravity/AntigravityLogParser.ts`,
  `src/core/harness/antigravity/AntigravityToolEventBuilder.ts`
- **Fix (tail):** Extract the read-and-split part of `BaseLogParser.readNewLines` into a
  protected helper (for example `readNewCompleteLines(filePath): string[]`) that owns
  `lastReadPosition`, truncation reset, `pendingLogText` and the `StringDecoder`. Make
  `BaseLogParser.readNewLines` use it, and replace `AntigravityLogParser.readNewLines`'s
  own split with it while keeping its classification, transcript poll and event order.
- **Fix (success):** Pass the resolved tool name into `resultSucceeded`/`exitCode`. Apply
  the content regex only to `run_command` results and background-task `SYSTEM_MESSAGE`
  completions, anchored to agy's phrasing (`^Exit code: N` line, `exited with code N`).
  Every other tool uses only structured `exit_code`/`exitCode` fields.
- **Tests:** `src/test/unit/AntigravityLogParser.test.ts`: a completion marker and a
  session-UUID line each split across two appends emit exactly one event after the second
  read; a 3-byte UTF-8 char split across reads decodes correctly; a `view_file` `GENERIC`
  result containing `exit code: 1` yields a COMPLETED `FILE_READ`; a `run_command` with
  `Exit code: 1` still fails. Run the other log-parser tests too, since `BaseLogParser`
  is shared by every harness (read `.github/instructions/harness-shared.instructions.md`).

### Step 6: Lifetime usage skippedRunCount double-counts after rescan

- **Bug:** `dev/bugs/backlog/lifetime-usage-skipped-run-count-double-counts-after-rescan.md`
- **Files:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`
- **Fix:** Persist `skippedRunCount` on `LineageData`. Increment it in `applyBackfillBatch`,
  set it from the scan in `replaceLineage`, derive the document total as the sum over
  lineages in `recomputeGrandTotals`, and delete the in-memory `lineageSkippedRunCounts`
  map. Require the new numeric field in the lineage validation so old documents are reset
  and rebuilt (or bump the persisted schema version, whichever the file already uses).
- **Tests:** `src/test/unit/LifetimeUsageStore.test.ts`: backfill a lineage with one
  unreadable run, construct a fresh store, upsert an in-range run with `costSources`, and
  assert `skippedRunCount` is unchanged. Add a test that an old document without the field
  is rebuilt.
- **Why before step 7:** step 7 changes the backfill path that this step adds a counter to.

### Step 7: Lifetime usage backfill drops older runs

- **Bug:** `dev/bugs/backlog/lifetime-usage-backfill-drops-older-runs.md`
- **Files:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`,
  `src/core/harness/shared/usage/WorkspaceStatsService.ts`
- **Fix:** Stop inferring per-run membership from the widened `[countedFrom, countedThrough]`
  interval. Preferred: when a backfill finds refs below `countedFrom` for an existing lineage
  (or for a lineage created by a live upsert and never backfilled), rebuild the lineage from
  a full `scanLineage` + `replaceLineage`, the way `upsertRunContribution` already handles a
  ref below `countedFrom`. Also make the upsert append path clear the lineage's backfill
  checkpoint (`backfillComplete = false` / `dirMtimeMs`) when it extends a lineage
  mid-backfill.
- **Tests:** `src/test/unit/LifetimeUsageStore.test.ts` and
  `src/test/unit/WorkspaceStatsService.test.ts`: upsert D then backfill [A, B, C] gives
  `runCount` 4; a backfill of more than 32 older refs counts all of them; an upsert landing
  between two batches drops nothing; `skippedRunCount` from step 6 stays correct through a
  rebuild.

### Step 8: Harness MCP export: read failures and Codex TOML subtables

- **Bugs:** `dev/bugs/backlog/harness-mcp-export-overwrites-config-on-read-failure.md`,
  `dev/bugs/backlog/codex-toml-export-ignores-env-subtables-and-header-comments.md`
- **Files:** `src/utils/HarnessMcpExporter.ts`, `src/utils/HarnessLspExporter.ts`,
  `src/utils/AtomicFileUtils.ts`, `src/utils/McpDiscoveryUtils.ts`
- **Fix (read failure), do first:** Move the ENOENT-only read helper and the
  realpath-resolving, random-suffix atomic writer that `HarnessLspExporter` already has into
  one shared helper (in `AtomicFileUtils.ts`, alongside `writeFileAtomic`, or reusing it if it
  can resolve symlinks). Use it from both exporters. The Codex TOML write/remove paths must go
  through it too instead of plain `fs.promises.writeFile`.
- **Fix (TOML):** Export a single TOML section-key helper from `McpDiscoveryUtils` (built on
  `parseTomlMcpServerKey`) that maps `[mcp_servers.<id>]` and any `[mcp_servers.<id>.*]`
  subtable to `<id>`, and use it in `writeCodexTomlFile` and `removeCodexTomlServers` so
  export and remove drop every block of the target server. Detect headers with a pattern
  that allows a trailing `# comment` and `[[...]]` array tables. Do **not** add a TOML
  library: `package.json` belongs to plan 1. If a TOML parser is already a dependency (check
  `node_modules` and existing imports), tests may use it to assert validity.
- **Tests:** `src/test/unit/HarnessMcpExporter.test.ts`, `src/test/unit/HarnessLspExporter.test.ts`,
  `src/test/unit/McpDiscoveryUtils.test.ts`. Unreadable existing file (simulate EACCES/EISDIR,
  e.g. a directory at the target path): export and remove reject and leave it untouched.
  Symlinked JSON target: link survives, target updated (skip the symlink case on Windows if
  the test runner lacks symlink privilege, as other tests in the repo do). TOML: export with
  `env` over an `[mcp_servers.foo.env]` layout yields one `env`; remove drops the subtable; a
  commented header for server `bar` survives removal of `a`.

### Step 9: MCP registry rename collision and stale search replies

- **Bugs:** `dev/bugs/backlog/mcp-registry-rename-to-existing-id-overwrites-server.md`,
  `dev/bugs/backlog/mcp-registry-search-results-not-matched-to-query.md`
- **Files:** `src/utils/McpRegistryFileManager.ts`, `src/ui/McpManagerService.ts`,
  `src/types/WebviewMessageTypes.ts`, `src/ui/webview-react/store/useMcpManagerStore.ts`,
  `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Fix (rename):** Add an atomic `rename(previousId, server, scope)` to
  `McpRegistryFileManager` that, inside one `serializeMutation`, rejects when another entry
  already has `server.id`, replaces the `previousId` entry in place and writes once. Call it
  from `handleSaveRegistryServer` when the id changed, and surface the rejection through the
  existing save-error path. Also reject a plain add whose id is taken if that path has the
  same overwrite. Skip the optional inline form error (`McpServerForm.tsx` is plan 4's).
- **Fix (search):** Add `requestId` to `RequestMcpRegistrySearchMessage` and
  `McpRegistrySearchResultMessage`. The store increments and records `latestRemoteRequestId`
  in `searchRemoteRegistry` (and `goNextPage`), `handleRequestRegistrySearch` echoes it, and
  `setRemoteSearchResult` drops any reply with a different id.
- **Tests:** `src/test/unit/McpRegistryFileManager.test.ts` (collision rejected and registry
  unchanged; failed write after rename leaves the original entry);
  `src/ui/webview-react/test/store/useMcpManagerStore.test.ts` (two searches, replies in
  reverse order, first ignored, cursor from the second).

### Step 10: OpenCode permission collision ignores other config files

- **Bug:** `dev/bugs/backlog/opencode-permission-collision-ignores-other-config-files.md`
- **Files:** `src/core/harness/opencode/OpenCodeInlineConfig.ts`
- **Re-verify first (UNCERTAIN on details):** The bug's list of OpenCode config layers is
  taken from OpenCode 1.19's loader. Before coding, confirm which files the installed
  OpenCode actually reads (its docs, or `opencode debug config` if available) and that
  merged keys keep the lower layer's order. The resolver gap itself (it only reads
  `opencode.json`, and resolves a relative `OPENCODE_CONFIG` against `process.cwd()`) is
  confirmed in code. If the extra layers turn out not to exist, still fix the
  `OPENCODE_CONFIG` cwd defect and the confirmed `opencode.jsonc` gap; only reject the bug
  (see §5) if none of it reproduces.
- **Fix:** Discover in OpenCode's order: global dir `config.json`, `opencode.json`,
  `opencode.jsonc`; `OPENCODE_CONFIG` resolved against the workspace root; project
  `opencode.json[c]` in each directory from the worktree/git root down to the workspace
  root; `.opencode/opencode.json[c]` in those directories, plus `OPENCODE_CONFIG_DIR`. Parse
  `.jsonc` with the JSONC parser the repo already uses. Put the file-name lists in shared
  constants. Do not edit `OpenCodeCliProvider.ts` (plan 2); the resolver's signature should
  stay compatible.
- **Tests:** `src/test/unit/OpenCodeCliProvider.test.ts` (it already covers this
  resolver): a key defined only in `opencode.jsonc`, only in global `config.json`, only in a
  parent-directory project config, and only in `.opencode/opencode.json` each cause
  renaming; a relative `OPENCODE_CONFIG` resolves against the workspace root.
- **Docs:** if `docs/workflows/permissions.md` or `docs/harnesses/` describes which OpenCode
  config files are considered, update it.

### Step 11: Git snapshot wrong when the workspace is a repo subdirectory

- **Bug:** `dev/bugs/backlog/git-snapshot-wrong-when-workspace-is-repo-subdirectory.md`
- **Files:** `src/utils/WorkspaceSnapshotService.ts`
- **Fix:** For the GIT strategy in the single-root branch of `captureWorkspaceState`, resolve
  the repo toplevel (preferably via the same `discoverRepos` helper the multi-root path
  uses). When it differs from `executionRoot`, build the segment with `root = toplevel`,
  `pathspec = toPosixPath(path.relative(toplevel, executionRoot))`, `prefix = ""`. Fix
  `enrichSnapshotBeforeContent`'s single-root `git show` to use the toplevel-relative path
  (via `gitRelFromChange` or a `repos` entry).
- **Tests:** `src/test/unit/WorkspaceSnapshotService.test.ts`, with a real temp git repo
  and the workspace at `packages/foo`: modified file appears with a workspace-relative path;
  deleted file is recorded workspace-relative; a change outside the subtree is excluded;
  undo restores the deleted file in place and writes no stray nested path. Keep the
  existing toplevel and multi-root tests green.
- **Tricky:** read `.github/instructions/utils.instructions.md` first. Paths reported by
  git are POSIX; compare and join carefully on Windows.

### Step 12: Deleted-lineage lockdown not rolled back on refuse or undo

- **Bug:** `dev/bugs/backlog/deleted-lineage-lockdown-not-rolled-back-on-refuse-or-undo.md`
- **Files:** `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`,
  `src/ui/webview-react/hooks/useMessageHandler.ts`, `src/ui/webview-react/store/uiStore.ts`,
  `src/types/WebviewMessageTypes.ts`, `src/core/orchestration/HistoryTrashRepository.ts`,
  `src/ui/WorkflowSerializer.ts`
- **Fix:** Stop setting `viewingDeletedWorkflow` optimistically in
  `markIfViewingDeletedLineage`. Have `HISTORY_TRASHED` carry the trashed workflowKey(s)
  (add the field in `WebviewMessageTypes.ts`, fill it in `WorkflowSerializer`), and set the
  flag in that handler only when a key matches the displayed workflow. Clear it when
  `HISTORY_TRASH_RESULT` reports a successful restore covering the displayed key. Replace the
  stale "hard-deletes immediately" comment. `HistoryTrashRepository` likely needs no change
  unless the trashed keys are not already returned by `trashLineage`.
- **Tests:** `WorkflowStatus.test.tsx` (deleting does not lock before confirmation),
  `useMessageHandler.test.ts` (trashed with matching key locks; restore unlocks; refused
  delete never locks), plus `WorkflowSerializer.test.ts` for the new payload field.

### Step 13: Template modal create has no in-flight guard

- **Bug:** `dev/bugs/backlog/template-modal-create-has-no-in-flight-guard.md`
- **Files:** `src/ui/webview-react/components/workflow/TemplateModal.tsx`,
  `src/ui/webview-react/store/uiStore.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Fix:** Add a `uiStore` "create pending" flag (backed by a ref in the modal so two clicks
  in one frame are both caught). Set it in `handleSubmit` before posting `CREATE_WORKFLOW`
  and return early if set; disable both Create buttons and show a "Creating…" label while
  set; ignore `e.repeat` in `handleKeyDown`. The `WORKFLOW_CREATED` handler clears it (on
  error so the user can retry), and opening the modal resets it.
- **Tests:** `TemplateModal.test.tsx` (double-click Create & Run posts one `CREATE_WORKFLOW`;
  repeated Ctrl+Enter keydown posts one; error reply re-enables), `uiStore.test.ts` for the
  flag.

### Step 14: Dry-run preview stale after discarding a continuation

- **Bug:** `dev/bugs/backlog/dry-run-preview-stale-after-discard-continuation.md`
- **Files:** `src/ui/webview-react/store/executionPreviewStore.ts`,
  `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Fix:** Authoritative pushes (`WORKFLOW_VIEW_IDENTITY`, `RUN_VIEW_LOADED`) overwrite the
  definition head instead of taking `Math.max`; `resolve()` treats the server's
  `displayedDefinitionRevision` as the current head. If an out-of-order guard is still
  needed, key it on `descriptorRevision` the way `uiStore.mergeDescriptorRevision` does.
- **Tests:** `executionPreviewStore.test.ts`: observe 3, observe 2 (authoritative), resolve
  with 2, `isStale === false`.

### Step 15: useLocalValue focus-only blur and POSIX CLI file links

- **Bugs:** `dev/bugs/backlog/local-value-commits-stale-value-on-focus-only-blur.md`,
  `dev/bugs/backlog/cli-command-posix-absolute-paths-linked-as-relative.md`
- **Files:** `src/ui/webview-react/hooks/useLocalInput.ts`,
  `src/ui/webview-react/utils/cliCommandFileLinks.ts`
- **Fix (local value):** Track a `dirty` ref set only in `onChange`. Make `onFocus` a no-op
  (keep it in the returned object so `LocalInputs.tsx` spreads stay valid). In `onBlur`,
  commit only when dirty; otherwise resync to `externalValueRef.current`. Clear the flag.
- **Fix (links):** Add a POSIX-absolute alternative to `CLI_FILE_PATH_SOURCE` after the
  `/abs/path/c:/` and `/X:/` alternatives, require a start-of-string or non-path character
  before the slash so `https://x/y.md` is not linked, and widen `ABSOLUTE_PATH_PATTERN` to
  `/^(?:[A-Za-z]:[\\/]|\/)/`.
- **Tests:** `useLocalInput.test.tsx` (focus, external value changes, blur: no commit and the
  input shows the new value; typing then blur still commits); `cliCommandFileLinks.test.tsx`
  (`@/Users/me/repo/src/foo.ts` and `/home/u/repo/.ctrlyoke/temp/x.md` with a POSIX cwd
  link the full absolute path; URLs are not linked; existing Windows cases unchanged).

### Step 16: Commit checkout failure silently swallowed

- **Bug:** `dev/bugs/backlog/commit-checkout-failure-silently-swallowed.md`
- **Files:** `src/ui/webview-react/hooks/useCommitHistoryContextMenu.tsx`,
  `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitHistoryPane.tsx`,
  `src/ui/webview-react/utils/hostedApi.ts`
- **Fix:** Add a small helper in `hostedApi.ts` that extracts the `{ error }` message from a
  `HostedHttpError` body (falling back to the raw message). In both the checkout-commit
  handler and the Return-to-branch handler: log with `WebviewLog`, show an inline error
  banner in the commit-history pane (dismissible), and call `onRefresh()` in `finally`.
  Share one handler-wrapper for workspace-viewer git mutations. Remove the misleading
  comments. Do not change the server (plan 1 owns `CtrlYokeHostedServer.ts`).
- **Tests:** `useCommitHistoryContextMenu.test.tsx` and `WorkspaceCommitHistoryPane.test.tsx`
  (mock checkout to reject, assert the message is shown and refresh is called);
  `hostedApi.test.ts` for the message extraction.

### Step 17: Diff gap expand uses rendered-hunk index

- **Bug:** `dev/bugs/backlog/diff-gap-expand-uses-rendered-hunk-index.md`
- **Files:** `src/ui/webview-react/components/output/DiffView.tsx`
- **Re-verify first (UNCERTAIN):** The failure depends on react-diff-view merging adjacent
  hunks once a gap is fully filled. Write the failing Vitest case first (three hunks, fully
  expand gap 1, then expand gap 2). If gap 2 already expands, the bug is not real: reject it
  per §5 and keep the test as a regression guard.
- **Fix:** Map the clicked rendered gap back to its base gap index (the base hunk whose
  `oldStart` equals the rendered hunk's `oldStart`, else the first with `oldStart >=` it) and
  use that index for `handleExpand`, `onExpandGap` and the `activeExpandedGaps.get` lookup.
  This keeps `outputRenderUtils.ts` and all controlled callers unchanged.
- **Tests:** `src/ui/webview-react/test/components/output/DiffView.test.tsx`: the
  three-hunk case renders gap 2's lines; in controlled mode `onExpandGap` receives the base
  index; the auto-expanded 1-line-gap case.

### Step 18: Steps panel "Copy full output" omits the prompt

- **Bug:** `dev/bugs/backlog/steps-panel-copy-full-output-omits-prompt.md`
- **Files:** `src/ui/webview-react/hooks/useLatestStepOutput.ts`,
  `src/ui/webview-react/utils/stepContextMenuItems.ts`,
  `src/ui/webview-react/hooks/useStepContextMenu.tsx`,
  `src/ui/webview-react/hooks/useFinalStepContextMenu.tsx`, and the callers that pass the
  latest output through: `WorkflowStepsPanel.tsx`, `PromptChipRail.tsx`,
  `WorkflowStepRow.tsx`, `WorkflowStep.tsx`, `ParallelGroupPanel.tsx`, `FinalStepFooter.tsx`
- **Fix:** Have `useLatestStepOutput` / `useFinalStepLatestOutput` return `{ output, prompt }`
  from the attempt's `OrderedCliHistoryEntry`, and pass `prompt` into
  `generateSingleStepMarkdownExport`. Prefer threading the pair through one shared type so
  the six component call sites change mechanically.
- **Tests:** `useLatestStepOutput.test.ts` (prompt returned), `useStepContextMenu.test.tsx`
  and `useFinalStepContextMenu.test.tsx` (copied markdown has a `### Prompt` section).

---

## 4. Bugs needing Nathan's decision

None. Every bug in this plan has a clear fix that stays inside the owned files. Two
choices were made here rather than escalated:

- Step 3 picks "always use the worker" over a `vm` timeout or a V8 flag, because the flag
  would touch launch config owned by plan 1 and `vm` adds a second evaluation path.
- Step 8 does not add a TOML library, because `package.json` is owned by plan 1. If the
  hand-rolled section matching proves too fragile, the step should note that in its
  commit message as a follow-up for Nathan, not add the dependency.

If a step finds that a fix truly requires a decision (for example a behavior change a user
would notice that the bug doc does not settle), the orchestrator should skip that step and
list it in its final summary.

---

## 5. Rules every queued step follows

1. **Self-contained.** Each step runs in a fresh session. Its prompt must name the bug
   doc(s), the files, and the relevant instruction files to read
   (`.github/instructions/*` per the routing table in `CLAUDE.md`). Read the bug doc and the
   cited code before changing anything; line numbers in bug docs may have drifted.
2. **Stay in your lane.** Edit only files owned by this plan (§2). If a fix truly needs a
   file owned by plan 1, 2 or 4, keep that edit minimal and name it in the commit message.
3. **Fix and test.** Fix the bug and add or update tests that fail without the fix.
4. **`npm test` passes.** Run it once and read the `TEST SUMMARY:` block
   (`npm test 2>&1 | Select-Object -Last 40`). Never run `npm run test:harness`. Also run
   `npm run lint` and `npm run typecheck` if the summary does not already cover them.
5. **Move the bug doc.** `git mv` each fixed bug doc to `dev/bugs/implemented/`, replacing
   its `**Severity:**` line with `**Resolution:** fixed in this commit`.
6. **Re-verification outcome.** For a step marked UNCERTAIN (steps 10 and 17), if the bug
   does not reproduce, `git mv` the doc to `dev/bugs/rejected/` with a one-line
   `**Resolution:**` giving the reason, instead of fixing it.
7. **Docs.** If behavior a user sees or types changes, update the hand-written `docs/`
   page in the same commit. No step here changes a schema, so generated reference pages
   should not change.
8. **Commit.** Commit the step's own work on the current branch with a plain
   conventional-commit message (`fix: ...`). No attribution or trailer lines. Do not create
   a branch.

---

## 6. Done criteria

Every bug doc listed below is in `dev/bugs/implemented/` or `dev/bugs/rejected/`, and the
final `npm test` summary is all PASS.

- `deleted-lineage-lockdown-not-rolled-back-on-refuse-or-undo.md`
- `dry-run-preview-stale-after-discard-continuation.md`
- `mcp-registry-rename-to-existing-id-overwrites-server.md`
- `mcp-registry-search-results-not-matched-to-query.md`
- `template-modal-create-has-no-in-flight-guard.md`
- `lifetime-usage-backfill-drops-older-runs.md`
- `lifetime-usage-skipped-run-count-double-counts-after-rescan.md`
- `codex-toml-export-ignores-env-subtables-and-header-comments.md`
- `harness-mcp-export-overwrites-config-on-read-failure.md`
- `git-snapshot-wrong-when-workspace-is-repo-subdirectory.md`
- `opencode-permission-collision-ignores-other-config-files.md`
- `antigravity-go-log-tail-splits-partial-lines.md`
- `antigravity-tool-success-scraped-from-exit-code-text.md`
- `cli-command-posix-absolute-paths-linked-as-relative.md`
- `commit-checkout-failure-silently-swallowed.md`
- `diff-gap-expand-uses-rendered-hunk-index.md`
- `execution-lease-file-torn-write-wedges-acquisitions.md`
- `inline-regex-comparison-catastrophic-backtracking-hangs-host.md`
- `local-value-commits-stale-value-on-focus-only-blur.md`
- `promoted-parallel-group-stays-serialized-after-anchor-settles.md`
- `steps-panel-copy-full-output-omits-prompt.md`
- `windows-credman-read-errors-treated-as-missing.md`
