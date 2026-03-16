/**
 * Prompt undo utility for the React webview.
 *
 * Extracts file change candidates from CliOutput structured events (Tier 1) and
 * workspace snapshots (Tier 2), then builds UndoDialogInput for the undo dialog.
 */
import type { CliOutput, UndoFileInstruction, UndoFileCandidate } from "../types/messages";
import type { CliEvent, FileEditData, FileWriteData, FileDeleteData } from "../types/cliEvents";
import { CLI_EVENT_TYPES } from "../types/cliEvents";
import type {
  WorkspaceSnapshot,
  SnapshotFileChange,
  UndoExecutionTarget,
  UndoDialogScope,
  PromptChangeType,
} from "@root/types/OutputHistoryTypes";

export interface UndoDialogInput {
  scope: UndoDialogScope;
  /** Tier 1 candidates: attributed to structured CLI events (high confidence) */
  eventAttributedFiles: UndoFileCandidate[];
  /** Tier 2 candidates: snapshot-only entries with no corresponding event */
  snapshotOnlyFiles: SnapshotFileChange[];
  workspacePath: string;
}

/** Determine the undo instruction for a single CLI event. */
export function resolveEventUndoInstruction(
  event: CliEvent,
  snapshotFiles: SnapshotFileChange[]
): UndoFileInstruction | null {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const d = event.data as FileEditData;
      if (!d.path) return null;
      // Only restore when we have the full pre-edit file content.
      // d.oldContent is the old_string substring passed to the edit tool, not the full
      // file — restoring the file to just that substring would delete everything else.
      if (d.originalFile != null)
        return { path: d.path, action: "restore-content", contentToRestore: d.originalFile };
      return null;
    }
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const d = event.data as FileWriteData;
      if (!d.path) return null;
      return { path: d.path, action: "delete" };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const d = event.data as FileDeleteData;
      if (!d.path) return null;
      const snap = snapshotFiles.find((f) => f.path === d.path);
      if (!snap) return null;
      if (snap.wasAtHead) return { path: d.path, action: "git-restore" };
      if (snap.contentToRestore != null)
        return { path: d.path, action: "restore-content", contentToRestore: snap.contentToRestore };
      return null;
    }
    default:
      return null;
  }
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
  /** structuredPatch arrays from every FILE_EDIT event, in chronological order */
  patches: NonNullable<UndoFileCandidate["structuredPatch"]>[];
  /** True if any FILE_EDIT for this file lacked a structuredPatch */
  anyMissingPatch: boolean;
  /** True if any non-FILE_EDIT event (FILE_WRITE / FILE_DELETE) touched this file */
  hasNonEditEvent: boolean;
  /** Fallback instruction from the first event — used for old history files (originalFile)
   *  and for non-edit events (delete / git-restore). */
  fallbackInstruction: UndoFileInstruction | null;
  /** Display: first-write-wins (shows what the file looked like before AI touched it) */
  oldContent: string | undefined;
  /** Display: last-write-wins (shows the most recent change for context) */
  newContent: string | undefined;
  /** Display: last-write-wins (most recent structured diff, for inline preview) */
  structuredPatch: UndoFileCandidate["structuredPatch"];
  afterHash: string | undefined;
  contentCaptureSkipped: boolean | undefined;
  wasAtHead: boolean | undefined;
}

/**
 * Build the full list of undo candidates for a set of CliOutputs and an optional snapshot.
 *
 * Tier 1: derived from structured CLI events (high confidence).
 * Tier 2: snapshot-only entries whose paths are NOT covered by any event (lower confidence).
 *
 * Prompt-level undo strategy for FILE_EDIT files (applied in priority order):
 *  1. reverse-patch-chain — when ALL FILE_EDIT events have a structuredPatch AND no
 *     non-edit event touched the file. Applies each patch in reverse (last→first) to
 *     reconstruct the pre-prompt state without storing full file content.
 *  2. restore-content    — fallback for old history files that stored originalFile on the
 *     first edit event. Used when any edit lacks a structuredPatch.
 *  3. null               — no undo available (harness never provided patch data or originalFile).
 *
 * FILE_WRITE / FILE_DELETE events are always handled via their own fallback logic
 * (delete / git-restore / restore-content from snapshot), never reverse-patch-chain.
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

      const snapEntry = snapshotFiles.find((f) => f.path === filePath);
      const existing = accumMap.get(filePath);

      let patches = existing?.patches ?? [];
      let anyMissingPatch = existing?.anyMissingPatch ?? false;
      let hasNonEditEvent = existing?.hasNonEditEvent ?? false;
      let fallbackInstruction = existing?.fallbackInstruction ?? null;
      let oldContent = existing?.oldContent;
      let newContent = existing?.newContent;
      let structuredPatch = existing?.structuredPatch;

      if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
        const editData = d as FileEditData;
        if (editData.structuredPatch && editData.structuredPatch.length > 0) {
          patches = [...patches, editData.structuredPatch];
        } else {
          anyMissingPatch = true;
        }
        // Fallback instruction: first FILE_EDIT's originalFile (backward compat with old history)
        if (fallbackInstruction === null) {
          fallbackInstruction = resolveEventUndoInstruction(event, snapshotFiles);
        }
        // Display: first-write-wins for oldContent, last-write-wins for newContent/patch
        if (oldContent === undefined) {
          oldContent = editData.originalFile ?? editData.oldContent;
        }
        newContent = editData.newContent;
        structuredPatch = editData.structuredPatch;
      } else {
        // FILE_WRITE or FILE_DELETE
        hasNonEditEvent = true;
        if (fallbackInstruction === null) {
          fallbackInstruction = resolveEventUndoInstruction(event, snapshotFiles);
        }
      }

      accumMap.set(filePath, {
        changeType,
        patches,
        anyMissingPatch,
        hasNonEditEvent,
        fallbackInstruction,
        oldContent,
        newContent,
        structuredPatch,
        afterHash: snapEntry?.afterHash ?? existing?.afterHash,
        contentCaptureSkipped: snapEntry?.contentCaptureSkipped ?? existing?.contentCaptureSkipped,
        wasAtHead: snapEntry?.wasAtHead ?? existing?.wasAtHead,
      });
    }
  }

  const tier1Candidates: UndoFileCandidate[] = Array.from(accumMap.entries()).map(
    ([filePath, accum]) => {
      let instruction: UndoFileInstruction | null;
      if (!accum.hasNonEditEvent && !accum.anyMissingPatch && accum.patches.length > 0) {
        // All events are FILE_EDITs and every one has a structuredPatch: use chain undo
        instruction = { path: filePath, action: "reverse-patch-chain", structuredPatches: accum.patches };
      } else {
        // Fall back to restore-content (old history) / delete / git-restore / null
        instruction = accum.fallbackInstruction;
      }
      return {
        path: filePath,
        changeType: accum.changeType,
        tier: "tier1",
        instruction,
        oldContent: accum.oldContent,
        newContent: accum.newContent,
        structuredPatch: accum.structuredPatch,
        afterHash: accum.afterHash,
        contentCaptureSkipped: accum.contentCaptureSkipped,
        wasAtHead: accum.wasAtHead,
      };
    }
  );

  const tier1Paths = new Set(accumMap.keys());

  // Collect Tier 2 candidates: snapshot entries not covered by any event.
  const tier2Candidates: UndoFileCandidate[] = snapshotFiles
    .filter((snap) => !tier1Paths.has(snap.path))
    .map((snap) => ({
      path: snap.path,
      changeType: snap.changeType,
      tier: "tier2",
      instruction: resolveSnapshotUndoInstruction(snap),
      contentCaptureSkipped: snap.contentCaptureSkipped,
      afterHash: snap.afterHash,
      wasAtHead: snap.wasAtHead,
    }));

  return [...tier1Candidates, ...tier2Candidates];
}

/** Resolve an undo instruction for a snapshot-only (Tier 2) file. */
function resolveSnapshotUndoInstruction(snap: SnapshotFileChange): UndoFileInstruction | null {
  switch (snap.changeType) {
    case "modified": {
      if (snap.wasAtHead) return { path: snap.path, action: "git-restore" };
      if (snap.contentToRestore != null)
        return { path: snap.path, action: "restore-content", contentToRestore: snap.contentToRestore };
      return null;
    }
    case "deleted": {
      if (snap.wasAtHead) return { path: snap.path, action: "git-restore" };
      if (snap.contentToRestore != null)
        return { path: snap.path, action: "restore-content", contentToRestore: snap.contentToRestore };
      return null;
    }
    case "created":
      return { path: snap.path, action: "delete" };
    default:
      return null;
  }
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

/** Build the full dialog input for a prompt-level undo. */
export function buildUndoDialogInputForPrompt(
  target: UndoExecutionTarget,
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string
): UndoDialogInput {
  const scope: UndoDialogScope = { mode: "prompt", target };
  const candidates = buildUndoCandidatesForOutputs(cliOutputs, snapshot);
  const tier2Paths = new Set(candidates.filter((c) => c.tier === "tier2").map((c) => c.path));
  return {
    scope,
    eventAttributedFiles: candidates.filter((c) => c.tier === "tier1"),
    snapshotOnlyFiles: (snapshot?.changedFiles ?? []).filter((s) => tier2Paths.has(s.path)),
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
  events: CliEvent[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string
): UndoDialogInput {
  const scope: UndoDialogScope = { mode: "singleFile", target, attemptIndex: eventIndex, path };
  const snapshotFiles: SnapshotFileChange[] = snapshot?.changedFiles ?? [];

  const event = events[eventIndex];
  if (!event) {
    return { scope, eventAttributedFiles: [], snapshotOnlyFiles: [], workspacePath };
  }

  const changeType = eventTypeToChangeType(event.type);
  if (!changeType) {
    return { scope, eventAttributedFiles: [], snapshotOnlyFiles: [], workspacePath };
  }

  // For FILE_EDIT: prefer reverse-patch so only this edit is undone (other edits stay intact).
  // Fall back to restore-content (via resolveEventUndoInstruction) only when no patch is available.
  let instruction: UndoFileInstruction | null;
  let oldContent: string | undefined;
  let newContent: string | undefined;
  let structuredPatch: UndoFileCandidate["structuredPatch"];

  if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
    const editData = event.data as FileEditData;
    oldContent = editData.originalFile ?? editData.oldContent;
    newContent = editData.newContent;
    structuredPatch = editData.structuredPatch;

    if (structuredPatch && structuredPatch.length > 0) {
      // Reverse-patch: the extension reads the current file and applies this patch in reverse.
      instruction = { path, action: "reverse-patch", structuredPatch };
    } else {
      // No structured patch — fall back to restore-content with originalFile if available.
      instruction = resolveEventUndoInstruction(event, snapshotFiles);
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

/** Build the dialog input for a single-file undo from a diff row. */
export function buildUndoDialogInputForSingleFile(
  target: UndoExecutionTarget,
  attemptIndex: number,
  path: string,
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string
): UndoDialogInput {
  const scope: UndoDialogScope = { mode: "singleFile", target, attemptIndex, path };
  const allCandidates = buildUndoCandidatesForOutputs(cliOutputs, snapshot);
  const fileCandidates = allCandidates.filter((c) => c.path === path);
  const tier2Paths = new Set(fileCandidates.filter((c) => c.tier === "tier2").map((c) => c.path));
  return {
    scope,
    eventAttributedFiles: fileCandidates.filter((c) => c.tier === "tier1"),
    snapshotOnlyFiles: (snapshot?.changedFiles ?? []).filter((s) => tier2Paths.has(s.path)),
    workspacePath,
  };
}
