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
