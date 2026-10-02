/**
 * Single source of truth for parsing file references from prompt text
 *
 * ctrlyoke supports multiple reference syntaxes:
 * 1. @path → Full file (CLI-native, no line ranges)
 * 2. @"path with spaces/file" → Full file with quoted path (for paths containing spaces)
 * 3. @path/to/directory/ → Directory structure (trailing slash)
 * 4. #selection:path:line-line → Line range snippet (ctrlyoke XML)
 * 5. #selection:"path with spaces":line-line → Line range with quoted path
 * 6. #sym[.kind]:path:SymbolName:line-line → Symbol reference with an encoded line range
 * 7. #sym[.kind]:"path with spaces":"symbol name":line-line → Quoted symbol reference
 *
 * In #selection: and #sym: the path and symbol name are colon-delimited fields:
 * either bare (no whitespace, `:`, or `"`) or double-quoted. See
 * ContextReferenceBuilder.quoteReferenceField, which decides that when building.
 *
 * This module provides unified parsing logic used by the HarnessIntegration
 * base class (CLI modes).
 */

import {
  GIT_CHANGE_KINDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
  SCRIPT_OUTPUT_SOURCES,
  type GitChangeKind,
} from "../types/DashboardConstants";
import { parseRangeNotation } from "./RangeNotationParser";
import { NOT_AFTER_BOUNDARY } from "./ReferenceBoundary";
import {
  createGitChangeReferencePattern,
  createConditionOutputReferencePattern,
  createInlinePriorContextReferencePattern,
  UNQUOTED_AT_REFERENCE_PATH,
} from "./ReferencePatterns";

export const LITERAL_FENCE_INFO = "text";

/**
 * Mask every prompt-reference and variable trigger character inside
 * backtick-fenced blocks.
 *
 * This is the single point that decides "is this inside a fence" for every
 * reference parser in the file (plus `SecretReferenceParser.parseSecretReferences`
 * and `CtrlYokeSlashTokens.scanCtrlYokeSlashTokens`, which both mask through
 * this same function) — each of those parsers calls it on its own input
 * rather than requiring every one of their many call sites to remember to
 * mask first. A pasted literal like `<!DOCTYPE>` or a `/mcp:` example inside
 * a fenced log/code excerpt must never be mistaken for a live reference:
 * `!NAME` hard-fails a run at secret preflight, and `$previous`/`/skill:`
 * silently inject real content the fence promised was inert. A trigger char
 * missing from this set is therefore a silent correctness bug, not just a
 * missed expansion — when a new trigger is added anywhere in the
 * prompt-reference system, it must be added here too.
 */
export function findFencedBlockRanges(
  text: string
): Array<{ from: number; to: number }> {
  const fenceRuns = /`{3,}/g;
  const ranges: Array<{ from: number; to: number }> = [];
  let opening = fenceRuns.exec(text);

  while (opening) {
    const openingLength = opening[0].length;
    let next: RegExpExecArray | null;
    let restartedAtGeneratedOpener = false;

    while ((next = fenceRuns.exec(text)) !== null) {
      if (next[0].length < openingLength) {
        continue;
      }

      const afterFence = next.index + next[0].length;
      const lineEnd = text.indexOf("\n", afterFence);
      const lineRemainder = text.slice(
        afterFence,
        lineEnd < 0 ? text.length : lineEnd
      );
      const isGeneratedOpener = lineRemainder.trim() === LITERAL_FENCE_INFO;

      if (isGeneratedOpener) {
        // The generated fence is longer than every run in the authored text
        // and substituted value. End the authored block here, then scan the
        // generated literal as its own block so backticks in the value cannot
        // close the authored fence.
        ranges.push({ from: opening.index, to: afterFence });
        opening = next;
        restartedAtGeneratedOpener = true;
        break;
      }

      ranges.push({ from: opening.index, to: afterFence });
      opening = fenceRuns.exec(text);
      restartedAtGeneratedOpener = true;
      break;
    }

    if (!restartedAtGeneratedOpener) {
      break;
    }
  }

  return ranges;
}

/** Mask every prompt-reference trigger inside ranges found by the shared scan. */
export function maskFencedCodeBlocks(text: string): string {
  let masked = text;
  for (const { from, to } of findFencedBlockRanges(text)) {
    const block = text.slice(from, to).replace(/[@#~!$/{}]/g, "\x00");
    masked = masked.slice(0, from) + block + masked.slice(to);
  }
  return masked;
}

/** Fence literal text with a backtick run longer than any run in its context. */
export function fenceLiteral(
  text: string,
  info = "",
  surroundingText = ""
): string {
  let longestRun = 0;
  for (const source of [text, surroundingText]) {
    for (const match of source.matchAll(/`+/g)) {
      longestRun = Math.max(longestRun, match[0].length);
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info ? ` ${info}` : ""}\n${text}\n${fence}`;
}

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  isDirectory?: boolean;
  symbolName?: string;
  symbolKind?: string;
  /** Offset of the first character of the matched token in the source text. */
  startOffset?: number;
  /** Offset one past the last character of the matched token in the source text. */
  endOffset?: number;
}

export type InlinePriorContextRef =
  /** `$previous` (no count) or `$previous:N` (the last N outputs). */
  | { kind: typeof PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS; count?: number }
  | { kind: typeof PRIOR_CONTEXT_REFERENCE_KINDS.ALL }
  | { kind: typeof PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP }
  | { kind: typeof PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP }
  | { kind: typeof PRIOR_CONTEXT_REFERENCE_KINDS.STEP; indices: number[] };

export interface InlinePriorContextMatch {
  ref: InlinePriorContextRef;
  /** The full matched token, e.g. "$previous" or "$step:1,3-5". */
  token: string;
  /** Offset of the `$` in the scanned text. */
  startOffset: number;
  /** Offset one past the token's last character in the scanned text. */
  endOffset: number;
}

export interface ConditionOutputMatch {
  phase:
    | typeof SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
    | typeof SCRIPT_OUTPUT_SOURCES.END_CONDITION;
  field: string;
  /** The full matched token, e.g. "$preCondition:stdout". */
  token: string;
  /** Offset of the first character of the matched token in the source text. */
  startOffset: number;
  /** Offset one past the last character of the matched token in the source text. */
  endOffset: number;
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
  const maskedPrompt = maskFencedCodeBlocks(prompt);

  // Regex to match @path or @"path with spaces"
  // Group 1: quoted path, Group 2: unquoted path
  // Unquoted paths end at whitespace or colon (include . for extensions)
  // The lookbehind rejects not just alphanumerics but every other character
  // that's legal inside a filename (+, -, _, =, @, #, $, %, ^, &, !, ~), so
  // an email (nathan@gmail.com) or a filename like data_file~@backup!.csv
  // mentioned in prose isn't mistaken for a reference at the inner @ — while
  // `(@file.ts` or `"@file.ts` still match, since `(`/`"` aren't filename
  // characters. The unquoted body still permits an embedded @ so a path like
  // src/myimage@512x512.png parses as one reference, not split at the inner @.
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}@(?:"([^"]+)"|(${UNQUOTED_AT_REFERENCE_PATH}))`,
    "g"
  );
  let match;

  while ((match = regex.exec(maskedPrompt)) !== null) {
    const [, quotedPath, unquotedPath] = match;
    let filePath = quotedPath || unquotedPath;

    // Strip trailing characters that cannot end a valid file path.
    // Valid paths end with alphanumeric (file extension or plain filename)
    // or / or \ (directory). Everything else is prose punctuation.
    // Handles mixed sequences like `).` that the old two-step approach missed.
    if (!quotedPath && filePath) {
      filePath = filePath.replace(/[^\p{L}\p{N}/\\]+$/u, "");
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
  const maskedPrompt = maskFencedCodeBlocks(prompt);

  // Match #selection:path:startLine-endLine for line ranges ONLY
  // Group 1: quoted path, Group 2: unquoted path, Group 3: startLine, Group 4: endLine
  // Same word-boundary rationale as parseAtReferences: rejects filename-legal
  // characters immediately before #, not just alphanumerics.
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}#selection:(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
    "g"
  );
  let match;

  while ((match = regex.exec(maskedPrompt)) !== null) {
    const [, quotedPath, unquotedPath, startLine, endLine] = match;
    const filePath = quotedPath ?? unquotedPath;

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
  const maskedPrompt = maskFencedCodeBlocks(prompt);

  // One pattern, quoted-or-bare per field — the same shape
  // parseSelectionReferences uses. Group 1: optional kind; groups 2/3:
  // quoted/bare path, groups 4/5: quoted/bare symbol name, groups 6-7: line
  // range.
  //
  // A bare field excludes whitespace, `:`, and `"` so that the only way to
  // write those is the quoted form (ContextReferenceBuilder.quoteReferenceField
  // guarantees it). That is what keeps a name from swallowing prose: the older
  // permissive `[^:]+` name pattern matched "MyClass, at 12" out of
  // `see #sym:a.ts:MyClass, at 12:30-45`. Everything else a language server
  // emits — `Foo<T>`, `my-thing`, `Foo.bar`, `#private`, `doThing()` — is a
  // legal bare name and needs no quoting.
  // Same word-boundary rationale as parseAtReferences: rejects filename-legal
  // characters immediately before #, not just alphanumerics.
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}#sym(?:\\.([a-z-]+))?:(?:"([^"]+)"|([^\\s:"]+)):(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
    "g"
  );
  let match;

  while ((match = regex.exec(maskedPrompt)) !== null) {
    const [
      ,
      symbolKind,
      quotedPath,
      barePath,
      quotedName,
      bareName,
      startLine,
      endLine,
    ] = match;

    references.push({
      ...(symbolKind ? { symbolKind } : {}),
      path: quotedPath ?? barePath,
      symbolName: quotedName ?? bareName,
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
 * Parse one inline prior-context reference body (the text after `$`, e.g.
 * "previous", "previous:3", "step:1,3-5") — the single parser behind the
 * runtime ({@link parseInlinePriorContextRefs}), the editor's chips and lint,
 * and the Ctrl+click preview, so they can never disagree about what a token
 * means.
 *
 * Returns null for unknown or invalid bodies. `length` is how much of the body
 * the reference spans: a trailing comma on `step:` is ordinary sentence
 * punctuation, not an empty range entry — e.g. "review $step:1,3, then tell
 * me..." — so it is excluded, the same way parseAtReferences strips trailing
 * prose punctuation from unquoted @ paths.
 */
export function parseInlinePriorContextBody(
  body: string
): { ref: InlinePriorContextRef; length: number } | null {
  switch (body) {
    case PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS:
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL:
    case PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP:
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP:
      return { ref: { kind: body }, length: body.length };
  }

  const previousPrefix = `${PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS}:`;
  if (body.startsWith(previousPrefix)) {
    const countText = body.slice(previousPrefix.length);
    const count = /^\d+$/.test(countText) ? Number(countText) : NaN;
    if (!Number.isSafeInteger(count) || count < 1) {
      return null;
    }
    return {
      ref: { kind: PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS, count },
      length: body.length,
    };
  }

  const stepPrefix = `${PRIOR_CONTEXT_REFERENCE_KINDS.STEP}:`;
  if (body.startsWith(stepPrefix)) {
    const rawRangeText = body.slice(stepPrefix.length);
    const rangeText = rawRangeText.replace(/,+$/, "");
    const indices = parseRangeNotation(rangeText);
    if (!indices) {
      return null;
    }
    return {
      ref: { kind: PRIOR_CONTEXT_REFERENCE_KINDS.STEP, indices },
      length: stepPrefix.length + rangeText.length,
    };
  }

  return null;
}

/**
 * The canonical body (no `$`) for a parsed reference — the inverse of
 * {@link parseInlinePriorContextBody}. Used wherever a reference is carried as
 * text between layers (chip `data-ref`, preview requests, token-count keys).
 */
export function formatInlinePriorContextBody(
  ref: InlinePriorContextRef
): string {
  switch (ref.kind) {
    case PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS:
      return ref.count === undefined ? ref.kind : `${ref.kind}:${ref.count}`;
    case PRIOR_CONTEXT_REFERENCE_KINDS.STEP:
      return `${ref.kind}:${ref.indices.join(",")}`;
    default:
      return ref.kind;
  }
}

/**
 * Find inline prior-context references in `text` exactly as given — no fence
 * masking. Callers that need fence-awareness either mask first (as
 * {@link parseInlinePriorContextRefs} does) or check ranges themselves (the
 * editor, which works on viewport slices).
 *
 * Recognized tokens: $previous, $previous:N, $all, $finalStep, $allFinalStep,
 * $step:N,M,A-B. Unknown $tokens are ignored so future syntaxes can pass
 * through unchanged.
 */
export function scanInlinePriorContextRefs(
  text: string
): InlinePriorContextMatch[] {
  const matches: InlinePriorContextMatch[] = [];
  // Same word-boundary rationale as parseAtReferences: rejects filename-legal
  // characters immediately before $, not just alphanumerics — e.g. a
  // shell/env-style "price$previous" or a filename containing "$" shouldn't
  // expand.
  const regex = createInlinePriorContextReferencePattern();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const parsed = parseInlinePriorContextBody(match[1]);
    if (!parsed) {
      continue;
    }
    // +1 for the leading "$".
    const token = match[0].slice(0, parsed.length + 1);
    matches.push({
      ref: parsed.ref,
      token,
      startOffset: match.index,
      endOffset: match.index + token.length,
    });
  }

  return matches;
}

/**
 * Parse inline prior-context references from prompt text, ignoring any inside
 * fenced code blocks. See {@link scanInlinePriorContextRefs} for the syntax.
 */
export function parseInlinePriorContextRefs(
  text: string
): InlinePriorContextMatch[] {
  return scanInlinePriorContextRefs(maskFencedCodeBlocks(text));
}

/**
 * Parse condition-output references from prompt text.
 *
 * Unknown phases are ignored so future dollar-token namespaces can pass
 * through unchanged. Unknown fields on a recognized phase are returned for
 * the substitution layer to leave untouched.
 */
export function parseConditionOutputRefs(text: string): ConditionOutputMatch[] {
  const matches: ConditionOutputMatch[] = [];
  const maskedText = maskFencedCodeBlocks(text);
  const regex = createConditionOutputReferencePattern();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(maskedText)) !== null) {
    const phase = match[1];
    if (
      phase !== SCRIPT_OUTPUT_SOURCES.PRE_CONDITION &&
      phase !== SCRIPT_OUTPUT_SOURCES.END_CONDITION
    ) {
      continue;
    }

    const field = match[2] ?? "";
    matches.push({
      phase,
      field,
      token: match[0],
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return matches;
}

// ============================================================================
// Prior-context token-count reference encoding
// ============================================================================
//
// Prior-context refs ($previous, $step:1,3, …) expand to the *actual output* of
// earlier steps, so their token cost depends on how many steps precede the
// prompt being edited (`stepCount`), not just the ref text. The editor's token
// counter therefore can't cache them by ref text alone. These helpers encode a
// `(body, stepCount)` pair into a single opaque reference string (NUL-delimited,
// so it can never collide with a real `@`/`#`/`~` ref or prompt text) that the
// count request carries end to end and the frontend caches by. The encoded
// string is only ever produced by the editor hook and consumed by the counter
// (never parsed back out of prompt text), so it can't collide with a real ref.
// Single-sourced here so the hook and the extension-host counter stay in sync.

const PRIOR_CONTEXT_TOKEN_PREFIX = "PRIOR\x00";

/**
 * Encode a prior-context ref body (e.g. "previous", "step:1,3") plus the
 * count of preceding steps into a token-count reference string.
 */
export function encodePriorContextTokenRef(
  body: string,
  stepCount: number
): string {
  return `${PRIOR_CONTEXT_TOKEN_PREFIX}${stepCount}\x00${body}`;
}

/**
 * Decode a token-count reference produced by {@link encodePriorContextTokenRef},
 * or null if it is not a prior-context ref.
 */
export function decodePriorContextTokenRef(
  ref: string
): { body: string; stepCount: number } | null {
  if (!ref.startsWith(PRIOR_CONTEXT_TOKEN_PREFIX)) {
    return null;
  }
  const rest = ref.slice(PRIOR_CONTEXT_TOKEN_PREFIX.length);
  const separator = rest.indexOf("\x00");
  if (separator < 0) {
    return null;
  }
  const stepCount = parseInt(rest.slice(0, separator), 10);
  if (Number.isNaN(stepCount)) {
    return null;
  }
  return { body: rest.slice(separator + 1), stepCount };
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
  const maskedText = maskFencedCodeBlocks(text);

  // ~diff  — exact keyword
  // ~staged — exact keyword
  // ~stash:<N> — stash entry by index
  // ~[0-9a-f]{7,40} — commit hash (case-insensitive)
  // Same word-boundary rationale as parseAtReferences: rejects filename-legal
  // characters immediately before ~, not just alphanumerics (e.g. a word
  // ending in a hex-looking suffix like "abc123~stale" or a filename like
  // "data_file~@backup!.csv" shouldn't be mistaken for a commit-hash ref).
  const regex = createGitChangeReferencePattern();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(maskedText)) !== null) {
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

  // Every parser records the matched token's position in the original prompt.
  allRefs.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));

  return allRefs;
}
