import {
  HARNESS_QUOTA_SOURCES,
  type HarnessId,
} from "../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../types/UsageTypes";
import type { IHarnessQuotaCollector } from "./IHarnessQuotaCollector";

/** Stage-5 provider fallback. Observed totals are merged by the service. */
export class ObservedOnlyQuotaCollector implements IHarnessQuotaCollector {
  constructor(public readonly harnessId: HarnessId) {}

  async refreshUsage(_signal?: AbortSignal): Promise<HarnessQuotaSnapshot> {
    return {
      harnessId: this.harnessId,
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      staleAfterMs: 0,
      windows: [],
    };
  }
}
