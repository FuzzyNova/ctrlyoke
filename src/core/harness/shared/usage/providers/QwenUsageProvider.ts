import { HARNESS_IDS } from "../../../../../types/DashboardConstants";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";
import { ObservedOnlyUsageProvider } from "../ObservedOnlyUsageProvider";

export class QwenUsageProvider
  extends ObservedOnlyUsageProvider
  implements IHarnessUsageProvider
{
  constructor() {
    super(HARNESS_IDS.QWEN_CLI);
  }
}
