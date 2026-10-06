import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { ExpandCollapseAllDiffsButton } from "@components/shared";
import {
  DiffFileList,
  type DiffFileGroup,
  type DiffFileListHandle,
  fromDiffKind,
  OpenFileButton,
} from "@components/diff";
import { DiffFileHistoryList } from "@components/diff/DiffFileHistoryList";
import { DiffRefDiffList } from "@components/diff/DiffRefDiffList";
import { usePagedGitRefDiff } from "@hooks/usePagedGitRefDiff";
import { downloadTextFile } from "@utils/download";
import { workspaceGitRefDiff } from "@utils/hostedApi";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";
import type { DiffFileCardProps } from "@components/diff/DiffFileCard";
import {
  mergeNonTextDiffEntries,
  type ParsedDiffFile,
} from "@utils/rdvAdapter";
import { Icon } from "../shared/Icon";

export const WorkspaceDiffPane: React.FC = () => {
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const diffOldContent = useWorkspaceViewerStore((s) => s.diffOldContent);
  const diffNewContent = useWorkspaceViewerStore((s) => s.diffNewContent);
  const diffLanguage = useWorkspaceViewerStore((s) => s.diffLanguage);
  const diffLoading = useWorkspaceViewerStore((s) => s.diffLoading);
  const diffFiles = useWorkspaceViewerStore((s) => s.diffFiles);
  const diffNonTextEntries = useWorkspaceViewerStore(
    (s) => s.diffNonTextEntries
  );
  const diffRefLabel = useWorkspaceViewerStore((s) => s.diffRefLabel);
  const diffCommitInfo = useWorkspaceViewerStore((s) => s.diffCommitInfo);
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const diffRefLoading = useWorkspaceViewerStore((s) => s.diffRefLoading);
  const diffRef = useWorkspaceViewerStore((s) => s.diffRef);
  const diffKind = useWorkspaceViewerStore((s) => s.diffKind);
  const diffPayloadKind = useWorkspaceViewerStore((s) => s.diffPayloadKind);
  const diffImage = useWorkspaceViewerStore((s) => s.diffImage);
  const fileHistoryPath = useWorkspaceViewerStore((s) => s.fileHistoryPath);
  const fileHistoryRepoId = useWorkspaceViewerStore((s) => s.fileHistoryRepoId);
  const fileHistoryActive = useWorkspaceViewerStore((s) => s.fileHistoryActive);
  const closeFileHistoryView = useWorkspaceViewerStore(
    (s) => s.closeFileHistoryView
  );
  const setMobileDiffVisible = useWorkspaceViewerStore(
    (s) => s.setMobileDiffVisible
  );

  const [downloading, setDownloading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const diffFileListRef = useRef<DiffFileListHandle>(null);
  const [commitDiffsCollapsed, setCommitDiffsCollapsed] = useState(false);
  const [commitDiffResetVersion, setCommitDiffResetVersion] = useState(0);
  const [commitDetailsExpanded, setCommitDetailsExpanded] = useState(false);

  const visibleFiles = useMemo(
    () => mergeNonTextDiffEntries(diffFiles ?? [], diffNonTextEntries),
    [diffFiles, diffNonTextEntries]
  );

  const sourceForParsedFile = useCallback(
    (file: ParsedDiffFile): DiffFileCardProps["source"] => {
      switch (file.payloadKind) {
        case DIFF_PAYLOAD_KINDS.IMAGE:
          return { kind: "image", image: file.image ?? {} };
        case DIFF_PAYLOAD_KINDS.BINARY:
          return { kind: "binary" };
        case DIFF_PAYLOAD_KINDS.TOO_LARGE:
          return { kind: DIFF_PAYLOAD_KINDS.TOO_LARGE };
        default:
          return {
            kind: "hunks",
            hunks: file.hunks,
            diffType: file.diffType,
          };
      }
    },
    []
  );

  const commitGroups = useMemo<DiffFileGroup[]>(
    () => [
      {
        key: "workspace-commit",
        files: visibleFiles.map((file) => ({
          key: file.path,
          path: file.path,
          oldPath: file.oldPath,
          changeType: file.changeType,
          language: file.language,
          source: sourceForParsedFile(file),
          headerActions: <OpenFileButton path={file.path} />,
        })),
      },
    ],
    [sourceForParsedFile, visibleFiles]
  );

  const pagedGitRefDiff = usePagedGitRefDiff({
    ref: diffRef ?? "",
    repo: selectedRepoId ?? undefined,
    enabled: diffRef !== null,
  });

  const sourceForSingleFile = useMemo((): DiffFileCardProps["source"] => {
    switch (diffPayloadKind) {
      case DIFF_PAYLOAD_KINDS.IMAGE:
        return { kind: "image", image: diffImage ?? {} };
      case DIFF_PAYLOAD_KINDS.BINARY:
        return { kind: "binary" };
      case DIFF_PAYLOAD_KINDS.TOO_LARGE:
        return { kind: DIFF_PAYLOAD_KINDS.TOO_LARGE };
      default:
        return {
          kind: "content",
          oldContent: diffOldContent,
          newContent: diffNewContent,
        };
    }
  }, [diffImage, diffNewContent, diffOldContent, diffPayloadKind]);
  const singleFileGroups = useMemo<DiffFileGroup[]>(
    () =>
      selectedDiffPath
        ? [
            {
              key: "workspace-working-tree",
              files: [
                {
                  key: selectedDiffPath,
                  path: selectedDiffPath,
                  changeType: fromDiffKind(diffKind ?? "modified"),
                  language: diffLanguage,
                  source: sourceForSingleFile,
                  headerActions: <OpenFileButton path={selectedDiffPath} />,
                },
              ],
            },
          ]
        : [],
    [diffKind, diffLanguage, selectedDiffPath, sourceForSingleFile]
  );

  useEffect(() => {
    setCommitDetailsExpanded(false);
  }, [diffRef, diffRefLabel]);

  const handleExpandAllDiffs = useCallback(() => {
    diffFileListRef.current?.prepareGlobalLayoutChange();
    setCommitDiffsCollapsed(false);
    setCommitDiffResetVersion((version) => version + 1);
  }, []);

  const handleCollapseAllDiffs = useCallback(() => {
    diffFileListRef.current?.prepareGlobalLayoutChange();
    setCommitDiffsCollapsed(true);
    setCommitDiffResetVersion((version) => version + 1);
  }, []);

  const handleDownload = useCallback(async () => {
    const refLabel = diffRef ? pagedGitRefDiff.refLabel : diffRefLabel;
    const activeCommitInfo = diffRef
      ? pagedGitRefDiff.commitInfo
      : diffCommitInfo;
    if (!refLabel) return;
    setDownloading(true);
    try {
      // Re-fetch the raw unified diff text for the download
      // Reconstruct the ref from the label to avoid storing it separately
      // We already have the unified diff from the current diffFiles parse, but
      // we need the raw text. Re-fetch from the same endpoint.
      let ref: string;
      if (refLabel === "Working Tree Changes") ref = "~diff";
      else if (refLabel === "Staged Changes") ref = "~staged";
      else if (refLabel.startsWith("Stash #"))
        ref = `~stash:${refLabel.slice("Stash #".length)}`;
      else {
        // "Commit abc1234" — the ref-diff response carries the full hash, so
        // downloads remain correct even when that commit is outside the
        // virtualized history window.
        const shortHash = refLabel.replace("Commit ", "");
        const fullHash = activeCommitInfo?.hash ?? shortHash;
        ref = `~${fullHash}`;
      }
      const { unifiedDiff } = await workspaceGitRefDiff(
        ref,
        selectedRepoId ?? undefined
      );
      const safeName = refLabel.replace(/[^a-z0-9_]/gi, "-").toLowerCase();
      downloadTextFile(`ctrlyoke-${safeName}.diff`, unifiedDiff);
    } catch {
      // ignore download errors
    } finally {
      setDownloading(false);
    }
  }, [
    diffCommitInfo,
    diffRef,
    diffRefLabel,
    pagedGitRefDiff.commitInfo,
    pagedGitRefDiff.refLabel,
    selectedRepoId,
  ]);

  const handleFileHistoryBack = useCallback(() => {
    closeFileHistoryView();
    setMobileDiffVisible(false);
  }, [closeFileHistoryView, setMobileDiffVisible]);

  if (fileHistoryActive && fileHistoryPath) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-panel-border shrink-0">
          <button
            type="button"
            onClick={handleFileHistoryBack}
            className="flex items-center gap-1 text-xs text-editor-fg hover:opacity-80 transition-opacity"
            aria-label="Back to source control files"
          >
            <Icon name="arrow-left" className="text-sm" />
            <span>Back</span>
          </button>
          <span className="truncate text-xs font-semibold text-editor-fg">
            File History: {fileHistoryPath}
          </span>
        </div>
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto px-3 py-2"
        >
          <DiffFileHistoryList
            path={fileHistoryPath}
            repo={fileHistoryRepoId ?? undefined}
            scrollContainerRef={scrollContainerRef}
          />
        </div>
      </div>
    );
  }

  // ── Multi-file git-ref diff mode ──────────────────────────────────────────

  if (diffRef !== null && pagedGitRefDiff.initialLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-editor-fg opacity-50">
        <Icon name="loading" className="animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  if (diffRef !== null) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Ref header banner */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-panel-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              name="git-commit"
              className="shrink-0 text-sm text-editor-fg opacity-60"
            />
            <span className="text-xs font-semibold text-editor-fg truncate">
              {pagedGitRefDiff.refLabel}
            </span>
            <span className="text-xs text-editor-fg opacity-40 shrink-0">
              {pagedGitRefDiff.totalCount === 1
                ? "1 file"
                : `${pagedGitRefDiff.totalCount} files`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pagedGitRefDiff.totalCount > 0 && (
              <ExpandCollapseAllDiffsButton
                anyDiffCollapsed={commitDiffsCollapsed}
                onExpand={handleExpandAllDiffs}
                onCollapse={handleCollapseAllDiffs}
              />
            )}
            <button
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="flex items-center gap-1 text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
              title="Download as .diff file"
            >
              <Icon
                name={downloading ? "loading" : "cloud-download"}
                className={downloading ? "animate-spin" : undefined}
              />
              Download
            </button>
          </div>
        </div>

        {/* Commit details (collapsible) */}
        {pagedGitRefDiff.commitInfo && (
          <div className="border-b border-panel-border shrink-0">
            <button
              onClick={() => setCommitDetailsExpanded((v) => !v)}
              aria-label="Toggle commit details"
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-editor-fg hover:bg-list-hover-bg transition-colors"
              title={
                commitDetailsExpanded
                  ? "Hide commit details"
                  : "Show commit details"
              }
            >
              <Icon
                name="chevron-right"
                className={`text-xs shrink-0 transition-transform duration-150 ${commitDetailsExpanded ? "rotate-90" : ""}`}
              />
              <span className="truncate font-medium">
                {pagedGitRefDiff.commitInfo.subject}
              </span>
            </button>
            {commitDetailsExpanded && (
              <div className="px-3 pb-2 pl-7 text-xs text-editor-fg">
                {pagedGitRefDiff.commitInfo.body && (
                  <p className="whitespace-pre-wrap opacity-80 mb-2">
                    {pagedGitRefDiff.commitInfo.body}
                  </p>
                )}
                <div className="opacity-50 font-mono text-xxs space-y-0.5">
                  <div>
                    {pagedGitRefDiff.commitInfo.author} &lt;
                    {pagedGitRefDiff.commitInfo.authorEmail}
                    &gt;
                  </div>
                  <div>
                    {pagedGitRefDiff.commitInfo.date} (
                    {pagedGitRefDiff.commitInfo.relativeDate})
                  </div>
                  <div>{pagedGitRefDiff.commitInfo.hash}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* File list */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto px-3 py-2"
        >
          <DiffRefDiffList
            ref={diffFileListRef}
            gitRef={diffRef}
            repo={selectedRepoId ?? undefined}
            controller={pagedGitRefDiff}
            command={{
              version: commitDiffResetVersion,
              collapsed: commitDiffsCollapsed,
            }}
            scrollContainerRef={scrollContainerRef}
          />
        </div>
      </div>
    );
  }

  if (diffRefLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-editor-fg opacity-50">
        <Icon name="loading" className="animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  if (diffFiles !== null) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Ref header banner */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-panel-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              name="git-commit"
              className="shrink-0 text-sm text-editor-fg opacity-60"
            />
            <span className="text-xs font-semibold text-editor-fg truncate">
              {diffRefLabel}
            </span>
            <span className="text-xs text-editor-fg opacity-40 shrink-0">
              {visibleFiles.length === 1
                ? "1 file"
                : `${visibleFiles.length} files`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {visibleFiles.length > 0 && (
              <ExpandCollapseAllDiffsButton
                anyDiffCollapsed={commitDiffsCollapsed}
                onExpand={handleExpandAllDiffs}
                onCollapse={handleCollapseAllDiffs}
              />
            )}
            <button
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="flex items-center gap-1 text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
              title="Download as .diff file"
            >
              <Icon
                name={downloading ? "loading" : "cloud-download"}
                className={downloading ? "animate-spin" : undefined}
              />
              Download
            </button>
          </div>
        </div>

        {/* Commit details (collapsible) */}
        {diffCommitInfo && (
          <div className="border-b border-panel-border shrink-0">
            <button
              onClick={() => setCommitDetailsExpanded((v) => !v)}
              aria-label="Toggle commit details"
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-editor-fg hover:bg-list-hover-bg transition-colors"
              title={
                commitDetailsExpanded
                  ? "Hide commit details"
                  : "Show commit details"
              }
            >
              <Icon
                name="chevron-right"
                className={`text-xs shrink-0 transition-transform duration-150 ${commitDetailsExpanded ? "rotate-90" : ""}`}
              />
              <span className="truncate font-medium">
                {diffCommitInfo.subject}
              </span>
            </button>
            {commitDetailsExpanded && (
              <div className="px-3 pb-2 pl-7 text-xs text-editor-fg">
                {diffCommitInfo.body && (
                  <p className="whitespace-pre-wrap opacity-80 mb-2">
                    {diffCommitInfo.body}
                  </p>
                )}
                <div className="opacity-50 font-mono text-xxs space-y-0.5">
                  <div>
                    {diffCommitInfo.author} &lt;{diffCommitInfo.authorEmail}
                    &gt;
                  </div>
                  <div>
                    {diffCommitInfo.date} ({diffCommitInfo.relativeDate})
                  </div>
                  <div>{diffCommitInfo.hash}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* File list */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto px-3 py-2"
        >
          <DiffFileList
            ref={diffFileListRef}
            groups={commitGroups}
            emptyMessage="No text changes to display"
            command={{
              version: commitDiffResetVersion,
              collapsed: commitDiffsCollapsed,
            }}
            scrollContainerRef={scrollContainerRef}
          />
        </div>
      </div>
    );
  }

  // ── Single-file working-tree diff mode (existing) ─────────────────────────

  if (!selectedDiffPath) {
    return (
      <div className="flex items-center justify-center h-full text-editor-fg opacity-40 select-none">
        <p className="text-sm">Select a file to see its diff</p>
      </div>
    );
  }

  if (diffLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-editor-fg opacity-50">
        <Icon name="loading" className="animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="h-full overflow-auto px-3 py-2">
      <DiffFileList
        ref={diffFileListRef}
        groups={singleFileGroups}
        emptyMessage="No text changes to display"
        command={{
          version: commitDiffResetVersion,
          collapsed: commitDiffsCollapsed,
        }}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
};
