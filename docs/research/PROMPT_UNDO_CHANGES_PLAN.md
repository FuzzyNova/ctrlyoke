# Prompt Undo Changes Plan

## Overview

Add an "Undo changes for this prompt" button to each completed prompt's output block in the dashboard. The button captures file-system state before and after each prompt runs (using git), stores the snapshot in the history file, and allows one-click reversal of all file changes made during that prompt's execution.

---

## Core Design Decisions

### Snapshot Strategy

The approach captures the workspace diff **before** each prompt runs and again **after** it completes. The difference between those two snapshots identifies exactly which files changed during the prompt. This is stored in the existing `StepOutput` structure in the history file.

**Why not `git stash`?** Stashing is disruptive (it removes working-tree changes from view) and requires pop/apply logic that can fail on conflicts. Diff-based snapshots are non-destructive and entirely safe.

**Why not just store all file contents?** Storing full file contents for every file in the repo is too expensive. Instead, the plan stores only the minimal data needed to undo changes for files that actually changed during the prompt.

### Undo Data Per Changed File

| Change Type | What Happened | Undo Action |
|---|---|---|
| `created` | New file created during prompt | Delete the file |
| `modified` | Tracked file was changed | Restore previous content |
| `deleted` | Tracked file was deleted | Recreate with previous content |

For `modified` files whose pre-prompt state was **already at HEAD** (no prior modifications), undo simply runs `git restore <file>` — no content storage needed.

For `modified` or `deleted` files that had **pre-existing modifications** before the prompt (i.e., they were already dirty at HEAD), the before-state content must be stored in the snapshot so it can be restored exactly.

For **new untracked** files (`created`), just delete them on undo.

### Size Limits

- Files exceeding **512 KB** are excluded from before-content capture. Their entries still appear in `changedFiles` with a `contentCaptureSkipped: true` flag. The undo button is shown with a tooltip warning when any changed file was skipped.
- Binary files (detected by null-byte presence in the first 8 KB) are skipped from content capture the same way.

---

## Data Model Changes

### `src/types/OutputHistoryTypes.ts`

Add `gitSnapshot` to `StepOutput` and define new interfaces:

```typescript
export interface StepOutput {
  cliOutputs: CliOutput[];
  statusMessages: StatusMessage[];
  /** Git-based snapshot for prompt undo. Undefined if git is unavailable or snapshot failed. */
  gitSnapshot?: PromptGitSnapshot;
}

/**
 * Workspace file-change snapshot for a single prompt execution.
 * Captures what changed during the prompt so changes can be undone.
 */
export interface PromptGitSnapshot {
  /** Timestamp when the snapshot was finalized (after prompt completed) */
  capturedAt: number;
  /** False if workspace is not a git repo (undo unavailable) */
  isGitRepo: boolean;
  /** Files changed during this prompt */
  changedFiles: PromptFileChange[];
}

export type PromptChangeType = 'created' | 'modified' | 'deleted';

export interface PromptFileChange {
  /** Workspace-relative POSIX path (forward slashes, no leading slash) */
  path: string;
  changeType: PromptChangeType;
  /**
   * Content to restore for undo of 'modified' or 'deleted' files.
   * UTF-8 string. Undefined if the file was at HEAD before the prompt
   * (undo uses `git restore` instead) or if content capture was skipped.
   */
  contentToRestore?: string;
  /**
   * True if this file's before-content was skipped due to size/binary limits.
   * Undo is unavailable for this specific file.
   */
  contentCaptureSkipped?: boolean;
  /**
   * True if the file was tracked (committed) at the point before the prompt.
   * If false and changeType is 'created', undo = delete. If false and 'modified',
   * it was already a dirty-but-not-committed file before, so contentToRestore is required.
   */
  wasAtHead?: boolean;
}
```

---

## New Backend Service

### `src/utils/GitSnapshotService.ts`

A focused utility with four responsibilities:

```
GitSnapshotService
  captureWorkspaceState(workspacePath): Promise<RawWorkspaceState>
  computeChanges(before, after): PromptFileChange[]
  undoChanges(changes, workspacePath): Promise<UndoResult>
  isGitRepo(workspacePath): Promise<boolean>
```

**`RawWorkspaceState`** (internal type, not stored):
```typescript
interface RawWorkspaceState {
  /** Map of workspace-relative path → file status and content-at-capture */
  files: Map<string, {
    gitStatus: 'M' | 'A' | 'D' | '?' | '!!';  // git --porcelain codes
    contentHash: string;       // SHA-256 of content (for change detection)
    content?: string;          // Only stored for modified/dirty files under size limit
    isAtHead: boolean;         // true if gitStatus is clean/not in porcelain output
  }>;
  capturedAt: number;
}
```

**`captureWorkspaceState` implementation**:
1. Run `git status --porcelain -u` — lists all modified, staged, untracked, and ignored-but-relevant files
2. For each file in the porcelain output:
   - Record its status code
   - If modified/added/untracked and under size limit: read content into memory
3. Return `RawWorkspaceState`

**`computeChanges` implementation**:
1. Compare `after.files` against `before.files`
2. A file changed if: it appears in `after` but not `before`, OR its status/contentHash changed
3. For each changed file: determine `changeType` and whether `contentToRestore` is needed
4. Return `PromptFileChange[]`

**`undoChanges` implementation**:
1. Validate each path is within workspace root (security check)
2. For `created` (new untracked): delete the file using `fs.unlink`
3. For `modified` where `wasAtHead`:
   - Run `git restore <file>` via `child_process.execFile` (NOT `exec` with shell)
4. For `modified` where `contentToRestore` is set:
   - Write `contentToRestore` back to the file using `fs.writeFile`
5. For `deleted`:
   - Write `contentToRestore` back to the file using `fs.writeFile`
6. Return `{ succeeded: string[], failed: Array<{path, error}> }`

**Security**: All file paths are validated against the workspace root before any operation. The service uses `child_process.execFile` (not `exec`) for git commands, with explicit argument arrays. No shell interpolation.

---

## Integration Points

### Snapshot Capture in Execution

**Where to hook in**: `WorkflowExecutor.ts` already controls the per-prompt execution loop. The snapshot capture wraps each prompt execution:

```
Before prompt N:
  beforeState = GitSnapshotService.captureWorkspaceState(workspacePath)

[Prompt N runs]

After prompt N completes:
  afterState = GitSnapshotService.captureWorkspaceState(workspacePath)
  changes = GitSnapshotService.computeChanges(beforeState, afterState)
  snapshot = { capturedAt: Date.now(), isGitRepo: true, changedFiles: changes }
```

The snapshot is then passed to `OutputHistoryManager.saveStepOutput()` alongside `cliOutputs` and `statusMessages`.

**`OutputHistoryManager.saveStepOutput`** — add `gitSnapshot?: PromptGitSnapshot` parameter and persist it into the `StepOutput`.

If git is unavailable (not a repo, git not installed): capture fails gracefully. `gitSnapshot` is stored as `{ capturedAt, isGitRepo: false, changedFiles: [] }` — the undo button is not shown.

If snapshot capture throws: log a warning, set `gitSnapshot` to undefined, continue normally (undo is just unavailable for that step).

---

## Message Protocol

### `src/types/DashboardConstants.ts`

Add to `MESSAGE_TYPES`:
```typescript
UNDO_PROMPT_CHANGES: "undoPromptChanges",
UNDO_PROMPT_RESULT: "undoPromptResult",
```

### `src/types/WebviewMessageTypes.ts`

```typescript
/** Sent from webview → extension when user clicks "Undo changes" */
export interface UndoPromptChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_CHANGES;
  data: {
    stepIndex: number;
    attemptIndex: number;
    changes: PromptFileChange[];
  };
}

/** Sent from extension → webview after undo completes */
export interface UndoPromptResultMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_RESULT;
  data: {
    stepIndex: number;
    attemptIndex: number;
    success: boolean;
    /** Files successfully restored */
    restoredFiles: string[];
    /** Files that could not be restored */
    failedFiles: Array<{ path: string; error: string }>;
  };
}
```

### `FlightPathWebviewProvider.ts`

Add a message handler for `MESSAGE_TYPES.UNDO_PROMPT_CHANGES`:
1. Call `GitSnapshotService.undoChanges(message.data.changes, workspaceFolderPath)`
2. Send `UNDO_PROMPT_RESULT` back with the result
3. Show a VS Code information/error notification summarizing what was restored

---

## Frontend Changes

### `CliOutput.tsx`

The button is rendered inside `renderStats()` (or just after it), as a new inline item in the stats bar.

**Show the button only when**:
- `!output.isStreaming` (prompt is done)
- `output.gitSnapshot?.isGitRepo === true`
- `output.gitSnapshot.changedFiles.length > 0`

**Button states**:
- Default: "↩ Undo changes" (small, secondary style, matching existing icon-btn pattern)
- Loading: spinner + "Undoing..." (disabled)
- Success: "✓ Undone" (briefly shown, then revert to default or hide)
- Error: "✗ Undo failed" with tooltip listing failed files

**Skipped files warning**: If any `changedFiles` entry has `contentCaptureSkipped: true`, the button tooltip notes: "Some large files cannot be undone."

**Code location**: Extend `renderStats()` in `CliOutput.tsx` to include the undo button as an additional `parts.push(...)` entry when the conditions are met.

**Handler**:
```typescript
const handleUndo = useCallback(() => {
  setUndoState('loading');
  sendMessage(MESSAGE_TYPES.UNDO_PROMPT_CHANGES, {
    stepIndex,
    attemptIndex,
    changes: output.gitSnapshot!.changedFiles,
  });
}, [output.gitSnapshot, stepIndex, attemptIndex]);
```

**`UNDO_PROMPT_RESULT` response**: handled in `useMessageHandler.ts` to update per-step undo state. Undo state (`idle | loading | success | error`) lives in local component state on `CliOutput` (no store needed — it's ephemeral UI).

### No New Store State Needed

Undo state is transient UI state (loading spinner while waiting for extension response). It can live as `useState` in `CliOutput.tsx`. The `UNDO_PROMPT_RESULT` message needs to target the correct `CliOutput` instance — match on `stepIndex + attemptIndex`.

To route the response to the correct component, `useMessageHandler.ts` emits a custom event via a simple event emitter pattern or the existing message routing, and each `CliOutput` subscribes using `useEffect`.

Alternatively: add an `undoResults: Record<string, UndoResult>` map to `workflowStore` keyed by `"step-attempt"` — simpler to implement with existing patterns.

### History View Compatibility

The undo button works in history-viewing mode too. When viewing an old run, `historyOutputs` includes `gitSnapshot` data per step. The same `CliOutput` component renders the button. The `UNDO_PROMPT_CHANGES` message sends the stored `changedFiles` — the extension doesn't need to look up anything from disk.

---

## File Change Summary

| File | Change |
|---|---|
| `src/types/OutputHistoryTypes.ts` | Add `gitSnapshot` to `StepOutput`, add `PromptGitSnapshot`, `PromptFileChange` interfaces |
| `src/types/DashboardConstants.ts` | Add `UNDO_PROMPT_CHANGES`, `UNDO_PROMPT_RESULT` to `MESSAGE_TYPES` |
| `src/types/WebviewMessageTypes.ts` | Add `UndoPromptChangesMessage`, `UndoPromptResultMessage` interfaces |
| `src/utils/GitSnapshotService.ts` | New file — git snapshot capture and undo logic |
| `src/flightpath/WorkflowExecutor.ts` | Wrap prompt execution with before/after snapshot capture |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Accept and persist `gitSnapshot` in `saveStepOutput` |
| `src/ui/FlightPathWebviewProvider.ts` | Handle `UNDO_PROMPT_CHANGES` message, call `GitSnapshotService.undoChanges` |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Add undo button to stats section |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Handle `UNDO_PROMPT_RESULT` message |
| `src/ui/webview-react/store/workflowStore.ts` | Optionally: add `undoResults` map for result state routing |

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Workspace is not a git repo | `isGitRepo: false` → button not shown |
| Git not installed | `captureWorkspaceState` throws → `gitSnapshot: undefined` → button not shown |
| File changed during prompt + also changed by user after prompt | Undo restores to pre-prompt state, overwriting any manual changes — user is warned in the undo button tooltip: "This will overwrite any changes made after this prompt" |
| File was committed after the prompt completed | `git restore` will still work; `contentToRestore` restore will still work |
| Multiple prompts changed the same file | Each prompt's undo only knows its own changes. Undoing prompt 2 may leave the file in prompt 1's state (correct behavior). |
| Large repo with many dirty files | `captureWorkspaceState` reads only files listed in `git status --porcelain` output, not all files — performance is bounded by the number of *dirty* files |
| Prompt is a retry attempt | Button shown on each retry `CliOutput` block independently. Each attempt has its own `gitSnapshot` |

---

## Not In Scope (YAGNI)

- Undo for uncommitted git-tracked files that FlightPath did NOT modify (not our changes to undo)
- Redo (re-apply undone changes)
- Undo confirmation dialog (the button is secondary-styled and the VS Code notification explains what was restored)
- Undo for binary files (skipped with explanation in tooltip)
- Undo when history is disabled (no `gitSnapshot` stored, button never shown)
