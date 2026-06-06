export const DEFAULT_COLLAPSED_OUTPUT_MAX_LINES = 10;
export const DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS = 1200;

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

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
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

  return {
    fullLineCount,
    visibleLineCount,
    hiddenLineCount: Math.max(0, fullLineCount - visibleLineCount),
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
