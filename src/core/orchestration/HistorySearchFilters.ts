import type {
  HistorySearchDocument,
  HistorySearchFilters,
} from "../../types/WorkflowTimelineTypes";

/** Applies the backend search filters consistently to indexed and fallback documents. */
export function matchesFilters(
  document: HistorySearchDocument,
  filters: HistorySearchFilters | undefined
): boolean {
  if (!filters) {
    return true;
  }

  if (
    filters.eventKinds &&
    filters.eventKinds.length > 0 &&
    !filters.eventKinds.includes(document.eventKind)
  ) {
    return false;
  }

  if (
    filters.workflowKeys &&
    filters.workflowKeys.length > 0 &&
    !filters.workflowKeys.includes(document.workflowKey)
  ) {
    return false;
  }

  if (typeof filters.since === "number" && document.startedAt < filters.since) {
    return false;
  }

  if (typeof filters.until === "number" && document.startedAt > filters.until) {
    return false;
  }

  if (
    filters.harnesses &&
    filters.harnesses.length > 0 &&
    (!document.harness || !filters.harnesses.includes(document.harness))
  ) {
    return false;
  }

  if (
    filters.executionStates &&
    filters.executionStates.length > 0 &&
    !filters.executionStates.includes(document.executionState)
  ) {
    return false;
  }

  const pathContains = filters.pathContains?.trim();
  if (
    pathContains &&
    (!document.filePath ||
      !normalizePath(document.filePath).includes(normalizePath(pathContains)))
  ) {
    return false;
  }

  return true;
}

/** Normalizes filter values for a stable, order-insensitive cursor hash. */
export function normalizeHistorySearchFilters(
  filters: HistorySearchFilters | undefined
): HistorySearchFilters {
  if (!filters) {
    return {};
  }

  return {
    ...(filters.eventKinds?.length
      ? { eventKinds: [...filters.eventKinds].sort() }
      : {}),
    ...(filters.workflowKeys?.length
      ? { workflowKeys: [...filters.workflowKeys].sort() }
      : {}),
    ...(typeof filters.since === "number" ? { since: filters.since } : {}),
    ...(typeof filters.until === "number" ? { until: filters.until } : {}),
    ...(filters.harnesses?.length
      ? { harnesses: [...filters.harnesses].sort() }
      : {}),
    ...(filters.executionStates?.length
      ? { executionStates: [...filters.executionStates].sort() }
      : {}),
    ...(filters.pathContains?.trim()
      ? { pathContains: normalizePath(filters.pathContains) }
      : {}),
  };
}

/** Regex syntax is case-sensitive even though matching itself is case-insensitive. */
export function normalizeHistorySearchQueryKey(
  query: string,
  regex: boolean
): string {
  const trimmed = query.trim();
  return regex ? trimmed : trimmed.toLowerCase();
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
