import React from "react";
import type { AutoResumePreview } from "../../utils/autoResumePreview";

export interface AutoResumeStatusRowProps {
  preview: AutoResumePreview;
}

const AUTO_RESUME_TOOLTIP =
  "Blank = auto-resume: continues the most recent session from an earlier prompt using the same harness.";

/** Status row shown below a blank Session ID field, previewing what auto-resume will do. */
export const AutoResumeStatusRow: React.FC<AutoResumeStatusRowProps> = ({
  preview,
}) => {
  return (
    <p
      className="text-xs text-description-fg mt-0.5 flex items-center gap-1"
      title={AUTO_RESUME_TOOLTIP}
    >
      <i className="codicon codicon-history text-xxs" aria-hidden="true" />
      {preview.resumable
        ? `Auto-resume: will resume ${preview.stepLabel}`
        : "Auto-resume: No sessions found to resume, will create new"}
    </p>
  );
};
