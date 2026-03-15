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
      if (d.originalFile != null)
        return { path: d.path, action: "restore-content", contentToRestore: d.originalFile };
      if (d.oldContent != null)
        return { path: d.path, action: "restore-content", contentToRestore: d.oldContent };
      // structuredPatch only: cannot reverse without current file content in webview
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

/**
 * Build the full list of undo candidates for a set of CliOutputs and an optional snapshot.
 *
 * Tier 1: derived from structured CLI events (high confidence).
 * Tier 2: snapshot-only entries whose paths are NOT covered by any event (lower confidence).
 */
export function buildUndoCandidatesForOutputs(
  cliOutputs: CliOutput[],
  snapshot: WorkspaceSnapshot | undefined
): UndoFileCandidate[] {
  const snapshotFiles: SnapshotFileChange[] = snapshot?.changedFiles ?? [];

  // Collect Tier 1 candidates, last-write-wins per path across all attempts.
  const tier1Map = new Map<string, UndoFileCandidate>();
  for (const output of cliOutputs) {
    const events = output.structured?.events;
    if (!events) continue;
    for (const event of events) {
      const changeType = eventTypeToChangeType(event.type);
      if (!changeType) continue;
      const d = event.data as FileEditData | FileWriteData | FileDeleteData;
      const path = d.path;
      if (!path) continue;
      const instruction = resolveEventUndoInstruction(event, snapshotFiles);
      const snapEntry = snapshotFiles.find((f) => f.path === path);

      // Carry diff data for FILE_EDIT events so the dialog can render a preview
      let oldContent: string | undefined;
      let newContent: string | undefined;
      let structuredPatch: UndoFileCandidate["structuredPatch"];
      if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
        const editData = d as FileEditData;
        oldContent = editData.originalFile ?? editData.oldContent;
        newContent = editData.newContent;
        structuredPatch = editData.structuredPatch;
      }

      tier1Map.set(path, {
        path,
        changeType,
        tier: "tier1",
        instruction,
        afterHash: snapEntry?.afterHash,
        contentCaptureSkipped: snapEntry?.contentCaptureSkipped,
        wasAtHead: snapEntry?.wasAtHead,
        oldContent,
        newContent,
        structuredPatch,
      });
    }
  }

  const tier1Candidates = Array.from(tier1Map.values());
  const tier1Paths = new Set(tier1Map.keys());

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
