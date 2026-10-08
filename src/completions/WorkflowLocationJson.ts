import {
  createScanner,
  findNodeAtLocation,
  findNodeAtOffset,
  getNodePath,
  parse,
  parseTree,
  SyntaxKind,
  type Node,
  type ParseOptions,
} from "jsonc-parser";
import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES,
  type WorkflowLocationRole,
} from "../types/DashboardConstants";
import {
  buildWorkflowLocation,
  classifyWorkflowObject,
  getTextRole,
  lineEndFrom,
  splitValuePath,
  type WorkflowLocation,
  type WorkflowPath,
  type WorkflowTextRange,
} from "./WorkflowLocationTypes";
import {
  createTextSpan,
  decodeJsonString,
  type WorkflowTextSpan,
} from "./WorkflowTextDecoding";

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
  const kind = CTRLYOKE_FILE_KINDS.WORKFLOW_JSON;
  if (isInComment(text, offset)) {
    return buildWorkflowLocation({
      kind,
      root,
      ownerPath: [],
      isKey: false,
      role: WORKFLOW_LOCATION_ROLES.NONE,
    });
  }
  const tree = parseTree(text, [], JSON_PARSE_OPTIONS);
  const node = tree ? findNodeAtOffset(tree, offset, true) : undefined;
  if (!node) return emptyLocation(root);

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
  // `findNodeAtOffset` includes both quote boundaries; text goes between them.
  const isString =
    node.type === JSON_NODE.STRING && isInsideString(text, node, offset);
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

function isInsideString(text: string, node: Node, offset: number): boolean {
  const { start, end } = innerStringRange(text, node);
  return offset >= start && offset <= end;
}

/** Inside a `//` or `/* *\/` comment (an unterminated block runs to the end). */
function isInComment(text: string, offset: number): boolean {
  const scanner = createScanner(text, false);
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EOF;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenOffset();
    if (start >= offset) return false;
    const end = start + scanner.getTokenLength();
    if (token === SyntaxKind.LineCommentTrivia && offset <= end) return true;
    if (token === SyntaxKind.BlockCommentTrivia) {
      const closed = text.startsWith("*/", end - 2) && end - start >= 4;
      if (closed ? offset < end - 1 : offset <= end) return true;
    }
  }
  return false;
}

/** Every string value whose field has `role` (e.g. every prompt), decoded. */
export function getJsonTextSpans(
  text: string,
  role: WorkflowLocationRole
): WorkflowTextSpan[] {
  const tree = parseTree(text, [], JSON_PARSE_OPTIONS);
  if (!tree) return [];
  const root = parse(text, [], JSON_PARSE_OPTIONS) as unknown;
  const spans: WorkflowTextSpan[] = [];
  const visit = (node: Node) => {
    if (node.type === JSON_NODE.OBJECT) {
      const objectPath = getNodePath(node);
      const objectKind = classifyWorkflowObject(objectPath, root);
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        if (!keyNode || !valueNode) continue;
        const field = String(keyNode.value);
        if (
          valueNode.type === JSON_NODE.STRING &&
          getTextRole(objectKind, field) === role
        ) {
          const sourceRange = innerStringRange(text, valueNode);
          spans.push(
            createTextSpan(
              {
                kind: CTRLYOKE_FILE_KINDS.WORKFLOW_JSON,
                path: [...objectPath, field],
                field,
                objectKind,
                role,
                sourceRange,
              },
              decodeJsonString(
                text.slice(sourceRange.start, sourceRange.end),
                sourceRange.start
              ),
              typeof valueNode.value === "string" ? valueNode.value : undefined
            )
          );
        } else {
          visit(valueNode);
        }
      }
    } else if (node.type === JSON_NODE.ARRAY) {
      node.children?.forEach(visit);
    }
  };
  visit(tree);
  return spans;
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
    const end = node.offset + node.length;
    // A list item or the root has no key: clip to its first line, as YAML does.
    return {
      start: node.offset,
      end: isCollection ? Math.min(end, lineEndFrom(text, node.offset)) : end,
    };
  }
  return undefined;
}
