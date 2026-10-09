import type { WorkflowPath } from "./WorkflowLocationTypes";

/** Convert an RFC 6901 JSON Pointer to the path shape used by workflow locations. */
export function workflowPathFromInstancePath(
  instancePath: string
): WorkflowPath {
  if (instancePath === "") return [];
  if (!instancePath.startsWith("/")) return [];
  return instancePath
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}
