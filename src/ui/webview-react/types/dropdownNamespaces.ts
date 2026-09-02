import {
  INHERIT_DEFAULT_OPTION,
  RESUME_SESSION_SELECTIONS,
  SESSION_ID_SENTINELS,
} from "@root/types/DashboardConstants";

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
    {
      value: RESUME_SESSION_SELECTIONS.YES,
      label: "Yes - Resume previous",
    },
    { value: RESUME_SESSION_SELECTIONS.NO, label: "No - Create New" },
    { value: SESSION_ID_SENTINELS.FINAL_STEP, label: "Final Step Session" },
  ] as const;
  return defaultLabel
    ? [{ value: INHERIT_DEFAULT_OPTION, label: defaultLabel }, ...base]
    : base;
}

/** Property writes a Resume Session dropdown selection implies. */
export interface ResumeSessionSelection {
  /** undefined = inherit, true/false = explicit prompt-level override. */
  resumeSession: boolean | undefined;
  /** Always written — "" clears the paired Session ID. */
  sessionId: string;
}

/**
 * Single source for what a Resume Session dropdown change does to the paired
 * Session ID, shared by every surface that renders the two together
 * (`PropertiesDrawer`, `ContextQuickPicker`).
 *
 * The Session ID is only *reachable* while the selection is "yes" — every other
 * selection greys the input out and shows either the inherited value or nothing.
 * So any selection that leaves "yes" must also clear it: a value the user can
 * neither see nor edit is still resolved at execution time, and a session ID
 * outlasting the dropdown that set it is exactly how a step resumed a GUID the
 * user had already switched away from.
 */
export function resumeSessionSelection(
  selection: string,
  currentSessionId: string | undefined
): ResumeSessionSelection {
  if (selection === SESSION_ID_SENTINELS.FINAL_STEP) {
    return {
      resumeSession: true,
      sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
    };
  }
  if (selection === RESUME_SESSION_SELECTIONS.YES) {
    // Keep a real session ID the user typed; only the sentinel is stale here.
    return {
      resumeSession: true,
      sessionId:
        currentSessionId === SESSION_ID_SENTINELS.FINAL_STEP
          ? ""
          : (currentSessionId ?? ""),
    };
  }
  return {
    resumeSession: selection === INHERIT_DEFAULT_OPTION ? undefined : false,
    sessionId: "",
  };
}
