# Code smell ledger

Durable record for the smell-hunt loop (`.ctrlyoke/templates/smell-hunt-loop.ctrlyoke.yaml`).
Each pass reads this before proposing work, so it never re-proposes something already
deferred or ruled out. One bullet per smell: files involved and a one-line reason.

## Passes

- **2026-11-08, pass 1** — hunted the harness layer and shared helpers. Fixed directly:
  `CopilotNotificationMonitor.buildHookConfig` re-implemented the base class's
  `encodePermissionRequestHook`; single-sourced matching JSON type guards and number
  parsers in `src/utils/JsonTypeGuards.ts`. Also routed exact inline
  `instanceof Error ? … : String(…)` source copies through `getErrorMessage` in
  `src/utils/ErrorUtils.ts`, removing five private copies across CLI, core, server and
  utilities while updating source call sites across workers and UI.
- **2026-11-08, pass 2** — reviewed pass 1's two refactors (behavior preserved). Cleaned
  up: four files failed Prettier, five imports had landed above file-header comments,
  two cross-module `export { isRecord }` re-exports (`WorkflowLocationTypes.ts`,
  `AntigravityTranscriptTypes.ts`) were replaced by direct `JsonTypeGuards` imports,
  four one-line `getErrorMessage` wrappers (`errorText`/`describeError`) were inlined,
  and webview imports of `ErrorUtils` now use the `@root/utils` alias. Hunted Node errno
  handling, webview step guards and the webview paged-listing hooks; queued three steps
  (errno-code helpers, `isScriptStep` copies, paged-hook helpers + `toError`).
  The errno-code refactor landed in `src/types/DashboardConstants.ts` and
  `src/utils/ErrorUtils.ts`, with source call sites and coverage updated.
  The six webview `isScriptStep` copies now use the generic core guard from
  `src/types/CtrlYokeTypes.ts`; focused guard coverage was added. Completed the
  queued paged-listing leaf-helper extraction in `utils/pagedListing.ts` and
  routed all nine exact error-normalization copies through `toError` in
  `src/utils/ErrorUtils.ts`; helper and unit coverage was added without changing
  hook state machines or response usability checks.
- **2026-11-08, pass 3** — reviewed pass 2's three refactors (behavior preserved). Cleaned
  up: removed `isFileNotFoundError(error, code)`, a pure alias of `hasErrnoCode`, and
  folded paired `!hasErrnoCode(e, A) && !hasErrnoCode(e, B)` checks into the variadic
  form. Fixed directly: merge-outcome literals in `WorktreeManager`/`DashboardMessageRouter`
  now use `WORKTREE_MERGE_OUTCOMES`; `confirmMutation` copied in `HistoryCommands` and
  `SecretCommands` now lives in `src/cli/CliPrompt.ts` (with a `CliConfirmIo` base
  interface); three inline newer-schema refusals (`mcp-server.ts`,
  `WorkingFileManager.ts`, `PromptFileParser.ts`) now call `assertWritableSchema`.
  Hunted the harness providers and the CLI/MCP/extension adapters; queued three steps
  (`escapeRegExp` copies, provider statusline registration, drifted effective-model
  resolution in MCP/CLI/OutputHistoryManager).
  The six regex-escaping copies now use the import-free `src/utils/TextUtils.ts` helper.
  Per-prompt statusline registration now lives in one shared harness helper, and declined installs no longer start idle sidecars.
  The drifted effective step harness/model calculations in `src/cli.ts`,
  `src/mcp-server.ts` and `OutputHistoryManager.ts` now use
  `resolveStepHarnessAndModel` from `src/types/ExecutionPropertyResolver.ts`.

- **2026-11-08, pass 4** — reviewed pass 3's three refactors (behavior preserved; the
  declined-install statusline change and the cross-harness model fix are filed bugs).
  Cleaned up: `ProviderStatuslineRegistration` now exposes the current prompt's
  `snapshotPath`, so the Claude and Antigravity providers no longer rebuild the
  `<prefix>-statusline-<token>.json` name; dropped an orphaned doc comment and two
  single-use temporaries around `resolveStepHarnessAndModel`. Fixed directly:
  `StatusIcon` kept its own status-to-codicon switch that disagreed with
  `STATUS_ICONS` on SENT (it now reads `STATUS_ICONS`, which takes the rendered
  arrow-up); `Header.tsx` slot actions use `WORKFLOW_EXECUTION_CONTROL_ACTIONS`.
  Completion notification deduplication now shares its summary and event-id state
  machine between the hosted server and VS Code toast manager.
  Hunted the hosted server, the dashboard bridge and the React dashboard; queued five
  steps (completion-notification dedup tracker, hosted viewer route error mapping,
  viewer idle-LRU snapshot stores, LSP server-root containment casing + realpath
  fallback, dashboard token/context stats copies).
  Added shared hosted workspace-viewer route error mapping and corrected reachable 403/`WorkspaceTreeHttpError` statuses.
  The viewer's file-history, commit-log, and git-ref-diff caches now share `IdleLruSnapshotStore` while retaining their existing refresh and eviction behavior.
  Fixed the LSP root-marker drive-letter casing regression and shared the server's realpath-with-fallback helper in `PathSecurity`.
  Dashboard token tooltips now share `buildAttemptTokenTooltipLines`, metadata follows live context telemetry during reruns, and Markdown exports preserve reported totals.
  Candidates for a later pass: inline `HARNESS_INFO[id]?.name ?? id` lookups in about
  ten webview files instead of `getHarnessDisplayName`/`getHarnessShortName`;
  "Parallel steps X–Y" labels retyped beside `parallelGroupHeaderTitle` in
  `utils/outputRows.ts`; `formatStepTargetLabel` re-inlined in
  `useOutputContextMenu.tsx` and `outputRowTiming.ts`; `WebPushService.atomicWriteJson`
  not using `uniqueAtomicTempPath`; hosted-server query parsing (`repo` trimmed from
  the query but not the body; three page-size parsers beside `WorkspaceTreeRoute`'s
  strict ones); `EXECUTION_STATE_ICONS` vs `EXECUTION_STATE_BADGE_ICONS` in
  `ui/webview-react/utils/status.ts` (the former has no production consumer).

- **2026-11-08, pass 5** — reviewed pass 4's five commits (behavior preserved; the
  route-status, LSP-casing and token-stats changes are filed bugs). Cleaned up: removed
  the unused `has()`/`size` members of `IdleLruSnapshotStore`. Hunted the pass-4
  candidate list and `npm run knip`'s duplicate exports; queued five steps (pure alias
  exports, inline harness display-name lookups, "Parallel steps X–Y" range label, dead
  and drifted execution-state helpers in `utils/status.ts`, `WebPushService`'s private
  atomic JSON write). Still open for a later pass: `formatStepTargetLabel` re-inlined in
  `useOutputContextMenu.tsx`/`outputRowTiming.ts`; hosted-server query parsing (`repo`
  trimmed from the query but not the body; page-size parsers beside
  `WorkspaceTreeRoute`'s strict ones); `src/license/LemonSqueezyConstants.ts` reported
  as an unused file by knip. Removed the ten pure aliases reported by knip and updated
  all source and test callers to use the canonical names. Replaced the inline harness
  display-name fallbacks across the dashboard with the shared display/short-name
  helpers, with known and unknown ID coverage.
  Single-sourced "Parallel steps X–Y" in `formatParallelStepsLabel` across core, CLI
  and dashboard callers; kept the screen-reader "to" wording unchanged.
  Removed dead, drifted execution-state helpers and their tests from the dashboard
  status utilities; retained the shared step icon maps and live control logic.
  Replaced `WebPushService.atomicWriteJson`'s collision-prone temp write with `writeFileAtomic`, preserving JSON formatting and private file modes.

- **2026-11-08, pass 6** — reviewed pass 5's five commits (behavior preserved; `npm test`
  green). Cleaned up: nine files the pass-5 steps left un-Prettiered;
  `formatStepTargetLabel` re-inlined in `useOutputContextMenu.tsx` and
  `outputRowTiming.ts`. Fixed directly: `PromptLinkProvider` compared against a raw
  `"missing"` instead of `PROMPT_FILE_RESOLUTION_STATUSES.MISSING`; `WorkspaceFileIndex`
  checked `"ERR_WORKER_OUT_OF_MEMORY"` by hand (now a `NODE_ERROR_CODES` entry via
  `hasErrnoCode`); `HostedWorkspaceViewerService.currentRemote`'s `?? "origin"` could
  never fire (now `||`). Hunted `src/core/orchestration/`, `src/cli/`, `src/config/`,
  `src/git/`, `src/completions/`; queued five steps (shared execution-state sets with two
  drifted copies, JSONC store read/atomic write in `src/config/`, relative-path escape
  check, `queue:N`/`final:N` target keys, hosted route query-string parsing).
  Landed the execution-state membership refactor through `ACTIVE_EXECUTION_STATES`
  and `IN_FLIGHT_EXECUTION_STATES`; fixed and covered the PAUSING append and
  CANCELLING ownership bugs.
  Shared JSONC object-file reads and hardened atomic writes across settings, trust stores and the MCP registry; corrected empty and invalid-root trust-store handling.
  Single-sourced native `path.relative` escape checks and fixed `..`-prefixed child paths.
  Single-sourced persisted output-target and attempt keys; the CLI terminal fallback still assumes queue targets and would mislabel a final target if one reaches it, for a later pass.
  Single-sourced hosted viewer optional query strings and file-history/git-ref-diff paging parameters, preserving their route-specific parsing behavior.
  Final review (workflow stopped after pass 6): all five steps preserved behavior; removed
  a leftover private `isExecutionOwnerState` wrapper, the `queueTargetKey` re-export
  from `RunOutputResolver`, and the now-dead `src/config/AtomicFileWrite.ts`.
  Candidates for a later pass: win32-only `toLowerCase()` path keys re-derived beside
  `PathCasing` (`RunSummaryCache.cacheKey`, `WorkspaceRepoDiscovery.pathKey` whose comment
  claims macOS folding too, `ExecutionPreviewService.normalizeComparisonPath`,
  `WorktreeManager.dedupePaths` vs `WorkflowBundleAnalyzer`'s non-folding dedupe);
  `flattenSteps` (`WorkflowFileCompletionCore.ts`) vs `flatStepCount`
  (`WorkflowPromptDiagnostics.ts`) disagreeing on non-object members; identical private
  copies of `normalizeBranchName` (`WorktreeManager`/`GitUtils`), `mapWithConcurrency`
  (`historySearchRebuildWorker`/`SkillsRegistryClient`), `lstatIfExists`
  (`ProjectStateLifecycle`/`ProjectStateRegistry`), `symbolKey`
  (`FallbackSymbolIndex`/`LspSymbolIndex`), `matchesPrefix` (permission/script completion
  helpers); `truncateUtf8` in `CommitMessageGenerator` vs `CliPromptPreparer`.
- **2026-11-09, error handling plan** — resolved the deferred "CLI error reporting in
  `src/cli.ts`" entry: every CLI error path now goes through `reportCliError`
  (`src/cli/CliExitCode.ts`), which owns redaction, the `Error: ` prefix, closed-pipe
  handling and exit codes. Commands without a JSON error shape gained the additive
  `{ schemaVersion: 1, success: false, error }` envelope, and integer flags use the strict
  parser in `src/cli/CliIntegerParsing.ts`. See
  `dev/implemented/ERROR_HANDLING_CONSISTENCY_PLAN.md` (§3 C1–C4, §4 R6).
- **2026-11-09, deferred review**: investigated every Deferred entry's open question.
  Each entry below now records its answer. Four entries hid real bugs, filed in
  `dev/bugs/backlog/`:
  - `mcp-skill-mode-ignores-workspace-run-history-location.md`
  - `paged-git-hooks-never-recover-from-expired-listing.md`
  - `prompt-completion-triggers-drift-between-editor-and-dashboard.md`
  - `unrecognized-model-falls-back-to-literal-none.md`

  Decided to fix: the duration-format convergence, plus three small cleanups (dead
  dashboard `notify*` copies, the dead WebSocket 4401 check, OpenCode preview
  splitting). Moved the generic paged hook and the trust-store base class to Ruled out.
  Recommended order: the four bugs (MCP location, paged hooks, completion triggers,
  model fallback), then the duration formats with the cleanups.

  Landed so far: the MCP location fix; the paged git hooks' expiry recovery; and the
  completion triggers, now decided once in `findPromptTriggerContext`
  (`src/completions/PromptTriggerContext.ts`), which both editors call. That last one
  removes the completion-trigger entry from Deferred. Then the model fallback
  (`resolveCliModelFlag`), which shrinks the `validateAndGetModel` entry to its one open
  product question. Then the duration formats and the three cleanups, which remove the
  dashboard-message, duration-format and access-token entries from Deferred:
  - Copy Metadata, Markdown export and `ScriptVerdict` use `formatClockDuration`
    (`ScriptVerdict`'s accessible name uses `formatSpokenDuration`).
  - The dead `notify*` copies in `CtrlYokeWebviewProvider` are gone. `DashboardApplication`
    and `CtrlYokeHostedServer` build their messages with `src/ui/DashboardProviderMessages.ts`.
  - The WebSocket `connection` handler's dead 4401 check is gone. HTTP routes and the
    upgrade share `tokenMatches`, so the upgrade also accepts `HOSTED_TOKEN_HEADER`.
  - `getClaudeModelName` rewrites only Copilot-style dotted IDs and `sonnet[1m]`-style
    aliases; every other ID naming Claude (Bedrock, Vertex, ARNs, pinned) passes through.
    That removes the Claude model-name entry from Deferred.
  - Qwen and OpenCode share `splitDescriptionPreview`
    (`src/core/harness/shared/AskUserQuestionPreview.ts`), the first piece of the shared
    ask-user-question parser.

## Deferred

Entries marked **Decided** have an agreed fix that hasn't landed yet. The others are
still deferred.

- Ask-user-question parsing in all six providers (`antigravity/AntigravityToolEventBuilder.ts`
  `parseQuestions`/`parseOptions`, `qwen/QwenLogParser.ts` `parseAskUserQuestionEntries`,
  `copilot/CopilotToolBuilder.ts` `parseQuestionEntries`/`parseChoice(s)`,
  `claude/ClaudeToolBuilder.ts`, `codex/CodexToolBuilder.ts`
  `parseRequestUserInputQuestions`, `opencode/OpenCodeEventMapper.ts`
  `parseOpenCodeQuestions`) — same output shape, but each harness has its own field
  aliases, string-option formats and preview heuristics; a shared parser needs a design
  for per-harness alias tables rather than a mechanical merge.
  _2026-11-09:_
  - **Plan.** The core is shareable: a question-list normalizer that takes per-harness
    alias keys and JSON-string handling, one object-option parser, and one answer
    matcher (Copilot and Qwen currently have copies). The plain-string option formats
    (Copilot, Antigravity) and the description splitters (Qwen, OpenCode) stay
    per-harness. That saves about 120 lines.
  - **Before merging.** Add a characterization test per harness for every alias key.
  - **Already shared.** The description splitter: Qwen and OpenCode both call
    `splitDescriptionPreview` (`shared/AskUserQuestionPreview.ts`).
- Run-history/project-state bootstrap in `src/cli.ts` (`runCommand`),
  `src/mcp-server.ts` (`initializeMcpStorage`), `src/extension.ts` and
  `src/cli/CliWorkspaceBootstrap.ts`: drifted. MCP reads the location from
  `CTRLYOKE_RUN_HISTORY_LOCATION` instead of settings, and `CliWorkspaceBootstrap` never
  logs the state-home warning.
  _2026-11-09:_
  - **The env handoff is intentional.** It predates settings loading in the MCP
    process, and still carries the parent's frozen value.
  - **The bug.** No fallback to settings when the variable is absent (skill mode,
    standalone registration); see
    `dev/bugs/implemented/mcp-skill-mode-ignores-workspace-run-history-location.md`
    (fixed).
  - **The missing warning is harmless.** It only fires when `CTRLYOKE_HOME` is inside
    the repo, and `ctrlyoke run` already logs it. Fold it in only if a shared
    bootstrap helper gets written.
- Internal `CTRLYOKE_*` env-var names (`CTRLYOKE_PROMPT_INDEX`, `CTRLYOKE_EXECUTION_ROOT`,
  `CTRLYOKE_WORKSPACE`, ...) written by `CliExecutionRunner.ts`, `CliMcpConfigGenerator.ts`,
  `CommitMessageGenerator.ts`, `HarnessAdapterUtils.ts` and read in `mcp-server.ts` as raw
  names; `CTRLYOKE_ENV_VARS` has only three keys.
  _2026-11-09: classified about 55 names. Every writer's spelling matches its readers,
  so this is hygiene only._
  - **User contract.** `HOME`, `WORKING_FILE`, `VAR_<KEY>`, the hook env in
    `docs/workflows/hooks.md`, `SERVER_TOKEN`, `LICENSE_KEY*`, `PARTICIPANT_LABEL`,
    and the MCP table in `docs/cli/ctrlyoke-mcp.md`.
  - **Internal plumbing.** `RUN_ID`, `NOTIFY_*`, `HOOK_CONTEXT_FILE`, `WORKFLOW_ID`,
    `PARALLEL_GROUP_ID`, `MCP_CLI_MODE`, and the per-harness `*_STATUSLINE_*` /
    `OPENCODE_*` / `QWEN_HOOK_SCRIPT` names.
  - **Dev/test only.** `DEV_*`, `HEAP_SNAPSHOT_MB`, `TEST_*`, and similar.
  - **Proposed layout.** Extend `CTRLYOKE_ENV_VARS` with the contract names; add
    `CTRLYOKE_INTERNAL_ENV_VARS`, kept in the per-harness protocol-constant files where
    those exist. Leave dev names as local literals. For the standalone `src/scripts/`
    literals, add a test asserting they match the constants. About 25 files; do it
    later.

- Hosted harness snapshot publish in `CtrlYokeHostedServer` vs
  `src/ui/DashboardSettingsSync.ts` (delta vs full map, missing-registry guard).
  _2026-11-09: no bug; the webview store merges both forms. Left over from the
  dashboard-message cleanup, which shared the registry messages only._
- Optional hosted-server hardening: a `Referrer-Policy: no-referrer` header, so the
  `?token=` in a page URL can't leak through a referrer. Left over from the
  access-token cleanup.

- Git invoked outside `execGit`: `GitCommitter.ts` (own spawn, no timeout),
  `CommitMessageGenerator`'s raw `execFileAsync` with its own 100 MB buffer, three
  repo-toplevel lookups.
  _2026-11-09:_
  - **Correction.** The hosted viewer's commit already goes through `execGit` with
    `GIT_NO_TIMEOUT` (since 579d0ffa1). Its other calls use a private
    `promisify(execFile)` with 10 s / 1 MiB.
  - **Timeout-less reads.** `WorkspaceSnapshotService` reads also bypass `execGit`
    with no timeout; their 512 KB content cap fits the 1 MiB default buffer.
  - **`commitAll` fixed.** Its commit had the 5-minute mutation timeout, so a slower
    pre-commit hook blocked managed-worktree landing. It now uses `GIT_NO_TIMEOUT`.
    `stdin: "ignore"` isn't needed: git gives commit hooks an empty stdin, and
    `execFile` can't set `stdio` anyway.
  - **Same limit on the landing merge.** `mergeNoFastForward` (the `merge: true`
    fallback) still uses the 5-minute timeout, and `git merge` runs the
    `pre-merge-commit` and `commit-msg` hooks.
  - **Toplevel lookups.** The three differ only in normalization and null-vs-throw.
    `RunChangesPlacer` and `GitCommitter` can become `repoToplevel` plus a throw.
  - **Proposed policy.** Hook-running commands (commit, merge, push, pull, checkout):
    `GIT_NO_TIMEOUT`. Queries: 10 s. Whole-repo reads: 5 min. Large diffs: stream to
    the cap instead of a 100 MB buffer.
- Cancelled hosted-viewer page requests keep running on the server. The three git
  fetchers in `src/ui/webview-react/utils/hostedApi.ts` (`workspaceCommitLog`,
  `workspaceFileHistory`, `workspaceGitRefDiffPage`) take no cancel signal, so the
  paged hooks' default fetchers drop theirs (`_signal`). _2026-11-09: deferred; no
  user-visible bug._
  - **A browser-only fix is pointless.** Passing the signal to `hostedFetch` (as
    `workspaceTree` already does) only frees browser connections. No hosted viewer
    route notices a client disconnect, including the directory listing, so the
    server's git work runs to completion either way.
  - **Pages cost real work.** Each commit-history page runs its own git command
    (`getRecentCommits` in `materializeCommitLogPage`).
  - **The real fix spans four layers:** an `AbortController` per route in
    `CtrlYokeHostedServer.ts`, aborted when the response closes early; the signal
    passed through the `HostedWorkspaceViewerService` page methods and their helpers;
    a `signal` option on `execGit` (`src/utils/GitUtils.ts`) that reports a
    cancelled call as aborted, not failed or timed out; then the browser half.
  - **Size.** About 100–150 lines plus tests. Medium risk, because `execGit` is
    shared by everything.
  - **Value.** Low: each page is one bounded git command (10 s timeout), and the
    waste only happens during fast scrolling.

## Ruled out

- `isRecord` in `src/core/harness/copilot/CopilotQuotaClient.ts` — deliberately accepts
  arrays (it only probes RPC error objects for `.code`); different meaning from the shared
  plain-object guard.
- `isScriptStep` in `src/completions/WorkflowFileCompletionCore.ts` — checks raw parsed
  YAML/JSON nodes, not typed workflow steps; keep it separate from the core type guard.
- `isPlainObject` in `src/core/harness/opencode/OpenCodeInlineConfig.ts` and
  `src/ui/webview-react/utils/structuralSharing.ts` — also check the prototype
  (`Object.prototype` or `null`), which the generic guard does not; those callers need it.
- `scripts/*.mjs` copies of `isPlainObject`, `escapeRegExp`, `sleep`, `formatDuration` —
  standalone build scripts that must not import from `src/`.
- `QwenNotificationMonitor` building its node command without quotes while Copilot inlines
  quoted bash/PowerShell commands — intentional: each harness's hook runner parses the
  command differently (comments in both files explain why).
- `isRecord` in `src/core/harness/antigravity/AntigravityStreamJsonUsage.ts` and
  `src/license/LicenseService.ts` — their local `JsonRecord` aliases carry readonly or
  required fields; replacing them with `Record<string, unknown>` would widen/change the
  type guard contract.
- `instanceof Error` message handling outside the exact shared pattern — stack-preserving
  branches, literal fallbacks, error normalization and type checks have different output
  or purpose. Exact matches in `scripts/recover-runs-from-search-index.mjs` and test files
  were left outside this source refactor's scope; `src/utils/ErrorUtils.ts` retains the
  shared helper's own implementation.
- `export { isRecord }` in `src/utils/ctrlyokeToolViews/shared.ts` — kept on purpose:
  that file is the tool-views module's shared barrel and ten sibling models import
  `isRecord` alongside `tryParseJson` from it.
- `normalizePath` in `src/ui/webview-react/utils/promptUndo.ts`,
  `src/core/orchestration/HistorySearchFilters.ts` and `src/utils/CliEventNormalizer.ts`
  — each normalizes differently (lower-casing, trailing-slash trimming, optional input);
  same name, different meaning from the paged hooks' `./`-stripping copy.
- Inline `new Promise((resolve) => setTimeout(resolve, ms))` sleeps (about 15 sites across
  core, harness and utils) — one-line idiom; a shared helper would save nothing.
- `extractSessionIdFromStdout` in the six `*HarnessAdapter.ts` files — each is a few lines
  matching that harness's own event shape and parser; similarity is coincidental.
- `basename` helpers in `src/ui/webview-react/navigation/navTitle.ts`,
  `src/ui/webview-react/utils/stepOverrideChips.ts`, `src/utils/McpSkillCommandRecognizer.ts`
  and `src/utils/StatuslineFormat.ts` — they differ on separators and trailing slashes,
  and each matches its input (route paths vs Windows-or-POSIX paths).
- `confirmDestructive` in `src/cli/HistoryTrashCommands.ts` — throws without `--yes`
  instead of declining, so it is not a copy of `confirmMutation`.
- `parseOtherWorkflowSelector` in `src/mcp-server.ts` vs `GlobalWorkflowStatusService.getStatus`
  — the MCP pre-check produces the MCP tool's own error wording (part of the tool's
  contract); the service's wording is customized for the CLI.
- Antigravity's statusline sidecar not calling `stop()` in its provider — not a leak:
  `CliIntegration` stops every execution sidecar it starts.
- Bundled template loading in `src/server/HostedErrorPageTemplate.ts`,
  `HostedServiceWorkerScript.ts`, `HostedStandaloneShimScript.ts` and
  `HostedThemeDefaults.ts` — the shared part is a two-line candidate-path find; caching
  (the shim stays uncached on purpose for dev rebuilds), placeholder encoding (raw vs
  JSON) and candidate order differ by design.
- `WorkspaceListingSnapshotCache` and `WorkspaceSearchSessionStore` vs the viewer's
  snapshot maps — the listing cache adds a byte cap, a disposed flag and frozen copies;
  the search store uses a strict `>` idle boundary with its own dispose. Only the three
  identical viewer-service copies were queued in pass 4.
- `MAX_OUTPUT_SNAPSHOT_BYTES = MAX_PASTED_IMAGE_BYTES` and
  `OUTPUT_SNAPSHOT_SAVE_TIMEOUT_MS = PASTED_IMAGE_SAVE_TIMEOUT_MS` in
  `src/types/DashboardConstants.ts` — knip calls them duplicate exports, but they name
  two different limits that happen to share a value; both names have real callers.
- `src/ui/webview-react/**/index.ts` barrels — listed under `ignore` in `knip.json` on
  purpose; an unused barrel re-export is not dead code by itself.
- `src/license/LemonSqueezyConstants.ts` — knip reports it unused, but it is imported by
  `landing/src/config.ts` and `netlify/functions/*`, outside knip's project.
- JSON read-with-fallback helpers (`ExecutionRootLeaseManager`/`ExecutionRootScope`
  `readJson`, `RunDefinitionAnchor`/`HarnessFileManager` `readJsonIfPresent`,
  `McpRegistryFileManager`/`McpDiscoveryUtils` `readJsonFile`, `LspDiscoveryUtils.readJson`,
  `FileSystemUtils.readJsonFile`) — each deliberately maps missing/unreadable/malformed
  differently (throw vs null vs warn, JSONC vs JSON); a shared helper would need a flag
  per difference. (The two identical `ExecutionRootScope`/`ExecutionRootLeaseManager`
  copies could still be merged in a later pass.)
- `src/ui/webview-react/store/editorStore.ts` `queue:${index}` draft keys — the
  dashboard's own key over a different target shape, not the output-target key.
- Hosted-server body `repo` reads not trimmed while query `repo` is — clients send ids
  verbatim; the one-line body idiom is left inline.
- One generic `usePagedListing` hook for
  `src/ui/webview-react/hooks/usePaged{CommitHistory,FileHistory,GitRefDiff,WorkspaceDirectory}.ts`.
  The hooks share a skeleton but use three different paging models:
  - CommitHistory and GitRefDiff fetch any page by offset, several at once.
  - FileHistory is cursor-based and append-only, one request at a time, with
    continuation fetches.
  - WorkspaceDirectory adds sort settings and recovers the on-screen row after a
    reload.

  A single hook would need a hook point for each difference, at medium-high risk.
  Shared leaf helpers in `utils/pagedListing.ts` are the right level. The missing
  expiry recovery was a bug, now fixed
  (`dev/bugs/implemented/paged-git-hooks-never-recover-from-expired-listing.md`);
  the three git hooks share `isExpiredListingError` and `rangePageOffsets` from
  there. (2026-11-09)

- A shared base class for the three trust stores in `src/config/`
  (`SecretGrantsTrustStore`, `ExternalRootsTrustStore`, `WorkspaceSettingsTrustStore`).
  The remaining differences are deliberate: who normalizes paths, the mtime cache,
  listeners, and copy-before-mutate exist only where needed. None is a bug: every
  caller normalizes paths first, and the cached store copies before mutating. A
  composed helper would save about 10 lines; the shared file I/O already landed in
  pass 6. (2026-11-09)
