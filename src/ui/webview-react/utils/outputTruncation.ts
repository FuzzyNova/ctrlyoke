import { DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT } from "@root/types/CtrlYokeSettings";

/**
 * Shared fallback for direct component consumers. The configurable UI setting
 * is threaded through output rows for Bash and generic tool results.
 */
export const DEFAULT_COLLAPSED_OUTPUT_MAX_LINES =
  DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT;
/** Fallback when output geometry is unavailable (for example direct component use). */
export const DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS = 1200;
/** Hard ceiling for a collapsed preview, even when the configured line count is high. */
export const MAX_COLLAPSED_OUTPUT_MAX_CHARS = 100_000;
export const DEFAULT_COLLAPSED_COMMAND_MAX_CHARS = 160;

/**
 * Governs both how script output (pre-conditions, end-conditions, script steps)
 * is chopped into rows and how much of it stays visible while the script runs.
 *
 * One number covers both because they answer the same question: how much script
 * output is worth looking at in one go. It is deliberately far larger than
 * `collapsedToolOutputLineCount`, which trims an *incidental* tool result down
 * to a glance — a script's output is the reason its step exists, so the default
 * is a screenful. Hardcoded rather than surfaced as a setting until someone
 * actually needs a different number; keep it here so both uses move together.
 */
export const SCRIPT_OUTPUT_LINES_PER_ROW = 30;

export function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Offset at which each line starts. A trailing newline terminates the final
 * line rather than opening an empty one, which is what the pane renders.
 *
 * Built with `indexOf` over the raw string instead of `split("\n")` so walking
 * a few hundred KB of streamed output costs one scan and an offset array rather
 * than thousands of substrings — this runs on every rebuild while a script is
 * still producing output.
 */
function getLineStartOffsets(body: string): number[] {
  if (body.length === 0) {
    return [];
  }

  const offsets = [0];
  let newlineIndex = body.indexOf("\n");
  while (newlineIndex !== -1) {
    offsets.push(newlineIndex + 1);
    newlineIndex = body.indexOf("\n", newlineIndex + 1);
  }
  return offsets;
}

/**
 * Splits `text` into consecutive chunks of at most `linesPerSegment` lines,
 * preserving the original text exactly when the chunks are rejoined with "\n".
 */
export function splitTextIntoLineSegments(
  text: string,
  linesPerSegment: number
): string[] {
  const body = stripTrailingNewline(text);
  if (body.length === 0) {
    return [];
  }

  const lineStarts = getLineStartOffsets(body);
  const size = Math.max(1, Math.floor(linesPerSegment));
  const segments: string[] = [];

  for (let line = 0; line < lineStarts.length; line += size) {
    const nextLine = line + size;
    segments.push(
      nextLine < lineStarts.length
        ? // -1 drops the newline that the next segment starts after.
          body.slice(lineStarts[line], lineStarts[nextLine] - 1)
        : body.slice(lineStarts[line])
    );
  }

  return segments;
}

export interface TrailingLinesWindow {
  /** The last `maxLines` lines of the source text. */
  text: string;
  /** How many lines precede the window. */
  hiddenLineCount: number;
  totalLineCount: number;
}

/** Keeps only the last `maxLines` lines of `text`, reporting what it dropped. */
export function takeTrailingLines(
  text: string,
  maxLines: number
): TrailingLinesWindow {
  const body = stripTrailingNewline(text);
  const lineStarts = getLineStartOffsets(body);
  const limit = Math.max(1, Math.floor(maxLines));
  const hiddenLineCount = Math.max(0, lineStarts.length - limit);

  return {
    text:
      hiddenLineCount === 0 ? body : body.slice(lineStarts[hiddenLineCount]),
    hiddenLineCount,
    totalLineCount: lineStarts.length,
  };
}

/**
 * Label for the script-output tail toggle. Unlike a collapsed tool result — cut
 * off at the bottom, so "[show N more lines]" reads forward — script output is
 * cut off at the *top*, so the collapsed label has to say which direction the
 * hidden lines are in.
 */
export function formatScriptOutputTailToggleLabel(
  hiddenLineCount: number,
  expanded: boolean
): string {
  if (expanded) {
    return "[show less]";
  }

  return `[show full output — ${hiddenLineCount} earlier line${
    hiddenLineCount !== 1 ? "s" : ""
  }]`;
}

export interface CollapsedOutputCharacterLimitOptions {
  maxLines: number;
  contentWidth?: number;
  outputFontSize: number;
  horizontalChrome?: number;
  charWidthMultiplier?: number;
}

/**
 * Converts a requested visible-line count into a width-aware character budget.
 * Logical newlines are still capped separately by buildCollapsedOutputPreview.
 */
export function getCollapsedOutputMaxChars({
  maxLines,
  contentWidth,
  outputFontSize,
  horizontalChrome = 0,
  charWidthMultiplier = 0.6,
}: CollapsedOutputCharacterLimitOptions): number {
  if (contentWidth == null || contentWidth <= 0) {
    return DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS;
  }

  const charWidth = Math.max(5.5, outputFontSize * charWidthMultiplier);
  const availableWidth = Math.max(80, contentWidth - horizontalChrome);
  const charsPerLine = Math.max(8, Math.floor(availableWidth / charWidth));
  const lineCount = Number.isFinite(maxLines)
    ? Math.max(1, Math.floor(maxLines))
    : DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;

  return Math.min(MAX_COLLAPSED_OUTPUT_MAX_CHARS, lineCount * charsPerLine);
}

export interface CollapsedOutputPreview {
  fullLineCount: number;
  visibleLineCount: number;
  hiddenLineCount: number;
  visibleText: string;
  isTruncated: boolean;
}

export interface CollapsedOutputPreviewOptions {
  expanded: boolean;
  maxLines?: number;
  maxChars?: number;
}

export interface CollapsedSingleLinePreviewOptions {
  expanded: boolean;
  maxChars?: number;
}

function countLines(text: string): number {
  const body = stripTrailingNewline(text);
  return body.length === 0 ? 0 : body.split("\n").length;
}

function getLineLimitEnd(text: string, maxLines: number): number {
  if (maxLines <= 0) {
    return 0;
  }

  let seenLines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") {
      continue;
    }
    if (seenLines >= maxLines) {
      return index;
    }
    seenLines++;
  }

  return text.length;
}

export function buildCollapsedOutputPreview(
  text: string,
  {
    expanded,
    maxLines = DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
    maxChars = DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  }: CollapsedOutputPreviewOptions
): CollapsedOutputPreview {
  const fullLineCount = countLines(text);
  if (expanded || (text.length <= maxChars && fullLineCount <= maxLines)) {
    return {
      fullLineCount,
      visibleLineCount: fullLineCount,
      hiddenLineCount: 0,
      visibleText: text,
      isTruncated: false,
    };
  }

  const lineLimitEnd = getLineLimitEnd(text, maxLines);
  const charLimitEnd = maxChars > 0 ? Math.min(text.length, maxChars) : 0;
  const visibleEnd = Math.min(lineLimitEnd, charLimitEnd);
  const visibleText = text.slice(0, visibleEnd).replace(/\n+$/g, "");
  const visibleLineCount = countLines(visibleText);
  const hiddenLineCount = Math.max(0, fullLineCount - visibleLineCount);

  // If only 1 line would be hidden and the full text is within the char budget,
  // the toggle link takes as much space as the hidden line — show everything.
  // The char-budget guard is critical: a single logical line can contain millions
  // of characters that wrap to many visual lines, so we must not bypass maxChars.
  if (hiddenLineCount <= 1 && text.length <= maxChars) {
    return {
      fullLineCount,
      visibleLineCount: fullLineCount,
      hiddenLineCount: 0,
      visibleText: text,
      isTruncated: false,
    };
  }

  return {
    fullLineCount,
    visibleLineCount,
    hiddenLineCount,
    visibleText,
    isTruncated: visibleEnd < text.length,
  };
}

export function formatCollapsedOutputToggleLabel(
  preview: Pick<CollapsedOutputPreview, "hiddenLineCount">,
  expanded: boolean
): string {
  if (expanded) {
    return "[show less]";
  }

  if (preview.hiddenLineCount <= 0) {
    return "[show more output]";
  }

  return `[show ${preview.hiddenLineCount} more line${
    preview.hiddenLineCount !== 1 ? "s" : ""
  }]`;
}

export function buildCollapsedSingleLinePreview(
  text: string,
  {
    expanded,
    maxChars = DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  }: CollapsedSingleLinePreviewOptions
): CollapsedOutputPreview {
  return buildCollapsedOutputPreview(text.replace(/\s*\n+\s*/g, " "), {
    expanded,
    maxLines: 1,
    maxChars,
  });
}
