import { normalizeCliEvents } from "@root/utils/CliEventNormalizer";
import type {
  CliEvent,
  CliOutput as CliOutputType,
  BashCommandData,
  FileEditData,
} from "../types/cliEvents";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OPERATION_STATUS,
  STEP_TYPES,
} from "../types/messages";
import type { WorkspaceSnapshot } from "@root/types/OutputHistoryTypes";
import { sameFilePath } from "./promptUndo";
import {
  getRenderedDiffStats,
  toRdvFromContent,
  toRdvHunks,
} from "./rdvAdapter";
import {
  buildDiffAnchorPrefix,
  extractCliOutputText,
  isStructuredPatchMalformed,
} from "./outputUtils";
import type { OutputMessageTarget } from "./outputProjection";

export interface VisibleStructuredEvent {
  event: CliEvent;
  originalIndex: number;
  hideDiff: boolean;
}

export interface OutputDiffStats {
  added: number;
  removed: number;
  runs: Array<{
    count: number;
    addedLines: number;
    removedLines: number;
  }>;
}

export function isScriptOutput(output: CliOutputType): boolean {
  return output.source === STEP_TYPES.SCRIPT;
}

export function getRawTextOutput(output: CliOutputType): boolean {
  return !!output.rawTextOutput || !!output.structured?.metadata?.rawTextOutput;
}

export function getVisibleStructuredEvents(
  events: readonly CliEvent[] | undefined
): VisibleStructuredEvent[] {
  if (!events?.length) return [];

  const normalizedEvents = normalizeCliEvents(events);
  const indicesToHideDiff = new Set<number>();
  const indicesToHideRow = new Set<number>();

  for (let i = 0; i < normalizedEvents.length; i++) {
    const event = normalizedEvents[i];

    if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
      const data = event.data as FileEditData;
      if (data.status === OPERATION_STATUS.INITIATED) {
        for (let j = i + 1; j < normalizedEvents.length; j++) {
          const next = normalizedEvents[j];
          if (next.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
          const nextData = next.data as FileEditData;
          if (!nextData.path || !data.path) continue;
          if (!sameFilePath(nextData.path, data.path)) continue;
          if (nextData.status === OPERATION_STATUS.COMPLETED) {
            indicesToHideDiff.add(i);
          }
          break;
        }
      }
    }

    if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
      const data = event.data as BashCommandData;
      if (data.status === OPERATION_STATUS.INITIATED && data.command) {
        for (let j = i + 1; j < normalizedEvents.length; j++) {
          const next = normalizedEvents[j];
          if (next.type !== CLI_EVENT_TYPES.BASH_COMMAND) continue;
          const nextData = next.data as BashCommandData;
          if (nextData.command !== data.command) continue;
          if (
            nextData.status === OPERATION_STATUS.COMPLETED ||
            nextData.status === OPERATION_STATUS.FAILED
          ) {
            indicesToHideRow.add(i);
          }
          break;
        }
      }
    }
  }

  return normalizedEvents.flatMap((event, originalIndex) => {
    if (indicesToHideRow.has(originalIndex)) {
      return [];
    }

    return [
      {
        event,
        originalIndex,
        hideDiff: indicesToHideDiff.has(originalIndex),
      },
    ];
  });
}

export function getSnapshotStructuredPatch(
  path: string,
  workspaceSnapshot?: WorkspaceSnapshot
): FileEditData["structuredPatch"] | undefined {
  return workspaceSnapshot?.changedFiles.find(
    (change) =>
      change.structuredPatch &&
      change.structuredPatch.length > 0 &&
      sameFilePath(path, change.path)
  )?.structuredPatch;
}

export function getSnapshotBeforeContent(
  path: string,
  workspaceSnapshot?: WorkspaceSnapshot
): string | undefined {
  return workspaceSnapshot?.changedFiles.find(
    (change) =>
      change.beforeContent !== undefined && sameFilePath(path, change.path)
  )?.beforeContent;
}

export function getDisplayStructuredPatch(
  path: string,
  eventPatch: FileEditData["structuredPatch"] | undefined,
  workspaceSnapshot?: WorkspaceSnapshot
): FileEditData["structuredPatch"] | undefined {
  const snapshotPatch = getSnapshotStructuredPatch(path, workspaceSnapshot);
  if (!snapshotPatch || snapshotPatch.length === 0) {
    return eventPatch;
  }

  if (!eventPatch || eventPatch.length === 0) {
    return snapshotPatch;
  }

  return isStructuredPatchMalformed(eventPatch) ? snapshotPatch : eventPatch;
}

export function computeOutputDiffStats(
  event: CliEvent,
  workspaceSnapshot?: WorkspaceSnapshot,
  viewType: "split" | "unified" = "unified"
): OutputDiffStats {
  if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
    const data = event.data as FileEditData;
    const structuredPatch = data.path
      ? getDisplayStructuredPatch(data.path, data.structuredPatch, workspaceSnapshot)
      : data.structuredPatch;
    const beforeContent = data.path
      ? getSnapshotBeforeContent(data.path, workspaceSnapshot) ?? data.oldContent
      : data.oldContent;

    if (structuredPatch && structuredPatch.length > 0) {
      return getRenderedDiffStats(toRdvHunks(structuredPatch), viewType);
    }
    if (beforeContent !== undefined && data.newContent !== undefined) {
      const { hunks } = toRdvFromContent(beforeContent, data.newContent);
      return getRenderedDiffStats(hunks, viewType);
    }
    return { added: 0, removed: 0, runs: [] };
  }

  if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
    const content = (event.data as { content?: string }).content;
    const lines = content ? content.split("\n").length : 1;
    return {
      added: lines,
      removed: 0,
      runs: [{ count: lines, addedLines: 1, removedLines: 0 }],
    };
  }

  if (event.type === CLI_EVENT_TYPES.FILE_DELETE) {
    return {
      added: 0,
      removed: 1,
      runs: [{ count: 1, addedLines: 0, removedLines: 1 }],
    };
  }

  return { added: 0, removed: 0, runs: [] };
}

export function getOutputDiffKey(
  target: OutputMessageTarget,
  stepIndex: number,
  runIndex: number,
  attemptIndex: number,
  eventIndex: number
): string {
  return `${buildDiffAnchorPrefix(
    target.kind === FINAL_STEP_PHASES.FINAL_STEP ? "fp" : "q",
    stepIndex,
    runIndex,
    attemptIndex
  )}-e${eventIndex}`;
}

export function getCliTextForCopy(output: CliOutputType): string | undefined {
  return extractCliOutputText(output);
}

export function buildUndoRecordKey(target: OutputMessageTarget): string {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? `finalStep-${target.index}`
    : `queue-${target.index}`;
}
