import { isRecord, tryParseJson } from "./shared";
import { TOOL_TERMINAL_TONES, type ToolTerminalLine } from "./shared";
import { parseCoordinationParticipant } from "./coordinationParticipantParser";
import type { CoordinationEntry } from "../../types/CtrlYokeTypes";
import { COORDINATION_ENTRY_KINDS } from "../../types/DashboardConstants";
import {
  coordinationEntrySearchText,
  coordinationEntrySummary,
  coordinationParticipantAttribution,
} from "./coordinationPresentation";

export interface ReadNotesParams {
  since?: number;
  from?: string[];
}

export interface ReadNotesResult {
  entries: CoordinationEntry[];
  nextCursor?: number;
}

function isEntry(value: unknown): value is CoordinationEntry {
  if (
    !isRecord(value) ||
    !parseCoordinationParticipant(value.from) ||
    !Number.isInteger(value.seq) ||
    typeof value.at !== "string" ||
    typeof value.via !== "string"
  )
    return false;
  if (
    !Object.values(COORDINATION_ENTRY_KINDS).includes(
      value.kind as (typeof COORDINATION_ENTRY_KINDS)[keyof typeof COORDINATION_ENTRY_KINDS]
    )
  )
    return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (
    value.paths !== undefined &&
    (!Array.isArray(value.paths) ||
      !value.paths.every((path) => typeof path === "string"))
  )
    return false;
  return true;
}

export function parseReadNotesParams(
  raw: unknown
): ReadNotesParams | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.since !== undefined &&
    (typeof raw.since !== "number" || raw.since < 0)
  )
    return undefined;
  if (
    raw.from !== undefined &&
    (!Array.isArray(raw.from) ||
      !raw.from.every((id) => typeof id === "string"))
  )
    return undefined;
  return {
    ...(typeof raw.since === "number" ? { since: raw.since } : {}),
    ...(Array.isArray(raw.from) ? { from: raw.from } : {}),
  };
}

export function parseReadNotesResultText(
  text: string
): ReadNotesResult | undefined {
  try {
    const parsed: unknown = tryParseJson(text);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isEntry)
    )
      return undefined;
    if (
      parsed.nextCursor !== undefined &&
      typeof parsed.nextCursor !== "number"
    )
      return undefined;
    return {
      entries: parsed.entries,
      ...(typeof parsed.nextCursor === "number"
        ? { nextCursor: parsed.nextCursor }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function readNotesSummary(
  _params: ReadNotesParams | undefined,
  result: ReadNotesResult
): string {
  return `Read ${result.entries.length} ${result.entries.length === 1 ? COORDINATION_ENTRY_KINDS.NOTE : "notes"}`;
}

export function readNotesSearchText(
  params: ReadNotesParams | undefined,
  result: ReadNotesResult
): string[] {
  return [
    readNotesSummary(params, result),
    ...result.entries.map(coordinationEntrySearchText),
  ];
}

export function readNotesEntryText(entry: CoordinationEntry): string {
  return `${coordinationParticipantAttribution(entry.from)}: ${coordinationEntrySummary(entry)}`;
}

export function readNotesTerminalLines(
  _params: ReadNotesParams | undefined,
  result: ReadNotesResult
): ToolTerminalLine[] {
  return result.entries.map((entry) => ({
    text: readNotesEntryText(entry),
    tone: TOOL_TERMINAL_TONES.untrusted,
  }));
}
