import { RUNNER_IDS } from "@root/types/DashboardConstants";
import type { ExternalExecutionOwnerSummary } from "@root/types/CtrlYokeTypes";

export function getExternalRunnerLabel(
  externalOwner: ExternalExecutionOwnerSummary | undefined
): string | undefined {
  if (externalOwner?.runner === RUNNER_IDS.CLI) return "ctrlyoke CLI";
  if (externalOwner?.runner === RUNNER_IDS.VSCODE)
    return "another ctrlyoke window";
  return undefined;
}

export function getExternalReadOnlyLabel(
  externalOwner: ExternalExecutionOwnerSummary | undefined
): string | undefined {
  const runner = getExternalRunnerLabel(externalOwner);
  return runner ? `Read-only — workflow is running via ${runner}` : undefined;
}
