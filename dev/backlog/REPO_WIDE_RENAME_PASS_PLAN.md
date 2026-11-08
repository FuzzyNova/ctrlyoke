# Repo-Wide Rename Pass

**Status:** Not started. Candidates come from four read-only scans of `src/` on 2026-11-08
(webview components; webview hooks/store/utils; core/harness/orchestration; UI bridge, server,
CLI, utils and types). Reference counts are approximate. Re-grep each item before renaming it.

## Goal

Rename files and symbols whose names no longer describe what they do. Most are named after
their first consumer and are now shared, sit in a folder they outgrew, or use terminology the
project has since retired ("provider" for a harness, "prompt" for every step). Behaviour
doesn't change. Each batch is a mechanical, reviewable commit.

The two renames that started this:

- `components/shared/StepContextMenu.tsx` → `ContextMenu.tsx`. Every menu reuses it: terminal,
  output, commit history, workspace explorer/editor, workflow, reference chips, header and
  CodeMirror. Only the step menu actually belongs to steps.
- `components/editor/PropertiesDrawer.tsx` → `PromptPropertiesDrawer.tsx`. It is the per-step
  prompt drawer, and the new name separates it from `layout/WorkflowPropertiesPanel.tsx`.

## Ground rules

### Contracts never change

Rename **TypeScript identifiers and file paths only**. A rename must never touch a string that
is persisted, sent over the wire, or typed by a user. Each item below is marked where this
applies. The known traps:

| Keep exactly as is                                                                                          | Why                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PERSISTED_STORES.PROVIDER_USAGE = "provider-usage"`, `PROVIDER_USAGE_SCHEMA_VERSION`                       | Schema-versioned store (`PersistedSchemaGuard.ts`, `FormatMigrations.ts`)                                                   |
| `HARNESS_USAGE_ERROR_CODES` values (`provider-refresh-failed`, …)                                           | Can surface to users                                                                                                        |
| `StatusLineFormatProvider` **values** (`claude`, `antigravity`, `copilot`, `qwen`)                          | `statusLine.byHarness.<id>` setting keys, and the snapshot-file prefix read by `src/scripts/ctrlyoke-statusline-wrapper.js` |
| `COMPLETION_NOTIFICATION_*` / `NOTIFICATION_KINDS` **values**                                               | Wire payloads and web push                                                                                                  |
| `_runtime.finalStep.loopCount`, `loopIndex` in `CtrlYokeTypes.ts` / `IDashboardSink.ts`                     | Persisted run state and dashboard protocol                                                                                  |
| `TempFileManager` directory names and file prefixes, output-snapshot filename prefix and truncation markers | On-disk layout                                                                                                              |
| sessionStorage `ctrlyoke-panel-reconnect-retry-at`, `window.__ctrlyokePanelHandshake*`                      | Shared with the HTML bootstrap                                                                                              |
| zustand persist names (`ctrlyoke-ui-state`, `ctrlyoke-workspace-viewer-state`)                              | Persisted, and not derived from file names                                                                                  |
| `docs/guide/dashboard.md` `step-context-menu-900x588.png`                                                   | It really is a screenshot of the step menu                                                                                  |

Log prefixes (`[CopilotCliProvider]`, `[WorkflowCommandHandler]`, …) follow their class name.
The session log is not one of the contracts listed in `CLAUDE.md`, so renaming them is fine.
Mention it in the commit body so nobody is surprised when an old grep stops matching.

### Never a blind substring replace

`StepContextMenu` → `ContextMenu` is the cautionary example. `useStepContextMenu`,
`useFinalStepContextMenu`, `utils/stepContextMenuItems.ts` and `StepContextMenuRequest`
(`WorkflowStepRow.tsx`) are genuinely step-specific and **keep** their names. A substring
replace would break them. For each rename:

1. `git mv` the file, so history follows it.
2. Rename the symbols with the language server (`rename_symbol`) or a word-boundary codemod run
   from a script file, driven by an **explicit list of identifiers**, never a pattern.
3. Grep for what the language server can't see:
   - `vi.mock("<path>")` strings, e.g. three tests mock `@utils/stepClipboard` by path
   - barrels (`components/*/index.ts`, `hooks/index.ts`, `store/index.ts`, `utils/index.ts`)
   - `knip.json`, `describe(...)` titles, CSS class strings queried with `closest()` /
     `querySelector`
   - comments and docstrings
   - `scripts/*.mjs` (`dev-host.mjs`, `generate-testing-gaps.mjs`, `find-hardcoded-strings.mjs`)
4. Rename the matching test file to mirror the source file.
5. Update live docs: `.github/instructions/*.md`, `.github/copilot-instructions.md`,
   `dev/reference/**` and `dev/backlog/**`. **Leave history alone**: `dev/implemented/`,
   `dev/bugs/implemented/`, `dev/rejected/` and `dev/research/` are a record of past work.
6. If a file moves between folders that different instruction files cover, or an instruction
   file is renamed, update the `applyTo` globs and run `npm run generate-agent-files`. The
   routing table in `CLAUDE.md`/`AGENTS.md` is generated from them, so never hand-edit it.

### Verification per batch

`npm run typecheck`, `npm run lint`, `npm run knip`, then `npm test 2>&1 | tail -40`, reading
the `TEST SUMMARY:` block. If a batch touched docs or scripts, also run `npm run check:docs`.
Run `git diff --cached --stat` before committing, to make sure renames show as renames and no
unrelated staged moves ride along.

### Commits

One commit per batch, or per item for the big ones, as `refactor(<area>): …`. Commit on the
current branch. No `CHANGELOG.md` entry is needed, since nothing a user sees changes.

## Batches

Ordered by value and independence. Batches 1–3 are webview-only and low risk. Batches 4–6 reach
across layers and need the "contracts never change" table. Earlier batches don't block later
ones, except where noted.

### Batch 1: the two requested renames

**1a. `StepContextMenu` → `ContextMenu`** (`components/shared/StepContextMenu.tsx`)

- File: `ContextMenu.tsx`. Types: `StepContextMenuItem/Divider/Entry/State/Props` →
  `ContextMenuItem/Divider/Entry/State/Props`. Nothing named `ContextMenu*` exists yet, so there
  are no collisions.
- CSS class `step-context-menu` → `context-menu`. No stylesheet rule uses it. It is queried in
  `components/workflow/WorkflowStatus.tsx:758` (`closest(".cy-dropdown-popup, .step-context-menu")`)
  and asserted in `test/components/workflow/WorkflowStatus.test.tsx`. Change all three together.
- Importers (~25):
  - components: `Header`, `CodeMirrorEditor`, `WorkspaceFileEditor`
  - hooks: `useCommitHistory`, `useFinalStep`, `useOutput`, `useReferenceChip`, `useStep`,
    `useTerminal`, `useWorkflow`, `useWorkspaceEditor` and `useWorkspaceExplorer` (each
    `…ContextMenu`), plus `useWorkflowFileMenuItems`
  - utils: `editorEditMenuItems`, `referenceChipMenu`, `stepContextMenuItems`
  - tests: `CodeMirrorEditor.test.tsx`, `editorEditMenuItems.test.ts`
  - a comment in `TerminalControlBar.tsx:279`
- Test: `test/components/shared/StepContextMenu.test.tsx` → `ContextMenu.test.tsx`, including
  its `describe`.
- Also: `knip.json:38`, and `dev/reference/KEYBOARD_SHORTCUTS.md:213`.
- **Keep:** `useStepContextMenu`, `useFinalStepContextMenu`, `stepContextMenuItems.ts`,
  `StepContextMenuRequest`, and the `FuzzyRanking`/completions references, which match
  `useFinalStepContextMenu`.

**1b. `PropertiesDrawer` → `PromptPropertiesDrawer`** (`components/editor/PropertiesDrawer.tsx`)

- File, component, `PropertiesDrawerProps`, CSS class `properties-drawer` (unused by any
  selector).
- Code: `components/editor/index.ts`, `PromptEditor.tsx`. Comments in `FooterQuickPicker`,
  `HarnessDropdown`, `ScriptConditionEditor`, `permissionUtils`, `useDrawerTabOverrides`,
  `editorStore`, `dropdownNamespaces`, `editorAutoExpand`,
  `src/test/integration/{helpers/propertyRoundTrip.ts,promptPropertyRoundTrip.integration.test.ts}`.
- Tests: `test/components/editor/PropertiesDrawer.test.tsx` → `PromptPropertiesDrawer.test.tsx`
  (8 `describe` titles), plus strings in `test/integration/promptStepUiPersistRoundTrip.test.tsx`.
- uiStore state moves with it: `propertiesDrawerOpen`, `toggle/open/closePropertiesDrawer` →
  `promptPropertiesDrawerOpen`, `toggle/open/closePromptPropertiesDrawer`. **Safe:** it is not in
  `partialize` and `resetUi` clears it. Callers: `App.tsx`, `PromptEditor.tsx`, `editorStore.ts`,
  `uiStore.test.ts`, `PromptEditor.test.tsx`, `promptStepUiPersistRoundTrip.test.tsx`.
- Docs: `.github/instructions/webview-react-components.instructions.md:13`,
  `dev/backlog/{CUSTOM_TOOLTIPS,DROPDOWN_TOOLBAR_SEARCH_AND_BULK_HIDE,TEMPLATE_AUTHORING_MODE}_PLAN.md`.
  `TESTING_GAPS.md` is regenerated by `npm run test:coverage`.
- Same commit: drop the drawer-era internal names in `WorkflowPropertiesPanel.tsx`
  (`drawerRef`, `SETTINGS_DRAWER_BREAKPOINT`, around lines 142, 421 and 1652), so "drawer" means
  only the prompt drawer and "panel" only the workflow panel.

### Batch 2: "prompt" → "step" in the step-list and editor components

These components render every step, script steps included. Batch 1b's `PromptPropertiesDrawer`
stays correct: that drawer really is prompt-only (`editorStore.ts:811` closes it in script mode).

| Current                                        | Proposed                             | Evidence                                                                                                        |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `components/editor/PromptEditor.tsx`           | `StepEditor.tsx`                     | `isScriptMode` branch, ~170 "script" mentions, embeds `ScriptConditionEditor`                                   |
| `components/prompts/` folder                   | `components/steps/`                  | `WorkflowStep.tsx`: "Renders both AI prompt steps and script steps"                                             |
| `PromptChipRail`                               | `StepChipRail`                       | One chip per step, uses `isScriptWorkflowStep`                                                                  |
| `PromptCounter`                                | `StepCounter`                        | Counts all `steps`                                                                                              |
| `PromptStepDetails`                            | `StepDetailRows`                     | Rendered in both the script and the prompt branch. An interface named `StepDetails` already exists, so not that |
| `PromptOverride`                               | `StepOverrideChip`                   | Pairs with the existing `utils/stepOverrideChips.ts`                                                            |
| `components/prompts/WorkflowStep.tsx`          | `WorkflowStepItem.tsx` (file only)   | Exports `WorkflowStepItem`; the file name reads like the `WorkflowStep` data type                               |
| `hooks/usePromptStatus.ts` (`getPromptStatus`) | `useStepStatus.ts` / `getStepStatus` | Takes any `WorkflowStep`; siblings `useStepClickHandler` and `useContextPct` already say "step"                 |

The folder move touches `layout/WorkflowStepsPanel.tsx`, `layout/index.ts`,
`ctrlyoke-tools/WorkflowStatusView.tsx`, `hooks/useStepClickHandler.ts`,
`utils/stepOverrideChips.ts`, and moves `test/components/prompts/` → `test/components/steps/`.
`usePromptStatus` is named in `orchestration.instructions.md`. Keep `utils/prompt.ts`'s
`PromptStep` out of this batch, because it is a wider data-model name. Revisit it separately.

### Batch 3: misnamed or misplaced webview modules

Independent items. Group them into two or three commits by folder.

| Current                                                                                                           | Proposed                                                                                                      | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/workflow/WorkflowStatus.tsx`                                                                          | `WorkflowSwitcher.tsx`                                                                                        | ~1,950-line rename/switch split button, not a status display. Easily confused with `ctrlyoke-tools/WorkflowStatusView.tsx`. CSS class `workflow-status` is unused. Comments in `globals.css`, `constants.ts`, `WorkflowInstance.ts:3079`, `uiStore.ts`. Named in `webview-react-components.instructions.md:35`                                                                               |
| `utils/stepClipboard.ts`                                                                                          | split into `utils/clipboard.ts`, `utils/workflowStepSerialization.ts` and `utils/stepEnabledToggle.ts`        | `writeClipboardText`, `readClipboardText` and `isEditableClipboardTarget` are generic (used by terminal/output/workflow menus and `CopyButton`). The enable/disable builders aren't clipboard code. **`vi.mock("@utils/stepClipboard")` in `CodeMirrorEditor`, `AtomicReferenceChip` and `CopyButton` tests must follow the function they mock.** Split `stepClipboard.test.ts` the same way |
| `shared/DeleteConfirmModal.tsx` / `shared/DeleteConfirmationModal.tsx`                                            | `ConfirmDeleteOperationModal` / `WorkspaceFileDeleteConfirmModal` (or move the latter to `workspace-viewer/`) | Two different modals with near-identical names. The first is tied to the `confirmDeleteOperations` setting; the second is the workspace-file delete dialog. `dev/backlog/HIGHLIGHT_UI_CONTROL_PLAN.md` references the first                                                                                                                                                                  |
| `components/output/DiffView.tsx`                                                                                  | `components/diff/TextDiffView.tsx`                                                                            | Generic renderer used by `diff/DiffFileCard`, `FileOperationOutput` and `StepMutationViews`. Pairs with `diff/MediaDiffView.tsx`                                                                                                                                                                                                                                                             |
| `components/editor/HooksEditor.tsx`                                                                               | `components/shared/HooksEditor.tsx`                                                                           | Used by the prompt drawer, `WorkflowPropertiesPanel` and `DefaultsHooksPage`                                                                                                                                                                                                                                                                                                                 |
| `components/editor/StepColorQuickPicker.tsx`                                                                      | `StepColorSwatch.tsx` in `layout/`                                                                            | Not a `FooterQuickPicker`. It's an `<input type="color">` header control used only by `layout/EditorSection.tsx`                                                                                                                                                                                                                                                                             |
| `components/workflow/FileBrowserModal.tsx`, `workspace-viewer/fileBrowserShared.tsx`                              | move both to `components/shared/`                                                                             | Generic picker opened from settings, export, save, template and location dialogs                                                                                                                                                                                                                                                                                                             |
| `components/prompts/InOutputViewMarker.tsx`                                                                       | `InOutputView.tsx`                                                                                            | Exports `InOutputViewBar` and hooks; nothing is called a "Marker"                                                                                                                                                                                                                                                                                                                            |
| `components/output/SubagentSpawn.tsx`                                                                             | `SubagentSpawnOutput.tsx`                                                                                     | Matches its export and the folder's `*Output.tsx` pattern                                                                                                                                                                                                                                                                                                                                    |
| `SubmitCommitMessageBody` in `ctrlyoke-tools/StepMutationViews.tsx`                                               | own file `SubmitCommitMessageView.tsx`                                                                        | Not a step mutation                                                                                                                                                                                                                                                                                                                                                                          |
| `ToolDot` in `output/FileOperationOutput.tsx`                                                                     | own file `output/ToolDot.tsx`                                                                                 | Shared by `OutputRow`, `ToolCallOutput`, `AskUserQuestionOutput` and `ToolCallBlock` (the same first-consumer problem as `StepContextMenu`)                                                                                                                                                                                                                                                  |
| `hooks/useDrawerTabOverrides.ts`                                                                                  | `usePropertiesTabOverrides.ts`                                                                                | Easily confused with `useSettingsDrawerTabOverrides`. This one resolves workflow/prompt property inheritance for `PromptEditor` and `WorkflowPropertiesPanel`                                                                                                                                                                                                                                |
| `store/compatibilityStore.ts` (`useCompatibilityStore`)                                                           | `harnessCapabilityStore.ts` / `useHarnessCapabilityStore`                                                     | Holds only the capability snapshot. The diagnostics live in `useCompatibilityDiagnostics`. Not persisted                                                                                                                                                                                                                                                                                     |
| `store/useHarnessFileStore.ts`, `useLanguageServerStore.ts`, `useMcpManagerStore.ts`, `useSkillsRegistryStore.ts` | `harnessFileStore.ts` etc. (file names only)                                                                  | The other 19 stores use `xStore.ts` for the file and `useXStore` for the hook                                                                                                                                                                                                                                                                                                                |
| `store/requestQueue.ts`                                                                                           | `utils/requestQueue.ts`                                                                                       | 8 lines of FIFO helpers, not a store                                                                                                                                                                                                                                                                                                                                                         |
| `navigation/navHistoryStore.ts` / `browserHistoryStore.ts`                                                        | `routeHistoryStore.ts` / `browserHistoryCursorStore.ts`                                                       | Both are "history store" with `canGoBack`/`canGoForward`, but they track different things. Low priority                                                                                                                                                                                                                                                                                      |

### Batch 4: webview messaging module (own commit, larger)

- `hooks/useMessageHandler.ts` (~3,700 lines). 49 files import it, almost all only for the
  outbound `sendMessage`/`openFile`. Move those two to `messaging/sendMessage.ts`. Keep the
  inbound router as `messaging/inboundMessageRouter.ts`, exporting `useInboundMessageRouter`
  (called once from `App.tsx`). Delete `BootstrapApp.tsx`'s private copy of
  `captureAndSendThemeVars` in favour of the shared one.
- Move the non-hook modules out of `hooks/` into the same `messaging/` folder:
  `inboundMessageDispatcher.ts`, `panelHandshake.ts`, `panelInboundBuffer.ts`,
  `reconnectWatchdog.ts`, `terminalMessageHandlers.ts`. Move the `CLIENT_ID_ASSIGNED` handler
  out of `terminalMessageHandlers.ts`, because it is connection identity, not terminal.
- Add a `@messaging/*` alias in `tsconfig.json`, `vite.config.ts` and `vitest.config.ts`.
- Add `src/ui/webview-react/messaging/**` to `webview-react-hooks.instructions.md`'s `applyTo`
  (or give it its own section), then run `npm run generate-agent-files`. Seven instruction files
  name `useMessageHandler`.

### Batch 5: "provider" → harness terminology in harness code

The project rule: "harness" is for AI execution strategies, and "provider" is reserved for VS
Code API types. This is the largest batch. Split it into the commits below. **Rename symbols
only; see the contracts table for which strings stay.**

| Current                                                                                                                                                                                                                                                                                                                                          | Proposed                                                                    | Size / notes                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/interfaces/ICliProvider.ts`, `{claude,codex,copilot,opencode,qwen,antigravity}/*CliProvider.ts`, `HeadlessSourceModeProvider`                                                                                                                                                                                                            | `IHarnessAdapter`, `ClaudeHarnessAdapter`, …                                | ~33 + ~48 files. Tests `*CliProvider.test.ts`, `CliProviderArgumentCharacterization.test.ts`, `CliProviderPreparation.test.ts`. Comments in `scripts/dev-host.mjs:137` (`*CliProvider.ts` glob) and `scripts/generate-testing-gaps.mjs:48`                      |
| `shared/CliProviderUtils.ts`, `CliProviderWorkflowContext`, `CliProviderPreparation`                                                                                                                                                                                                                                                             | `HarnessAdapterUtils`, `HarnessAdapterWorkflowContext`, …                   | 24 files. `scripts/dev-host.mjs:35` references `CliProviderUtils.runVersionCommand`. Move the generic `RetryableAsyncCache` out of it into `src/utils/`                                                                                                         |
| `.github/instructions/harness-cli-providers.instructions.md`                                                                                                                                                                                                                                                                                     | `harness-adapters.instructions.md`                                          | Then run `npm run generate-agent-files`. The globs are folder-based and don't change                                                                                                                                                                            |
| `shared/usage/IHarnessUsageProvider`, `usage/providers/*UsageProvider`, `ObservedOnlyUsageProvider`, `createDefaultHarnessUsageProviders`                                                                                                                                                                                                        | `IHarnessQuotaCollector`, `usage/collectors/*QuotaCollector`, …             | The interface doc already says "quota collectors". **Keep `provider-usage` and the error-code strings**                                                                                                                                                         |
| `shared/HarnessFlagCompletionProvider.ts`                                                                                                                                                                                                                                                                                                        | `HarnessFlagHelpParser.ts`                                                  | No provider class; it parses `--help` and exports `getHarnessFlagCompletions()`. 3 importers plus its test                                                                                                                                                      |
| `src/utils/StatuslineFormat.ts` `STATUS_LINE_FORMAT_PROVIDERS` / `StatusLineFormatProvider`; `StatusLineTrackingControls.providerForHarness`, `STATUS_LINE_FORMAT_PROVIDER_BY_HARNESS`; the `provider` prop on `StatusLineFormatEditor`/`StatusLinePreview`; `StatuslineManager.providerForHarness`/`forProvider`; `WebviewSettingsSync.ts:1216` | `StatusLineFormatHarness`, a `harness` prop, `toStatusLineFormatHarness`, … | Consider folding into `STATUS_LINE_HARNESS_IDS` to drop the mapping table. **Keep the string values.** Leave `src/scripts/ctrlyoke-statusline-wrapper.js`'s `STATUSLINE_PROVIDERS` alone, or rename only its local variable (it is a separately shipped script) |
| `src/types/CliOutputTypes.ts` `ProviderModelUsage`                                                                                                                                                                                                                                                                                               | `HarnessModelUsage`                                                         | Type name only. The `modelUsage` field is unchanged                                                                                                                                                                                                             |

Leave `hasExplicitProviderQuotaDetails` (`harnessUsageDisplay.ts`) as it is. It refers to API
quota providers, which is correct.

### Batch 6: UI bridge, platform and core names

| Current                                                                               | Proposed                                                                                                              | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui/IDashboardProvider.ts`                                                        | `IDashboardRegistryEvents`, optionally moved to `src/types/`                                                          | Not a VS Code provider. A set of `notifyWorkflow*` calls plus `postMessage`. Its doc names classes that don't exist (`CtrlYokeServer`) or no longer depend on it. Named in `ui.instructions.md:13`                                                                                                                                                                                                                                   |
| `src/ui/WebviewMessageRouter.ts`, `WebviewSettingsSync.ts`, `WebviewClientContext.ts` | `DashboardMessageRouter`, `DashboardSettingsSync`, `DashboardClientContext`                                           | `DashboardApplication` builds them for both panel and hosted clients. Move `PostMessageFn` and `HarnessStatus` out of `WebviewSettingsSync.ts` (e.g. into `DashboardClientEndpoint.ts`). Named in `ui.instructions.md` and `copilot-instructions.md` (the `routeQueue` paragraph). **Do not** rename `WebviewMessageTypes.ts`: 216 files, an `applyTo` glob, `find-dead-methods.mjs`, and "webview" is the established protocol name |
| `src/ui/WebviewUserInteractionPort.ts`                                                | `DashboardUserInteractionPort`                                                                                        | One per client, hosted browsers included                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/ui/notifications/CompletionNotificationFactory.ts`                               | `NotificationEventFactory.ts`, moved to `src/core/notifications/`                                                     | Also builds hook and test notifications. `src/types/IDashboardSink.ts` imports it, so `types` depends on `ui/`. "Completion" clashes with `src/completions/`. Rename `COMPLETION_NOTIFICATION_SEVERITY`/`CompletionNotificationSeverity` → `NOTIFICATION_SEVERITY` (symbols only). Delete the `@deprecated CompletionNotificationEvent` alias (last user: `WebPushService.ts`)                                                       |
| `src/ui/WorkflowSerializer.ts`                                                        | `WorkflowLibraryHandlers.ts`                                                                                          | ~40 `handle*` handlers covering save/export, templates, browse dialogs, recents, favorites, history trash and run deletion. Named in `ui.instructions.md` and `test.instructions.md:96`                                                                                                                                                                                                                                              |
| `src/ui/OutputSnapshotService.ts`                                                     | `OutputCaptureAttachments.ts`                                                                                         | Two functions, not a service, and "snapshot" clashes with `WorkspaceSnapshotService`. Rename `TempFileManager.createOutputSnapshotFile` → `createOutputCaptureFile` with it. **Keep the filename prefix strings**                                                                                                                                                                                                                    |
| `src/platform/CliAdapter.ts`                                                          | `NodePlatformAdapter.ts`                                                                                              | Used by the hosted server (`NodeHostServices`) and by `CommitMessageGenerator.ts:509` inside the extension, so it isn't CLI-only. Matches its `Node*` siblings. Fix the stale `PlatformAdapter.ts:9` comment. Keep `ResolvedCliConfig`, which really is CLI-flag config. Named in `cli-binary` and `platform` instructions                                                                                                           |
| `src/cli/CliPrompt.ts` (`promptYesNo`)                                                | `CliConfirm.ts` (`confirmYesNo`)                                                                                      | Every other "prompt" in `src/cli` and core means an AI prompt. 3 importers                                                                                                                                                                                                                                                                                                                                                           |
| `src/utils/PropertyResolver.ts`                                                       | `SettingsPropertyResolver.ts`                                                                                         | Near-duplicate of `src/types/ExecutionPropertyResolver.ts`, which it wraps. Its "VS Code" doc is stale. 32 files. Named in `types.instructions.md`                                                                                                                                                                                                                                                                                   |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts`                                   | `HarnessSettingsJsonStore.ts`                                                                                         | Also stores arbitrary persistent values (`statusLine`) and manages `.gitignore` and the schema. Move `SettingsJsonPermissionPolicy/Decision`, which only OpenCode uses, into `opencode/`. Named in `harness-shared` and `harness-cli-providers` instructions                                                                                                                                                                         |
| `src/core/orchestration/WorkflowCommandHandler.ts`                                    | `DashboardNavigationCommands.ts`                                                                                      | Two methods (`openPanel`, `openCurrentPromptFile`); its header claims it "handles all user-facing commands". Lower confidence                                                                                                                                                                                                                                                                                                        |
| `src/utils/TempFileManager.ts`                                                        | Split out an `AttachmentStore` for the persistent `.ctrlyoke/attachments/` part, or rename to `WorkspaceScratchFiles` | Its doc says "only manages temp files", but it owns a store that persists. Named in `copilot-instructions.md:46`, `extension.instructions.md` and `utils.instructions.md`. **Keep the on-disk names.** Lower priority, and it would be a split rather than a rename                                                                                                                                                                  |

### Batch 7: folder moves that change which instruction file applies

Each one needs `applyTo`/routing updates and `npm run generate-agent-files`. Move the related
instruction-file paragraphs to the file that now covers them.

- `src/core/harness/shared/CodexHookUtils.ts` → `src/core/harness/codex/`. Only Codex uses it.
- `src/completions/ContextReferenceBuilder.ts` → `src/utils/`. It is the single source of
  reference syntax, imported by core, utils and the UI. Documented in `completions.instructions.md`.
- `src/completions/CtrlYokeFileKind.ts` → `src/utils/WorkflowFileKind.ts`. Core, utils, the
  server and a webview hook import it.
- `src/types/ToolPermissionUtils.ts` → `src/utils/`. It's pure logic with no webview importer,
  and `types.instructions.md` asks type modules to stay runtime-light. Leave the other logic in
  `src/types/` (`CompatibilityAnalyzer`, `PortabilityReport`, `PreviewRedactor`), because the
  webview does share it.

### Deletions found along the way (not renames)

Each is small enough to ride with the batch that touches the same area.

- `HarnessIntegration.wasLastFailureUserCancellation()` (`src/core/HarnessIntegration.ts:1407`)
  is a copilot-chat leftover. The base always returns `false` and nothing overrides it, so the
  branch at `WorkflowExecutor.ts:5585` is dead. Remove both, and fix the "Chat" comments at
  `HarnessIntegration.ts:876,1355,1359` and `WorkflowOrchestrator.ts:1995`. (Batch 5 or 6.)
- `ui/webview-react/utils/diff.ts` (`generateDiff`/`applyDiff`): only its barrel line and its
  own test use it, and the name collides with the real diff utilities. (Batch 3.)
- `extractCliOutputText` (deprecated alias, test-only) and `getCliTextForCopy` (one-line
  wrapper with one caller) in favour of `getStepAssistantTextForCopy`. (Batch 3.)
- `export const FileHistoryList = DiffFileHistoryList` (unused alias). (Batch 3.)
- Stale doc comments with no rename needed:
  - `src/types/IDashboardSink.ts` still says `CtrlYokeWebviewProvider` implements it.
  - `RunningWorkflowItem` still refers to the old "Running Workflows dropdown".

## Deferred or not doing

- **`src/types/DashboardConstants.ts` → `SharedConstants.ts`/`CtrlYokeConstants.ts`.** The
  name is misleading (~6,000 lines of repo-wide constants), but it is imported by ~1,200 files
  and 9 scripts, named in the `types-core` glob, 9 instruction files and `knip.json`. The payoff
  is small against that churn. If done, do it alone as one mechanical commit, with no other
  changes.
- **`HostedWorkspaceViewerService`.** It does more than view now, but "workspace viewer" is the
  feature name across `components/workspace-viewer/` and `HostedWorkspaceViewerTypes.ts`.
  Rename only as part of renaming the whole feature.
- **`WebviewMessageTypes.ts`**: see Batch 6.
- **`CliIntegration`, `CliLogMonitor`, `PtyProcessManager`, the `Cli*` helpers.** Every harness
  is a CLI, so "Cli" is accurate. These are also routing-table anchors.
- **`PromptFileParser`/`PromptFileLoader`.** "Prompt file" is still the documented term.
- **`useVsCodeApi`, `terminalRegistry`, `useFontSizeControls`/`useFontSizeSync`,
  `RunSummaryRow`/`RunSummaryBanner`, `ctrlyoke-tools/*View.tsx` exporting `*Body`,
  `DrawerRow`/`DrawerTabBar`, `WorkspaceViewerModal`.** These were checked, and the names hold.

## Open question: final-step "loop" names that mean one pass

`copilot-instructions.md` says internal `loopIndex`/`loopCount` names stay as they are, so
this plan leaves them alone. The scans did find webview-local names that aren't persisted or
part of the protocol and plainly mean a pass count:

- `workflowStore.finalStepLoopCount`
- the `setFinalStepStatus(…, loopCount, …)` parameter
- the `loopCount` prop on `FinalStepFooter`/`PromptChipRail`, which is treated as
  "passes 1..loopCount + 1"
- local `loopIndex` in `InOutputViewMarker.tsx` and `UndoChangesDialog.tsx`

`outputAnnouncements.ts` already stores the comparison in a variable named `samePass`.
Renaming them to `finalStepPassCount`/`completedPassCount` would be safe, but it goes against
the written convention. Decide whether the convention covers only the shared and persisted
names before including it. If yes, it fits in Batch 2.
