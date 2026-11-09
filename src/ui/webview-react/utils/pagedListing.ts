import { ERROR_NAMES } from "@root/types/DashboardConstants";

export function pageOffset(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize) * pageSize;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === ERROR_NAMES.ABORT;
}

export function normalizeRepo(repo: string | undefined): string | undefined {
  const normalized = repo?.trim();
  return normalized ? normalized : undefined;
}

export function normalizePagedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function listingKey(value: string, repo: string | undefined): string {
  return `${repo ?? ""}\u0000${value}`;
}

export function loadedRowCount<T>(
  pages: ReadonlyMap<number, readonly T[]>,
  minimum = 0
): number {
  let count = 0;
  for (const rows of pages.values()) count += rows.length;
  return Math.max(minimum, count);
}
