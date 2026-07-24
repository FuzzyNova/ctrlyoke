---
applyTo: "src/ui/webview-react/store/**"
---

<purpose>
Stores are split by ownership, not by screen. Extend the store that owns the data source instead of creating mirrored state in multiple stores.
</purpose>

<ownership>
- `workflowStore` owns execution state, live output, history snapshots, retry state, context-window stats, and undo metadata. Streaming updates should land here, not in component-local state.
- `uiStore` owns persisted view preferences and transient modal/navigation state. It uses `persist` + `vsCodeRawStorage`, so stored shapes must stay JSON-serializable.
- `editorStore` owns draft editing state. New-step drafts are persisted through `vscode.getState()`, while edits to existing steps live in workflow-local `pendingEdits` keyed by `queue:index` or `finalStep`.
- `settingsStore` keeps both raw global settings and workflow overrides. Effective-value helpers are the canonical inheritance path.
- `terminalStore` tracks session metadata only; xterm instances, DOM, and replay buffers stay outside Zustand in `terminalRegistry.ts`.
- `workspaceViewerStore` persists modal state and file drafts. Its file keys are normalized workspace-relative forward-slash paths so navigation from output/search/diff reuses the same cache entries.
</ownership>

<gotchas>
- `workflowStore.syncIncomingWorkflowProperties()` keeps workflow-property undo snapshots in sync. Skipping it makes workflow undo/redo incomplete.
- `historyOutputs` is a separate historical snapshot; continuation runs may promote old history back into `liveOrderedEntries`, so do not collapse those concepts into one array.
- `runtimeUndoGeneration` exists for undoable actions that only change runtime metadata. Bump it instead of mutating unrelated state just to force a zundo snapshot.
- Prefer defined store actions over raw `setState`, except for the few centralized bootstrap/reset flows that intentionally touch multiple slices at once.
- `uiStore` holds two different views of "the executing run's state", and only one of them is live. `runSummaries` (with `executionRunRef`) is a **snapshot frozen at the last `RUN_VIEW_LOADED`** — nothing refreshes it as a run moves running → pausing → paused, so a run seeded and started in one gesture leaves its summary reading `idle` for the run's entire life (`markExecutionRunFinished` only patches it on terminal states). `loadedWorkflows` is the **live** mirror of every active workflow, kept current by `WORKFLOW_ADDED` / `WORKFLOW_SUMMARY_UPDATED` / `WORKFLOW_DISMISSED`. Read live execution state from `loadedWorkflows` and treat the snapshot as a fallback only; reading it the other way round is what once made the header show "Nothing is executing" (disabled Pause/Stop, no Resume) while a run was genuinely paused, and suppressed the pausing banner outright. `getWorkflowExecutionControls` now additionally ignores any non-active `executionRunState` as a backstop.
- Snapshot-apply actions (`loadWorkflow`, `loadHistoryRun`, `hydrateLiveRunHistory`) run incoming data through `preserveReferences` (`utils/structuralSharing.ts`) so a replayed-but-unchanged snapshot keeps existing object identities — this is what keeps the output pane's memo chain (`useOutputRowsModel` → `buildOutputRows` → row memos) from redrawing unchanged rows. Two rules keep it working: don't pre-clear state an action will immediately replace (the `RUN_VIEW_LOADED` handler passes `skipHistoryOutputsClear` for exactly this), and only pass `loadWorkflow`'s `preserveLiveOutput` for a same-address, same-definition-revision, non-rollback replay — anything else must clear runtime state.
</gotchas>
