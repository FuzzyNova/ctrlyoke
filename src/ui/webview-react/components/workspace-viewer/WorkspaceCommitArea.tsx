import React, { useCallback } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceCommit,
  workspacePush,
  workspacePull,
  workspaceStage,
  workspaceGenerateCommitMessage,
} from "@utils/hostedApi";

interface WorkspaceCommitAreaProps {
  incomingCommitCount: number;
  onRefresh: () => Promise<unknown>;
  outgoingCommitCount: number;
}

function formatSyncActionLabel(baseLabel: string, count: number): string {
  return count > 0 ? `${baseLabel} (${count})` : baseLabel;
}

export const WorkspaceCommitArea: React.FC<WorkspaceCommitAreaProps> = ({
  incomingCommitCount,
  onRefresh,
  outgoingCommitCount,
}) => {
  const commitMessage = useWorkspaceViewerStore((s) => s.commitMessage);
  const committing = useWorkspaceViewerStore((s) => s.committing);
  const generatingCommitMessage = useWorkspaceViewerStore(
    (s) => s.generatingCommitMessage
  );
  const pushing = useWorkspaceViewerStore((s) => s.pushing);
  const pulling = useWorkspaceViewerStore((s) => s.pulling);
  const scmError = useWorkspaceViewerStore((s) => s.scmError);
  const sourceControlFiles = useWorkspaceViewerStore(
    (s) => s.sourceControlFiles
  );
  const setCommitMessage = useWorkspaceViewerStore((s) => s.setCommitMessage);
  const setCommitting = useWorkspaceViewerStore((s) => s.setCommitting);
  const setGeneratingCommitMessage = useWorkspaceViewerStore(
    (s) => s.setGeneratingCommitMessage
  );
  const setPushing = useWorkspaceViewerStore((s) => s.setPushing);
  const setPulling = useWorkspaceViewerStore((s) => s.setPulling);
  const setScmError = useWorkspaceViewerStore((s) => s.setScmError);
  const clearDiff = useWorkspaceViewerStore((s) => s.clearDiff);

  const handleGenerate = useCallback(async () => {
    if (generatingCommitMessage) return;
    setGeneratingCommitMessage(true);
    setScmError(null);
    try {
      const result = await workspaceGenerateCommitMessage();
      setCommitMessage(result.message);
      if (!result.staged) {
        setScmError(
          "Generated from unstaged changes. Stage files for a more accurate message."
        );
      }
    } catch (err) {
      setScmError(String(err));
    } finally {
      setGeneratingCommitMessage(false);
    }
  }, [
    generatingCommitMessage,
    setGeneratingCommitMessage,
    setCommitMessage,
    setScmError,
  ]);

  const handleCommit = useCallback(async () => {
    if (commitMessage.trim() === "" || committing) return;
    setCommitting(true);
    setScmError(null);
    try {
      const staged = sourceControlFiles.filter((f) => f.stagedStatus !== null);
      const changed = sourceControlFiles.filter(
        (f) => f.unstagedStatus !== null
      );
      if (staged.length === 0 && changed.length > 0) {
        for (const file of changed) {
          await workspaceStage({ path: file.path });
        }
      }
      await workspaceCommit({ message: commitMessage });
      setCommitMessage("");
      clearDiff();
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setCommitting(false);
    }
  }, [
    commitMessage,
    committing,
    sourceControlFiles,
    setCommitting,
    setScmError,
    setCommitMessage,
    clearDiff,
    onRefresh,
  ]);

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
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={handlePush}
          disabled={pushing}
          className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-secondary-bg px-2 py-1 text-xs text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:opacity-50"
        >
          {pushing ? (
            <i className="codicon codicon-loading animate-spin" />
          ) : (
            <i className="codicon codicon-cloud-upload" />
          )}
          {formatSyncActionLabel("Push", outgoingCommitCount)}
        </button>

        <button
          onClick={handlePull}
          disabled={pulling}
          className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-secondary-bg px-2 py-1 text-xs text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:opacity-50"
        >
          {pulling ? (
            <i className="codicon codicon-loading animate-spin" />
          ) : (
            <i className="codicon codicon-cloud-download" />
          )}
          {formatSyncActionLabel("Pull", incomingCommitCount)}
        </button>
      </div>

      <div className="flex gap-1 items-start">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message..."
          rows={3}
          className="flex-1 min-w-0 resize-none rounded border border-panel-border bg-input-bg text-editor-fg text-xs px-2 py-1.5 placeholder-editor-fg placeholder-opacity-40 focus:outline-none focus:border-focus-border"
        />
        <button
          onClick={handleGenerate}
          disabled={generatingCommitMessage}
          title="Generate commit message"
          className="flex-shrink-0 w-8 flex items-center justify-center self-stretch rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:opacity-50"
        >
          {generatingCommitMessage ? (
            <i className="codicon codicon-loading animate-spin" />
          ) : (
            <i className="codicon codicon-sparkle" />
          )}
        </button>
      </div>

      <button
        onClick={handleCommit}
        disabled={commitMessage.trim() === "" || committing}
        className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-bg px-3 py-1 text-xs text-btn-fg transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {committing ? (
          <i className="codicon codicon-loading animate-spin" />
        ) : (
          <i className="codicon codicon-check" />
        )}
        Commit
      </button>

      {scmError && <p className="mt-1 text-xs text-error-fg">{scmError}</p>}
    </div>
  );
};
