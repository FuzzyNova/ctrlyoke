import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";
import { COMPATIBILITY_DIAGNOSTIC_SEVERITIES } from "@root/types/DashboardConstants";

export type FieldDiagnostic = Pick<
  CompatibilityDiagnostic,
  "severity" | "message"
> & { id?: string };

/** Shared border treatment for inputs that have persistent validation feedback. */
export function fieldValidationBorderClass(
  diagnostics: readonly FieldDiagnostic[]
): string {
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    )
  ) {
    return "border-input-error-border";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "border-warning-fg";
  }
  return "border-input-border";
}
