import {
  CAPABILITY_DOMAINS,
  HARNESS_INFO,
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
  ALLOWED_TOOLS_UNVERIFIED: "compatibility.permissions.allowedTools.unverified",
  DENIED_TOOLS_NOT_ENFORCED:
    "compatibility.permissions.deniedTools.notEnforced",
  DENIED_TOOLS_PARTIAL: "compatibility.permissions.deniedTools.partial",
  DENIED_TOOLS_UNVERIFIED: "compatibility.permissions.deniedTools.unverified",
  PERMISSION_TRANSLATION_LOSSY: "compatibility.permissions.translation.lossy",
  SECRETS_UNRESOLVED: "secrets.unresolved",
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

export interface CapabilityDomainDescriptorMap {
  promptInputs: {
    images: CapabilityDeclaration;
  };
  permissions: PermissionCapabilityDescriptor;
  hooks: Partial<Record<HookEvent, CapabilityDeclaration>>;
  mcp: {
    perServerToolFiltering: CapabilityDeclaration;
  };
}

export type CapabilityDomainState<T> = {
  [K in keyof T]: T[K] extends CapabilityDeclaration
    ? EffectiveCapabilityState
    : T[K] extends object
      ? CapabilityDomainState<T[K]>
      : never;
};

export type EffectivePermissionCapabilityState =
  CapabilityDomainState<PermissionCapabilityDescriptor>;

export type EffectiveCapabilityDomainStateMap = Partial<{
  [D in CapabilityDomain]: CapabilityDomainState<
    CapabilityDomainDescriptorMap[D]
  >;
}>;

/** Harness-owned declarations exposed through the shared provider boundary. */
export type HarnessCapabilityFacts = Partial<CapabilityDomainDescriptorMap>;

export type HarnessCapabilityDescriptor = {
  harnessId: HarnessId;
} & HarnessCapabilityFacts;

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
  effective: EffectiveCapabilityDomainStateMap;
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
  /**
   * The declaration's `caveatCode`, when the diagnostic concerns a capability
   * that is unsupported or partially supported. Folded into the message as
   * the "why", so an unsupported capability reads as a known architectural
   * fact rather than an open question.
   */
  caveatCode?: string;
}

/**
 * Stable caveat codes a harness adapter may attach to a declaration to explain
 * *why* a capability is limited. The code is the harness-owned fact; the prose
 * lives in `getCompatibilityCaveatMessage()` so no consumer — least of all a
 * React component — needs a harness switch to render it.
 */
export const PERMISSION_CAVEAT_CODES = {
  SANDBOX_APPROVAL_MODES: "permissions.sandboxApprovalModes",
  COARSE_PERMISSION_MODES: "permissions.coarsePermissionModes",
} as const;

export type PermissionCaveatCode =
  (typeof PERMISSION_CAVEAT_CODES)[keyof typeof PERMISSION_CAVEAT_CODES];

/**
 * Resolve a declaration's `caveatCode` into a trailing "because ..." clause.
 * Returns undefined when the declaration carries no caveat, so callers can
 * omit the clause rather than inventing a reason.
 */
export function getCompatibilityCaveatMessage(
  caveatCode: string | undefined
): string | undefined {
  switch (caveatCode) {
    case PERMISSION_CAVEAT_CODES.SANDBOX_APPROVAL_MODES:
      return "because this harness uses sandbox/approval modes instead of individual tool patterns";
    case PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES:
      return "because this harness uses coarse permission modes instead of individual tool patterns";
    default:
      return undefined;
  }
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
  // Render the display name here so no consumer has to rewrite the prose.
  const harness = HARNESS_INFO[context.harnessId]?.name ?? context.harnessId;
  const caveat = getCompatibilityCaveatMessage(context.caveatCode);
  // Fold the harness-owned "why" into the sentence instead of leaving a bare
  // fidelity fact — an unsupported capability is a known architectural
  // limitation, not an open question, so the reason belongs in the same
  // sentence rather than a separate lookup.
  const withCaveat = (sentence: string): string =>
    caveat ? `${sentence} ${caveat}.` : `${sentence}.`;

  switch (code) {
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE:
      return `The ${harness} harness is unavailable for this execution target.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED:
      return withCaveat(
        `Permission mode is not supported by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL:
      return withCaveat(
        `Permission mode is only partially translated by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED:
      return `Permission mode support is unverified for the installed ${harness} version.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED:
      return withCaveat(
        `${capabilityLabel} are NOT ENFORCED by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL:
      return withCaveat(
        `${capabilityLabel} are only partially translated by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED:
      return `${capabilityLabel} support is unverified for the installed ${harness} version.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return `${capabilityLabel} include rules that are only partially represented by the ${harness} harness.`;
    default:
      return `Compatibility for ${context.capability} is unavailable for the ${harness} harness.`;
  }
}

/** Shared remediation prose for compatibility diagnostics. */
export function getCompatibilityDiagnosticRemediation(
  code: string
): string | undefined {
  switch (code) {
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE:
      return "Install the harness, make it available on PATH, or select an installed harness.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED:
      return "Choose a supported permission mode for this harness or select another harness.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL:
      return "Use a harness with exact permission-mode support when the distinction matters.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED:
      return "Remove the rule or select a harness that enforces individual tool patterns.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL:
      return "Narrow the rule to the supported subset or select a harness with exact list support.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED:
      return "Install a harness version covered by the compatibility evidence or review this finding manually.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return "Use a harness with exact translation support or simplify the affected rules.";
    default:
      return undefined;
  }
}
