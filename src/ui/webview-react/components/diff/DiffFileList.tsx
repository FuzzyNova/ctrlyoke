import React from "react";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard";
import {
  diffFileListRowGapClass,
  projectDiffFileListRows,
} from "@utils/diffFileRows";

export interface DiffFileGroup {
  /** Stable semantic identity for this group, independent of heading text/order. */
  key?: string;
  /** Optional heading; omit for a flat list. */
  heading?: string;
  /** Optional one-line explainer under the heading. */
  headingHint?: string;
  files: Array<DiffFileCardProps & { key: string }>;
}

export interface DiffFileListProps {
  groups: DiffFileGroup[];
  emptyMessage: string;
  /** Rendered above the list. */
  selectionSummary?: React.ReactNode;
}

export const DiffFileList: React.FC<DiffFileListProps> = ({
  groups,
  emptyMessage,
  selectionSummary,
}) => {
  const hasFiles = groups.some((group) => group.files.length > 0);

  if (!hasFiles) {
    return (
      <div className="flex flex-col gap-3">
        {selectionSummary}
        <div className="flex items-center justify-center h-32 text-editor-fg opacity-40 select-none">
          <p className="text-sm">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const rows = projectDiffFileListRows({ groups, selectionSummary });

  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <div key={row.key} className={diffFileListRowGapClass(row)}>
          {row.kind === "selection-summary" && row.content}
          {row.kind === "group-heading" && (
            <div className="flex flex-col gap-0.5">
              <h3 className="text-xs font-semibold text-description-fg">
                {row.heading}
              </h3>
              {row.headingHint && (
                <p className="text-xs text-description-fg italic">
                  {row.headingHint}
                </p>
              )}
            </div>
          )}
          {row.kind === "file" && <DiffFileCard {...row.file} />}
        </div>
      ))}
    </div>
  );
};
