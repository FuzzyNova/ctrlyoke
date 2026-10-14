import {
  HARNESS_INFO,
  HARNESS_IDS,
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_SOURCE_TIERS,
  HOOK_EVENT_ORDER,
  MCP_CAPABILITY_KEYS,
  type HookEvent,
  type HarnessId,
} from "@root/types/DashboardConstants";
import {
  getCompatibilityCaveatMessage,
  type CompatibilityDiagnostic,
  type HarnessCapabilityRegistrySnapshot,
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

export function diagnosticsForHookEvents(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    HOOK_EVENT_ORDER.includes(diagnostic.capability as HookEvent)
  );
}

export function diagnosticsForMcpFiltering(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.capability === MCP_CAPABILITY_KEYS.PER_SERVER_TOOL_FILTERING
  );
}

export function permissionCapabilitySummary(
  snapshot: HarnessCapabilityRegistrySnapshot,
  field: Exclude<PermissionField, "mode">
): Pick<CompatibilityDiagnostic, "severity" | "message">[] {
  const supported: string[] = [];
  const notEnforced: string[] = [];

  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    const state =
      snapshot.harnesses[harnessId]?.effective?.permissions?.[field];
    const label =
      harnessId === HARNESS_IDS.CLAUDE_CLI
        ? "Claude CLI"
        : (HARNESS_INFO[harnessId]?.name ?? harnessId);

    if (state?.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED) {
      notEnforced.push(label);
    } else {
      supported.push(label);
    }
  }

  const label =
    field === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
      ? "Allowed Tools"
      : "Denied Tools";
  const diagnostics: Pick<CompatibilityDiagnostic, "severity" | "message">[] =
    [];

  if (supported.length > 0) {
    diagnostics.push({
      severity: "info",
      message: `${label} are currently supported by ${joinLabels(supported)}.`,
    });
  }
  if (notEnforced.length > 0) {
    diagnostics.push({
      severity: "warning",
      message: `${joinLabels(notEnforced)} only support an overall permission mode, not individual tool patterns; ${label} are NOT ENFORCED by these harnesses.`,
    });
  }

  return diagnostics;
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "no harnesses";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function toFieldDiagnostic(
  diagnostic: CompatibilityDiagnostic,
  sourceLabel?: string
): Pick<CompatibilityDiagnostic, "severity" | "message"> {
  const message = diagnostic.message;
  return {
    severity: diagnostic.severity,
    message: sourceLabel ? `${message} ${sourceLabel}` : message,
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

function isLossy(state: { fidelity: string; verification: string }): boolean {
  return (
    state.fidelity !== CAPABILITY_FIDELITIES.EXACT ||
    state.verification !== CAPABILITY_VERIFICATION_STATUSES.VERIFIED
  );
}

function hasEnforcedCaveat(
  state: { fidelity: string; verification: string },
  caveatCode: string | undefined
): boolean {
  return state.fidelity === CAPABILITY_FIDELITIES.PARTIAL && !!caveatCode;
}

function harnessLabel(harnessId: HarnessId): string {
  return HARNESS_INFO[harnessId]?.shortName ?? harnessId;
}

/**
 * The reason a harness cannot enforce a list is a harness-owned fact carried on
 * the declaration as `caveatCode`; the prose lives in the shared helper. This
 * module must never switch on `harnessId` to invent one.
 */
function reasonForHarness(
  harnessId: HarnessId,
  field: Exclude<PermissionField, "mode">,
  capabilities: HarnessCapabilityRegistrySnapshot
): string {
  const caveat = getCompatibilityCaveatMessage(
    capabilities.harnesses[harnessId]?.descriptor?.permissions?.[field]
      ?.caveatCode
  );
  if (caveat) {
    return caveat.startsWith("because ") ? caveat : `because ${caveat}`;
  }
  return "because this harness does not provide verified individual tool-pattern enforcement";
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
  const relevant = targets.filter((target) => {
    const permissions = target.resolved.properties.toolPermissions;
    // dangerouslyAllowAll bypasses every allow/deny list natively, so a
    // leftover non-empty list carried over from a previous mode is never
    // "ignored" by anything — there is nothing left for it to affect.
    if (permissions?.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      return false;
    }
    return (permissions?.[field]?.length ?? 0) > 0;
  });
  if (relevant.length === 0) return undefined;

  const grouped = new Map<
    HarnessId,
    { supported: number; caveated: number; affected: number }
  >();
  for (const target of relevant) {
    const harnessId = target.resolved.properties.harness;
    const group =
      grouped.get(harnessId) ?? { supported: 0, caveated: 0, affected: 0 };
    const state =
      capabilities.harnesses[harnessId]?.effective?.permissions?.[field];
    const caveatCode =
      capabilities.harnesses[harnessId]?.descriptor?.permissions?.[field]
        ?.caveatCode;
    if (state && hasEnforcedCaveat(state, caveatCode)) group.caveated += 1;
    else if (state && !isLossy(state)) group.supported += 1;
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
        `Ignored by ${counts.affected} ${harnessLabel(harnessId)} step${counts.affected === 1 ? "" : "s"} ${reasonForHarness(harnessId, field, capabilities)}`
    );

  const caveated = [...grouped.entries()]
    .filter(([, counts]) => counts.caveated > 0)
    .map(([harnessId, counts]) => {
      const caveat = getCompatibilityCaveatMessage(
        capabilities.harnesses[harnessId]?.descriptor?.permissions?.[field]
          ?.caveatCode
      );
      return `Enforced for ${counts.caveated} ${harnessLabel(harnessId)} step${counts.caveated === 1 ? "" : "s"}${caveat ? `, but ${caveat}` : ""}`;
    });

  if (ignored.length === 0 && caveated.length === 0) return undefined;
  const deniedRuleWarning =
    field === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
      ? " Denied Tools are NOT ENFORCED by the affected consumers."
      : "";
  return {
    severity: ignored.length > 0 ? "warning" : "info",
    message: `${enforced.concat(caveated, ignored).join(". ")}.${deniedRuleWarning}`,
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
