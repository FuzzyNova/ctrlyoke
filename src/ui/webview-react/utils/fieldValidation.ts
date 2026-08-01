import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";

export type FieldDiagnostic = Pick<
  CompatibilityDiagnostic,
  "severity" | "message"
> & { id?: string };

/** Shared border treatment for inputs that have persistent validation feedback. */
export function fieldValidationBorderClass(
  diagnostics: readonly FieldDiagnostic[]
): string {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "border-input-error-border";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "border-warning-fg";
  }
  return "border-input-border";
}
