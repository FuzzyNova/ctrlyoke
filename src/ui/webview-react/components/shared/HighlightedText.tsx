import type { ReactNode } from "react";

interface HighlightedTextProps {
  text: string;
  tokens: readonly string[];
}

interface TextRun {
  start: number;
  end: number;
}

function getMatchedRuns(text: string, tokens: readonly string[]): TextRun[] {
  const lowerText = text.toLocaleLowerCase();
  const runs: TextRun[] = [];
  for (const token of tokens) {
    const normalized = token.toLocaleLowerCase();
    if (!normalized) continue;
    let startAt = 0;
    while (startAt < lowerText.length) {
      const start = lowerText.indexOf(normalized, startAt);
      if (start < 0) break;
      runs.push({ start, end: start + normalized.length });
      startAt = start + normalized.length;
    }
  }
  runs.sort((a, b) => a.start - b.start || a.end - b.end);
  return runs.reduce<TextRun[]>((merged, run) => {
    const previous = merged[merged.length - 1];
    if (previous && run.start <= previous.end) {
      previous.end = Math.max(previous.end, run.end);
    } else {
      merged.push({ ...run });
    }
    return merged;
  }, []);
}

export function HighlightedText({ text, tokens }: HighlightedTextProps) {
  const runs = getMatchedRuns(text, tokens);
  if (runs.length === 0) return text;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const [index, run] of runs.entries()) {
    if (cursor < run.start) content.push(text.slice(cursor, run.start));
    content.push(
      <mark key={`${run.start}-${index}`}>
        {text.slice(run.start, run.end)}
      </mark>
    );
    cursor = run.end;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return <>{content}</>;
}
