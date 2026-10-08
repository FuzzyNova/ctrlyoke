import type {
  CtrlYokeFileKind,
  WorkflowLocationRole,
  WorkflowObjectKind,
} from "../types/DashboardConstants";
import type { WorkflowPath, WorkflowTextRange } from "./WorkflowLocationTypes";

/**
 * Decoding workflow string values while keeping an offset map back to the
 * source, so a rule that runs on the decoded text (`findCodeRanges`,
 * reference scanning, prompt lint) can report ranges in the document. Pure:
 * no parser imports, so both the JSON and the YAML halves use it.
 */

/** Decoded text plus, for every decoded index (and one past the end), its source offset. */
export interface DecodedText {
  readonly text: string;
  readonly sourceOffsets: readonly number[];
}

/** One prompt- or script-bearing value in a workflow document. */
export interface WorkflowTextSpan {
  readonly kind: CtrlYokeFileKind;
  /** Path of the value, e.g. `["steps", 0, "endCondition", "retryPrompt"]`; `[]` for a `.prompt.md` body. */
  readonly path: WorkflowPath;
  /** The key holding the value (`prompt`, `retryPrompt`, ...); absent for a `.prompt.md` body. */
  readonly field?: string;
  readonly objectKind: WorkflowObjectKind;
  readonly role: WorkflowLocationRole;
  /** The raw source span of the value's content (inside quotes, after a block header). */
  readonly sourceRange: WorkflowTextRange;
  /** The value as the loader sees it: unescaped, dedented, folded and chomped. */
  readonly text: string;
  /**
   * False when the decoder could not reproduce the parser's value exactly; the
   * text is then the parser's and offsets are only approximate.
   */
  readonly exact: boolean;
  /** Document offset of a decoded offset (0..text.length). */
  toSourceOffset(decodedOffset: number): number;
}

export function createTextSpan(
  fields: Omit<WorkflowTextSpan, "text" | "exact" | "toSourceOffset">,
  decoded: DecodedText,
  parsedValue?: string
): WorkflowTextSpan {
  const exact = parsedValue === undefined || parsedValue === decoded.text;
  const text = exact ? decoded.text : (parsedValue ?? decoded.text);
  const { start, end } = fields.sourceRange;
  const offsets = decoded.sourceOffsets;
  return {
    ...fields,
    text,
    exact,
    toSourceOffset: (decodedOffset) => {
      const index = Math.max(0, Math.min(decodedOffset, text.length));
      return exact ? offsets[index] : Math.min(start + index, end);
    },
  };
}

class DecodedTextBuilder {
  private readonly chars: string[] = [];
  private readonly offsets: number[] = [];

  push(value: string, sourceOffset: number): void {
    for (let index = 0; index < value.length; index++) {
      this.chars.push(value[index]);
      this.offsets.push(sourceOffset);
    }
  }

  get length(): number {
    return this.chars.length;
  }

  /** Drop decoded characters from the end (block-scalar chomping). */
  truncate(length: number): void {
    this.chars.length = length;
    this.offsets.length = length;
  }

  lastOffset(): number | undefined {
    return this.offsets[this.offsets.length - 1];
  }

  build(endOffset: number): DecodedText {
    return {
      text: this.chars.join(""),
      sourceOffsets: [...this.offsets, endOffset],
    };
  }
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Decode the content between a JSON string's quotes, starting at `base`. */
export function decodeJsonString(source: string, base: number): DecodedText {
  const out = new DecodedTextBuilder();
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char !== "\\") {
      out.push(char, base + index);
      continue;
    }
    const next = source[index + 1];
    if (
      next === "u" &&
      /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))
    ) {
      out.push(
        String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)),
        base + index
      );
      index += 5;
    } else if (next !== undefined && JSON_ESCAPES[next] !== undefined) {
      out.push(JSON_ESCAPES[next], base + index);
      index += 1;
    } else {
      out.push(char, base + index);
    }
  }
  return out.build(base + source.length);
}

const YAML_DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  ...JSON_ESCAPES,
  "0": "\0",
  a: "\x07",
  e: "\x1b",
  v: "\v",
  " ": " ",
  "\t": "\t",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};

const YAML_HEX_ESCAPE_LENGTHS: Readonly<Record<string, number>> = {
  x: 2,
  u: 4,
  U: 8,
};

const isLineBreak = (char: string | undefined) =>
  char === "\n" || char === "\r";
const isBlank = (char: string | undefined) => char === " " || char === "\t";

/** Index just past the line break at `index` (`\r\n` counts as one). */
function skipLineBreak(source: string, index: number): number {
  return source[index] === "\r" && source[index + 1] === "\n"
    ? index + 2
    : index + 1;
}

export const YAML_FLOW_STYLES = {
  PLAIN: "plain",
  SINGLE_QUOTED: "singleQuoted",
  DOUBLE_QUOTED: "doubleQuoted",
} as const;
export type YamlFlowStyle =
  (typeof YAML_FLOW_STYLES)[keyof typeof YAML_FLOW_STYLES];

/**
 * Decode a plain or quoted YAML scalar's content (inside the quotes) starting
 * at `base`. Line breaks fold: one break becomes a space, and each empty line
 * becomes a newline; whitespace around a break is dropped.
 */
export function decodeYamlFlowScalar(
  source: string,
  base: number,
  style: YamlFlowStyle
): DecodedText {
  const out = new DecodedTextBuilder();
  // Whitespace is held back until a non-blank follows on the same line, since
  // trailing whitespace before a break is not part of the value.
  let pending: { char: string; offset: number }[] = [];
  const flush = () => {
    for (const { char, offset } of pending) out.push(char, offset);
    pending = [];
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (isBlank(char)) {
      pending.push({ char, offset: base + index });
      index++;
      continue;
    }
    if (isLineBreak(char)) {
      pending = [];
      const firstBreak = base + index;
      index = skipLineBreak(source, index);
      const emptyLineBreaks: number[] = [];
      for (;;) {
        while (isBlank(source[index])) index++;
        if (!isLineBreak(source[index])) break;
        emptyLineBreaks.push(base + index);
        index = skipLineBreak(source, index);
      }
      if (emptyLineBreaks.length === 0) {
        out.push(" ", firstBreak);
      } else {
        for (const offset of emptyLineBreaks) out.push("\n", offset);
      }
      continue;
    }
    flush();
    if (style === YAML_FLOW_STYLES.SINGLE_QUOTED && char === "'") {
      // `''` is an escaped quote.
      out.push("'", base + index);
      index += source[index + 1] === "'" ? 2 : 1;
      continue;
    }
    if (style === YAML_FLOW_STYLES.DOUBLE_QUOTED && char === "\\") {
      index = decodeDoubleQuotedEscape(source, base, index, out);
      continue;
    }
    out.push(char, base + index);
    index++;
  }
  flush();
  return out.build(base + source.length);
}

/** Decode the escape at `index` (a backslash); returns the index after it. */
function decodeDoubleQuotedEscape(
  source: string,
  base: number,
  index: number,
  out: DecodedTextBuilder
): number {
  const next = source[index + 1];
  if (isLineBreak(next)) {
    // An escaped line break joins the lines with nothing between them.
    let after = skipLineBreak(source, index + 1);
    while (isBlank(source[after])) after++;
    return after;
  }
  const hexLength =
    next === undefined ? undefined : YAML_HEX_ESCAPE_LENGTHS[next];
  if (hexLength !== undefined) {
    const hex = source.slice(index + 2, index + 2 + hexLength);
    if (hex.length === hexLength && /^[0-9a-fA-F]+$/.test(hex)) {
      out.push(String.fromCodePoint(parseInt(hex, 16)), base + index);
      return index + 2 + hexLength;
    }
  }
  const escaped =
    next === undefined ? undefined : YAML_DOUBLE_QUOTED_ESCAPES[next];
  if (escaped !== undefined) {
    out.push(escaped, base + index);
    return index + 2;
  }
  out.push("\\", base + index);
  return index + 1;
}

const BLOCK_CHOMPING = { CLIP: "clip", STRIP: "strip", KEEP: "keep" } as const;

interface BlockLine {
  /** Source offset where the line starts. */
  readonly start: number;
  /** Source offset of the line's end (before its break). */
  readonly end: number;
  /** Source offset of the line break, or `end` for the last line. */
  readonly breakOffset: number;
  readonly text: string;
}

function splitBlockLines(
  text: string,
  start: number,
  end: number
): BlockLine[] {
  const lines: BlockLine[] = [];
  let lineStart = start;
  while (lineStart < end) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0 || lineEnd > end) lineEnd = end;
    const contentEnd =
      lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    lines.push({
      start: lineStart,
      end: contentEnd,
      breakOffset: contentEnd,
      text: text.slice(lineStart, contentEnd),
    });
    lineStart = lineEnd + 1;
  }
  return lines;
}

/**
 * Decode a block scalar (`|` or `>`) whose header starts at `headerStart` and
 * whose node ends at `end`. Content lines are dedented by the block's indent;
 * `>` folds, and the chomping indicator decides the trailing newlines.
 */
export function decodeYamlBlockScalar(
  text: string,
  headerStart: number,
  end: number
): DecodedText {
  const headerEnd = text.indexOf("\n", headerStart);
  const contentStart = headerEnd < 0 || headerEnd >= end ? end : headerEnd + 1;
  const header = text.slice(headerStart, headerEnd < 0 ? end : headerEnd);
  const folded = header.startsWith(">");
  const indicators = /^[|>]([+-]?)(\d?)([+-]?)/.exec(header);
  const chompChar = indicators?.[1] || indicators?.[3];
  const chomping =
    chompChar === "-"
      ? BLOCK_CHOMPING.STRIP
      : chompChar === "+"
        ? BLOCK_CHOMPING.KEEP
        : BLOCK_CHOMPING.CLIP;
  const lines = splitBlockLines(text, contentStart, end);
  const leadingSpaces = (line: string) => line.length - line.trimStart().length;
  const explicitIndent = Number(indicators?.[2] || 0);
  let indent: number;
  if (explicitIndent > 0) {
    // Relative to the line that holds the header.
    const headerLineStart = text.lastIndexOf("\n", headerStart - 1) + 1;
    indent =
      leadingSpaces(text.slice(headerLineStart, headerStart)) + explicitIndent;
  } else {
    const first = lines.find((line) => line.text.trim() !== "");
    indent = first ? leadingSpaces(first.text) : 0;
  }

  const content = lines.map((line) => {
    const strip = Math.min(indent, leadingSpaces(line.text));
    return {
      ...line,
      contentStart: line.start + strip,
      content: line.text.slice(strip),
      empty: line.text.trim() === "" && line.text.length <= indent,
    };
  });
  let lastContent = -1;
  content.forEach((line, index) => {
    if (!line.empty) lastContent = index;
  });

  const out = new DecodedTextBuilder();
  const pushLine = (line: (typeof content)[number]) => {
    for (let index = 0; index < line.content.length; index++) {
      out.push(line.content[index], line.contentStart + index);
    }
  };
  const moreIndented = (line: (typeof content)[number]) =>
    isBlank(line.content[0]);

  for (let index = 0; index <= lastContent; index++) {
    const line = content[index];
    if (!folded || line.empty) {
      pushLine(line);
      if (index < lastContent) out.push("\n", line.breakOffset);
      continue;
    }
    pushLine(line);
    if (index === lastContent) break;
    let next = index + 1;
    while (next <= lastContent && content[next].empty) next++;
    const empties = next - index - 1;
    if (!moreIndented(line) && !moreIndented(content[next])) {
      if (empties === 0) {
        out.push(" ", line.breakOffset);
      } else {
        for (let empty = index + 1; empty < next; empty++) {
          out.push("\n", content[empty].breakOffset);
        }
      }
    } else {
      out.push("\n", line.breakOffset);
      for (let empty = index + 1; empty < next; empty++) {
        out.push("\n", content[empty].breakOffset);
      }
    }
    index = next - 1;
  }

  const lastLine = lastContent >= 0 ? content[lastContent] : undefined;
  if (lastLine && chomping !== BLOCK_CHOMPING.STRIP) {
    out.push("\n", lastLine.breakOffset);
  }
  if (chomping === BLOCK_CHOMPING.KEEP) {
    const trailing = content.slice(lastContent + 1);
    // The last split line has no break of its own unless the source ended in one.
    for (const [index, line] of trailing.entries()) {
      const hasBreak =
        index < trailing.length - 1 || isLineBreak(text[line.end]);
      if (hasBreak) out.push("\n", line.breakOffset);
    }
  }
  const endOffset = lastLine ? lastLine.end : contentStart;
  if (out.length === 0) return out.build(contentStart);
  return out.build(Math.max(endOffset, out.lastOffset() ?? endOffset));
}
