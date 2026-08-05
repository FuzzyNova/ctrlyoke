import React from "react";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard";

export interface DiffFileGroup {
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

  const hasHeadings = groups.some((group) => group.heading !== undefined);

  return (
    <div className="flex flex-col gap-3">
      {selectionSummary}
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group.heading ?? `group-${groupIndex}`}>
          {hasHeadings && group.heading && (
            <div className="flex flex-col gap-0.5">
              <h3 className="text-xs font-semibold text-description-fg">
                {group.heading}
              </h3>
              {group.headingHint && (
                <p className="text-xs text-description-fg italic">
                  {group.headingHint}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-3">
            {group.files.map(({ key, ...file }) => (
              <DiffFileCard key={key} {...file} />
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
