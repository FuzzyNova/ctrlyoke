import React from "react";
import { HARNESS_INFO } from "@root/types/DashboardConstants";
import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";
import type { FieldDiagnostic as FieldDiagnosticItem } from "@utils/fieldValidation";
import { Icon } from "./Icon";

export interface FieldDiagnosticProps {
  id: string;
  diagnostics: readonly FieldDiagnosticItem[];
  className?: string;
}

const SEVERITY_STYLE = {
  warning: {
    icon: "warning",
    className: "text-warning-fg",
  },
  error: {
    icon: "error",
    className: "text-error-fg",
  },
  info: {
    icon: "info",
    className: "text-description-fg",
  },
} as const;

/** Renders persistent, accessible feedback for a form control. */
export const FieldDiagnostic: React.FC<FieldDiagnosticProps> = ({
  id,
  diagnostics,
  className = "",
}) => {
  if (diagnostics.length === 0) return null;

  return (
    <div id={id} className={`flex flex-col gap-1 text-xxs ${className}`}>
      {diagnostics.map((diagnostic, index) => {
        const style = SEVERITY_STYLE[diagnostic.severity];
        return (
          <p
            key={`${diagnostic.message}-${index}`}
            className={`flex items-start gap-1 ${style.className}`}
          >
            <Icon name={style.icon} className="mt-px shrink-0" />
            <span>{diagnostic.message}</span>
          </p>
        );
      })}
    </div>
  );
};

export interface CompatibilitySummaryProps {
  diagnostics: readonly Pick<
    CompatibilityDiagnostic,
    "severity" | "message" | "harnessId"
  >[];
  onReview: () => void;
}

/** Compact live summary shown beside the harness selector. */
export const CompatibilitySummary: React.FC<CompatibilitySummaryProps> = ({
  diagnostics,
  onReview,
}) => {
  if (diagnostics.length === 0) return null;

  const harnesses = [
    ...new Set(diagnostics.map((diagnostic) => diagnostic.harnessId)),
  ];
  const count = diagnostics.length;
  const warningLabel = `compatibility warning${count === 1 ? "" : "s"}`;
  const harnessLabel =
    harnesses.length === 1
      ? `for ${HARNESS_INFO[harnesses[0]]?.name ?? harnesses[0]}`
      : `across ${harnesses.length} harnesses`;

  return (
    <div
      className="mt-1 flex items-center gap-2 rounded-sm border border-warning-fg/40 bg-severity-warning-bg px-2 py-1 text-xxs text-warning-fg"
      role="status"
      aria-live="polite"
    >
      <Icon name="warning" className="shrink-0" />
      <span>
        {count} {warningLabel} {harnessLabel}
      </span>
      <button
        type="button"
        onClick={onReview}
        className="ml-auto shrink-0 font-semibold underline hover:no-underline"
      >
        Review
      </button>
    </div>
  );
};
