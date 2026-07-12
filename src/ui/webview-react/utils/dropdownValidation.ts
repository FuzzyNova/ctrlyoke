import type {
  AgentOption,
  ModelOption,
  SkillOption,
} from "@store/settingsStore";
import type { HarnessId } from "../types/messages";

function isKnownValue(
  value: string,
  options: ReadonlyArray<{ name: string; path: string }>
): boolean {
  return options.some(
    (option) => option.name === value || option.path === value
  );
}

/** Returns a warning when an explicit model is unavailable for its harness. */
export function modelWarning(
  model: string | null | undefined,
  harness: HarnessId,
  modelOptions: ReadonlyArray<ModelOption>
): string | null {
  if (!model || modelOptions.some((option) => option.value === model)) {
    return null;
  }

  return `Model "${model}" is not available for ${harness}.`;
}

/** Returns a warning when an explicit agent is not currently discovered. */
export function agentWarning(
  agent: string | null | undefined,
  availableAgents: ReadonlyArray<AgentOption>
): string | null {
  if (!agent || availableAgents.some((available) => available.name === agent)) {
    return null;
  }

  return `Agent "${agent}" is not available in this workspace.`;
}

/** Returns a warning when one or more explicit skills are not currently discovered. */
export function skillsWarning(
  skills: string[] | null | undefined,
  availableSkills: ReadonlyArray<SkillOption>
): string | null {
  if (!skills || skills.length === 0) {
    return null;
  }

  const missingSkills = skills.filter(
    (skill) => !isKnownValue(skill, availableSkills)
  );
  if (missingSkills.length === 0) {
    return null;
  }

  const label = missingSkills.length === 1 ? "skill" : "skills";
  return `${missingSkills.length} ${label} not found: ${missingSkills
    .map((skill) => `"${skill}"`)
    .join(", ")}.`;
}

/** Returns the consistent border token for a soft dropdown warning. */
export function dropdownBorderClass(
  warning: string | null | undefined
): string {
  return warning ? "border-warning-fg" : "border-dropdown-border";
}

/** Returns the consistent text token for a soft dropdown warning. */
export function dropdownWarningClass(
  warning: string | null | undefined
): string {
  return warning ? "text-warning-fg" : "text-description-fg";
}
