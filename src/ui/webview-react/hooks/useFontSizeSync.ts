import { useEffect } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import { EDITOR_FONT_SIZE_VSCODE } from "@root/types/DashboardConstants";
import { EDITOR_FONT_SIZE_CSS_VAR } from "@utils/codemirrorTheme";
import { terminalRegistry } from "../terminalRegistry";

/** Root CSS custom property every output-area size derives from (globals.css). */
const OUTPUT_FONT_SIZE_CSS_VAR = "--cy-output-font-size";

/**
 * Applies the three font-size settings to the page: the output size and editor
 * size as root CSS custom properties, and the terminal size to every live
 * xterm. Reads the mirrored `globalSettings`, which is present from INIT
 * onward and patched optimistically by the header steppers.
 */
export function useFontSizeSync(): void {
  const outputFontSize = useSettingsStore(
    (s) => s.globalSettings.outputFontSize
  );
  const editorFontSize = useSettingsStore(
    (s) => s.globalSettings.editorFontSize
  );
  const terminalFontSize = useSettingsStore(
    (s) =>
      s.globalSettings.terminal?.fontSize ??
      CTRLYOKE_SETTINGS_DEFAULTS.terminal.fontSize
  );

  useEffect(() => {
    document.documentElement.style.setProperty(
      OUTPUT_FONT_SIZE_CSS_VAR,
      `${outputFontSize}px`
    );
  }, [outputFontSize]);

  // "vscode" removes the override so the theme falls back to VS Code's size.
  useEffect(() => {
    const root = document.documentElement.style;
    if (editorFontSize === EDITOR_FONT_SIZE_VSCODE) {
      root.removeProperty(EDITOR_FONT_SIZE_CSS_VAR);
    } else {
      root.setProperty(EDITOR_FONT_SIZE_CSS_VAR, `${editorFontSize}px`);
    }
  }, [editorFontSize]);

  useEffect(() => {
    terminalRegistry.updateFontSize(terminalFontSize);
  }, [terminalFontSize]);
}
