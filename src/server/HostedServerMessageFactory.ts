import {
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
} from "../types/DashboardConstants";

export function createHostedHarnessStatusUpdate(
  harnessId: string,
  available: boolean
): {
  type: string;
  data: {
    harnessStatus: Record<
      string,
      {
        available: boolean;
        status: string;
      }
    >;
  };
} {
  return {
    type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
    data: {
      harnessStatus: {
        [harnessId]: {
          available,
          status: available
            ? HARNESS_STATUS_STRINGS.AVAILABLE
            : HARNESS_STATUS_STRINGS.UNAVAILABLE,
        },
      },
    },
  };
}
