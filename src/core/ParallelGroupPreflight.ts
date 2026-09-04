import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  getEffectiveParallelGroupWidth,
  PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES,
  type HarnessId,
  type ParallelGroupPreflightDiagnosticCode,
} from "../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  PromptFile,
  PromptStep,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { isScriptStep } from "../types/CtrlYokeTypes";
import type {
  ExecutionPropertyDefaults,
  ResolvedExecutionTarget,
} from "../types/ExecutionPropertyResolver";
import { resolveExecutionProperties } from "../types/ExecutionPropertyResolver";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import { hasCtrlYokeServer } from "./harness/shared/CliProviderUtils";
import { SessionResolver } from "../utils/SessionResolver";
import { VarSubstitutor } from "../utils/VarSubstitutor";

export interface ParallelGroupPreflightIssue {
  readonly code: ParallelGroupPreflightDiagnosticCode;
  readonly memberIndices: readonly number[];
  readonly message: string;
}

export interface ParallelGroupPreflightMember {
  readonly stepIndex: number;
  readonly step: WorkflowStep;
  readonly resolvedTarget: ResolvedExecutionTarget;
  readonly resolvedProperties: ResolvedProperties;
  readonly variables: Readonly<Record<string, string>>;
  readonly effectivePromptText?: string;
  readonly resolvedSessionId?: string;
}

export interface ParallelGroupPreflightResult {
  readonly group: ParallelGroupDefinition;
  readonly groupStartBoundary: number;
  readonly effectiveWidth: number;
  readonly executableMemberCount: number;
  readonly members: readonly ParallelGroupPreflightMember[];
  readonly issues: readonly ParallelGroupPreflightIssue[];
}

export interface ParallelGroupPreflightOptions {
  readonly workflow: PromptFile;
  readonly group: ParallelGroupDefinition;
  readonly defaults: ExecutionPropertyDefaults;
  readonly hostCanProvidePty: boolean;
  readonly supportsConcurrentInteractiveSessions: boolean;
  readonly configuredWidth: number;
  /** Test-only/next-stage override; production defaults to the closed build gate. */
  readonly fanOutEnabled?: boolean;
  /** Recovery execution omits members whose terminal runtime is already durable. */
  readonly excludeTerminalMembers?: boolean;
  readonly resolvePromptText?: (
    promptText: string,
    variables: Readonly<Record<string, string>>
  ) => Promise<string>;
  readonly normalizeProperties?: (
    properties: ResolvedProperties,
    step: WorkflowStep,
    effectivePromptText: string | undefined
  ) => Promise<ResolvedProperties>;
  readonly checkHarnessReady?: (
    harnessId: HarnessId
  ) => Promise<string | undefined> | string | undefined;
  readonly ensureIsolatedIntegration?: (
    member: ParallelGroupPreflightMember
  ) => Promise<unknown> | unknown;
  readonly finalStepSessionId?: string;
}

export class ParallelGroupPreflightError extends Error {
  constructor(readonly result: ParallelGroupPreflightResult) {
    super(formatParallelGroupPreflightFailure(result));
    this.name = "ParallelGroupPreflightError";
  }
}

function promptProjection(step: WorkflowStep): PromptStep {
  if (!isScriptStep(step)) return step;
  return {
    prompt: "",
    ...(step.executionMode !== undefined
      ? { executionMode: step.executionMode }
      : {}),
    ...(step.errorBehavior !== undefined
      ? { errorBehavior: step.errorBehavior }
      : {}),
    ...(step.secrets !== undefined ? { secrets: step.secrets } : {}),
  };
}

function memberLabel(workflow: PromptFile, stepIndex: number): string {
  const name = workflow.steps?.[stepIndex]?.name;
  return `Step ${stepIndex + 1}${name ? ` ("${name}")` : ""}`;
}

function memberList(workflow: PromptFile, indices: readonly number[]): string {
  return indices.map((index) => memberLabel(workflow, index)).join(", ");
}

function sameGroupNumericReferences(
  value: ResolvedProperties["priorContext"] | ResolvedProperties["sessionId"],
  group: ParallelGroupDefinition
): number[] {
  const references =
    typeof value === "number" ? [value] : Array.isArray(value) ? value : [];
  return references.filter((oneBased) => {
    const index = oneBased - 1;
    return index >= group.startIndex && index <= group.endIndex;
  });
}

/** Resolve and validate every enabled member before any group member launches. */
export async function preflightParallelGroup(
  options: ParallelGroupPreflightOptions
): Promise<ParallelGroupPreflightResult> {
  const {
    workflow,
    group,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
  } = options;
  const variables = Object.freeze({ ...(workflow.vars ?? {}) });
  const effectiveWidth = getEffectiveParallelGroupWidth(
    options.configuredWidth,
    options.fanOutEnabled
  );
  const issues: ParallelGroupPreflightIssue[] = [];
  const members: ParallelGroupPreflightMember[] = [];

  for (
    let stepIndex = group.startIndex;
    stepIndex <= group.endIndex;
    stepIndex += 1
  ) {
    const step = workflow.steps?.[stepIndex];
    if (
      !step ||
      step.enabled === false ||
      (options.excludeTerminalMembers &&
        step._runtime?.completedAt !== undefined)
    ) {
      continue;
    }

    const prompt = promptProjection(step);
    const resolvedTarget = resolveExecutionProperties(prompt, workflow, {
      defaults: options.defaults,
      hostCanProvidePty,
    });
    let resolvedProperties = VarSubstitutor.applyToResolvedProperties(
      resolvedTarget.properties,
      variables
    );
    const substitutedTarget: ResolvedExecutionTarget = {
      ...resolvedTarget,
      properties: resolvedProperties,
    };
    const effectivePromptText = isScriptStep(step)
      ? undefined
      : options.resolvePromptText
        ? await options.resolvePromptText(step.prompt, variables)
        : VarSubstitutor.applyToPromptText(step.prompt, variables);
    if (options.normalizeProperties) {
      resolvedProperties = await options.normalizeProperties(
        resolvedProperties,
        step,
        effectivePromptText
      );
    }

    const invalidPriorContext = sameGroupNumericReferences(
      resolvedProperties.priorContext,
      group
    );
    const invalidSession = sameGroupNumericReferences(
      resolvedProperties.sessionId,
      group
    );
    if (invalidPriorContext.length > 0 || invalidSession.length > 0) {
      const details = [
        ...(invalidPriorContext.length > 0
          ? [`priorContext ${invalidPriorContext.join(", ")}`]
          : []),
        ...(invalidSession.length > 0
          ? [`sessionId ${invalidSession.join(", ")}`]
          : []),
      ].join(" and ");
      issues.push({
        code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INVALID_REFERENCE,
        memberIndices: [stepIndex],
        message: `${memberLabel(workflow, stepIndex)} has an effective ${details} reference into its own parallel group.`,
      });
    }

    const resolvedSessionId = isScriptStep(step)
      ? undefined
      : SessionResolver.resolveWithProperties(
          prompt,
          stepIndex,
          workflow.steps ?? [],
          resolvedProperties,
          options.finalStepSessionId,
          group.startIndex,
          false
        );
    const member: ParallelGroupPreflightMember = {
      stepIndex,
      step,
      resolvedTarget: {
        ...substitutedTarget,
        properties: resolvedProperties,
      },
      resolvedProperties,
      variables,
      ...(effectivePromptText !== undefined ? { effectivePromptText } : {}),
      ...(resolvedSessionId !== undefined ? { resolvedSessionId } : {}),
    };
    members.push(member);

    if (!isScriptStep(step) && hasCtrlYokeServer(resolvedProperties)) {
      issues.push({
        code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.DYNAMIC_QUEUE,
        memberIndices: [stepIndex],
        message: `${memberLabel(workflow, stepIndex)} enables the ctrlyoke dynamic-queue MCP server, which is unavailable inside a parallel group.`,
      });
    }
  }

  const sessions = new Map<string, number[]>();
  for (const member of members) {
    if (!member.resolvedSessionId || isScriptStep(member.step)) continue;
    const key = `${member.resolvedProperties.harness}\0${member.resolvedSessionId}`;
    const indices = sessions.get(key) ?? [];
    indices.push(member.stepIndex);
    sessions.set(key, indices);
  }
  for (const [key, indices] of sessions) {
    if (indices.length < 2) continue;
    const [harnessId, sessionId] = key.split("\0");
    issues.push({
      code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION,
      memberIndices: indices,
      message: `${memberList(workflow, indices)} resolve to the same ${harnessId} session "${sessionId}". Parallel members must use distinct sessions.`,
    });
  }

  const interactiveIndices = members
    .filter(
      (member) =>
        member.resolvedProperties.executionMode === EXECUTION_MODES.INTERACTIVE
    )
    .map((member) => member.stepIndex);
  if (interactiveIndices.length > 1 && !supportsConcurrentInteractiveSessions) {
    issues.push({
      code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTERACTIVE_MULTIPLEX,
      memberIndices: interactiveIndices,
      message: `${memberList(workflow, interactiveIndices)} resolve to interactive mode, but this host cannot multiplex interactive sessions. Use executionMode: headless for all but one member.`,
    });
  }

  const promptMembers = members.filter((member) => !isScriptStep(member.step));
  const harnessErrors = new Map<
    string,
    { harness: HarnessId; indices: number[] }
  >();
  if (options.checkHarnessReady) {
    for (const member of promptMembers) {
      const reason = await options.checkHarnessReady(
        member.resolvedProperties.harness
      );
      if (!reason) continue;
      const key = `${member.resolvedProperties.harness}\0${reason}`;
      const found = harnessErrors.get(key) ?? {
        harness: member.resolvedProperties.harness,
        indices: [],
      };
      found.indices.push(member.stepIndex);
      harnessErrors.set(key, found);
    }
  }
  for (const [key, failure] of harnessErrors) {
    const reason = key.slice(key.indexOf("\0") + 1);
    issues.push({
      code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE,
      memberIndices: failure.indices,
      message: `${memberList(workflow, failure.indices)} require ${failure.harness}, which is not ready: ${reason}`,
    });
  }

  if (options.ensureIsolatedIntegration) {
    const integrationOwners = new Map<unknown, number>();
    for (const member of promptMembers) {
      try {
        const integration = await options.ensureIsolatedIntegration(member);
        if (integration !== undefined && integration !== null) {
          const previousOwner = integrationOwners.get(integration);
          if (previousOwner !== undefined) {
            issues.push({
              code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTEGRATION_CREATION,
              memberIndices: [previousOwner, member.stepIndex],
              message: `${memberList(workflow, [previousOwner, member.stepIndex])} were assigned the same integration instead of isolated integrations.`,
            });
          } else {
            integrationOwners.set(integration, member.stepIndex);
          }
        }
      } catch (error) {
        issues.push({
          code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTEGRATION_CREATION,
          memberIndices: [member.stepIndex],
          message: `${memberLabel(workflow, member.stepIndex)} could not create an isolated ${member.resolvedProperties.harness} integration: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return {
    group,
    groupStartBoundary: group.startIndex,
    effectiveWidth,
    executableMemberCount: members.length,
    members,
    issues,
  };
}

export function formatParallelGroupPreflightFailure(
  result: ParallelGroupPreflightResult
): string {
  const range = `${result.group.startIndex + 1}–${result.group.endIndex + 1}`;
  return [
    `Parallel steps ${range} failed preflight:`,
    ...result.issues.map((issue) => `- ${issue.message}`),
  ].join("\n");
}

export function throwIfParallelGroupPreflightFailed(
  result: ParallelGroupPreflightResult
): void {
  if (result.issues.length > 0) {
    throw new ParallelGroupPreflightError(result);
  }
}

/** Shared state shape for preview diagnostics produced from preflight issues. */
export const PARALLEL_PREFLIGHT_DIAGNOSTIC_STATE = {
  fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
  mechanism: CAPABILITY_MECHANISMS.NONE,
  verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
} as const;

export const PARALLEL_PREFLIGHT_WIDTH_STATE = {
  fidelity: CAPABILITY_FIDELITIES.EXACT,
  mechanism: CAPABILITY_MECHANISMS.NATIVE,
  verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
} as const;

export function parallelGroupWidthMessage(
  result: ParallelGroupPreflightResult
): string {
  const range = `${result.group.startIndex + 1}–${result.group.endIndex + 1}`;
  return result.effectiveWidth <= 1
    ? `Parallel steps ${range} run sequentially in this build (effective width 1).`
    : `Parallel steps ${range} run up to ${result.effectiveWidth} members concurrently.`;
}

export function parallelGroupIssueSeverity() {
  return COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR;
}

export function parallelGroupConsumer(stepIndex: number) {
  return { kind: FINAL_STEP_PHASES.QUEUE, stepIndex } as const;
}
