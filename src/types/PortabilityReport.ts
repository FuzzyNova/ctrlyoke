import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  HOOK_EVENT_ORDER,
  MCP_CAPABILITY_KEYS,
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  PROMPT_INPUT_CAPABILITY_KEYS,
  HARNESS_IDS,
  type HarnessId,
  type HookEvent,
} from "./DashboardConstants";
import type { PromptFile } from "./CtrlYokeTypes";
import type {
  CompatibilityConsumerTarget,
  CompatibilityDiagnostic,
  EffectiveCapabilityState,
  HarnessCapabilityRegistrySnapshot,
} from "./CompatibilityTypes";
import {
  analyzeCompatibility,
  enumerateCompatibilityTargets,
  retargetCompatibilityTargets,
  type CompatibilityExecutionTarget,
  type CompatibilityTargetResolver,
  type CompatibilityWorkspaceState,
} from "./CompatibilityAnalyzer";

export const PORTABILITY_ROW_STATUSES = {
  READY: "ready",
  LOSSY: "lossy",
  UNSUPPORTED: "unsupported",
  WORKSPACE_SIDE_EFFECTS: "workspace-side-effects",
} as const;

export type PortabilityRowStatus =
  (typeof PORTABILITY_ROW_STATUSES)[keyof typeof PORTABILITY_ROW_STATUSES];

export interface PortabilityReportInput {
  workflow: PromptFile;
  capabilities: HarnessCapabilityRegistrySnapshot;
  /** The shared effective-property resolver supplied by the host. */
  resolveTarget: CompatibilityTargetResolver;
  /**
   * Resolve image attachments using the same reference semantics as the
   * authoring surface. Image references are not execution properties, so the
   * projection accepts them as a pure input rather than parsing them again.
   */
  imageFileRefs?: (
    target: CompatibilityExecutionTarget
  ) => readonly string[] | undefined;
  workspace?: CompatibilityWorkspaceState;
}

export interface PortabilityDiagnostic extends CompatibilityDiagnostic {
  /** Stable identity derived only from structured diagnostic fields. */
  identity: string;
}

export interface PortabilityWorkspaceSideEffect {
  /** Stable identity derived from the affected consumer and property. */
  identity: string;
  harnessId: HarnessId;
  capability: string;
  consumer: CompatibilityConsumerTarget;
  sourceTier?: CompatibilityDiagnostic["sourceTier"];
  propertyPointer?: string;
  state: EffectiveCapabilityState;
}

export interface PortabilityHarnessRow {
  harnessId: HarnessId;
  status: PortabilityRowStatus;
  /** True when a used capability is not verified for the installed version. */
  unverified: boolean;
  diagnostics: readonly PortabilityDiagnostic[];
  workspaceSideEffects: readonly PortabilityWorkspaceSideEffect[];
}

export interface PortabilityReport {
  /** Report projection version, independent from the CLI JSON v1 contract. */
  schemaVersion: 1;
  /** Available harnesses only, in canonical HARNESS_IDS order. */
  rows: readonly PortabilityHarnessRow[];
  /** Harnesses omitted because their installed availability is false. */
  excludedHarnesses: readonly HarnessId[];
}

/**
 * Project one parsed workflow onto every available harness in a capability
 * snapshot. Consumer enumeration and effective-property resolution remain
 * owned by CompatibilityAnalyzer and the supplied shared resolver.
 */
export function buildPortabilityReport({
  workflow,
  capabilities,
  resolveTarget,
  imageFileRefs,
  workspace,
}: PortabilityReportInput): PortabilityReport {
  const consumers = enumerateCompatibilityTargets(workflow, resolveTarget).map(
    (target) => ({
      ...target,
      ...(imageFileRefs ? { imageFileRefs: imageFileRefs(target) } : {}),
    })
  );
  const rows: PortabilityHarnessRow[] = [];
  const excludedHarnesses: HarnessId[] = [];

  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    const installed = capabilities.harnesses[harnessId];
    if (!installed?.available) {
      excludedHarnesses.push(harnessId);
      continue;
    }

    const targets = retargetCompatibilityTargets(consumers, harnessId);
    const diagnostics = analyzeCompatibility({
      workflow,
      executionTargets: targets,
      capabilities,
      workspace,
    })
      .map((diagnostic) => withDiagnosticIdentity(diagnostic))
      .sort(compareDiagnostics);
    const workspaceSideEffects = targets
      .flatMap((target) =>
        collectWorkspaceSideEffects(target, installed, capabilities)
      )
      .sort(compareWorkspaceSideEffects);

    rows.push({
      harnessId,
      status: classifyRow(diagnostics, workspaceSideEffects),
      unverified: diagnostics.some(
        (diagnostic) =>
          diagnostic.state.verification ===
          CAPABILITY_VERIFICATION_STATUSES.UNKNOWN
      ),
      diagnostics,
      workspaceSideEffects,
    });
  }

  return {
    schemaVersion: 1,
    rows,
    excludedHarnesses,
  };
}

/** Stable identity for a compatibility finding; message text is excluded. */
export function getPortabilityDiagnosticIdentity(
  diagnostic: CompatibilityDiagnostic
): string {
  return JSON.stringify([
    diagnostic.harnessId,
    diagnostic.code,
    diagnostic.capability,
    diagnostic.consumer
      ? diagnostic.consumer.kind === FINAL_STEP_PHASES.QUEUE
        ? [diagnostic.consumer.kind, diagnostic.consumer.stepIndex]
        : [diagnostic.consumer.kind]
      : null,
    diagnostic.propertyPointer ?? null,
    diagnostic.sourceTier ?? null,
  ]);
}

function withDiagnosticIdentity(
  diagnostic: CompatibilityDiagnostic
): PortabilityDiagnostic {
  return {
    ...diagnostic,
    identity: getPortabilityDiagnosticIdentity(diagnostic),
  };
}

function classifyRow(
  diagnostics: readonly PortabilityDiagnostic[],
  workspaceSideEffects: readonly PortabilityWorkspaceSideEffect[]
): PortabilityRowStatus {
  // Severity and capability facts are intentionally read from structured
  // fields. Diagnostic prose and diagnostic-code suffixes are not classifiers.
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR ||
        diagnostic.state.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED
    )
  ) {
    return PORTABILITY_ROW_STATUSES.UNSUPPORTED;
  }
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.state.fidelity === CAPABILITY_FIDELITIES.PARTIAL
    )
  ) {
    return PORTABILITY_ROW_STATUSES.LOSSY;
  }
  if (workspaceSideEffects.length > 0) {
    return PORTABILITY_ROW_STATUSES.WORKSPACE_SIDE_EFFECTS;
  }
  return PORTABILITY_ROW_STATUSES.READY;
}

function collectWorkspaceSideEffects(
  target: CompatibilityExecutionTarget,
  installed: HarnessCapabilityRegistrySnapshot["harnesses"][HarnessId],
  capabilities: HarnessCapabilityRegistrySnapshot
): PortabilityWorkspaceSideEffect[] {
  const uses: UsedCapability[] = [];
  const properties = target.resolved.properties;
  const sourceTier = target.resolved.sources.toolPermissions;

  if (
    capabilities.enabledDomains.includes(CAPABILITY_DOMAINS.PERMISSIONS) &&
    properties.toolPermissions &&
    properties.toolPermissions.mode !== PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
  ) {
    const states = installed.effective.permissions;
    if (states) {
      addUsedCapability(
        uses,
        PERMISSION_CAPABILITY_KEYS.MODE,
        states.mode,
        target,
        sourceTier,
        getPermissionPointer(target, PERMISSION_CAPABILITY_KEYS.MODE)
      );
      if (properties.toolPermissions.allowedTools.length > 0) {
        addUsedCapability(
          uses,
          PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS,
          states.allowedTools,
          target,
          sourceTier,
          getPermissionPointer(target, PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS)
        );
      }
      if (properties.toolPermissions.deniedTools.length > 0) {
        addUsedCapability(
          uses,
          PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS,
          states.deniedTools,
          target,
          sourceTier,
          getPermissionPointer(target, PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS)
        );
      }
    }
  }

  if (capabilities.enabledDomains.includes(CAPABILITY_DOMAINS.HOOKS)) {
    const hooks = properties.hooks;
    const states = installed.effective.hooks;
    if (Array.isArray(hooks) && states) {
      for (const [hookIndex, hook] of hooks.entries()) {
        const event = hook.event as HookEvent;
        const state = states[event];
        if (!HOOK_EVENT_ORDER.includes(event) || !state) {
          continue;
        }
        const hookSource = target.resolved.sources.hooks;
        addUsedCapability(
          uses,
          event,
          state,
          target,
          hookSource,
          getHookPointer(target, hookSource, hookIndex)
        );
      }
    }
  }

  if (capabilities.enabledDomains.includes(CAPABILITY_DOMAINS.MCP)) {
    const servers = properties.mcpServers;
    const state = installed.effective.mcp?.perServerToolFiltering;
    if (Array.isArray(servers) && state) {
      for (const [serverIndex, server] of servers.entries()) {
        if (
          typeof server !== "object" ||
          server === null ||
          (server.deniedTools?.length ?? 0) === 0
        ) {
          continue;
        }
        const mcpSource = target.resolved.sources.mcpServers;
        addUsedCapability(
          uses,
          MCP_CAPABILITY_KEYS.PER_SERVER_TOOL_FILTERING,
          state,
          target,
          mcpSource,
          getMcpPointer(target, mcpSource, serverIndex)
        );
      }
    }
  }

  if (
    capabilities.enabledDomains.includes(CAPABILITY_DOMAINS.PROMPT_INPUTS) &&
    target.imageFileRefs &&
    target.imageFileRefs.length > 0
  ) {
    const state = installed.effective.promptInputs?.images;
    if (state) {
      addUsedCapability(
        uses,
        PROMPT_INPUT_CAPABILITY_KEYS.IMAGES,
        state,
        target,
        COMPATIBILITY_SOURCE_TIERS.PROMPT,
        target.consumer.kind === FINAL_STEP_PHASES.QUEUE
          ? `/steps/${target.consumer.stepIndex}/prompt`
          : "/finalStep/prompt"
      );
    }
  }

  return uses
    .filter(
      (use) =>
        use.state.mechanism === CAPABILITY_MECHANISMS.WORKSPACE_CONFIG ||
        use.state.mechanism === CAPABILITY_MECHANISMS.MIXED
    )
    .map((use) => ({
      identity: getWorkspaceSideEffectIdentity(use),
      harnessId: target.resolved.properties.harness,
      capability: use.capability,
      consumer: use.consumer,
      ...(use.sourceTier ? { sourceTier: use.sourceTier } : {}),
      ...(use.propertyPointer ? { propertyPointer: use.propertyPointer } : {}),
      state: use.state,
    }));
}

interface UsedCapability {
  capability: string;
  consumer: CompatibilityConsumerTarget;
  sourceTier?: CompatibilityDiagnostic["sourceTier"];
  propertyPointer?: string;
  state: EffectiveCapabilityState;
}

function addUsedCapability(
  uses: UsedCapability[],
  capability: string,
  state: EffectiveCapabilityState | undefined,
  target: CompatibilityExecutionTarget,
  sourceTier: CompatibilityDiagnostic["sourceTier"],
  propertyPointer: string | undefined
): void {
  if (!state) {
    return;
  }
  uses.push({
    capability,
    consumer: target.consumer,
    ...(sourceTier ? { sourceTier } : {}),
    ...(propertyPointer ? { propertyPointer } : {}),
    state,
  });
}

function getPermissionPointer(
  target: CompatibilityExecutionTarget,
  key: string
): string | undefined {
  const sourceTier = target.resolved.sources.toolPermissions;
  if (!sourceTier || sourceTier === COMPATIBILITY_SOURCE_TIERS.DEFAULTS) {
    return undefined;
  }
  const base =
    target.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${target.consumer.stepIndex}`
      : "/finalStep";
  return sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
    ? `${base}/toolPermissions/${key}`
    : `/toolPermissions/${key}`;
}

function getHookPointer(
  target: CompatibilityExecutionTarget,
  sourceTier: CompatibilityDiagnostic["sourceTier"],
  hookIndex: number
): string | undefined {
  const base =
    target.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${target.consumer.stepIndex}`
      : "/finalStep";
  return sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
    ? `${base}/hooks/${hookIndex}/event`
    : sourceTier === COMPATIBILITY_SOURCE_TIERS.WORKFLOW
      ? `/hooks/${hookIndex}/event`
      : undefined;
}

function getMcpPointer(
  target: CompatibilityExecutionTarget,
  sourceTier: CompatibilityDiagnostic["sourceTier"],
  serverIndex: number
): string | undefined {
  if (!sourceTier || sourceTier === COMPATIBILITY_SOURCE_TIERS.DEFAULTS) {
    return undefined;
  }
  const base =
    target.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${target.consumer.stepIndex}`
      : "/finalStep";
  return sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
    ? `${base}/mcpServers/${serverIndex}/deniedTools`
    : `/mcpServers/${serverIndex}/deniedTools`;
}

function getWorkspaceSideEffectIdentity(use: UsedCapability): string {
  return JSON.stringify([
    use.capability,
    use.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? [use.consumer.kind, use.consumer.stepIndex]
      : [use.consumer.kind],
    use.propertyPointer ?? null,
    use.sourceTier ?? null,
  ]);
}

function compareDiagnostics(
  left: PortabilityDiagnostic,
  right: PortabilityDiagnostic
): number {
  return left.identity.localeCompare(right.identity);
}

function compareWorkspaceSideEffects(
  left: PortabilityWorkspaceSideEffect,
  right: PortabilityWorkspaceSideEffect
): number {
  return left.identity.localeCompare(right.identity);
}
