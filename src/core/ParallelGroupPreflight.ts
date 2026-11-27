import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  getEffectiveParallelGroupWidth,
  PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES,
  SUB_WORKFLOW_WORKTREE_PLACEMENTS,
  type HarnessId,
  type ParallelGroupPreflightDiagnosticCode,
} from "../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  PromptFile,
  PromptStep,
  SubWorkflowStep,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import {
  isPromptStep,
  isScriptStep,
  isSubWorkflowStep,
} from "../types/CtrlYokeTypes";
import type {
  PreparedSubWorkflowLaunch,
  SubWorkflowWorktreePlan,
} from "../types/SubWorkflowTypes";
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
import {
  VarSubstitutionValidationError,
  VarSubstitutor,
} from "../utils/VarSubstitutor";
import { VAR_SUBSTITUTION_PHASES } from "../utils/VarSubstitutionPolicy";
import { RunStartView } from "../utils/RunStartView";
import { formatParallelStepsLabel } from "../utils/FinalStepLabels";
import {
  PASSTHROUGH_PROMPT_FILE_RESOLVER,
  resolvePromptTextWithVariables,
  type PromptTextFileResolver,
} from "./PromptTextResolver";
import { getErrorMessage } from "../utils/ErrorUtils";
import { classifySubWorkflowWorktree } from "../utils/WorktreeConfigShape";
import { pathsEqual } from "../utils/PathCasing";
import * as path from "path";

/**
 * What an author does about a `MERGE_INTO_SHARED_ROOT` issue. One constant,
 * so every place that refuses a merge lane beside an editing member says the
 * same thing.
 */
export const MERGE_INTO_SHARED_ROOT_GUIDANCE =
  "Give the editing member its own worktree (a workflow step whose child sets worktree), or drop merge from the merging lane.";

/**
 * What an author does about a `WORKTREE_COLLISION` issue: only one run can
 * hold a named worktree at a time.
 */
export const WORKTREE_COLLISION_GUIDANCE =
  "Give each member its own branch, or move one of them out of the parallel group.";

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
  /**
   * A dispatch field of this member failed substitution. The member holds no
   * session or integration reservation; the executor fails it under its own
   * `errorBehavior` before any side effect, as it would a sequential step.
   */
  readonly varSubstitutionError?: VarSubstitutionValidationError;
  /**
   * A sub-workflow member's child, resolved and parsed (or materialized) once
   * here and reused by its launch. A failed preparation is not a group
   * issue: the member fails alone, under its own `onFail`.
   */
  readonly subWorkflowLaunch?: PreparedSubWorkflowLaunch;
  /**
   * The effective width of the group run that dispatched this member, fixed
   * when that run was preflighted. Set by the executor at dispatch, so a
   * member decides whether it runs beside siblings from the width its group
   * actually runs at, never from a setting changed since.
   */
  readonly groupEffectiveWidth?: number;
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
  /**
   * The run's run-start resolution. Omitted outside a run (a preview), where
   * one is resolved from `workflow`.
   */
  readonly runStartView?: RunStartView;
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
  /**
   * The parent runs in the workspace's main checkout, so a sub-workflow
   * member whose child sets `worktree: false` edits the parent's checkout.
   */
  readonly parentRunsInMainCheckout?: boolean;
  /**
   * Resolve, cycle-check and parse (file) or materialize (inline) a
   * sub-workflow member's child. Omitted outside a run, where a sub-workflow
   * member is reported without a prepared launch.
   */
  readonly prepareSubWorkflowMember?: (
    step: SubWorkflowStep,
    stepIndex: number
  ) => Promise<PreparedSubWorkflowLaunch>;
}

export interface ParallelGroupMemberPreflightOptions extends ParallelGroupPreflightOptions {
  readonly stepIndex: number;
  readonly step: WorkflowStep;
  readonly reservedMembers?: readonly ParallelGroupPreflightMember[];
}

class ParallelGroupPreflightError extends Error {
  constructor(readonly result: ParallelGroupPreflightResult) {
    super(formatParallelGroupPreflightFailure(result));
    this.name = "ParallelGroupPreflightError";
  }
}

function promptProjection(step: WorkflowStep): PromptStep {
  if (isPromptStep(step)) return step;
  if (!isScriptStep(step)) return { prompt: "" };
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

/** How a member uses the parent's checkout, for `MERGE_INTO_SHARED_ROOT`. */
export interface ParentCheckoutUse {
  /** The member edits the parent's checkout while it runs. */
  readonly edits: boolean;
  /** The member's child merges its worktree into the parent's checkout. */
  readonly mergesInto: boolean;
}

const NO_PARENT_CHECKOUT_USE: ParentCheckoutUse = {
  edits: false,
  mergesInto: false,
};

/**
 * How one step uses the parent's checkout. A prompt or script step runs in the
 * parent's root. A sub-workflow step is classified from its child's
 * `worktree` key (D4): `plan` when the child was prepared, otherwise, for an
 * inline child, its authored definition. A file child that was never parsed
 * uses nothing.
 */
export function stepParentCheckoutUse(
  step: WorkflowStep,
  parentRunsInMainCheckout: boolean,
  plan?: SubWorkflowWorktreePlan
): ParentCheckoutUse {
  if (!isSubWorkflowStep(step)) {
    return { edits: true, mergesInto: false };
  }
  const resolvedPlan = subWorkflowStepWorktreePlan(step, plan);
  if (!resolvedPlan) return NO_PARENT_CHECKOUT_USE;
  return {
    edits:
      resolvedPlan.placement === SUB_WORKFLOW_WORKTREE_PLACEMENTS.INHERITED ||
      (resolvedPlan.placement ===
        SUB_WORKFLOW_WORKTREE_PLACEMENTS.MAIN_CHECKOUT &&
        parentRunsInMainCheckout),
    mergesInto: resolvedPlan.mergesIntoParent,
  };
}

/**
 * A sub-workflow step's worktree plan: `plan` when its child was prepared,
 * otherwise, for an inline child, its authored definition. A file child that
 * was never parsed has none.
 */
function subWorkflowStepWorktreePlan(
  step: SubWorkflowStep,
  plan: SubWorkflowWorktreePlan | undefined
): SubWorkflowWorktreePlan | undefined {
  return (
    plan ??
    (typeof step.workflow === "string"
      ? undefined
      : classifySubWorkflowWorktree(step.workflow.worktree))
  );
}

/**
 * The named worktree branch a member's child will hold, or undefined when it
 * holds none or fails alone before it runs.
 */
function memberNamedBranch(
  member: ParallelGroupPreflightMember
): string | undefined {
  if (member.varSubstitutionError !== undefined) return undefined;
  if (!isSubWorkflowStep(member.step)) return undefined;
  const launch = member.subWorkflowLaunch;
  if (launch && !launch.ok) return undefined;
  return subWorkflowStepWorktreePlan(member.step, launch?.worktreePlan)
    ?.namedBranch;
}

/**
 * Two members whose children name the same worktree branch: only one run
 * can hold a named worktree's exclusive lease, so the later member could
 * never start beside the earlier one.
 */
function worktreeCollisionIssue(
  workflow: PromptFile,
  member: ParallelGroupPreflightMember,
  reservedMembers: readonly ParallelGroupPreflightMember[]
): ParallelGroupPreflightIssue | undefined {
  const branch = memberNamedBranch(member);
  if (branch === undefined) return undefined;
  const holders = reservedMembers
    .filter((reserved) => memberNamedBranch(reserved) === branch)
    .map((reserved) => reserved.stepIndex);
  if (holders.length === 0) return undefined;
  const indices = [...holders, member.stepIndex].sort((a, b) => a - b);
  return {
    code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.WORKTREE_COLLISION,
    memberIndices: indices,
    message: `${memberList(workflow, indices)} use the same named worktree "${branch}" in one parallel group. ${WORKTREE_COLLISION_GUIDANCE}`,
  };
}

/**
 * A member uses the parent's checkout as its step does, unless it fails alone
 * before it runs (a substitution error or a failed child preparation).
 */
function parentCheckoutUse(
  member: ParallelGroupPreflightMember,
  parentRunsInMainCheckout: boolean
): ParentCheckoutUse {
  if (member.varSubstitutionError !== undefined) return NO_PARENT_CHECKOUT_USE;
  const launch = member.subWorkflowLaunch;
  if (launch && !launch.ok) return NO_PARENT_CHECKOUT_USE;
  return stepParentCheckoutUse(
    member.step,
    parentRunsInMainCheckout,
    launch?.worktreePlan
  );
}

/**
 * Whether a run executes in the workspace's main checkout, so that a
 * `worktree: false` child of it edits its own checkout. Decided by where the
 * run actually executes, never by whether it has a worktree record: an
 * inherited child (D4a) has no worktree of its own yet runs in its parent's,
 * and it is in the main checkout only when its execution root is the state
 * root (the checkout the run was started from). An `executionRoot` of
 * `undefined` is a worktree not placed yet (a preview of a worktree run).
 * The single source for group preflight, its preview, and the live
 * `parallelWithCurrent` join and group-member edit checks.
 */
export function runsInMainCheckout(
  executionRoot: string | undefined,
  stateRoot: string
): boolean {
  return (
    executionRoot !== undefined &&
    pathsEqual(path.resolve(executionRoot), path.resolve(stateRoot))
  );
}

/** One step index with its use of the parent's checkout. */
export interface ParentCheckoutUser {
  readonly stepIndex: number;
  readonly use: ParentCheckoutUse;
}

/**
 * The `MERGE_INTO_SHARED_ROOT` issue among `users`, or undefined when no
 * merging member shares the group with a member editing the parent's
 * checkout. Shared by group preflight and the live `parallelWithCurrent`
 * join, so both refuse with the same text.
 */
export function mergeIntoSharedRootIssueAmong(
  workflow: PromptFile,
  users: readonly ParentCheckoutUser[]
): ParallelGroupPreflightIssue | undefined {
  const mergers = users
    .filter((user) => user.use.mergesInto)
    .map((user) => user.stepIndex)
    .sort((a, b) => a - b);
  const editors = users
    .filter((user) => user.use.edits)
    .map((user) => user.stepIndex)
    .sort((a, b) => a - b);
  if (mergers.length === 0 || editors.length === 0) return undefined;
  return {
    code: PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.MERGE_INTO_SHARED_ROOT,
    memberIndices: [...new Set([...mergers, ...editors])].sort((a, b) => a - b),
    message: `${memberList(workflow, mergers)} ${mergers.length > 1 ? "merge" : "merges"} into the parent's checkout, which ${memberList(workflow, editors)} ${editors.length > 1 ? "edit" : "edits"} in the same parallel group. ${MERGE_INTO_SHARED_ROOT_GUIDANCE}`,
  };
}

/**
 * A lane whose child merges into the parent's checkout cannot run beside a
 * member editing that checkout: the merge would land under an agent still
 * editing, or the merge's dirty-tree guard would turn it into `blocked`.
 */
function mergeIntoSharedRootIssue(
  workflow: PromptFile,
  member: ParallelGroupPreflightMember,
  reservedMembers: readonly ParallelGroupPreflightMember[],
  parentRunsInMainCheckout: boolean
): ParallelGroupPreflightIssue | undefined {
  const use = parentCheckoutUse(member, parentRunsInMainCheckout);
  if (!use.edits && !use.mergesInto) return undefined;
  const counterparts = reservedMembers
    .map((reserved) => ({
      stepIndex: reserved.stepIndex,
      use: parentCheckoutUse(reserved, parentRunsInMainCheckout),
    }))
    .filter(
      (other) =>
        (use.edits && other.use.mergesInto) ||
        (use.mergesInto && other.use.edits)
    );
  if (counterparts.length === 0) return undefined;
  return mergeIntoSharedRootIssueAmong(workflow, [
    ...counterparts,
    { stepIndex: member.stepIndex, use },
  ]);
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
  const runStartView = options.runStartView ?? RunStartView.resolve(workflow);
  const variables = runStartView.vars;
  const issues: ParallelGroupPreflightIssue[] = [];

  const authoredStep = runStartView.resolveStep(
    options.step,
    options.stepIndex
  );
  const resolveTarget = (from: WorkflowStep) =>
    resolveExecutionProperties(
      promptProjection(from),
      runStartView.applyToWorkflow(workflow),
      { defaults: options.defaults, hostCanProvidePty }
    );
  let step: WorkflowStep;
  let resolvedTarget: ResolvedExecutionTarget;
  let resolvedProperties: ResolvedProperties;
  try {
    step = VarSubstitutor.substituteStepView(
      authoredStep,
      variables,
      VAR_SUBSTITUTION_PHASES.DISPATCH,
      options.stepIndex
    );
    resolvedTarget = resolveTarget(step);
    resolvedProperties = VarSubstitutor.applyToResolvedProperties(
      resolvedTarget.properties,
      variables
    );
  } catch (error) {
    if (!(error instanceof VarSubstitutionValidationError)) throw error;
    // Not a group conflict: the member fails alone, under its errorBehavior.
    const unresolvedTarget = resolveTarget(authoredStep);
    return {
      member: {
        stepIndex: options.stepIndex,
        step: authoredStep,
        resolvedTarget: unresolvedTarget,
        resolvedProperties: unresolvedTarget.properties,
        variables,
        varSubstitutionError: error,
      },
      issues: [],
      failureMessage: "",
    };
  }
  if (isSubWorkflowStep(step)) {
    // A child run is its own instance: its steps go through their own
    // preflight, so the harness, session, integration and interactive checks
    // of this group do not apply to it (P3).
    const subWorkflowLaunch = await options.prepareSubWorkflowMember?.(
      authoredStep as SubWorkflowStep,
      options.stepIndex
    );
    const subWorkflowMember: ParallelGroupPreflightMember = {
      stepIndex: options.stepIndex,
      step,
      resolvedTarget,
      resolvedProperties,
      variables,
      ...(subWorkflowLaunch ? { subWorkflowLaunch } : {}),
    };
    const subWorkflowIssues = [
      mergeIntoSharedRootIssue(
        workflow,
        subWorkflowMember,
        options.reservedMembers ?? [],
        options.parentRunsInMainCheckout ?? false
      ),
      worktreeCollisionIssue(
        workflow,
        subWorkflowMember,
        options.reservedMembers ?? []
      ),
    ].filter((issue): issue is ParallelGroupPreflightIssue => !!issue);
    return {
      member: subWorkflowMember,
      issues: subWorkflowIssues,
      failureMessage:
        subWorkflowIssues.length > 0
          ? formatMemberPreflightFailure(options.stepIndex, subWorkflowIssues)
          : "",
    };
  }
  const prompt = promptProjection(step);
  const effectivePromptText = isPromptStep(step)
    ? await resolvePromptTextWithVariables(
        step.prompt,
        variables,
        options.promptFileResolver ?? PASSTHROUGH_PROMPT_FILE_RESOLVER,
        options.sourceDefinitionPath
      )
    : undefined;
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

  const candidateSessionId = isPromptStep(step)
    ? SessionResolver.resolveWithProperties(
        prompt,
        options.stepIndex,
        workflow.steps ?? [],
        resolvedProperties,
        options.finalStepSessionId,
        group.startIndex,
        false
      )
    : undefined;

  const reservedMembers = options.reservedMembers ?? [];
  const sessionOwners = reservedMembers.filter(
    (reserved) =>
      isPromptStep(reserved.step) &&
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
      reserved.varSubstitutionError === undefined &&
      // A sub-workflow member's terminal belongs to its child instance.
      !isSubWorkflowStep(reserved.step) &&
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

  const mergeIssue = mergeIntoSharedRootIssue(
    workflow,
    member,
    reservedMembers,
    options.parentRunsInMainCheckout ?? false
  );
  if (mergeIssue) issues.push(mergeIssue);

  if (isPromptStep(step) && options.checkHarnessReady) {
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
  if (isPromptStep(step) && options.ensureIsolatedIntegration) {
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
        message: `${memberLabel(workflow, options.stepIndex)} could not create an isolated ${resolvedProperties.harness} integration: ${getErrorMessage(error)}`,
      });
    }
  }

  const result: ParallelGroupMemberPreflightResult = {
    member: memberWithIntegration,
    issues,
    failureMessage: formatMemberPreflightFailure(options.stepIndex, issues),
  };
  return result;
}

function formatMemberPreflightFailure(
  stepIndex: number,
  issues: readonly ParallelGroupPreflightIssue[]
): string {
  return [
    `Parallel step ${stepIndex + 1} failed preflight:`,
    ...issues.map((issue) => `- ${issue.message}`),
  ].join("\n");
}

/** Resolve and validate every enabled member before any group member launches. */
export async function preflightParallelGroup(
  options: ParallelGroupPreflightOptions
): Promise<ParallelGroupPreflightResult> {
  // One view for every member, so each member sees the same run-start values.
  const runStartView =
    options.runStartView ?? RunStartView.resolve(options.workflow);
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
    const authoredStep = options.workflow.steps?.[stepIndex];
    const step = authoredStep
      ? runStartView.resolveStep(authoredStep, stepIndex)
      : undefined;
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
      runStartView,
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

function formatParallelGroupPreflightFailure(
  result: ParallelGroupPreflightResult
): string {
  return [
    `${formatParallelStepsLabel(result.group)} failed preflight:`,
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
  return result.effectiveWidth <= 1
    ? `${formatParallelStepsLabel(result.group)} run sequentially (effective width 1).`
    : `${formatParallelStepsLabel(result.group)} run up to ${result.effectiveWidth} members concurrently.`;
}

export function parallelGroupIssueSeverity() {
  return COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR;
}

export function parallelGroupConsumer(stepIndex: number) {
  return { kind: FINAL_STEP_PHASES.QUEUE, stepIndex } as const;
}
