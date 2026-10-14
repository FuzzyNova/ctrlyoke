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
import {
  RESOLUTION_SOURCES,
  resolveExecutionProperties,
} from "../types/ExecutionPropertyResolver";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import { SessionResolver } from "../utils/SessionResolver";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import {
  PASSTHROUGH_PROMPT_FILE_RESOLVER,
  resolvePromptTextWithVariables,
  type PromptTextFileResolver,
} from "./PromptTextResolver";

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
  /**
   * Step index of an earlier member that already holds the session this member
   * would auto-resume (no `sessionId`). Concurrent members cannot continue one
   * conversation, so this member starts a new session instead.
   */
  readonly autoResumeSharedWith?: number;
  /** Internal reservation used to verify integration isolation. */
  readonly integrationReservation?: unknown;
}

export interface ParallelGroupMemberPreflightResult {
  readonly member: ParallelGroupPreflightMember;
  readonly issues: readonly ParallelGroupPreflightIssue[];
  readonly failureMessage: string;
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
  /** Explicit override used by tests or compatibility simulations. */
  readonly fanOutEnabled?: boolean;
  /** Recovery execution omits members whose terminal runtime is already durable. */
  readonly excludeTerminalMembers?: boolean;
  readonly promptFileResolver?: PromptTextFileResolver;
  readonly sourceDefinitionPath?: string;
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
  readonly workflowSessionIdFromOverride?: boolean;
}

export interface ParallelGroupMemberPreflightOptions extends ParallelGroupPreflightOptions {
  readonly stepIndex: number;
  readonly step: WorkflowStep;
  readonly reservedMembers?: readonly ParallelGroupPreflightMember[];
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

/**
 * Resolve and validate one member against the current definition and the
 * reservations held by members that have already been admitted.
 *
 * The executor calls this after its atomic claim. Keeping this path separate
 * from group admission is what makes edits arriving from another process
 * visible to a member that is still pending.
 */
export async function preflightParallelGroupMember(
  options: ParallelGroupMemberPreflightOptions
): Promise<ParallelGroupMemberPreflightResult> {
  const {
    workflow,
    group,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
  } = options;
  const variables = Object.freeze({ ...(workflow.vars ?? {}) });
  const issues: ParallelGroupPreflightIssue[] = [];

  const step = options.step;
  const prompt = promptProjection(step);
  const resolvedTarget = resolveExecutionProperties(prompt, workflow, {
    defaults: options.defaults,
    hostCanProvidePty,
  });
  let resolvedProperties = VarSubstitutor.applyToResolvedProperties(
    resolvedTarget.properties,
    variables
  );
  const effectivePromptText = isScriptStep(step)
    ? undefined
    : await resolvePromptTextWithVariables(
        step.prompt,
        variables,
        options.promptFileResolver ?? PASSTHROUGH_PROMPT_FILE_RESOLVER,
        options.sourceDefinitionPath
      );
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
      memberIndices: [options.stepIndex],
      message: `${memberLabel(workflow, options.stepIndex)} has an effective ${details} reference into its own parallel group.`,
    });
  }

  const candidateSessionId = isScriptStep(step)
    ? undefined
    : SessionResolver.resolveWithProperties(
        prompt,
        options.stepIndex,
        workflow.steps ?? [],
        resolvedProperties,
        options.finalStepSessionId,
        group.startIndex,
        false
      );

  const reservedMembers = options.reservedMembers ?? [];
  const sessionOwners = reservedMembers.filter(
    (reserved) =>
      !isScriptStep(reserved.step) &&
      candidateSessionId !== undefined &&
      reserved.resolvedSessionId === candidateSessionId &&
      reserved.resolvedProperties.harness === resolvedProperties.harness
  );
  // An auto-resumed session (no sessionId) that an earlier member already holds
  // is not an authoring conflict, just two branches inheriting one
  // conversation: the later member starts fresh. Explicit references still fail.
  const autoResumeSharedWith =
    sessionOwners.length > 0 && resolvedProperties.sessionId === undefined
      ? sessionOwners[0].stepIndex
      : undefined;
  const resolvedSessionId =
    autoResumeSharedWith === undefined ? candidateSessionId : undefined;
  const member: ParallelGroupPreflightMember = {
    stepIndex: options.stepIndex,
    step,
    resolvedTarget: {
      ...resolvedTarget,
      properties: resolvedProperties,
    },
    resolvedProperties,
    variables,
    ...(effectivePromptText !== undefined ? { effectivePromptText } : {}),
    ...(resolvedSessionId !== undefined ? { resolvedSessionId } : {}),
    ...(autoResumeSharedWith !== undefined ? { autoResumeSharedWith } : {}),
  };

  if (sessionOwners.length > 0 && autoResumeSharedWith === undefined) {
    const indices = [
      ...sessionOwners.map((owner) => owner.stepIndex),
      options.stepIndex,
    ];
    const sessionIdComesFromWorkflowOverride =
      options.workflowSessionIdFromOverride &&
      workflow.sessionId === resolvedSessionId &&
      (resolvedTarget.sources.sessionId === RESOLUTION_SOURCES.WORKFLOW ||
        sessionOwners.some(
          (owner) =>
            owner.resolvedTarget.sources.sessionId ===
            RESOLUTION_SOURCES.WORKFLOW
        ));
    issues.push({
      code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION,
      memberIndices: indices,
      message: `${memberList(workflow, indices)} resolve to the same ${resolvedProperties.harness} session "${resolvedSessionId}". Parallel members must use distinct sessions.${sessionIdComesFromWorkflowOverride ? " Members inherit --session-id, so give those members their own sessionId or run without the flag." : ""}`,
    });
  }

  const interactiveOwners = reservedMembers.filter(
    (reserved) =>
      reserved.resolvedProperties.executionMode === EXECUTION_MODES.INTERACTIVE
  );
  if (
    resolvedProperties.executionMode === EXECUTION_MODES.INTERACTIVE &&
    interactiveOwners.length > 0 &&
    !supportsConcurrentInteractiveSessions
  ) {
    const indices = [
      ...interactiveOwners.map((owner) => owner.stepIndex),
      options.stepIndex,
    ];
    issues.push({
      code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTERACTIVE_MULTIPLEX,
      memberIndices: indices,
      message: `${memberList(workflow, indices)} resolve to interactive mode, but this host cannot multiplex interactive sessions. Run headless or set those members to executionMode: headless.`,
    });
  }

  if (!isScriptStep(step) && options.checkHarnessReady) {
    const reason = await options.checkHarnessReady(resolvedProperties.harness);
    if (reason) {
      issues.push({
        code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.HARNESS_UNAVAILABLE,
        memberIndices: [options.stepIndex],
        message: `${memberLabel(workflow, options.stepIndex)} require ${resolvedProperties.harness}, which is not ready: ${reason}`,
      });
    }
  }

  let memberWithIntegration = member;
  if (!isScriptStep(step) && options.ensureIsolatedIntegration) {
    try {
      const integration = await options.ensureIsolatedIntegration(member);
      memberWithIntegration = {
        ...member,
        integrationReservation: integration,
      };
      const previousOwner = reservedMembers.find(
        (reserved) =>
          integration !== undefined &&
          integration !== null &&
          reserved.integrationReservation === integration
      );
      if (previousOwner) {
        const indices = [previousOwner.stepIndex, options.stepIndex];
        issues.push({
          code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTEGRATION_CREATION,
          memberIndices: indices,
          message: `${memberList(workflow, indices)} were assigned the same integration instead of isolated integrations.`,
        });
      }
    } catch (error) {
      issues.push({
        code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTEGRATION_CREATION,
        memberIndices: [options.stepIndex],
        message: `${memberLabel(workflow, options.stepIndex)} could not create an isolated ${resolvedProperties.harness} integration: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const result: ParallelGroupMemberPreflightResult = {
    member: memberWithIntegration,
    issues,
    failureMessage: [
      `Parallel step ${options.stepIndex + 1} failed preflight:`,
      ...issues.map((issue) => `- ${issue.message}`),
    ].join("\n"),
  };
  return result;
}

/** Resolve and validate every enabled member before any group member launches. */
export async function preflightParallelGroup(
  options: ParallelGroupPreflightOptions
): Promise<ParallelGroupPreflightResult> {
  const effectiveWidth = getEffectiveParallelGroupWidth(
    options.configuredWidth,
    options.fanOutEnabled
  );
  const issues: ParallelGroupPreflightIssue[] = [];
  const members: ParallelGroupPreflightMember[] = [];
  for (
    let stepIndex = options.group.startIndex;
    stepIndex <= options.group.endIndex;
    stepIndex += 1
  ) {
    const step = options.workflow.steps?.[stepIndex];
    if (
      !step ||
      step.enabled === false ||
      (options.excludeTerminalMembers &&
        step._runtime?.completedAt !== undefined)
    ) {
      continue;
    }
    const memberResult = await preflightParallelGroupMember({
      ...options,
      step,
      stepIndex,
      reservedMembers: members,
    });
    members.push(memberResult.member);
    issues.push(...memberResult.issues);
  }

  return {
    group: options.group,
    groupStartBoundary: options.group.startIndex,
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
    ? `Parallel steps ${range} run sequentially (effective width 1).`
    : `Parallel steps ${range} run up to ${result.effectiveWidth} members concurrently.`;
}

export function parallelGroupIssueSeverity() {
  return COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR;
}

export function parallelGroupConsumer(stepIndex: number) {
  return { kind: FINAL_STEP_PHASES.QUEUE, stepIndex } as const;
}
