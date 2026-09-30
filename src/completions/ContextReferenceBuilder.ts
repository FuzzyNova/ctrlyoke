export function normalizeReferencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function quoteReferencePath(pathValue: string): string {
  return /[\s:]/.test(pathValue) ? `"${pathValue}"` : pathValue;
}

/**
 * Quote a value that sits in a **colon-delimited field** of a `#selection:` or
 * `#sym:` reference (their path, and a symbol's name).
 *
 * In `#sym:<path>:<name>:<start>-<end>`, colons separate fields, so a Windows
 * absolute path (`C:\dev\a.ts`) or a symbol name containing a colon must be
 * quoted for the parser to read it. `quoteReferencePath` uses the same rule
 * as defense in depth for references created from absolute paths.
 *
 * A literal `"` in a path or symbol name is not supported: both the quoted and
 * the bare form of a field exclude it, and there is no escape syntax.
 */
export function quoteReferenceField(value: string): string {
  return /[\s:]/.test(value) ? `"${value}"` : value;
}

export function buildFileReferenceValue(relativePath: string): string {
  return quoteReferencePath(normalizeReferencePath(relativePath));
}

/**
 * Build a canonical lone prompt-file reference. Unlike an @-reference, the
 * leading `./` is part of the path syntax in a single-root workspace and the
 * value must never be quoted.
 */
export function buildPromptFileReferenceValue(relativePath: string): string {
  const normalizedPath = normalizeReferencePath(relativePath)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  return `./${normalizedPath}`;
}

export function buildFileReference(relativePath: string): string {
  return `@${buildFileReferenceValue(relativePath)}`;
}

export function buildDirectoryReferenceValue(relativePath: string): string {
  const normalizedPath = normalizeReferencePath(relativePath).replace(
    /\/+$/,
    ""
  );
  return quoteReferencePath(`${normalizedPath}/`);
}

export function buildDirectoryReference(relativePath: string): string {
  return `@${buildDirectoryReferenceValue(relativePath)}`;
}

export function buildSelectionReferenceValue(
  relativePath: string,
  startLine: number,
  endLine: number
): string {
  const path = quoteReferenceField(normalizeReferencePath(relativePath));
  return `selection:${path}:${startLine}-${endLine}`;
}

export function buildSelectionReference(
  relativePath: string,
  startLine: number,
  endLine: number
): string {
  return `#${buildSelectionReferenceValue(relativePath, startLine, endLine)}`;
}

/**
 * Build the literal `#selection:<path>:<start>-<end>` text for a path that is
 * already in its final display form (e.g. an absolute path from a CLI file-read
 * event). Unlike {@link buildSelectionReference}, this does not normalize
 * separators via `normalizeReferencePath` — output surfaces show paths
 * verbatim, backslashes included — it only quotes the field when the path
 * needs it (Windows drive-letter colons, spaces).
 */
export function buildSelectionReferenceText(
  path: string,
  startLine: number,
  endLine: number
): string {
  return `#selection:${quoteReferenceField(path)}:${startLine}-${endLine}`;
}

export function buildSymbolReferenceValue(
  relativePath: string,
  symbolName: string,
  startLine: number,
  endLine: number,
  symbolKind?: string
): string {
  const path = quoteReferenceField(normalizeReferencePath(relativePath));
  // Symbol names come verbatim from the language server and routinely contain
  // spaces (Markdown headings, CSS selectors) or angle brackets/dots/hyphens.
  const verb = symbolKind ? `sym.${symbolKind}` : "sym";
  return `${verb}:${path}:${quoteReferenceField(symbolName)}:${startLine}-${endLine}`;
}

export function buildSymbolReference(
  relativePath: string,
  symbolName: string,
  startLine: number,
  endLine: number,
  symbolKind?: string
): string {
  return `#${buildSymbolReferenceValue(
    relativePath,
    symbolName,
    startLine,
    endLine,
    symbolKind
  )}`;
}

function buildGitReferenceValue(ref: string): string {
  return ref;
}

export function buildGitReference(ref: string): string {
  return `~${buildGitReferenceValue(ref)}`;
}
