import {
  ATTEMPT_COST_SOURCES,
  type AttemptCostSource,
} from "../../../../types/DashboardConstants";

export function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function stableCostSources(
  sources: readonly AttemptCostSource[] | undefined
): AttemptCostSource[] | undefined {
  if (!sources?.length) return undefined;
  const sourceSet = new Set(sources);
  const ordered = Object.values(ATTEMPT_COST_SOURCES).filter((source) =>
    sourceSet.has(source)
  );
  return ordered.length ? ordered : undefined;
}
