# Rename ledger

This ledger maps retired names to their current names. Historical implementation, bug, rejected, and research documents keep the names that were accurate when they were written.

| Old name | New name | Kind (file / symbol / CSS class / folder) | Batch | Date |
| --- | --- | --- | --- | --- |
| `src/ui/webview-react/components/shared/StepContextMenu.tsx` | `src/ui/webview-react/components/shared/ContextMenu.tsx` | file | 1a | 2026-11-09 |
| `src/ui/webview-react/test/components/shared/StepContextMenu.test.tsx` | `src/ui/webview-react/test/components/shared/ContextMenu.test.tsx` | file | 1a | 2026-11-09 |
| `StepContextMenu` | `ContextMenu` | symbol | 1a | 2026-11-09 |
| `StepContextMenuItem` | `ContextMenuItem` | symbol | 1a | 2026-11-09 |
| `StepContextMenuDivider` | `ContextMenuDivider` | symbol | 1a | 2026-11-09 |
| `StepContextMenuEntry` | `ContextMenuEntry` | symbol | 1a | 2026-11-09 |
| `StepContextMenuState` | `ContextMenuState` | symbol | 1a | 2026-11-09 |
| `StepContextMenuProps` | `ContextMenuProps` | symbol | 1a | 2026-11-09 |
| `step-context-menu` | `context-menu` | CSS class | 1a | 2026-11-09 |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx` | `src/ui/webview-react/components/editor/PromptPropertiesDrawer.tsx` | file | 1b | 2026-11-09 |
| `src/ui/webview-react/test/components/editor/PropertiesDrawer.test.tsx` | `src/ui/webview-react/test/components/editor/PromptPropertiesDrawer.test.tsx` | file | 1b | 2026-11-09 |
| `PropertiesDrawer` | `PromptPropertiesDrawer` | symbol | 1b | 2026-11-09 |
| `PropertiesDrawerProps` | `PromptPropertiesDrawerProps` | symbol | 1b | 2026-11-09 |
| `properties-drawer` | `prompt-properties-drawer` | CSS class | 1b | 2026-11-09 |
| `propertiesDrawerOpen` | `promptPropertiesDrawerOpen` | symbol | 1b | 2026-11-09 |
| `togglePropertiesDrawer` | `togglePromptPropertiesDrawer` | symbol | 1b | 2026-11-09 |
| `openPropertiesDrawer` | `openPromptPropertiesDrawer` | symbol | 1b | 2026-11-09 |
| `closePropertiesDrawer` | `closePromptPropertiesDrawer` | symbol | 1b | 2026-11-09 |
| `drawerRef` (`WorkflowPropertiesPanel`) | `panelRef` | symbol | 1b | 2026-11-09 |
| `SETTINGS_DRAWER_BREAKPOINT` (`WorkflowPropertiesPanel`) | `WORKFLOW_PANEL_BREAKPOINT` | symbol | 1b | 2026-11-09 |
| `RunFinalStepProjection.loopCount` | `RunFinalStepProjection.passCount` | symbol | 8 | 2026-11-09 |
| `RunFinalStepProjection.latestLoop` | `RunFinalStepProjection.latestPass` | symbol | 8 | 2026-11-09 |
| `finalLoopCount` (`src/cli.ts`) | `finalPassCount` | symbol | 8 | 2026-11-09 |
| `src/ui/webview-react/components/output/DiffView.tsx` | `src/ui/webview-react/components/diff/TextDiffView.tsx` | file | 3b | 2026-11-09 |
| `src/ui/webview-react/test/components/output/DiffView.test.tsx` | `src/ui/webview-react/test/components/diff/TextDiffView.test.tsx` | file | 3b | 2026-11-09 |
| `DiffView` | `TextDiffView` | symbol | 3b | 2026-11-09 |
| `src/ui/webview-react/components/output/SubagentSpawn.tsx` | `src/ui/webview-react/components/output/SubagentSpawnOutput.tsx` | file | 3b | 2026-11-09 |
| `src/ui/webview-react/test/components/output/SubagentSpawn.test.tsx` | `src/ui/webview-react/test/components/output/SubagentSpawnOutput.test.tsx` | file | 3b | 2026-11-09 |
| `src/ui/webview-react/components/output/ctrlyoke-tools/StepMutationViews.tsx` (`SubmitCommitMessageBody`) | `src/ui/webview-react/components/output/ctrlyoke-tools/SubmitCommitMessageView.tsx` | symbol | 3b | 2026-11-09 |
| `src/ui/webview-react/components/output/FileOperationOutput.tsx` (`ToolDot`) | `src/ui/webview-react/components/output/ToolDot.tsx` | symbol | 3b | 2026-11-09 |
| `src/ui/webview-react/components/steps/InOutputViewMarker.tsx` | `src/ui/webview-react/components/steps/InOutputView.tsx` | file | 3b | 2026-11-09 |
| `getCliTextForCopy` | removed; callers use `getStepAssistantTextForCopy` | symbol | 3b | 2026-11-09 |
| `src/ui/webview-react/utils/diff.ts` (`generateDiff`, `applyDiff`) | removed (unused) | file / symbols | 3b | 2026-11-09 |

| `src/ui/webview-react/components/prompts/` | `src/ui/webview-react/components/steps/` | folder | 2 | 2026-11-09 |
| `src/ui/webview-react/test/components/prompts/` | `src/ui/webview-react/test/components/steps/` | folder | 2 | 2026-11-09 |
| `src/ui/webview-react/components/editor/PromptEditor.tsx` | `src/ui/webview-react/components/editor/StepEditor.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/test/components/editor/PromptEditor.test.tsx` | `src/ui/webview-react/test/components/editor/StepEditor.test.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/components/prompts/PromptChipRail.tsx` | `src/ui/webview-react/components/steps/StepChipRail.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/test/components/prompts/PromptChipRail.test.tsx` | `src/ui/webview-react/test/components/steps/StepChipRail.test.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/components/prompts/PromptCounter.tsx` | `src/ui/webview-react/components/steps/StepCounter.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/components/prompts/PromptStepDetails.tsx` | `src/ui/webview-react/components/steps/StepDetailRows.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/test/components/prompts/PromptStepDetails.test.tsx` | `src/ui/webview-react/test/components/steps/StepDetailRows.test.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/components/prompts/WorkflowStep.tsx` | `src/ui/webview-react/components/steps/WorkflowStepItem.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/test/components/prompts/WorkflowStep.test.tsx` | `src/ui/webview-react/test/components/steps/WorkflowStepItem.test.tsx` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/hooks/usePromptStatus.ts` | `src/ui/webview-react/hooks/useStepStatus.ts` | file | 2 | 2026-11-09 |
| `src/ui/webview-react/test/hooks/usePromptStatus.test.ts` | `src/ui/webview-react/test/hooks/useStepStatus.test.ts` | file | 2 | 2026-11-09 |
| `PromptEditor` | `StepEditor` | symbol | 2 | 2026-11-09 |
| `PromptEditorProps` | `StepEditorProps` | symbol | 2 | 2026-11-09 |
| `PromptChipRail` | `StepChipRail` | symbol | 2 | 2026-11-09 |
| `PromptChipRailProps` | `StepChipRailProps` | symbol | 2 | 2026-11-09 |
| `PromptCounter` | `StepCounter` | symbol | 2 | 2026-11-09 |
| `PromptCounterProps` | `StepCounterProps` | symbol | 2 | 2026-11-09 |
| `PromptStepDetails` | `StepDetailRows` | symbol | 2 | 2026-11-09 |
| `PromptStepDetailsProps` | `StepDetailRowsProps` | symbol | 2 | 2026-11-09 |
| `PromptOverride` | `StepOverrideChip` | symbol | 2 | 2026-11-09 |
| `usePromptStatus` | `useStepStatus` | symbol | 2 | 2026-11-09 |
| `getPromptStatus` | `getStepStatus` | symbol | 2 | 2026-11-09 |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx` | `src/ui/webview-react/components/workflow/WorkflowSwitcher.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/test/components/workflow/WorkflowStatus.test.tsx` | `src/ui/webview-react/test/components/workflow/WorkflowSwitcher.test.tsx` | file | 3a | 2026-11-09 |
| `WorkflowStatus` | `WorkflowSwitcher` | symbol | 3a | 2026-11-09 |
| `WorkflowStatusProps` | `WorkflowSwitcherProps` | symbol | 3a | 2026-11-09 |
| `workflow-status` | removed (unused) | CSS class | 3a | 2026-11-09 |
| `src/ui/webview-react/components/shared/DeleteConfirmModal.tsx` | `src/ui/webview-react/components/shared/ConfirmDeleteOperationModal.tsx` | file | 3a | 2026-11-09 |
| `DeleteConfirmModal` | `ConfirmDeleteOperationModal` | symbol | 3a | 2026-11-09 |
| `DeleteConfirmModalProps` | `ConfirmDeleteOperationModalProps` | symbol | 3a | 2026-11-09 |
| `src/ui/webview-react/components/shared/DeleteConfirmationModal.tsx` | `src/ui/webview-react/components/shared/WorkspaceFileDeleteConfirmModal.tsx` | file | 3a | 2026-11-09 |
| `DeleteConfirmationModal` | `WorkspaceFileDeleteConfirmModal` | symbol | 3a | 2026-11-09 |
| `DeleteConfirmationModalProps` | `WorkspaceFileDeleteConfirmModalProps` | symbol | 3a | 2026-11-09 |
| `src/ui/webview-react/components/editor/HooksEditor.tsx` | `src/ui/webview-react/components/shared/HooksEditor.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/test/components/editor/HooksEditor.test.tsx` | `src/ui/webview-react/test/components/shared/HooksEditor.test.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/components/editor/StepColorQuickPicker.tsx` | `src/ui/webview-react/components/layout/StepColorSwatch.tsx` | file | 3a | 2026-11-09 |
| `StepColorQuickPicker` | `StepColorSwatch` | symbol | 3a | 2026-11-09 |
| `StepColorQuickPickerProps` | `StepColorSwatchProps` | symbol | 3a | 2026-11-09 |
| `src/ui/webview-react/components/workflow/FileBrowserModal.tsx` | `src/ui/webview-react/components/shared/FileBrowserModal.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/test/components/workflow/FileBrowserModal.test.tsx` | `src/ui/webview-react/test/components/shared/FileBrowserModal.test.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/components/workspace-viewer/fileBrowserShared.tsx` | `src/ui/webview-react/components/shared/fileBrowserShared.tsx` | file | 3a | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`readClipboardText`) | `src/ui/webview-react/utils/clipboard.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`writeClipboardText`) | `src/ui/webview-react/utils/clipboard.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`isEditableClipboardTarget`) | `src/ui/webview-react/utils/clipboard.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`WorkflowStepUpdateRequest`) | `src/ui/webview-react/utils/stepEnabledToggle.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`buildWorkflowStepEnabledUpdate`) | `src/ui/webview-react/utils/stepEnabledToggle.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`buildWorkflowStepEnabledState`) | `src/ui/webview-react/utils/stepEnabledToggle.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`isScriptWorkflowStep`) | `src/ui/webview-react/utils/workflowStepSerialization.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`getWorkflowStepRawText`) | `src/ui/webview-react/utils/workflowStepSerialization.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`serializeWorkflowStepText`) | `src/ui/webview-react/utils/workflowStepSerialization.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`parseWorkflowStepClipboardText`) | `src/ui/webview-react/utils/workflowStepSerialization.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/utils/stepClipboard.ts` (`readWorkflowStepFromClipboard`) | `src/ui/webview-react/utils/workflowStepSerialization.ts` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/hooks/useDrawerTabOverrides.ts` | `src/ui/webview-react/hooks/usePropertiesTabOverrides.ts` | file | 3c | 2026-11-09 |
| `useDrawerTabOverrides` | `usePropertiesTabOverrides` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/store/compatibilityStore.ts` | `src/ui/webview-react/store/harnessCapabilityStore.ts` | file | 3c | 2026-11-09 |
| `useCompatibilityStore` | `useHarnessCapabilityStore` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/store/useHarnessFileStore.ts` | `src/ui/webview-react/store/harnessFileStore.ts` | file | 3c | 2026-11-09 |
| `src/ui/webview-react/store/useLanguageServerStore.ts` | `src/ui/webview-react/store/languageServerStore.ts` | file | 3c | 2026-11-09 |
| `src/ui/webview-react/store/useMcpManagerStore.ts` | `src/ui/webview-react/store/mcpManagerStore.ts` | file | 3c | 2026-11-09 |
| `src/ui/webview-react/store/useSkillsRegistryStore.ts` | `src/ui/webview-react/store/skillsRegistryStore.ts` | file | 3c | 2026-11-09 |
| `src/ui/webview-react/store/requestQueue.ts` | `src/ui/webview-react/utils/requestQueue.ts` | file | 3c | 2026-11-09 |
| `src/ui/webview-react/navigation/navHistoryStore.ts` | `src/ui/webview-react/navigation/routeHistoryStore.ts` | file | 3c | 2026-11-09 |
| `useNavHistoryStore` | `useRouteHistoryStore` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/navigation/browserHistoryStore.ts` | `src/ui/webview-react/navigation/browserHistoryCursorStore.ts` | file | 3c | 2026-11-09 |
| `useBrowserHistoryStore` | `useBrowserHistoryCursorStore` | symbol | 3c | 2026-11-09 |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | `src/ui/webview-react/messaging/inboundMessageRouter.ts` | file | 4 | 2026-11-09 |
| `useMessageHandler` | `useInboundMessageRouter` | symbol | 4 | 2026-11-09 |
| `sendMessage` (`hooks/useMessageHandler.ts`) | `messaging/sendMessage.ts` | symbol | 4 | 2026-11-09 |
| `openFile` (`hooks/useMessageHandler.ts`) | `messaging/sendMessage.ts` | symbol | 4 | 2026-11-09 |
| `captureAndSendThemeVars` (`hooks/useMessageHandler.ts`) | `messaging/sendMessage.ts` | symbol | 4 | 2026-11-09 |
| `src/ui/webview-react/hooks/inboundMessageDispatcher.ts` | `src/ui/webview-react/messaging/inboundMessageDispatcher.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/hooks/panelHandshake.ts` | `src/ui/webview-react/messaging/panelHandshake.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/hooks/panelInboundBuffer.ts` | `src/ui/webview-react/messaging/panelInboundBuffer.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/hooks/reconnectWatchdog.ts` | `src/ui/webview-react/messaging/reconnectWatchdog.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/hooks/terminalMessageHandlers.ts` | `src/ui/webview-react/messaging/terminalMessageHandlers.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/test/hooks/useMessageHandler.test.ts` | `src/ui/webview-react/test/messaging/inboundMessageRouter.test.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/test/hooks/inboundMessageDispatcher.test.ts` | `src/ui/webview-react/test/messaging/inboundMessageDispatcher.test.ts` | file | 4 | 2026-11-09 |
| `src/ui/webview-react/test/hooks/panelHandshake.test.ts` | `src/ui/webview-react/test/messaging/panelHandshake.test.ts` | file | 4 | 2026-11-09 |


| `src/core/harness/shared/usage/IHarnessUsageProvider.ts` | `src/core/harness/shared/usage/IHarnessQuotaCollector.ts` | file | 5c | 2026-11-09 |
| `src/core/harness/shared/usage/providers/` | `src/core/harness/shared/usage/collectors/` | folder | 5c | 2026-11-09 |
| `src/core/harness/shared/usage/ObservedOnlyUsageProvider.ts` | `src/core/harness/shared/usage/ObservedOnlyQuotaCollector.ts` | file | 5c | 2026-11-09 |
| `src/test/unit/HarnessFlagCompletionProvider.test.ts` | `src/test/unit/HarnessFlagHelpParser.test.ts` | file | 5c | 2026-11-09 |
| `src/core/harness/shared/HarnessFlagCompletionProvider.ts` | `src/core/harness/shared/HarnessFlagHelpParser.ts` | file | 5c | 2026-11-09 |
| `IHarnessUsageProvider` | `IHarnessQuotaCollector` | symbol | 5c | 2026-11-09 |
| `*UsageProvider` (`usage/providers/`) | `*QuotaCollector` (`usage/collectors/`) | symbol | 5c | 2026-11-09 |
| `ObservedOnlyUsageProvider` | `ObservedOnlyQuotaCollector` | symbol | 5c | 2026-11-09 |
| `createDefaultHarnessUsageProviders` | `createDefaultHarnessQuotaCollectors` | symbol | 5c | 2026-11-09 |
| `StatusLineFormatProvider` | `StatusLineFormatHarness` | symbol | 5c | 2026-11-09 |
| `STATUS_LINE_FORMAT_PROVIDERS` | `STATUS_LINE_FORMAT_HARNESSES` | symbol | 5c | 2026-11-09 |
| `providerForHarness` (`StatusLineTrackingControls`) | `statusLineHarnessIdForHarness` | symbol | 5c | 2026-11-09 |
| `STATUS_LINE_FORMAT_PROVIDER_BY_HARNESS` | `STATUS_LINE_FORMAT_HARNESS_BY_ID` | symbol | 5c | 2026-11-09 |
| `StatuslineManager.providerForHarness` | `StatuslineManager.statusLineHarnessIdForHarness` | symbol | 5c | 2026-11-09 |
| `StatuslineManager.forProvider` | `StatuslineManager.forStatusLineHarness` | symbol | 5c | 2026-11-09 |
| `StatusLineFormatEditor.provider` / `StatusLinePreview.provider` | `harness` | symbol / prop | 5c | 2026-11-09 |
| `ProviderModelUsage` | `HarnessModelUsage` | symbol | 5c | 2026-11-09 |

## Kept on purpose

- `utils/prompt.ts`'s `PromptStep` remains a wider data-model name; `PromptPropertiesDrawer` remains prompt-only.
- `useStepContextMenu`, `useFinalStepContextMenu`, `utils/stepContextMenuItems.ts`, and `StepContextMenuRequest` remain step-specific; the `FuzzyRanking` and completions matches for `useFinalStepContextMenu` stay unchanged.
- `useSettingsDrawerTabOverrides`, `DrawerRow`, and `DrawerTabBar` remain settings-drawer names; `drawerRef` in `GlobalSettingsDrawer.tsx` remains drawer-specific.
- `src/ui/webview-react/components/output/ctrlyoke-tools/WorkflowStatusView.tsx` and its tool-view symbols remain tool-status names; they are separate from the workflow header switcher.
- `MESSAGE_TYPES.CLIENT_ID_ASSIGNED` and `MESSAGE_TYPES.CAPTURE_THEME_VARS` remain wire-message names; only their webview handler/helper locations changed. `useRunViewLoadWatchdog` remains a hook in `hooks/`.
- Persisted and wire contracts: `PERSISTED_STORES.PROVIDER_USAGE = "provider-usage"`, `PROVIDER_USAGE_SCHEMA_VERSION`; `HARNESS_USAGE_ERROR_CODES` values (including `provider-refresh-failed`); `StatusLineFormatHarness` values (`claude`, `antigravity`, `copilot`, `qwen`); `COMPLETION_NOTIFICATION_*` / `NOTIFICATION_KINDS` values; `_runtime.finalStep.loopCount`, `OutputExecutionTarget.loopIndex`, and the `loop*` fields in `WebviewMessageTypes.ts` / `IDashboardSink.ts`.
- Notification wire values (`COMPLETION_NOTIFICATION_*` and `NOTIFICATION_KINDS`) and output-capture filename prefixes/truncation markers remain unchanged; only their TypeScript identifiers and source locations moved.
- On-disk and browser contracts: `TempFileManager` directory names and file prefixes, output-snapshot filename prefix and truncation markers; sessionStorage `ctrlyoke-panel-reconnect-retry-at`, `window.__ctrlyokePanelHandshake*`; zustand persist names `ctrlyoke-ui-state` and `ctrlyoke-workspace-viewer-state`.
- `docs/guide/dashboard.md` screenshot name `step-context-menu-900x588.png` remains unchanged.
| `src/core/harness/shared/interfaces/ICliProvider.ts` | `src/core/harness/shared/interfaces/IHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/claude/ClaudeCliProvider.ts` | `src/core/harness/claude/ClaudeHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/codex/CodexCliProvider.ts` | `src/core/harness/codex/CodexHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/copilot/CopilotCliProvider.ts` | `src/core/harness/copilot/CopilotHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/opencode/OpenCodeCliProvider.ts` | `src/core/harness/opencode/OpenCodeHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/qwen/QwenCliProvider.ts` | `src/core/harness/qwen/QwenHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/core/harness/antigravity/AntigravityCliProvider.ts` | `src/core/harness/antigravity/AntigravityHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/ClaudeCliProvider.test.ts` | `src/test/unit/ClaudeHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/CodexCliProvider.test.ts` | `src/test/unit/CodexHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/CopilotCliProvider.test.ts` | `src/test/unit/CopilotHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/OpenCodeCliProvider.test.ts` | `src/test/unit/OpenCodeHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/QwenCliProvider.test.ts` | `src/test/unit/QwenHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/AntigravityCliProvider.test.ts` | `src/test/unit/AntigravityHarnessAdapter.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/CliProviderArgumentCharacterization.test.ts` | `src/test/unit/HarnessAdapterArgumentCharacterization.test.ts` | file | 5a | 2026-11-09 |
| `src/test/unit/CliProviderPreparation.test.ts` | `src/test/unit/HarnessAdapterPreparation.test.ts` | file | 5a | 2026-11-09 |
| `.github/instructions/harness-cli-providers.instructions.md` | `.github/instructions/harness-adapters.instructions.md` | file | 5a | 2026-11-09 |
| `ICliProvider` | `IHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `ClaudeCliProvider` | `ClaudeHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `CodexCliProvider` | `CodexHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `CopilotCliProvider` | `CopilotHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `OpenCodeCliProvider` | `OpenCodeHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `QwenCliProvider` | `QwenHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `AntigravityCliProvider` | `AntigravityHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `HeadlessSourceModeProvider` | `HeadlessSourceModeAdapter` | symbol | 5a | 2026-11-09 |
| `src/test/helpers/posixClaudeProvider.ts` | `src/test/helpers/posixClaudeHarnessAdapter.ts` | file | 5a | 2026-11-09 |
| `PosixClaudeCliProvider` | `PosixClaudeHarnessAdapter` | symbol | 5a | 2026-11-09 |
| `src/core/harness/shared/CliProviderUtils.ts` | `src/core/harness/shared/HarnessAdapterUtils.ts` | file | 5b | 2026-11-09 |
| `src/test/unit/CliProviderUtils.test.ts` | `src/test/unit/HarnessAdapterUtils.test.ts` | file | 5b | 2026-11-09 |
| `CliProviderUtils` | `HarnessAdapterUtils` | symbol | 5b | 2026-11-09 |
| `CliProviderWorkflowContext` | `HarnessAdapterWorkflowContext` | symbol | 5b | 2026-11-09 |
| `CliProviderPreparation` | `HarnessAdapterPreparation` | symbol | 5b | 2026-11-09 |
| `RetryableAsyncCache` (`src/core/harness/shared/CliProviderUtils.ts`) | `src/utils/RetryableAsyncCache.ts` | symbol / module | 5b | 2026-11-09 |
| `src/ui/IDashboardProvider.ts` | `src/types/IDashboardRegistryEvents.ts` | file | 6a | 2026-11-09 |
| `IDashboardProvider` | `IDashboardRegistryEvents` | symbol | 6a | 2026-11-09 |
| `src/ui/WebviewMessageRouter.ts` | `src/ui/DashboardMessageRouter.ts` | file | 6a | 2026-11-09 |
| `src/ui/WebviewSettingsSync.ts` | `src/ui/DashboardSettingsSync.ts` | file | 6a | 2026-11-09 |
| `src/ui/WebviewClientContext.ts` | `src/ui/DashboardClientContext.ts` | file | 6a | 2026-11-09 |
| `WebviewMessageRouter` | `DashboardMessageRouter` | symbol | 6a | 2026-11-09 |
| `WebviewSettingsSync` | `DashboardSettingsSync` | symbol | 6a | 2026-11-09 |
| `WebviewSettingsSyncHost` | `DashboardSettingsSyncHost` | symbol | 6a | 2026-11-09 |
| `WebviewClientContext` | `DashboardClientContext` | symbol | 6a | 2026-11-09 |
| `createWebviewClientContext` | `createDashboardClientContext` | symbol | 6a | 2026-11-09 |
| `PostMessageFn`, `HarnessStatus` (`DashboardSettingsSync.ts`) | `DashboardClientEndpoint.ts` | symbol / type | 6a | 2026-11-09 |
| `src/ui/WebviewUserInteractionPort.ts` | `src/ui/DashboardUserInteractionPort.ts` | file | 6a | 2026-11-09 |
| `WebviewUserInteractionPort` | `DashboardUserInteractionPort` | symbol | 6a | 2026-11-09 |
| `src/ui/notifications/CompletionNotificationFactory.ts` | `src/core/notifications/NotificationEventFactory.ts` | file | 6a | 2026-11-09 |
| `src/test/unit/CompletionNotificationFactory.test.ts` | `src/test/unit/NotificationEventFactory.test.ts` | file | 6a | 2026-11-09 |
| `COMPLETION_NOTIFICATION_SEVERITY` | `NOTIFICATION_SEVERITY` | symbol | 6a | 2026-11-09 |
| `CompletionNotificationSeverity` | `NotificationSeverity` | symbol | 6a | 2026-11-09 |
| `CompletionNotificationEvent` | removed; callers use `CtrlYokeNotificationEvent` | symbol | 6a | 2026-11-09 |
| `src/ui/WorkflowSerializer.ts` | `src/ui/WorkflowLibraryHandlers.ts` | file | 6a | 2026-11-09 |
| `src/test/unit/WorkflowSerializer.test.ts` | `src/test/unit/WorkflowLibraryHandlers.test.ts` | file | 6a | 2026-11-09 |
| `WorkflowSerializer` | `WorkflowLibraryHandlers` | symbol | 6a | 2026-11-09 |
| `src/ui/OutputSnapshotService.ts` | `src/ui/OutputCaptureAttachments.ts` | file | 6a | 2026-11-09 |
| `src/test/unit/OutputSnapshotService.test.ts` | `src/test/unit/OutputCaptureAttachments.test.ts` | file | 6a | 2026-11-09 |
| `OutputSnapshotService` | `OutputCaptureAttachments` | symbol | 6a | 2026-11-09 |
| `writeOutputSnapshotAttachment` | `writeOutputCaptureAttachment` | symbol | 6a | 2026-11-09 |
| `savePendingOutputSnapshot` | `savePendingOutputCapture` | symbol | 6a | 2026-11-09 |
| `TempFileManager.createOutputSnapshotFile` | `TempFileManager.createOutputCaptureFile` | symbol | 6a | 2026-11-09 |
| `src/platform/CliAdapter.ts` | `src/platform/NodePlatformAdapter.ts` | file | 6b | 2026-11-09 |
| `CliAdapter` | `NodePlatformAdapter` | symbol | 6b | 2026-11-09 |
| `src/cli/CliPrompt.ts` | `src/cli/CliConfirm.ts` | file | 6b | 2026-11-09 |
| `promptYesNo` | `confirmYesNo` | symbol | 6b | 2026-11-09 |
| `src/utils/PropertyResolver.ts` | `src/utils/SettingsPropertyResolver.ts` | file | 6b | 2026-11-09 |
| `src/test/unit/PropertyResolver.test.ts` | `src/test/unit/SettingsPropertyResolver.test.ts` | file | 6b | 2026-11-09 |
| `PropertyResolver` | `SettingsPropertyResolver` | symbol | 6b | 2026-11-09 |
| `PropertyResolverOptions` | `SettingsPropertyResolverOptions` | symbol | 6b | 2026-11-09 |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts` | `src/core/harness/shared/HarnessSettingsJsonStore.ts` | file | 6b | 2026-11-09 |
| `src/test/unit/SettingsJsonMcpTracker.test.ts` | `src/test/unit/HarnessSettingsJsonStore.test.ts` | file | 6b | 2026-11-09 |
| `SettingsJsonMcpTracker` | `HarnessSettingsJsonStore` | symbol | 6b | 2026-11-09 |
| `SettingsJsonMcpTrackerOptions` | `HarnessSettingsJsonStoreOptions` | symbol | 6b | 2026-11-09 |
| `SettingsJsonMcpRegisterOptions` | `HarnessSettingsJsonRegisterOptions` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueKey` | `HarnessSettingsPersistentValueKey` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueCaptureResult` | `HarnessSettingsPersistentValueCaptureResult` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueCapture` | `HarnessSettingsPersistentValueCapture` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueUninstall` | `HarnessSettingsPersistentValueUninstall` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueInstallResult` | `HarnessSettingsPersistentValueInstallResult` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPersistentValueMatcher` | `HarnessSettingsPersistentValueMatcher` | symbol | 6b | 2026-11-09 |
| `SETTINGS_JSON_INSTALL_KIND_WRITTEN` | `HARNESS_SETTINGS_INSTALL_KIND_WRITTEN` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPermissionDecision` | `OpenCodePermissionDecision` | symbol | 6b | 2026-11-09 |
| `SettingsJsonPermissionPolicy` | `OpenCodePermissionPolicy` | symbol | 6b | 2026-11-09 |
| `src/core/orchestration/WorkflowCommandHandler.ts` | `src/core/orchestration/DashboardNavigationCommands.ts` | file | 6b | 2026-11-09 |
| `src/test/unit/WorkflowCommandHandler.test.ts` | `src/test/unit/DashboardNavigationCommands.test.ts` | file | 6b | 2026-11-09 |
| `WorkflowCommandHandler` | `DashboardNavigationCommands` | symbol | 6b | 2026-11-09 |
| `HarnessIntegration.wasLastFailureUserCancellation` | removed (dead branch; no overrides) | symbol | 6b | 2026-11-09 |
| `src/core/harness/shared/CodexHookUtils.ts` | `src/core/harness/codex/CodexHookUtils.ts` | file | 7 | 2026-11-09 |
| `src/completions/ContextReferenceBuilder.ts` | `src/utils/ContextReferenceBuilder.ts` | file | 7 | 2026-11-09 |
| `src/completions/CtrlYokeFileKind.ts` | `src/utils/WorkflowFileKind.ts` | file | 7 | 2026-11-09 |
| `src/test/unit/CtrlYokeFileKind.test.ts` | `src/test/unit/WorkflowFileKind.test.ts` | file | 7 | 2026-11-09 |
| `CtrlYokeFileKind` | `WorkflowFileKind` | symbol | 7 | 2026-11-09 |
| `src/types/ToolPermissionUtils.ts` | `src/utils/ToolPermissionUtils.ts` | file | 7 | 2026-11-09 |

## Kept on purpose

- `ResolvedCliConfig` remains CLI configuration despite its adapter moving to `NodePlatformAdapter`.
- `ExecutionPropertyResolver` remains the platform-neutral types-layer resolver; only its settings adapter is now `SettingsPropertyResolver`.
- `getCtrlYokeFileKind`, `getCtrlYokeFileGlobs`, and the `CTRLYOKE_FILE_KINDS` values keep their names and values; only the `CtrlYokeFileKind` type is now `WorkflowFileKind`.
- `ToolPermissionUtils` has no webview import; its shared runtime helpers remain under `src/utils/`.
