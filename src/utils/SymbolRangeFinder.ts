/**
 * Provider-independent symbol range discovery.
 *
 * A `#sym:` reference already encodes the file path, symbol name, and the
 * symbol's 1-based start line (captured from VS Code's symbol provider at
 * completion time). To attach the symbol's body we only need its END line.
 *
 * Historically that end line came from `vscode.executeDocumentSymbolProvider`,
 * which makes symbol expansion depend on the VS Code extension host — it returns
 * nothing under the CLI shim, so symbol attachments silently failed when running
 * a workflow from the standalone CLI. This module computes the extent directly
 * from the file text using brace/indentation heuristics, so expansion behaves
 * identically in VS Code and the CLI (and needs no language extension loaded).
 */

export interface SymbolRange {
  /** 1-based start line of the symbol. */
  startLine: number;
  /** 1-based end line of the symbol (inclusive). */
  endLine: number;
}

/** Extensions whose blocks are delimited by indentation rather than braces. */
const INDENTATION_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".pyw",
  ".yaml",
  ".yml",
  ".coffee",
]);

/** Upper bound on how far we scan for an opening body brace / block end. */
const MAX_BLOCK_SCAN_LINES = 2000;

/**
 * Compute the line range of a symbol given the file content and the symbol's
 * declared start line. Never throws — falls back to a single-line range when the
 * extent can't be determined.
 *
 * @param content       Full file text.
 * @param symbolName    Symbol name (may include a trailing `()`).
 * @param startLine     1-based line where the symbol is declared.
 * @param fileExtension File extension including the dot (e.g. `.ts`), used to
 *                      pick brace- vs indentation-based block detection.
 */
export function findSymbolRange(
  content: string,
  symbolName: string,
  startLine: number,
  fileExtension: string
): SymbolRange {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) {
    return { startLine, endLine: startLine };
  }

  const startIdx = locateStartIndex(lines, symbolName, startLine);
  const ext = fileExtension.toLowerCase();

  let endIdx: number;
  if (INDENTATION_EXTENSIONS.has(ext)) {
    endIdx = findIndentBlockEnd(lines, startIdx);
  } else {
    const braceEnd = findBraceBlockEnd(lines, startIdx);
    endIdx = braceEnd !== null ? braceEnd : findIndentBlockEnd(lines, startIdx);
  }

  return { startLine: startIdx + 1, endLine: endIdx + 1 };
}

/**
 * Resolve the symbol's start line. Trusts the provided line when it actually
 * contains the symbol name; otherwise locates the first line that does (handles
 * a file that drifted since the reference was created).
 */
function locateStartIndex(
  lines: string[],
  symbolName: string,
  startLine: number
): number {
  const normalized = symbolName.replace(/\(\)$/, "");
  const givenIdx = clamp(startLine - 1, 0, lines.length - 1);

  const wordRe = new RegExp(`\\b${escapeRegExp(normalized)}\\b`);
  if (wordRe.test(lines[givenIdx])) {
    return givenIdx;
  }
  for (let i = 0; i < lines.length; i++) {
    if (wordRe.test(lines[i])) {
      return i;
    }
  }
  return givenIdx;
}

/**
 * Find the end of a brace-delimited block starting at (or just after) `startIdx`
 * by tracking brace depth. Distinguishes the symbol's body brace from inline
 * object-type braces in a signature (e.g. `foo(o: { a: number }): void {`) by
 * only "entering" the body once depth is still positive at a line boundary, and
 * bails out (returning null) when a statement terminator or blank line is hit
 * before any body brace — i.e. the symbol has no brace body (a field/property).
 *
 * @returns the 0-based end line, or null when no brace body is found.
 */
function findBraceBlockEnd(lines: string[], startIdx: number): number | null {
  let depth = 0;
  let entered = false;
  const limit = Math.min(lines.length, startIdx + MAX_BLOCK_SCAN_LINES);

  for (let i = startIdx; i < limit; i++) {
    const sanitized = stripStringsAndLineComments(lines[i]);
    for (const ch of sanitized) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }

    if (!entered) {
      if (depth > 0) {
        entered = true;
      } else {
        const trimmed = sanitized.trim();
        // A statement terminator at depth 0 before any body brace means this
        // symbol has no brace block (e.g. an interface property, a type alias,
        // or a single-statement const) — stop and let indentation decide.
        if (/;\s*$/.test(trimmed)) {
          return null;
        }
        // A blank line after the declaration likewise means "no brace body".
        if (i > startIdx && trimmed === "") {
          return null;
        }
      }
    }

    if (entered && depth <= 0) {
      return i;
    }
  }

  return entered ? limit - 1 : null;
}

/**
 * Find the end of an indentation-delimited block: the last non-blank line that
 * is more deeply indented than the start line. Blank lines do not terminate the
 * block. Used for Python/YAML and as the fallback for brace-less symbols.
 *
 * @returns the 0-based end line.
 */
function findIndentBlockEnd(lines: string[], startIdx: number): number {
  const baseIndent = indentWidth(lines[startIdx]);
  let end = startIdx;
  const limit = Math.min(lines.length, startIdx + MAX_BLOCK_SCAN_LINES);

  for (let i = startIdx + 1; i < limit; i++) {
    if (lines[i].trim() === "") {
      continue;
    }
    if (indentWidth(lines[i]) <= baseIndent) {
      break;
    }
    end = i;
  }
  return end;
}

/** Count leading-whitespace width (tab counts as one unit for comparison). */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t") {
      width++;
    } else {
      break;
    }
  }
  return width;
}

/**
 * Crudely remove line comments and single-line string/template literal contents
 * so braces inside them are not counted. Does not handle multi-line strings or
 * block comments — acceptable for the first/last lines of a symbol body.
 */
function stripStringsAndLineComments(line: string): string {
  let s = line.replace(/\/\/.*$/, "");
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''");
  s = s.replace(/`(?:\\.|[^`\\])*`/g, "``");
  return s;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
