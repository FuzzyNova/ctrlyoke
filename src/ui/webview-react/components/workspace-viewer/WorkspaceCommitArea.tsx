import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceCommit,
  workspacePush,
  workspacePull,
  workspaceStage,
  workspaceGenerateCommitMessage,
} from "@utils/hostedApi";
import { Icon } from "../shared/Icon";

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
  const repos = useWorkspaceViewerStore((s) => s.repos);
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const setSelectedRepoId = useWorkspaceViewerStore((s) => s.setSelectedRepoId);
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

  const generateAbortControllerRef = useRef<AbortController | null>(null);
  const [generationDotCount, setGenerationDotCount] = useState(0);

  useEffect(() => {
    if (!generatingCommitMessage) {
      setGenerationDotCount(0);
      return;
    }

    const interval = window.setInterval(() => {
      setGenerationDotCount((count) => (count + 1) % 4);
    }, 500);

    return () => window.clearInterval(interval);
  }, [generatingCommitMessage]);

  const handleGenerate = useCallback(async () => {
    if (generatingCommitMessage) return;
    const abortController = new AbortController();
    generateAbortControllerRef.current = abortController;
    setGeneratingCommitMessage(true);
    setScmError(null);
    try {
      const result = await workspaceGenerateCommitMessage(
        commitMessage.trim() || undefined,
        abortController.signal,
        selectedRepoId ?? undefined
      );
      setCommitMessage(result.message);
      if (!result.staged) {
        setScmError(
          "Generated from unstaged changes. Stage files for a more accurate message."
        );
      }
    } catch (err) {
      if (abortController.signal.aborted) return;
      setScmError(String(err));
    } finally {
      generateAbortControllerRef.current = null;
      setGeneratingCommitMessage(false);
    }
  }, [
    commitMessage,
    generatingCommitMessage,
    selectedRepoId,
    setGeneratingCommitMessage,
    setCommitMessage,
    setScmError,
  ]);

  const handleCancelGenerate = useCallback(() => {
    generateAbortControllerRef.current?.abort();
  }, []);

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
      await workspaceCommit({
        message: commitMessage,
        repo: selectedRepoId ?? undefined,
      });
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
    selectedRepoId,
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
      await workspacePush(selectedRepoId ?? undefined);
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setPushing(false);
    }
  }, [pushing, selectedRepoId, setPushing, setScmError, onRefresh]);

  const handlePull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    setScmError(null);
    try {
      await workspacePull(selectedRepoId ?? undefined);
      await onRefresh();
    } catch (err) {
      setScmError(String(err));
    } finally {
      setPulling(false);
    }
  }, [pulling, selectedRepoId, setPulling, setScmError, onRefresh]);

  return (
    <div className="flex flex-col gap-2 p-3 flex-shrink-0">
      {repos.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xxs font-semibold uppercase tracking-wide text-editor-fg opacity-50">
            Repository
          </span>
          <div className="relative">
            <Icon
              name="repo"
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60"
            />
            <select
              value={selectedRepoId ?? ""}
              onChange={(e) => setSelectedRepoId(e.target.value || null)}
              aria-label="Select repository"
              className="w-full appearance-none rounded border border-panel-border bg-input-bg pl-7 pr-7 py-1 text-xs text-editor-fg focus:outline-none focus:border-focus-border"
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.label}
                </option>
              ))}
            </select>
            <Icon
              name="chevron-down"
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60"
            />
          </div>
        </label>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={handlePush}
          disabled={pushing}
          aria-label="Push commits"
          className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-secondary-bg px-2 py-1 text-xs text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:opacity-50"
        >
          {pushing ? (
            <Icon name="loading" className="animate-spin" />
          ) : (
            <Icon name="cloud-upload" />
          )}
          {formatSyncActionLabel("Push", outgoingCommitCount)}
        </button>

        <button
          onClick={handlePull}
          disabled={pulling}
          aria-label="Pull commits"
          className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-secondary-bg px-2 py-1 text-xs text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:opacity-50"
        >
          {pulling ? (
            <Icon name="loading" className="animate-spin" />
          ) : (
            <Icon name="cloud-download" />
          )}
          {formatSyncActionLabel("Pull", incomingCommitCount)}
        </button>
      </div>

      <div className="flex gap-1 items-start">
        <div className="relative flex-1 min-w-0">
          <textarea
            value={generatingCommitMessage ? "" : commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={
              generatingCommitMessage
                ? `Generating commit message${".".repeat(generationDotCount)}`
                : "Commit message..."
            }
            rows={3}
            disabled={generatingCommitMessage}
            aria-label="Commit message"
            aria-describedby={
              generatingCommitMessage ? "commit-message-generating" : undefined
            }
            className="w-full resize-none rounded border border-panel-border bg-input-bg px-2 py-1.5 text-xs text-editor-fg placeholder-editor-fg placeholder-opacity-40 focus:outline-none focus:border-focus-border disabled:cursor-wait disabled:opacity-50"
          />
          {generatingCommitMessage && (
            <span
              id="commit-message-generating"
              className="sr-only"
              role="status"
            >
              Generating commit message. Editing is disabled until generation is
              finished or canceled.
            </span>
          )}
        </div>
        <button
          onClick={
            generatingCommitMessage ? handleCancelGenerate : handleGenerate
          }
          title={
            generatingCommitMessage
              ? "Cancel generation"
              : "Generate commit message with ctrlyoke"
          }
          aria-label={
            generatingCommitMessage
              ? "Cancel commit message generation"
              : "Generate commit message"
          }
          data-testid="generate-commit-message-btn"
          className="flex-shrink-0 w-8 flex items-center justify-center self-stretch rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover"
        >
          {generatingCommitMessage ? (
            <Icon name="stop-circle" />
          ) : (
            <i
              aria-hidden="true"
              className="custom-icon icon-generate-commit-message"
            />
          )}
        </button>
      </div>

      <button
        onClick={handleCommit}
        disabled={commitMessage.trim() === "" || committing}
        className="flex w-full items-center justify-center gap-1 rounded border border-btn-border bg-btn-bg px-3 py-1 text-xs text-btn-fg transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {committing ? (
          <Icon name="loading" className="animate-spin" />
        ) : (
          <Icon name="check" />
        )}
        Commit
      </button>

      {scmError && <p className="mt-1 text-xs text-error-fg">{scmError}</p>}
    </div>
  );
};
