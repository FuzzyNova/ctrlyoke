import React, { useEffect, useMemo, useState } from "react";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard";
import {
  type DiffFileListRow,
  diffFileListRowGapClass,
  projectDiffFileListRows,
} from "@utils/diffFileRows";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";

export interface DiffFileListCommand {
  /** Changes whenever Expand all or Collapse all should reset local state. */
  version: number;
  collapsed: boolean;
}

interface CollapsedOverride {
  version: number;
  collapsed: boolean;
}

interface ExpandedGapsOverride {
  version: number;
  expandedGaps: DiffGapExpansionState;
}

const EMPTY_COLLAPSED_OVERRIDES = new Map<string, CollapsedOverride>();
const EMPTY_EXPANDED_GAPS_OVERRIDES = new Map<string, ExpandedGapsOverride>();
const EMPTY_EXPANDED_GAPS: DiffGapExpansionState = new Map();

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
  command: DiffFileListCommand;
  /** Rendered above the list. */
  selectionSummary?: React.ReactNode;
}

export const DiffFileList: React.FC<DiffFileListProps> = ({
  groups,
  emptyMessage,
  command,
  selectionSummary,
}) => {
  const rows = projectDiffFileListRows(
    { groups, selectionSummary },
    { collapsed: command.collapsed }
  );
  const fileRows = rows.filter(
    (row): row is Extract<DiffFileListRow, { kind: "file" }> =>
      row.kind === "file"
  );
  const fileRowKeySignature = fileRows.map((row) => row.key).join("\u0000");
  const activeFileRowKeys = useMemo(
    () =>
      new Set(
        fileRowKeySignature.length > 0
          ? fileRowKeySignature.split("\u0000")
          : []
      ),
    [fileRowKeySignature]
  );

  const [collapsedOverrides, setCollapsedOverrides] = useState(
    EMPTY_COLLAPSED_OVERRIDES
  );
  const [expandedGapsOverrides, setExpandedGapsOverrides] = useState(
    EMPTY_EXPANDED_GAPS_OVERRIDES
  );

  // A command reset must take effect during this render. The effects below
  // only discard the entries after render, so an unchanged card cannot briefly
  // retain an override from the previous Expand/Collapse all command.
  const currentCollapsedOverrides = new Map<string, CollapsedOverride>();
  for (const [key, override] of collapsedOverrides) {
    if (override.version === command.version && activeFileRowKeys.has(key)) {
      currentCollapsedOverrides.set(key, override);
    }
  }
  const currentExpandedGapsOverrides = new Map<string, ExpandedGapsOverride>();
  for (const [key, override] of expandedGapsOverrides) {
    if (override.version === command.version && activeFileRowKeys.has(key)) {
      currentExpandedGapsOverrides.set(key, override);
    }
  }

  useEffect(() => {
    setCollapsedOverrides((previous) => {
      let next: Map<string, CollapsedOverride> | undefined;
      for (const [key, override] of previous) {
        if (
          override.version !== command.version ||
          !activeFileRowKeys.has(key)
        ) {
          next ??= new Map(previous);
          next.delete(key);
        }
      }
      return next ?? previous;
    });
    setExpandedGapsOverrides((previous) => {
      let next: Map<string, ExpandedGapsOverride> | undefined;
      for (const [key, override] of previous) {
        if (
          override.version !== command.version ||
          !activeFileRowKeys.has(key)
        ) {
          next ??= new Map(previous);
          next.delete(key);
        }
      }
      return next ?? previous;
    });
  }, [activeFileRowKeys, command.version, fileRowKeySignature]);

  const handleCollapsedChange = (key: string, collapsed: boolean): void => {
    setCollapsedOverrides((previous) => {
      const existing = previous.get(key);
      if (
        existing?.version === command.version &&
        existing.collapsed === collapsed
      ) {
        return previous;
      }
      const next = new Map(previous);
      next.set(key, { version: command.version, collapsed });
      return next;
    });
  };

  const handleExpandGap = (
    key: string,
    gapIndex: number,
    nextExpandedToLine: number
  ): void => {
    setExpandedGapsOverrides((previous) => {
      const existing = previous.get(key);
      const expandedGaps = new Map(existing?.expandedGaps);
      if (expandedGaps.get(gapIndex) === nextExpandedToLine) return previous;
      expandedGaps.set(gapIndex, nextExpandedToLine);
      const next = new Map(previous);
      next.set(key, {
        version: command.version,
        expandedGaps,
      });
      return next;
    });
  };

  const hasFiles = fileRows.length > 0;

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
          {row.kind === "file" && (
            <DiffFileCard
              {...row.file}
              collapsed={
                currentCollapsedOverrides.get(row.key)?.collapsed ??
                command.collapsed
              }
              onCollapsedChange={(collapsed) =>
                handleCollapsedChange(row.key, collapsed)
              }
              expandedGaps={
                currentExpandedGapsOverrides.get(row.key)?.expandedGaps ??
                EMPTY_EXPANDED_GAPS
              }
              onExpandGap={(gapIndex, nextExpandedToLine) =>
                handleExpandGap(row.key, gapIndex, nextExpandedToLine)
              }
            />
          )}
        </div>
      ))}
    </div>
  );
};
