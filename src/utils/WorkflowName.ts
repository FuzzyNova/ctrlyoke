import * as path from "path";

/** Return a workflow's filename without its ctrlyoke-specific extension. */
export function extractWorkflowName(filePath: string): string {
  const fileName = path.basename(filePath);
  return fileName.replace(/\.(ctrlyoke\.(json|yaml|yml)|prompt\.md)$/, "");
}
