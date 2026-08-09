export function normalizeReferencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function quoteReferencePath(pathValue: string): string {
  return pathValue.includes(" ") ? `"${pathValue}"` : pathValue;
}

/**
 * Quote a value that sits in a **colon-delimited field** of a `#selection:` or
 * `#sym:` reference (their path, and a symbol's name).
 *
 * Stricter than {@link quoteReferencePath}, which only quotes on spaces. Inside
 * `#sym:<path>:<name>:<start>-<end>` a colon is structurally ambiguous — it is
 * the field separator — so a Windows absolute path (`C:\dev\a.ts`) or a symbol
 * name containing a colon produces a token no parser can read unless it is
 * quoted. In an `@ref` there is no following field, so a colon is unambiguous
 * there and `quoteReferencePath` stays space-only.
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
