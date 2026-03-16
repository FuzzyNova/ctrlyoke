/**
 * Prompt undo utility for the React webview.
 *
 * Extracts file change candidates from CliOutput structured events (Tier 1) and
 * workspace snapshots (Tier 2), then builds UndoDialogInput for the undo dialog.
 */
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
} from "../types/cliEvents";
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
      return { path: d.path, action: "delete" };
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const d = event.data as FileDeleteData;
      if (!d.path) return null;
      const snap = snapshotFiles.find((f) => f.path === d.path);
      if (!snap) return null;
      if (snap.wasAtHead) return { path: d.path, action: "git-restore" };
      if (snap.contentToRestore != null)
        return {
          path: d.path,
          action: "restore-content",
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
 * absolute CLI event paths (`C:\dev\FlightPath\manual-test\temp.txt`) and
 * workspace-relative snapshot paths (`manual-test/temp.txt`).
 */
function sameFilePath(a: string, b: string): boolean {
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
}

/**
 * Build the full list of undo candidates for a set of CliOutputs and an optional snapshot.
 *
 * Tier 1: derived from structured CLI events (high confidence).
 * Tier 2: snapshot-only entries whose paths are NOT covered by any event (lower confidence).
 *
 * Prompt-level undo strategy:
 *  1. Snapshot-based instruction — for all files (git-restore / reverse-patch / restore-content
 *     / delete), derived from the workspace before→after diff captured around the prompt.
 *     Works for all harnesses and bash/CLI tool changes that have no structured events.
 *  2. null — no undo available (no snapshot entry for the path).
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

      // If the tool execution explicitly failed, discard any accumulated state for this
      // path — the operation had no filesystem effect and should not appear as undoable.
      if ((d as { success?: boolean }).success === false) {
        accumMap.delete(filePath);
        continue;
      }

      const existing = accumMap.get(filePath);

      let oldContent = existing?.oldContent;
      let newContent = existing?.newContent;

      if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
        const editData = d as FileEditData;
        // Display: first-write-wins for oldContent, last-write-wins for newContent
        if (oldContent === undefined) {
          oldContent = editData.oldContent;
        }
        newContent = editData.newContent;
      }

      // Preserve "created" once set — a FILE_WRITE followed by FILE_EDITs still
      // means the file was created during this prompt.
      const resolvedChangeType =
        existing?.changeType === "created" ? "created" : changeType;

      accumMap.set(filePath, {
        changeType: resolvedChangeType,
        oldContent,
        newContent,
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

    return {
      path: filePath,
      changeType: accum.changeType,
      tier: "tier1",
      instruction,
      oldContent: accum.oldContent,
      newContent: accum.newContent,
      structuredPatch: snapEntry?.structuredPatch,
      afterHash: snapEntry?.afterHash,
      contentCaptureSkipped: snapEntry?.contentCaptureSkipped,
      wasAtHead: snapEntry?.wasAtHead,
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
      afterHash: snap.afterHash,
      wasAtHead: snap.wasAtHead,
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
      if (snap.wasAtHead) return { path: snap.path, action: "git-restore" };
      if (snap.structuredPatch && snap.structuredPatch.length > 0)
        return {
          path: snap.path,
          action: "reverse-patch",
          structuredPatch: snap.structuredPatch,
        };
      return null;
    }
    case "deleted": {
      if (snap.wasAtHead) return { path: snap.path, action: "git-restore" };
      if (snap.contentToRestore != null)
        return {
          path: snap.path,
          action: "restore-content",
          contentToRestore: snap.contentToRestore,
        };
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
  const tier2Paths = new Set(
    candidates.filter((c) => c.tier === "tier2").map((c) => c.path)
  );
  return {
    scope,
    eventAttributedFiles: candidates.filter((c) => c.tier === "tier1"),
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
  events: CliEvent[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string
): UndoDialogInput {
  const scope: UndoDialogScope = {
    mode: "singleFile",
    target,
    attemptIndex: eventIndex,
    path,
  };
  const snapshotFiles: SnapshotFileChange[] = snapshot?.changedFiles ?? [];

  const event = events[eventIndex];
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
  let oldContent: string | undefined;
  let newContent: string | undefined;
  let structuredPatch: UndoFileCandidate["structuredPatch"];

  if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
    const editData = event.data as FileEditData;
    oldContent = editData.oldContent;
    newContent = editData.newContent;
    structuredPatch = editData.structuredPatch;

    if (structuredPatch && structuredPatch.length > 0) {
      // Reverse-patch: the extension reads the current file and applies this patch in reverse.
      instruction = { path, action: "reverse-patch", structuredPatch };
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

/** Build the dialog input for a single-file undo from a diff row. */
export function buildUndoDialogInputForSingleFile(
  target: UndoExecutionTarget,
  attemptIndex: number,
  path: string,
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined,
  workspacePath: string
): UndoDialogInput {
  const scope: UndoDialogScope = {
    mode: "singleFile",
    target,
    attemptIndex,
    path,
  };
  const allCandidates = buildUndoCandidatesForOutputs(cliOutputs, snapshot);
  const fileCandidates = allCandidates.filter((c) => c.path === path);
  const tier2Paths = new Set(
    fileCandidates.filter((c) => c.tier === "tier2").map((c) => c.path)
  );
  return {
    scope,
    eventAttributedFiles: fileCandidates.filter((c) => c.tier === "tier1"),
    snapshotOnlyFiles: (snapshot?.changedFiles ?? []).filter((s) =>
      tier2Paths.has(s.path)
    ),
    workspacePath,
  };
}
