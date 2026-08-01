import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_BASES,
  CAPABILITY_VERIFICATION_KINDS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  PERMISSION_CAPABILITY_KEYS,
  type HarnessId,
  type HookEvent,
} from "./DashboardConstants";

export const COMPATIBILITY_DIAGNOSTIC_CODES = {
  HARNESS_UNAVAILABLE: "compatibility.harness.unavailable",
  PERMISSION_MODE_UNSUPPORTED: "compatibility.permissions.mode.unsupported",
  PERMISSION_MODE_PARTIAL: "compatibility.permissions.mode.partial",
  PERMISSION_MODE_UNVERIFIED: "compatibility.permissions.mode.unverified",
  ALLOWED_TOOLS_NOT_ENFORCED:
    "compatibility.permissions.allowedTools.notEnforced",
  ALLOWED_TOOLS_PARTIAL: "compatibility.permissions.allowedTools.partial",
  ALLOWED_TOOLS_UNVERIFIED:
    "compatibility.permissions.allowedTools.unverified",
  DENIED_TOOLS_NOT_ENFORCED:
    "compatibility.permissions.deniedTools.notEnforced",
  DENIED_TOOLS_PARTIAL: "compatibility.permissions.deniedTools.partial",
  DENIED_TOOLS_UNVERIFIED:
    "compatibility.permissions.deniedTools.unverified",
} as const;

export type CapabilityFidelity =
  (typeof CAPABILITY_FIDELITIES)[keyof typeof CAPABILITY_FIDELITIES];
export type CapabilityMechanism =
  (typeof CAPABILITY_MECHANISMS)[keyof typeof CAPABILITY_MECHANISMS];
export type CapabilityVerificationStatus =
  (typeof CAPABILITY_VERIFICATION_STATUSES)[keyof typeof CAPABILITY_VERIFICATION_STATUSES];
export type CapabilityVerificationKind =
  (typeof CAPABILITY_VERIFICATION_KINDS)[keyof typeof CAPABILITY_VERIFICATION_KINDS];
export type CapabilityVerificationBasis =
  (typeof CAPABILITY_VERIFICATION_BASES)[keyof typeof CAPABILITY_VERIFICATION_BASES];
export type CapabilityDomain =
  (typeof CAPABILITY_DOMAINS)[keyof typeof CAPABILITY_DOMAINS];
export type CompatibilityDiagnosticSeverity =
  (typeof COMPATIBILITY_DIAGNOSTIC_SEVERITIES)[keyof typeof COMPATIBILITY_DIAGNOSTIC_SEVERITIES];
export type CompatibilitySourceTier =
  (typeof COMPATIBILITY_SOURCE_TIERS)[keyof typeof COMPATIBILITY_SOURCE_TIERS];

/** A semver range expression for a harness CLI version. */
export type HarnessVersionRange = string;

export interface CapabilityDeclaration {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  verification?: {
    kind: CapabilityVerificationKind;
    reference: string;
    basis: CapabilityVerificationBasis;
    /** Ranges for which this exact capability claim has evidence. */
    readonly verifiedVersions: readonly HarnessVersionRange[];
  };
  caveatCode?: string;
  remediationCode?: string;
}

export interface EffectiveCapabilityState {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  verification: CapabilityVerificationStatus;
}

export interface PermissionCapabilityDescriptor {
  mode: CapabilityDeclaration;
  allowedTools: CapabilityDeclaration;
  deniedTools: CapabilityDeclaration;
}

export type PermissionCapabilityKey = keyof PermissionCapabilityDescriptor;

export type EffectivePermissionCapabilityState = Record<
  PermissionCapabilityKey,
  EffectiveCapabilityState
>;

export interface HarnessCapabilityDescriptor {
  harnessId: HarnessId;
  promptInputs?: {
    images: CapabilityDeclaration;
  };
  permissions?: PermissionCapabilityDescriptor;
  hooks?: Partial<Record<HookEvent, CapabilityDeclaration>>;
  mcp?: {
    injection: CapabilityDeclaration;
    perServerToolFiltering: CapabilityDeclaration;
  };
  usage?: {
    contextWindow: CapabilityDeclaration;
    turnTokens: CapabilityDeclaration;
    cumulativeTokens: CapabilityDeclaration;
  };
}

export interface HarnessCapabilityRegistrySnapshot {
  schemaVersion: number;
  enabledDomains: CapabilityDomain[];
  harnesses: Record<HarnessId, InstalledHarnessCapabilities>;
}

export interface InstalledHarnessCapabilities {
  available: boolean;
  /** Present for versioned CLI harnesses after detection succeeds. */
  version?: string;
  descriptor: HarnessCapabilityDescriptor;
  /** Installed-version-aware states for the enabled capability domains. */
  effective?: {
    permissions: EffectivePermissionCapabilityState;
  };
}

export type CompatibilityConsumerTarget =
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP };

export interface CompatibilityDiagnostic {
  /**
   * Stable identity is `code` plus the structured location fields. Consumers
   * must not parse `message`; user-facing prose belongs in shared diagnostic
   * message helpers.
   */
  code: string;
  severity: CompatibilityDiagnosticSeverity;
  harnessId: HarnessId;
  capability: string;
  /** Definition-level AI target that consumes the resolved value. */
  consumer?: CompatibilityConsumerTarget;
  /** RFC 6901 JSON Pointer to the authored value. */
  propertyPointer?: string;
  sourceTier?: CompatibilitySourceTier;
  state: EffectiveCapabilityState;
  message: string;
  remediation?: string;
}

export interface CompatibilityDiagnosticMessageContext {
  harnessId: HarnessId;
  capability: string;
}

/** Shared user-facing prose for compatibility diagnostics. */
export function getCompatibilityDiagnosticMessage(
  code: string,
  context: CompatibilityDiagnosticMessageContext
): string {
  const capabilityLabel =
    context.capability === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
      ? "Allowed Tools"
      : "Denied Tools";

  switch (code) {
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE:
      return `The ${context.harnessId} harness is unavailable for this execution target.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED:
      return `Permission mode is not supported by the ${context.harnessId} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL:
      return `Permission mode is only partially translated by the ${context.harnessId} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED:
      return `Permission mode support is unverified for the installed ${context.harnessId} version.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED:
      return `${capabilityLabel} are NOT ENFORCED by the ${context.harnessId} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL:
      return `${capabilityLabel} are only partially translated by the ${context.harnessId} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED:
      return `${capabilityLabel} support is unverified for the installed ${context.harnessId} version.`;
    default:
      return `Compatibility for ${context.capability} is unavailable for the ${context.harnessId} harness.`;
  }
}
