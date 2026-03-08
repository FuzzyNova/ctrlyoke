# Prompt Undo Changes Plan

## Overview

Add an "Undo changes for this prompt" button to each completed prompt's output block in the dashboard. Clicking it opens a review dialog showing exactly which files changed during that prompt so users can selectively undo them.

The implementation uses a **hybrid attribution model**: structured file events from `CliOutput` (already stored in history) are the primary, per-workflow source of truth; before/after workspace snapshots are supplementary, catching bash-driven changes and filling content gaps when events don't carry before-state data.

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

Files that appear in the before/after snapshot diff but have no corresponding structured event. These may be from bash tool use (`sed -i`, `npm install`, `git apply`, etc.) or from a parallel workflow. Stored in `StepOutput.workspaceSnapshot.changedFiles` — only files *not* covered by Tier 1 events are included here to avoid redundancy.

### Undo Content Sources (priority order)

For a given file, undo content is resolved in this order:

1. `FileEditData.originalFile` — full pre-edit content (Claude CLI, already in history)
2. `FileEditData.oldContent` — partial before-content (already in history)
3. Reverse-apply `FileEditData.structuredPatch` — reconstruct from diff hunks (already in history)
4. `workspaceSnapshot.changedFiles[].contentToRestore` — before-snapshot content (stored separately)
5. `git restore <file>` — restores to HEAD, only when `wasAtHead: true`, `strategy === 'git'`, and file was unmodified before prompt

Sources 1–3 live in the existing `CliOutput` structure; no new storage is needed for event-attributed files. Source 4 is the new storage, needed only for snapshot-only files.

### Harness Coverage

| Harness | File event coverage | Snapshot importance |
|---|---|---|
| `claude-cli` | Excellent — `FILE_EDIT` with `originalFile` + `structuredPatch` | Low (bash-only gaps) |
| `codex-cli` | Good — `FILE_EDIT/WRITE/DELETE` events emitted | Medium |
| `copilot-cli` | Minimal — `rawTextOutput` mode, no structured file events | High (primary source) |
| `copilot-chat` | None | High (primary source) |

---

## Snapshot Strategy

`WorkspaceSnapshotService` selects a snapshot strategy once at the start of each workflow run and uses it for all before/after captures in that run.

### Strategy Selection

```
isGitRepo(workspacePath)
  → true:  use GitStrategy   (preferred)
  → false: use FilesystemStrategy
```

The strategy is determined by attempting `git rev-parse --is-inside-work-tree` at the workspace root. Failure (non-zero exit or git not installed) falls back to `FilesystemStrategy`.

### Why GitStrategy Is Preferred

`git status --porcelain` only surfaces files that git tracks or that are untracked-but-not-gitignored. Any path matched by `.gitignore` — `dist/`, `out/`, `node_modules/`, `build/`, generated assets — is **completely invisible** to it. Build artifact noise is eliminated for free without any extra configuration.

`git restore` is also only available under this strategy (it requires git history).

### GitStrategy — How It Works

**Before-snapshot**: run `git status --porcelain` to get the set of already-dirty and untracked files. For each, read current content (≤ 512 KB, non-binary) and compute SHA-256. These are the files that were already dirty *before* the prompt ran.

**After-snapshot**: run `git status --porcelain` again. Compare to before:
- In after but not before → file was clean (at HEAD) before the prompt, modified during it → `wasAtHead: true`, no `contentToRestore` needed (undo via `git restore`)
- In both with a different content hash → file was already dirty, further modified during the prompt → content from before-snapshot is the `contentToRestore`
- In both with the same hash → not actually changed, exclude

### FilesystemStrategy — How It Works

Used when git is unavailable or the workspace is not a git repo.

**Change detection**: walk the workspace recursively, hash every non-excluded file. Compare before/after hashes to determine what changed.

**Exclusion rules** (applied in order, first match wins):

1. **`.flightpath/` directory** — always excluded (our own runtime files)
2. **`.git/` directory** — always excluded
3. **Hardcoded default exclusions** — covers the common build artifact directories across all major ecosystems:
   ```
   node_modules/   dist/           out/            build/
   .next/          .nuxt/          .svelte-kit/    .turbo/
   coverage/       .nyc_output/    .cache/         .parcel-cache/
   __pycache__/    .pytest_cache/  .venv/          venv/
   target/         vendor/         .gradle/        .idea/
   *.pyc           *.class         *.o             *.obj
   ```
4. **`.gitignore` patterns** — if a `.gitignore` file exists at the workspace root, parse it and apply matching patterns. This handles project-specific ignores even in non-git repos. Parsing rules:
   - Skip empty lines and lines starting with `#`
   - Skip negation patterns (`!`-prefixed) — too complex to invert reliably, ignore them
   - Directory patterns (`dist/`, `build/`) → exclude any path whose first segment matches
   - Bare names (`node_modules`) → exclude any path segment matching the name
   - Simple glob patterns (`*.log`) → match against the filename only using basic `*` wildcard

`wasAtHead` is always `false` under `FilesystemStrategy` — there is no git history to restore from.

### No External Package Required

Both strategies use only Node.js built-ins (`fs`, `crypto`) and `child_process.execFile`. No git library (`simple-git`, etc.) and no gitignore parser package are needed. The gitignore parsing required is simple enough to implement inline.

---

## Data Model Changes

### `src/types/OutputHistoryTypes.ts`

Add `workspaceSnapshot` to `StepOutput`. This only stores snapshot-only files (those not covered by structured events), keeping storage minimal.

```typescript
export interface StepOutput {
  cliOutputs: CliOutput[];
  statusMessages: StatusMessage[];
  /**
   * Supplementary workspace snapshot for prompt undo.
   * Contains only files changed during the prompt that had NO corresponding
   * FILE_EDIT/WRITE/DELETE structured event (e.g., bash-driven mutations).
   * Undefined if snapshot capture failed entirely.
   */
  workspaceSnapshot?: WorkspaceSnapshot;
}

/**
 * Supplementary workspace snapshot for a single prompt execution.
 * Stores only the data that structured events cannot provide.
 */
export interface WorkspaceSnapshot {
  /** Timestamp when the after-snapshot was captured */
  capturedAt: number;
  /**
   * Which strategy was used to capture this snapshot.
   * 'git': git available; git restore works for wasAtHead files.
   * 'filesystem': no git; content-only undo, no git restore.
   */
  strategy: 'git' | 'filesystem';
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
   * Undefined if the file was at HEAD before the prompt (use git restore when strategy === 'git')
   * or if content capture was skipped due to size/binary limits.
   */
  contentToRestore?: string;
  /** True if file was unmodified (at HEAD) before the prompt ran. Only set when strategy === 'git'. */
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

### `src/utils/WorkspaceSnapshotService.ts`

Handles workspace-state capture and file restoration across both strategies. Does **not** do event extraction — that happens in the webview at dialog-open time from existing `CliOutput` data.

```
WorkspaceSnapshotService
  selectStrategy(workspacePath): Promise<'git' | 'filesystem'>
  captureWorkspaceState(workspacePath, strategy): Promise<RawWorkspaceState>
  computeSnapshotOnlyChanges(before, after, eventPaths): SnapshotFileChange[]
  undoFiles(files: UndoFileInstruction[], workspacePath): Promise<UndoResult>
```

**`RawWorkspaceState`** (internal, not stored):
```typescript
interface RawWorkspaceState {
  strategy: 'git' | 'filesystem';
  files: Map<string, {
    contentHash: string;      // SHA-256 for change detection
    content?: string;         // before-state content, under size limit
    isAtHead: boolean;        // true only under git strategy
  }>;
  capturedAt: number;
}
```

**`selectStrategy(workspacePath)`**: runs `git rev-parse --is-inside-work-tree` via `execFile`. Returns `'git'` on success, `'filesystem'` on any failure. Called once per workflow run; callers pass the result to `captureWorkspaceState`.

**`captureWorkspaceState(workspacePath, strategy)`**:
- `'git'`: runs `git status --porcelain`, reads content for each listed file
- `'filesystem'`: walks the directory recursively applying exclusion rules (see above), reads content for each file

**`computeSnapshotOnlyChanges(before, after, eventPaths)`**:
- `eventPaths: Set<string>` — paths already covered by structured events (skip these)
- For git: files in after but not before → `wasAtHead: true`; files in both with different hash → use before-content
- For filesystem: files in after but not in before → `created`; files in both with different hash → `modified`; files in before but not after → `deleted`
- Exclude any path in `eventPaths`

**`undoFiles(files: UndoFileInstruction[], workspacePath)`**:
```typescript
interface UndoFileInstruction {
  path: string;
  action: 'delete' | 'restore-content' | 'git-restore';
  contentToRestore?: string;  // for 'restore-content'
}
```
1. Validate all paths are inside workspace root (security — path traversal prevention)
2. `delete`: `fs.unlink`
3. `restore-content`: `fs.writeFile(content)`
4. `git-restore`: `execFile('git', ['restore', '--', path])` — no shell interpolation; only called when `strategy === 'git'`
5. Return `{ succeeded: string[], failed: Array<{path, error}> }`

---

## Integration: Snapshot Capture in Execution

**Where**: `WorkflowExecutor.ts`, wrapping each prompt execution.

```
At workflow start (once):
  strategy = WorkspaceSnapshotService.selectStrategy(workspacePath)

Before prompt N:
  beforeState = WorkspaceSnapshotService.captureWorkspaceState(workspacePath, strategy)

[Prompt N runs → CliOutput built with structured events]

After prompt N completes:
  afterState = WorkspaceSnapshotService.captureWorkspaceState(workspacePath, strategy)
  eventPaths = extractEventPaths(cliOutput.structured.events)
  snapshotChanges = WorkspaceSnapshotService.computeSnapshotOnlyChanges(
    beforeState, afterState, eventPaths
  )
  workspaceSnapshot = { capturedAt: Date.now(), strategy, changedFiles: snapshotChanges }
```

`extractEventPaths` collects `.path` from all `FILE_EDIT`, `FILE_WRITE`, `FILE_DELETE` events — these are excluded from snapshot diff because they are already covered by Tier 1 data.

**`OutputHistoryManager.saveStepOutput`**: add optional `workspaceSnapshot?: WorkspaceSnapshot` parameter, persist into `StepOutput`.

Failure modes:
- Git not installed → `selectStrategy` returns `'filesystem'` — snapshot still captured, just no `git restore`
- Not a git repo → same as above
- Both strategies fail to capture (filesystem walk throws) → `workspaceSnapshot = undefined` — dialog shows event-attributed files only; undo still works for those
- Either → Tier 1 (event-attributed) files always work regardless of snapshot availability

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
  /** From StepOutput.workspaceSnapshot.changedFiles */
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
- At least one of: event-attributed files exist OR `workspaceSnapshot?.changedFiles.length > 0`

Note: the trigger is shown even when `workspaceSnapshot` is absent or `strategy === 'filesystem'` — Tier 1 (event-attributed) files are always undoable regardless of snapshot availability.

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
1. Call `WorkspaceSnapshotService.undoFiles(message.data.files, workspaceFolderPath)`
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
| `src/types/OutputHistoryTypes.ts` | Add `workspaceSnapshot` to `StepOutput`; add `WorkspaceSnapshot`, `SnapshotFileChange` |
| `src/types/DashboardConstants.ts` | Add `UNDO_PROMPT_CHANGES`, `UNDO_PROMPT_RESULT` to `MESSAGE_TYPES` |
| `src/types/WebviewMessageTypes.ts` | Add `UndoPromptChangesMessage`, `UndoPromptResultMessage`, `UndoFileInstruction` |
| `src/utils/WorkspaceSnapshotService.ts` | **New** — workspace snapshot capture (git + filesystem strategies) and file restoration |
| `src/flightpath/WorkflowExecutor.ts` | Select strategy once at run start; wrap each prompt execution with before/after snapshot; pass `workspaceSnapshot` to history |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Accept `workspaceSnapshot` in `saveStepOutput` |
| `src/ui/FlightPathWebviewProvider.ts` | Handle `UNDO_PROMPT_CHANGES`, call `WorkspaceSnapshotService.undoFiles` |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Add undo trigger button; manage `dialogOpen` state |
| `src/ui/webview-react/components/output/UndoChangesDialog.tsx` | **New** — review dialog with two-tier file list |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Handle `UNDO_PROMPT_RESULT`, write to `workflowStore.undoResults` |
| `src/ui/webview-react/store/workflowStore.ts` | Add `undoResults: Record<string, UndoResult>` for result routing |

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Workspace is not a git repo | `selectStrategy` returns `'filesystem'`; snapshot still works; `git restore` unavailable but `restore-content` works for all captured files |
| Git not installed | Same as above — falls back to filesystem strategy |
| Non-git repo with `.gitignore` | `.gitignore` patterns parsed and applied during filesystem walk — project-specific build dirs still excluded |
| Build artifacts (`dist/`, `node_modules/`) | Git strategy: invisible to `git status --porcelain` (gitignored). Filesystem strategy: excluded by hardcoded defaults and/or `.gitignore` parsing |
| Parallel workflows modifying overlapping files | Tier 2 (snapshot-only) files shown unchecked with warning; user decides |
| `FILE_DELETE` event — no before-content in event | Look up path in `snapshotOnlyFiles` for `contentToRestore`; if absent, mark non-undoable |
| File committed after prompt completed | `git restore` no longer appropriate; `contentToRestore` write still works |
| File manually edited by user after prompt | Dialog tooltip warns: "File may have been modified since this prompt ran" (detect via current git status at dialog-open time) |
| Multiple prompts changed the same file | Each prompt's dialog shows its own changes; undoing an earlier prompt may partially conflict with a later one — no automatic resolution |
| Large file (>512 KB) | `contentCaptureSkipped: true` — greyed out, non-selectable in dialog |
| Binary file | Same as large file |
| Prompt had only bash-driven changes (no file events) | All files appear in Tier 2; dialog still opens and user can undo them |
| Copilot CLI / Chat harnesses (no file events) | Dialog populated entirely from Tier 2 snapshot; all files shown with warning |
| No snapshot AND no file events | Undo trigger not shown (nothing to undo) |

---

## Not In Scope (YAGNI)

- Redo (re-apply undone changes)
- Multi-step undo (undo prompts N through M in one action)
- Undo for binary files
- Reverse-patch application via `git apply --reverse` (use `contentToRestore` write instead — simpler, no patch apply failure modes)
- Undo when history is disabled (no `workspaceSnapshot`, no button)
- Full gitignore spec compliance in filesystem strategy (negation patterns, `**` globs, etc.) — hardcoded defaults + simple patterns are sufficient
