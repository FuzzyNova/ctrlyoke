import React from "react";
import { DiffView } from "@components/output/DiffView";
import type { HunkData, DiffType } from "react-diff-view";
import type { UnifiedDiffHunk } from "@root/types/CliOutputTypes";
import {
  DIFF_CHANGE_COLOR,
  DIFF_CHANGE_ICON,
  DIFF_CHANGE_LABEL,
} from "./diffChangeType";
import {
  DiffFileDirectoryLabel,
  DiffFileNameLabel,
  diffFilePathTitle,
} from "./DiffFilePathLabel";
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

  const pathTitle = diffFilePathTitle(path, oldPath);

  return (
    <div className="border border-panel-border rounded overflow-hidden">
      <div className="sticky top-0 z-10 flex flex-col gap-0.5 border-b border-panel-border bg-editor-bg px-2.5 py-1 text-xs font-mono">
        <div className="flex items-center gap-2">
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
            className={`codicon ${DIFF_CHANGE_ICON[changeType]} shrink-0 ${DIFF_CHANGE_COLOR[changeType]}`}
            title={DIFF_CHANGE_LABEL[changeType]}
            aria-label={DIFF_CHANGE_LABEL[changeType]}
          />
          <div
            className="flex min-w-0 flex-1 flex-col"
            title={pathTitle}
            aria-label={pathTitle}
          >
            <DiffFileNameLabel path={path} oldPath={oldPath} />
            <DiffFileDirectoryLabel path={path} oldPath={oldPath} />
          </div>
          {headerActions && (
            <div className="ml-auto flex shrink-0 items-center">
              {headerActions}
            </div>
          )}
        </div>
        {note && (
          <span className="pl-5 text-description-fg italic [overflow-wrap:anywhere]">
            {note}
          </span>
        )}
      </div>
      {diffView}
    </div>
  );
};
