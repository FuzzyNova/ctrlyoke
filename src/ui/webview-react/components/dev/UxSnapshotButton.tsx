import { useEffect } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { captureUxSnapshot } from "@utils/uxSnapshot";
import { WebviewLog } from "@utils/logger";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { notifyUser } from "@utils/notifyUser";

/**
 * Floating, dev-only "UX Snapshot" capture button pinned to the right-center of
 * the viewport. On tap it serializes the live UI (HTML + computed styles +
 * matched author rules) and posts it to the extension host, which writes it to
 * `.ctrlyoke/snapshots/`.
 *
 * Feedback (mirrors the copy button in CliOutput): the icon flips to a spinner
 * the instant it is tapped, stays spinning through the write round-trip, then
 * shows a brief green check when the extension confirms the save. Because the
 * capture is a heavy synchronous DOM walk that would block the paint, it is
 * deferred a couple of frames so the spinner is visible first.
 *
 * Mounts only when (a) this is a dev build and (b) the user has toggled the
 * button on in Developer settings.
 */
export function UxSnapshotButton() {
  const vscode = useVsCodeApi();
  const devEnabled = useSettingsStore((s) => s.dev?.enabled ?? false);
  const visible = useUiStore((s) => s.uxSnapshotButtonVisible);
  const status = useUiStore((s) => s.uxSnapshotStatus);
  const setStatus = useUiStore((s) => s.setUxSnapshotStatus);

  // Auto-reset: clear the green check / error flash after a moment, and guard
  // against a missing reply leaving the spinner stuck forever.
  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const delay = status === "capturing" ? 8000 : 1200;
    const timer = window.setTimeout(() => setStatus("idle"), delay);
    return () => window.clearTimeout(timer);
  }, [status, setStatus]);

  if (!devEnabled || !visible) {
    return null;
  }

  // Swallow mousedown here so it never bubbles to document, where WorkflowStatus's
  // outside-click listener (bound to "mousedown") would otherwise treat this tap as
  // "outside" and close whatever dropdown is currently open — right before the click
  // handler below gets a chance to snapshot it. React delegates synthetic events at
  // the app root, which sits between this button and document in the bubble path, so
  // this always runs before that document-level listener does.
  const swallowMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleCapture = () => {
    if (status === "capturing") {
      return;
    }
    // Paint the spinner first, then run the blocking capture two frames later so
    // the tap gives instant feedback instead of freezing on the old icon.
    setStatus("capturing");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const { markdown, png } = captureUxSnapshot();
          vscode.postMessage({
            type: MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE,
            markdown,
            png,
          });
        } catch (error) {
          WebviewLog.error("UX snapshot capture failed", error);
          notifyUser(
            "UX snapshot capture failed",
            USER_FEEDBACK_SEVERITY.ERROR
          );
          setStatus("error");
        }
      });
    });
  };

  const iconClass =
    status === "capturing"
      ? "codicon-loading codicon-modifier-spin"
      : status === "saved"
        ? "codicon-check"
        : status === "error"
          ? "codicon-error"
          : "codicon-device-camera";

  const stateTextClass =
    status === "saved"
      ? "text-indicator-success"
      : status === "error"
        ? "text-error-fg"
        : "text-description-fg hover:text-foreground";

  return (
    <button
      type="button"
      onMouseDown={swallowMouseDown}
      onClick={handleCapture}
      disabled={status === "capturing"}
      aria-label="Capture UX snapshot"
      title="Capture UX snapshot (dev)"
      className={`fixed right-0 top-1/2 -translate-y-1/2 z-popover flex items-center justify-center w-9 h-11 rounded-l-md border border-r-0 border-panel-border bg-editor-bg/90 shadow-md backdrop-blur transition-colors hover:bg-editor-bg disabled:cursor-wait ${stateTextClass}`}
    >
      <i className={`codicon ${iconClass}`} />
    </button>
  );
}
