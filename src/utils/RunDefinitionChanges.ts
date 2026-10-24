import {
  RUN_DEFINITION_CHANGE_SCOPES,
  type RunDefinitionChange,
} from "../types/DashboardConstants";

/**
 * "step 2: endCondition, toolPermissions; workflow: hooks" — the one wording
 * of a definition changed outside ctrlyoke, shared by the dashboard banner,
 * the run's status message, CLI errors and logs. Webview-safe.
 */
export function describeRunDefinitionChanges(
  changes: readonly RunDefinitionChange[]
): string {
  if (changes.length === 0) {
    return "no visible field changed";
  }
  return changes
    .map((change) => {
      const label =
        change.scope === RUN_DEFINITION_CHANGE_SCOPES.STEP
          ? `step ${change.stepNumber}`
          : change.scope === RUN_DEFINITION_CHANGE_SCOPES.FINAL_STEP
            ? "final step"
            : "workflow";
      return `${label}: ${change.fields.join(", ")}`;
    })
    .join("; ");
}
