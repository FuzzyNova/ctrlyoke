import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  HOOK_EVENT_ORDER,
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  STEP_TYPES,
  type HarnessId,
  type HookEvent,
} from "./DashboardConstants";
import type { PromptFile, PromptStep, WorkflowStep } from "./CtrlYokeTypes";
import type { ResolvedExecutionTarget } from "./ExecutionPropertyResolver";
import type {
  CompatibilityConsumerTarget,
  CompatibilityDiagnostic,
  EffectiveCapabilityState,
  HarnessCapabilityRegistrySnapshot,
} from "./CompatibilityTypes";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  getCompatibilityDiagnosticMessage,
  getCompatibilityDiagnosticRemediation,
} from "./CompatibilityTypes";
import { mergeServerDeniedTools } from "./ToolPermissionUtils";

export interface CompatibilityExecutionTarget {
  consumer: CompatibilityConsumerTarget;
  resolved: ResolvedExecutionTarget;
}

/** Reserved for future workspace-scoped compatibility domains. */
export interface CompatibilityWorkspaceState {
  readonly workspaceRoot?: string;
}

export interface CompatibilityAnalyzerInput {
  workflow: PromptFile;
  executionTargets: readonly CompatibilityExecutionTarget[];
  capabilities: HarnessCapabilityRegistrySnapshot;
  workspace?: CompatibilityWorkspaceState;
}

export type CompatibilityTargetResolver = (
  prompt: PromptStep,
  workflow: PromptFile
) => ResolvedExecutionTarget;

/**
 * Re-target existing consumers at a selected harness without re-resolving
 * their inherited properties. Compatibility validation uses this to answer
 * "what if this workflow ran on X?" while keeping the shared resolver's
 * property provenance intact.
 */
export function retargetCompatibilityTargets(
  executionTargets: readonly CompatibilityExecutionTarget[],
  harnessId: HarnessId
): CompatibilityExecutionTarget[] {
  return executionTargets.map((target) => ({
    ...target,
    resolved: {
      ...target.resolved,
      properties: {
        ...target.resolved.properties,
        harness: harnessId,
      },
    },
  }));
}

/**
 * Enumerate only the AI consumers that currently exist in the definition.
 * The caller supplies the shared resolver; this helper owns no precedence
 * rules and therefore cannot drift from execution.
 */
export function enumerateCompatibilityTargets(
  workflow: PromptFile,
  resolveTarget: CompatibilityTargetResolver
): CompatibilityExecutionTarget[] {
  const targets: CompatibilityExecutionTarget[] = [];
  for (const [stepIndex, step] of (workflow.steps ?? []).entries()) {
    if (step.enabled === false || isScriptWorkflowStep(step)) {
      continue;
    }
    targets.push({
      consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
      resolved: resolveTarget(step, workflow),
    });
  }

  const finalStep = workflow.finalStep;
  if (
    finalStep &&
    finalStep.enabled !== false &&
    !isScriptWorkflowStep(finalStep)
  ) {
    targets.push({
      consumer: { kind: FINAL_STEP_PHASES.FINAL_STEP },
      resolved: resolveTarget(finalStep, workflow),
    });
  }
  return targets;
}

/** Analyze the enabled permissions consumers in a parsed workflow. */
export function analyzeCompatibility({
  workflow,
  executionTargets,
  capabilities,
  workspace,
}: CompatibilityAnalyzerInput): CompatibilityDiagnostic[] {
  void workflow;
  void workspace;
  const diagnostics: CompatibilityDiagnostic[] = [];

  for (const target of executionTargets) {
    const harnessId = target.resolved.properties.harness;
    const installed = capabilities.harnesses[harnessId];
    if (!installed?.available) {
      diagnostics.push(
        createDiagnostic(
          COMPATIBILITY_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE,
          COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
          harnessId,
          "harness",
          target,
          installed?.effective?.permissions?.mode ?? unknownCapabilityState(),
          undefined
        )
      );
      continue;
    }

    const permissions = target.resolved.properties.toolPermissions;
    if (!permissions) {
      // `none` mode already resolves to `null` upstream in
      // `resolveToolPermissions`, so it never reaches this point.
      continue;
    }

    if (permissions.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      // Every harness natively bypasses all approval/tool-list checks in this
      // mode, so neither the mode nor the (possibly stale, leftover) allow/deny
      // lists have anything to diagnose.
      continue;
    }

    const effectivePermissions = mergeServerDeniedTools(
      permissions,
      target.resolved.properties.mcpServers
    );
    const hasAttachedServerDenials =
      effectivePermissions !== permissions &&
      target.resolved.properties.mcpServers?.some(
        (server) =>
          typeof server === "object" &&
          server !== null &&
          (server.deniedTools?.length ?? 0) > 0
      ) === true;
    const serverDenialPointer = hasAttachedServerDenials
      ? getMcpServerDenialPointer(target)
      : undefined;

    const effective = installed.effective?.permissions;
    if (!effective) {
      continue;
    }

    const sourceTier = target.resolved.sources.toolPermissions;
    const declarations = installed.descriptor.permissions;
    const permissionFields: Array<{
      key: "mode" | "allowedTools" | "deniedTools";
      used: boolean;
      state: EffectiveCapabilityState;
      caveatCode?: string;
      sourceTier?: ResolvedExecutionTarget["sources"]["toolPermissions"];
      propertyPointer?: string;
    }> = [
      {
        key: PERMISSION_CAPABILITY_KEYS.MODE,
        used: true,
        state: effective.mode,
        caveatCode: declarations?.mode.caveatCode,
      },
      {
        key: PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS,
        used: permissions.allowedTools.length > 0,
        state: effective.allowedTools,
        caveatCode: declarations?.allowedTools.caveatCode,
      },
      {
        key: PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS,
        used: Boolean(effectivePermissions?.deniedTools?.length),
        state: effective.deniedTools,
        caveatCode: declarations?.deniedTools.caveatCode,
        sourceTier: hasAttachedServerDenials
          ? target.resolved.sources.mcpServers
          : sourceTier,
        propertyPointer: serverDenialPointer,
      },
    ];

    for (const field of permissionFields) {
      if (!field.used) {
        continue;
      }
      for (const diagnostic of diagnosticsForPermissionField(
        field.key,
        field.state,
        harnessId,
        target,
        field.sourceTier ?? sourceTier,
        field.caveatCode,
        field.propertyPointer
      )) {
        diagnostics.push(diagnostic);
      }
    }

    analyzeConfiguredHooks(target, installed, diagnostics);
  }

  return diagnostics;
}

function analyzeConfiguredHooks(
  target: CompatibilityExecutionTarget,
  installed: NonNullable<
    CompatibilityAnalyzerInput["capabilities"]["harnesses"][HarnessId]
  >,
  diagnostics: CompatibilityDiagnostic[]
): void {
  const hooks = target.resolved.properties.hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) {
    return;
  }

  const effectiveHooks = installed.effective?.hooks;
  const declarations = installed.descriptor.hooks;
  if (!effectiveHooks) {
    return;
  }

  const sourceTier = target.resolved.sources.hooks;
  for (const [hookIndex, hook] of hooks.entries()) {
    const event = hook.event as HookEvent;
    if (!HOOK_EVENT_ORDER.includes(event)) {
      continue;
    }
    const state = effectiveHooks[event];
    if (!state) {
      continue;
    }

    const base = {
      harnessId: target.resolved.properties.harness,
      capability: event,
      consumer: target.consumer,
      sourceTier,
      state,
    };
    if (state.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED) {
      diagnostics.push(
        createHookDiagnostic(
          COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED,
          base,
          hookIndex,
          declarations?.[event]?.caveatCode
        )
      );
    } else if (state.fidelity === CAPABILITY_FIDELITIES.PARTIAL) {
      diagnostics.push(
        createHookDiagnostic(
          COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_PARTIAL,
          base,
          hookIndex,
          declarations?.[event]?.caveatCode
        )
      );
    }

    if (
      state.fidelity !== CAPABILITY_FIDELITIES.UNSUPPORTED &&
      state.verification === CAPABILITY_VERIFICATION_STATUSES.UNKNOWN
    ) {
      diagnostics.push(
        createHookDiagnostic(
          COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNVERIFIED,
          base,
          hookIndex
        )
      );
    }
  }
}

function createHookDiagnostic(
  code: string,
  base: {
    harnessId: HarnessId;
    capability: HookEvent;
    consumer: CompatibilityConsumerTarget;
    sourceTier?: ResolvedExecutionTarget["sources"]["hooks"];
    state: EffectiveCapabilityState;
  },
  hookIndex: number,
  caveatCode?: string
): CompatibilityDiagnostic {
  const pointerBase =
    base.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${base.consumer.stepIndex}`
      : "/finalStep";
  const propertyPointer =
    base.sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
      ? `${pointerBase}/hooks/${hookIndex}/event`
      : base.sourceTier === COMPATIBILITY_SOURCE_TIERS.WORKFLOW
        ? `/hooks/${hookIndex}/event`
        : undefined;
  return {
    code,
    severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
    harnessId: base.harnessId,
    capability: base.capability,
    consumer: base.consumer,
    ...(base.sourceTier ? { sourceTier: base.sourceTier } : {}),
    ...(propertyPointer ? { propertyPointer } : {}),
    state: base.state,
    message: getCompatibilityDiagnosticMessage(code, {
      harnessId: base.harnessId,
      capability: base.capability,
      caveatCode,
    }),
    ...(getCompatibilityDiagnosticRemediation(code)
      ? { remediation: getCompatibilityDiagnosticRemediation(code) }
      : {}),
  };
}

function diagnosticsForPermissionField(
  key: "mode" | "allowedTools" | "deniedTools",
  state: EffectiveCapabilityState,
  harnessId: HarnessId,
  target: CompatibilityExecutionTarget,
  sourceTier: ResolvedExecutionTarget["sources"]["toolPermissions"],
  caveatCode?: string,
  propertyPointer?: string
): CompatibilityDiagnostic[] {
  const diagnostics: CompatibilityDiagnostic[] = [];
  const base = {
    harnessId,
    capability: key,
    target,
    sourceTier,
    state,
  };

  if (state.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED) {
    diagnostics.push(
      createDiagnostic(
        key === PERMISSION_CAPABILITY_KEYS.MODE
          ? COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED
          : key === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
            ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED
            : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        base.harnessId,
        base.capability,
        base.target,
        base.state,
        base.sourceTier,
        key,
        caveatCode,
        propertyPointer
      )
    );
  } else if (state.fidelity === CAPABILITY_FIDELITIES.PARTIAL) {
    diagnostics.push(
      createDiagnostic(
        key === PERMISSION_CAPABILITY_KEYS.MODE
          ? COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL
          : key === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
            ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL
            : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        base.harnessId,
        base.capability,
        base.target,
        base.state,
        base.sourceTier,
        key,
        caveatCode,
        propertyPointer
      )
    );
  }

  // An `unsupported` fidelity is an architectural fact ("Codex uses sandbox
  // modes instead"), not a claim that erodes with the installed CLI version —
  // the NOT_ENFORCED diagnostic above already explains it in full. Layering an
  // "unverified" diagnostic on top would incorrectly suggest we merely haven't
  // checked, when we deliberately know this harness has no equivalent.
  if (
    state.fidelity !== CAPABILITY_FIDELITIES.UNSUPPORTED &&
    state.verification === CAPABILITY_VERIFICATION_STATUSES.UNKNOWN
  ) {
    diagnostics.push(
      createDiagnostic(
        key === PERMISSION_CAPABILITY_KEYS.MODE
          ? COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED
          : key === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
            ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED
            : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        base.harnessId,
        base.capability,
        base.target,
        base.state,
        base.sourceTier,
        key,
        undefined,
        propertyPointer
      )
    );
  }

  return diagnostics;
}

function createDiagnostic(
  code: string,
  severity: CompatibilityDiagnostic["severity"],
  harnessId: HarnessId,
  capability: string,
  target: CompatibilityExecutionTarget,
  state: EffectiveCapabilityState,
  sourceTier?: ResolvedExecutionTarget["sources"]["toolPermissions"],
  permissionKey?: "mode" | "allowedTools" | "deniedTools",
  caveatCode?: string,
  propertyPointer?: string
): CompatibilityDiagnostic {
  const pointerBase =
    target.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${target.consumer.stepIndex}`
      : "/finalStep";
  const remediation = getCompatibilityDiagnosticRemediation(code);
  return {
    code,
    severity,
    harnessId,
    capability,
    consumer: target.consumer,
    ...(sourceTier ? { sourceTier } : {}),
    ...(propertyPointer
      ? { propertyPointer }
      : sourceTier &&
          sourceTier !== COMPATIBILITY_SOURCE_TIERS.DEFAULTS &&
          permissionKey
        ? {
            propertyPointer:
              sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
                ? `${pointerBase}/toolPermissions/${permissionKey}`
                : `/toolPermissions/${permissionKey}`,
          }
        : {}),
    state,
    message: getCompatibilityDiagnosticMessage(code, {
      harnessId,
      capability,
      caveatCode,
    }),
    ...(remediation ? { remediation } : {}),
  };
}

function getMcpServerDenialPointer(
  target: CompatibilityExecutionTarget
): string | undefined {
  const sourceTier = target.resolved.sources.mcpServers;
  if (!sourceTier || sourceTier === COMPATIBILITY_SOURCE_TIERS.DEFAULTS) {
    return undefined;
  }

  const serverIndex = target.resolved.properties.mcpServers?.findIndex(
    (server) =>
      typeof server === "object" &&
      server !== null &&
      (server.deniedTools?.length ?? 0) > 0
  );
  if (serverIndex === undefined || serverIndex < 0) {
    return undefined;
  }

  const pointerBase =
    target.consumer.kind === FINAL_STEP_PHASES.QUEUE
      ? `/steps/${target.consumer.stepIndex}`
      : "/finalStep";
  return sourceTier === COMPATIBILITY_SOURCE_TIERS.PROMPT
    ? `${pointerBase}/mcpServers/${serverIndex}/deniedTools`
    : `/mcpServers/${serverIndex}/deniedTools`;
}

/**
 * Fallback state for a harness with no usable declaration (an unavailable
 * harness has nothing installed to evaluate). `unsupported` is the only
 * fidelity that may pair with mechanism `none` — a supported fidelity must
 * always name a real mechanism.
 */
function unknownCapabilityState(): EffectiveCapabilityState {
  return {
    fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
    mechanism: CAPABILITY_MECHANISMS.NONE,
    verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
  };
}

function isScriptWorkflowStep(
  step: WorkflowStep
): step is Exclude<WorkflowStep, PromptStep> {
  return step.type === STEP_TYPES.SCRIPT;
}
