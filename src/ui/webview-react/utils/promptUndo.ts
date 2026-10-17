/**
 * Prompt undo utility for the React webview.
 *
 * Extracts file change candidates from CliOutput structured events (Tier 1) and
 * workspace snapshots (Tier 2), then builds UndoDialogInput for the undo dialog.
 */
import { UNDO_FILE_ACTIONS } from "../types/messages";
import type {
  CliOutput,
  UndoFileInstruction,
  UndoFileCandidate,
} from "../types/messages";
import type {
  CliEvent,
  FileEditData,
  FileWriteData,
  FileDeleteData,
  UnifiedDiffHunk,
} from "../types/cliEvents";
import { CLI_EVENT_TYPES } from "../types/cliEvents";
import type {
  WorkspaceSnapshot,
  SnapshotFileChange,
  UndoExecutionTarget,
  UndoDialogScope,
  PromptChangeType,
  UndoRecord,
} from "@root/types/OutputHistoryTypes";
import * as Diff from "diff";
import { fromPromptChangeType, type DiffFileCardProps } from "@components/diff";
import {
  FINAL_STEP_PHASES,
  FILE_OPERATION_KINDS,
  MAX_CONTENT_SIZE,
  UNDO_REDO_DIRECTIONS,
  UNDO_DIALOG_SCOPE_MODES,
  type DiffChangeType,
  type UndoRedoDirection,
} from "@root/types/DashboardConstants";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { hasRenderableDiff, normalizeStructuredPatch } from "@utils/diffUtils";
import {
  normalizeCliFilePathKey,
  sameCliFilePath,
} from "@root/utils/CliEventVisibility";

export const UNDO_FILE_CANDIDATE_TIERS = {
  TIER1: "tier1",
  TIER2: "tier2",
} as const;

export interface UndoDialogInput {
  scope: UndoDialogScope;
  /** Tier 1 candidates: attributed to structured CLI events (high confidence) */
  eventAttributedFiles: UndoFileCandidate[];
  /** Tier 2 candidates: snapshot-only entries with no corresponding event */
  snapshotOnlyFiles: SnapshotFileChange[];
  workspacePath: string;
}

/** A single step's data for workflow-level undo/redo dialogs. */
export interface WorkflowStepEntry {
  target: UndoExecutionTarget;
  label: string;
  undoCandidates?: UndoFileCandidate[];
  redoInstructions?: UndoFileInstruction[];
}

export interface AggregatedUndoFile {
  /** Normalized key used to merge across steps (sameFilePath semantics). */
  key: string;
  /** Display path, from the first step that touched it. */
  path: string;
  changeType: DiffChangeType;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
  /** Steps that touched this file, ascending, each with its own instruction. */
  steps: Array<{
    target: UndoExecutionTarget;
    label: string;
    instruction: UndoFileInstruction | null;
    direction: UndoRedoDirection;
  }>;
  direction: UndoRedoDirection;
  contentCaptureSkipped: boolean;
  /** True when the aggregate diff could not be composed and is only partial. */
  isPartialDiff: boolean;
}

/** Render-ready file data shared by all four undo/redo dialog modes. */
export interface PromptUndoDialogRow extends Omit<
  DiffFileCardProps,
  "selection"
> {
  key: string;
  direction: UndoRedoDirection;
  instruction: UndoFileInstruction | null;
  hasDiff: boolean;
  disabledReason?: string;
}

export interface PromptUndoDialogGroup {
  /** Stable semantic identity used by the shared diff row projection. */
  key?: string;
  heading?: string;
  headingHint?: string;
  files: PromptUndoDialogRow[];
}

export interface PromptUndoDialogModel {
  workflowRows: PromptUndoDialogRow[];
  workflowFiles: AggregatedUndoFile[];
  redoRows: PromptUndoDialogRow[];
  tier1Rows: PromptUndoDialogRow[];
  tier2Rows: PromptUndoDialogRow[];
  allUndoRows: PromptUndoDialogRow[];
  groups: PromptUndoDialogGroup[];
}

export interface SpecificEventDiffFallback {
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
}

/**
 * Resolve an undo instruction for a single FILE_WRITE or FILE_DELETE event.
 * Used by buildUndoDialogInputForSpecificEvent for per-event (not prompt-level) undo.
 * FILE_EDIT is handled separately via reverse-patch on the event's structuredPatch.
 */
function resolveEventUndoInstruction(
  event: CliEvent,
  snapshotFiles: SnapshotFileChange[],
  workspaceRoot?: string
): UndoFileInstruction | null {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const d = event.data as FileWriteData;
      if (!d.path) return null;
      const snap = resolveSnapshotFileMatch(
        snapshotFiles,
        d.path,
        workspaceRoot
      );
      return snap ? resolveSnapshotUndoInstruction(snap) : null;
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const d = event.data as FileDeleteData;
      if (!d.path) return null;
      const snap = resolveSnapshotFileMatch(
        snapshotFiles,
        d.path,
        workspaceRoot
      );
      if (!snap) return null;
      if (snap.contentToRestore != null)
        return {
          path: d.path,
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: snap.contentToRestore,
        };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Compare two file paths for equality, tolerating the mismatch between
 * absolute CLI event paths (`C:\dev\ctrlyoke\manual-test\temp.txt`) and
 * workspace-relative snapshot paths (`manual-test/temp.txt`).
 */
export function sameFilePath(a: string, b: string): boolean {
  return sameCliFilePath(a, b);
}

/** A file is redoable only when its undo record still contains its instruction. */
export function hasFileRedoInstruction(
  undoRecord: UndoRecord | undefined,
  path: string
): boolean {
  return (
    undoRecord != null &&
    undoRecord.isRedone !== true &&
    undoRecord.redoInstructions.some((instruction) =>
      sameFilePath(instruction.path, path)
    )
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isAbsolutePath(path: string): boolean {
  // Normalize separators first: Windows CLI events report `C:\dev\...`.
  const normalizedPath = path.replace(/\\/g, "/");
  return normalizedPath.startsWith("/") || /^[a-z]:\//i.test(normalizedPath);
}

function relativizeToWorkspace(
  path: string,
  workspaceRoot: string
): string | undefined {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(workspaceRoot);
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return undefined;
}

/** Resolve one snapshot entry for an event path, preferring exact and most-specific matches. */
export function resolveSnapshotFileMatch<T extends { path: string }>(
  snapshotFiles: T[],
  eventPath: string,
  workspaceRoot?: string
): T | undefined {
  let comparableEventPath = eventPath;
  if (workspaceRoot && isAbsolutePath(eventPath)) {
    const relativePath = relativizeToWorkspace(eventPath, workspaceRoot);
    if (relativePath === undefined) return undefined;
    comparableEventPath = relativePath;
  }

  const normalizedEventPath = normalizePath(comparableEventPath);
  const exactMatch = snapshotFiles.find(
    (file) => normalizePath(file.path) === normalizedEventPath
  );
  if (exactMatch) return exactMatch;

  // With a known root, relative paths must match exactly. Without one, use the
  // longest suffix to bridge event and snapshot paths without a root.
  if (workspaceRoot) return undefined;
  return snapshotFiles
    .filter((file) => {
      const normalizedSnapshotPath = normalizePath(file.path);
      return (
        normalizedEventPath.endsWith(`/${normalizedSnapshotPath}`) ||
        normalizedSnapshotPath.endsWith(`/${normalizedEventPath}`)
      );
    })
    .sort(
      (a, b) => normalizePath(b.path).length - normalizePath(a.path).length
    )[0];
}

/** Remove candidates that already have redo instructions for this prompt. */
export function excludeUndoneCandidates(
  candidates: UndoFileCandidate[],
  redoInstructions: UndoFileInstruction[],
  workspaceRoot?: string
): UndoFileCandidate[] {
  if (redoInstructions.length === 0) return candidates;

  const normalizeWorkspaceKey = (path: string): string | undefined => {
    if (workspaceRoot && isAbsolutePath(path)) {
      const relativePath = relativizeToWorkspace(path, workspaceRoot);
      return relativePath === undefined
        ? undefined
        : normalizePath(relativePath);
    }
    return normalizePath(path);
  };

  const redoKeys = new Set(
    redoInstructions
      .map((instruction) => normalizeWorkspaceKey(instruction.path))
      .filter((key): key is string => key !== undefined)
  );

  return candidates.filter((candidate) => {
    const path = candidate.instruction?.path ?? candidate.path;
    const key = normalizeWorkspaceKey(path);
    if (key !== undefined && redoKeys.has(key)) return false;

    // Without a workspace root, retain sameFilePath's absolute/relative
    // suffix matching for paths that cannot be reduced to a shared key.
    return (
      workspaceRoot != null ||
      !redoInstructions.some((instruction) =>
        sameFilePath(instruction.path, path)
      )
    );
  });
}

function getOutputWorkspaceRoot(cliOutputs: CliOutput[]): string | undefined {
  return cliOutputs.find((output) => output.workingDirectory)?.workingDirectory;
}

/** Map a CLI event type to a PromptChangeType for display purposes. */
function eventTypeToChangeType(eventType: string): PromptChangeType | null {
  switch (eventType) {
    case CLI_EVENT_TYPES.FILE_EDIT:
      return FILE_OPERATION_KINDS.MODIFIED;
    case CLI_EVENT_TYPES.FILE_WRITE:
      return FILE_OPERATION_KINDS.CREATED;
    case CLI_EVENT_TYPES.FILE_DELETE:
      return FILE_OPERATION_KINDS.DELETED;
    default:
      return null;
  }
}

/** Extract all file paths touched by FILE_EDIT/FILE_WRITE/FILE_DELETE events. */
export function getFileEventPaths(cliOutputs: CliOutput[]): Set<string> {
  const paths = new Set<string>();
  for (const output of cliOutputs) {
    const events = output.structured?.events;
    if (!events) continue;
    for (const event of events) {
      if (
        event.type !== CLI_EVENT_TYPES.FILE_EDIT &&
        event.type !== CLI_EVENT_TYPES.FILE_WRITE &&
        event.type !== CLI_EVENT_TYPES.FILE_DELETE
      )
        continue;
      const d = event.data as FileEditData | FileWriteData | FileDeleteData;
      if (d.path) paths.add(d.path);
    }
  }
  return paths;
}

/** Per-file accumulator used while building Tier 1 undo candidates. */
interface FileAccum {
  /** Display path: first-seen spelling is preserved when separators differ. */
  path: string;
  changeType: PromptChangeType;
  /** Display: first-write-wins (shows what the file looked like before AI touched it) */
  oldContent: string | undefined;
  /** Display: last-write-wins (shows the most recent change for context) */
  newContent: string | undefined;
  /** Per-event structured patches collected in order (fallback display when snapshot has none) */
  eventPatches: UnifiedDiffHunk[][];
  /** True when a FILE_WRITE payload exceeded the content capture limit. */
  contentCaptureSkipped: boolean;
}

function exceedsMaxContentSize(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > MAX_CONTENT_SIZE;
}

/**
 * Build the full list of undo candidates for a set of CliOutputs and an optional snapshot.
 *
 * Tier 1: derived from structured CLI events (high confidence).
 * Tier 2: snapshot-only entries whose paths are NOT covered by any event (lower confidence).
 *
 * Prompt-level undo strategy:
 *  1. Snapshot-based instruction — for all files (reverse-patch / restore-content / delete),
 *     derived from the workspace before→after diff captured around the prompt.
 *     Works for all harnesses and bash/CLI tool changes that have no structured events.
 *  2. null — no undo available (no snapshot entry or no patch data for the path).
 */
export function buildUndoCandidatesForOutputs(
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined,
  workspaceRoot = getOutputWorkspaceRoot(cliOutputs)
): UndoFileCandidate[] {
  const snapshotFiles: SnapshotFileChange[] = snapshot?.changedFiles ?? [];

  const accumMap = new Map<string, FileAccum>();

  for (const output of cliOutputs) {
    const events = output.structured?.events;
    if (!events) continue;
    for (const event of events) {
      const changeType = eventTypeToChangeType(event.type);
      if (!changeType) continue;
      const d = event.data as FileEditData | FileWriteData | FileDeleteData;
      const filePath = d.path;
      if (!filePath) continue;

      // If this specific event failed, skip it — don't let a failed event contribute
      // to the undo candidates. Prior successful events for the same path are preserved.
      if ((d as { success?: boolean }).success === false) {
        continue;
      }

      const pathKey = normalizeCliFilePathKey(filePath);
      const existing = accumMap.get(pathKey);

      let oldContent = existing?.oldContent;
      let newContent = existing?.newContent;
      const eventPatches = existing?.eventPatches ?? [];
      let contentCaptureSkipped = existing?.contentCaptureSkipped ?? false;

      if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
        const editData = d as FileEditData;
        // Display: first-write-wins for oldContent, last-write-wins for newContent
        if (oldContent === undefined) {
          oldContent = editData.oldContent;
        }
        newContent = editData.newContent;
        if (editData.structuredPatch && editData.structuredPatch.length > 0) {
          eventPatches.push(editData.structuredPatch);
        }
      } else if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
        const writeData = d as FileWriteData;
        if (exceedsMaxContentSize(writeData.content)) {
          newContent = undefined;
          contentCaptureSkipped = true;
        } else {
          newContent = writeData.content;
        }
      }

      // Preserve "created" once set — a FILE_WRITE followed by FILE_EDITs still
      // means the file was created during this prompt.
      const resolvedChangeType =
        existing?.changeType === FILE_OPERATION_KINDS.CREATED
          ? FILE_OPERATION_KINDS.CREATED
          : changeType;

      if (
        event.type === CLI_EVENT_TYPES.FILE_WRITE &&
        resolvedChangeType === FILE_OPERATION_KINDS.CREATED
      ) {
        oldContent = "";
      }

      accumMap.set(pathKey, {
        path: existing?.path ?? filePath,
        changeType: resolvedChangeType,
        oldContent,
        newContent,
        eventPatches,
        contentCaptureSkipped,
      });
    }
  }

  const matchedSnapshotIndexes = new Set<number>();
  const tier1Candidates: UndoFileCandidate[] = Array.from(
    accumMap.entries()
  ).map(([, accum]) => {
    const filePath = accum.path;
    const snapEntry = resolveSnapshotFileMatch(
      snapshotFiles,
      filePath,
      workspaceRoot
    );
    if (snapEntry) matchedSnapshotIndexes.add(snapshotFiles.indexOf(snapEntry));

    // Snapshot-based instruction (works for all harnesses and CLI tool changes).
    // No snapshot entry → non-undoable (instruction = null).
    const instruction = snapEntry
      ? resolveSnapshotUndoInstruction(snapEntry)
      : null;

    // For display: prefer the snapshot's structuredPatch (a single full before→after diff).
    // Fall back to the per-event patches combined — needed when the snapshot patch is absent
    // (e.g. content capture was skipped due to file size).
    const snapshotPatch = snapEntry?.structuredPatch;
    const displayPatch =
      snapshotPatch ??
      (accum.eventPatches.length > 0 ? accum.eventPatches.flat() : undefined);

    return {
      path: filePath,
      // Prefer the snapshot's changeType — it is authoritative about whether the
      // file existed before the prompt started. FILE_WRITE events are always mapped
      // to "created" by eventTypeToChangeType, but the AI may FILE_WRITE an existing
      // file (which the snapshot correctly records as "modified").
      changeType: snapEntry?.changeType ?? accum.changeType,
      tier: UNDO_FILE_CANDIDATE_TIERS.TIER1,
      instruction,
      oldContent: snapshotPatch
        ? snapEntry?.beforeContent
        : displayPatch
          ? undefined
          : accum.oldContent,
      newContent: displayPatch ? undefined : accum.newContent,
      structuredPatch: displayPatch,
      afterHash: snapEntry?.afterHash,
      contentCaptureSkipped:
        snapEntry?.contentCaptureSkipped || accum.contentCaptureSkipped,
    };
  });

  // Collect Tier 2 candidates: snapshot entries not covered by any event.
  const tier2Candidates: UndoFileCandidate[] = snapshotFiles
    .filter((_snap, index) => !matchedSnapshotIndexes.has(index))
    .map((snap) => ({
      path: snap.path,
      changeType: snap.changeType,
      tier: UNDO_FILE_CANDIDATE_TIERS.TIER2,
      instruction: resolveSnapshotUndoInstruction(snap),
      contentCaptureSkipped: snap.contentCaptureSkipped,
      oldContent: snap.beforeContent,
      afterHash: snap.afterHash,
      structuredPatch: snap.structuredPatch,
    }));

  return [...tier1Candidates, ...tier2Candidates];
}

/** Resolve an undo instruction for a snapshot file change. */
function resolveSnapshotUndoInstruction(
  snap: SnapshotFileChange
): UndoFileInstruction | null {
  switch (snap.changeType) {
    case FILE_OPERATION_KINDS.MODIFIED: {
      if (snap.structuredPatch && snap.structuredPatch.length > 0)
        return {
          path: snap.path,
          action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
          structuredPatch: snap.structuredPatch,
          lineEnding: snap.lineEnding,
        };
      return null;
    }
    case FILE_OPERATION_KINDS.DELETED: {
      if (snap.contentToRestore != null)
        return {
          path: snap.path,
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: snap.contentToRestore,
        };
      return null;
    }
    case FILE_OPERATION_KINDS.CREATED:
      return { path: snap.path, action: UNDO_FILE_ACTIONS.DELETE };
    default:
      return null;
  }
}

function buildDiffSource(
  oldContent: string | undefined,
  newContent: string | undefined,
  structuredPatch: UnifiedDiffHunk[] | undefined
): DiffFileCardProps["source"] {
  if (structuredPatch && structuredPatch.length > 0) {
    return { kind: "patch", structuredPatch, oldContent };
  }
  return { kind: "content", oldContent, newContent };
}

function buildUndoDialogRow(options: {
  key: string;
  path: string;
  direction: UndoRedoDirection;
  changeType: PromptChangeType;
  instruction: UndoFileInstruction | null;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
  contentCaptureSkipped?: boolean;
}): PromptUndoDialogRow {
  const { oldContent, newContent, structuredPatch } = options;
  return {
    key: options.key,
    path: options.path,
    direction: options.direction,
    changeType: fromPromptChangeType(options.changeType),
    source: buildDiffSource(oldContent, newContent, structuredPatch),
    language: getLanguageFromPath(options.path),
    instruction: options.instruction,
    hasDiff: hasRenderableDiff({
      oldContent,
      newContent,
      structuredPatch,
    }),
    disabledReason:
      options.instruction === null
        ? options.contentCaptureSkipped
          ? "Content not captured"
          : "Cannot undo"
        : undefined,
  };
}

function redoInstructionToDiffChangeType(
  instruction: UndoFileInstruction
): DiffChangeType {
  if (instruction.action === UNDO_FILE_ACTIONS.DELETE) {
    return FILE_OPERATION_KINDS.DELETED;
  }
  if (
    instruction.action === UNDO_FILE_ACTIONS.RESTORE_CONTENT &&
    !instruction.structuredPatch
  ) {
    return FILE_OPERATION_KINDS.CREATED;
  }
  return FILE_OPERATION_KINDS.MODIFIED;
}

function normalizeFilePath(path: string): string {
  return normalizeCliFilePathKey(path);
}

function sameUndoTarget(
  left: UndoExecutionTarget,
  right: UndoExecutionTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === FINAL_STEP_PHASES.FINAL_STEP
      ? left.loopIndex ===
        (right.kind === FINAL_STEP_PHASES.FINAL_STEP ? right.loopIndex : -1)
      : left.stepIndex ===
        (right.kind === FINAL_STEP_PHASES.QUEUE ? right.stepIndex : -1))
  );
}

function formatStructuredPatch(
  path: string,
  hunks: UnifiedDiffHunk[],
  reverse = false
): string {
  const header = [`--- ${path}`, `+++ ${path}`];
  const formattedHunks = hunks.map((hunk) => {
    const oldStart = reverse ? hunk.newStart : hunk.oldStart;
    const oldLines = reverse ? hunk.newLines : hunk.oldLines;
    const newStart = reverse ? hunk.oldStart : hunk.newStart;
    const newLines = reverse ? hunk.oldLines : hunk.newLines;
    const lines = reverse
      ? hunk.lines.map((line) => {
          if (line.startsWith("+")) return `-${line.slice(1)}`;
          if (line.startsWith("-")) return `+${line.slice(1)}`;
          return line;
        })
      : hunk.lines;
    return [
      `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      ...lines,
    ].join("\n");
  });
  return `${[...header, ...formattedHunks].join("\n")}\n`;
}

function applyStructuredPatch(
  content: string,
  hunks: UnifiedDiffHunk[],
  reverse = false
): string | undefined {
  try {
    const normalizedHunks = normalizeStructuredPatch(hunks);
    if (normalizedHunks.length === 0) return undefined;
    const patched = Diff.applyPatch(
      content.replace(/\r\n/g, "\n"),
      formatStructuredPatch("workflow-file", normalizedHunks, reverse)
    );
    return patched === false ? undefined : patched;
  } catch {
    return undefined;
  }
}

interface AggregationPart {
  path: string;
  changeType: DiffChangeType;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
  contentCaptureSkipped?: boolean;
  direction: UndoRedoDirection;
  step: AggregatedUndoFile["steps"][number];
}

function getNetChangeType(
  first: DiffChangeType,
  last: DiffChangeType
): DiffChangeType | null {
  if (
    first === FILE_OPERATION_KINDS.CREATED &&
    last === FILE_OPERATION_KINDS.DELETED
  )
    return null;
  if (first === FILE_OPERATION_KINDS.CREATED)
    return FILE_OPERATION_KINDS.CREATED;
  if (last === FILE_OPERATION_KINDS.DELETED)
    return FILE_OPERATION_KINDS.DELETED;
  if (
    first === FILE_OPERATION_KINDS.DELETED &&
    last === FILE_OPERATION_KINDS.CREATED
  )
    return FILE_OPERATION_KINDS.MODIFIED;
  return FILE_OPERATION_KINDS.MODIFIED;
}

function composeAggregateDiff(
  parts: AggregationPart[],
  changeType: DiffChangeType
): Pick<
  AggregatedUndoFile,
  "oldContent" | "newContent" | "structuredPatch" | "isPartialDiff"
> {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const base =
    first.oldContent ??
    (changeType === FILE_OPERATION_KINDS.CREATED ? "" : undefined);

  if (base !== undefined) {
    let composed = base;
    let composedSuccessfully = true;

    for (const part of parts) {
      if (part.changeType === FILE_OPERATION_KINDS.DELETED) {
        composed = "";
        continue;
      }
      if (part.structuredPatch && part.structuredPatch.length > 0) {
        const patched = applyStructuredPatch(composed, part.structuredPatch);
        if (patched === undefined) {
          composedSuccessfully = false;
          break;
        }
        composed = patched;
      } else if (part.newContent !== undefined) {
        composed = part.newContent;
      } else {
        composedSuccessfully = false;
        break;
      }
    }

    if (composedSuccessfully) {
      return {
        oldContent: base,
        newContent: composed,
        isPartialDiff: false,
      };
    }

    if (last.newContent !== undefined) {
      return {
        oldContent: base,
        newContent: last.newContent,
        isPartialDiff: false,
      };
    }
  }

  const patches = parts.flatMap((part) => part.structuredPatch ?? []);
  return {
    structuredPatch: patches.length > 0 ? patches : undefined,
    isPartialDiff: patches.length > 0,
  };
}

function buildUndoAggregationPart(
  entry: WorkflowStepEntry,
  candidate: UndoFileCandidate
): AggregationPart {
  const instruction = candidate.instruction;
  let oldContent = candidate.oldContent;
  let newContent = candidate.newContent;

  if (instruction?.action === UNDO_FILE_ACTIONS.RESTORE_CONTENT) {
    oldContent ??= instruction.contentToRestore;
    if (candidate.changeType === FILE_OPERATION_KINDS.DELETED) newContent = "";
  } else if (candidate.changeType === FILE_OPERATION_KINDS.CREATED) {
    oldContent ??= "";
  }

  return {
    path: candidate.path,
    changeType: fromPromptChangeType(candidate.changeType),
    oldContent,
    newContent,
    structuredPatch: candidate.structuredPatch,
    contentCaptureSkipped: candidate.contentCaptureSkipped,
    direction: UNDO_REDO_DIRECTIONS.UNDO,
    step: {
      target: entry.target,
      label: entry.label,
      instruction,
      direction: UNDO_REDO_DIRECTIONS.UNDO,
    },
  };
}

function buildRedoAggregationPart(
  entry: WorkflowStepEntry,
  instruction: UndoFileInstruction
): AggregationPart {
  const changeType = redoInstructionToDiffChangeType(instruction);
  let oldContent: string | undefined;
  let newContent: string | undefined;

  if (instruction.action === UNDO_FILE_ACTIONS.DELETE) {
    newContent = "";
  } else if (
    instruction.structuredPatch &&
    instruction.contentToRestore !== undefined
  ) {
    newContent = instruction.contentToRestore;
    oldContent = applyStructuredPatch(
      instruction.contentToRestore,
      instruction.structuredPatch,
      true
    );
  } else {
    oldContent = "";
    newContent = instruction.contentToRestore;
  }

  return {
    path: instruction.path,
    changeType,
    oldContent,
    newContent,
    structuredPatch: instruction.structuredPatch,
    direction: UNDO_REDO_DIRECTIONS.REDO,
    step: {
      target: entry.target,
      label: entry.label,
      instruction,
      direction: UNDO_REDO_DIRECTIONS.REDO,
    },
  };
}

/**
 * Merge per-step workflow undo or redo data into one row per file.
 *
 * Entries are expected in ascending workflow order. Callers select either the
 * undoCandidates or redoInstructions side before invoking this function.
 */
export function aggregateWorkflowUndoFiles(
  entries: WorkflowStepEntry[]
): AggregatedUndoFile[] {
  const aggregates = new Map<
    string,
    {
      path: string;
      byDirection: Map<UndoRedoDirection, AggregationPart[]>;
    }
  >();

  for (const entry of entries) {
    const partsForEntry = [
      ...(entry.undoCandidates ?? []).map((candidate) =>
        buildUndoAggregationPart(entry, candidate)
      ),
      ...(entry.redoInstructions ?? []).map((instruction) =>
        buildRedoAggregationPart(entry, instruction)
      ),
    ];
    for (const part of partsForEntry) {
      const pathKey = normalizeCliFilePathKey(part.path);
      let targetAggregate =
        aggregates.get(pathKey) ??
        [...aggregates.values()].find((aggregate) =>
          sameFilePath(aggregate.path, part.path)
        );
      if (!targetAggregate) {
        targetAggregate = {
          path: part.path,
          byDirection: new Map<UndoRedoDirection, AggregationPart[]>(),
        };
        aggregates.set(pathKey, targetAggregate);
      }
      const parts = targetAggregate.byDirection.get(part.direction) ?? [];
      parts.push(part);
      targetAggregate.byDirection.set(part.direction, parts);
    }
  }

  return [...aggregates.values()].flatMap(({ byDirection }) =>
    [...byDirection.entries()].flatMap(([direction, parts]) => {
      const changeType = getNetChangeType(
        parts[0].changeType,
        parts[parts.length - 1].changeType
      );
      if (!changeType) return [];

      const composed = composeAggregateDiff(parts, changeType);
      return [
        {
          key: `${normalizeFilePath(parts[0].path)}::${direction}`,
          path: parts[0].path,
          changeType,
          oldContent: composed.oldContent,
          newContent: composed.newContent,
          structuredPatch: composed.structuredPatch,
          steps: parts.reduce<AggregationPart["step"][]>((steps, part) => {
            const alreadyListed = steps.some((step) =>
              sameUndoTarget(step.target, part.step.target)
            );
            if (!alreadyListed) steps.push(part.step);
            return steps;
          }, []),
          direction,
          contentCaptureSkipped: parts.some(
            (part) => part.contentCaptureSkipped === true
          ),
          isPartialDiff:
            composed.isPartialDiff ||
            parts.some((part) => part.contentCaptureSkipped),
        },
      ];
    })
  );
}

function buildAggregatedDialogRow(
  file: AggregatedUndoFile
): PromptUndoDialogRow {
  const { oldContent, newContent, structuredPatch } = file;
  const noteParts = [file.steps.map((step) => step.label).join(", ")];
  if (file.isPartialDiff) {
    noteParts.push("diff shown per step; original content unavailable");
  }
  return {
    key: file.key,
    path: file.path,
    direction: file.direction,
    changeType: file.changeType,
    source: buildDiffSource(oldContent, newContent, structuredPatch),
    language: getLanguageFromPath(file.path),
    instruction: file.steps[0]?.instruction ?? null,
    hasDiff: hasRenderableDiff({ oldContent, newContent, structuredPatch }),
    disabledReason:
      file.steps[0]?.instruction === null
        ? file.contentCaptureSkipped
          ? "Content not captured"
          : "Cannot undo"
        : undefined,
    note: noteParts.join(" · "),
  };
}

function buildRedoDialogRow(
  instruction: UndoFileInstruction,
  key: string
): PromptUndoDialogRow {
  const structuredPatch = instruction.structuredPatch;
  return {
    key,
    path: instruction.path,
    direction: UNDO_REDO_DIRECTIONS.REDO,
    changeType: redoInstructionToDiffChangeType(instruction),
    source: buildDiffSource(undefined, undefined, structuredPatch),
    language: getLanguageFromPath(instruction.path),
    instruction,
    hasDiff: hasRenderableDiff({ structuredPatch }),
  };
}

function buildCandidateRow(
  candidate: UndoFileCandidate,
  key = candidate.path
): PromptUndoDialogRow {
  return buildUndoDialogRow({
    key,
    path: candidate.path,
    direction: UNDO_REDO_DIRECTIONS.UNDO,
    changeType: candidate.changeType,
    instruction: candidate.instruction,
    oldContent: candidate.oldContent,
    newContent: candidate.newContent,
    structuredPatch: candidate.structuredPatch,
    contentCaptureSkipped: candidate.contentCaptureSkipped,
  });
}

/** Build the render-ready data for all four undo/redo dialog modes. */
export function buildPromptUndoDialogModel(options: {
  mode: UndoRedoDirection;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  workflowEntries?: WorkflowStepEntry[];
}): PromptUndoDialogModel {
  const { mode, input, redoInstructions, workflowEntries } = options;
  const isWorkflowMode = (workflowEntries?.length ?? 0) > 0;

  if (isWorkflowMode) {
    const aggregationEntries = (workflowEntries ?? []).map((entry) =>
      mode === UNDO_REDO_DIRECTIONS.REDO
        ? {
            target: entry.target,
            label: entry.label,
            redoInstructions: entry.redoInstructions,
          }
        : {
            target: entry.target,
            label: entry.label,
            undoCandidates: entry.undoCandidates,
          }
    );
    const workflowFiles = aggregateWorkflowUndoFiles(aggregationEntries);
    const workflowRows = workflowFiles.map(buildAggregatedDialogRow);
    const groups: PromptUndoDialogGroup[] = [
      { key: "workflow-aggregate", files: workflowRows },
    ];
    return {
      workflowRows,
      workflowFiles,
      redoRows: [],
      tier1Rows: [],
      tier2Rows: [],
      allUndoRows: [],
      groups,
    };
  }

  const redoRows =
    mode === UNDO_REDO_DIRECTIONS.REDO
      ? (redoInstructions ?? []).map((instruction) =>
          buildRedoDialogRow(instruction, instruction.path)
        )
      : [];
  const tier1Rows =
    mode === UNDO_REDO_DIRECTIONS.UNDO
      ? (input?.eventAttributedFiles ?? []).map((candidate) =>
          buildCandidateRow(candidate)
        )
      : [];
  const tier2Rows =
    mode === UNDO_REDO_DIRECTIONS.UNDO
      ? (input?.snapshotOnlyFiles ?? []).map((snapshotFile) =>
          buildCandidateRow({
            path: snapshotFile.path,
            changeType: snapshotFile.changeType,
            tier: UNDO_FILE_CANDIDATE_TIERS.TIER2,
            instruction: resolveSnapshotUndoInstruction(snapshotFile),
            contentCaptureSkipped: snapshotFile.contentCaptureSkipped,
            oldContent: snapshotFile.beforeContent,
            structuredPatch: snapshotFile.structuredPatch,
          })
        )
      : [];
  const allUndoRows = [...tier1Rows, ...tier2Rows];

  const groups: PromptUndoDialogGroup[] =
    mode === UNDO_REDO_DIRECTIONS.REDO
      ? [{ key: UNDO_REDO_DIRECTIONS.REDO, files: redoRows }]
      : [
          {
            key: "reported",
            heading: "Changes the AI reported",
            headingHint:
              "The harness told us it made these edits, so we know exactly what changed.",
            files: tier1Rows,
          },
          {
            key: "detected",
            heading: "Other changes we detected",
            headingHint:
              "Found by comparing the workspace before and after — may include edits from other tools or another workflow running at the same time.",
            files: tier2Rows,
          },
        ];

  return {
    workflowRows: [],
    workflowFiles: [],
    redoRows,
    tier1Rows,
    tier2Rows,
    allUndoRows,
    groups,
  };
}

/** Summarise a list of candidates for display purposes. */
export function getPromptUndoSummary(candidates: UndoFileCandidate[]): {
  undoableCount: number;
  blockedCount: number;
  hasTier2: boolean;
  hasNonUndoable: boolean;
} {
  return {
    undoableCount: candidates.filter((c) => c.instruction !== null).length,
    blockedCount: candidates.filter((c) => c.instruction === null).length,
    hasTier2: candidates.some(
      (c) => c.tier === UNDO_FILE_CANDIDATE_TIERS.TIER2
    ),
    hasNonUndoable: candidates.some((c) => c.instruction === null),
  };
}

/**
 * Build the full dialog input for a prompt-level undo.
 *
 * @param excludePaths - Files already undone (from redoInstructions) that
 *   should not appear in the undo dialog. Matched via sameFilePath so that
 *   absolute CLI paths and workspace-relative snapshot paths compare correctly.
 */
export function buildUndoDialogInputForPrompt(
  target: UndoExecutionTarget,
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string,
  excludePaths?: UndoFileInstruction[]
): UndoDialogInput {
  const scope: UndoDialogScope = {
    mode: UNDO_DIALOG_SCOPE_MODES.PROMPT,
    target,
  };
  const allCandidates = buildUndoCandidatesForOutputs(
    cliOutputs,
    snapshot,
    workspacePath
  );

  // Strip out files already undone (present in redo instructions).
  const candidates = excludeUndoneCandidates(
    allCandidates,
    excludePaths ?? [],
    workspacePath
  );

  const tier2Paths = new Set(
    candidates
      .filter((c) => c.tier === UNDO_FILE_CANDIDATE_TIERS.TIER2)
      .map((c) => c.path)
  );
  return {
    scope,
    eventAttributedFiles: candidates.filter(
      (c) => c.tier === UNDO_FILE_CANDIDATE_TIERS.TIER1
    ),
    snapshotOnlyFiles: (snapshot?.changedFiles ?? []).filter((s) =>
      tier2Paths.has(s.path)
    ),
    workspacePath,
  };
}

/**
 * Build the dialog input for undoing a **specific** event (identified by its index in the
 * events array of a single CliOutput).  Unlike buildUndoDialogInputForSingleFile, this does
 * NOT use last-write-wins across all events for the path — it targets the exact event the
 * user clicked so that individual diffs can be undone independently.
 *
 * For FILE_EDIT events, uses reverse-patch rather than restore-content so that only the
 * clicked diff is reverted, leaving all other edits to the file intact.
 */
export function buildUndoDialogInputForSpecificEvent(
  target: UndoExecutionTarget,
  eventIndex: number,
  path: string,
  event: CliEvent | undefined,
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string,
  fallback?: SpecificEventDiffFallback
): UndoDialogInput {
  const scope: UndoDialogScope = {
    mode: UNDO_DIALOG_SCOPE_MODES.SINGLE_FILE,
    target,
    attemptIndex: eventIndex,
    path,
  };
  const snapshotFiles: SnapshotFileChange[] = snapshot?.changedFiles ?? [];

  if (!event) {
    return {
      scope,
      eventAttributedFiles: [],
      snapshotOnlyFiles: [],
      workspacePath,
    };
  }

  const changeType = eventTypeToChangeType(event.type);
  if (!changeType) {
    return {
      scope,
      eventAttributedFiles: [],
      snapshotOnlyFiles: [],
      workspacePath,
    };
  }

  // For FILE_EDIT: prefer reverse-patch so only this edit is undone (other edits stay intact).
  // Fall back to restore-content (via resolveEventUndoInstruction) only when no patch is available.
  let instruction: UndoFileInstruction | null;
  let oldContent = fallback?.oldContent;
  let newContent = fallback?.newContent;
  let structuredPatch = fallback?.structuredPatch;
  let snapshotFile: SnapshotFileChange | undefined;

  if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
    const editData = event.data as FileEditData;
    oldContent = oldContent ?? editData.oldContent;
    newContent = newContent ?? editData.newContent;
    structuredPatch =
      structuredPatch ??
      (editData.structuredPatch && editData.structuredPatch.length > 0
        ? editData.structuredPatch
        : undefined);

    if (structuredPatch && structuredPatch.length > 0) {
      // Reverse-patch: the extension reads the current file and applies this patch in reverse.
      instruction = {
        path,
        action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
        structuredPatch,
      };
    } else {
      // No structured patch — can't undo this specific edit.
      instruction = null;
    }
  } else {
    instruction = resolveEventUndoInstruction(
      event,
      snapshotFiles,
      workspacePath
    );
    if (
      event.type === CLI_EVENT_TYPES.FILE_WRITE ||
      event.type === CLI_EVENT_TYPES.FILE_DELETE
    ) {
      const eventPath = (event.data as FileWriteData | FileDeleteData).path;
      if (eventPath) {
        snapshotFile = resolveSnapshotFileMatch(
          snapshotFiles,
          eventPath,
          workspacePath
        );
      }
    }
  }

  const candidate: UndoFileCandidate = {
    path,
    changeType: snapshotFile?.changeType ?? changeType,
    tier: UNDO_FILE_CANDIDATE_TIERS.TIER1,
    instruction,
    oldContent,
    newContent,
    structuredPatch,
  };

  return {
    scope,
    eventAttributedFiles: [candidate],
    snapshotOnlyFiles: [],
    workspacePath,
  };
}

// ============================================================================
// Shared prompt-level undo/redo action computation
// ============================================================================

/** Counts and labels for every change row in a prompt scope. */
export interface PromptChangeSummary {
  total: number;
  undoable: number;
  undone: number;
  blocked: number;
  label: string;
  compactLabel: string;
  title: string;
}

export function createPromptChangeSummary(
  total: number,
  undoable: number,
  undone: number,
  blocked: number
): PromptChangeSummary {
  const undoneLabel =
    undone === 0
      ? ""
      : undone === total
        ? " (all undone)"
        : ` (${undone} undone)`;

  return {
    total,
    undoable,
    undone,
    blocked,
    label: `View ${total} change${total !== 1 ? "s" : ""}${undoneLabel}`,
    compactLabel: `View ${total}`,
    title: `${total} file${total !== 1 ? "s" : ""} changed${
      undone > 0 ? ` · ${undone} undone, can be redone` : ""
    }`,
  };
}

export function getPromptChangeLabelParts(
  summary: PromptChangeSummary,
  compact = false
): { main: string; undone: string } {
  if (compact) return { main: summary.compactLabel, undone: "" };
  const suffixStart = summary.label.indexOf(" (");
  return suffixStart < 0
    ? { main: summary.label, undone: "" }
    : {
        main: summary.label.slice(0, suffixStart),
        undone: summary.label.slice(suffixStart),
      };
}

/**
 * Compute the prompt-level change summary for a step.
 *
 * Used by both the output-row header and minimap so the logic is never
 * duplicated. The caller inputs remain per-target to preserve the memoized
 * performance boundary in outputRows.ts.
 */
export function computePromptChangeSummary(
  allStepOutputs: CliOutput[],
  effectiveUndoRecord: UndoRecord | undefined,
  effectiveSnapshot: WorkspaceSnapshot | undefined
): PromptChangeSummary {
  // Redo: files that were previously undone and can be redone.
  // The persisted record removes each redone path; isRedone marks the final one.
  const undone =
    effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
      ? (effectiveUndoRecord.redoInstructions?.length ?? 0)
      : 0;

  // Undo: files that can still be undone (may coexist with redo in mixed state).
  // Exclude paths already undone (present in redoInstructions) so the count
  // and dialog only show the remaining undoable files.
  const redoInstructions =
    effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
      ? (effectiveUndoRecord.redoInstructions ?? [])
      : [];
  const allCandidates = buildUndoCandidatesForOutputs(
    allStepOutputs,
    effectiveSnapshot
  );
  const candidates = excludeUndoneCandidates(
    allCandidates,
    redoInstructions,
    getOutputWorkspaceRoot(allStepOutputs)
  );
  const { undoableCount, blockedCount } = getPromptUndoSummary(candidates);
  return createPromptChangeSummary(
    undoableCount + blockedCount + undone,
    undoableCount,
    undone,
    blockedCount
  );
}
