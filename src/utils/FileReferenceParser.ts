/**
 * Single source of truth for parsing file references from prompt text
 *
 * FlightPath supports multiple reference syntaxes:
 * 1. @path → Full file (CLI-native, no line ranges)
 * 2. @"path with spaces/file" → Full file with quoted path (for paths containing spaces)
 * 3. @path/to/directory/ → Directory structure (trailing slash)
 * 4. #selection:path:line-line → Line range snippet (FlightPath XML)
 * 5. #selection:"path with spaces":line-line → Line range with quoted path
 * 6. #sym:path:SymbolName:line → Symbol reference (resolves to file + line range)
 * 7. #sym:"path with spaces":SymbolName:line → Symbol reference with quoted path
 *
 * This module provides unified parsing logic used by:
 * - NativeAttachmentHandler (Chat mode)
 * - HarnessIntegration base class (CLI modes)
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
 * Line ranges should use #selection:path:start-end syntax instead.
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
  // Unquoted paths end at whitespace or colon (include . for extensions)
  const regex = /@(?:"([^"]+)"|([^\s:]+))/g;
  let match;

  while ((match = regex.exec(prompt)) !== null) {
    const [, quotedPath, unquotedPath] = match;
    let filePath = quotedPath || unquotedPath;

    // Strip trailing punctuation from unquoted paths
    // But preserve file extensions and multi-dot filenames (e.g., .ts, .flightpath.json, config.test.ts)
    if (!quotedPath && filePath) {
      // Strategy: File paths end with alphanumeric or dot+alphanumeric (extensions)
      // Sentence punctuation (?!,;)]}") appears after the last alphanumeric

      // Strip common sentence-ending punctuation: ?!,;)]}
      // But NOT periods yet (they might be part of extensions or relative paths)
      filePath = filePath.replace(/[?!,;)\]}"]+$/, "");

      // For trailing periods: only strip if they come AFTER the extension/filename
      // i.e., the path already has alphanumeric at the end before the period(s)
      // Example: "file.ts." → strip the last period (sentence ending)
      // Example: "file.ts" → keep as-is (extension)
      // Example: "../file" → keep as-is (relative path)
      filePath = filePath.replace(/(\w)\.+$/, "$1");
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
 * Parse #selection:path:line-line references from prompt text (line ranges)
 *
 * Supports formats:
 * - #selection:path:10-20 (line range)
 * - #selection:"path with spaces":10-20 (quoted path with line range)
 *
 * @param prompt The prompt text containing #selection: references
 * @returns Array of file references with line ranges
 */
export function parseSelectionReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Match #selection:path:startLine-endLine for line ranges ONLY
  // Group 1: quoted path, Group 2: unquoted path, Group 3: startLine, Group 4: endLine
  const regex = /#selection:(?:"([^"]+)"|([^\s:]+)):(\d+)-(\d+)/g;
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
 * Parse #sym: references from prompt text (symbol references)
 *
 * Supports formats:
 * - #sym:path/to/file.ts:SymbolName:123 (plain path)
 * - #sym:"path with spaces/file.ts":SymbolName:123 (quoted path for paths with spaces)
 * - #sym:path/to/file.ts:methodName():123 (method with parentheses)
 *
 * File path (workspace-relative), symbol name, and line number (1-based) together
 * ensure unique identification when the same symbol appears in multiple files.
 *
 * @param prompt The prompt text containing #sym: references
 * @returns Array of symbol references with file path, symbol name, and line number
 */
export function parseSymbolReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Match quoted paths: #sym:"path with spaces/file.ts":SymbolName:123
  // Group 1: quoted path, Group 2: symbol name (with optional parens), Group 3: line number
  const quotedRegex = /#sym:"([^"]+)":([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?):(\d+)/g;
  let match;

  while ((match = quotedRegex.exec(prompt)) !== null) {
    const [, filePath, symbolName, lineStr] = match;
    references.push({
      path: filePath,
      symbolName,
      startLine: parseInt(lineStr, 10),
    });
  }

  // Match unquoted paths: #sym:path/to/file.ts:SymbolName:123
  // Captures: (1) file path, (2) symbol name (with optional parens), (3) line number
  const plainRegex = /#sym:([^:]+):([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?):(\d+)/g;

  while ((match = plainRegex.exec(prompt)) !== null) {
    const [, filePath, symbolName, lineStr] = match;

    // Skip if this position was already captured by the quoted regex
    // (plain regex would match the quoted form too, capturing '"path..."')
    if (filePath.startsWith('"')) {
      continue;
    }

    references.push({
      path: filePath,
      symbolName,
      startLine: parseInt(lineStr, 10),
    });
  }

  return references;
}

/**
 * Parse directory references ONLY from prompt text (@path/ with trailing slash)
 *
 * This is used by CLI integrations to identify directories that need XML
 * tree structure generation, while leaving native @path file references untouched.
 *
 * @param prompt The prompt text containing directory references
 * @returns Array of directory references only (isDirectory: true)
 */
export function parseDirectoryReferences(prompt: string): FileReference[] {
  const atRefs = parseAtReferences(prompt);
  // Filter to only directory references (trailing slash)
  return atRefs.filter((ref) => ref.isDirectory);
}

// ============================================================================
// Git Change References (~diff, ~staged, ~stash:N, ~<hash>)
// ============================================================================

export type GitChangeKind = "commit" | "diff" | "staged" | "stash";

export interface GitChangeReference {
  kind: GitChangeKind;
  raw: string;         // the full matched token, e.g. "~c056e24...", "~diff", "~stash:2"
  hash?: string;       // for kind === "commit"
  stashIndex?: number; // for kind === "stash"
  startOffset: number;
  endOffset: number;
}

/**
 * Parse ~diff, ~staged, ~stash:<N>, and ~<hash> references from prompt text.
 *
 * These are a distinct concept from file/symbol references and are NOT
 * mixed into the FileReference type.
 *
 * @param text The prompt text to parse
 * @returns Array of git change references in order of appearance
 */
export function parseGitChangeReferences(text: string): GitChangeReference[] {
  const results: GitChangeReference[] = [];

  // ~diff  — exact keyword
  // ~staged — exact keyword
  // ~stash:<N> — stash entry by index
  // ~[0-9a-f]{7,40} — commit hash (case-insensitive)
  const regex = /~(diff|staged|stash:(\d+)|([0-9a-f]{7,40}))/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];           // e.g. "~diff", "~stash:2", "~c056e24"
    const inner = match[1];         // e.g. "diff", "stash:2", "c056e24"
    const stashNumStr = match[2];   // defined only for stash:<N>
    const hashStr = match[3];       // defined only for commit hash

    let kind: GitChangeKind;
    let hash: string | undefined;
    let stashIndex: number | undefined;

    const lowerInner = inner.toLowerCase();

    if (lowerInner === "diff") {
      kind = "diff";
    } else if (lowerInner === "staged") {
      kind = "staged";
    } else if (stashNumStr !== undefined) {
      kind = "stash";
      stashIndex = parseInt(stashNumStr, 10);
    } else if (hashStr !== undefined) {
      kind = "commit";
      hash = hashStr.toLowerCase();
    } else {
      continue; // shouldn't happen
    }

    results.push({
      kind,
      raw,
      hash,
      stashIndex,
      startOffset: match.index,
      endOffset: match.index + raw.length,
    });
  }

  return results;
}

/**
 * Parse ALL file references from prompt text (all syntaxes)
 *
 * Combines all syntaxes into a single array:
 * - @path → Full file references
 * - @path/ → Directory references
 * - #selection:path:line-line → Line range references
 * - #sym:name → Symbol references
 *
 * @param prompt The prompt text containing file references
 * @returns Array of all file references (ordered by appearance in prompt)
 */
export function parseAllFileReferences(prompt: string): FileReference[] {
  const atRefs = parseAtReferences(prompt);
  const fileRefs = parseSelectionReferences(prompt);
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
