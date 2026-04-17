import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@components/shared/Button";
import { Modal } from "@components/shared/Modal";

interface WorkflowFileEntry {
  path: string;
  relativePath: string;
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
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetch("/api/workflow-files")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        return response.json() as Promise<{ files?: WorkflowFileEntry[] }>;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const nextFiles = data.files ?? [];
        setFiles(nextFiles);
        setSelectedPath(nextFiles[0]?.path ?? "");
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setFiles([]);
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
    if (!normalizedQuery) {
      return files;
    }
    return files.filter((file) =>
      file.relativePath.toLowerCase().includes(normalizedQuery)
    );
  }, [files, query]);

  const chosenPath = manualPath.trim() || selectedPath;

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
        <label className="block text-sm font-medium text-foreground">
          Search workspace files
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="workflow, prompt, .flightpath"
            className="mt-2 w-full rounded border border-input-border bg-input-bg px-3 py-2 text-input-fg placeholder:text-input-placeholder focus:outline-none focus:ring-1 focus:ring-focus-border"
          />
        </label>

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
            placeholder="C:\\path\\to\\workflow.flightpath.yaml"
            className="mt-2 w-full rounded border border-input-border bg-input-bg px-3 py-2 text-input-fg placeholder:text-input-placeholder focus:outline-none focus:ring-1 focus:ring-focus-border"
          />
        </label>
      </div>
    </Modal>
  );
};
