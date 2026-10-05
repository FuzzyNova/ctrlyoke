import {
  CAPABILITY_DOMAINS,
  getHarnessDisplayName,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_BASES,
  CAPABILITY_VERIFICATION_KINDS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  MCP_CAPABILITY_KEYS,
  PERMISSION_CAPABILITY_KEYS,
  PROMPT_INPUT_CAPABILITY_KEYS,
  type HarnessId,
  type HookEvent,
} from "./DashboardConstants";
import { HOOK_EVENT_OPTIONS_META } from "./SchemaUiMetadata";

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
  MCP_FILTERING_UNSUPPORTED:
    "compatibility.mcp.perServerToolFiltering.unsupported",
  MCP_FILTERING_PARTIAL: "compatibility.mcp.perServerToolFiltering.partial",
  MCP_FILTERING_UNVERIFIED:
    "compatibility.mcp.perServerToolFiltering.unverified",
  IMAGE_INPUT_UNSUPPORTED: "compatibility.promptInputs.images.unsupported",
  IMAGE_INPUT_PARTIAL: "compatibility.promptInputs.images.partial",
  IMAGE_INPUT_UNVERIFIED: "compatibility.promptInputs.images.unverified",
  PERMISSION_TRANSLATION_LOSSY: "compatibility.permissions.translation.lossy",
  HOOK_EVENT_UNSUPPORTED: "compatibility.hooks.event.unsupported",
  HOOK_EVENT_PARTIAL: "compatibility.hooks.event.partial",
  HOOK_EVENT_UNVERIFIED: "compatibility.hooks.event.unverified",
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
  [K in keyof T]: NonNullable<T[K]> extends CapabilityDeclaration
    ? EffectiveCapabilityState
    : NonNullable<T[K]> extends object
      ? CapabilityDomainState<NonNullable<T[K]>>
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

export const MCP_CAVEAT_CODES = {
  NO_PER_SERVER_FILTERING: "mcp.noPerServerFiltering",
} as const;

export const PROMPT_INPUT_CAVEAT_CODES = {
  NO_NATIVE_IMAGE_ATTACHMENT: "promptInputs.noNativeImageAttachment",
} as const;

export const HOOK_CAVEAT_CODES = {
  /** The harness has no native event ctrlyoke can translate the hook to. */
  NO_NATIVE_EVENT: "hooks.noNativeEvent",
  /** The harness can miss the main session's creation event (OpenCode #14808). */
  MAIN_SESSION_START_UNRELIABLE: "hooks.mainSessionStartUnreliable",
  /** The hook fires, but the harness's decision-response contract is unverified. */
  UNVERIFIED_DECISION_CONTRACT: "hooks.unverifiedDecisionContract",
} as const;

export type PermissionCaveatCode =
  (typeof PERMISSION_CAVEAT_CODES)[keyof typeof PERMISSION_CAVEAT_CODES];

export type McpCaveatCode =
  (typeof MCP_CAVEAT_CODES)[keyof typeof MCP_CAVEAT_CODES];

export type PromptInputCaveatCode =
  (typeof PROMPT_INPUT_CAVEAT_CODES)[keyof typeof PROMPT_INPUT_CAVEAT_CODES];

export type HookCaveatCode =
  (typeof HOOK_CAVEAT_CODES)[keyof typeof HOOK_CAVEAT_CODES];

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
    case MCP_CAVEAT_CODES.NO_PER_SERVER_FILTERING:
      return "because this harness exposes no documented per-server tool filtering mechanism";
    case PROMPT_INPUT_CAVEAT_CODES.NO_NATIVE_IMAGE_ATTACHMENT:
      return "because this harness has no verified native image-attachment path in the ctrlyoke CLI adapter";
    case HOOK_CAVEAT_CODES.NO_NATIVE_EVENT:
      return "because this harness exposes no native event ctrlyoke can map it to";
    case HOOK_CAVEAT_CODES.MAIN_SESSION_START_UNRELIABLE:
      return "because this harness can start the main session before its plugin is listening, so the hook may not fire for it";
    case HOOK_CAVEAT_CODES.UNVERIFIED_DECISION_CONTRACT:
      return "because the hook fires but this harness's allow/deny response contract is unverified, so a returned decision may be ignored";
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
      : context.capability === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
        ? "Denied Tools"
        : context.capability === MCP_CAPABILITY_KEYS.PER_SERVER_TOOL_FILTERING
          ? "Per-server MCP tool filters"
          : context.capability === PROMPT_INPUT_CAPABILITY_KEYS.IMAGES
            ? "Image prompt inputs"
            : hookEventLabel(context.capability);
  // Render the display name here so no consumer has to rewrite the prose.
  const harness = getHarnessDisplayName(context.harnessId);
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNSUPPORTED:
      return withCaveat(
        `Per-server MCP tool filters are NOT ENFORCED by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_PARTIAL:
      return withCaveat(
        `Per-server MCP tool filters are only partially translated by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNVERIFIED:
      return `Per-server MCP tool filter support is unverified for the installed ${harness} version.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNSUPPORTED:
      return withCaveat(
        `Image prompt inputs are NOT ATTACHED by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_PARTIAL:
      return withCaveat(
        `Image prompt inputs are only partially translated by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNVERIFIED:
      return `Image prompt input support is unverified for the installed ${harness} version.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return `${capabilityLabel} include rules that are only partially represented by the ${harness} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED:
      return withCaveat(
        `The ${harness} harness does not support the ${hookEventLabel(context.capability)} hook event`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_PARTIAL:
      return withCaveat(
        `The ${hookEventLabel(context.capability)} hook event is only partially supported by the ${harness} harness`
      );
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNVERIFIED:
      return `Support for the ${hookEventLabel(context.capability)} hook event is unverified for the installed ${harness} version.`;
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNSUPPORTED:
      return "Remove the server filter or select a harness with verified per-server MCP filtering.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_PARTIAL:
      return "Use only the supported server filter subset or select a harness with exact per-server MCP filtering.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNVERIFIED:
      return "Install a harness version covered by the MCP filtering evidence or review this finding manually.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNSUPPORTED:
      return "Remove the image reference or select a harness with verified native image-input support.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_PARTIAL:
      return "Use a harness with exact image-input support when the image must reach the model as vision input.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNVERIFIED:
      return "Install a harness version covered by the image-input evidence or review this finding manually.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return "Use a harness with exact translation support or simplify the affected rules.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED:
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_PARTIAL:
    case COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNVERIFIED:
      return "Remove the affected hook event or select a harness with verified support for it.";
    default:
      return undefined;
  }
}

/**
 * Resolve the shared remediation for a static capability declaration.
 *
 * Documentation and other registry-level consumers need the same guidance as
 * authored-workflow diagnostics, but do not have an installed version or a
 * workflow consumer from which to build a diagnostic. Keep that mapping here
 * so those consumers do not grow a second capability taxonomy.
 */
export function getCompatibilityDeclarationRemediation(
  domain: CapabilityDomain,
  capability: string,
  declaration: CapabilityDeclaration
): string | undefined {
  const code = getDeclarationDiagnosticCode(
    domain,
    capability,
    declaration.fidelity
  );
  return code ? getCompatibilityDiagnosticRemediation(code) : undefined;
}

function getDeclarationDiagnosticCode(
  domain: CapabilityDomain,
  capability: string,
  fidelity: CapabilityFidelity
): string | undefined {
  if (fidelity === CAPABILITY_FIDELITIES.EXACT) {
    return undefined;
  }

  switch (domain) {
    case CAPABILITY_DOMAINS.PERMISSIONS:
      switch (capability) {
        case PERMISSION_CAPABILITY_KEYS.MODE:
          return fidelity === CAPABILITY_FIDELITIES.PARTIAL
            ? COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL
            : COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED;
        case PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS:
          return fidelity === CAPABILITY_FIDELITIES.PARTIAL
            ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL
            : COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED;
        case PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS:
          return fidelity === CAPABILITY_FIDELITIES.PARTIAL
            ? COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL
            : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED;
        default:
          return undefined;
      }
    case CAPABILITY_DOMAINS.MCP:
      return fidelity === CAPABILITY_FIDELITIES.PARTIAL
        ? COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_PARTIAL
        : COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNSUPPORTED;
    case CAPABILITY_DOMAINS.PROMPT_INPUTS:
      return fidelity === CAPABILITY_FIDELITIES.PARTIAL
        ? COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_PARTIAL
        : COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNSUPPORTED;
    case CAPABILITY_DOMAINS.HOOKS:
      return fidelity === CAPABILITY_FIDELITIES.PARTIAL
        ? COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_PARTIAL
        : COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED;
  }
}

function hookEventLabel(capability: string): string {
  return HOOK_EVENT_OPTIONS_META[capability as HookEvent]?.label ?? capability;
}
