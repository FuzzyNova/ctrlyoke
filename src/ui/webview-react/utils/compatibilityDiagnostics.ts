import {
  getHarnessShortName,
  HARNESS_IDS,
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
  HOOK_EVENT_ORDER,
  MCP_CAPABILITY_KEYS,
  type HookEvent,
  type HarnessId,
} from "@root/types/DashboardConstants";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  getCompatibilityCaveatMessage,
  getCompatibilityDiagnosticMessage,
  isAdvisoryCaveat,
  type CompatibilityCaveatCode,
  type CompatibilityDiagnostic,
  type HarnessCapabilityRegistrySnapshot,
} from "@root/types/CompatibilityTypes";
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";

export type PermissionField =
  | typeof PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
  | typeof PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  | typeof PERMISSION_CAPABILITY_KEYS.MODE;

const PERMISSION_FIELDS: readonly (
  PermissionField | typeof PERMISSION_CAPABILITY_KEYS.AUTO_MODE
)[] = [
  PERMISSION_CAPABILITY_KEYS.MODE,
  PERMISSION_CAPABILITY_KEYS.AUTO_MODE,
  PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS,
  PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS,
];

export function diagnosticsForPermissions(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    PERMISSION_FIELDS.includes(diagnostic.capability as PermissionField)
  );
}

export function diagnosticsForPermissionField(
  diagnostics: readonly CompatibilityDiagnostic[],
  field: PermissionField
): CompatibilityDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.capability === field ||
      (field === PERMISSION_CAPABILITY_KEYS.MODE &&
        diagnostic.capability === PERMISSION_CAPABILITY_KEYS.AUTO_MODE)
  );
}

export function diagnosticsForHookEvents(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    HOOK_EVENT_ORDER.includes(diagnostic.capability as HookEvent)
  );
}

/** The harness-support note shown under a Sandbox control, if the analyzer raised one. */
export function sandboxSupportDiagnostic(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnostic | undefined {
  return diagnostics.find(
    (diagnostic) =>
      diagnostic.code === COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED ||
      diagnostic.code === COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED
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

/**
 * One warning per harness that cannot enforce a tool list at all, each giving
 * that harness's own reason, or nothing when every harness enforces it (the
 * normal case). Partial support is left to the per-step diagnostics.
 */
export function permissionCapabilitySummary(
  snapshot: HarnessCapabilityRegistrySnapshot,
  field: Exclude<PermissionField, "mode">
): Pick<CompatibilityDiagnostic, "severity" | "message">[] {
  const code =
    field === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
      ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED
      : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED;

  return (Object.values(HARNESS_IDS) as HarnessId[])
    .filter(
      (harnessId) =>
        snapshot.harnesses[harnessId]?.effective?.permissions?.[field]
          ?.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED
    )
    .map((harnessId) => ({
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      message: getCompatibilityDiagnosticMessage(code, {
        harnessId,
        capability: field,
        caveatCode:
          snapshot.harnesses[harnessId]?.descriptor?.permissions?.[field]
            ?.caveatCode,
      }),
    }));
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

function hasAdvisoryCaveat(
  state: { fidelity: string; verification: string },
  caveatCode: CompatibilityCaveatCode | undefined
): boolean {
  return (
    state.fidelity === CAPABILITY_FIDELITIES.PARTIAL &&
    isAdvisoryCaveat(caveatCode)
  );
}

function harnessLabel(harnessId: HarnessId): string {
  return getHarnessShortName(harnessId);
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
  const caveatCode =
    capabilities.harnesses[harnessId]?.descriptor?.permissions?.[field]
      ?.caveatCode;
  // Reason caveats are already "because …" clauses; an advisory note does not
  // explain why a list is ignored, so it falls back to the generic reason.
  const caveat = isAdvisoryCaveat(caveatCode)
    ? undefined
    : getCompatibilityCaveatMessage(caveatCode);
  return (
    caveat ??
    "because this harness does not provide verified individual tool-pattern enforcement"
  );
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
    { supported: number; caveated: number; partial: number; affected: number }
  >();
  for (const target of relevant) {
    const harnessId = target.resolved.properties.harness;
    const group = grouped.get(harnessId) ?? {
      supported: 0,
      caveated: 0,
      partial: 0,
      affected: 0,
    };
    const state =
      capabilities.harnesses[harnessId]?.effective?.permissions?.[field];
    const caveatCode =
      capabilities.harnesses[harnessId]?.descriptor?.permissions?.[field]
        ?.caveatCode;
    if (state && hasAdvisoryCaveat(state, caveatCode)) group.caveated += 1;
    else if (state && !isLossy(state)) group.supported += 1;
    else if (state?.fidelity === CAPABILITY_FIDELITIES.PARTIAL) {
      group.partial += 1;
    } else group.affected += 1;
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

  const partial = [...grouped.entries()]
    .filter(([, counts]) => counts.partial > 0)
    .map(
      ([harnessId, counts]) =>
        `Only partly enforced for ${counts.partial} ${harnessLabel(harnessId)} step${counts.partial === 1 ? "" : "s"} ${reasonForHarness(harnessId, field, capabilities)}`
    );

  if (ignored.length === 0 && partial.length === 0 && caveated.length === 0) {
    return undefined;
  }
  // An ignored deny list is the one case where a step can run a tool the
  // author meant to forbid, so say that outright.
  const deniedRuleWarning =
    field === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS && ignored.length > 0
      ? " Those steps can still run the denied tools."
      : "";
  return {
    severity:
      ignored.length > 0 || partial.length > 0
        ? COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
        : COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO,
    message: `${enforced.concat(caveated, partial, ignored).join(". ")}.${deniedRuleWarning}`,
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
