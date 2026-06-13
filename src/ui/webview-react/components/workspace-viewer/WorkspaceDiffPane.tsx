import React, { useCallback, useState } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { DiffView } from "@components/output/DiffView";
import type { ParsedDiffFile } from "@utils/rdvAdapter";
import { downloadTextFile } from "@utils/diff";
import { workspaceGitRefDiff } from "@utils/hostedApi";

function FileHeader({ file }: { file: ParsedDiffFile }) {
  const displayPath =
    file.oldPath && file.oldPath !== file.path
      ? `${file.oldPath} → ${file.path}`
      : file.path;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-editor-bg border-b border-panel-border text-xs font-mono text-editor-fg opacity-80 sticky top-0 z-10">
      <i className="codicon codicon-file-diff flex-shrink-0" />
      <span className="truncate">{displayPath}</span>
    </div>
  );
}

export const WorkspaceDiffPane: React.FC = () => {
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const diffOldContent = useWorkspaceViewerStore((s) => s.diffOldContent);
  const diffNewContent = useWorkspaceViewerStore((s) => s.diffNewContent);
  const diffLanguage = useWorkspaceViewerStore((s) => s.diffLanguage);
  const diffLoading = useWorkspaceViewerStore((s) => s.diffLoading);
  const diffFiles = useWorkspaceViewerStore((s) => s.diffFiles);
  const diffRefLabel = useWorkspaceViewerStore((s) => s.diffRefLabel);
  const diffRefLoading = useWorkspaceViewerStore((s) => s.diffRefLoading);
  const clearDiff = useWorkspaceViewerStore((s) => s.clearDiff);

  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!diffRefLabel) return;
    setDownloading(true);
    try {
      // Re-fetch the raw unified diff text for the download
      const store = useWorkspaceViewerStore.getState();
      // Reconstruct the ref from the label to avoid storing it separately
      // We already have the unified diff from the current diffFiles parse, but
      // we need the raw text. Re-fetch from the same endpoint.
      const refLabel = diffRefLabel;
      let ref: string;
      if (refLabel === "Working Tree Changes") ref = "~diff";
      else if (refLabel === "Staged Changes") ref = "~staged";
      else if (refLabel.startsWith("Stash #"))
        ref = `~stash:${refLabel.slice("Stash #".length)}`;
      else {
        // "Commit abc1234" — we only have the short hash label
        // find the full hash from the commit history if available
        const shortHash = refLabel.replace("Commit ", "");
        const fullHash = store.commitHistory.find(
          (c) => c.shortHash === shortHash || c.hash.startsWith(shortHash)
        )?.hash ?? shortHash;
        ref = `~${fullHash}`;
      }
      const { unifiedDiff } = await workspaceGitRefDiff(ref);
      const safeName = refLabel.replace(/[^a-z0-9_]/gi, "-").toLowerCase();
      downloadTextFile(`flightpath-${safeName}.diff`, unifiedDiff);
    } catch {
      // ignore download errors
    } finally {
      setDownloading(false);
    }
  }, [diffRefLabel]);

  // ── Multi-file git-ref diff mode ──────────────────────────────────────────

  if (diffRefLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-editor-fg opacity-50">
        <i className="codicon codicon-loading animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  if (diffFiles !== null) {
    const visibleFiles = diffFiles.filter((f) => f.hunks.length > 0);
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Ref header banner */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-panel-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <i className="codicon codicon-git-commit flex-shrink-0 text-sm text-editor-fg opacity-60" />
            <span className="text-xs font-semibold text-editor-fg truncate">
              {diffRefLabel}
            </span>
            <span className="text-xs text-editor-fg opacity-40 flex-shrink-0">
              {visibleFiles.length === 1
                ? "1 file"
                : `${visibleFiles.length} files`}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="flex items-center gap-1 text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
              title="Download as .diff file"
            >
              <i
                className={`codicon ${downloading ? "codicon-loading animate-spin" : "codicon-cloud-download"}`}
              />
              Download
            </button>
            <button
              onClick={clearDiff}
              className="codicon codicon-close text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity"
              title="Close diff"
              aria-label="Close diff"
            />
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-auto px-3 py-2">
          {visibleFiles.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-editor-fg opacity-40 select-none">
              <p className="text-sm">No text changes to display</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {visibleFiles.map((file) => (
                <div
                  key={file.path}
                  className="border border-panel-border rounded overflow-hidden"
                >
                  <FileHeader file={file} />
                  <DiffView
                    oldContent=""
                    newContent=""
                    language={file.language}
                    globallyCollapsed={false}
                    hunks={file.hunks}
                    diffType={file.diffType}
                  />
                </div>
              ))}
            </div>
          )}
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
        <i className="codicon codicon-loading animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-3 py-2">
      <DiffView
        oldContent={diffOldContent}
        newContent={diffNewContent}
        language={diffLanguage}
        globallyCollapsed={false}
      />
    </div>
  );
};
