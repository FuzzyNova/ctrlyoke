import React, { useCallback, useState } from "react";
import { Modal } from "./Modal";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { isStandalone } from "@hooks/useVsCodeApi";
import { sendMessage } from "@hooks/useMessageHandler";
import { MESSAGE_TYPES } from "@/types/messages";
import { downloadTextFile } from "@utils/download";
import { CONTENT_PREVIEW_LANGUAGES } from "@root/types/DashboardConstants";
import { Icon } from "./Icon";

/**
 * Modal that displays prior-context XML preview content, a resolved
 * `/mcp:<name>` reference's server config as JSON, and (as a fallback in
 * VS Code mode) git-ref diffs before the native diff command is available.
 * The primary git-ref path in browser mode now renders in WorkspaceDiffPane.
 *
 * Footer actions:
 * - Copy  — copies content to clipboard
 * - Open in Editor (VS Code only) — re-opens the content in a VS Code text document
 * - Download (browser only) — triggers a browser file download
 */
export const ContentPreviewModal: React.FC = () => {
  const modal = useUiStore((s) => s.contentPreviewModal);
  const setContentPreviewModal = useUiStore((s) => s.setContentPreviewModal);
  // A reference chip in the workspace file editor opens previews from inside
  // the full-screen viewer, so the modal must sit above it while it is open.
  const workspaceViewerOpen = useWorkspaceViewerStore((s) => s.isOpen);
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
      const ext =
        modal.language === CONTENT_PREVIEW_LANGUAGES.DIFF
          ? ".diff"
          : modal.language === CONTENT_PREVIEW_LANGUAGES.JSON
            ? ".json"
            : ".xml";
      const filename = `ctrlyoke-${modal.ref.replace(/[^a-z0-9_]/gi, "-").toLowerCase()}${ext}`;
      downloadTextFile(filename, modal.content);
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
      elevated={workspaceViewerOpen}
      footer={
        <>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm transition-colors ${
              copied
                ? "text-indicator-success"
                : "text-description-fg hover:text-foreground"
            }`}
            onClick={handleCopy}
            title="Copy to clipboard"
          >
            <Icon name={copied ? "codicon-check" : "codicon-copy"} />
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-btn-bg text-btn-fg hover:bg-btn-hover rounded-sm transition-colors"
            onClick={handleExport}
            title={isStandalone ? "Download as file" : "Open in VS Code editor"}
          >
            {isStandalone ? (
              <>
                <Icon name="cloud-download" />
                Download
              </>
            ) : (
              <>
                <Icon name="go-to-file" />
                Open in Editor
              </>
            )}
          </button>
        </>
      }
    >
      {/* Prose-heavy previews (prior-context XML) wrap so text joined onto the
          end of a long line stays visible; diffs keep their column layout. */}
      <pre
        className={`font-mono text-xs leading-relaxed text-editor-fg overflow-x-auto ${
          modal.language === CONTENT_PREVIEW_LANGUAGES.DIFF
            ? "whitespace-pre"
            : "whitespace-pre-wrap wrap-break-word"
        }`}
      >
        {modal.content}
      </pre>
    </Modal>
  );
};
