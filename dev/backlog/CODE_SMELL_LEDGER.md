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
  form. Fixed directly: merge-outcome literals in `WorktreeManager`/`WebviewMessageRouter`
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

## Deferred

- `src/ui/webview-react/hooks/usePaged{CommitHistory,FileHistory,GitRefDiff,WorkspaceDirectory}.ts`
  — the four hooks re-implement the same page cache / abort / in-flight / expiry state
  machine around per-hook `responseIsUsable` checks. Collapsing them into one generic
  `usePagedListing` hook is a design change; only their identical leaf helpers were
  queued in pass 2.
- Ask-user-question parsing in all six providers (`antigravity/AntigravityToolEventBuilder.ts`
  `parseQuestions`/`parseOptions`, `qwen/QwenLogParser.ts` `parseAskUserQuestionEntries`,
  `copilot/CopilotToolBuilder.ts` `parseQuestionEntries`/`parseChoice(s)`,
  `claude/ClaudeToolBuilder.ts`, `codex/CodexToolBuilder.ts`
  `parseRequestUserInputQuestions`, `opencode/OpenCodeEventMapper.ts`
  `parseOpenCodeQuestions`) — same output shape, but each harness has its own field
  aliases, string-option formats and preview heuristics; a shared parser needs a design
  for per-harness alias tables rather than a mechanical merge.
- `validateAndGetModel` in five `*CliProvider.ts` files — same skeleton, but the "none"
  sentinel, registry-not-loaded handling and validation strictness differ per harness on
  purpose or by accident; needs a decision on the intended rule before merging.
- Run-history/project-state bootstrap in `src/cli.ts` (`runCommand`),
  `src/mcp-server.ts` (`initializeMcpStorage`), `src/extension.ts` and
  `src/cli/CliWorkspaceBootstrap.ts` — drifted (MCP reads the location from
  `CTRLYOKE_RUN_HISTORY_LOCATION` instead of settings; `CliWorkspaceBootstrap` never logs
  the state-home warning). Unifying changes where MCP reads its storage location, which
  needs a decision on whether the env handoff is intentional.
- Internal `CTRLYOKE_*` env-var names (`CTRLYOKE_PROMPT_INDEX`, `CTRLYOKE_EXECUTION_ROOT`,
  `CTRLYOKE_WORKSPACE`, ...) written by `CliExecutionRunner.ts`, `CliMcpConfigGenerator.ts`,
  `CommitMessageGenerator.ts`, `CliProviderUtils.ts` and read in `mcp-server.ts` as raw
  names; `CTRLYOKE_ENV_VARS` has only three keys. Needs a sweep that separates documented
  script-facing variables (a user contract) from internal parent→child plumbing and from
  standalone `src/scripts/` that cannot import.

- Dashboard message payloads (`WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`,
  `WORKFLOW_SUMMARY_UPDATED`, `COORDINATION_SCOPE_UPDATED`, `CLI_WATCH_OUTPUT`,
  `STEPS_EXTENDED`) built separately in `src/server/CtrlYokeHostedServer.ts`,
  `src/ui/CtrlYokeWebviewProvider.ts` and `src/ui/DashboardApplication.ts`, plus the
  harness snapshot publish in `CtrlYokeHostedServer` vs `src/ui/WebviewSettingsSync.ts`
  (delta vs full map, missing-registry guard) — comments say `PostMessageDashboardSink`
  owns these shapes; moving them there changes the `IDashboardSink` surface every
  client implements, so it needs a design pass.
- Duration formats in the dashboard: `formatClockDuration` (`ui/webview-react/utils/time.ts`)
  is documented as the one format, but Copy Metadata (`stepMetadataClipboard.ts`,
  `7.4s`), Markdown export (`markdownExport.ts`, raw float), `ScriptVerdict.tsx`
  (`130.6s`) and `outputRowTiming.ts` (`1m 30s`) each use their own, with tests pinning
  them — choosing one changes user-visible and exported text, so it needs a decision.
- Access-token checks in `src/server/CtrlYokeHostedServer.ts`: `requestHasValidToken`
  accepts the `x-ctrlyoke-token` header or `?token=`, the WebSocket upgrade and
  connection handlers only `?token=` (the latter closes with 4401) — auth surface;
  unifying needs a decision on which forms WebSocket clients may use.

- CLI error reporting in `src/cli.ts` (`handleHistoryCommand`, `handleStepCommand`,
  `handleSecretCommand`, ~20 inline `console.error(...); process.exit(2)` sites) vs
  `handleCliError` in `src/cli/CliExitCode.ts` — drifted (only the secret path redacts,
  only history handles closed pipes, step emits its own JSON error); stderr text, JSON
  error shape and exit codes are a scripting contract, and `parseTimeoutSeconds`/
  `parseScriptTimeoutSeconds` accepting `1e3`/`0x10` is flag validation — needs a
  decision on the intended surface first.
- Git invoked outside `execGit`: `GitCommitter.ts` (own spawn, no timeout),
  `GitUtils.commitAll` (5-minute mutation timeout, contradicting the `GIT_NO_TIMEOUT`
  comment that commits run hooks), `HostedWorkspaceViewerService` commit path,
  `CommitMessageGenerator`'s raw `execFileAsync` with its own 100 MB buffer, three
  repo-toplevel lookups — unifying needs a timeout/buffer policy decision.
- The three trust stores in `src/config/` (`SecretGrantsTrustStore`,
  `ExternalRootsTrustStore`, `WorkspaceSettingsTrustStore`) — same load/set/save
  skeleton, but canonicalization, caching, listeners and copy-before-mutate differ; a
  shared base class is a design change (pass 6 only queued their shared file I/O).
- Prompt completion trigger detection in `src/completions/PromptCompletionProvider.ts`
  vs `src/ui/webview-react/utils/promptCompletion/promptCompletionResult.ts` — drifted
  (`#`/`~` query validation, slash-token rules, escaped-quote `@` paths exist on only one
  side); the webview bundle can't import the VS Code completion module, so sharing it
  needs a pure module both bundles accept and a decision on the intended rules.

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
- `extractSessionIdFromStdout` in the six `*CliProvider.ts` files — each is a few lines
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
