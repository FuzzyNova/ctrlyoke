import type {
  AskUserQuestionData,
  AskUserQuestionEntry,
} from "../types/cliEvents";

/**
 * Shared text layout for one AskUserQuestion question, used by both
 * `buildAskUserQuestionSearchSegments` (search) and `AskUserQuestionOutput`
 * (rendering) so a decoration's [start, end) offsets — computed here — always
 * line up with the exact substrings the component highlights.
 */
export interface AskUserQuestionOptionRange {
  label: [number, number];
  description?: [number, number];
}

export interface AskUserQuestionTextBlock {
  text: string;
  questionRange: [number, number];
  optionRanges: AskUserQuestionOptionRange[];
  answerRange?: [number, number];
  notesRange?: [number, number];
}

export function buildAskUserQuestionTextBlock(
  entry: AskUserQuestionEntry
): AskUserQuestionTextBlock {
  let text = "";
  const append = (value: string): [number, number] => {
    const start = text.length;
    text += value;
    return [start, text.length];
  };

  const questionRange = append(entry.question);

  const optionRanges: AskUserQuestionOptionRange[] = entry.options.map(
    (option) => {
      text += "\n";
      const label = append(option.label);
      if (!option.description) {
        return { label };
      }
      text += ": ";
      return { label, description: append(option.description) };
    }
  );

  let answerRange: [number, number] | undefined;
  if (entry.answer) {
    text += "\n";
    answerRange = append(entry.answer);
  }

  let notesRange: [number, number] | undefined;
  if (entry.notes) {
    text += "\n";
    notesRange = append(entry.notes);
  }

  return { text, questionRange, optionRanges, answerRange, notesRange };
}

/**
 * One row-level search segment for an AskUserQuestion event: either a
 * per-question block (`field: "response"`, carrying its `block` layout for
 * sub-range highlighting) or the decline feedback (`field: "error"`).
 *
 * Segments share a single running cursor across the whole event — mirroring
 * `outputFind.ts`'s `createSegments` — so this is the one place that offset
 * math happens; both the search index and the renderer read it from here
 * instead of recomputing it independently.
 */
export interface AskUserQuestionSearchSegment {
  field: "response" | "error";
  text: string;
  start: number;
  end: number;
  block?: AskUserQuestionTextBlock;
}

export function buildAskUserQuestionSearchSegments(
  data: AskUserQuestionData
): AskUserQuestionSearchSegment[] {
  const segments: AskUserQuestionSearchSegment[] = [];
  let cursor = 0;

  for (const question of data.questions) {
    const block = buildAskUserQuestionTextBlock(question);
    if (!block.text) continue;
    const start = cursor;
    const end = start + block.text.length;
    segments.push({ field: "response", text: block.text, start, end, block });
    cursor = end + 1;
  }

  if (data.declined?.feedback) {
    const start = cursor;
    const end = start + data.declined.feedback.length;
    segments.push({ field: "error", text: data.declined.feedback, start, end });
    cursor = end + 1;
  }

  return segments;
}
