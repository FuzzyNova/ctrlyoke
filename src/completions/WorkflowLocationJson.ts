import {
  findNodeAtLocation,
  findNodeAtOffset,
  getNodePath,
  parse,
  parseTree,
  type Node,
  type ParseOptions,
} from "jsonc-parser";
import { CTRLYOKE_FILE_KINDS } from "../types/DashboardConstants";
import {
  buildWorkflowLocation,
  splitValuePath,
  type WorkflowLocation,
  type WorkflowPath,
  type WorkflowTextRange,
} from "./WorkflowLocationTypes";

/** Workflow JSON may carry comments and trailing commas while being edited. */
const JSON_PARSE_OPTIONS: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
};

const JSON_NODE = {
  OBJECT: "object",
  ARRAY: "array",
  PROPERTY: "property",
  STRING: "string",
} as const;

function emptyLocation(root: unknown): WorkflowLocation {
  return buildWorkflowLocation({
    kind: CTRLYOKE_FILE_KINDS.WORKFLOW_JSON,
    root,
    ownerPath: [],
    isKey: false,
  });
}

/** Error-tolerant location of `offset` in a workflow JSON document. */
export function getJsonWorkflowLocation(
  text: string,
  offset: number
): WorkflowLocation {
  const root = parse(text, [], JSON_PARSE_OPTIONS) as unknown;
  const tree = parseTree(text, [], JSON_PARSE_OPTIONS);
  const node = tree ? findNodeAtOffset(tree, offset, true) : undefined;
  if (!node) return emptyLocation(root);
  const kind = CTRLYOKE_FILE_KINDS.WORKFLOW_JSON;

  // Whitespace inside `{ ... }`: a new key belongs to this object.
  if (node.type === JSON_NODE.OBJECT) {
    return buildWorkflowLocation({
      kind,
      root,
      ownerPath: getNodePath(node),
      isKey: true,
    });
  }

  // `"key": ` with no value yet, or the colon/whitespace around a key.
  if (node.type === JSON_NODE.PROPERTY) {
    const keyNode = node.children?.[0];
    const key = typeof keyNode?.value === "string" ? keyNode.value : undefined;
    const ownerPath = getNodePath(node);
    if (
      keyNode &&
      key !== undefined &&
      offset > keyNode.offset + keyNode.length
    ) {
      return buildWorkflowLocation({
        kind,
        root,
        ownerPath,
        key,
        isKey: false,
        textCapable: !node.children?.[1],
      });
    }
    return buildWorkflowLocation({ kind, root, ownerPath, key, isKey: true });
  }

  const parent = node.parent;
  const isKeyNode =
    parent?.type === JSON_NODE.PROPERTY && parent.children?.[0] === node;
  if (isKeyNode && parent) {
    return buildWorkflowLocation({
      kind,
      root,
      ownerPath: getNodePath(parent),
      key: String(node.value),
      isKey: true,
    });
  }

  const valuePath = getNodePath(node);
  const { ownerPath, key } = splitValuePath(valuePath);
  const isString = node.type === JSON_NODE.STRING;
  // Only a direct property value is text; strings inside lists are plain values.
  const isDirectValue = parent?.type === JSON_NODE.PROPERTY;
  return buildWorkflowLocation({
    kind,
    root,
    ownerPath,
    key,
    isKey: false,
    valuePath,
    textCapable: isString && isDirectValue,
    valueRange: isString ? innerStringRange(text, node) : undefined,
    jsonString: isString,
  });
}

/** Content between the quotes; an unterminated string ends at the line end. */
function innerStringRange(text: string, node: Node): WorkflowTextRange {
  const start = node.offset + 1;
  const end = node.offset + node.length;
  const terminated = end - 1 > node.offset && text[end - 1] === '"';
  return { start, end: terminated ? end - 1 : end };
}

/**
 * Range of the node at `path`: a scalar's own text, or the key of an object or
 * array so a diagnostic does not paint the whole subtree. Falls back to the
 * nearest ancestor that exists.
 */
export function findJsonRangeForPath(
  text: string,
  path: WorkflowPath
): WorkflowTextRange | undefined {
  const tree = parseTree(text, [], JSON_PARSE_OPTIONS);
  if (!tree) return undefined;
  for (let length = path.length; length >= 0; length--) {
    const node = findNodeAtLocation(tree, path.slice(0, length) as never);
    if (!node) continue;
    const isCollection =
      node.type === JSON_NODE.OBJECT || node.type === JSON_NODE.ARRAY;
    const keyNode = node.parent?.children?.[0];
    if (isCollection && node.parent?.type === JSON_NODE.PROPERTY && keyNode) {
      return { start: keyNode.offset, end: keyNode.offset + keyNode.length };
    }
    return { start: node.offset, end: node.offset + node.length };
  }
  return undefined;
}
