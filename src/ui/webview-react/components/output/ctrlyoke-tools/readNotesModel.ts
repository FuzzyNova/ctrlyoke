import type { CoordinationEntry } from "@root/types/CtrlYokeTypes";
import { COORDINATION_ENTRY_KINDS } from "@root/types/DashboardConstants";
import {
  coordinationEntrySearchText,
  coordinationEntrySummary,
  coordinationParticipantAttribution,
} from "@utils/coordinationPresentation";

export interface ReadNotesParams {
  since?: number;
  from?: string[];
}

export interface ReadNotesResult {
  entries: CoordinationEntry[];
  nextCursor?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParticipant(value: unknown): value is CoordinationEntry["from"] {
  return (
    isRecord(value) &&
    typeof value.participantId === "string" &&
    typeof value.label === "string" &&
    typeof value.kind === "string" &&
    typeof value.attested === "boolean"
  );
}

function isEntry(value: unknown): value is CoordinationEntry {
  if (
    !isRecord(value) ||
    !isParticipant(value.from) ||
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
    const parsed: unknown = JSON.parse(text);
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
    result.entries.map(coordinationEntrySearchText).join("\n"),
  ];
}

export function readNotesEntryText(entry: CoordinationEntry): string {
  return `${coordinationParticipantAttribution(entry.from)}: ${coordinationEntrySummary(entry)}`;
}

export function estimateReadNotesHeight(
  _params: ReadNotesParams | undefined,
  result: ReadNotesResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const text = readNotesSearchText(undefined, result);
  const lines = text.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
    0
  );
  const bodyLines = result.entries.reduce(
    (total, entry) =>
      total +
      (entry.kind === COORDINATION_ENTRY_KINDS.NOTE && entry.text
        ? Math.max(1, Math.ceil(entry.text.length / charsPerLine))
        : 0),
    0
  );
  return 34 + (lines + bodyLines) * fontSize * 1.55 + rawHeight;
}
