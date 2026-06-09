import React, { useCallback, useState } from "react";
import { Modal } from "./Modal";
import { useUiStore } from "@store/uiStore";
import { isStandalone } from "@hooks/useVsCodeApi";
import { sendMessage } from "@hooks/useMessageHandler";
import { MESSAGE_TYPES } from "@/types/messages";

/**
 * Modal that displays git diff or prior-context XML preview content.
 * Triggered by ~diff / ~staged / ~stash / ~<hash> and $prior-context links
 * in the CodeMirror prompt editor. Works in both VS Code and browser mode.
 *
 * Footer actions:
 * - Copy  — copies content to clipboard
 * - Open in Editor (VS Code only) — re-opens the content in a VS Code text document
 * - Download (browser only) — triggers a browser file download
 */
export const ContentPreviewModal: React.FC = () => {
  const modal = useUiStore((s) => s.contentPreviewModal);
  const setContentPreviewModal = useUiStore((s) => s.setContentPreviewModal);
  const [copied, setCopied] = useState(false);

  const handleClose = useCallback(() => {
    setContentPreviewModal(null);
  }, [setContentPreviewModal]);

  const handleCopy = useCallback(async () => {
    if (!modal) return;
    try {
      await navigator.clipboard.writeText(modal.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [modal]);

  const handleExport = useCallback(() => {
    if (!modal) return;
    if (isStandalone) {
      const ext = modal.language === "diff" ? ".diff" : ".xml";
      const filename = `flightpath-${modal.ref.replace(/[^a-z0-9_]/gi, "-").toLowerCase()}${ext}`;
      const blob = new Blob([modal.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      sendMessage(MESSAGE_TYPES.EXPORT_CONTENT_PREVIEW, {
        content: modal.content,
        language: modal.language,
        title: modal.title,
      });
    }
  }, [modal]);

  if (!modal) return null;

  return (
    <Modal
      isOpen
      title={modal.title}
      onClose={handleClose}
      size="xl"
      fullWidthOnNarrow
      footer={
        <>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors ${
              copied
                ? "text-indicator-success"
                : "text-description-fg hover:text-foreground"
            }`}
            onClick={handleCopy}
            title="Copy to clipboard"
          >
            <i
              className={`codicon ${copied ? "codicon-check" : "codicon-copy"}`}
            />
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-btn-bg text-btn-fg hover:bg-btn-hover rounded transition-colors"
            onClick={handleExport}
            title={isStandalone ? "Download as file" : "Open in VS Code editor"}
          >
            {isStandalone ? (
              <>
                <i className="codicon codicon-cloud-download" />
                Download
              </>
            ) : (
              <>
                <i className="codicon codicon-go-to-file" />
                Open in Editor
              </>
            )}
          </button>
        </>
      }
    >
      <pre className="font-mono text-xs leading-relaxed text-editor-fg whitespace-pre overflow-x-auto">
        {modal.content}
      </pre>
    </Modal>
  );
};
