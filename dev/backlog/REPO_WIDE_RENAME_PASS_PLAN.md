# Repo-Wide Rename Pass

**Status:** Not started. Candidates come from four read-only scans of `src/` on 2026-11-08
(webview components; webview hooks/store/utils; core/harness/orchestration; UI bridge, server,
CLI, utils and types). Reference counts are approximate. Re-grep each item before renaming it.

## Progress

Staged 2026-11-09 as one workflow step per chunk below, run in this order. Each step ticks its
own box in the commit that lands it, and adds its ledger rows to `dev/reference/RENAMES.md`.

- [x] 1a `StepContextMenu` → `ContextMenu`, and create the ledger plus its `copilot-instructions.md` line
- [x] 1b `PropertiesDrawer` → `PromptPropertiesDrawer`, uiStore state, `WorkflowPropertiesPanel` panel names
- [ ] 8 Final-step pass-count names
- [ ] 2 "prompt" → "step" in the step-list and editor components (`components/prompts/` → `components/steps/`)
- [ ] 3a Component moves: `WorkflowSwitcher`, delete modals, `FileBrowserModal`, `HooksEditor`, `StepColorSwatch`
- [ ] 3b Output/diff components: `TextDiffView`, `SubagentSpawnOutput`, `SubmitCommitMessageView`, `ToolDot`, `InOutputView`, plus the Batch 3 deletions
- [ ] 3c Utils, hooks and stores: `stepClipboard` split, `usePropertiesTabOverrides`, store renames, `requestQueue`, history stores
- [ ] 4 Webview `messaging/` module
- [ ] 5a `ICliProvider`/`*CliProvider` → `IHarnessAdapter`/`*HarnessAdapter`, and the instruction file rename
- [ ] 5b `CliProviderUtils`/`CliProviderWorkflowContext`/`CliProviderPreparation`, and `RetryableAsyncCache` → `src/utils/`
- [ ] 5c Quota collectors, `HarnessFlagHelpParser`, status-line format harness names, `HarnessModelUsage`
- [ ] 6a UI bridge: `IDashboardRegistryEvents`, `Dashboard*` router/sync/context/port, `NotificationEventFactory`, `WorkflowLibraryHandlers`, `OutputCaptureAttachments`
- [ ] 6b Platform and core: `NodePlatformAdapter`, `CliConfirm`, `SettingsPropertyResolver`, `HarnessSettingsJsonStore`, `DashboardNavigationCommands`, `wasLastFailureUserCancellation` removal
- [ ] 7 Folder moves that change which instruction file applies

Paths in Batches 3–8 are written against the tree before this pass. Where an earlier batch has
already moved a file (Batch 2 moves `components/prompts/` to `components/steps/`), look the new
path up in the ledger.

### Procedure for each staged step

Each step runs in a fresh session, after the earlier steps have committed.

1. Read this whole plan, then your chunk's section. Run `git log --oneline -20` and read
   `dev/reference/RENAMES.md` (once it exists) to see what has landed. Check the code you build
   on rather than trusting the line numbers here. Re-grep every item before renaming it.
2. Read the instruction file for every area you touch (routing table in `CLAUDE.md`).
3. Follow "Ground rules" below exactly: `git mv`, an explicit identifier list (never a pattern),
   contract strings untouched, the grep checklist, live docs updated in place, history docs left
   alone, and ledger rows (plus "kept on purpose" entries) in the same commit. Write any codemod as
   a script file in your scratch directory and run it with `node`. Never pass code through a shell
   string (see `fileEditing` in `.github/copilot-instructions.md`).
4. Do only your chunk. If you find something wrong in a later chunk's section, correct that
   section of this plan rather than doing the work yourself.
5. Run the gate in the **foreground**: `npm run typecheck`, `npm run lint`, `npm run knip`,
   `npm run check:docs` if you touched docs or scripts, then
   `npm test > .ctrlyoke/logs/rename-pass-test.log 2>&1` and read its `TEST SUMMARY:` block
   (`tail -40`). Steps run headless, and every process a step started dies when its turn ends, so
   never background a command and end the turn to "check later". Raise the tool timeout as far as
   it goes. If the suite could outlive it, start it writing to the log and poll in a foreground
   loop in the same turn (`until grep -q 'TEST SUMMARY:' <log>; do sleep 30; done`). Don't re-run
   the whole suite just to check whether it passed. Fix every failure your rename caused. If a
   failure is plainly unrelated and was already failing before you started, record it under
   "Known unrelated failures" at the end of this plan.
6. Tick your box under Progress. Stage explicit paths (no `git add -A`), check
   `git diff --cached --stat` to make sure moves show as renames, and commit with a plain
   `refactor(<area>): …` conventional message with no trailers. If any log prefix changed, mention
   it in the body. Leave the working tree clean.

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

| Keep exactly as is                                                                                                                      | Why                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PERSISTED_STORES.PROVIDER_USAGE = "provider-usage"`, `PROVIDER_USAGE_SCHEMA_VERSION`                                                   | Schema-versioned store (`PersistedSchemaGuard.ts`, `FormatMigrations.ts`)                                                   |
| `HARNESS_USAGE_ERROR_CODES` values (`provider-refresh-failed`, …)                                                                       | Can surface to users                                                                                                        |
| `StatusLineFormatProvider` **values** (`claude`, `antigravity`, `copilot`, `qwen`)                                                      | `statusLine.byHarness.<id>` setting keys, and the snapshot-file prefix read by `src/scripts/ctrlyoke-statusline-wrapper.js` |
| `COMPLETION_NOTIFICATION_*` / `NOTIFICATION_KINDS` **values**                                                                           | Wire payloads and web push                                                                                                  |
| `_runtime.finalStep.loopCount`, `OutputExecutionTarget.loopIndex`, the `loop*` fields in `WebviewMessageTypes.ts` / `IDashboardSink.ts` | Run files, every final-step `events.jsonl` event, and the dashboard protocol (see Batch 8)                                  |
| `TempFileManager` directory names and file prefixes, output-snapshot filename prefix and truncation markers                             | On-disk layout                                                                                                              |
| sessionStorage `ctrlyoke-panel-reconnect-retry-at`, `window.__ctrlyokePanelHandshake*`                                                  | Shared with the HTML bootstrap                                                                                              |
| zustand persist names (`ctrlyoke-ui-state`, `ctrlyoke-workspace-viewer-state`)                                                          | Persisted, and not derived from file names                                                                                  |
| `docs/guide/dashboard.md` `step-context-menu-900x588.png`                                                                               | It really is a screenshot of the step menu                                                                                  |

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
   `dev/reference/**`, `dev/active/**` and `dev/backlog/**`. **Leave history alone**:
   `dev/implemented/`, `dev/bugs/implemented/`, `dev/rejected/` and `dev/research/` are a
   record of past work. Add a row to `dev/reference/RENAMES.md` instead, in the same commit
   (see "Historical dev docs" below). Item 1 in that section says what each row needs.
6. If a file moves between folders that different instruction files cover, or an instruction
   file is renamed, update the `applyTo` globs and run `npm run generate-agent-files`. The
   routing table in `CLAUDE.md`/`AGENTS.md` is generated from them, so never hand-edit it.

### Historical dev docs: a rename ledger instead of rewriting them

**Problem:** `dev/implemented/` (296 docs), `dev/bugs/implemented/` (813), `dev/rejected/` and
`dev/research/` use names that this pass retires: 383 of those docs mention at least one. Someone reading an old design doc greps for
`WorkflowSerializer` and finds nothing. The scale is real. By file count, `CliProvider` appears
in 71 implemented plans and 61 fixed bugs, `PromptEditor` in 54 and 28, `useMessageHandler` in
48 and 23, and `WorkflowSerializer` in 40 and 9.

**Decision: don't find-and-replace history. Keep a ledger that makes the old names
searchable.** Rewriting those docs would damage the thing they exist for:

- **They'd contradict their own citations.** Fixed-bug docs give a commit hash, and plans
  describe a specific tree. After a rewrite, a doc says `ContextMenu.tsx` while
  `git show <hash>` shows `StepContextMenu.tsx`. Then the doc matches neither the code at the
  time nor the code today.
- **Some old statements only made sense under the old name.** For example, "`StepContextMenu`
  is only used by the step list" was true when it was written. After a replace it reads
  "`ContextMenu` is only used by the step list", which was never true. Batch 1 renames
  `StepContextMenu` _because_ that's no longer true. A replace can't tell a reference from a
  claim.
- **It's the substring trap again, at a larger scale and with no compiler.** Prose, code
  fences and quoted log lines (`[CopilotCliProvider] …`) have no type checker. A mistaken
  `useStepContextMenu` → `useContextMenu` in a doc fails silently.
- **It's churn with no review signal.** Hundreds of history docs would change, burying each
  batch's real diff, and every future rename would have to repeat it.

The ledger fixes the actual problem, which is that an old name leads nowhere:

1. **Create `dev/reference/RENAMES.md`** in the first rename commit, whichever batch lands
   first. Each later batch appends its own rows in the same commit as the rename. The table has
   one row per old name: `| Old name | New name | Kind (file / symbol / CSS class / folder) | Batch | Date |`.
   There is no commit column, because a commit can't contain its own hash. The commit that
   added a row is the rename commit, so
   `git log -S'<old name>' -- dev/reference/RENAMES.md` finds it. Write file paths in full (`src/ui/webview-react/components/shared/StepContextMenu.tsx`), so
   a grep for either the bare file name or the path finds the row. Record splits (Batch 3's
   `stepClipboard.ts` → three files) as one row per moved symbol. Add a short "kept on
   purpose" list for names that look renamed but aren't (`useStepContextMenu`,
   `StepContextMenuRequest`, the contract strings), so nobody "finishes" the rename later.
2. **Then a grep for any old name lands on the ledger**, and the ledger gives the new name.
   `git log --follow` on the new path recovers the file's history, because every
   move is a `git mv` (ground rule 1).
3. **Add one line to the `knowledgeCapture` (or `orientation`) section of
   `.github/copilot-instructions.md`**: names in `dev/implemented/`, `dev/bugs/implemented/`,
   `dev/rejected/` and `dev/research/` are as of when each doc was written, and you look up
   renamed ones in `dev/reference/RENAMES.md`. It's the same idea as the existing
   `copilot-chat` note. This is a durable fact that the code can't tell you, so it meets the
   bar for instruction files. Add it in the same commit that creates the ledger.

Live docs still get updated in place (ground rule 5): `dev/backlog/**`, `dev/active/**`,
`dev/reference/**` (except the ledger's "Old name" column), and the instruction files.

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
across layers and need the "contracts never change" table. Batch 7 moves folders, and Batch 8
is a small core/CLI naming fix. Earlier batches don't block later ones, except where noted.

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

**1b. `PropertiesDrawer` → `PromptPropertiesDrawer`** (`components/editor/PromptPropertiesDrawer.tsx`)

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

| Current                                                                               | Proposed                                                                    | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui/IDashboardProvider.ts`                                                        | `IDashboardRegistryEvents`, optionally moved to `src/types/`                | Not a VS Code provider. A set of `notifyWorkflow*` calls plus `postMessage`. Its doc names classes that don't exist (`CtrlYokeServer`) or no longer depend on it. Named in `ui.instructions.md:13`                                                                                                                                                                                                                                   |
| `src/ui/WebviewMessageRouter.ts`, `WebviewSettingsSync.ts`, `WebviewClientContext.ts` | `DashboardMessageRouter`, `DashboardSettingsSync`, `DashboardClientContext` | `DashboardApplication` builds them for both panel and hosted clients. Move `PostMessageFn` and `HarnessStatus` out of `WebviewSettingsSync.ts` (e.g. into `DashboardClientEndpoint.ts`). Named in `ui.instructions.md` and `copilot-instructions.md` (the `routeQueue` paragraph). **Do not** rename `WebviewMessageTypes.ts`: 216 files, an `applyTo` glob, `find-dead-methods.mjs`, and "webview" is the established protocol name |
| `src/ui/WebviewUserInteractionPort.ts`                                                | `DashboardUserInteractionPort`                                              | One per client, hosted browsers included                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/ui/notifications/CompletionNotificationFactory.ts`                               | `NotificationEventFactory.ts`, moved to `src/core/notifications/`           | Also builds hook and test notifications. `src/types/IDashboardSink.ts` imports it, so `types` depends on `ui/`. "Completion" clashes with `src/completions/`. Rename `COMPLETION_NOTIFICATION_SEVERITY`/`CompletionNotificationSeverity` → `NOTIFICATION_SEVERITY` (symbols only). Delete the `@deprecated CompletionNotificationEvent` alias (last user: `WebPushService.ts`)                                                       |
| `src/ui/WorkflowSerializer.ts`                                                        | `WorkflowLibraryHandlers.ts`                                                | ~40 `handle*` handlers covering save/export, templates, browse dialogs, recents, favorites, history trash and run deletion. Named in `ui.instructions.md` and `test.instructions.md:96`                                                                                                                                                                                                                                              |
| `src/ui/OutputSnapshotService.ts`                                                     | `OutputCaptureAttachments.ts`                                               | Two functions, not a service, and "snapshot" clashes with `WorkspaceSnapshotService`. Rename `TempFileManager.createOutputSnapshotFile` → `createOutputCaptureFile` with it. **Keep the filename prefix strings**                                                                                                                                                                                                                    |
| `src/platform/CliAdapter.ts`                                                          | `NodePlatformAdapter.ts`                                                    | Used by the hosted server (`NodeHostServices`) and by `CommitMessageGenerator.ts:509` inside the extension, so it isn't CLI-only. Matches its `Node*` siblings. Fix the stale `PlatformAdapter.ts:9` comment. Keep `ResolvedCliConfig`, which really is CLI-flag config. Named in `cli-binary` and `platform` instructions                                                                                                           |
| `src/cli/CliPrompt.ts` (`promptYesNo`)                                                | `CliConfirm.ts` (`confirmYesNo`)                                            | Every other "prompt" in `src/cli` and core means an AI prompt. 3 importers                                                                                                                                                                                                                                                                                                                                                           |
| `src/utils/PropertyResolver.ts`                                                       | `SettingsPropertyResolver.ts`                                               | Near-duplicate of `src/types/ExecutionPropertyResolver.ts`, which it wraps. Its "VS Code" doc is stale. 32 files. Named in `types.instructions.md`                                                                                                                                                                                                                                                                                   |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts`                                   | `HarnessSettingsJsonStore.ts`                                               | Also stores arbitrary persistent values (`statusLine`) and manages `.gitignore` and the schema. Move `SettingsJsonPermissionPolicy/Decision`, which only OpenCode uses, into `opencode/`. Named in `harness-shared` and `harness-cli-providers` instructions                                                                                                                                                                         |
| `src/core/orchestration/WorkflowCommandHandler.ts`                                    | `DashboardNavigationCommands.ts`                                            | Two methods (`openPanel`, `openCurrentPromptFile`); its header claims it "handles all user-facing commands". Lower confidence                                                                                                                                                                                                                                                                                                        |

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

### Batch 8: final-step "loop" and "pass" names

**Decision (2026-11-09): don't rename the `loop*` contract names. Fix the few names that
hold the wrong kind of number.** One small commit. It doesn't depend on the other batches.
Some of the files it names are renamed by Batches 2 and 3 (`PromptChipRail`,
`InOutputViewMarker.tsx`). If those batches land first, look up the new names in the ledger.

#### Why the contract names stay

There are ~500 `loopIndex`/`loopCount` references. Most of them carry one value from disk or
the wire through to its consumer:

- `_runtime.finalStep.loopCount` is persisted in every run file and documented publicly in
  `docs/reference/run-files.md` ("pass N is loopCount N-1"), which is generated from the
  schema.
- `OutputExecutionTarget.loopIndex` (`CtrlYokeTypes.ts:932`) is the `target` of every final-step
  event in `events.jsonl`.
- The dashboard protocol carries both: `FinalStep*Message` in `WebviewMessageTypes.ts` and
  `IDashboardSink`.

Renaming any of these means a schema bump plus a migration of every timeline file, and users
get nothing for it. The webview mirrors (`workflowStore.finalStepLoopCount`, the
`setFinalStepStatus` parameter, the `loopCount` prop on `FinalStepFooter`/`PromptChipRail`)
should keep the contract's name too. A grep for `loopCount` then follows the value from the
run file all the way to the badge. A different name partway along would break that grep at
the boundary.

The originally proposed `finalStepPassCount` would also be **wrong**. `_runtime.finalStep.loopCount`
is a 0-based **index**, not a count. `FinalStepFooter` renders `formatFinalPassBadge(loopCount + 1)`.
So the real hazard isn't "loop" versus "pass". It's whether a variable holds an index, a
1-based number, or a count.

#### The convention: the name says what kind of number it holds

| Holds                                   | Name                                                                | Already used by                                            |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0-based pass index (the contract value) | `loopIndex`, and `loopCount` where the contract field has that name | run files, timeline, protocol, webview mirrors             |
| 1-based pass number                     | `passNumber`                                                        | `FinalStepLabels.ts`, `CliStepSelector.ts`                 |
| How many passes ran                     | `passCount`                                                         | `CliJsonResultBuilder.ts:410`, `InOutputViewMarker.tsx:38` |

Never introduce a new `loopCount` that holds a count, or a `passIndex` that holds the index.
In final-step code, use a qualified name (`passNumber`, `finalPass…`) and never a bare `pass`,
because end conditions already use "pass" for validation passing (`onPass`, `passRetryPrompt`).

The local `loopIndex` variables in `InOutputViewMarker.tsx` and `UndoChangesDialog.tsx` hold
indexes, so they're already correct. Leave them alone.

#### What the commit changes

1. **`RunFinalStepProjection.loopCount` → `passCount`** (`core/orchestration/RunOutputResolver.ts:171`,
   the accumulator at `:1506`/`:1518`, the write at `:889`/`:925`). This field is a **count**
   (`max(loopIndex + 1)`) that uses the contract's index name, which is the one real trap.
   `CliJsonResultBuilder.ts:411` already reads it into a variable called `passCount`. The type
   is internal: the CLI JSON envelope exposes `pass`/`passes[]`, never this field. Re-grep for
   other readers. Consider `latestLoop` → `latestPass` in the same interface.
2. **`cli.ts:2105` `finalLoopCount` → `finalPassCount`.** It is a count (used as an
   `Array.from` length).
3. **Single-source the index→count conversion.** `cli.ts:2105` and
   `CliJsonResultBuilder.ts:410` each compute `phase === FINAL_STEP ? loopCount + 1 : loopCount`
   inline. Extract it as one helper beside the final-step runtime type, e.g.
   `getFinalStepPassCount(runtime)`. Don't put it in `FinalStepLabels.ts`, which must stay
   dependency-free. Re-grep for further copies.
4. **Update the convention in `.github/copilot-instructions.md`** (the Terminology bullet). Keep
   "internal `loopIndex`/`loopCount` names stay as they are", then add the index/number/count
   rule above in one sentence, so the next scan doesn't propose this rename again.
5. **Add the ledger rows** for items 1 and 2.

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

- **`src/utils/TempFileManager.ts`** (moved out of Batch 6 when the pass was staged). Its doc
  says "only manages temp files", but it owns the persistent `.ctrlyoke/attachments/` store.
  The fix is to split out an `AttachmentStore`, which is a design change rather than a rename,
  so it doesn't belong in a mechanical pass. Batch 6a still renames
  `createOutputSnapshotFile` → `createOutputCaptureFile`. If the split is done later, keep the
  on-disk names. Named in `copilot-instructions.md`, `extension.instructions.md` and
  `utils.instructions.md`.

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
