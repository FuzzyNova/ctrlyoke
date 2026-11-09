/** A line that looks like part of an ASCII-art mockup rather than prose. */
const ASCII_ART_LINE = /[\\/|()<>^~_=]/;

/**
 * Split an ask-user-question option description into prose and a preview
 * block, for harnesses whose question tool has no `preview` field and whose
 * models put a mockup after a blank line instead (Qwen, OpenCode).
 *
 * The paragraphs after the first become a preview only when they hold at
 * least two lines that look like ASCII art. Otherwise the description is
 * ordinary multi-paragraph prose and is returned whole.
 */
export function splitDescriptionPreview(description: string): {
  description: string;
  preview?: string;
} {
  const paragraphs = description.split(/\r?\n\s*\r?\n/);
  if (paragraphs.length < 2) {
    return { description };
  }

  const preview = paragraphs.slice(1).join("\n\n").trimEnd();
  const asciiLines = preview
    .split(/\r?\n/)
    .filter((line) => ASCII_ART_LINE.test(line));
  if (asciiLines.length < 2) {
    return { description };
  }

  return { description: paragraphs[0].trim(), preview };
}
