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
