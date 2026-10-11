import {
  STATUS_LINE_USAGE_DIRECTIONS,
  type UsagePercentDirection,
} from "@root/utils/StatuslineFormat";
import { useSettingsStore } from "@store/settingsStore";

/** Reads the shared quota percentage direction setting with its default. */
export function useUsagePercentDirection(): UsagePercentDirection {
  return useSettingsStore(
    (state) =>
      state.fullGlobalSettings?.settings.usageTracking.percentDirection ??
      STATUS_LINE_USAGE_DIRECTIONS.USED
  );
}
