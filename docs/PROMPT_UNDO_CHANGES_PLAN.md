# Prompt Undo Changes Plan

## Overview

Add two undo entry points to the dashboard:

1. Prompt-level undo in the prompt panel for completed queue prompts.
2. File-level undo buttons on individual `FILE_EDIT` / `FILE_WRITE` / `FILE_DELETE` rows in `ToolCallOutput.tsx`.

Both entry points open the same review dialog. The difference is scope:

- Prompt-level opens the dialog for all changes attributed to one prompt execution, across all attempts/retries for that prompt.
- File-level opens the dialog pre-filtered to a single file change from one rendered diff row.

This keeps one undo pipeline, one dialog, and one backend restore service.

The implementation uses a **hybrid attribution model**:

- Structured file events from `CliOutput.structured.events` are the high-confidence source of truth.
- Before/after workspace snapshots are the supplemental source for bash-driven changes and for delete restore content when the event itself does not carry before-state data.

## Main Refinements to the Original Plan

The original plan was close, but it missed a few important things:

1. The primary button should not live in `CliOutput.tsx`. It should live in the prompt panel (`PromptItem` / `PromptItemDetails`) because that is where users think in terms of "undo this prompt".
2. Individual diff rows should get their own compact undo buttons in `ToolCallOutput.tsx`, but they should reuse the same dialog and restore flow.
3. Live mode needs access to snapshot metadata. Storing it only in history is not enough because the prompt panel and output panel need it immediately after a prompt completes.
4. Prompt-level undo must aggregate changes across all attempts for that step, not just the latest `CliOutput`.
5. History browsing must be view-only for this feature in v1. Undoing from an old historical run against the current workspace is too risky.
6. The current plan is queue-step-centric. The backend/message contracts should be target-based so final-prompt loop support is not boxed out later, even if the prompt-panel button is queue-only in v1.

## The Attribution Problem (Parallel Workflows)

A naive before/after snapshot approach captures *everything* that changed in the workspace during a prompt — including changes from other concurrently running workflows. A user undoing prompt 3 of workflow A should not accidentally revert changes made by workflow B that happened to run at the same time.

**Solution: two-tier file attribution in the review dialog.**

`CliOutput.structured.events` already contains `FILE_EDIT`, `FILE_WRITE`, and `FILE_DELETE` events emitted by the AI session for *this specific* prompt. These are definitively attributed. The before/after snapshot catches the remainder (bash-driven mutations, etc.) but cannot confirm which workflow caused them. The dialog surfaces this distinction so users can decide.

## UX

### Primary entry point: prompt panel

Place the main `Undo changes` button on completed queue prompt rows in the prompt panel.

Recommended placement:

- Add a compact action row in `PromptItemDetails.tsx`, shown only for completed prompts that have undoable changes.
- Button text: `Undo changes`
- Optional count badge: `(N)`

Why this placement:

- It matches the user's mental model: "undo this prompt".
- It is visible without scrolling the output panel.
- It avoids overloading the already-dense output header/stats row.

Show the prompt-level button only when all of these are true:

- prompt status is `completed` or `failed` with captured file changes
- the workflow is not currently `running` or `cancelling`
- the dashboard is not in run-history view
- the workflow is not CLI-managed watch mode
- there is at least one undoable file candidate

### Secondary entry point: per-diff buttons

Add compact icon-only undo buttons to `ToolCallOutput.tsx` for:

- `FileEditOutput`
- `FileWriteOutput`
- `FileDeleteOutput`

Placement:

- Right-aligned on the same line as the file operation label/path.
- Visible on hover, or always visible for selected/expanded rows.

Tooltip text:

- `Undo this file change`

Behavior:

- Opens the shared dialog in single-file mode.
- The selected file is pre-checked.
- Other files from the same prompt are hidden in single-file mode.

### History mode

Undo should be disabled in run-history view in v1.

Reason:

- History rendering is replaying an old run, but the workspace has moved on.
- A destructive action from a historical run is much easier to misunderstand than a live-run undo.

If useful, the dialog can later get a view-only `Review changes` mode for history, but that is not required for v1.

### Final prompt scope

Backend contracts should support final-prompt loops, because output history and output rendering already distinguish them.

UI scope for v1:

- Prompt-panel undo button: queue prompts only.
- Per-diff undo button: queue prompts and final-prompt loop outputs both supported, because the button is attached to a concrete rendered output block.

Reason to defer final-prompt footer undo:

- The footer represents a recurring prompt with loop semantics, not one stable execution target.
- The footer currently surfaces only the latest loop, which makes an aggregate "undo this final prompt" action ambiguous.

## Attribution Model

### Tier 1: event-attributed files

Extracted from `CliOutput.structured.events` for the specific prompt execution target.

These are high confidence because they came from the harness session for that prompt:

| Event type | Undo source |
|---|---|
| `FILE_EDIT` | `originalFile`, `oldContent`, or reversed `structuredPatch` |
| `FILE_WRITE` | delete the created file |
| `FILE_DELETE` | restore deleted content from snapshot fallback |

### Tier 2: snapshot-only files

Files present in the before/after workspace diff that do not have a matching structured file event.

These can be:

- bash-driven changes
- tool side effects
- changes from another concurrent workflow

These should be shown separately in the dialog and unchecked by default.

### Undo Content Sources (priority order)

For a given file, undo content is resolved in this order:

1. `FileEditData.originalFile` — full pre-edit content (Claude CLI, already in history)
2. `FileEditData.oldContent` — partial before-content (already in history)
3. Reverse-apply `FileEditData.structuredPatch` — reconstruct from diff hunks (already in history)
4. `workspaceSnapshot.changedFiles[].contentToRestore` — before-snapshot content (stored separately)
5. `git restore <file>` — restores to HEAD, only when `wasAtHead: true`, `strategy === 'git'`, and file was unmodified before prompt

Sources 1–3 live in the existing `CliOutput` structure; no new storage is needed for event-attributed files. Source 4 is the new storage, needed only for snapshot-only files and `FILE_DELETE` restore.

Do not introduce a backend `reverse-patch` action. If a patch must be reversed, resolve it to full `contentToRestore` in the webview utility (`promptUndo.ts`) before sending the message to the extension.

### Harness Coverage

| Harness | File event coverage | Snapshot importance |
|---|---|---|
| `claude-cli` | Excellent — `FILE_EDIT` with `originalFile` + `structuredPatch` | Low (bash-only gaps) |
| `codex-cli` | Good — `FILE_EDIT/WRITE/DELETE` events emitted | Medium |
| `copilot-cli` | Minimal — `rawTextOutput` mode, no structured file events | High (primary source) |
| `copilot-chat` | None | High (primary source) |

## Undo Scope Model

Introduce a target-based abstraction instead of passing only `stepIndex`.

Use the same shape already present in `OutputHistoryTypes.ts`:

```ts
type UndoExecutionTarget =
  | { kind: "queue"; stepIndex: number }
  | { kind: "finalPrompt"; loopIndex: number };
```

Then add a UI-level scope:

```ts
type UndoDialogScope =
  | { mode: "prompt"; target: UndoExecutionTarget }
  | {
      mode: "singleFile";
      target: UndoExecutionTarget;
      attemptIndex: number;
      path: string;
    };
```

This keeps the backend generic while the UI decides whether the dialog is prompt-wide or file-scoped.

## Retry Semantics

Prompt-level undo must aggregate across all attempts for a queue step.

That means:

- The before snapshot is captured once before the initial attempt.
- The after snapshot is captured once after the prompt is fully finished, including retries/end-condition remediation.
- Structured events are aggregated across all `CliOutput[]` attempts for that target.

Result:

- Prompt-level undo restores the workspace to the state before the prompt first started.
- File-level undo still works at the individual event row level, but it is intentionally narrower and may conflict with later retries or later prompts. The dialog should warn that the file may have changed since this event was produced.

## Snapshot Strategy

`WorkspaceSnapshotService` still selects one strategy per workflow run:

```text
isGitRepo(workspacePath)
  -> true:  GitStrategy
  -> false: FilesystemStrategy
```

The strategy is determined by attempting `git rev-parse --is-inside-work-tree` at the workspace root. Failure (non-zero exit or git not installed) falls back to `FilesystemStrategy`.

### GitStrategy

Preferred because:

- `git status --porcelain` naturally excludes `.gitignore`d build artifacts.
- `git restore -- <path>` gives a clean restore path for files that were at HEAD before the prompt.

Before snapshot:

- run `git status --porcelain` to get already-dirty and untracked files
- read content for those files when within limits
- compute SHA-256 hash for change detection

After snapshot:

- run `git status --porcelain` again
- compare to before:
  - in after but not before → file was at HEAD before, `wasAtHead: true`, undo via `git restore`
  - in both with a different content hash → was already dirty, `contentToRestore` = before-snapshot content
  - in both with same hash → unchanged, exclude
- classify `created`, `modified`, `deleted`

### FilesystemStrategy

Used when git is unavailable or workspace is not a git repo.

Walk the workspace, excluding (in priority order, first match wins):

1. `.flightpath/` — always excluded (our own runtime files)
2. `.git/` — always excluded
3. Hardcoded artifact directories/files:
   ```
   node_modules/   dist/           out/            build/
   .next/          .nuxt/          .svelte-kit/    .turbo/
   coverage/       .nyc_output/    .cache/         .parcel-cache/
   __pycache__/    .pytest_cache/  .venv/          venv/
   target/         vendor/         .gradle/        .idea/
   *.pyc           *.class         *.o             *.obj
   ```
4. `.gitignore` patterns — if a `.gitignore` exists at workspace root, parse and apply:
   - Skip empty lines and `#` comments
   - Skip negation patterns (`!`-prefixed) — too complex to invert reliably
   - Directory patterns (`dist/`) → exclude any path whose first segment matches
   - Bare names (`node_modules`) → exclude any path segment matching the name
   - Simple glob patterns (`*.log`) → match against filename only using basic `*` wildcard

`wasAtHead` is always `false` under `FilesystemStrategy` — there is no git history to restore from.

### Capture limits

- max content capture: 512 KB per file
- binary detection: null byte in first 8 KB
- large/binary files remain listed but are non-undoable automatically (`contentCaptureSkipped: true`)

### No External Package Required

Both strategies use only Node.js built-ins (`fs`, `crypto`) and `child_process.execFile`. No git library (`simple-git`, etc.) and no gitignore parser package are needed.

## Data Model Changes

### `src/types/OutputHistoryTypes.ts`

Extend `StepOutput`:

```ts
export interface StepOutput {
  cliOutputs: CliOutput[];
  statusMessages: StatusMessage[];
  workspaceSnapshot?: WorkspaceSnapshot;
}
```

Use a snapshot shape that is sufficient for both restore and warnings:

```ts
export interface WorkspaceSnapshot {
  /** Timestamp when the after-snapshot was captured */
  capturedAt: number;
  /** 'git': git restore works for wasAtHead files. 'filesystem': content-only undo. */
  strategy: "git" | "filesystem";
  /**
   * Files changed during this prompt that have NO structured event attribution.
   * May include changes from parallel workflows — shown with a warning in the dialog.
   */
  changedFiles: SnapshotFileChange[];
}

export type PromptChangeType = "created" | "modified" | "deleted";

export interface SnapshotFileChange {
  /** Workspace-relative POSIX path (forward slashes, no leading slash) */
  path: string;
  changeType: PromptChangeType;
  /**
   * Content to restore for 'modified' or 'deleted' files.
   * Undefined if wasAtHead (use git restore) or if content capture was skipped.
   */
  contentToRestore?: string;
  /** True if file was unmodified (at HEAD) before the prompt ran. Only set when strategy === 'git'. */
  wasAtHead?: boolean;
  /** True if before-content was skipped due to size (>512 KB) or binary detection. */
  contentCaptureSkipped?: boolean;
  /**
   * SHA-256 of file content after the prompt completed.
   * Enables reliable drift detection: if current hash differs at dialog-open time,
   * show an amber warning "File has changed since this prompt completed".
   */
  afterHash?: string;
}
```

`afterHash` is worth storing even though it is small because it enables a reliable "workspace drift" warning in the dialog by comparing current file content to the post-prompt hash.

### Live webview state

History storage is not enough. Live mode also needs this data.

Add to `workflowStore.ts`:

```ts
workspaceSnapshots: Record<number, WorkspaceSnapshot>;
finalPromptWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
undoResults: Record<string, UndoResult>;
```

Why:

- prompt panel button needs live snapshot data
- per-diff dialog needs delete fallback data immediately
- history view already gets snapshot data from `StepOutput`

## New Backend Service

### `src/utils/WorkspaceSnapshotService.ts`

Responsibilities:

```ts
selectStrategy(workspacePath): Promise<"git" | "filesystem">
captureWorkspaceState(workspacePath, strategy): Promise<RawWorkspaceState>
computeSnapshotChanges(before, after, eventPaths): SnapshotFileChange[]
undoFiles(files: UndoFileInstruction[], workspacePath): Promise<UndoResult>
hashCurrentFile(workspacePath, relativePath): Promise<string | undefined>
```

**`RawWorkspaceState`** (internal, not stored):

```ts
interface RawWorkspaceState {
  strategy: "git" | "filesystem";
  files: Map<string, {
    contentHash: string;   // SHA-256 for change detection
    content?: string;      // before-state content, under size limit
    isAtHead: boolean;     // true only under git strategy
  }>;
  capturedAt: number;
}
```

`UndoFileInstruction` should stay simple:

```ts
interface UndoFileInstruction {
  path: string;
  action: "delete" | "restore-content" | "git-restore";
  contentToRestore?: string;
}
```

`undoFiles()` should also:

1. validate all paths stay inside the workspace (path traversal prevention)
2. `mkdir -p` parent directories before `restore-content`
3. treat deleting a missing file as a no-op success
4. return partial success details, not fail the whole batch

**`computeSnapshotChanges(before, after, eventPaths)`**:

- `eventPaths: Set<string>` — paths already covered by structured events (skip these — they are Tier 1)
- For git: files in after but not before → `wasAtHead: true`; files in both with different hash → use before-content
- For filesystem: files in after but not in before → `created`; hash mismatch → `modified`; in before but not after → `deleted`
- Exclude any path in `eventPaths`

## Integration in Execution Flow

### `WorkflowExecutor.ts`

Wrap the entire execution target, not each individual attempt:

```text
at workflow start (once):
  strategy = selectStrategy(workspacePath)

before first attempt:
  beforeState = captureWorkspaceState(workspacePath, strategy)

run prompt + retries until final result

after prompt fully settles:
  aggregate structured event paths across all attempts → eventPaths
  afterState = captureWorkspaceState(workspacePath, strategy)
  snapshot = computeSnapshotChanges(beforeState, afterState, eventPaths)
  persist snapshot to history
  send snapshot to live webview state
```

This applies to:

- queue prompts
- final-prompt loops

Failure modes:

- Git not installed → `selectStrategy` returns `'filesystem'` — snapshot still captured, just no `git restore`
- Both strategies fail to capture → `workspaceSnapshot = undefined` — dialog shows event-attributed files only; Tier 1 undo still works

### `OutputHistoryManager.ts`

Update `saveExecutionOutput()` to accept optional `workspaceSnapshot` and store it alongside the merged `cliOutputs`.

Important:

- `cliOutputs` merge by `attemptIndex`
- `workspaceSnapshot` is per target execution, not per attempt
- only replace the snapshot when the prompt execution is fully done

## Live Message Protocol

The original plan only covered the confirm/restore round trip. It also needs a live snapshot message.

### `src/types/DashboardConstants.ts`

Add:

```ts
STEP_UNDO_DATA_UPDATED: "stepUndoDataUpdated",
UNDO_PROMPT_CHANGES: "undoPromptChanges",
UNDO_PROMPT_RESULT: "undoPromptResult",
```

### `src/types/WebviewMessageTypes.ts`

Add:

```ts
export interface StepUndoDataUpdatedMessage {
  type: typeof MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED;
  target: UndoExecutionTarget;
  workspaceSnapshot?: WorkspaceSnapshot;
}

export interface UndoPromptChangesMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_CHANGES;
  data: {
    requestId: string;
    target: UndoExecutionTarget;
    files: UndoFileInstruction[];
  };
}

export interface UndoPromptResultMessage {
  type: typeof MESSAGE_TYPES.UNDO_PROMPT_RESULT;
  data: {
    requestId: string;
    target: UndoExecutionTarget;
    restoredFiles: string[];
    failedFiles: Array<{ path: string; error: string }>;
  };
}
```

Use `requestId`, not `stepIndex + attemptIndex`, for result routing. That is more robust once there are two entry points and potentially repeated opens from the same prompt.

### Extension routing

`FlightPathWebviewProvider.ts` / `WebviewMessageRouter.ts`:

- handle `STEP_UNDO_DATA_UPDATED` emission after prompt completion
- handle `UNDO_PROMPT_CHANGES` request
- call `WorkspaceSnapshotService.undoFiles(...)`
- send `UNDO_PROMPT_RESULT`
- show VS Code notification summarizing partial/full success

## Webview Utilities

Add a focused helper:

- `src/ui/webview-react/utils/promptUndo.ts`

Responsibilities:

1. Extract file events from one `CliOutput`
2. Aggregate file events across all `CliOutput[]` attempts for a prompt target
3. Resolve event data into `UndoFileCandidate`s (including patch reversal to `contentToRestore`)
4. Merge event candidates with snapshot-only candidates
5. Produce prompt-panel summaries (`count`, `hasTier2`, `hasNonUndoable`)
6. Resolve a single event-row click into dialog input

This avoids duplicating file-attribution logic in:

- `PromptsPanel.tsx`
- `CliOutput.tsx`
- `ToolCallOutput.tsx`
- `UndoChangesDialog.tsx`

**`resolveEventUndoInstruction()` example** (lives in `promptUndo.ts`):

```ts
function resolveEventUndoInstruction(
  event: CliEvent,
  snapshotFiles: SnapshotFileChange[]
): UndoFileInstruction | null {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const d = event.data as FileEditData;
      if (d.originalFile)    return { path: d.path, action: "restore-content", contentToRestore: d.originalFile };
      if (d.oldContent)      return { path: d.path, action: "restore-content", contentToRestore: d.oldContent };
      if (d.structuredPatch) return { path: d.path, action: "restore-content", contentToRestore: reverseApplyPatch(d.structuredPatch, d.path) };
      return null; // no content available — non-undoable
    }
    case CLI_EVENT_TYPES.FILE_WRITE:
      return { path: (event.data as FileWriteData).path, action: "delete" };
    case CLI_EVENT_TYPES.FILE_DELETE: {
      // Before-content must come from snapshot fallback
      const snap = snapshotFiles.find(f => f.path === (event.data as FileDeleteData).path);
      if (!snap?.contentToRestore) return null; // non-undoable
      if (snap.wasAtHead) return { path: snap.path, action: "git-restore" };
      return { path: snap.path, action: "restore-content", contentToRestore: snap.contentToRestore };
    }
    default:
      return null;
  }
}
```

## Dialog Plan

### New component

`src/ui/webview-react/components/output/UndoChangesDialog.tsx`

Use the existing shared `Modal` component.

### Dialog modes

#### Prompt mode

Title example:

`Undo changes from Prompt 3`

Subtitle:

- `4 files can be restored`
- optional warning if there are snapshot-only files

#### Single-file mode

Title example:

`Undo change in src/utils/helpers.ts`

Subtitle:

- identifies the originating prompt/attempt when available

### Layout

Use a two-pane layout on wide widths, stacked layout on narrow widths.

Left pane:

- grouped checklist of files
- `Changed directly by the AI`
- `Also changed during this prompt`

Right pane:

- preview for the selected file
- reuse existing diff rendering where possible

Preview behavior by change type:

- `modified`: show diff preview
- `created`: show message `This file will be deleted`
- `deleted`: show restored content preview if available, otherwise show non-undoable explanation

**Example layout:**

```
Undo Changes for Prompt 3
─────────────────────────────────────────────────────────────
Changed directly by the AI:
  ☑  src/components/Button.tsx      edited
  ☑  src/utils/helpers.ts           edited
  ☑  src/newfile.ts                 created  →  will be deleted

⚠ Also changed during this prompt (source unknown):
  ☐  src/unrelated.ts               modified
     May be from a parallel workflow — review before undoing
─────────────────────────────────────────────────────────────
                          [ Cancel ]  [ Undo Selected (3) ]
```

### File row content

Each row should show:

- checkbox
- path
- change badge: `edited`, `created`, `deleted`
- source badge: `AI` or `snapshot`
- restore method badge when useful: `git restore`, `restore content`, `delete`
- warning icon if file drift is detected

Defaults:

- Tier 1 items checked by default
- Tier 2 items unchecked by default
- non-undoable items disabled (`contentCaptureSkipped: true` or no restore content)

### Props

```ts
interface UndoChangesDialogProps {
  scope: UndoDialogScope;
  /** Resolved from CliOutput.structured.events via promptUndo.ts */
  eventAttributedFiles: UndoFileCandidate[];
  /** From workspaceSnapshot.changedFiles (Tier 2 only — paths not in eventAttributedFiles) */
  snapshotOnlyFiles: SnapshotFileChange[];
  onConfirm: (requestId: string, files: UndoFileInstruction[]) => void;
  onClose: () => void;
}
```

### Drift warning

If `afterHash` exists and current file hash differs at dialog-open time, show:

- amber warning icon
- helper text: `File has changed since this prompt completed`

This is especially important for per-diff undo, where later retries or later prompts may already have touched the same file.

### Footer

- `Cancel`
- `Undo selected (N)`

Disable confirm when `N === 0`.

On success:

- close dialog
- show toast / VS Code notification summary

Do not mutate historical output UI to pretend the prompt was never run. The output remains historical evidence; undo is a workspace operation, not an output rewrite.

## Prompt Panel Wiring

### `PromptsPanel.tsx`

This component already has the right context:

- workflow execution state
- history-mode state
- CLI-managed state
- access to live/history outputs per prompt

Add a history-aware step data lookup that returns:

- all `cliOutputs` for the target
- `workspaceSnapshot` for the target
- derived undo summary

Pass an `undoAction` prop down to `PromptItem` / `PromptItemDetails`.

### `PromptItem.tsx` and `PromptItemDetails.tsx`

Add an optional action slot or dedicated prop for the prompt-level undo button.

Do not force `PromptItemDetails` itself to understand undo attribution. It should only render a supplied action and count.

## Output Wiring

### `OutputSection.tsx`

`CliOutput` currently does not know whether the UI is in history mode. It needs that gating information.

Pass down:

- `target`
- `isViewingHistory`
- `allowUndoActions`

### `CliOutput.tsx`

This component should stop owning the primary prompt-level undo button.

Its role in v1:

- pass execution target / attempt context to rendered events
- host `UndoChangesDialog` state when an inline file-level undo button is clicked

Show the inline undo trigger when:

- `!output.isStreaming`
- `allowUndoActions === true`
- at least one of: event-attributed files exist OR `workspaceSnapshot?.changedFiles.length > 0`

Trigger appearance: small inline link in stats bar — `↩ Undo changes (N)` where N = total undoable file count.

### `ToolCallOutput.tsx`

Add compact undo buttons to:

- `FileEditOutput`
- `FileWriteOutput`
- `FileDeleteOutput`

Those buttons should call back up with:

```ts
{
  target,
  attemptIndex,
  path,
  eventType
}
```

Then `CliOutput` opens the shared dialog in single-file mode.

## Result Routing

Keep undo result state ephemeral.

In `workflowStore.ts`:

```ts
undoResults: Record<string, UndoResult>;
setUndoResult(requestId: string, result: UndoResult): void;
clearUndoResult(requestId: string): void;
```

`useMessageHandler.ts` writes `UNDO_PROMPT_RESULT` into the store keyed by `requestId`.

The dialog component watches the `requestId` it created and reacts when the result arrives.

## File Change Summary

| File | Change |
|---|---|
| `src/types/OutputHistoryTypes.ts` | Add `workspaceSnapshot` to `StepOutput`; add `WorkspaceSnapshot`, `SnapshotFileChange` |
| `src/types/DashboardConstants.ts` | Add `STEP_UNDO_DATA_UPDATED`, `UNDO_PROMPT_CHANGES`, `UNDO_PROMPT_RESULT` |
| `src/types/WebviewMessageTypes.ts` | Add target-based undo message types and `UndoFileInstruction` / `UndoResult` |
| `src/utils/WorkspaceSnapshotService.ts` | New service for state capture, hashing, and restore |
| `src/flightpath/WorkflowExecutor.ts` | Capture before/after snapshots around full target execution and emit/persist undo metadata |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Persist `workspaceSnapshot` with merged step output |
| `src/ui/FlightPathWebviewProvider.ts` | Emit live undo metadata, handle undo requests |
| `src/ui/WebviewMessageRouter.ts` | Route `UNDO_PROMPT_CHANGES` |
| `src/ui/webview-react/store/workflowStore.ts` | Add live workspace snapshots and undo result routing |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Handle `STEP_UNDO_DATA_UPDATED` and `UNDO_PROMPT_RESULT` |
| `src/ui/webview-react/utils/promptUndo.ts` | New shared file-attribution / dialog-input utility |
| `src/ui/webview-react/components/prompts/PromptItemDetails.tsx` | Render prompt-level undo action |
| `src/ui/webview-react/components/prompts/PromptItem.tsx` | Accept/present undo action props |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx` | Compute undo summary and wire prompt-level button |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Pass target/history gating into `CliOutput` |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Own dialog open state for inline file undo |
| `src/ui/webview-react/components/output/ToolCallOutput.tsx` | Add inline file-level undo buttons |
| `src/ui/webview-react/components/output/UndoChangesDialog.tsx` | New shared review-and-confirm dialog |

## Edge Cases

| Scenario | Handling |
|---|---|
| Workspace is not a git repo | fall back to filesystem strategy; `wasAtHead` always false; `git restore` unavailable but `restore-content` works |
| Git not installed | same fallback |
| Non-git repo with `.gitignore` | `.gitignore` patterns parsed and applied during filesystem walk |
| Build artifacts (`dist/`, `node_modules/`) | git strategy: invisible to `git status --porcelain` (gitignored); filesystem strategy: excluded by hardcoded defaults |
| Prompt had retries | one before snapshot, one after snapshot, aggregate all attempts |
| Snapshot capture fails entirely | Tier 1 event-attributed undo still works |
| `FILE_DELETE` has no restore content | look up path in snapshot; if absent, mark non-undoable |
| `FILE_DELETE` was at HEAD | use `git restore` action |
| Prompt had only bash-driven changes | dialog still works using Tier 2 entries |
| Copilot CLI / Copilot Chat with no structured file events | prompt-level undo is snapshot-driven only; all files shown with Tier 2 warning |
| No snapshot AND no file events | undo trigger not shown (nothing to undo) |
| File exceeds size limit or is binary | show disabled row with explanation (`contentCaptureSkipped: true`) |
| File already deleted before undo | delete action treated as no-op success |
| Parent directory was deleted | `restore-content` recreates parents |
| File changed after prompt completed | show drift warning using `afterHash` comparison |
| Parallel workflows modifying overlapping files | Tier 2 files shown unchecked with warning; user decides |
| Multiple prompts changed same file | no automatic conflict resolution; user is warned and reviews per file |
| User is viewing history | destructive undo buttons hidden/disabled |
| Workflow is currently running | destructive undo buttons hidden/disabled |
| CLI-managed watch mode | destructive undo buttons hidden/disabled in v1 |

## Not In Scope

- redo
- batch undo across multiple prompts
- destructive undo while viewing history
- final-prompt footer aggregate undo button
- binary-file undo
- full gitignore spec compliance in filesystem mode (negation patterns, `**` globs, etc.)
- automatic merge/conflict resolution when later prompts changed the same file
- reverse-patch application via `git apply --reverse` (resolve to `contentToRestore` in webview instead)
