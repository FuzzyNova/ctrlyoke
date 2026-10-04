import { isRecord, tryParseJson, type ToolTerminalLine } from "./shared";

export interface SubmitCommitMessageParams {
  message: string;
}
export interface SubmitCommitMessageResult {
  success: true;
  outputPath?: string;
}

export function parseSubmitCommitMessageParams(
  raw: unknown
): SubmitCommitMessageParams | undefined {
  return isRecord(raw) && typeof raw.message === "string"
    ? { message: raw.message }
    : undefined;
}

export function parseSubmitCommitMessageResultText(
  text: string
): SubmitCommitMessageResult | undefined {
  try {
    const raw: unknown = tryParseJson(text);
    if (!isRecord(raw) || raw.success !== true) return undefined;
    return {
      success: true,
      ...(typeof raw.outputPath === "string"
        ? { outputPath: raw.outputPath }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function commitMessageSummary(
  params: SubmitCommitMessageParams | undefined
): string {
  const firstLine = params?.message.trim().split(/\r?\n/, 1)[0];
  return firstLine || "Submitted commit message";
}

export function submitCommitMessageSearchText(
  params: SubmitCommitMessageParams | undefined
): string[] {
  return params
    ? [commitMessageSummary(params), params.message]
    : ["Submitted commit message"];
}

export function submitCommitMessageTerminalLines(
  params: SubmitCommitMessageParams | undefined,
  _result: SubmitCommitMessageResult
): ToolTerminalLine[] {
  return params ? [{ text: params.message }] : [];
}
