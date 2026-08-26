import { useCallback, useState } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";
import { useEditorStore } from "@store/editorStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceCheckoutCommit } from "@utils/hostedApi";
import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { buildGitReference } from "@root/completions/ContextReferenceBuilder";
import { PROMPT_EDITOR_INSERT_MODES, MESSAGE_TYPES } from "@/types/messages";
import { isStandalone } from "@hooks/useVsCodeApi";
import { Modal } from "@components/shared/Modal";
import { Button } from "@components/shared/Button";
import { sendMessage } from "@hooks/useMessageHandler";

interface UseCommitHistoryContextMenuOptions {
  onRefresh: () => void;
}

export function useCommitHistoryContextMenu({
  onRefresh,
}: UseCommitHistoryContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );
  const [pendingCheckout, setPendingCheckout] =
    useState<WorkspaceCommitLogEntry | null>(null);

  const detached = useWorkspaceViewerStore((s) => s.detached);

  const handleViewDiff = useCallback((commit: WorkspaceCommitLogEntry) => {
    if (isStandalone) {
      const store = useWorkspaceViewerStore.getState();
      void store.openToGitRef(`~${commit.hash}`);
      store.setMobileDiffVisible(true);
    } else {
      sendMessage(MESSAGE_TYPES.OPEN_GIT_CHANGE, { ref: `~${commit.hash}` });
    }
  }, []);

  const handleAddToCtrlYoke = useCallback((commit: WorkspaceCommitLogEntry) => {
    const editorStore = useEditorStore.getState();
    editorStore.preparePromptEditorForInsert();
    editorStore.enqueuePromptEditorInsert({
      requestId: `commit-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      references: [buildGitReference(commit.hash)],
      mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
    });
  }, []);

  const handleCheckoutCommit = useCallback(
    async (commit: WorkspaceCommitLogEntry) => {
      const store = useWorkspaceViewerStore.getState();
      const branchBeforeCheckout = store.currentBranch;
      try {
        await workspaceCheckoutCommit({
          hash: commit.hash,
          repo: store.selectedRepoId ?? undefined,
        });
        if (branchBeforeCheckout) {
          store.setPreviousBranch(branchBeforeCheckout);
        }
        // Optimistically mark detached so the immediate refresh below passes the
        // branch hint (detachedBranchHint requires `detached` to be true). The
        // store's `detached` flag otherwise only flips once the refreshed
        // response lands, which would be too late for this first request and
        // would hide the commits ahead of the checked-out point until a manual
        // refresh.
        store.setDetached(true);
        onRefresh();
      } catch {
        // errors surfaced via refresh
      }
    },
    [onRefresh]
  );

  const openContextMenu = useCallback(
    (x: number, y: number, commit: WorkspaceCommitLogEntry) => {
      const isAlreadyHead = commit.isHead && !detached;
      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Copy Hash",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              void navigator.clipboard.writeText(commit.hash);
            },
          },
          {
            label: "Copy Message",
            icon: "codicon-clippy",
            disabled: false,
            onClick: () => {
              void navigator.clipboard.writeText(commit.subject);
            },
          },
          { type: "divider" },
          {
            label: "View Diff",
            icon: "codicon-diff",
            disabled: false,
            onClick: () => handleViewDiff(commit),
          },
          {
            label: "Add Commit to ctrlyoke",
            icon: "codicon-add",
            disabled: false,
            onClick: () => handleAddToCtrlYoke(commit),
          },
          { type: "divider" },
          {
            label: "Checkout Commit (Detach HEAD)",
            icon: "codicon-git-commit",
            disabled: isAlreadyHead,
            disabledTitle: isAlreadyHead ? "Already at this commit" : undefined,
            onClick: () => setPendingCheckout(commit),
          },
        ],
      });
    },
    [detached, handleAddToCtrlYoke, handleViewDiff]
  );

  const handleConfirmCheckout = useCallback(() => {
    const commit = pendingCheckout;
    setPendingCheckout(null);
    if (commit) {
      void handleCheckoutCommit(commit);
    }
  }, [handleCheckoutCommit, pendingCheckout]);

  const commitHistoryContextMenuPortal = (
    <>
      {contextMenu && (
        <StepContextMenu
          {...contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
      <Modal
        isOpen={pendingCheckout !== null}
        onClose={() => setPendingCheckout(null)}
        elevated
        title="Checkout Commit?"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setPendingCheckout(null)}
            >
              Cancel
            </Button>
            <Button variant="danger" size="md" onClick={handleConfirmCheckout}>
              Checkout
            </Button>
          </>
        }
      >
        <p className="text-foreground">
          This will put the repository in a detached HEAD state at commit{" "}
          <span className="font-mono">{pendingCheckout?.shortHash}</span>.
        </p>
        <p className="mt-2 text-sm text-description-fg">
          You can return to your branch from the History panel banner.
        </p>
      </Modal>
    </>
  );

  return { openContextMenu, commitHistoryContextMenuPortal };
}
