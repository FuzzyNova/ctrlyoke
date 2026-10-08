import { PROMPT_FILE_LANGUAGE_IDS } from "../types/DashboardConstants";
import { findCodeRanges } from "../utils/FileReferenceParser";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import { getWorkflowTextSpans } from "./WorkflowPromptRanges";

/** A literal (code) range in document offsets. */
export interface PromptCodeRange {
  from: number;
  to: number;
}

const WHOLE_DOCUMENT_PROMPT_LANGUAGES: readonly string[] = [
  PROMPT_FILE_LANGUAGE_IDS.PROMPT,
  PROMPT_FILE_LANGUAGE_IDS.MARKDOWN,
];

/**
 * Where a prompt in this document is literal (inline code or a fence), in
 * document offsets. A reference inside such a range is sent as text and never
 * expanded, so VS Code must not link or complete it.
 *
 * `findCodeRanges` runs on each prompt value as the loader decodes it
 * (`getWorkflowTextSpans`), never on the raw file, and the results map back
 * through the span. Files that are not ctrlyoke files are scanned whole only
 * for the markdown and `prompt` languages; any other language has no prompt
 * text to judge, so it has no code ranges.
 */
export function getPromptCodeRanges(
  text: string,
  fileName: string,
  languageId: string
): PromptCodeRange[] {
  const kind = getCtrlYokeFileKind(fileName);
  if (kind === null) {
    return WHOLE_DOCUMENT_PROMPT_LANGUAGES.includes(languageId)
      ? findCodeRanges(text)
      : [];
  }
  return getWorkflowTextSpans(text, kind).flatMap((span) => {
    // An inexact span's offsets are only approximate, so mapping would land
    // ranges on the wrong characters. Scan its raw source instead: inline code
    // stays exact, and a fence lost to block indentation errs toward "live".
    if (!span.exact) {
      const { start, end } = span.sourceRange;
      return findCodeRanges(text.slice(start, end)).map((range) => ({
        from: start + range.from,
        to: start + range.to,
      }));
    }
    return findCodeRanges(span.text).map((range) => ({
      from: span.toSourceOffset(range.from),
      to: span.toSourceOffset(range.to),
    }));
  });
}

/** The parts of a text document `getDocumentPromptCodeRanges` reads. */
export interface PromptCodeRangeDocument {
  readonly uri: { toString(): string };
  readonly version: number;
  readonly fileName: string;
  readonly languageId: string;
  getText(): string;
}

const CACHE_LIMIT = 8;
const cache = new Map<string, { version: number; ranges: PromptCodeRange[] }>();

/**
 * `getPromptCodeRanges` for an open document, cached per URI and version. The
 * link provider and every completion trigger ask for the same version, and
 * each uncached call re-parses the whole file.
 */
export function getDocumentPromptCodeRanges(
  document: PromptCodeRangeDocument
): PromptCodeRange[] {
  const key = document.uri.toString();
  const hit = cache.get(key);
  if (hit?.version === document.version) return hit.ranges;
  const ranges = getPromptCodeRanges(
    document.getText(),
    document.fileName,
    document.languageId
  );
  cache.delete(key);
  cache.set(key, { version: document.version, ranges });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return ranges;
}

/** True when `[from, to]` lies entirely inside one range. */
export function isRangeInPromptCode(
  from: number,
  to: number,
  ranges: readonly PromptCodeRange[]
): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

/** True when a cursor sits strictly between a code range's two ends. */
export function isCursorInPromptCode(
  offset: number,
  ranges: readonly PromptCodeRange[]
): boolean {
  return ranges.some((range) => offset > range.from && offset < range.to);
}
