import type { PromptFile } from "../types/CtrlYokeTypes";
import { getVariableKeyErrors } from "../utils/KeyValueKeyKinds";

/**
 * Apply the CLI's `--var` overrides to a parsed workflow's `vars`, over the
 * workflow's own defaults. The one place both the root run and every file
 * child (D11) take them from. A name the workflow does not declare is added
 * rather than rejected; only an invalid variable name throws.
 */
export function mergeCliVarsIntoWorkflow(
  workflow: PromptFile,
  vars: Readonly<Record<string, string>>
): void {
  if (Object.keys(vars).length === 0) {
    return;
  }
  const mergedVars = { ...(workflow.vars ?? {}), ...vars };
  const variableKeyErrors = getVariableKeyErrors(Object.keys(mergedVars));
  if (variableKeyErrors.length > 0) {
    throw new Error(
      `Invalid workflow variables: ${variableKeyErrors.join(", ")}`
    );
  }
  workflow.vars = mergedVars;
}
