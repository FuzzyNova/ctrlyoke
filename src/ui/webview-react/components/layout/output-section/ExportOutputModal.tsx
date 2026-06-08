import React from "react";
import { Modal } from "@components/shared";

interface ExportOutputModalProps {
  includeCommand: boolean;
  includeMetadata: boolean;
  isStandaloneMode: boolean;
  stepRange: string;
  stepRangeError: boolean;
  totalCliSteps: number;
  onClose: () => void;
  onConfirm: () => void;
  onIncludeCommandChange: (checked: boolean) => void;
  onIncludeMetadataChange: (checked: boolean) => void;
  onStepRangeChange: (value: string) => void;
}

export const ExportOutputModal: React.FC<ExportOutputModalProps> = ({
  includeCommand,
  includeMetadata,
  isStandaloneMode,
  stepRange,
  stepRangeError,
  totalCliSteps,
  onClose,
  onConfirm,
  onIncludeCommandChange,
  onIncludeMetadataChange,
  onStepRangeChange,
}) => (
  <Modal
    isOpen
    title="Export Output"
    onClose={onClose}
    size="sm"
    footer={
      <>
        <button
          type="button"
          className="px-4 py-2 text-sm text-description-fg hover:text-foreground transition-colors"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="px-4 py-2 text-sm bg-btn-bg text-btn-fg hover:bg-btn-hover rounded transition-colors"
          onClick={onConfirm}
        >
          {isStandaloneMode ? (
            <>
              <i className="codicon codicon-cloud-download mr-1" />
              Download
            </>
          ) : (
            <>
              <i className="codicon codicon-share mr-1" />
              Export
            </>
          )}
        </button>
      </>
    }
  >
    <div className="flex flex-col gap-4 py-1">
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          aria-label="Include CLI command"
          checked={includeCommand}
          onChange={(event) => onIncludeCommandChange(event.target.checked)}
          className="mt-0.5 accent-btn-bg"
        />
        <span className="text-sm">
          <span className="text-foreground font-medium">
            Include CLI command
          </span>
          <span className="block text-xs text-description-fg mt-0.5">
            When unchecked, the command run for each prompt step is omitted from
            the export.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          aria-label="Include metadata"
          checked={includeMetadata}
          onChange={(event) => onIncludeMetadataChange(event.target.checked)}
          className="mt-0.5 accent-btn-bg"
        />
        <span className="text-sm">
          <span className="text-foreground font-medium">Include metadata</span>
          <span className="block text-xs text-description-fg mt-0.5">
            When unchecked, step headings, token stats, session IDs, and
            separators are omitted — giving a clean conversation history.
          </span>
        </span>
      </label>

      <div>
        <label className="block text-sm text-foreground font-medium mb-1">
          Step range{" "}
          <span className="text-description-fg font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={stepRange}
          onChange={(event) => onStepRangeChange(event.target.value)}
          placeholder={
            totalCliSteps > 1
              ? `e.g. 1-${totalCliSteps}`
              : "e.g. 1,2,4-10"
          }
          aria-label="Step range (e.g. 1,2,4-10)"
          className={`w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7 ${
            stepRangeError ? "border-input-error-border" : "border-input-border"
          }`}
        />
        {stepRangeError && (
          <span className="text-xxs text-error-fg mt-0.5 block">
            Use numbers, commas, and ranges (e.g. 1,3,5-10)
          </span>
        )}
        <p className="text-xxs text-description-fg mt-1">
          Leave blank to export all {totalCliSteps > 0 ? totalCliSteps : ""}{" "}
          step{totalCliSteps !== 1 ? "s" : ""}.
        </p>
      </div>
    </div>
  </Modal>
);
