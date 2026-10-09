import type { WorkflowPath } from "./WorkflowLocationTypes";

/** Convert an RFC 6901 JSON Pointer to the path shape used by workflow locations. */
export function workflowPathFromInstancePath(
  instancePath: string,
  parsedDocument?: unknown
): WorkflowPath {
  if (instancePath === "") return [];
  if (!instancePath.startsWith("/")) return [];
  let current: unknown = parsedDocument;
  return instancePath
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((segment) => {
      const key: string | number =
        Array.isArray(current) && /^\d+$/.test(segment)
          ? Number(segment)
          : segment;
      current =
        current != null
          ? (current as Record<string | number, unknown>)[key]
          : undefined;
      return key;
    });
}
