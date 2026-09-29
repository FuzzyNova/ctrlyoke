import { isRecord, tryParseJson } from "./shared";

export interface PostNoteParams {
  text?: string;
  to?: string[];
}

export interface PostNoteResult {
  text: string;
  to?: string[];
  seq?: number;
}

export function parsePostNoteParams(raw: unknown): PostNoteParams | undefined {
  if (!isRecord(raw)) return undefined;
  const to = Array.isArray(raw.to)
    ? raw.to.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(to ? { to } : {}),
  };
}

export function parsePostNoteResultText(
  text: string
): PostNoteResult | undefined {
  try {
    const parsed: unknown = tryParseJson(text);
    if (!isRecord(parsed) || typeof parsed.text !== "string") return undefined;
    const to = Array.isArray(parsed.to)
      ? parsed.to.filter((value): value is string => typeof value === "string")
      : undefined;
    return {
      text: parsed.text,
      ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
      ...(to ? { to } : {}),
    };
  } catch {
    return undefined;
  }
}

export function postNoteSummary(
  params: PostNoteParams | undefined,
  result: PostNoteResult
): string {
  const recipients = result.to ?? params?.to;
  return recipients?.length ? `Note → ${recipients.join(", ")}` : "Note → all";
}

export function postNoteSearchText(
  params: PostNoteParams | undefined,
  result: PostNoteResult
): string[] {
  return [postNoteSummary(params, result), result.text];
}

export function estimatePostNoteHeight(
  params: PostNoteParams | undefined,
  result: PostNoteResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const text = `${postNoteSummary(params, result)}\n${result.text}`;
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const lines = text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
  return 34 + lines * fontSize * 1.55 + (result.text ? 10 : 0) + rawHeight;
}
