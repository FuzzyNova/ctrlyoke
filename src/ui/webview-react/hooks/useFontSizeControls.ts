import { useCallback } from "react";
import {
  selectSettingWriteScope,
  useSettingsStore,
} from "@store/settingsStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  CTRLYOKE_SETTINGS_DEFAULTS,
  FONT_SIZE_LIMITS,
  clampFontSize,
} from "@root/types/CtrlYokeSettings";
import {
  MESSAGE_TYPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";

const OUTPUT_FONT_SIZE_PATH = "ui.outputFontSize";
const TERMINAL_FONT_SIZE_PATH = "terminal.fontSize";

export interface FontSizeControls {
  outputFontSize: number;
  terminalFontSize: number;
  setOutputFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
}

function writeFontSizeSetting(
  path: string,
  size: number,
  scope: SettingWriteScope
): void {
  getVsCodeApi()?.postMessage({
    type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
    path,
    value: size,
    scope,
  });
}

/**
 * The output toolbar's font-size steppers. Both write the real setting (to the
 * workspace when a workspace file already owns it) and patch the mirrored
 * `globalSettings` at once, so repeated clicks step from the value on screen
 * instead of waiting for the settings broadcast to come back.
 */
export function useFontSizeControls(): FontSizeControls {
  const outputFontSize = useSettingsStore(
    (s) => s.globalSettings.outputFontSize
  );
  const terminalFontSize = useSettingsStore(
    (s) =>
      s.globalSettings.terminal?.fontSize ??
      CTRLYOKE_SETTINGS_DEFAULTS.terminal.fontSize
  );
  const outputScope = useSettingsStore((s) =>
    selectSettingWriteScope(s, OUTPUT_FONT_SIZE_PATH)
  );
  const terminalScope = useSettingsStore((s) =>
    selectSettingWriteScope(s, TERMINAL_FONT_SIZE_PATH)
  );

  const setOutputFontSize = useCallback(
    (size: number) => {
      const next = clampFontSize(size, FONT_SIZE_LIMITS.output, outputFontSize);
      useSettingsStore.getState().updateGlobalSetting("outputFontSize", next);
      writeFontSizeSetting(OUTPUT_FONT_SIZE_PATH, next, outputScope);
    },
    [outputFontSize, outputScope]
  );

  const setTerminalFontSize = useCallback(
    (size: number) => {
      const next = clampFontSize(
        size,
        FONT_SIZE_LIMITS.terminal,
        terminalFontSize
      );
      const { globalSettings, updateGlobalSetting } =
        useSettingsStore.getState();
      if (globalSettings.terminal) {
        updateGlobalSetting("terminal", {
          ...globalSettings.terminal,
          fontSize: next,
        });
      }
      writeFontSizeSetting(TERMINAL_FONT_SIZE_PATH, next, terminalScope);
    },
    [terminalFontSize, terminalScope]
  );

  return {
    outputFontSize,
    terminalFontSize,
    setOutputFontSize,
    setTerminalFontSize,
  };
}
