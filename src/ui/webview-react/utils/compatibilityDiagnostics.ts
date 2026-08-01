import {
  HARNESS_INFO,
  HARNESS_IDS,
  PERMISSION_CAPABILITY_KEYS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_SOURCE_TIERS,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type {
  CompatibilityDiagnostic,
  HarnessCapabilityRegistrySnapshot,
} from "@root/types/CompatibilityTypes";
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";

export type PermissionField =
  | typeof PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
  | typeof PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  | typeof PERMISSION_CAPABILITY_KEYS.MODE;

export function diagnosticsForPermissionField(
  diagnostics: readonly CompatibilityDiagnostic[],
  field: PermissionField
): CompatibilityDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.capability === field);
}

export function toFieldDiagnostic(
  diagnostic: CompatibilityDiagnostic,
  sourceLabel?: string
): Pick<CompatibilityDiagnostic, "severity" | "message"> {
  const harnessName =
    HARNESS_INFO[diagnostic.harnessId]?.name ?? diagnostic.harnessId;
  const message = diagnostic.message
    .split(diagnostic.harnessId)
    .join(harnessName);
  return {
    severity: diagnostic.severity,
    message: sourceLabel
      ? `${message} ${sourceLabel}`
      : message,
  };
}

export function formatCompatibilitySource(
  sourceTier: CompatibilityDiagnostic["sourceTier"]
): string | undefined {
  if (sourceTier === COMPATIBILITY_SOURCE_TIERS.WORKFLOW) {
    return "This value is inherited from workflow properties.";
  }
  if (sourceTier === COMPATIBILITY_SOURCE_TIERS.DEFAULTS) {
    return "This value comes from the global defaults.";
  }
  return undefined;
}

function isLossy(
  state: { fidelity: string; verification: string }
): boolean {
  return (
    state.fidelity !== CAPABILITY_FIDELITIES.EXACT ||
    state.verification !== CAPABILITY_VERIFICATION_STATUSES.VERIFIED
  );
}

function harnessLabel(harnessId: HarnessId): string {
  return HARNESS_INFO[harnessId]?.shortName ?? harnessId;
}

function reasonForHarness(harnessId: HarnessId): string {
  switch (harnessId) {
    case HARNESS_IDS.CODEX_CLI:
      return "because Codex uses sandbox/approval modes instead of individual tool patterns";
    case HARNESS_IDS.ANTIGRAVITY_CLI:
      return "because Antigravity uses coarse permission modes instead of individual tool patterns";
    default:
      return "because this harness does not provide verified individual tool-pattern enforcement";
  }
}

/**
 * Aggregates target-level analyzer output into the workflow-level wording used
 * by the authoring controls. Target diagnostics remain the source of truth;
 * this is presentation-only aggregation.
 */
export function workflowPermissionDiagnostic(
  field: Exclude<PermissionField, "mode">,
  targets: readonly CompatibilityExecutionTarget[],
  capabilities: HarnessCapabilityRegistrySnapshot
): Pick<CompatibilityDiagnostic, "severity" | "message"> | undefined {
  const relevant = targets.filter(
    (target) => (target.resolved.properties.toolPermissions?.[field]?.length ?? 0) > 0
  );
  if (relevant.length === 0) return undefined;

  const grouped = new Map<
    HarnessId,
    { supported: number; affected: number }
  >();
  for (const target of relevant) {
    const harnessId = target.resolved.properties.harness;
    const group = grouped.get(harnessId) ?? { supported: 0, affected: 0 };
    const state = capabilities.harnesses[harnessId]?.effective?.permissions[field];
    if (state && !isLossy(state)) group.supported += 1;
    else group.affected += 1;
    grouped.set(harnessId, group);
  }

  const enforced = [...grouped.entries()]
    .filter(([, counts]) => counts.supported > 0)
    .map(
      ([harnessId, counts]) =>
        `Enforced for ${counts.supported} ${harnessLabel(harnessId)} step${counts.supported === 1 ? "" : "s"}`
    );
  const ignored = [...grouped.entries()]
    .filter(([, counts]) => counts.affected > 0)
    .map(
      ([harnessId, counts]) =>
        `Ignored by ${counts.affected} ${harnessLabel(harnessId)} step${counts.affected === 1 ? "" : "s"} ${reasonForHarness(harnessId)}`
    );

  if (ignored.length === 0) return undefined;
  const deniedRuleWarning =
    field === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
      ? " Denied Tools are NOT ENFORCED by the affected consumers."
      : "";
  return {
    severity: "warning",
    message: `${enforced.concat(ignored).join(". ")}.${deniedRuleWarning}`,
  };
}

export function firstCompatibilityProperty(
  diagnostics: readonly CompatibilityDiagnostic[],
  prefix = "settings"
): string {
  const diagnostic = diagnostics.find((item) => item.propertyPointer);
  if (!diagnostic?.propertyPointer) return `${prefix}-permission-mode`;
  if (diagnostic.propertyPointer.endsWith("allowedTools")) {
    return `${prefix}-allowed-tools`;
  }
  if (diagnostic.propertyPointer.endsWith("deniedTools")) {
    return `${prefix}-denied-tools`;
  }
  return `${prefix}-permission-mode`;
}
