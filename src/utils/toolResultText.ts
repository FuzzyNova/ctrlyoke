import type { ToolResult } from "../types/CliOutputTypes";

/** Text shown by the generic tool-call row and searched by output find. */
export function getToolResultText(result: ToolResult | undefined): string {
  if (!result) return "";
  if (!result.success && typeof result.error === "string") return result.error;
  if (typeof result.output === "string") return result.output;
  return result.success ? "Success" : "Failed";
}
