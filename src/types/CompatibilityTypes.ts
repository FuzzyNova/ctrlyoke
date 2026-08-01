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
  type HarnessId,
  type HookEvent,
} from "./DashboardConstants";

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
