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

/**
 * Short label for the compact ownership badge on a running-workflow row.
 * "Other VS Code Window" (rather than bare "VS Code") because the badge is
 * seen from inside VS Code — an unqualified "VS Code" reads as a no-op label
 * to a user already in that editor.
 */
export function getExternalOwnerBadgeLabel(
  externalOwner: ExternalExecutionOwnerSummary | undefined
): string | undefined {
  if (externalOwner?.runner === RUNNER_IDS.CLI) return "CLI";
  if (externalOwner?.runner === RUNNER_IDS.VSCODE)
    return "Other VS Code Window";
  return undefined;
}
