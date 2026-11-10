import { HARNESS_IDS } from "../../../../../types/DashboardConstants";
import type { IHarnessQuotaCollector } from "../IHarnessQuotaCollector";
import { ObservedOnlyQuotaCollector } from "../ObservedOnlyQuotaCollector";

export class QwenQuotaCollector
  extends ObservedOnlyQuotaCollector
  implements IHarnessQuotaCollector
{
  constructor() {
    super(HARNESS_IDS.QWEN_CLI);
  }
}
