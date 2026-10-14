import type { HarnessId } from "@root/types/DashboardConstants";
import { inheritsWorkflowHarnessScopedValues } from "@root/types/ExecutionPropertyResolver";

/**
 * Label for the fallback entry of a harness-scoped step field (Model,
 * Additional Args). "Inherit" means the value comes from the workflow;
 * "Default" means the step runs on another harness than the workflow's, so it
 * uses that harness's settings default. Pass `null` for a bulk selection
 * whose steps run on different harnesses, which can resolve either way.
 */
export function harnessScopedFallbackLabel(
  stepHarness: HarnessId | null,
  workflowHarness: HarnessId,
  valueLabel: string
): string {
  if (stepHarness === null) return "Inherit / Default";
  const prefix = inheritsWorkflowHarnessScopedValues(
    stepHarness,
    workflowHarness
  )
    ? "Inherit"
    : "Default";
  return `${prefix} (${valueLabel})`;
}
