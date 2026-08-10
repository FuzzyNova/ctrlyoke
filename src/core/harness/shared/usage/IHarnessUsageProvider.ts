import type { HarnessId } from "../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../types/UsageTypes";

/** Pull boundary for provider quota collectors. */
export interface IHarnessUsageProvider {
  readonly harnessId: HarnessId;
  refreshUsage(signal?: AbortSignal): Promise<HarnessQuotaSnapshot>;
}
