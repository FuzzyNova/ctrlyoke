import { EXECUTION_STATES } from "../types/DashboardConstants";
import { parseHistoryTime } from "./HistoryTime";

/** Shared state and start-time parsing for history search and list filters. */
export function parseHistoryStateFilter(
  values: string[] | undefined
): string[] | undefined {
  if (!values) return undefined;
  const allowed = Object.values(EXECUTION_STATES);
  const allowedSet = new Set<string>(allowed);
  const invalid = values.find((value) => !allowedSet.has(value));
  if (invalid !== undefined) {
    throw new Error(
      `Invalid --state value "${invalid}". Valid values: ${allowed.join(", ")}`
    );
  }
  return values;
}

export function parseHistorySince(
  value: string | undefined
): number | undefined {
  return value === undefined ? undefined : parseHistoryTime(value);
}

export function parseHistoryInteger(
  value: string | undefined,
  optionName: string,
  minimum: number,
  whenMissing: number
): number {
  if (value === undefined) return whenMissing;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${optionName} value "${value}"; expected an integer.`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `Invalid ${optionName} value "${value}"; expected an integer of at least ${minimum}.`
    );
  }
  return parsed;
}
