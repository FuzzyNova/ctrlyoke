import { useEffect } from "react";
import { selectUiAccessibility, useSettingsStore } from "@store/settingsStore";
import { terminalRegistry } from "../terminalRegistry";

/**
 * Apply `ui.accessibility.terminalScreenReaderMode` to every terminal session.
 * An explicit setting because a browser cannot tell that a screen reader is
 * running.
 */
export function useTerminalScreenReaderModeSync(): void {
  const enabled = useSettingsStore(
    (state) => selectUiAccessibility(state).terminalScreenReaderMode
  );
  useEffect(() => {
    terminalRegistry.setScreenReaderMode(enabled);
  }, [enabled]);
}
