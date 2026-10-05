import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";

/**
 * Extract workflow name from file path
 */
export function getWorkflowNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  // Source prompt files may use any supported extension; run-scoped workflow
  // definitions always derive their display name from the lineage descriptor.
  return fileName
    .replace(/\.ctrlyoke\.(yaml|yml|json)$/i, "")
    .replace(/\.(yaml|yml|json)$/i, "");
}

/**
 * The workflow name shown in the header and the browser tab title. During a
 * cross-lineage switch the workflow store still holds the previous workflow,
 * so the pending switch's target name wins.
 */
export function resolveWorkflowDisplayName(
  pendingSwitchWorkflowName: string | null | undefined,
  workflowName: string | null,
  fileName: string | null
): string {
  return (
    pendingSwitchWorkflowName ??
    (fileName
      ? workflowName || getWorkflowNameFromPath(fileName)
      : DEFAULT_WORKFLOW_NAME)
  );
}
