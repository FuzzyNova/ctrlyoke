const PATH_DEPTH_PADDING = 4;

export function getPathDepth(relativePath: string): number {
  return relativePath.split("/").length;
}

export function getPathDepthSortKey(relativePath: string): string {
  return String(getPathDepth(relativePath)).padStart(PATH_DEPTH_PADDING, "0");
}

export function comparePathDepths(a: string, b: string): number {
  return getPathDepth(a) - getPathDepth(b) || a.localeCompare(b);
}
