import * as fs from "fs";
import { stripLeadingBom } from "./TextUtils";

export interface MarkdownFrontmatter {
  /** YAML text between the opening and closing fences. */
  frontmatter: string;
  /** Markdown body following the closing fence. */
  body: string;
}

/**
 * Split a Markdown YAML frontmatter block from its body.
 * The fences must occupy their own lines; an initial UTF-8 BOM is ignored.
 */
export function splitMarkdownFrontmatter(
  content: string
): MarkdownFrontmatter | null {
  const normalizedContent = stripLeadingBom(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    normalizedContent
  );
  if (!match) {
    return null;
  }

  return {
    frontmatter: match[1],
    body: normalizedContent.slice(match[0].length),
  };
}

/**
 * DiscoveryUtils
 *
 * Shared helpers for agent and skill discovery.
 * Used by AgentDiscovery, SkillDiscovery, AgentExpander, and SkillExpander.
 */

/**
 * Format a directory or filename for display in UI.
 * Converts kebab-case or snake_case to Title Case.
 *
 * @example formatDisplayName("pdf-processing") → "Pdf Processing"
 * @example formatDisplayName("my_skill")       → "My Skill"
 */
export function formatDisplayName(name: string): string {
  const withSpaces = name.replace(/[-_]/g, " ");
  return withSpaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Returns true if `directoryPath` exists and is a directory.
 * Returns false for any other case (missing, file, permission error).
 */
export async function isAccessibleDirectory(
  directoryPath: string
): Promise<boolean> {
  if (!fs.existsSync(directoryPath)) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
