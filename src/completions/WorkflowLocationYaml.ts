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
  WORKFLOW_OBJECT_KINDS,
} from "../types/DashboardConstants";
import type {
  CtrlYokeFileKind,
  WorkflowLocationRole,
} from "../types/DashboardConstants";
import {
  buildWorkflowLocation,
  classifyWorkflowObject,
  getTextRole,
  lineEndFrom,
  splitValuePath,
  YAML_SCALAR_STYLES,
  type WorkflowLocation,
  type WorkflowLocationInput,
  type WorkflowPath,
  type WorkflowTextRange,
  type YamlScalarStyle,
} from "./WorkflowLocationTypes";
import {
  createTextSpan,
  decodeYamlBlockScalar,
  decodeYamlFlowScalar,
  YAML_FLOW_STYLES,
  type DecodedText,
  type WorkflowTextSpan,
  type YamlFlowStyle,
} from "./WorkflowTextDecoding";

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

/** The partially parsed document as plain data (undefined if the parser gives up). */
export function parseYamlRoot(text: string): unknown {
  return parseYaml(text).root;
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
    // Before an opening or past a closing quote the cursor is not in the string.
    contains: (offset) =>
      quoted
        ? offset > start &&
          (terminated ? offset < valueEnd : offset <= valueEnd)
        : offset >= start && offset <= valueEnd,
  };
}

/** Lists whose items are objects, so a bare scalar item is a half-typed key. */
const OBJECT_LIST_KEYS: ReadonlySet<string> = new Set([
  PROMPT_PROPERTIES.STEPS,
  PROMPT_PROPERTIES.PARALLEL,
  PROMPT_PROPERTIES.HOOKS,
]);

/** What a key looks like while it is still being typed. */
const PARTIAL_KEY = /^[\w.$-]*$/;

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
    path: WorkflowPath,
    parentInFlow: boolean
  ): WorkflowLocation | undefined => {
    const inFlow =
      parentInFlow || ((isMap(node) || isSeq(node)) && node.flow === true);
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
            inFlowCollection: inFlow,
          });
        }
        const value = pair.value as YamlNode | null;
        if (isScalar(value)) {
          const firstKey = halfTypedFirstKey(
            pair.key,
            value,
            [...path, key],
            inFlow
          );
          if (firstKey) return firstKey;
          const hit = scalarHit(value, path, key, undefined, inFlow);
          if (hit) return hit;
        } else if (value && rangeContains(value, offset)) {
          return visit(value, [...path, key], inFlow);
        }
      }
      // `{ prompt: x, § }`: a new key in a flow mapping.
      return node.flow && insideFlowBrackets(node)
        ? buildWorkflowLocation({
            kind,
            root: parsed.root,
            ownerPath: path,
            isKey: true,
            inFlowCollection: true,
          })
        : undefined;
    }
    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        if (isScalar(item)) {
          const itemPath = [...path, index];
          const { ownerPath, key } = splitValuePath(itemPath);
          if (
            key !== undefined &&
            OBJECT_LIST_KEYS.has(key) &&
            (typeof item.value === "string" || item.value === null) &&
            rangeContains(item, offset)
          ) {
            // `- pro` (or an empty `- `) in steps: the first key of a new
            // item, not a string item.
            return buildWorkflowLocation({
              kind,
              root: parsed.root,
              ownerPath: itemPath,
              key: typeof item.value === "string" ? item.value : undefined,
              isKey: true,
              inFlowCollection: inFlow,
            });
          }
          const hit = scalarHit(item, ownerPath, key, itemPath, inFlow);
          if (hit) return hit;
        } else if (rangeContains(item as YamlNode, offset)) {
          return visit(item, [...path, index], inFlow);
        }
      }
      // `[a, §]`: a new item in a flow sequence.
      if (node.flow && insideFlowBrackets(node)) {
        const index = node.items.filter((item) => {
          const end = (item as YamlNode | null)?.range?.[1];
          return end !== undefined && end <= offset;
        }).length;
        const itemPath = [...path, index];
        const { ownerPath, key } = splitValuePath(itemPath);
        return buildWorkflowLocation({
          kind,
          root: parsed.root,
          ownerPath,
          key,
          isKey: false,
          valuePath: itemPath,
          valueRange: { start: offset, end: offset },
          inFlowCollection: true,
        });
      }
    }
    return undefined;
  };

  const insideFlowBrackets = (node: YamlNode) =>
    !!node.range && offset > node.range[0] && offset < node.range[1];

  /**
   * `endCondition:` then `ret` on the next line parses as the plain value of
   * `endCondition`, but it is the first key of a new nested object.
   */
  const halfTypedFirstKey = (
    keyNode: Scalar,
    value: Scalar,
    objectPath: WorkflowPath,
    inFlow: boolean
  ): WorkflowLocation | undefined => {
    if (
      value.type !== Scalar.PLAIN ||
      !value.range ||
      !keyNode.range ||
      offset < value.range[0] ||
      offset > value.range[1]
    ) {
      return undefined;
    }
    const source = text.slice(value.range[0], value.range[1]);
    if (
      !PARTIAL_KEY.test(source) ||
      !text.slice(keyNode.range[1], value.range[0]).includes("\n") ||
      classifyWorkflowObject(objectPath, parsed.root) ===
        WORKFLOW_OBJECT_KINDS.UNKNOWN
    ) {
      return undefined;
    }
    return buildWorkflowLocation({
      kind,
      root: parsed.root,
      ownerPath: objectPath,
      key: source,
      isKey: true,
      inFlowCollection: inFlow,
    });
  };

  const scalarHit = (
    node: Scalar,
    ownerPath: WorkflowPath,
    key: string | undefined,
    valuePath: WorkflowPath | undefined,
    inFlow: boolean
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
      inFlowCollection: inFlow,
    });
  };

  return visit(parsed.doc.contents, [], false);
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

const INLINE_VALUE_STATES = {
  /** Plain text the cursor is still typing. */
  PLAIN: "plain",
  /** Inside a quoted scalar that is not closed yet. */
  QUOTED: "quoted",
  /** In a trailing comment, or past a closed quote: not part of the value. */
  OUTSIDE: "outside",
} as const;

/**
 * Where the cursor stands in the value typed so far on a `key: value` line.
 * A `#` starts a comment only at the start or after whitespace, and never
 * inside quotes.
 */
function inlineValueState(value: string): {
  state: (typeof INLINE_VALUE_STATES)[keyof typeof INLINE_VALUE_STATES];
  quoteStyle?: YamlScalarStyle;
} {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const quoteStyle =
      quote === '"'
        ? YAML_SCALAR_STYLES.DOUBLE_QUOTED
        : YAML_SCALAR_STYLES.SINGLE_QUOTED;
    for (let index = 1; index < value.length; index++) {
      if (quote === '"' && value[index] === "\\") {
        index++;
      } else if (value[index] === quote) {
        // `''` is an escaped quote inside a single-quoted scalar.
        if (quote === "'" && value[index + 1] === "'") {
          index++;
          continue;
        }
        return { state: INLINE_VALUE_STATES.OUTSIDE, quoteStyle };
      }
    }
    return { state: INLINE_VALUE_STATES.QUOTED, quoteStyle };
  }
  return /(^|\s)#/.test(value)
    ? { state: INLINE_VALUE_STATES.OUTSIDE }
    : { state: INLINE_VALUE_STATES.PLAIN };
}

/** End of a block scalar's body: its last line indented past `keyCol`. */
function blockBodyEnd(text: string, offset: number, keyCol: number): number {
  const trimCr = (end: number) => (text[end - 1] === "\r" ? end - 1 : end);
  let lineEnd = lineEndFrom(text, offset);
  let bodyEnd = Math.max(offset, trimCr(lineEnd));
  while (lineEnd < text.length) {
    const start = lineEnd + 1;
    lineEnd = lineEndFrom(text, start);
    const line = text.slice(start, trimCr(lineEnd));
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= keyCol) break;
    bodyEnd = trimCr(lineEnd);
  }
  return bodyEnd;
}

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
  let blockBodyStart = 0;
  let lineStart = 0;

  for (let index = 0; index < cursorLine; index++) {
    const nextLineStart = lineStart + lines[index].length + 1;
    const line = lines[index].replace(/\r$/, "");
    lineStart = nextLineStart;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (blockKeyCol >= 0) {
      if (line.search(/\S/) > blockKeyCol) continue;
      blockKeyCol = -1;
    }
    const { keyCol, rest } = applyLine(frames, line);
    const match = KEY_LINE.exec(rest);
    if (!match) continue;
    setKey(frames, keyCol, unquoteKey(match[1]));
    if (BLOCK_HEADER.test((match[2] ?? "").trim())) {
      blockKeyCol = keyCol;
      blockBodyStart = nextLineStart;
    }
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
  // The range is the whole body, as on the parser path.
  if (blockKeyCol >= 0 && cursorIndent > blockKeyCol) {
    const key = frames[frames.length - 1]?.key;
    return build(frames, {
      key,
      textCapable: true,
      valueRange: {
        start: blockBodyStart,
        end: blockBodyEnd(text, offset, blockKeyCol),
      },
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
    const key = frames[frames.length - 1].key;
    const value = (match[2] ?? "").trimStart();
    const onHeader = BLOCK_HEADER.test(value.trim());
    const inline = onHeader ? undefined : inlineValueState(value);
    if (inline?.state === INLINE_VALUE_STATES.OUTSIDE) {
      return build(frames, { key, role: WORKFLOW_LOCATION_ROLES.NONE });
    }
    const quoted = inline?.state === INLINE_VALUE_STATES.QUOTED;
    // `key: §"text"`: anything typed here lands outside the quotes.
    const beforeOpeningQuote =
      value === "" && (text[offset] === '"' || text[offset] === "'");
    return build(frames, {
      key,
      textCapable: !onHeader && !beforeOpeningQuote && !/^[[{]/.test(value),
      valueRange: onHeader
        ? undefined
        : {
            start: offset - value.length + (quoted ? 1 : 0),
            end: offset,
          },
      scalarStyle: inline?.quoteStyle ?? YAML_SCALAR_STYLES.PLAIN,
    });
  }

  // Typing a key (or empty): find the object that will own it.
  if (PARTIAL_KEY.test(rest)) {
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

const FLOW_STYLE_BY_SCALAR_STYLE: Readonly<
  Partial<Record<YamlScalarStyle, YamlFlowStyle>>
> = {
  [YAML_SCALAR_STYLES.PLAIN]: YAML_FLOW_STYLES.PLAIN,
  [YAML_SCALAR_STYLES.SINGLE_QUOTED]: YAML_FLOW_STYLES.SINGLE_QUOTED,
  [YAML_SCALAR_STYLES.DOUBLE_QUOTED]: YAML_FLOW_STYLES.DOUBLE_QUOTED,
};

function decodeScalar(
  text: string,
  node: Scalar
): { sourceRange: WorkflowTextRange; decoded: DecodedText } | undefined {
  const geometry = scalarGeometry(text, node);
  if (!geometry?.valueRange || !node.range) return undefined;
  const { valueRange } = geometry;
  const flowStyle = FLOW_STYLE_BY_SCALAR_STYLE[geometry.style];
  const decoded = flowStyle
    ? decodeYamlFlowScalar(
        text.slice(valueRange.start, valueRange.end),
        valueRange.start,
        flowStyle
      )
    : decodeYamlBlockScalar(text, node.range[0], node.range[1]);
  return { sourceRange: valueRange, decoded };
}

/** Every string value whose field has `role` (e.g. every prompt), decoded. */
export function getYamlTextSpans(
  text: string,
  role: WorkflowLocationRole,
  kind: CtrlYokeFileKind = CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
): WorkflowTextSpan[] {
  const parsed = parseYaml(text);
  const spans: WorkflowTextSpan[] = [];
  const visit = (node: unknown, path: WorkflowPath) => {
    if (isMap(node)) {
      const objectKind = classifyWorkflowObject(path, parsed.root);
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const field = String(pair.key.value);
        const value = pair.value;
        if (
          isScalar(value) &&
          typeof value.value === "string" &&
          getTextRole(objectKind, field) === role
        ) {
          const decoded = decodeScalar(text, value);
          if (!decoded) continue;
          spans.push(
            createTextSpan(
              {
                kind,
                path: [...path, field],
                field,
                objectKind,
                role,
                sourceRange: decoded.sourceRange,
              },
              decoded.decoded,
              value.value
            )
          );
        } else {
          visit(value, [...path, field]);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => visit(item, [...path, index]));
    }
  };
  visit(parsed.doc.contents, []);
  return spans;
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
