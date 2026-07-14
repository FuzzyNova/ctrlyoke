import { SESSION_ID_SENTINELS } from "@root/types/DashboardConstants";

/**
 * Namespace keys for the dropdown hide feature.
 *
 * Each key maps to a Record<string, string[]> entry in uiStore.hiddenDropdownOptions.
 * Using per-harness model namespaces means hiding a model in one harness context
 * has zero effect on other harnesses.
 *
 * Both WorkflowPropertiesPanel and PropertiesDrawer share these constants so hidden state
 * is always in sync between the two panels.
 */
export const DROPDOWN_NAMESPACES = {
  HARNESS: "harness",
  MODEL_COPILOT_CLI: "model:copilot-cli",
  MODEL_CLAUDE_CLI: "model:claude-cli",
  MODEL_CODEX_CLI: "model:codex-cli",
  AGENT: "agent",
  SKILLS: "skills",
} as const;

export type DropdownNamespace =
  (typeof DROPDOWN_NAMESPACES)[keyof typeof DROPDOWN_NAMESPACES];

/**
 * Derive the model namespace from the active harness ID at render time.
 * e.g. "copilot-cli" → "model:copilot-cli"
 */
export function modelNamespaceForHarness(harness: string): string {
  return `model:${harness}`;
}

/**
 * Generate Resume Session dropdown options.
 * PropertiesDrawer includes a "Default" option with dynamic label.
 * WorkflowPropertiesPanel uses only Yes/No (computes effective value separately).
 */
export function getResumeSessionOptions(defaultLabel?: string) {
  const base = [
    { value: "yes", label: "Yes - Resume previous" },
    { value: "no", label: "No - Create New" },
    { value: SESSION_ID_SENTINELS.FINAL_STEP, label: "Final Step Session" },
  ] as const;
  return defaultLabel
    ? [{ value: "default", label: defaultLabel }, ...base]
    : base;
}
