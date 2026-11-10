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
  SANDBOX_CAPABILITY_KEYS,
  type HarnessId,
  type HookEvent,
  type ExecutionMode,
} from "./DashboardConstants";
import { HOOK_EVENT_OPTIONS_META } from "./SchemaUiMetadata";
import {
  formatHarnessVersionGuidance,
  type HarnessVersionAssessment,
} from "../utils/HarnessVersion";

export const COMPATIBILITY_DIAGNOSTIC_CODES = {
  HARNESS_UNAVAILABLE: "compatibility.harness.unavailable",
  /** Installed but older than `versionPolicy.minimum`: it still runs. */
  HARNESS_BELOW_MINIMUM: "compatibility.harness.belowMinimum",
  PERMISSION_MODE_UNSUPPORTED: "compatibility.permissions.mode.unsupported",
  PERMISSION_MODE_PARTIAL: "compatibility.permissions.mode.partial",
  PERMISSION_MODE_UNVERIFIED: "compatibility.permissions.mode.unverified",
  ALLOWED_TOOLS_NOT_ENFORCED:
    "compatibility.permissions.allowedTools.notEnforced",
  ALLOWED_TOOLS_PARTIAL: "compatibility.permissions.allowedTools.partial",
  ALLOWED_TOOLS_ENFORCED_WITH_CAVEAT:
    "compatibility.permissions.allowedTools.enforcedWithCaveat",
  ALLOWED_TOOLS_UNVERIFIED: "compatibility.permissions.allowedTools.unverified",
  DENIED_TOOLS_NOT_ENFORCED:
    "compatibility.permissions.deniedTools.notEnforced",
  DENIED_TOOLS_PARTIAL: "compatibility.permissions.deniedTools.partial",
  DENIED_TOOLS_ENFORCED_WITH_CAVEAT:
    "compatibility.permissions.deniedTools.enforcedWithCaveat",
  DENIED_TOOLS_UNVERIFIED: "compatibility.permissions.deniedTools.unverified",
  MCP_FILTERING_UNSUPPORTED:
    "compatibility.mcp.perServerToolFiltering.unsupported",
  MCP_FILTERING_PARTIAL: "compatibility.mcp.perServerToolFiltering.partial",
  MCP_FILTERING_UNVERIFIED:
    "compatibility.mcp.perServerToolFiltering.unverified",
  IMAGE_INPUT_UNSUPPORTED: "compatibility.promptInputs.images.unsupported",
  IMAGE_INPUT_PARTIAL: "compatibility.promptInputs.images.partial",
  IMAGE_INPUT_UNVERIFIED: "compatibility.promptInputs.images.unverified",
  SANDBOX_UNSUPPORTED: "compatibility.sandbox.terminal.unsupported",
  /** `defaults.sandbox: true` on a harness that can't sandbox: skipped, not refused. */
  SANDBOX_DEFAULT_SKIPPED: "compatibility.sandbox.terminal.defaultSkipped",
  /** `sandboxMode` set while `sandbox` does not resolve to `true`. */
  SANDBOX_MODE_UNUSED: "compatibility.sandbox.mode.unused",
  SANDBOX_SETTINGS_OVERRIDDEN:
    "compatibility.sandbox.terminal.settingsOverridden",
  PERMISSION_TRANSLATION_LOSSY: "compatibility.permissions.translation.lossy",
  ANTIGRAVITY_SETTINGS_COLLISION:
    "compatibility.permissions.antigravitySettingsCollision",
  MCP_SERVER_ID_SANITIZED: "compatibility.mcp.serverId.sanitized",
  MCP_SERVER_ID_COLLISION: "compatibility.mcp.serverId.collision",
  MCP_TOOL_NAME_INVALID: "compatibility.mcp.toolName.invalid",
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

export interface CapabilityVerification {
  kind: CapabilityVerificationKind;
  reference: string;
  basis: CapabilityVerificationBasis;
  /** Ranges for which this exact capability claim has evidence. */
  readonly verifiedVersions: readonly HarnessVersionRange[];
}

export interface CapabilityDeclaration {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  verification?: CapabilityVerification;
  caveatCode?: CompatibilityCaveatCode;
  remediationCode?: string;
  /** Capability refinements for harness execution modes. */
  modeOverrides?: Partial<Record<ExecutionMode, CapabilityModeOverride>>;
}

/**
 * The live suite (`npm run test:harness`) that proves a capability claim
 * against the real CLI, one case per claim.
 */
const CAPABILITY_SUITE_REFERENCE =
  "src/test/harness/capabilities.harness.test.ts";

/** Evidence for a claim the capability suite proves. */
export function capabilitySuiteVerification(
  verifiedVersions: readonly HarnessVersionRange[]
): CapabilityVerification {
  return {
    kind: CAPABILITY_VERIFICATION_KINDS.BEHAVIORAL_TEST,
    reference: CAPABILITY_SUITE_REFERENCE,
    basis: CAPABILITY_VERIFICATION_BASES.CLI_VERSION,
    verifiedVersions,
  };
}

export interface CapabilityModeOverride {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  caveatCode?: CompatibilityCaveatCode;
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

export interface CapabilityDomainDescriptorMap {
  promptInputs: {
    images: CapabilityDeclaration;
  };
  permissions: PermissionCapabilityDescriptor;
  hooks: Partial<Record<HookEvent, CapabilityDeclaration>>;
  mcp: {
    perServerToolFiltering: CapabilityDeclaration;
  };
  sandbox: { terminal: CapabilityDeclaration };
}

export const SANDBOX_CAVEAT_CODE = {
  NETWORK_FOLLOWS_HARNESS_POLICY: "network-follows-harness-policy",
  FILE_TOOLS_BEST_EFFORT: "file-tools-best-effort",
  CLAUDE_WINDOWS_UNAVAILABLE: "claude-sandbox-windows-unavailable",
  MCP_SERVERS_NOT_CONTAINED: "mcp-servers-not-contained",
  COPILOT_UNUSABLE: "copilot-sandbox-unusable",
  ANTIGRAVITY_UNUSABLE: "antigravity-sandbox-unusable",
  QWEN_UNUSABLE: "qwen-sandbox-unusable",
  OPENCODE_UNUSABLE: "opencode-sandbox-unusable",
} as const;
export type SandboxCaveatCode =
  (typeof SANDBOX_CAVEAT_CODE)[keyof typeof SANDBOX_CAVEAT_CODE];

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
  /** `version` assessed against the harness's `versionPolicy`. */
  versionAssessment?: HarnessVersionAssessment;
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
  caveatCode?: CompatibilityCaveatCode;
  /** The installed CLI's version assessment, for version diagnostics. */
  version?: HarnessVersionAssessment;
}

/**
 * Stable caveat codes a harness adapter may attach to a declaration to explain
 * *why* a capability is limited. The code is the harness-owned fact; the prose
 * lives in `getCompatibilityCaveatMessage()` so no consumer — least of all a
 * React component — needs a harness switch to render it.
 */
export const PERMISSION_CAVEAT_CODES = {
  SANDBOX_APPROVAL_MODES: "permissions.sandboxApprovalModes",
  ANTIGRAVITY_RULE_TRANSLATION: "permissions.antigravityRuleTranslation",
  CLAUDE_PREAPPROVED_SETTINGS: "permissions.claudePreapprovedSettings",
  MCP_TOOL_DENIALS_ONLY: "permissions.mcpToolDenialsOnly",
} as const;

export const MCP_CAVEAT_CODES = {
  NO_PER_SERVER_FILTERING: "mcp.noPerServerFiltering",
} as const;

export const HOOK_CAVEAT_CODES = {
  /** The harness has no native event ctrlyoke can translate the hook to. */
  NO_NATIVE_EVENT: "hooks.noNativeEvent",
  /** The harness can miss the main session's creation event (OpenCode #14808). */
  MAIN_SESSION_START_UNRELIABLE: "hooks.mainSessionStartUnreliable",
  /**
   * The harness can exit without waiting for the hook (Claude Code's
   * StopFailure after a rejected request), so a slow hook is cut off.
   */
  NOT_AWAITED_ON_EXIT: "hooks.notAwaitedOnExit",
  /** The hook fires, but the harness's decision-response contract is unverified. */
  UNVERIFIED_DECISION_CONTRACT: "hooks.unverifiedDecisionContract",
  /** The hook fires, but cannot block the tool call. */
  CANNOT_BLOCK: "hooks.cannotBlock",
  /** The hook fires as a notification, but cannot return a permission decision. */
  DECISION_UNSUPPORTED: "hooks.decisionUnsupported",
} as const;

export type PermissionCaveatCode =
  (typeof PERMISSION_CAVEAT_CODES)[keyof typeof PERMISSION_CAVEAT_CODES];

export type McpCaveatCode =
  (typeof MCP_CAVEAT_CODES)[keyof typeof MCP_CAVEAT_CODES];

export type HookCaveatCode =
  (typeof HOOK_CAVEAT_CODES)[keyof typeof HOOK_CAVEAT_CODES];

export type CompatibilityCaveatCode =
  PermissionCaveatCode | McpCaveatCode | HookCaveatCode | SandboxCaveatCode;

/**
 * Caveats that explain a risk alongside a capability that is enforced. Every
 * other caveat is a reason the capability is limited, and its message must be
 * a "because …" clause so it reads after any sentence it is appended to.
 */
const ADVISORY_CAVEAT_CODES = {
  CLAUDE_PREAPPROVED_SETTINGS:
    PERMISSION_CAVEAT_CODES.CLAUDE_PREAPPROVED_SETTINGS,
} as const;

export function isAdvisoryCaveat(
  code: CompatibilityCaveatCode | undefined
): boolean {
  return code === ADVISORY_CAVEAT_CODES.CLAUDE_PREAPPROVED_SETTINGS;
}

/**
 * Resolve a declaration's `caveatCode` into shared explanatory prose.
 * Returns undefined when the declaration carries no caveat, so callers can
 * omit the clause rather than inventing a reason.
 */
export function getCompatibilityCaveatMessage(
  caveatCode: string | undefined
): string | undefined {
  switch (caveatCode) {
    case PERMISSION_CAVEAT_CODES.SANDBOX_APPROVAL_MODES:
      return "because this harness uses sandbox/approval modes instead of individual tool patterns";
    case PERMISSION_CAVEAT_CODES.ANTIGRAVITY_RULE_TRANSLATION:
      return "because Antigravity cannot translate web search or subagent tools, list/search denials, or allow a command chain piecemeal";
    case PERMISSION_CAVEAT_CODES.CLAUDE_PREAPPROVED_SETTINGS:
      return "Claude's own settings allow rules can add to this list in headless mode";
    case PERMISSION_CAVEAT_CODES.MCP_TOOL_DENIALS_ONLY:
      return "because this harness enforces only mcp__<server>__<tool> denials for MCP servers the workflow attaches, and uses sandbox/approval modes instead of other tool patterns";
    case MCP_CAVEAT_CODES.NO_PER_SERVER_FILTERING:
      return "because this harness exposes no documented per-server tool filtering mechanism";
    case HOOK_CAVEAT_CODES.NO_NATIVE_EVENT:
      return "because this harness exposes no native event ctrlyoke can map it to";
    case HOOK_CAVEAT_CODES.MAIN_SESSION_START_UNRELIABLE:
      return "because this harness can start the main session before its plugin is listening, so the hook may not fire for it";
    case HOOK_CAVEAT_CODES.NOT_AWAITED_ON_EXIT:
      return "because this harness can exit without waiting for the hook, so a hook that takes more than a moment can be cut off before it finishes";
    case HOOK_CAVEAT_CODES.UNVERIFIED_DECISION_CONTRACT:
      return "because the hook fires but this harness's allow/deny response contract is unverified, so a returned decision may be ignored";
    case HOOK_CAVEAT_CODES.CANNOT_BLOCK:
      return "because this harness's pre-tool hook fires but cannot block the tool call";
    case HOOK_CAVEAT_CODES.DECISION_UNSUPPORTED:
      return "because OpenCode delivers this event as notification-only; allow and deny decisions are not supported";
    case SANDBOX_CAVEAT_CODE.NETWORK_FOLLOWS_HARNESS_POLICY:
      return "because network access is set by the harness's own sandbox settings, not by ctrlyoke, and Codex's Windows sandbox does not block network access at all";
    case SANDBOX_CAVEAT_CODE.FILE_TOOLS_BEST_EFFORT:
      return "because built-in Write and Edit tools run outside the terminal sandbox and follow tool permissions instead";
    case SANDBOX_CAVEAT_CODE.CLAUDE_WINDOWS_UNAVAILABLE:
      return "because Claude Code's Bash sandbox is not available on Windows, and Claude refuses to start when a required sandbox is unavailable";
    case SANDBOX_CAVEAT_CODE.MCP_SERVERS_NOT_CONTAINED:
      return "because MCP servers run outside the terminal sandbox";
    case SANDBOX_CAVEAT_CODE.COPILOT_UNUSABLE:
      return "because Copilot also sandboxes ctrlyoke MCP servers and hook scripts, which cannot start inside it";
    case SANDBOX_CAVEAT_CODE.ANTIGRAVITY_UNUSABLE:
      return "because Antigravity makes the workspace read-only while leaving outside paths writable";
    case SANDBOX_CAVEAT_CODE.QWEN_UNUSABLE:
      return "because Qwen's sandbox re-launches the CLI and disables MCP servers and executable hooks";
    case SANDBOX_CAVEAT_CODE.OPENCODE_UNUSABLE:
      return "because OpenCode has no supported per-run terminal sandbox mechanism";
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
    caveat
      ? `${sentence}${isAdvisoryCaveat(context.caveatCode) ? `; ${caveat}` : ` ${caveat}`}.`
      : `${sentence}.`;

  switch (code) {
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE:
      return `The ${harness} harness is unavailable for this execution target.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_BELOW_MINIMUM:
      return (
        formatHarnessVersionGuidance(harness, context.version) ??
        `${harness} is older than the minimum supported version and may not work correctly.`
      );
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_ENFORCED_WITH_CAVEAT:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_ENFORCED_WITH_CAVEAT:
      return withCaveat(
        `${capabilityLabel} are enforced by the ${harness} harness`
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED:
      return `${harness} can't sandbox commands, so this step will fail to start.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED:
      return `${harness} can't sandbox commands, so the default Sandbox On is skipped for this step and ${harness}'s own sandbox settings apply.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_MODE_UNUSED:
      return "Sandbox mode has no effect because Sandbox is not On for this step.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return `${capabilityLabel} include rules that are only partially represented by the ${harness} harness.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_SANITIZED:
      return `Antigravity MCP server ids must match [A-Za-z0-9_-]; ids are written after replacing other characters with underscores.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_COLLISION:
      return `Multiple Antigravity MCP server ids become the same id after replacing characters outside [A-Za-z0-9_-] with underscores; one server entry will replace another.`;
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_TOOL_NAME_INVALID:
      return `An Antigravity MCP tool name listed in allowedTools or deniedTools contains unsupported characters or makes the generated name exceed 64 characters; ctrlyoke cannot rename server tools.`;
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_BELOW_MINIMUM:
      return "Update the harness CLI. ctrlyoke still runs it, but features it relies on may be missing.";
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_ENFORCED_WITH_CAVEAT:
    case COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_ENFORCED_WITH_CAVEAT:
      return undefined;
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
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED:
      return "Turn Sandbox off or select a harness with verified terminal sandbox support.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED:
      return "Run the step on Codex or Claude Code, or set Sandbox to Off or None on the workflow or step.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_MODE_UNUSED:
      return "Turn Sandbox on, or remove the Sandbox mode override.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNSUPPORTED:
      return "Remove the image reference or select a harness with verified native image-input support.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_PARTIAL:
      return "Use a harness with exact image-input support when the image must reach the model as vision input.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNVERIFIED:
      return "Install a harness version covered by the image-input evidence or review this finding manually.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY:
      return "Use a harness with exact translation support or simplify the affected rules.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_SANITIZED:
      return "Use only letters, numbers, underscores, and hyphens in Antigravity MCP server ids to keep ids unchanged.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_COLLISION:
      return "Rename the colliding MCP servers so their Antigravity-normalized ids are unique.";
    case COMPATIBILITY_DIAGNOSTIC_CODES.MCP_TOOL_NAME_INVALID:
      return "Rename the tool in its MCP server, or use a tool name that Antigravity accepts.";
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
 *
 * @public Loaded from the compiled `out/` by `scripts/generate-compatibility-docs.mjs`.
 */
export function getCompatibilityDeclarationRemediation(
  domain: CapabilityDomain,
  capability: string,
  declaration: CapabilityDeclaration
): string | undefined {
  const code = getDeclarationDiagnosticCode(
    domain,
    capability,
    declaration.fidelity,
    declaration.caveatCode
  );
  return code ? getCompatibilityDiagnosticRemediation(code) : undefined;
}

/**
 * Diagnostic code for a non-exact permission capability. Shared by the
 * author-time analyzer and the launch-time mappers so both report the same
 * fact with the same code and prose, which is what lets the run's status
 * reporter dedupe them into one message.
 */
export function getPermissionFidelityDiagnosticCode(
  capability: string,
  fidelity: CapabilityFidelity,
  caveatCode?: CompatibilityCaveatCode
): string | undefined {
  if (fidelity === CAPABILITY_FIDELITIES.EXACT) {
    return undefined;
  }
  const partial = fidelity === CAPABILITY_FIDELITIES.PARTIAL;
  const advisory = partial && isAdvisoryCaveat(caveatCode);
  switch (capability) {
    case PERMISSION_CAPABILITY_KEYS.MODE:
      return partial
        ? COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL
        : COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED;
    case PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS:
      return advisory
        ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_ENFORCED_WITH_CAVEAT
        : partial
          ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL
          : COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED;
    case PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS:
      return advisory
        ? COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_ENFORCED_WITH_CAVEAT
        : partial
          ? COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL
          : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED;
    default:
      return undefined;
  }
}

/**
 * Severity for a permission fidelity diagnostic. Informational for a partial
 * fidelity with an advisory caveat, and for a tool list that is still the
 * shipped default (see `isShippedDefaultToolList`): nobody chose that list, so
 * a harness that can't enforce it is not something to warn about.
 */
export function getPermissionFidelityDiagnosticSeverity(
  fidelity: CapabilityFidelity,
  caveatCode?: CompatibilityCaveatCode,
  isShippedDefaultList = false
): CompatibilityDiagnosticSeverity {
  return isShippedDefaultList ||
    (fidelity === CAPABILITY_FIDELITIES.PARTIAL && isAdvisoryCaveat(caveatCode))
    ? COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO
    : COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING;
}

function getDeclarationDiagnosticCode(
  domain: CapabilityDomain,
  capability: string,
  fidelity: CapabilityFidelity,
  caveatCode?: CompatibilityCaveatCode
): string | undefined {
  if (fidelity === CAPABILITY_FIDELITIES.EXACT) {
    return undefined;
  }

  switch (domain) {
    case CAPABILITY_DOMAINS.PERMISSIONS:
      return getPermissionFidelityDiagnosticCode(
        capability,
        fidelity,
        caveatCode
      );
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
    case CAPABILITY_DOMAINS.SANDBOX:
      // Partial sandbox support has no per-step diagnostic; see analyzeSandbox.
      return fidelity === CAPABILITY_FIDELITIES.PARTIAL
        ? undefined
        : COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED;
  }
}

function hookEventLabel(capability: string): string {
  return HOOK_EVENT_OPTIONS_META[capability as HookEvent]?.label ?? capability;
}

/**
 * The diagnostic for `sandbox: true` on a harness that can't sandbox. Written
 * in the workflow or step it is an error and the launch is refused; inherited
 * from `defaults.sandbox` it is a warning and the step runs without ctrlyoke's
 * sandbox flags. Shared by the analyzer and the launch-time sandbox mappers.
 */
export function sandboxUnsupportedDiagnostic(input: {
  harnessId: HarnessId;
  fromDefaults: boolean;
  caveatCode?: CompatibilityCaveatCode;
  state?: EffectiveCapabilityState;
}): CompatibilityDiagnostic {
  const code = input.fromDefaults
    ? COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED
    : COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED;
  const capability = SANDBOX_CAPABILITY_KEYS.TERMINAL;
  const remediation = getCompatibilityDiagnosticRemediation(code);
  return {
    code,
    severity: input.fromDefaults
      ? COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
      : COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
    harnessId: input.harnessId,
    capability,
    state: input.state ?? {
      fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
      mechanism: CAPABILITY_MECHANISMS.NONE,
      verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
    },
    message: getCompatibilityDiagnosticMessage(code, {
      harnessId: input.harnessId,
      capability,
      caveatCode: input.caveatCode,
    }),
    ...(remediation ? { remediation } : {}),
  };
}

/**
 * `sandbox: true` that the step's own `additionalArgs` would replace or widen.
 * It is an error, so the launch is refused rather than run less contained
 * than Dry Run reports.
 */
export function sandboxOverriddenDiagnostic(
  harnessId: HarnessId,
  message: string
): CompatibilityDiagnostic {
  return {
    code: COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_SETTINGS_OVERRIDDEN,
    severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
    harnessId,
    capability: SANDBOX_CAPABILITY_KEYS.TERMINAL,
    state: {
      fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
    },
    message,
  };
}
