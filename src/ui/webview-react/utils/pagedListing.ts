import type { VirtualizedListRange } from "@components/shared/VirtualizedListFoundation";
import { ERROR_NAMES } from "@root/types/DashboardConstants";
import { HostedHttpError } from "@utils/hostedApi";

/** HTTP status the hosted viewer answers for an evicted listing snapshot. */
const EXPIRED_LISTING_STATUS = 410;

export function pageOffset(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize) * pageSize;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === ERROR_NAMES.ABORT;
}

/**
 * Whether a page request failed because the server evicted the listing's
 * snapshot (it does after several idle minutes). Requests naming that listing
 * id can never succeed again, so the hook must start a fresh listing.
 */
export function isExpiredListingError(value: unknown): boolean {
  return (
    value instanceof HostedHttpError && value.status === EXPIRED_LISTING_STATUS
  );
}

/** Page offsets covering a virtualized range's overscan window. */
export function rangePageOffsets(
  range: VirtualizedListRange | null,
  pageSize: number
): number[] {
  if (!range) return [];
  const offsets: number[] = [];
  const last = pageOffset(range.overscanEndIndex, pageSize);
  for (
    let offset = pageOffset(range.overscanStartIndex, pageSize);
    offset <= last;
    offset += pageSize
  ) {
    offsets.push(offset);
  }
  return offsets;
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
