import React from "react";
import type { WorkflowLineageDescriptor } from "@root/types/CtrlYokeTypes";

type ImportedFrom = NonNullable<WorkflowLineageDescriptor["importedFrom"]>;
export type ImportedOriginKind = "runBundle" | "harnessSession" | "observedSession";

export interface ImportedOriginBadgeProps {
  kind: ImportedOriginKind;
  description: string;
  label?: string;
}

export function importedOriginAccessibleName(importedFrom: ImportedFrom): string {
  return `Imported from ${importedFrom.bundleName}; source ${importedFrom.sourceRoot}; exported ${importedFrom.exportedAt}`;
}

/** Compact provenance badge shared by imported run origins. */
export const ImportedOriginBadge: React.FC<ImportedOriginBadgeProps> = ({
  kind,
  description,
  label = "Imported",
}) => {
  return (
    <span
      data-testid="imported-origin-badge"
      role="img"
      title={description}
      aria-label={description}
      className="inline-flex shrink-0 items-center rounded-sm border border-widget-border px-1.5 py-0.5 text-xs leading-none text-description-fg"
      data-origin-kind={kind}
    >
      {label}
    </span>
  );
};
