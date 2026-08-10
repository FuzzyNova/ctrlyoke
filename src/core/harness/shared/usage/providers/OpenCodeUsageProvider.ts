import { HARNESS_IDS } from "../../../../../types/DashboardConstants";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";
import { ObservedOnlyUsageProvider } from "../ObservedOnlyUsageProvider";

export class OpenCodeUsageProvider
  extends ObservedOnlyUsageProvider
  implements IHarnessUsageProvider
{
  constructor() {
    super(HARNESS_IDS.OPENCODE_CLI);
  }
}
