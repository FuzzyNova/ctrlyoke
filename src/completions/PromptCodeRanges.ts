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
  return getWorkflowTextSpans(text, kind).flatMap((span) =>
    findCodeRanges(span.text).map((range) => ({
      from: span.toSourceOffset(range.from),
      to: span.toSourceOffset(range.to),
    }))
  );
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
