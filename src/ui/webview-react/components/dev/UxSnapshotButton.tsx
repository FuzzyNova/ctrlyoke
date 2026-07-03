import { useState } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { captureUxSnapshot } from "@utils/uxSnapshot";
import { WebviewLog } from "@utils/logger";

/**
 * Floating, dev-only "UX Snapshot" capture button pinned to the right-center of
 * the viewport. On tap it serializes the live UI (HTML + computed styles +
 * matched author rules) and posts it to the extension host, which writes it to
 * `.ctrlyoke/snapshots/`. The saved-path confirmation toast is fired from the
 * UX_SNAPSHOT_SAVED handler in useMessageHandler.
 *
 * Mounts only when (a) this is a dev build and (b) the user has toggled the
 * button on in Developer settings.
 */
export function UxSnapshotButton() {
  const vscode = useVsCodeApi();
  const devEnabled = useSettingsStore((s) => s.dev?.enabled ?? false);
  const visible = useUiStore((s) => s.uxSnapshotButtonVisible);
  const showToast = useUiStore((s) => s.showToast);
  const [capturing, setCapturing] = useState(false);

  if (!devEnabled || !visible) {
    return null;
  }

  const handleCapture = () => {
    if (capturing) {
      return;
    }
    setCapturing(true);
    try {
      const { markdown, png } = captureUxSnapshot();
      vscode.postMessage({
        type: MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE,
        markdown,
        png,
      });
      showToast("Capturing UX snapshot…", "info");
    } catch (error) {
      WebviewLog.error("UX snapshot capture failed", error);
      showToast("UX snapshot capture failed", "error");
    } finally {
      // The extension reply (UX_SNAPSHOT_SAVED) drives the final toast; release
      // the button shortly after so a slow write can't wedge it permanently.
      setTimeout(() => setCapturing(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCapture}
      disabled={capturing}
      aria-label="Capture UX snapshot"
      title="Capture UX snapshot (dev)"
      className="fixed right-0 top-1/2 -translate-y-1/2 z-popover flex items-center justify-center w-9 h-11 rounded-l-md border border-r-0 border-panel-border bg-editor-bg/90 text-description-fg shadow-md backdrop-blur hover:text-foreground hover:bg-editor-bg disabled:opacity-60 disabled:cursor-wait"
    >
      <i
        className={`codicon ${capturing ? "codicon-loading codicon-modifier-spin" : "codicon-device-camera"}`}
      />
    </button>
  );
}
