import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type Node as YamlNode,
} from "yaml";
import {
  CTRLYOKE_FILE_KINDS,
  PROMPT_PROPERTIES,
  WORKFLOW_LOCATION_ROLES,
} from "../types/DashboardConstants";
import type { CtrlYokeFileKind } from "../types/DashboardConstants";
import {
  buildWorkflowLocation,
  splitValuePath,
  YAML_SCALAR_STYLES,
  type WorkflowLocation,
  type WorkflowLocationInput,
  type WorkflowPath,
  type WorkflowTextRange,
  type YamlScalarStyle,
} from "./WorkflowLocationTypes";

/**
 * The YAML half of workflow location, kept in its own file so the hosted
 * webview can `import()` it lazily (the `yaml` package is ~35 KB gzipped).
 *
 * The `yaml` parser answers when the cursor is inside an existing node. A
 * blank line, a half-typed key or a block-scalar line has no node, so those
 * fall back to an indentation scan over the text before the cursor.
 */

interface YamlParse {
  readonly doc: Document.Parsed;
  readonly root: unknown;
}

function parseYaml(text: string): YamlParse {
  const doc = parseDocument(text, { prettyErrors: false });
  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: -1 });
  } catch {
    root = undefined;
  }
  return { doc, root };
}

function scalarStyleOf(node: Scalar): YamlScalarStyle {
  switch (node.type) {
    case Scalar.QUOTE_DOUBLE:
      return YAML_SCALAR_STYLES.DOUBLE_QUOTED;
    case Scalar.QUOTE_SINGLE:
      return YAML_SCALAR_STYLES.SINGLE_QUOTED;
    case Scalar.BLOCK_FOLDED:
    case Scalar.BLOCK_LITERAL:
      return YAML_SCALAR_STYLES.BLOCK;
    default:
      return YAML_SCALAR_STYLES.PLAIN;
  }
}

interface ScalarGeometry {
  readonly style: YamlScalarStyle;
  /** Where the cursor can edit the scalar's content; absent on a block header. */
  readonly valueRange?: WorkflowTextRange;
  readonly contains: (offset: number) => boolean;
}

function scalarGeometry(
  text: string,
  node: Scalar
): ScalarGeometry | undefined {
  if (!node.range) return undefined;
  const [start, valueEnd, nodeEnd] = node.range;
  const style = scalarStyleOf(node);
  if (style === YAML_SCALAR_STYLES.BLOCK) {
    const headerEnd = text.indexOf("\n", start);
    const contentStart = headerEnd < 0 ? valueEnd : headerEnd + 1;
    return {
      style,
      valueRange: {
        start: contentStart,
        end: Math.max(contentStart, valueEnd),
      },
      contains: (offset) =>
        offset >= start && offset < Math.max(nodeEnd, valueEnd),
    };
  }
  const quoted =
    style === YAML_SCALAR_STYLES.DOUBLE_QUOTED ||
    style === YAML_SCALAR_STYLES.SINGLE_QUOTED;
  const terminated =
    quoted && valueEnd - start >= 2 && text[valueEnd - 1] === text[start];
  return {
    style,
    valueRange: quoted
      ? { start: start + 1, end: terminated ? valueEnd - 1 : valueEnd }
      : { start, end: valueEnd },
    contains: (offset) => offset >= start && offset <= valueEnd,
  };
}

/** Lists whose items are objects, so a bare scalar item is a half-typed key. */
const OBJECT_LIST_KEYS: ReadonlySet<string> = new Set([
  PROMPT_PROPERTIES.STEPS,
  PROMPT_PROPERTIES.PARALLEL,
  PROMPT_PROPERTIES.HOOKS,
]);

function rangeContains(node: YamlNode | null | undefined, offset: number) {
  return !!node?.range && offset >= node.range[0] && offset <= node.range[1];
}

function locateInAst(
  text: string,
  parsed: YamlParse,
  kind: CtrlYokeFileKind,
  offset: number
): WorkflowLocation | undefined {
  const visit = (
    node: unknown,
    path: WorkflowPath
  ): WorkflowLocation | undefined => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || !pair.key.range) continue;
        const key = String(pair.key.value);
        const [keyStart, keyEnd] = pair.key.range;
        if (offset >= keyStart && offset <= keyEnd) {
          return buildWorkflowLocation({
            kind,
            root: parsed.root,
            ownerPath: path,
            key,
            isKey: true,
          });
        }
        const value = pair.value as YamlNode | null;
        if (isScalar(value)) {
          const hit = scalarHit(value, path, key, undefined);
          if (hit) return hit;
        } else if (value && rangeContains(value, offset)) {
          return visit(value, [...path, key]);
        }
      }
      return undefined;
    }
    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        if (isScalar(item)) {
          const itemPath = [...path, index];
          const { ownerPath, key } = splitValuePath(itemPath);
          if (
            key !== undefined &&
            OBJECT_LIST_KEYS.has(key) &&
            typeof item.value === "string" &&
            rangeContains(item, offset)
          ) {
            // `- pro` in steps: the first key of a new item, not a string item.
            return buildWorkflowLocation({
              kind,
              root: parsed.root,
              ownerPath: itemPath,
              key: item.value,
              isKey: true,
            });
          }
          const hit = scalarHit(item, ownerPath, key, itemPath);
          if (hit) return hit;
        } else if (rangeContains(item as YamlNode, offset)) {
          return visit(item, [...path, index]);
        }
      }
    }
    return undefined;
  };

  const scalarHit = (
    node: Scalar,
    ownerPath: WorkflowPath,
    key: string | undefined,
    valuePath: WorkflowPath | undefined
  ): WorkflowLocation | undefined => {
    const geometry = scalarGeometry(text, node);
    if (!geometry?.contains(offset)) return undefined;
    const onBlockHeader =
      geometry.style === YAML_SCALAR_STYLES.BLOCK &&
      geometry.valueRange !== undefined &&
      offset < geometry.valueRange.start;
    const isText = typeof node.value === "string" || node.value === null;
    return buildWorkflowLocation({
      kind,
      root: parsed.root,
      ownerPath,
      key,
      isKey: false,
      valuePath,
      textCapable: isText && !onBlockHeader && valuePath === undefined,
      valueRange: onBlockHeader ? undefined : geometry.valueRange,
      scalarStyle: geometry.style,
    });
  };

  return visit(parsed.doc.contents, []);
}

const SCAN_FRAME = { MAP: "map", SEQ: "seq" } as const;
type ScanFrameType = (typeof SCAN_FRAME)[keyof typeof SCAN_FRAME];

interface ScanFrame {
  readonly col: number;
  readonly type: ScanFrameType;
  key?: string;
  index: number;
}

const BLOCK_HEADER = /^[|>][+-]?\d*[+-]?\s*(#.*)?$/;
const KEY_LINE =
  /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#:[\]{}&*!|>'"%@`,-][^:#]*|-[^\s:][^:#]*)\s*:(?:\s+(.*)|\s*)$/;

function framePath(frames: readonly ScanFrame[], withTopKey: boolean) {
  const path: (string | number)[] = [];
  frames.forEach((frame, index) => {
    if (frame.type === SCAN_FRAME.SEQ) {
      path.push(frame.index);
    } else if (
      frame.key !== undefined &&
      (withTopKey || index < frames.length - 1)
    ) {
      path.push(frame.key);
    }
  });
  return path;
}

/** Applies one line's dashes and key to the frame stack; returns where the key starts. */
function applyLine(
  frames: ScanFrame[],
  line: string
): { keyCol: number; rest: string } {
  let col = line.search(/\S/);
  let rest = line.slice(col);
  while (/^-(\s|$)/.test(rest)) {
    while (frames.length > 0 && frames[frames.length - 1].col > col)
      frames.pop();
    const top = frames[frames.length - 1];
    if (top?.type === SCAN_FRAME.SEQ && top.col === col) {
      top.index++;
    } else {
      frames.push({ col, type: SCAN_FRAME.SEQ, index: 0 });
    }
    const gap = rest.slice(1).search(/\S/);
    const advance = gap < 0 ? rest.length : 1 + gap;
    col += advance;
    rest = rest.slice(advance);
  }
  return { keyCol: col, rest };
}

function setKey(frames: ScanFrame[], keyCol: number, key: string) {
  while (frames.length > 0 && frames[frames.length - 1].col > keyCol) {
    frames.pop();
  }
  const top = frames[frames.length - 1];
  if (top?.type === SCAN_FRAME.MAP && top.col === keyCol) {
    top.key = key;
  } else {
    frames.push({ col: keyCol, type: SCAN_FRAME.MAP, key, index: 0 });
  }
}

const unquoteKey = (raw: string) =>
  /^["']/.test(raw) ? raw.slice(1, -1) : raw.trim();

function locateByScan(
  text: string,
  parsed: YamlParse,
  kind: CtrlYokeFileKind,
  offset: number
): WorkflowLocation {
  const lines = text.slice(0, offset).split("\n");
  const cursorLine = lines.length - 1;
  const before = lines[cursorLine].replace(/\r$/, "");
  const frames: ScanFrame[] = [];
  let blockKeyCol = -1;

  for (let index = 0; index < cursorLine; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (blockKeyCol >= 0) {
      if (line.search(/\S/) > blockKeyCol) continue;
      blockKeyCol = -1;
    }
    const { keyCol, rest } = applyLine(frames, line);
    const match = KEY_LINE.exec(rest);
    if (!match) continue;
    setKey(frames, keyCol, unquoteKey(match[1]));
    if (BLOCK_HEADER.test((match[2] ?? "").trim())) blockKeyCol = keyCol;
  }

  const build = (
    ownerFrames: readonly ScanFrame[],
    extra: Partial<WorkflowLocationInput>
  ) =>
    buildWorkflowLocation({
      kind,
      root: parsed.root,
      ownerPath: framePath(ownerFrames, false),
      isKey: false,
      ...extra,
    });
  const cursorIndent =
    before.trim() === "" ? before.length : before.search(/\S/);

  // A line inside a block scalar: prompt or script text, no structure to track.
  if (blockKeyCol >= 0 && cursorIndent > blockKeyCol) {
    const key = frames[frames.length - 1]?.key;
    return build(frames, {
      key,
      textCapable: true,
      valueRange: { start: offset - before.length, end: offset },
      scalarStyle: YAML_SCALAR_STYLES.BLOCK,
    });
  }

  if (/^\s*#/.test(before)) {
    return build([], { role: WORKFLOW_LOCATION_ROLES.NONE });
  }

  const { keyCol, rest } =
    before.trim() === ""
      ? { keyCol: before.length, rest: "" }
      : applyLine(frames, before);
  const match = KEY_LINE.exec(rest);
  if (match) {
    // Cursor is after "key:" — a value.
    setKey(frames, keyCol, unquoteKey(match[1]));
    const value = (match[2] ?? "").trimStart();
    const onHeader = BLOCK_HEADER.test(value.trim());
    return build(frames, {
      key: frames[frames.length - 1].key,
      textCapable: !onHeader && !/^[[{]/.test(value),
      valueRange: onHeader
        ? undefined
        : { start: offset - value.length, end: offset },
      scalarStyle: YAML_SCALAR_STYLES.PLAIN,
    });
  }

  // Typing a key (or empty): find the object that will own it.
  if (/^[\w.$-]*$/.test(rest)) {
    while (frames.length > 0 && frames[frames.length - 1].col > keyCol) {
      frames.pop();
    }
    const top = frames[frames.length - 1];
    const sharesLevel = top?.type === SCAN_FRAME.MAP && top.col === keyCol;
    return buildWorkflowLocation({
      kind,
      root: parsed.root,
      ownerPath: framePath(sharesLevel ? frames.slice(0, -1) : frames, true),
      key: rest.length > 0 ? rest : undefined,
      isKey: true,
    });
  }

  // A scalar list item: `- value`.
  const top = frames[frames.length - 1];
  const itemPath = framePath(frames, false);
  const { ownerPath, key } = splitValuePath(itemPath);
  return buildWorkflowLocation({
    kind,
    root: parsed.root,
    ownerPath,
    key,
    isKey: false,
    valuePath: top?.type === SCAN_FRAME.SEQ ? itemPath : undefined,
  });
}

/** Error-tolerant location of `offset` in a workflow YAML document. */
export function getYamlWorkflowLocation(
  text: string,
  offset: number,
  kind: CtrlYokeFileKind = CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
): WorkflowLocation {
  const parsed = parseYaml(text);
  return (
    locateInAst(text, parsed, kind, offset) ??
    locateByScan(text, parsed, kind, offset)
  );
}

function lineEndFrom(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

/**
 * Range of the node at `path`: a scalar's own text, or the key for a mapping or
 * list. Falls back to the nearest ancestor that exists.
 */
export function findYamlRangeForPath(
  text: string,
  path: WorkflowPath
): WorkflowTextRange | undefined {
  const { doc } = parseYaml(text);
  for (let length = path.length; length >= 0; length--) {
    let node: unknown = doc.contents;
    let keyNode: Scalar | undefined;
    let found = true;
    for (const segment of path.slice(0, length)) {
      if (isMap(node) && typeof segment === "string") {
        const pair = node.items.find(
          (item) => isScalar(item.key) && String(item.key.value) === segment
        );
        if (!pair) {
          found = false;
          break;
        }
        keyNode = isScalar(pair.key) ? pair.key : undefined;
        node = pair.value;
      } else if (isSeq(node) && typeof segment === "number") {
        node = node.items[segment];
        keyNode = undefined;
      } else {
        found = false;
        break;
      }
    }
    if (!found || node === undefined || node === null) continue;
    const range = (node as YamlNode).range;
    const emptyScalar = isScalar(node) && (!range || range[1] <= range[0]);
    if ((isMap(node) || isSeq(node) || emptyScalar) && keyNode?.range) {
      return { start: keyNode.range[0], end: keyNode.range[1] };
    }
    if (!range) continue;
    if (isMap(node) || isSeq(node)) {
      return {
        start: range[0],
        end: Math.min(range[1], lineEndFrom(text, range[0])),
      };
    }
    return { start: range[0], end: range[1] };
  }
  return undefined;
}
