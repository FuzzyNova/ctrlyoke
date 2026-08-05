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
  MAX_CONTENT_SIZE,
  type DiffChangeType,
} from "@root/types/DashboardConstants";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { hasRenderableDiff } from "@utils/diffUtils";

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
    instruction: UndoFileInstruction;
  }>;
  /** True when the aggregate diff could not be composed and is only partial. */
  isPartialDiff: boolean;
}

/** Render-ready file data shared by all four undo/redo dialog modes. */
export interface PromptUndoDialogRow extends Omit<
  DiffFileCardProps,
  "selection"
> {
  key: string;
  instruction: UndoFileInstruction | null;
  hasDiff: boolean;
  disabledReason?: string;
}

export interface PromptUndoDialogGroup {
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
  snapshotFiles: SnapshotFileChange[]
): UndoFileInstruction | null {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const d = event.data as FileWriteData;
      if (!d.path) return null;
      return { path: d.path, action: UNDO_FILE_ACTIONS.DELETE };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const d = event.data as FileDeleteData;
      if (!d.path) return null;
      const snap = snapshotFiles.find((f) => sameFilePath(f.path, d.path));
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
  const na = a.replace(/\\/g, "/").toLowerCase();
  const nb = b.replace(/\\/g, "/").toLowerCase();
  if (na === nb) return true;
  // One is absolute, the other is a relative suffix of the absolute path.
  return na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

/** Map a CLI event type to a PromptChangeType for display purposes. */
function eventTypeToChangeType(eventType: string): PromptChangeType | null {
  switch (eventType) {
    case CLI_EVENT_TYPES.FILE_EDIT:
      return "modified";
    case CLI_EVENT_TYPES.FILE_WRITE:
      return "created";
    case CLI_EVENT_TYPES.FILE_DELETE:
      return "deleted";
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
  snapshot: WorkspaceSnapshot | undefined
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

      const existing = accumMap.get(filePath);

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
        existing?.changeType === "created" ? "created" : changeType;

      if (
        event.type === CLI_EVENT_TYPES.FILE_WRITE &&
        resolvedChangeType === "created"
      ) {
        oldContent = "";
      }

      accumMap.set(filePath, {
        changeType: resolvedChangeType,
        oldContent,
        newContent,
        eventPatches,
        contentCaptureSkipped,
      });
    }
  }

  const tier1Candidates: UndoFileCandidate[] = Array.from(
    accumMap.entries()
  ).map(([filePath, accum]) => {
    // Use path-insensitive matching: CLI events emit absolute paths while the
    // workspace snapshot stores workspace-relative paths.
    const snapEntry = snapshotFiles.find((f) => sameFilePath(f.path, filePath));

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
      tier: "tier1",
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

  const tier1EventPaths = Array.from(accumMap.keys());

  // Collect Tier 2 candidates: snapshot entries not covered by any event.
  // Use path-insensitive matching so absolute event paths and relative snapshot
  // paths are correctly treated as the same file.
  const tier2Candidates: UndoFileCandidate[] = snapshotFiles
    .filter((snap) => !tier1EventPaths.some((p) => sameFilePath(snap.path, p)))
    .map((snap) => ({
      path: snap.path,
      changeType: snap.changeType,
      tier: "tier2",
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
    case "modified": {
      if (snap.structuredPatch && snap.structuredPatch.length > 0)
        return {
          path: snap.path,
          action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
          structuredPatch: snap.structuredPatch,
          lineEnding: snap.lineEnding,
        };
      return null;
    }
    case "deleted": {
      if (snap.contentToRestore != null)
        return {
          path: snap.path,
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: snap.contentToRestore,
        };
      return null;
    }
    case "created":
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
    changeType: fromPromptChangeType(options.changeType),
    source: buildDiffSource(oldContent, newContent, structuredPatch),
    language: getLanguageFromPath(options.path),
    globallyCollapsed: true,
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
    return "deleted";
  }
  if (
    instruction.action === UNDO_FILE_ACTIONS.RESTORE_CONTENT &&
    !instruction.structuredPatch
  ) {
    return "created";
  }
  return "modified";
}

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
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
  const patched = Diff.applyPatch(
    content.replace(/\r\n/g, "\n"),
    formatStructuredPatch("workflow-file", hunks, reverse)
  );
  return patched === false ? undefined : patched;
}

interface AggregationPart {
  path: string;
  changeType: DiffChangeType;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
  contentCaptureSkipped?: boolean;
  step: AggregatedUndoFile["steps"][number];
}

function getNetChangeType(
  first: DiffChangeType,
  last: DiffChangeType
): DiffChangeType | null {
  if (first === "created" && last === "deleted") return null;
  if (first === "created") return "created";
  if (last === "deleted") return "deleted";
  if (first === "deleted" && last === "created") return "modified";
  return "modified";
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
  const base = first.oldContent ?? (changeType === "created" ? "" : undefined);

  if (base !== undefined) {
    let composed = base;
    let composedSuccessfully = true;

    for (const part of parts) {
      if (part.changeType === "deleted") {
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
): AggregationPart | null {
  if (!candidate.instruction) return null;
  const instruction = candidate.instruction;
  let oldContent = candidate.oldContent;
  let newContent = candidate.newContent;

  if (instruction.action === UNDO_FILE_ACTIONS.RESTORE_CONTENT) {
    oldContent ??= instruction.contentToRestore;
    if (candidate.changeType === "deleted") newContent = "";
  } else if (candidate.changeType === "created") {
    oldContent ??= "";
  }

  return {
    path: candidate.path,
    changeType: fromPromptChangeType(candidate.changeType),
    oldContent,
    newContent,
    structuredPatch: candidate.structuredPatch,
    contentCaptureSkipped: candidate.contentCaptureSkipped,
    step: { target: entry.target, label: entry.label, instruction },
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
    step: { target: entry.target, label: entry.label, instruction },
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
  const partsByFile: AggregationPart[] = [];

  for (const entry of entries) {
    if (entry.redoInstructions && entry.redoInstructions.length > 0) {
      partsByFile.push(
        ...entry.redoInstructions.map((instruction) =>
          buildRedoAggregationPart(entry, instruction)
        )
      );
    } else {
      for (const candidate of entry.undoCandidates ?? []) {
        const part = buildUndoAggregationPart(entry, candidate);
        if (part) partsByFile.push(part);
      }
    }
  }

  const aggregates: Array<{ parts: AggregationPart[] }> = [];
  for (const part of partsByFile) {
    const existing = aggregates.find((aggregate) =>
      sameFilePath(aggregate.parts[0].path, part.path)
    );
    if (existing) existing.parts.push(part);
    else aggregates.push({ parts: [part] });
  }

  return aggregates.flatMap(({ parts }) => {
    const changeType = getNetChangeType(
      parts[0].changeType,
      parts[parts.length - 1].changeType
    );
    if (!changeType) return [];

    const composed = composeAggregateDiff(parts, changeType);
    return [
      {
        key: normalizeFilePath(parts[0].path),
        path: parts[0].path,
        changeType,
        oldContent: composed.oldContent,
        newContent: composed.newContent,
        structuredPatch: composed.structuredPatch,
        steps: parts.map((part) => part.step),
        isPartialDiff:
          composed.isPartialDiff ||
          parts.some((part) => part.contentCaptureSkipped),
      },
    ];
  });
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
    changeType: file.changeType,
    source: buildDiffSource(oldContent, newContent, structuredPatch),
    language: getLanguageFromPath(file.path),
    globallyCollapsed: true,
    instruction: file.steps[0]?.instruction ?? null,
    hasDiff: hasRenderableDiff({ oldContent, newContent, structuredPatch }),
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
    changeType: redoInstructionToDiffChangeType(instruction),
    source: buildDiffSource(undefined, undefined, structuredPatch),
    language: getLanguageFromPath(instruction.path),
    globallyCollapsed: true,
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
  mode: "undo" | "redo";
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  workflowEntries?: WorkflowStepEntry[];
}): PromptUndoDialogModel {
  const { mode, input, redoInstructions, workflowEntries } = options;
  const isWorkflowMode = (workflowEntries?.length ?? 0) > 0;

  if (isWorkflowMode) {
    const aggregationEntries = (workflowEntries ?? []).map((entry) =>
      mode === "redo"
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
    const groups: PromptUndoDialogGroup[] = [{ files: workflowRows }];
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
    mode === "redo"
      ? (redoInstructions ?? []).map((instruction) =>
          buildRedoDialogRow(instruction, instruction.path)
        )
      : [];
  const tier1Rows =
    mode === "undo"
      ? (input?.eventAttributedFiles ?? []).map((candidate) =>
          buildCandidateRow(candidate)
        )
      : [];
  const tier2Rows =
    mode === "undo"
      ? (input?.snapshotOnlyFiles ?? []).map((snapshotFile) =>
          buildCandidateRow({
            path: snapshotFile.path,
            changeType: snapshotFile.changeType,
            tier: "tier2",
            instruction: resolveSnapshotUndoInstruction(snapshotFile),
            contentCaptureSkipped: snapshotFile.contentCaptureSkipped,
            oldContent: snapshotFile.beforeContent,
            structuredPatch: snapshotFile.structuredPatch,
          })
        )
      : [];
  const allUndoRows = [...tier1Rows, ...tier2Rows];

  const groups: PromptUndoDialogGroup[] =
    mode === "redo"
      ? [{ files: redoRows }]
      : [
          {
            heading: "Changes the AI reported",
            headingHint:
              "The harness told us it made these edits, so we know exactly what changed.",
            files: tier1Rows,
          },
          {
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
  hasTier2: boolean;
  hasNonUndoable: boolean;
} {
  return {
    undoableCount: candidates.filter((c) => c.instruction !== null).length,
    hasTier2: candidates.some((c) => c.tier === "tier2"),
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
  const scope: UndoDialogScope = { mode: "prompt", target };
  const allCandidates = buildUndoCandidatesForOutputs(cliOutputs, snapshot);

  // Strip out files already undone (present in redo instructions).
  const candidates =
    excludePaths && excludePaths.length > 0
      ? allCandidates.filter(
          (c) => !excludePaths.some((ep) => sameFilePath(c.path, ep.path))
        )
      : allCandidates;

  const tier2Paths = new Set(
    candidates.filter((c) => c.tier === "tier2").map((c) => c.path)
  );
  return {
    scope,
    eventAttributedFiles: candidates.filter((c) => c.tier === "tier1"),
    snapshotOnlyFiles: (snapshot?.changedFiles ?? []).filter(
      (s) =>
        tier2Paths.has(s.path) &&
        !(excludePaths ?? []).some((ep) => sameFilePath(s.path, ep.path))
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
    mode: "singleFile",
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
    instruction = resolveEventUndoInstruction(event, snapshotFiles);
  }

  const candidate: UndoFileCandidate = {
    path,
    changeType,
    tier: "tier1",
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

/**
 * The available undo and redo actions for a prompt step.
 * Both can be non-null simultaneously — "mixed state" — when the user has
 * undone some files in the step but not all of them.
 */
export interface PromptUndoActions {
  undo: { label: string; count: number } | null;
  redo: { label: string; count: number } | null;
}

/**
 * Compute which prompt-level undo/redo actions are available for a step.
 *
 * Used by both CliOutput (header button) and OutputSection (minimap popup)
 * so the logic is never duplicated.
 */
export function computePromptUndoActions(
  allStepOutputs: CliOutput[],
  effectiveUndoRecord: UndoRecord | undefined,
  effectiveSnapshot: WorkspaceSnapshot | undefined
): PromptUndoActions {
  // Redo: files that were previously undone and can be redone.
  // Only available while isRedone is falsy (a redo resets the record).
  const redoCount =
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
  const candidates =
    redoInstructions.length > 0
      ? allCandidates.filter(
          (c) => !redoInstructions.some((ri) => sameFilePath(c.path, ri.path))
        )
      : allCandidates;
  const { undoableCount } = getPromptUndoSummary(candidates);

  return {
    undo:
      undoableCount > 0
        ? {
            label: `Undo ${undoableCount} change${undoableCount !== 1 ? "s" : ""}`,
            count: undoableCount,
          }
        : null,
    redo:
      redoCount > 0
        ? {
            label: `Redo ${redoCount} change${redoCount !== 1 ? "s" : ""}`,
            count: redoCount,
          }
        : null,
  };
}
