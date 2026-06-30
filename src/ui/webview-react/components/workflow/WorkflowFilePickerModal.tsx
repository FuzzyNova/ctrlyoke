import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@components/shared/Button";
import { Modal } from "@components/shared/Modal";
import { hostedFetch } from "@utils/hostedApi";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import type { WorkflowFileEntry } from "@root/utils/WorkflowFileDiscovery";

interface WorkflowFilesResponse {
  files?: WorkflowFileEntry[];
  isGitRepo?: boolean;
}

const WORKFLOW_PATH_PLACEHOLDER = "path/to/workflow.ctrlyoke.yaml";

function normalizeWorkflowPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/");
}

interface WorkflowFilePickerModalProps {
  isOpen: boolean;
  title: string;
  actionLabel: string;
  onClose: () => void;
  onSelect: (filePath: string) => void;
}

export const WorkflowFilePickerModal: React.FC<
  WorkflowFilePickerModalProps
> = ({ isOpen, title, actionLabel, onClose, onSelect }) => {
  const [files, setFiles] = useState<WorkflowFileEntry[]>([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hideGitIgnoredFiles = useSettingsStore(
    (s) => s.globalSettings.hideGitIgnoredFiles
  );
  const hideGitIgnoredFilesScope = useSettingsStore((s) =>
    s.globalSettings.settingSources["ui.hideGitIgnoredFiles"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const vscode = useVsCodeApi();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    hostedFetch<WorkflowFilesResponse>("/api/workflow-files")
      .then((data) => {
        if (cancelled) {
          return;
        }
        const nextFiles = (data.files ?? []).map((file) => ({
          ...file,
          path: normalizeWorkflowPath(file.path),
          relativePath: normalizeWorkflowPath(file.relativePath),
        }));
        setFiles(nextFiles);
        setIsGitRepo(data.isGitRepo ?? false);
        setSelectedPath(nextFiles[0]?.path ?? "");
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setFiles([]);
        setIsGitRepo(false);
        setSelectedPath("");
        setError(err instanceof Error ? err.message : "Could not load files");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return files.filter((file) => {
      if (hideGitIgnoredFiles && file.gitIgnored) return false;
      if (
        normalizedQuery &&
        !file.relativePath.toLowerCase().includes(normalizedQuery)
      )
        return false;
      return true;
    });
  }, [files, query, hideGitIgnoredFiles]);

  const chosenPath = normalizeWorkflowPath(manualPath || selectedPath);

  const handleSubmit = () => {
    if (!chosenPath) {
      return;
    }
    onSelect(chosenPath);
    onClose();
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={handleSubmit} disabled={!chosenPath}>
        {actionLabel}
      </Button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={footer}
      size="lg"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="workflow-file-search"
              className="text-sm font-medium text-foreground"
            >
              Search workspace files
            </label>
            {isGitRepo && (
              <button
                type="button"
                onClick={() =>
                  vscode.postMessage({
                    type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
                    path: "ui.hideGitIgnoredFiles",
                    value: !hideGitIgnoredFiles,
                    scope: hideGitIgnoredFilesScope,
                  })
                }
                className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                  hideGitIgnoredFiles
                    ? "text-description-fg hover:bg-btn-secondary-hover"
                    : "text-foreground hover:bg-btn-secondary-hover"
                }`}
                title={
                  hideGitIgnoredFiles
                    ? "Show git-ignored files"
                    : "Hide git-ignored files"
                }
              >
                <i
                  className={`codicon ${hideGitIgnoredFiles ? "codicon-eye-closed" : "codicon-eye"} text-xs`}
                />
                <span>git-ignored</span>
              </button>
            )}
          </div>
          <input
            id="workflow-file-search"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="workflow, prompt, .ctrlyoke"
            className="w-full rounded border border-input-border bg-input-bg px-3 py-2 text-input-fg placeholder:text-input-placeholder focus:outline-none focus:ring-1 focus:ring-focus-border"
          />
        </div>

        <div className="h-64 overflow-y-auto rounded border border-panel-border">
          {isLoading && (
            <div className="px-3 py-2 text-sm text-description-fg">
              Loading files...
            </div>
          )}
          {!isLoading && error && (
            <div className="px-3 py-2 text-sm text-warning-fg">
              File list unavailable. Enter a workspace path below.
            </div>
          )}
          {!isLoading && !error && filteredFiles.length === 0 && (
            <div className="px-3 py-2 text-sm text-description-fg">
              No workflow files found.
            </div>
          )}
          {!isLoading &&
            filteredFiles.map((file) => (
              <button
                type="button"
                key={file.path}
                onClick={() => {
                  setSelectedPath(file.path);
                  setManualPath("");
                }}
                className={`block w-full border-0 px-3 py-2 text-left text-sm ${
                  selectedPath === file.path && !manualPath
                    ? "bg-list-active-bg text-list-active-fg"
                    : "bg-transparent text-foreground hover:bg-list-hover-bg hover:text-list-hover-fg"
                }`}
              >
                <span className="block truncate">{file.relativePath}</span>
              </button>
            ))}
        </div>

        <label className="block text-sm font-medium text-foreground">
          Or enter a path
          <input
            type="text"
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            placeholder={WORKFLOW_PATH_PLACEHOLDER}
            className="mt-2 w-full rounded border border-input-border bg-input-bg px-3 py-2 text-input-fg placeholder:text-input-placeholder focus:outline-none focus:ring-1 focus:ring-focus-border"
          />
        </label>
      </div>
    </Modal>
  );
};
