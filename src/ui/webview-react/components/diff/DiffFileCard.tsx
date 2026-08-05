import React from "react";
import { DiffView } from "@components/output/DiffView";
import type { HunkData, DiffType } from "react-diff-view";
import type { UnifiedDiffHunk } from "@root/types/CliOutputTypes";
import { DIFF_CHANGE_ICON } from "./diffChangeType";
import { DiffChangeBadge } from "./DiffChangeBadge";
import { DiffFilePathLabel } from "./DiffFilePathLabel";
import type { DiffChangeType } from "@root/types/DashboardConstants";

export interface DiffFileCardProps {
  path: string;
  /** Previous path — set only for a true rename. Never a /dev/null sentinel. */
  oldPath?: string;
  changeType: DiffChangeType;

  /** Exactly one diff source. */
  source:
    | { kind: "hunks"; hunks: HunkData[]; diffType: DiffType }
    | { kind: "content"; oldContent?: string; newContent?: string }
    | {
        kind: "patch";
        structuredPatch: UnifiedDiffHunk[];
        oldContent?: string;
      };

  language?: string;

  /** Present ⇒ the card renders a checkbox. Absent ⇒ read-only card. */
  selection?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabledReason?: string;
  };

  /** Small italic note on the header row. */
  note?: string;
  /** Right-aligned slot. */
  headerActions?: React.ReactNode;

  globallyCollapsed: boolean;
  localResetVersion?: number;
  findQuery?: string;
  findCaseSensitive?: boolean;
  viewType?: "split" | "unified";
}

export const DiffFileCard: React.FC<DiffFileCardProps> = ({
  path,
  oldPath,
  changeType,
  source,
  language,
  selection,
  note,
  headerActions,
  globallyCollapsed,
  localResetVersion,
  findQuery,
  findCaseSensitive,
  viewType,
}) => {
  const diffView = (() => {
    switch (source.kind) {
      case "hunks":
        return (
          <DiffView
            hunks={source.hunks}
            diffType={source.diffType}
            language={language}
            globallyCollapsed={globallyCollapsed}
            localResetVersion={localResetVersion}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            viewType={viewType}
            outerMarginClassName="my-1"
          />
        );
      case "content":
        return (
          <DiffView
            oldContent={source.oldContent}
            newContent={source.newContent}
            language={language}
            globallyCollapsed={globallyCollapsed}
            localResetVersion={localResetVersion}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            viewType={viewType}
            outerMarginClassName="my-1"
          />
        );
      case "patch":
        return (
          <DiffView
            structuredPatch={source.structuredPatch}
            oldContent={source.oldContent}
            language={language}
            globallyCollapsed={globallyCollapsed}
            localResetVersion={localResetVersion}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            viewType={viewType}
            outerMarginClassName="my-1"
          />
        );
    }
  })();

  return (
    <div className="border border-panel-border rounded overflow-hidden">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-panel-border bg-editor-bg px-2.5 py-1 text-xs font-mono">
        {selection &&
          (selection.disabledReason ? (
            <span
              className="shrink-0 text-description-fg italic"
              title={selection.disabledReason}
            >
              {selection.disabledReason}
            </span>
          ) : (
            <input
              type="checkbox"
              checked={selection.checked}
              onChange={(event) => selection.onChange(event.target.checked)}
              aria-label={`Select ${path}`}
              className="shrink-0"
            />
          ))}
        <i
          className={`codicon codicon-file-diff ${DIFF_CHANGE_ICON[changeType]} shrink-0 text-editor-fg opacity-80`}
          aria-hidden="true"
        />
        <DiffFilePathLabel path={path} oldPath={oldPath} />
        <DiffChangeBadge changeType={changeType} />
        {note && (
          <span className="shrink-0 text-description-fg italic">{note}</span>
        )}
        {headerActions && (
          <div className="ml-auto flex shrink-0 items-center">
            {headerActions}
          </div>
        )}
      </div>
      {diffView}
    </div>
  );
};
