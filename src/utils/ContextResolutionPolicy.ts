import {
  CONTEXT_RESOLUTION_FAILURE_MODES,
  formatContextResolutionFailureMessage,
  isContextResolutionDiagnostic,
} from "../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import { ConfigurationUtils } from "./ConfigurationUtils";

/**
 * Throw when `execution.contextResolutionFailure` is `"fail"` and any of the
 * diagnostics is a declared reference that did not resolve.
 */
export function assertContextResolutionDiagnosticsAllowed(
  diagnostics: readonly CompatibilityDiagnostic[]
): void {
  const blockingDiagnostics = diagnostics.filter((diagnostic) =>
    isContextResolutionDiagnostic(diagnostic.code)
  );
  if (
    ConfigurationUtils.getContextResolutionFailureMode() ===
      CONTEXT_RESOLUTION_FAILURE_MODES.FAIL &&
    blockingDiagnostics.length > 0
  ) {
    throw new Error(formatContextResolutionFailureMessage(blockingDiagnostics));
  }
}
