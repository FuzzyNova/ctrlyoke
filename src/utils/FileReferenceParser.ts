/**
 * Single source of truth for parsing file references from prompt text
 *
 * ctrlyoke supports multiple reference syntaxes:
 * 1. @path → Full file (CLI-native, no line ranges)
 * 2. @"path with spaces/file" → Full file with quoted path (for paths containing spaces)
 * 3. @path/to/directory/ → Directory structure (trailing slash)
 * 4. #selection:path:line-line → Line range snippet (ctrlyoke XML)
 * 5. #selection:"path with spaces":line-line → Line range with quoted path
 * 6. #sym:path:SymbolName:line-line → Symbol reference with an encoded line range
 * 7. #sym:"path with spaces":SymbolName:line-line → Quoted-path symbol reference
 *
 * This module provides unified parsing logic used by:
 * - NativeAttachmentHandler (Chat mode)
 * - HarnessIntegration base class (CLI modes)
 */

import {
  GIT_CHANGE_KINDS,
  type GitChangeKind,
} from "../types/DashboardConstants";
import { parseRangeNotation } from "./RangeNotationParser";

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  isDirectory?: boolean;
  symbolName?: string;
  /** Offset of the first character of the matched token in the source text. */
  startOffset?: number;
  /** Offset one past the last character of the matched token in the source text. */
  endOffset?: number;
}

export type InlinePriorContextRef =
  | { kind: "previous" }
  | { kind: "all" }
  | { kind: "finalStep" }
  | { kind: "allFinalStep" }
  | { kind: "step"; indices: number[] };

export interface InlinePriorContextMatch {
  ref: InlinePriorContextRef;
  /** The full matched token, e.g. "$previous" or "$step:1,3-5". */
  token: string;
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

    // Strip trailing characters that cannot end a valid file path.
    // Valid paths end with alphanumeric (file extension or plain filename)
    // or / or \ (directory). Everything else is prose punctuation.
    // Handles mixed sequences like `).` that the old two-step approach missed.
    if (!quotedPath && filePath) {
      filePath = filePath.replace(/[^a-zA-Z0-9/\\]+$/, "");
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

      // Quoted paths aren't stripped of trailing punctuation, so match[0]
      // spans exactly @"...". Unquoted paths may have had trailing prose
      // punctuation stripped off filePath, so endOffset uses the stripped
      // length ("@" plus filePath) rather than the raw match length —
      // otherwise a sanitize pass would eat trailing punctuation like ").".
      const startOffset = match.index;
      const endOffset =
        quotedPath !== undefined
          ? match.index + match[0].length
          : match.index + 1 + filePath.length;

      references.push({
        path: filePath,
        isDirectory,
        startOffset,
        endOffset,
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
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return references;
}

/**
 * Parse #sym: references from prompt text (symbol references)
 *
 * Supports formats:
 * - #sym:path/to/file.ts:SymbolName:123-145 (plain path)
 * - #sym:"path with spaces/file.ts":SymbolName:123-145 (quoted path)
 * - #sym:path/to/file.ts:methodName():123-145 (method with parentheses)
 *
 * File path (workspace-relative), symbol name, and line range (1-based) together
 * ensure unique identification when the same symbol appears in multiple files.
 *
 * @param prompt The prompt text containing #sym: references
 * @returns Array of symbol references with file path, symbol name, and line number
 */
export function parseSymbolReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  const quotedRegex =
    /#sym:"([^"]+)":([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?):(\d+)-(\d+)/g;
  let match;

  while ((match = quotedRegex.exec(prompt)) !== null) {
    const [, filePath, symbolName, startLine, endLine] = match;
    references.push({
      path: filePath,
      symbolName,
      startLine: parseInt(startLine, 10),
      endLine: parseInt(endLine, 10),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  const plainRegex =
    /#sym:([^:]+):([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?):(\d+)-(\d+)/g;

  while ((match = plainRegex.exec(prompt)) !== null) {
    const [, filePath, symbolName, startLine, endLine] = match;

    // Skip if this position was already captured by the quoted regex
    // (plain regex would match the quoted form too, capturing '"path..."')
    if (filePath.startsWith('"')) {
      continue;
    }

    references.push({
      path: filePath,
      symbolName,
      startLine: parseInt(startLine, 10),
      endLine: parseInt(endLine, 10),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
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
// Inline Prior Context References ($previous, $all, $step:1,3-5)
// ============================================================================

/**
 * Parse inline prior-context references from prompt text.
 *
 * Recognized tokens:
 * - $previous
 * - $all
 * - $finalStep
 * - $allFinalStep
 * - $step:N,M,A-B
 *
 * Unknown $tokens are ignored so future syntaxes can pass through unchanged.
 */
export function parseInlinePriorContextRefs(
  text: string
): InlinePriorContextMatch[] {
  const matches: InlinePriorContextMatch[] = [];
  const regex = /\$([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9,\-]*)?)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    const token = match[0];

    if (body === "previous") {
      matches.push({ ref: { kind: "previous" }, token });
      continue;
    }
    if (body === "all") {
      matches.push({ ref: { kind: "all" }, token });
      continue;
    }
    if (body === "finalStep") {
      matches.push({ ref: { kind: "finalStep" }, token });
      continue;
    }
    if (body === "allFinalStep") {
      matches.push({ ref: { kind: "allFinalStep" }, token });
      continue;
    }
    if (body.startsWith("step:")) {
      const rangeText = body.slice("step:".length);
      const indices = parseRangeNotation(rangeText);
      if (!indices) {
        console.warn(`Invalid inline prior context range "${token}" skipped`);
        continue;
      }
      matches.push({ ref: { kind: "step", indices }, token });
    }
  }

  return matches;
}

// ============================================================================
// Git Change References (~diff, ~staged, ~stash:N, ~<hash>)
// ============================================================================

export interface GitChangeReference {
  kind: GitChangeKind;
  raw: string; // the full matched token, e.g. "~c056e24...", "~diff", "~stash:2"
  hash?: string; // for kind === "commit"
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
    const raw = match[0]; // e.g. "~diff", "~stash:2", "~c056e24"
    const inner = match[1]; // e.g. "diff", "stash:2", "c056e24"
    const stashNumStr = match[2]; // defined only for stash:<N>
    const hashStr = match[3]; // defined only for commit hash

    let kind: GitChangeKind;
    let hash: string | undefined;
    let stashIndex: number | undefined;

    const lowerInner = inner.toLowerCase();

    if (lowerInner === GIT_CHANGE_KINDS.DIFF) {
      kind = GIT_CHANGE_KINDS.DIFF;
    } else if (lowerInner === GIT_CHANGE_KINDS.STAGED) {
      kind = GIT_CHANGE_KINDS.STAGED;
    } else if (stashNumStr !== undefined) {
      kind = GIT_CHANGE_KINDS.STASH;
      stashIndex = parseInt(stashNumStr, 10);
    } else if (hashStr !== undefined) {
      kind = GIT_CHANGE_KINDS.COMMIT;
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
