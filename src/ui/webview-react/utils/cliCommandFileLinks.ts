/**
 * Turns file-path references embedded in rendered CLI/script command text
 * (e.g. a temp prompt/excerpts/skills file, or a Claude-style `@file`
 * reference) into plain, non-chip links that open the referenced file.
 *
 * Unlike MarkdownText's auto-linking of AI prose, the visible/copied text of
 * a link here is always the untouched raw substring — only the click target
 * is normalized — because this text is the exact command ctrlyoke sent to
 * the CLI, and copying it must reproduce that byte-for-byte.
 */
import React from "react";
import { openFile } from "@hooks/useMessageHandler";
import {
  FILE_EXTENSIONS,
  SEP,
  normalizeCodexAbsPath,
} from "@utils/filePathPatterns";
import {
  highlightText,
  sliceDecorationMatches,
  type RowFindDecoration,
} from "./outputFind";

/**
 * Matches a file-path reference inside CLI/script command display text: an
 * optional Claude-style leading `@`, then a Windows-absolute, Codex
 * pseudo-absolute, slash-drive-absolute, explicitly-relative, or
 * bare-relative path — the bare-relative alternative allows one leading dot
 * segment (unlike MarkdownText's FILE_PATH_SOURCE) so `.ctrlyoke\temp\...`
 * matches — ending in a recognized extension.
 *
 * Built fresh rather than reusing FILE_PATH_SOURCE/IMAGE_PATH_SOURCE
 * directly: this needs the optional `@` prefix on every alternative (not
 * just images) plus the file-extension list, and touching FILE_PATH_SOURCE
 * itself would change MarkdownText's prose auto-linking behavior.
 */
const CLI_FILE_PATH_SOURCE =
  "@?" +
  "(?:" +
  "[A-Za-z]:" +
  SEP + // 1. Windows absolute  C:\  or  C:/  or  C:\\
  "|" +
  "/abs/path/" +
  "[A-Za-z]:/" + // 2. Codex pseudo-absolute /abs/path/c:/
  "|" +
  "/" +
  "[A-Za-z]:/" + // 3. Slash-prefixed Windows absolute /c:/
  "|" +
  "\\.{1,2}" +
  SEP + // 4. Relative prefix   ./   or  ../
  "|" +
  "\\.?[a-zA-Z][\\w-]*" +
  SEP + // 5. Bare relative, optional single leading dot segment (.ctrlyoke\, src\, …)
  ")" +
  "(?:[\\w.\\-]+" +
  SEP +
  ")*" + // Zero or more inner directory segments
  "[\\w.\\-]+" + // Final filename base
  "\\.(?:" +
  FILE_EXTENSIONS +
  ")\\b"; // Extension (required)

const ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export interface CliFileReferenceRange {
  start: number;
  end: number;
  /** Normalized filesystem path to open — not yet resolved against a working directory. */
  openPath: string;
}

/** Scans `text` for file-path references, returning their source ranges and normalized open targets. */
export function findCliFileReferenceRanges(
  text: string
): CliFileReferenceRange[] {
  const regex = new RegExp(CLI_FILE_PATH_SOURCE, "gi");
  const ranges: CliFileReferenceRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const openPath = normalizeCodexAbsPath(
      raw.replace(/^@/, "").replace(/\\{2,}/g, "\\")
    );
    ranges.push({
      start: match.index,
      end: match.index + raw.length,
      openPath,
    });
  }
  return ranges;
}

/**
 * Resolves a reference's open target to an absolute path, or `undefined`
 * when it's relative and there's no working directory to resolve it
 * against — callers should leave such a reference as plain text rather than
 * guess.
 */
function resolveOpenPath(
  openPath: string,
  workingDirectory: string | undefined
): string | undefined {
  if (ABSOLUTE_PATH_PATTERN.test(openPath)) {
    return openPath;
  }
  if (!workingDirectory) {
    return undefined;
  }
  return `${workingDirectory.replace(/[\\/]+$/, "")}/${openPath.replace(/^[\\/]+/, "")}`;
}

interface TextSpan {
  start: number;
  end: number;
  /** Present only for a span that should render as a link. */
  resolvedPath?: string;
}

function buildSpans(
  textLength: number,
  ranges: CliFileReferenceRange[],
  workingDirectory: string | undefined
): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const resolvedPath = resolveOpenPath(range.openPath, workingDirectory);
    if (!resolvedPath) {
      continue;
    }
    if (range.start > cursor) {
      spans.push({ start: cursor, end: range.start });
    }
    spans.push({ start: range.start, end: range.end, resolvedPath });
    cursor = range.end;
  }
  if (cursor < textLength) {
    spans.push({ start: cursor, end: textLength });
  }
  return spans;
}

// `inline` + `text-left` override the browser's default <button> UA styles
// (display: inline-block; text-align: center) — without them, a link whose
// text wraps onto multiple lines gets each line centered within the
// button's own shrink-to-fit box instead of following the surrounding
// command text's left-aligned wrap, which reads as stray centered whitespace.
const LINK_BUTTON_CLASS =
  "text-link-fg hover:underline cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit] inline text-left";

/**
 * Renders CLI/script command display text with any embedded file-path
 * references turned into plain links that open the referenced file, while
 * composing with "find in output" highlighting via the existing
 * `sliceDecorationMatches`/`highlightText` utilities — each span (link or
 * plain) gets its own re-based slice of `matches` and is highlighted
 * independently, rather than teaching `highlightText` a second range
 * dimension.
 */
export function renderCommandTextWithFileLinks(
  text: string,
  matches: RowFindDecoration["matches"],
  workingDirectory?: string
): React.ReactNode {
  const ranges = findCliFileReferenceRanges(text);
  if (ranges.length === 0) {
    return highlightText(text, matches);
  }

  const spans = buildSpans(text.length, ranges, workingDirectory);

  return spans.map((span) => {
    const spanText = text.slice(span.start, span.end);
    const spanMatches = sliceDecorationMatches(
      { matches },
      span.start,
      span.end
    );
    const highlighted = highlightText(spanText, spanMatches);

    if (!span.resolvedPath) {
      return React.createElement(
        React.Fragment,
        { key: `text-${span.start}` },
        highlighted
      );
    }

    const resolvedPath = span.resolvedPath;
    return React.createElement(
      "button",
      {
        key: `link-${span.start}`,
        type: "button",
        className: LINK_BUTTON_CLASS,
        title: `Open ${resolvedPath}`,
        onClick: () => openFile(resolvedPath),
      },
      highlighted
    );
  });
}
