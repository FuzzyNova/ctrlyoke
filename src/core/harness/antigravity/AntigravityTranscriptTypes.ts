/**
 * Strictly typed subset of Antigravity's transcript_full.jsonl vocabulary.
 * Unknown provider variants remain representable through the string fields,
 * but are only consumed after passing these runtime guards.
 */
export interface AntigravityPlannerToolCall {
  name: string;
  args?: Record<string, unknown>;
  toolAction?: string;
  toolSummary?: string;
}

export interface AntigravityTranscriptEntry {
  source: string;
  type: string;
  status: string;
  created_at?: string;
  content?: unknown;
  step_index?: number;
  thinking?: string;
  tool_calls?: AntigravityPlannerToolCall[];
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAntigravityPlannerToolCall(
  value: unknown
): value is AntigravityPlannerToolCall {
  if (!isRecord(value) || typeof value.name !== "string") {
    return false;
  }
  if (value.args !== undefined && !isRecord(value.args)) {
    return false;
  }
  return (
    (value.toolAction === undefined || typeof value.toolAction === "string") &&
    (value.toolSummary === undefined || typeof value.toolSummary === "string")
  );
}

export function isAntigravityTranscriptEntry(
  value: unknown
): value is AntigravityTranscriptEntry {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    typeof value.type !== "string" ||
    typeof value.status !== "string"
  ) {
    return false;
  }
  if (value.created_at !== undefined && typeof value.created_at !== "string") {
    return false;
  }
  if (value.step_index !== undefined && typeof value.step_index !== "number") {
    return false;
  }
  if (value.thinking !== undefined && typeof value.thinking !== "string") {
    return false;
  }
  if (value.tool_calls !== undefined) {
    if (
      !Array.isArray(value.tool_calls) ||
      !value.tool_calls.every(isAntigravityPlannerToolCall)
    ) {
      return false;
    }
  }
  return true;
}
