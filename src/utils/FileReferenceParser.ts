/**
 * Single source of truth for parsing file references from prompt text
 *
 * FlightPath supports multiple reference syntaxes:
 * 1. @path → Full file (CLI-native, no line ranges)
 * 2. @path/to/directory/ → Directory structure (trailing slash)
 * 3. #file:path:line-line → Line range snippet (FlightPath XML)
 * 4. #sym:symbolName → Symbol reference (resolves to file + line range)
 *
 * This module provides unified parsing logic used by:
 * - NativeAttachmentHandler (Chat mode)
 * - CopilotIntegration base class (CLI modes)
 */

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  isDirectory?: boolean;
  symbolName?: string;
}

/**
 * Parse @path references from prompt text (CLI-native full file syntax)
 *
 * Supports formats:
 * - @path/to/file.ts (full file - CLI handles natively)
 * - @path/to/directory/ (directory structure - trailing slash)
 * - @"path with spaces/file.ts" (quoted path)
 *
 * Note: @path does NOT support line ranges - CLIs don't support them.
 * Line ranges should use #file:path:start-end syntax instead.
 *
 * Trailing punctuation is stripped from unquoted paths.
 *
 * @param prompt The prompt text containing @path references
 * @returns Array of file references (full files or directories)
 */
export function parseAtReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Regex to match @path or @"path with spaces"
  // Group 1: quoted path, Group 2: unquoted path
  // Unquoted paths end at whitespace, colon, or common punctuation
  const regex = /@(?:"([^"]+)"|([^\s:?!.,;)\]}"]+))/g;
  let match;

  // Punctuation that commonly follows file references in natural language
  const trailingPunctuation = /[?!.,;)\]}]+$/;

  while ((match = regex.exec(prompt)) !== null) {
    const [, quotedPath, unquotedPath] = match;
    let filePath = quotedPath || unquotedPath;

    // Strip trailing punctuation from unquoted paths
    if (!quotedPath && filePath) {
      filePath = filePath.replace(trailingPunctuation, "");
    }

    // Skip if path is empty or looks like a mention (@workspace, @user, etc.)
    // We only want file paths (contain / or \ or .)
    if (
      filePath &&
      (filePath.includes("/") ||
        filePath.includes("\\") ||
        filePath.includes("."))
    ) {
      // Check if this is a directory reference (trailing slash)
      const isDirectory = filePath.endsWith("/") || filePath.endsWith("\\");

      references.push({
        path: filePath,
        isDirectory,
      });
    }
  }

  return references;
}

/**
 * Parse #file:path:line-line references from prompt text (line ranges)
 *
 * Supports formats:
 * - #file:path:10-20 (line range)
 * - #file:"path with spaces":10-20 (quoted path with line range)
 *
 * Note: #file:path (without line range) is DEPRECATED - use @path instead.
 *
 * @param prompt The prompt text containing #file: references
 * @returns Array of file references with line ranges
 */
export function parseFileReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Match #file:path:startLine-endLine for line ranges ONLY
  // Group 1: quoted path, Group 2: unquoted path, Group 3: startLine, Group 4: endLine
  const regex = /#file:(?:"([^"]+)"|([^\s:]+)):(\d+)-(\d+)/g;
  let match;

  while ((match = regex.exec(prompt)) !== null) {
    const [, quotedPath, unquotedPath, startLine, endLine] = match;
    const filePath = quotedPath || unquotedPath;

    references.push({
      path: filePath,
      startLine: parseInt(startLine, 10),
      endLine: parseInt(endLine, 10),
    });
  }

  return references;
}

/**
 * Parse #sym:symbolName references from prompt text (symbol references)
 *
 * Supports formats:
 * - #sym:ClassName
 * - #sym:methodName
 * - #sym:CONSTANT_NAME
 *
 * Note: Symbol resolution happens at attachment time using VS Code Language Server
 *
 * @param prompt The prompt text containing #sym: references
 * @returns Array of symbol references (need resolution to file locations)
 */
export function parseSymbolReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Match #sym:symbolName
  // Symbol names: start with letter/underscore, contain letters/numbers/underscores
  const regex = /#sym:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;

  while ((match = regex.exec(prompt)) !== null) {
    const symbolName = match[1];

    references.push({
      path: "", // Will be resolved later
      symbolName,
    });
  }

  return references;
}

/**
 * Parse ALL file references from prompt text (all syntaxes)
 *
 * Combines all syntaxes into a single array:
 * - @path → Full file references
 * - @path/ → Directory references
 * - #file:path:line-line → Line range references
 * - #sym:name → Symbol references
 *
 * @param prompt The prompt text containing file references
 * @returns Array of all file references (ordered by appearance in prompt)
 */
export function parseAllFileReferences(prompt: string): FileReference[] {
  const atRefs = parseAtReferences(prompt);
  const fileRefs = parseFileReferences(prompt);
  const symRefs = parseSymbolReferences(prompt);

  // Combine and sort by position in original prompt
  // This ensures processing order matches user intent
  const allRefs = [...atRefs, ...fileRefs, ...symRefs];

  // Sort by first occurrence in prompt
  allRefs.sort((a, b) => {
    // For symbol refs, search for the #sym: pattern
    const aSearchStr = a.symbolName ? `#sym:${a.symbolName}` : a.path;
    const bSearchStr = b.symbolName ? `#sym:${b.symbolName}` : b.path;

    const aIndex = prompt.indexOf(aSearchStr);
    const bIndex = prompt.indexOf(bSearchStr);
    return aIndex - bIndex;
  });

  return allRefs;
}

/**
 * Convert workspace-relative path to @path syntax
 *
 * Both Copilot and Claude CLIs use identical @path format.
 * This is the single source of truth for path conversion.
 *
 * @param filePath Workspace-relative path (e.g., "src/extension.ts")
 * @returns @path syntax (e.g., "@src/extension.ts")
 */
export function convertToAtSyntax(filePath: string): string {
  // Remove leading slash/backslash if present
  const normalized = filePath.replace(/^[/\\]/, "");

  // Use forward slashes for consistency (both CLIs accept this)
  const pathWithSlashes = normalized.replace(/\\/g, "/");

  return `@${pathWithSlashes}`;
}
