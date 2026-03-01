# Prompt Undo Changes Plan

## Overview

Add an "Undo changes for this prompt" button to each completed prompt's output block in the dashboard. Clicking it opens a review dialog showing exactly which files changed during that prompt so users can selectively undo them.

The implementation uses a **hybrid attribution model**: structured file events from `CliOutput` (already stored in history) are the primary, per-workflow source of truth; before/after git snapshots are supplementary, catching bash-driven changes and filling content gaps when events don't carry before-state data.

---

## The Attribution Problem (Parallel Workflows)

A naive before/after snapshot approach captures *everything* that changed in the workspace during a prompt — including changes from other concurrently running workflows. A user undoing prompt 3 of workflow A should not accidentally revert changes made by workflow B that happened to run at the same time.

**Solution: two-tier file attribution in the review dialog.**

`CliOutput.structured.events` already contains `FILE_EDIT`, `FILE_WRITE`, and `FILE_DELETE` events emitted by the AI session for *this specific* prompt. These are definitively attributed. The before/after snapshot catches the remainder (bash-driven mutations, etc.) but cannot confirm which workflow caused them. The dialog surfaces this distinction so users can decide.

---

## Core Design

### Attribution Sources

**Tier 1 — Event-attributed (high confidence)**

Extracted from `CliOutput.structured.events` at the time the undo dialog opens. No extra storage needed — this data is already in the history file.

| Event type | Data available for undo |
|---|---|
| `FILE_EDIT` | `FileEditData.originalFile` (full before-content, Claude CLI) or `oldContent` or `structuredPatch` (reversed) |
| `FILE_WRITE` | Path only — undo = delete the created file |
| `FILE_DELETE` | `FileDeleteData` — before-content must come from snapshot |

**Tier 2 — Snapshot-attributed (lower confidence)**

Files that appear in the before/after git status diff but have no corresponding structured event. These may be from bash tool use (`sed -i`, `npm install`, `git apply`, etc.) or from a parallel workflow. Stored in `StepOutput.gitSnapshot.changedFiles` — only files *not* covered by Tier 1 events are included here to avoid redundancy.

### Undo Content Sources (priority order)

For a given file, undo content is resolved in this order:

1. `FileEditData.originalFile` — full pre-edit content (Claude CLI, already in history)
2. `FileEditData.oldContent` — partial before-content (already in history)
3. Reverse-apply `FileEditData.structuredPatch` — reconstruct from diff hunks (already in history)
4. `gitSnapshot.changedFiles[].contentToRestore` — before-snapshot content (stored separately)
5. `git restore <file>` — restores to HEAD, only when `wasAtHead: true` and file was unmodified before prompt

Sources 1–3 live in the existing `CliOutput` structure; no new storage is needed for event-attributed files. Source 4 is the new storage, needed only for snapshot-only files.

### Harness Coverage

| Harness | File event coverage | Snapshot importance |
|---|---|---|
| `claude-cli` | Excellent — `FILE_EDIT` with `originalFile` + `structuredPatch` | Low (bash-only gaps) |
| `codex-cli` | Good — `FILE_EDIT/WRITE/DELETE` events emitted | Medium |
| `copilot-cli` | Minimal — `rawTextOutput` mode, no structured file events | High (primary source) |
| `copilot-chat` | None | High (primary source) |

---

## Data Model Changes

### `src/types/OutputHistoryTypes.ts`

Add `gitSnapshot` to `StepOutput`. This only stores snapshot-only files (those not covered by structured events), keeping storage minimal.

```typescript
export interface StepOutput {
  cliOutputs: CliOutput[];
  statusMessages: StatusMessage[];
  /**
   * Supplementary git snapshot for prompt undo.
   * Contains only files changed during the prompt that had NO corresponding
   * FILE_EDIT/WRITE/DELETE structured event (e.g., bash-driven mutations).
   * Undefined if git is unavailable or snapshot capture failed.
   */
  gitSnapshot?: PromptGitSnapshot;
}

/**
 * Supplementary workspace snapshot for a single prompt execution.
 * Stores only the data that structured events cannot provide.
 */
export interface PromptGitSnapshot {
  /** Timestamp when the after-snapshot was captured */
  capturedAt: number;
  /** False if workspace is not a git repo (undo unavailable) */
  isGitRepo: boolean;
  /**
   * Files changed during this prompt that have NO structured event attribution.
   * May include changes from parallel workflows — shown with a warning in the dialog.
   */
  changedFiles: SnapshotFileChange[];
}

export type PromptChangeType = 'created' | 'modified' | 'deleted';

export interface SnapshotFileChange {
  /** Workspace-relative POSIX path (forward slashes, no leading slash) */
  path: string;
  changeType: PromptChangeType;
  /**
   * Content to restore for undo of 'modified' or 'deleted' files.
   * Undefined if the file was at HEAD before the prompt (use `git restore`)
   * or if content capture was skipped due to size/binary limits.
   */
  contentToRestore?: string;
  /** True if file was unmodified (at HEAD) before the prompt ran. */
  wasAtHead?: boolean;
  /** True if before-content was skipped due to size (>512KB) or binary detection. */
  contentCaptureSkipped?: boolean;
}
```

### Size Limits

- Files exceeding **512 KB** are excluded from `contentToRestore` capture. Entry still included in `changedFiles` with `contentCaptureSkipped: true`.
- Binary files (null byte in first 8 KB) treated the same way.
- Files with `contentCaptureSkipped: true` are shown in the dialog as non-undoable (greyed out checkbox).

---

## New Backend Service

### `src/utils/GitSnapshotService.ts`

Focused on git-state capture and file restoration. Does **not** do event extraction — that happens in the webview at dialog-open time from existing `CliOutput` data.

```
GitSnapshotService
  isGitRepo(workspacePath): Promise<boolean>
  captureWorkspaceState(workspacePath): Promise<RawWorkspaceState>
  computeSnapshotOnlyChanges(before, after, eventPaths): SnapshotFileChange[]
  undoFiles(files: UndoFileInstruction[], workspacePath): Promise<UndoResult>
```

**`RawWorkspaceState`** (internal, not stored):
```typescript
interface RawWorkspaceState {
  files: Map<string, {
    gitStatus: 'M' | 'A' | 'D' | '?';  // from git --porcelain
    contentHash: string;                  // SHA-256 for change detection
    content?: string;                     // before-state content, under size limit
    isAtHead: boolean;
  }>;
  capturedAt: number;
}
```

**`computeSnapshotOnlyChanges(before, after, eventPaths)`**:
- `eventPaths: Set<string>` — paths already covered by structured events (skip these)
- Compare `after.files` vs `before.files`; exclude any path in `eventPaths`
- Return `SnapshotFileChange[]` for remaining changed files

**`undoFiles(files: UndoFileInstruction[], workspacePath)`**:
```typescript
interface UndoFileInstruction {
  path: string;
  action: 'delete' | 'restore-content' | 'git-restore';
  contentToRestore?: string;  // for 'restore-content'
}
```
1. Validate all paths are inside workspace root (security)
2. `delete`: `fs.unlink`
3. `restore-content`: `fs.writeFile(content)`
4. `git-restore`: `child_process.execFile('git', ['restore', path])` — no shell interpolation
5. Return `{ succeeded: string[], failed: Array<{path, error}> }`

---

## Integration: Snapshot Capture in Execution

**Where**: `WorkflowExecutor.ts`, wrapping each prompt execution.

```
Before prompt N:
  eventPaths = Set()  (will be populated after the prompt runs)
  beforeState = GitSnapshotService.captureWorkspaceState(workspacePath)

[Prompt N runs → CliOutput built with structured events]

After prompt N completes:
  afterState = GitSnapshotService.captureWorkspaceState(workspacePath)
  eventPaths = extractEventPaths(cliOutput.structured.events)
  snapshotChanges = GitSnapshotService.computeSnapshotOnlyChanges(
    beforeState, afterState, eventPaths
  )
  gitSnapshot = { capturedAt: Date.now(), isGitRepo: true, changedFiles: snapshotChanges }
```

`extractEventPaths` collects `.path` from all `FILE_EDIT`, `FILE_WRITE`, `FILE_DELETE` events — these are excluded from snapshot diff because they are already covered by Tier 1 data.

**`OutputHistoryManager.saveStepOutput`**: add optional `gitSnapshot?: PromptGitSnapshot` parameter, persist into `StepOutput`.

Failure modes:
- Not a git repo → `gitSnapshot = { isGitRepo: false, changedFiles: [] }` — dialog still shows event-attributed files
- Git unavailable / capture throws → `gitSnapshot = undefined` — dialog shows event-attributed files only
- Both → undo still works for files with structured events

---

## Review Dialog (New Component)

### `src/ui/webview-react/components/output/UndoChangesDialog.tsx`

A modal (using the existing `Modal` shared component) that opens when the user clicks "↩ Undo changes" in the stats bar.

**Dialog layout:**

```
Undo Changes for Prompt 3
─────────────────────────────────────────────────────
Changed by this prompt:
  ☑  src/components/Button.tsx         edited
  ☑  src/utils/helpers.ts              edited
  ☑  src/newfile.ts                    created → will be deleted

⚠ Also changed during this prompt (source unknown):
  ☐  src/unrelated.ts                  modified
     May be from a parallel workflow — review before undoing
─────────────────────────────────────────────────────
                    [ Cancel ]  [ Undo Selected (3 files) ]
```

**Tier 1 items** (event-attributed) — pre-checked, normal styling.

**Tier 2 items** (snapshot-only) — unchecked by default, amber warning icon, tooltip: "This file changed during the prompt but was not directly modified by the AI. It may have been changed by a parallel workflow or a bash command. Review before undoing."

**Non-undoable items** (contentCaptureSkipped) — shown greyed out with disabled checkbox, tooltip: "File exceeds size limit — cannot be undone automatically."

**"Undo Selected" button**: disabled when zero files selected. Label updates dynamically: "Undo Selected (N files)".

### Props

```typescript
interface UndoChangesDialogProps {
  stepIndex: number;
  attemptIndex: number;
  /** Extracted from CliOutput.structured.events */
  eventAttributedFiles: EventAttributedFile[];
  /** From StepOutput.gitSnapshot.changedFiles */
  snapshotOnlyFiles: SnapshotFileChange[];
  onConfirm: (selectedFiles: UndoFileInstruction[]) => void;
  onClose: () => void;
}

interface EventAttributedFile {
  path: string;
  changeType: PromptChangeType;
  /** Resolved undo instruction built from event data */
  undoInstruction: UndoFileInstruction;
}
```

**Event-to-undo-instruction resolution** (done in the component or a utility):

```typescript
function resolveEventUndoInstruction(event: CliEvent): UndoFileInstruction | null {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const d = event.data as FileEditData;
      if (d.originalFile) return { path: d.path, action: 'restore-content', contentToRestore: d.originalFile };
      if (d.oldContent)   return { path: d.path, action: 'restore-content', contentToRestore: d.oldContent };
      if (d.structuredPatch) return { path: d.path, action: 'reverse-patch', patch: d.structuredPatch };
      return null; // no content available — treat as non-undoable
    }
    case CLI_EVENT_TYPES.FILE_WRITE:
      return { path: (event.data as FileWriteData).path, action: 'delete' };
    case CLI_EVENT_TYPES.FILE_DELETE:
      return null; // need contentToRestore from snapshot; look it up there
    default:
      return null;
  }
}
```

`FILE_DELETE` events don't carry before-content, so the undo instruction falls back to `snapshotOnlyFiles` for that path's `contentToRestore`. If not found there, the file is shown as non-undoable.

---

## `CliOutput.tsx` Changes

Replace the single "Undo changes" button concept with a trigger that opens the dialog.

**Show the trigger when**:
- `!output.isStreaming`
- At least one of: event-attributed files exist OR `gitSnapshot?.changedFiles.length > 0`
- `gitSnapshot?.isGitRepo !== false` (if `isGitRepo` is known-false, hide entirely)

**Trigger appearance**: Small inline link/button in stats bar — "↩ Undo changes (N files)" where N = total undoable file count.

**State**: `dialogOpen: boolean` via `useState` in `CliOutput`.

---

## Message Protocol

### `src/types/DashboardConstants.ts`

```typescript
UNDO_PROMPT_CHANGES: "undoPromptChanges",
UNDO_PROMPT_RESULT:  "undoPromptResult",
```

### `src/types/WebviewMessageTypes.ts`

```typescript
/** Webview → Extension: user confirmed undo selections */
export interface UndoPromptChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_CHANGES;
  data: {
    stepIndex: number;
    attemptIndex: number;
    files: UndoFileInstruction[];  // only the files user chose to undo
  };
}

/** Extension → Webview: undo operation result */
export interface UndoPromptResultMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_RESULT;
  data: {
    stepIndex: number;
    attemptIndex: number;
    success: boolean;
    restoredFiles: string[];
    failedFiles: Array<{ path: string; error: string }>;
  };
}
```

### `FlightPathWebviewProvider.ts`

Handle `UNDO_PROMPT_CHANGES`:
1. Call `GitSnapshotService.undoFiles(message.data.files, workspaceFolderPath)`
2. Send `UNDO_PROMPT_RESULT` back
3. Show VS Code notification: "Restored N files" or "Undo failed for: ..."

---

## State Routing for `UNDO_PROMPT_RESULT`

Undo state (`idle | loading | success | error`) is ephemeral — lives in `CliOutput` local state via `useState`. The response message needs to reach the right `CliOutput` instance. Use `workflowStore.undoResults: Record<string, UndoResult>` keyed by `"${stepIndex}-${attemptIndex}"`:

- `CliOutput` reads from this key and reacts to changes
- `useMessageHandler.ts` writes the result into the store on `UNDO_PROMPT_RESULT`
- `CliOutput` clears the key when it unmounts or when the dialog is re-opened

---

## File Change Summary

| File | Change |
|---|---|
| `src/types/OutputHistoryTypes.ts` | Add `gitSnapshot` to `StepOutput`; add `PromptGitSnapshot`, `SnapshotFileChange` |
| `src/types/DashboardConstants.ts` | Add `UNDO_PROMPT_CHANGES`, `UNDO_PROMPT_RESULT` to `MESSAGE_TYPES` |
| `src/types/WebviewMessageTypes.ts` | Add `UndoPromptChangesMessage`, `UndoPromptResultMessage`, `UndoFileInstruction` |
| `src/utils/GitSnapshotService.ts` | **New** — git snapshot capture and file restoration |
| `src/flightpath/WorkflowExecutor.ts` | Wrap prompt execution with before/after snapshot; pass `gitSnapshot` to history |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Accept `gitSnapshot` in `saveStepOutput` |
| `src/ui/FlightPathWebviewProvider.ts` | Handle `UNDO_PROMPT_CHANGES`, call `GitSnapshotService.undoFiles` |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Add undo trigger button; manage `dialogOpen` state |
| `src/ui/webview-react/components/output/UndoChangesDialog.tsx` | **New** — review dialog with two-tier file list |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Handle `UNDO_PROMPT_RESULT`, write to `workflowStore.undoResults` |
| `src/ui/webview-react/store/workflowStore.ts` | Add `undoResults: Record<string, UndoResult>` for result routing |

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Workspace is not a git repo | `isGitRepo: false` — dialog shows event-attributed files only (undo still works for those) |
| Git not installed | Snapshot fails silently — dialog shows event-attributed files only |
| Parallel workflows modifying overlapping files | Tier 2 (snapshot-only) files shown unchecked with warning; user decides |
| `FILE_DELETE` event — no before-content in event | Look up path in `snapshotOnlyFiles` for `contentToRestore`; if absent, mark non-undoable |
| File committed after prompt completed | `git restore` no longer appropriate; `contentToRestore` write still works |
| File manually edited by user after prompt | Dialog tooltip warns: "File may have been modified since this prompt ran" (detect via current git status at dialog-open time) |
| Multiple prompts changed the same file | Each prompt's dialog shows its own changes; undoing an earlier prompt may partially conflict with a later one — no automatic resolution |
| Large file (>512 KB) | `contentCaptureSkipped: true` — greyed out, non-selectable in dialog |
| Binary file | Same as large file |
| Prompt had only bash-driven changes (no file events) | All files appear in Tier 2; dialog still opens and user can undo them |
| Copilot CLI / Chat harnesses (no file events) | Dialog populated entirely from Tier 2 snapshot; all files shown with warning |

---

## Not In Scope (YAGNI)

- Redo (re-apply undone changes)
- Multi-step undo (undo prompts N through M in one action)
- Undo for binary files
- Reverse-patch application via `git apply --reverse` (use `contentToRestore` write instead — simpler, no patch apply failure modes)
- Undo when history is disabled (no `gitSnapshot`, no button)
