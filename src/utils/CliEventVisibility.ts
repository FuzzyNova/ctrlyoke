import type {
  BashCommandData,
  CliEvent,
  FileEditData,
} from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/DashboardConstants";

/** Match paths the same way output and undo views do, including absolute suffixes. */
export function normalizeCliFilePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function sameCliFilePath(a: string, b: string): boolean {
  const normalizedA = normalizeCliFilePathKey(a);
  const normalizedB = normalizeCliFilePathKey(b);
  return (
    normalizedA === normalizedB ||
    normalizedA.endsWith(`/${normalizedB}`) ||
    normalizedB.endsWith(`/${normalizedA}`)
  );
}

/** Return the index of a Bash initiated row hidden by its matching completion. */
export function findSupersededInitiatedIndex(
  events: readonly CliEvent[],
  initiatedIndex: number
): number | undefined {
  const event = events[initiatedIndex];
  if (event?.type !== CLI_EVENT_TYPES.BASH_COMMAND) return undefined;

  const data = event.data as BashCommandData;
  if (data.status !== OPERATION_STATUS.INITIATED || !data.command) {
    return undefined;
  }

  for (let index = initiatedIndex + 1; index < events.length; index++) {
    const next = events[index];
    if (next.type !== CLI_EVENT_TYPES.BASH_COMMAND) continue;
    const nextData = next.data as BashCommandData;
    if (nextData.command !== data.command) continue;
    return nextData.status === OPERATION_STATUS.COMPLETED ||
      nextData.status === OPERATION_STATUS.FAILED
      ? initiatedIndex
      : undefined;
  }

  return undefined;
}

/** Whether this initiated FILE_EDIT's duplicate diff should be hidden. */
export function shouldHideInitiatedFileEditDiff(
  events: readonly CliEvent[],
  initiatedIndex: number
): boolean {
  const event = events[initiatedIndex];
  if (event?.type !== CLI_EVENT_TYPES.FILE_EDIT) return false;

  const data = event.data as FileEditData;
  if (data.status !== OPERATION_STATUS.INITIATED) return false;

  for (let index = initiatedIndex + 1; index < events.length; index++) {
    const next = events[index];
    if (next.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
    const nextData = next.data as FileEditData;
    if (!nextData.path || !data.path) continue;
    if (!sameCliFilePath(nextData.path, data.path)) continue;
    return nextData.status === OPERATION_STATUS.COMPLETED;
  }

  return false;
}
