import { useMemo } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { TERMINAL_MOBILE_CONTROL_BAR } from "@root/types/DashboardConstants";
import { isStandalone } from "./useVsCodeApi";
import { useMediaQuery } from "./useMediaQuery";

export interface MobileTerminalBarState {
  shouldShow: boolean;
  isCoarsePointer: boolean;
  hasTouchCapability: boolean;
}

/**
 * Resolves mobile terminal control bar visibility from device signals plus
 * the user override in terminal settings.
 */
export function useMobileTerminalBar(): MobileTerminalBarState {
  const mobileControlBar = useSettingsStore(
    (s) =>
      s.fullGlobalSettings?.settings.terminal.mobileControlBar ??
      s.globalSettings.terminal?.mobileControlBar ??
      TERMINAL_MOBILE_CONTROL_BAR.AUTO
  );
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const hasTouchCapability = useMemo(
    () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0,
    []
  );

  if (mobileControlBar === TERMINAL_MOBILE_CONTROL_BAR.NEVER) {
    return { shouldShow: false, isCoarsePointer, hasTouchCapability };
  }

  if (mobileControlBar === TERMINAL_MOBILE_CONTROL_BAR.ALWAYS) {
    return { shouldShow: true, isCoarsePointer, hasTouchCapability };
  }

  return {
    shouldShow: isStandalone && hasTouchCapability && isCoarsePointer,
    isCoarsePointer,
    hasTouchCapability,
  };
}
