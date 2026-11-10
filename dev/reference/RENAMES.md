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

## Kept on purpose

- `useStepContextMenu`, `useFinalStepContextMenu`, `utils/stepContextMenuItems.ts`, and `StepContextMenuRequest` remain step-specific; the `FuzzyRanking` and completions matches for `useFinalStepContextMenu` stay unchanged.
- Persisted and wire contracts: `PERSISTED_STORES.PROVIDER_USAGE = "provider-usage"`, `PROVIDER_USAGE_SCHEMA_VERSION`; `HARNESS_USAGE_ERROR_CODES` values (including `provider-refresh-failed`); `StatusLineFormatProvider` values (`claude`, `antigravity`, `copilot`, `qwen`); `COMPLETION_NOTIFICATION_*` / `NOTIFICATION_KINDS` values; `_runtime.finalStep.loopCount`, `OutputExecutionTarget.loopIndex`, and the `loop*` fields in `WebviewMessageTypes.ts` / `IDashboardSink.ts`.
- On-disk and browser contracts: `TempFileManager` directory names and file prefixes, output-snapshot filename prefix and truncation markers; sessionStorage `ctrlyoke-panel-reconnect-retry-at`, `window.__ctrlyokePanelHandshake*`; zustand persist names `ctrlyoke-ui-state` and `ctrlyoke-workspace-viewer-state`.
- `docs/guide/dashboard.md` screenshot name `step-context-menu-900x588.png` remains unchanged.
