import { stripLeadingBom } from "./TextUtils";

/**
 * Markdown YAML frontmatter splitting. Pure (no `fs`) so the workflow loader,
 * agent/skill discovery and the editor location code all share one rule.
 */

export interface MarkdownFrontmatter {
  /** YAML text between the opening and closing fences. */
  frontmatter: string;
  /** Markdown body following the closing fence. */
  body: string;
}

/** Offsets into the original text, BOM included. */
export interface MarkdownFrontmatterRanges {
  /** The YAML between the fences; absent when there is no frontmatter block. */
  readonly frontmatter?: { readonly start: number; readonly end: number };
  /** Where the markdown body starts (after the closing fence, or after the BOM). */
  readonly bodyStart: number;
}

const FRONTMATTER =
  /^---\r?\n(?:(?=---[ \t]*(?:\r?\n|$))|([\s\S]*?)\r?\n)---[ \t]*(?:\r?\n|$)/u;

/**
 * Locate a frontmatter block. The fences must occupy their own lines; an
 * initial UTF-8 BOM is ignored, and an empty block (`---` then `---`) counts.
 */
export function locateMarkdownFrontmatter(
  content: string
): MarkdownFrontmatterRanges {
  const normalized = stripLeadingBom(content);
  const bomLength = content.length - normalized.length;
  const match = FRONTMATTER.exec(normalized);
  if (!match) return { bodyStart: bomLength };
  const yamlStart = bomLength + match[0].indexOf("\n") + 1;
  return {
    frontmatter: {
      start: yamlStart,
      end: yamlStart + (match[1]?.length ?? 0),
    },
    bodyStart: bomLength + match[0].length,
  };
}

/** Split a Markdown YAML frontmatter block from its body. */
export function splitMarkdownFrontmatter(
  content: string
): MarkdownFrontmatter | null {
  const { frontmatter, bodyStart } = locateMarkdownFrontmatter(content);
  if (!frontmatter) return null;
  return {
    frontmatter: content.slice(frontmatter.start, frontmatter.end),
    body: content.slice(bodyStart),
  };
}

/**
 * The prompt text of a `.prompt.md` file: the body after any frontmatter,
 * trimmed. The loader and a step that names the file both use it, so the
 * harness receives the same text either way and never the frontmatter.
 */
export function getPromptMarkdownText(content: string): string {
  const split = splitMarkdownFrontmatter(content);
  return stripLeadingBom(split ? split.body : content).trim();
}
