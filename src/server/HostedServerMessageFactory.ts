import type { HarnessId } from "../types/DashboardConstants";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  HarnessAvailabilityReport,
  HarnessStatusUpdateMessage,
} from "../types/WebviewMessageTypes";
import { toHarnessStatusInfo } from "../core/harness/shared/HarnessDetection";

export function createHostedHarnessStatusUpdate(
  harnessId: HarnessId,
  report: HarnessAvailabilityReport
): HarnessStatusUpdateMessage {
  return {
    type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
    data: {
      harnessStatus: {
        [harnessId]: toHarnessStatusInfo(report),
      },
    },
  };
}
