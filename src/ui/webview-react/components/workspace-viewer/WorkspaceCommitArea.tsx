import React, { useCallback } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceCommit, workspacePush, workspacePull } from "@utils/hostedApi";

interface WorkspaceCommitAreaProps {
  onRefresh: () => void;
}

export const WorkspaceCommitArea: React.FC<WorkspaceCommitAreaProps> = ({
  onRefresh,
}) => {
  const commitMessage = useWorkspaceViewerStore((s) => s.commitMessage);
  const committing = useWorkspaceViewerStore((s) => s.committing);
  const pushing = useWorkspaceViewerStore((s) => s.pushing);
  const pulling = useWorkspaceViewerStore((s) => s.pulling);
  const scmError = useWorkspaceViewerStore((s) => s.scmError);
  const setCommitMessage = useWorkspaceViewerStore((s) => s.setCommitMessage);
  const setCommitting = useWorkspaceViewerStore((s) => s.setCommitting);
  const setPushing = useWorkspaceViewerStore((s) => s.setPushing);
  const setPulling = useWorkspaceViewerStore((s) => s.setPulling);
  const setScmError = useWorkspaceViewerStore((s) => s.setScmError);

  const handleCommit = useCallback(async () => {
    if (commitMessage.trim() === "" || committing) return;
    setCommitting(true);
    setScmError(null);
    try {
      await workspaceCommit({ message: commitMessage });
      setCommitMessage("");
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, committing, setCommitting, setScmError, setCommitMessage, onRefresh]);

  const handlePush = useCallback(async () => {
    if (pushing) return;
    setPushing(true);
    setScmError(null);
    try {
      await workspacePush();
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setPushing(false);
    }
  }, [pushing, setPushing, setScmError, onRefresh]);

  const handlePull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    setScmError(null);
    try {
      await workspacePull();
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setPulling(false);
    }
  }, [pulling, setPulling, setScmError, onRefresh]);

  return (
    <div className="flex flex-col gap-2 p-3 flex-shrink-0">
      <textarea
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        placeholder="Commit message..."
        rows={3}
        className="w-full resize-none rounded border border-[var(--panel-border)] bg-[var(--input-bg,var(--sidebar-bg))] text-[var(--editor-fg)] text-xs px-2 py-1.5 placeholder-[var(--editor-fg)] placeholder-opacity-40 focus:outline-none focus:border-[var(--focus-border)]"
      />

      <div className="flex items-center gap-2">
        <button
          onClick={handleCommit}
          disabled={commitMessage.trim() === "" || committing}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded border border-[var(--btn-border)] bg-[var(--btn-bg)] text-[var(--btn-fg)] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {committing ? (
            <i className="codicon codicon-loading animate-spin" />
          ) : (
            <i className="codicon codicon-check" />
          )}
          Commit
        </button>

        <div role="group" className="flex overflow-hidden rounded border border-[var(--btn-border)]">
          <button
            onClick={handlePush}
            disabled={pushing}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--btn-secondary-bg)] text-[var(--btn-secondary-fg)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50 border-r border-[var(--btn-border)]"
          >
            {pushing ? (
              <i className="codicon codicon-loading animate-spin" />
            ) : (
              <i className="codicon codicon-cloud-upload" />
            )}
            Push
          </button>
          <button
            onClick={handlePull}
            disabled={pulling}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--btn-secondary-bg)] text-[var(--btn-secondary-fg)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50"
          >
            {pulling ? (
              <i className="codicon codicon-loading animate-spin" />
            ) : (
              <i className="codicon codicon-cloud-download" />
            )}
            Pull
          </button>
        </div>
      </div>

      {scmError && (
        <p className="text-xs text-[var(--status-error)] mt-1">{scmError}</p>
      )}
    </div>
  );
};
