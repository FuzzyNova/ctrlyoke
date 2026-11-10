import { HARNESS_IDS } from "../../../../../types/DashboardConstants";
import type { IHarnessQuotaCollector } from "../IHarnessQuotaCollector";
import { ObservedOnlyQuotaCollector } from "../ObservedOnlyQuotaCollector";

export class OpenCodeQuotaCollector
  extends ObservedOnlyQuotaCollector
  implements IHarnessQuotaCollector
{
  constructor() {
    super(HARNESS_IDS.OPENCODE_CLI);
  }
}
