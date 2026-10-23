import type { CliEvent, SubagentAttribution } from "../types/CliOutputTypes";

/** Stable key for the spawn group that produced an event. */
export function subagentGroupKey(
  attribution: SubagentAttribution | undefined
): string {
  return attribution
    ? JSON.stringify([attribution.parentToolCallId, attribution.agentId ?? null])
    : "parent";
}

export function sameSubagentGroup(left: CliEvent, right: CliEvent): boolean {
  return subagentGroupKey(left.subagent) === subagentGroupKey(right.subagent);
}
