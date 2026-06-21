export function normalizeReferencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function quoteReferencePath(pathValue: string): string {
  return pathValue.includes(" ") ? `"${pathValue}"` : pathValue;
}

export function buildFileReferenceValue(relativePath: string): string {
  return quoteReferencePath(normalizeReferencePath(relativePath));
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
  return `selection:${buildFileReferenceValue(relativePath)}:${startLine}-${endLine}`;
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
  endLine: number
): string {
  return `sym:${buildFileReferenceValue(relativePath)}:${symbolName}:${startLine}-${endLine}`;
}

export function buildSymbolReference(
  relativePath: string,
  symbolName: string,
  startLine: number,
  endLine: number
): string {
  return `#${buildSymbolReferenceValue(relativePath, symbolName, startLine, endLine)}`;
}

function buildGitReferenceValue(ref: string): string {
  return ref;
}

export function buildGitReference(ref: string): string {
  return `~${buildGitReferenceValue(ref)}`;
}
