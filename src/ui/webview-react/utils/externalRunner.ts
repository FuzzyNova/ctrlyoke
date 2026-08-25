import { RUNNER_IDS, type RunnerId } from "@root/types/DashboardConstants";

export function getExternalRunnerLabel(
  managedBy: RunnerId | undefined
): string | undefined {
  if (managedBy === RUNNER_IDS.CLI) return "ctrlyoke CLI";
  if (managedBy === RUNNER_IDS.VSCODE) return "another ctrlyoke window";
  return undefined;
}

export function getExternalReadOnlyLabel(
  managedBy: RunnerId | undefined
): string | undefined {
  const runner = getExternalRunnerLabel(managedBy);
  return runner ? `Read-only — workflow is running via ${runner}` : undefined;
}
