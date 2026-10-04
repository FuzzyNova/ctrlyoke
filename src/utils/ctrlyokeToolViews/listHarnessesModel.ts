import { isRecord, tryParseJson } from "./shared";
import { HARNESS_IDS } from "../../types/DashboardConstants";
export interface HarnessModel {
  id: string;
  displayName: string;
  available: boolean;
  models?: string[];
}
export interface ListHarnessesParams {}
export interface ListHarnessesResult {
  harnesses: HarnessModel[];
}
export function parseListHarnessesParams(
  raw: unknown
): ListHarnessesParams | undefined {
  return isRecord(raw) ? {} : undefined;
}
export function parseListHarnessesResultText(
  text: string
): ListHarnessesResult | undefined {
  try {
    const value: unknown = tryParseJson(text);
    if (!isRecord(value) || !Array.isArray(value.harnesses)) return undefined;
    const valid = value.harnesses.every(
      (h) =>
        isRecord(h) &&
        typeof h.id === "string" &&
        typeof h.displayName === "string" &&
        typeof h.available === "boolean" &&
        (h.models === undefined ||
          (Array.isArray(h.models) &&
            h.models.every((m) => typeof m === "string")))
    );
    if (!valid) return undefined;
    return value as unknown as ListHarnessesResult;
  } catch {
    return undefined;
  }
}
const ALL_HARNESS_IDS = Object.values(HARNESS_IDS);
export function listHarnessesSummary(
  _params: ListHarnessesParams | undefined,
  result: ListHarnessesResult
): string {
  return `${ALL_HARNESS_IDS.length} harnesses (${result.harnesses.filter((h) => h.available).length} available)`;
}
export function allHarnesses(result: ListHarnessesResult): HarnessModel[] {
  const byId = new Map(result.harnesses.map((h) => [h.id, h]));
  return ALL_HARNESS_IDS.map(
    (id) =>
      byId.get(id) ?? { id, displayName: id, available: false, models: [] }
  );
}
export function listHarnessesSearchText(
  params: ListHarnessesParams | undefined,
  result: ListHarnessesResult
): string[] {
  return [
    listHarnessesSummary(params, result),
    allHarnesses(result)
      .map(
        (h) => `${h.displayName} · ${h.available ? "available" : "unavailable"}`
      )
      .join("\n"),
  ];
}
