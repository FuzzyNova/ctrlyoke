import {
  HARNESS_QUOTA_SOURCES,
  type HarnessId,
} from "../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../types/UsageTypes";
import type { IHarnessUsageProvider } from "./IHarnessUsageProvider";

/** Stage-5 provider fallback. Observed totals are merged by the service. */
export class ObservedOnlyUsageProvider implements IHarnessUsageProvider {
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
