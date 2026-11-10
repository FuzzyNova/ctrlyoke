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

## Kept on purpose

- `utils/prompt.ts`'s `PromptStep` remains a wider data-model name; `PromptPropertiesDrawer` remains prompt-only.
- `useStepContextMenu`, `useFinalStepContextMenu`, `utils/stepContextMenuItems.ts`, and `StepContextMenuRequest` remain step-specific; the `FuzzyRanking` and completions matches for `useFinalStepContextMenu` stay unchanged.
- `useSettingsDrawerTabOverrides`, `DrawerRow`, and `DrawerTabBar` remain settings-drawer names; `drawerRef` in `GlobalSettingsDrawer.tsx` remains drawer-specific.
- Persisted and wire contracts: `PERSISTED_STORES.PROVIDER_USAGE = "provider-usage"`, `PROVIDER_USAGE_SCHEMA_VERSION`; `HARNESS_USAGE_ERROR_CODES` values (including `provider-refresh-failed`); `StatusLineFormatProvider` values (`claude`, `antigravity`, `copilot`, `qwen`); `COMPLETION_NOTIFICATION_*` / `NOTIFICATION_KINDS` values; `_runtime.finalStep.loopCount`, `OutputExecutionTarget.loopIndex`, and the `loop*` fields in `WebviewMessageTypes.ts` / `IDashboardSink.ts`.
- On-disk and browser contracts: `TempFileManager` directory names and file prefixes, output-snapshot filename prefix and truncation markers; sessionStorage `ctrlyoke-panel-reconnect-retry-at`, `window.__ctrlyokePanelHandshake*`; zustand persist names `ctrlyoke-ui-state` and `ctrlyoke-workspace-viewer-state`.
- `docs/guide/dashboard.md` screenshot name `step-context-menu-900x588.png` remains unchanged.
