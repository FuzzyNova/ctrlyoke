import type { SelectOption } from "./CustomSelect";

/** The agent fields shared by every agent picker. */
export interface AgentSelectEntry {
  name: string;
  displayName?: string;
  path: string;
  description?: string;
}

/** Prefer author-provided metadata over the filename-derived identifier. */
export function getAgentDisplayName(agent: AgentSelectEntry): string {
  return agent.displayName ?? agent.name;
}

/** Create a consistently rendered CustomSelect option for an agent. */
export function toAgentSelectOption(
  agent: AgentSelectEntry,
  value: string
): SelectOption {
  return {
    value,
    label: getAgentDisplayName(agent),
    description: agent.description,
  };
}
