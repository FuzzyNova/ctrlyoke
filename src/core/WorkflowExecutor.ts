import * as path from "path";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import {
  PromptStep,
  ScriptStep,
  WorkflowStep,
  isScriptStep,
  DynamicQueueConfig,
  FinalStepRuntimeState,
  EXECUTION_STATES,
  HarnessId,
  type ScriptVerdict,
  type ErrorBehavior,
  type WorkflowAttemptTarget,
  type PreConditionAction,
  type StepExecutionOutcome,
  type ParallelGroupOutcome,
  type ParallelGroupDefinition,
  type ScriptProperties,
} from "../types/CtrlYokeTypes";
import {
  WorkflowContext,
  type ExecutionWorkspace,
} from "../types/WorkflowContextTypes";
import {
  EXECUTION_MODES,
  CTRLYOKE_ENV_VARS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  PROMPT_DIAGNOSTIC_CODES,
  formatContextResolutionFailureMessage,
  isContextResolutionDiagnostic,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  FINAL_STEP_PHASES,
  PARALLEL_GROUP_ADMISSION,
  CONDITION_ACTIONS,
  STEP_TYPES,
  SCRIPT_VERDICT_OUTCOMES,
  WORKFLOW_EXECUTION_OUTCOMES,
  COMPARE_SOURCES,
  EXECUTION_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  SCRIPT_SOURCE_LABELS,
  FAILURE_KINDS,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
  ATTEMPT_COST_UNAVAILABLE_REASONS,
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  TOKEN_TOTAL_CONFIDENCE,
  PROMPT_TERMINAL_STATUS,
  STEP_CLAIM_OUTCOMES,
  getEffectiveParallelGroupWidth,
  type ConditionAction,
  type StatusMessageSeverity,
  type WorkflowExecutionOutcome,
} from "../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import { PromptQueue } from "./PromptQueue";
import { HarnessIntegration } from "./HarnessIntegration";
import {
  EndConditionHandler,
  SendRetryPromptCallback,
  type RetryContext,
} from "./EndConditionHandler";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "./EndConditionEvaluator";
import { Log } from "../utils/Log";
import {
  PropertyResolver,
  type ResolvedProperties,
} from "../utils/PropertyResolver";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  exceedsLimit,
  formatRetryDenominator,
  isUnlimited,
} from "../utils/LimitUtils";
import {
  buildStepLimitError,
  getEffectiveMaxStepsSource,
  resolveEffectiveMaxSteps,
} from "../utils/QueueLimitUtils";
import { resolveReportedScriptProperties } from "../utils/ScriptComparison";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import {
  findSecretInterpolationsInPrompt,
  buildSecretProcessEnvironment,
  expandSecretInterpolations,
  findMissingSecretNames,
  getProcessMapSecretNames,
  getDeclaredSecretGrants,
  assertSecretGrantTrust,
  findUnapprovedSecretGrants,
  MissingSecretError,
  resolveSecretEnvironment,
} from "../utils/SecretResolver";
import { getEffectiveSecretGrants } from "../utils/SecretReferenceParser";
import { McpServerNormalizer } from "../utils/McpServerNormalizer";
import {
  secretGrantsTrustStore,
  type SecretGrantsTrustStore,
} from "../config/SecretGrantsTrustStore";
import { PromptFileResolver } from "./PromptFileResolver";
import { resolvePromptTextWithVariables } from "./PromptTextResolver";
import {
  CliOutputFormatter,
  DashboardOutput,
} from "./harness/shared/CliOutputFormatter";
import {
  OutputHistoryManager,
  type DefinitionRevisionContext,
} from "./orchestration/OutputHistoryManager";
import { CliEvent, CliOutput } from "../types/WebviewMessageTypes";
import {
  WorkspaceSnapshotService,
  RawWorkspaceState,
} from "../utils/WorkspaceSnapshotService";
import {
  WorkspaceSnapshot,
  OutputExecutionTarget,
} from "../types/OutputHistoryTypes";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { RunSecretRedactor } from "../utils/SecretRedactionService";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { mapSourceDefinitionPathToExecution } from "../platform/WorkspaceRootResolver";
import { pathsEqual } from "../utils/PathCasing";
import { summarizeCompactionEvents } from "../utils/TokenUsage";
import { calculateAttemptCost } from "../utils/ModelPricing";
import { HARNESS_TOKEN_SEMANTICS } from "../utils/TokenSemantics";
import {
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  type TimelineAttemptTerminalState,
  type TimelineAttemptStartReason,
} from "../types/WorkflowTimelineTypes";
import {
  formatVerdictSummary,
  createConditionEvaluationSummary,
  ScriptExecutionReporter,
} from "./orchestration/ScriptExecutionReporter";
import type { ScriptProcessRunner } from "./orchestration/ScriptProcessRunner";
import {
  getSignedStepIndex as getSignedWorkflowStepIndex,
  toOutputExecutionTarget as toWorkflowOutputExecutionTarget,
  type StatusMessageReporter,
} from "./orchestration/StatusMessageReporter";
import {
  preflightParallelGroup,
  preflightParallelGroupMember,
  throwIfParallelGroupPreflightFailed,
  type ParallelGroupMemberPreflightResult,
  type ParallelGroupPreflightMember,
  type ParallelGroupPreflightOptions,
} from "./ParallelGroupPreflight";
import { ParallelGroupRun } from "./ParallelGroupRun";
import { RecordedTargetFailureError } from "./RecordedTargetFailureError";
import {
  formatFinalPassLabel,
  formatFinalPassPhrase,
} from "../utils/FinalStepLabels";

export interface WorkflowExecutionContext {
  /** Immutable state/execution roots for this workflow run. */
  executionWorkspace: ExecutionWorkspace;
  /** Whether this host can provide a PTY for interactive execution. */
  hostCanProvidePty?: boolean;
  /** Whether this host can multiplex concurrent interactive sessions. */
  supportsConcurrentInteractiveSessions?: boolean;
  workspaceFolderPath: string | undefined;
  /**
   * Open workspace roots (multi-root). Passed to WorkspaceSnapshotService so
   * capture/undo span every root's repo, not just the primary. Empty/one-entry
   * in single-root, where snapshot behavior stays byte-identical.
   */
  namedWorkspaceRoots?: readonly ResolverWorkspaceFolder[];
  currentPromptFilePath: string | undefined;
  /** Authored workflow definition used as the semantic base for prompt-file refs. */
  sourceDefinitionPath?: string;
  statusReporter: StatusMessageReporter;
  dashboardProvider?: IDashboardSink;
  reportCompatibilityDiagnostics?: WorkflowContext["reportCompatibilityDiagnostics"];
  analyzeCompatibilityForPrompt?: WorkflowContext["analyzeCompatibilityForPrompt"];
  shouldShowCliCommand: boolean;
  dynamicQueueConfig: DynamicQueueConfig;
  /** Allows coordinator tests to exercise fan-out while the production gate is closed. */
  parallelGroupFanOutEnabled?: boolean;
  /** Group-scoped cancellation signal for target leaves. */
  abortSignal?: AbortSignal;
  getIntegrationForPrompt: (
    prompt: PromptStep,
    resolvedProperties: ResolvedProperties,
    target?: ExecutionTarget
  ) => HarnessIntegration;
  /** Retire a sibling integration's PTY when this dispatch takes over its session. */
  releaseConflictingAiSession?: WorkflowContext["releaseConflictingAiSession"];
  /** Wait for the detector singleton to prove a required harness ready. */
  ensureHarnessReady?: (harnessId: HarnessId) => Promise<string | undefined>;
  /** Enables isolated target-keyed integrations for a parallel coordinator. */
  targetKeyedExecution?: boolean;
  registerActiveTarget?: (
    target: ExecutionTarget,
    attemptIndex: number
  ) => void;
  registerTargetPtySession?: (
    target: ExecutionTarget,
    sessionId: string
  ) => void;
  clearTargetPtySession?: (target: ExecutionTarget) => void;
  unregisterActiveTarget?: (target: ExecutionTarget) => void;
  cancelTarget?: (target: ExecutionTarget) => Promise<void>;
  releaseTargetResources?: (target: ExecutionTarget) => Promise<void>;
  /** Close the addressed coordination participant when a target settles. */
  closeCoordinationParticipant?: (
    target: WorkflowAttemptTarget
  ) => Promise<void>;
  /** Release all claims held by members of a group at its join boundary. */
  releaseCoordinationGroupClaims?: (
    group: ParallelGroupDefinition
  ) => Promise<void>;
  getScriptProcessRunner?: (target: ExecutionTarget) => ScriptProcessRunner;
  historyFilePath: string;
  workingFilePath?: string;
  /** Runtime addresses for generated built-in MCP skill instructions. */
  mcpToolSkillContext?: WorkflowContext["mcpToolSkillContext"];
  instanceTag?: string;
  /** Workflow instance UUID — used as the PTY workflowId so terminal sessions
   *  are keyed by the same ID the webview uses for activeWorkflowId. */
  instanceId?: string;
  onStatusMessage?: (
    stepIndex: number,
    message: string,
    severity: string
  ) => void;
  onTargetStreamingEvents?: (data: {
    target: WorkflowAttemptTarget;
    stepName: string;
    events: CliEvent[];
  }) => void;
  onTargetStreamingChunk?: (data: {
    target: WorkflowAttemptTarget;
    stepName: string;
    chunk: string;
  }) => void;
  /** Fires script command/output updates with the execution target that produced them. */
  onScriptOutput?: (target: OutputExecutionTarget, output: CliOutput) => void;
  /** Fires completed script output, including the structured verdict. */
  onScriptCompletedOutput?: (
    target: OutputExecutionTarget,
    output: CliOutput
  ) => void;
  outputHistoryManager?: OutputHistoryManager;
  /** Run-owned redactor populated only with values resolved during execution. */
  secretRedactor?: RunSecretRedactor;
  /**
   * Always-on callback to capture the init state for a queue step's output (called even when
   * the workflow is inactive/backgrounded). Used to buffer output for replay when switching
   * back to this workflow instance.
   */
  captureOutputInit?: (
    stepIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    cliCommandWasInjected: boolean | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput?: boolean,
    runIndex?: number
  ) => void;
  /** Always-on chunk buffer for queue steps — enables output replay on workflow switch. */
  captureChunk?: (stepIndex: number, chunk: string) => void;
  /** Always-on completed-output capture for queue steps — enables replay on workflow switch. */
  captureCompletedOutput?: (
    stepIndex: number,
    output: any,
    integration?: HarnessIntegration
  ) => void;
  /** Always-on structured event buffer for queue steps — enables replay on workflow switch. */
  captureEvents?: (stepIndex: number, events: CliEvent[]) => void;
  /**
   * Always-on live context-window buffer for queue steps — enables the
   * running-step gauge to be replayed immediately on workflow switch instead
   * of waiting for the harness's next update (which may be seconds/minutes
   * away, or never arrive again if the step finishes clean).
   */
  captureContextWindow?: (
    stepIndex: number,
    used: number,
    size: number
  ) => void;
  /** Snapshot of in-flight queue output already sent to the dashboard. */
  getBufferedOutput?: (stepIndex: number) => CliOutput | undefined;
  /** Mirror of captureOutputInit for finalStep loops, keyed by loopIndex. */
  captureFinalStepOutputInit?: (
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    cliCommandWasInjected: boolean | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput?: boolean,
    runIndex?: number
  ) => void;
  /**
   * Switch post-completion session activity attribution to the prompt about to
   * be dispatched. Called immediately before sendPrompt synchronously parks the
   * prior step's watcher.
   */
  beginSessionActivityTargetCapture?: (
    integration: HarnessIntegration,
    target: ExecutionTarget
  ) => void;
  captureFinalStepChunk?: (loopIndex: number, chunk: string) => void;
  captureFinalStepEvents?: (loopIndex: number, events: CliEvent[]) => void;
  captureFinalStepCompletedOutput?: (
    loopIndex: number,
    output: any,
    integration?: HarnessIntegration
  ) => void;
  /** Snapshot of in-flight finalStep output already sent to the dashboard. */
  getFinalStepBufferedOutput?: (loopIndex: number) => CliOutput | undefined;
  onFinalStepStatusMessage?: (
    loopIndex: number,
    message: string,
    severity: string
  ) => void;
  /** WorkspaceSnapshotService instance — shared across the workflow run */
  snapshotService?: WorkspaceSnapshotService;
  /** Callback to emit live snapshot data to the webview after a prompt completes */
  onSnapshotCaptured?: (
    target: ExecutionTarget,
    snapshot: WorkspaceSnapshot
  ) => void;
  /**
   * Spawn a PTY session for interactive script execution.
   * Wraps the script in a shell so PTY interactive input works correctly.
   * Sends TERMINAL_STARTED / TERMINAL_OUTPUT / TERMINAL_ENDED to the webview and
   * resolves with the process exit code when the PTY exits.
   * Only available when running inside the VS Code extension (not CLI mode).
   */
  spawnScriptPty?: (options: {
    /** Human-readable step label shown in the terminal tab header. */
    stepName: string;
    /** Signed step index used as the CLI output slot. */
    stepIndex: number;
    /** Parallel group identity for grouped queue steps. */
    parallelGroupId?: string;
    /** Resource-registry key for the owning execution target. */
    targetKey: string;
    /** Raw script string from the step definition (e.g. ".ctrlyoke/scripts/check.py arg"). */
    script: string;
    /** Optional shell executable for inline script execution. */
    shell?: string;
    /** Working directory for the script process. */
    cwd: string;
    /** Environment overrides for the script process. */
    env?: Record<string, string>;
    /** Called for each output chunk — used to stream text to the CliOutput panel. */
    onOutput: (chunk: string) => void;
    /** Maximum runtime in milliseconds before the PTY is killed. */
    timeout: number;
    /** Called when the PTY is killed because its timeout expired. */
    onTimeout?: () => void;
    onSessionCreated?: (sessionId: string) => void;
    onSessionEnded?: () => void;
  }) => Promise<number>;
  targetRunIndices?: Map<string, number>;
  /**
   * The definitionRevision producing this run's current output, plus the snapshot to
   * commit before its first attempt. A getter so it reflects the live queue definition
   * (append/edit can advance it mid-run), evaluated fresh on every output write.
   */
  getDefinitionRevisionContext?: () => DefinitionRevisionContext | undefined;
  /** Timeline-backed response source for prior-context prompt construction. */
  resolvePriorContextItems?: WorkflowContext["resolvePriorContextItems"];
}

export type ParallelGroupJoinResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly diagnostic: string };

type ExecutionTarget = WorkflowAttemptTarget;

function getExecutionTargetRunKey(target: ExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
}

function isStepEnabled(step: WorkflowStep | undefined | null): boolean {
  return step != null && step.enabled !== false;
}

/** Map condition-authored script fields through the shared comparison resolver. */
function toReportedConditionProperties(condition: ScriptProperties) {
  return resolveReportedScriptProperties({
    script: condition.script,
    env: condition.env,
    compareSource: condition.compareSource,
    operator: condition.operator,
    expected: condition.expected,
    ignoreCase: condition.ignoreCase,
    timeoutSec: condition.timeoutSec,
    shell: condition.shell,
  });
}

type PromptFailureDisposition =
  | {
      outcome: typeof WORKFLOW_EXECUTION_OUTCOMES.RETRY;
      nextErrorRetryCount?: number;
    }
  | { outcome: typeof WORKFLOW_EXECUTION_OUTCOMES.CONTINUE }
  | { outcome: typeof WORKFLOW_EXECUTION_OUTCOMES.STOP };

type PhaseDisposition = {
  outcome: WorkflowExecutionOutcome;
  nextAttemptIndex?: number;
  nextErrorRetryCount?: number;
};

function canRetryErrorBehavior(
  errorBehavior: ErrorBehavior,
  attemptIndex: number
): boolean {
  return (
    errorBehavior.onError === CONDITION_ACTIONS.RETRY &&
    attemptIndex < (errorBehavior.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES)
  );
}

function getAttemptStartReason(
  attemptIndex: number
): TimelineAttemptStartReason {
  return attemptIndex > 0
    ? TIMELINE_ATTEMPT_START_REASONS.RETRY
    : TIMELINE_ATTEMPT_START_REASONS.INITIAL;
}

/**
 * Drives the sequential execution loop for a ctrlyoke workflow.
 *
 * The outer loop has two phases:
 *   1. **Queue phase** — drains normal prompts via `promptQueue.hasNext()`.
 *   2. **finalStep phase** — runs the orchestrator gate once the queue is empty.
 *      If the gate appends new prompts, the outer loop repeats
 *      (queue → finalStep → queue → …).
 *
 * Pause requests are honored only at a fully finalized step boundary: response
 * persistence, post-conditions, attempt completion, stats, and queue advancement
 * all finish before execution transitions from PAUSING to PAUSED.
 */
export class WorkflowExecutor {
  private readonly waitingResponseTargets = new Set<string>();
  private readonly targetExecutionErrors = new Map<string, unknown>();
  private readonly scriptExecutionReporter: ScriptExecutionReporter;
  private activeParallelGroupRun:
    ParallelGroupRun<WorkflowExecutionContext> | undefined;
  private activeParallelGroupPreflightMembers:
    Map<number, ParallelGroupPreflightMember> | undefined;
  private parallelGroupJoinQueue: Promise<void> = Promise.resolve();
  /**
   * The context and snapshot strategy of the execution currently draining the
   * queue. An ad-hoc promotion arrives from outside the loop and needs both to
   * start the promoted group's run beside the in-flight anchor.
   */
  private activeExecution:
    | {
        readonly context: WorkflowExecutionContext;
        readonly snapshotStrategy: "git" | "filesystem" | undefined;
      }
    | undefined;
  /**
   * A group run started by an ad-hoc promotion while its anchor was still
   * executing sequentially. The sequential settlement consumes it; it is never
   * re-created by the queue loop for the same group.
   */
  private promotedParallelGroupRun:
    | {
        readonly groupId: string;
        readonly run: ParallelGroupRun<WorkflowExecutionContext>;
        readonly outcome: Promise<ParallelGroupOutcome>;
      }
    | undefined;
  /**
   * A sequential step can become a group's started anchor while it is still
   * executing. Keep its captured before-state until the promoted group has
   * settled so the group snapshot retains the original undo boundary.
   */
  private readonly pendingSequentialSnapshotBeforeStates = new Map<
    string,
    RawWorkspaceState
  >();

  constructor(
    private readonly promptQueue: PromptQueue,
    private readonly endConditionHandler: EndConditionHandler,
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly platform: PlatformAdapter,
    private readonly userFeedbackSink?: UserFeedbackSink,
    private readonly secretGrantTrustStore: Pick<
      SecretGrantsTrustStore,
      "getDecision"
    > = secretGrantsTrustStore
  ) {
    this.scriptExecutionReporter = new ScriptExecutionReporter(
      endConditionEvaluator
    );
    this.promptQueue.onDidMergeDiskSteps((steps) => {
      const groupRun = this.activeParallelGroupRun;
      if (!groupRun) {
        return;
      }
      const group = this.promptQueue
        .getState()
        .parallelGroups.find((candidate) => candidate.id === groupRun.group.id);
      if (!group) {
        return;
      }
      const survivingIds = steps
        .map((step) => step._runtime?.stepId)
        .filter((stepId): stepId is string => stepId !== undefined)
        .filter((stepId) => {
          const index = this.promptQueue
            .getState()
            .steps.findIndex(
              (candidate) => candidate._runtime?.stepId === stepId
            );
          return index >= group.startIndex && index <= group.endIndex;
        });
      groupRun.reconcileMembers(survivingIds);
    });
  }

  private getRuntime() {
    return this.promptQueue.getRuntimeStateMachine();
  }

  /**
   * Execute the workflow. Supports resume from a paused or previously-stopped
   * run — the queue's `currentIndex` and `finalStepRuntime` phase are both
   * restored from the working file before this is called, so the loop picks up
   * exactly where it left off.
   */
  async execute(
    _defaultIntegration: HarnessIntegration,
    context: WorkflowExecutionContext
  ): Promise<void> {
    this.clearResponseWaitState();

    const runtime = this.promptQueue.getRuntimeStateMachine();
    if (runtime.startExecution()) {
      await this.promptQueue.commitRuntimeTransition();
    }
    if (runtime.startExecutionTimer()) {
      await this.promptQueue.commitRuntimeTransition({
        persist: false,
        emitStateChange: false,
      });
    }

    await this.showDashboard();

    if (
      await this.checkStepLimit(
        this.promptQueue.getWorkflowFile().maxSteps,
        this.promptQueue.getState().steps.length
      )
    ) {
      return;
    }

    this.logWorkflowStart(context, this.promptQueue.getProgress().total);

    const snapshotStrategy = await this.selectSnapshotStrategy(context);
    // Published for the duration of the drain so an out-of-loop admission
    // (Run in Parallel / an MCP live join) can start a promoted group's run
    // with the same context and snapshot strategy the loop would have used.
    this.activeExecution = { context, snapshotStrategy };
    try {
      await this.initializeFinalStepRuntime(context);

      const getFinalStep = () => this.promptQueue.getWorkflowFile().finalStep;

      const initialFinalStep = getFinalStep();

      // Only skip the queue drain and go straight to the finalStep when resuming
      // a run that was interrupted mid-finalStep AND there are no pending queue
      // items waiting to run. If there are pending items (e.g. an ephemeral
      // prompt was appended to a completed workflow), drain the queue first so
      // the new prompts are not skipped.
      let runFinalStepFirst =
        !!initialFinalStep &&
        this.promptQueue.getFinalStepRuntime()?.phase ===
          FINAL_STEP_PHASES.FINAL_STEP &&
        !this.promptQueue.hasNext();
      while (true) {
        if (!runFinalStepFirst) {
          while (this.promptQueue.hasNext()) {
            const state = this.promptQueue.getState();
            if (
              await this.checkExecutionTimeLimit(
                context.dynamicQueueConfig,
                state.currentIndex,
                this.promptQueue.getProgress().total
              )
            ) {
              break;
            }
            const group = state.parallelGroups.find((candidate) => {
              if (candidate.startIndex === state.currentIndex) {
                return true;
              }
              // A sequential anchor advances currentIndex when it settles. If
              // it was promoted while in flight, resume at the next unsettled
              // member but keep the group's original start boundary.
              return (
                state.currentIndex > candidate.startIndex &&
                state.currentIndex <= candidate.endIndex &&
                state.steps
                  .slice(candidate.startIndex, state.currentIndex)
                  .every((step) => step._runtime?.completedAt !== undefined)
              );
            });
            if (group) {
              const groupOutcome = await this.executeParallelGroup(
                group,
                context,
                snapshotStrategy
              );
              if (
                groupOutcome.paused ||
                groupOutcome.stopped ||
                groupOutcome.terminalFailure
              ) {
                break;
              }
              continue;
            }

            const target: ExecutionTarget = {
              kind: FINAL_STEP_PHASES.QUEUE,
              stepIndex: state.currentIndex,
            };
            const prompt = state.steps[state.currentIndex];
            const stepId = prompt?._runtime?.stepId;
            if (!stepId) {
              throw new Error(
                `Cannot dispatch queue step ${state.currentIndex}: missing stepId`
              );
            }
            const claim = await this.promptQueue.claimStepById(
              stepId,
              Date.now(),
              context.executionWorkspace.stateRoot
            );
            if (claim.status === STEP_CLAIM_OUTCOMES.MISSING) {
              continue;
            }
            if (claim.status !== STEP_CLAIM_OUTCOMES.CLAIMED) {
              throw new Error(
                `Cannot dispatch step ${stepId}: claim ${claim.status}`
              );
            }
            const outcome = await this.executeWithSnapshot(
              { ...target, stepIndex: claim.stepIndex },
              claim.step,
              context,
              snapshotStrategy
            );
            const shouldContinue = await this.commitSequentialOutcome(
              outcome,
              context
            );

            if (!shouldContinue) {
              break;
            }
          }
        }

        runFinalStepFirst = false;

        const statusAfterQueue = runtime.status;
        // Resume can race the short unwind after a confirmed pause. If it does,
        // keep using this execution loop instead of skipping the remaining queue.
        if (
          statusAfterQueue === EXECUTION_STATES.RUNNING &&
          this.promptQueue.hasNext()
        ) {
          continue;
        }
        if (statusAfterQueue !== EXECUTION_STATES.RUNNING) {
          break;
        }

        const currentFinalStep = getFinalStep();
        if (!currentFinalStep) {
          break;
        }
        if (
          await this.checkExecutionTimeLimit(
            context.dynamicQueueConfig,
            this.promptQueue.getState().currentIndex,
            this.promptQueue.getProgress().total
          )
        ) {
          break;
        }

        // Initialize runtime if a final step was added after execution started
        if (!this.promptQueue.getFinalStepRuntime()) {
          await this.setFinalStepRuntime(context, {
            phase: FINAL_STEP_PHASES.QUEUE,
            loopCount: 0,
          });
        }

        const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
        const loopIndex = finalStepRuntime?.loopCount ?? 0;
        const queueSizeBefore = this.promptQueue.getState().steps.length;

        await this.setFinalStepRuntime(context, {
          phase: FINAL_STEP_PHASES.FINAL_STEP,
          loopCount: loopIndex,
          status: STEP_STATUS.RUNNING,
          startedAt: Date.now(),
        });

        const finalTarget: ExecutionTarget = {
          kind: FINAL_STEP_PHASES.FINAL_STEP,
          loopIndex,
        };
        const finalOutcome = await this.executeWithSnapshot(
          finalTarget,
          currentFinalStep,
          context,
          snapshotStrategy
        );
        await this.settleCoordinationParticipant(finalOutcome.target, context);
        const shouldContinue =
          finalOutcome.status === PROMPT_TERMINAL_STATUS.COMPLETED;

        if (!shouldContinue) {
          if (finalOutcome.status === PROMPT_TERMINAL_STATUS.FAILED) {
            runtime.fail();
            await this.promptQueue.commitRuntimeTransition();
          } else if (
            finalOutcome.status === PROMPT_TERMINAL_STATUS.CANCELLED &&
            runtime.status === EXECUTION_STATES.CANCELLING
          ) {
            runtime.confirmStopped();
            await this.promptQueue.commitRuntimeTransition();
          }
          await this.persistInterruptedFinalStepRuntime(context);
          break;
        }

        const statusAfterFinal = runtime.status;
        if (
          statusAfterFinal === EXECUTION_STATES.STOPPED ||
          statusAfterFinal === EXECUTION_STATES.CANCELLING ||
          statusAfterFinal === EXECUTION_STATES.ERROR
        ) {
          await this.persistInterruptedFinalStepRuntime(context);
          break;
        }

        const queueSizeAfter = this.promptQueue.getState().steps.length;
        if (queueSizeAfter > queueSizeBefore) {
          const hitQueueSizeLimit = await this.checkStepLimit(
            this.promptQueue.getWorkflowFile().maxSteps,
            queueSizeAfter
          );
          if (hitQueueSizeLimit) {
            break;
          }

          await this.setFinalStepRuntime(context, {
            phase: FINAL_STEP_PHASES.QUEUE,
            loopCount: loopIndex + 1,
            status: STEP_STATUS.COMPLETED,
            startedAt:
              this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
            completedAt: Date.now(),
          });

          if (
            await this.confirmPauseAndStop(
              "[WorkflowExecutor] Workflow paused after final step appended queue work"
            )
          ) {
            break;
          }

          continue;
        }

        await this.setFinalStepRuntime(context, {
          phase: FINAL_STEP_PHASES.FINAL_STEP,
          loopCount: loopIndex,
          status: STEP_STATUS.COMPLETED,
          startedAt: this.promptQueue.getFinalStepRuntime()?.startedAt,
          completedAt: Date.now(),
        });

        if (
          await this.confirmPauseAndStop(
            "[WorkflowExecutor] Workflow paused after final step"
          )
        ) {
          break;
        }

        break;
      }

      Log.info("[WorkflowExecutor] Workflow execution complete");
      await this.finalizeWorkflowExecution();
      this.logWorkflowCompletion(context, this.promptQueue.getProgress().total);
    } finally {
      this.activeExecution = undefined;
    }
  }

  private async preflightGroup(
    group: ParallelGroupDefinition,
    context: WorkflowExecutionContext
  ) {
    const preflight = await preflightParallelGroup(
      this.getParallelGroupPreflightOptions(group, context)
    );

    Log.info(
      `[WorkflowExecutor] Parallel steps ${group.startIndex + 1}–${group.endIndex + 1}: effective width ${preflight.effectiveWidth}`
    );
    if (preflight.issues.length > 0) {
      await Promise.all(
        preflight.members.map((member) =>
          context.releaseTargetResources?.({
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: member.stepIndex,
          })
        )
      );
      throwIfParallelGroupPreflightFailed(preflight);
    }
    for (const member of preflight.members) {
      if (
        !isScriptStep(member.step) &&
        member.resolvedProperties.resumeSession &&
        member.resolvedSessionId === undefined
      ) {
        Log.warn(
          `[WorkflowExecutor] Parallel preflight: Step ${member.stepIndex + 1}${member.step.name ? ` ("${member.step.name}")` : ""} has no historical ${member.resolvedProperties.harness} session at the group boundary; starting fresh.`
        );
      }
    }
    return preflight;
  }

  private getParallelGroupPreflightOptions(
    group: ParallelGroupDefinition,
    context: WorkflowExecutionContext
  ): ParallelGroupPreflightOptions {
    const workflow = this.promptQueue.getWorkflowFile();
    return {
      workflow,
      group,
      defaults: PropertyResolver.createContext({
        hostCanProvidePty: context.hostCanProvidePty,
      }).defaults,
      hostCanProvidePty: context.hostCanProvidePty ?? true,
      supportsConcurrentInteractiveSessions:
        context.supportsConcurrentInteractiveSessions ?? true,
      configuredWidth: context.dynamicQueueConfig.maxParallelSteps,
      fanOutEnabled: context.parallelGroupFanOutEnabled,
      excludeTerminalMembers: true,
      ...this.getPromptFileResolutionOptions(context),
      normalizeProperties: async (
        properties,
        memberStep,
        effectivePromptText
      ) =>
        isScriptStep(memberStep)
          ? properties
          : (
              await McpServerNormalizer.applyFromRegistryWithDiagnostics(
                properties,
                context.workspaceFolderPath ??
                  context.executionWorkspace.executionRoot,
                effectivePromptText ?? ""
              )
            ).properties,
      checkHarnessReady: context.ensureHarnessReady,
      ensureIsolatedIntegration: (member) =>
        context.getIntegrationForPrompt(
          member.step as PromptStep,
          member.resolvedProperties,
          {
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: member.stepIndex,
          }
        ),
      finalStepSessionId: workflow.finalStep?._runtime?.sessionId as
        string | undefined,
    };
  }

  private async preflightGroupMember(
    group: ParallelGroupDefinition,
    step: WorkflowStep,
    stepIndex: number,
    context: WorkflowExecutionContext,
    runningMembers: readonly ParallelGroupPreflightMember[]
  ): Promise<ParallelGroupMemberPreflightResult> {
    const result = await preflightParallelGroupMember({
      ...this.getParallelGroupPreflightOptions(group, context),
      step,
      stepIndex,
      reservedMembers: runningMembers,
    });
    if (
      !isScriptStep(result.member.step) &&
      result.member.resolvedProperties.resumeSession &&
      result.member.resolvedSessionId === undefined
    ) {
      Log.warn(
        `[WorkflowExecutor] Parallel preflight: Step ${stepIndex + 1}${result.member.step.name ? ` ("${result.member.step.name}")` : ""} has no historical ${result.member.resolvedProperties.harness} session at the group boundary; starting fresh.`
      );
    }
    return result;
  }

  private getRecoveredGroupOutcome(
    stepIndex: number
  ): StepExecutionOutcome | undefined {
    const step = this.promptQueue.getState().steps[stepIndex];
    if (step?._runtime?.completedAt === undefined) {
      return undefined;
    }
    return {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
      status: step._runtime.terminalStatus ?? PROMPT_TERMINAL_STATUS.COMPLETED,
      ...(step._runtime.failureMessage
        ? { failureReason: step._runtime.failureMessage }
        : {}),
      ...(step._runtime.terminalFailure === false
        ? { terminalFailure: false }
        : {}),
    };
  }

  private async executeParallelGroup(
    group: ParallelGroupDefinition,
    context: WorkflowExecutionContext,
    snapshotStrategy: "git" | "filesystem" | undefined
  ): Promise<ParallelGroupOutcome> {
    // An ad-hoc promotion already started this group beside its anchor. Reuse
    // that run instead of forking a second coordinator for the same group.
    const promoted = this.takePromotedParallelGroupRun(group.id);
    if (promoted) {
      return this.finishParallelGroupRun(
        promoted.run,
        promoted.outcome,
        group,
        context
      );
    }
    const preflight = await this.preflightGroup(group, context);
    let groupBeforeState: RawWorkspaceState | undefined;
    const state = this.promptQueue.getState();
    if (preflight.effectiveWidth > 1 && snapshotStrategy) {
      const anchorId = state.steps[group.startIndex]?._runtime?.stepId;
      groupBeforeState = anchorId
        ? this.pendingSequentialSnapshotBeforeStates.get(anchorId)
        : undefined;
      if (!groupBeforeState) {
        const hasSettledMember = state.steps
          .slice(group.startIndex, group.endIndex + 1)
          .some((step) => step._runtime?.completedAt !== undefined);
        if (!hasSettledMember) {
          try {
            groupBeforeState =
              await context.snapshotService?.captureWorkspaceState(
                context.executionWorkspace.executionRoot,
                snapshotStrategy,
                context.executionWorkspace.namedWorkspaceRoots
              );
          } catch (error) {
            Log.warn(
              "[WorkflowExecutor] Failed to capture parallel group workspace snapshot:",
              error
            );
          }
        }
      }
    }
    const pendingIds: string[] = [];
    const initialOutcomes = new Map<string, StepExecutionOutcome>();
    const admissionTargets = new Map<string, number>();
    for (
      let stepIndex = group.startIndex;
      stepIndex <= group.endIndex;
      stepIndex += 1
    ) {
      const step = state.steps[stepIndex];
      const stepId = step?._runtime?.stepId;
      if (!step || !stepId) {
        throw new Error(
          `Cannot initialize parallel step ${stepIndex}: missing step identity`
        );
      }
      const recovered = this.getRecoveredGroupOutcome(stepIndex);
      if (recovered) {
        initialOutcomes.set(stepId, recovered);
      } else if (step.enabled === false) {
        const skipped: StepExecutionOutcome = {
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
          status: PROMPT_TERMINAL_STATUS.SKIPPED,
        };
        initialOutcomes.set(stepId, skipped);
        await this.persistGroupSettlement(skipped, context);
        if (groupBeforeState && snapshotStrategy) {
          await this.captureAndEmitSnapshot(
            { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: group.startIndex },
            groupBeforeState,
            snapshotStrategy,
            context,
            group.id
          ).catch((error) =>
            Log.warn(
              "[WorkflowExecutor] Failed to capture parallel group workspace snapshot:",
              error
            )
          );
        }
      } else {
        pendingIds.push(stepId);
        admissionTargets.set(stepId, stepIndex);
      }
    }
    await this.promptQueue.setActiveParallelGroupAdmission(
      group.id,
      PARALLEL_GROUP_ADMISSION.ACCEPTING
    );
    const groupRun = this.createParallelGroupRun({
      group,
      context,
      snapshotStrategy,
      pendingIds,
      initialOutcomes,
      admissionTargets,
      effectiveWidth: preflight.effectiveWidth,
      groupBeforeState,
    });
    this.activeParallelGroupRun = groupRun;
    this.activeParallelGroupPreflightMembers = new Map(
      preflight.members.map((member) => [member.stepIndex, member])
    );
    return this.finishParallelGroupRun(
      groupRun,
      groupRun.run(),
      group,
      context
    );
  }

  /**
   * Build the coordinator for one active parallel group. Both the queue loop
   * and an ad-hoc promotion construct their run here so admission, dispatch,
   * settlement, and join behave identically however the group came to exist.
   */
  private createParallelGroupRun(options: {
    readonly group: ParallelGroupDefinition;
    readonly context: WorkflowExecutionContext;
    readonly snapshotStrategy: "git" | "filesystem" | undefined;
    readonly pendingIds: readonly string[];
    readonly initialOutcomes: ReadonlyMap<string, StepExecutionOutcome>;
    readonly admissionTargets: ReadonlyMap<string, number>;
    readonly effectiveWidth: number;
    readonly groupBeforeState: RawWorkspaceState | undefined;
    readonly adoptedMemberIds?: readonly string[];
    /** Reservations held by members this run did not dispatch itself. */
    readonly adoptedReservations?: () => readonly ParallelGroupPreflightMember[];
  }): ParallelGroupRun<WorkflowExecutionContext> {
    const {
      group,
      context,
      snapshotStrategy,
      pendingIds,
      initialOutcomes,
      admissionTargets,
      groupBeforeState,
    } = options;
    return new ParallelGroupRun<WorkflowExecutionContext>({
      group,
      pendingIds,
      initialOutcomes,
      effectiveWidth: options.effectiveWidth,
      context,
      snapshotStrategy,
      groupBeforeState,
      ...(options.adoptedMemberIds
        ? { adoptedMemberIds: options.adoptedMemberIds }
        : {}),
      resolveStepById: (stepId) => {
        const stepIndex = this.promptQueue
          .getState()
          .steps.findIndex(
            (candidate) => candidate._runtime?.stepId === stepId
          );
        const step =
          stepIndex >= 0
            ? this.promptQueue.getState().steps[stepIndex]
            : undefined;
        return step ? { step, stepIndex } : undefined;
      },
      releaseRemovedPendingMember: async (stepId) => {
        const stepIndex = admissionTargets.get(stepId);
        if (stepIndex === undefined) return;
        await context.releaseTargetResources?.({
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex,
        });
      },
      claimStepById: (stepId, startedAt, groupContext) =>
        this.promptQueue.claimStepById(
          stepId,
          startedAt,
          groupContext.executionWorkspace.stateRoot
        ),
      preflightMember: async ({ step, stepIndex, runningMembers }) => {
        const liveGroup = this.promptQueue
          .getState()
          .parallelGroups.find((candidate) => candidate.id === group.id);
        if (!liveGroup) {
          throw new Error(
            `Cannot preflight parallel group ${group.id}: group is missing from the current definition`
          );
        }
        return this.preflightGroupMember(liveGroup, step, stepIndex, context, [
          // A member adopted from the sequential path holds a live session and
          // integration this run never reserved, so its reservation has to be
          // supplied explicitly or a joiner could collide with it.
          ...(options.adoptedReservations?.() ?? []),
          ...runningMembers,
        ]);
      },
      executeMember: async (
        target,
        step,
        groupContext,
        memberSnapshotStrategy,
        member
      ) => {
        try {
          return await this.executeWithSnapshot(
            target,
            step,
            groupContext,
            memberSnapshotStrategy,
            member
          );
        } finally {
          this.targetExecutionErrors.delete(getExecutionTargetRunKey(target));
        }
      },
      persistSettlement: (outcome, settlementContext) =>
        this.persistGroupSettlement(outcome, settlementContext),
      captureGroupSnapshot: async (
        target,
        beforeState,
        strategy,
        groupId,
        snapshotContext
      ) => {
        try {
          await this.captureAndEmitSnapshot(
            target,
            beforeState,
            strategy,
            snapshotContext,
            groupId
          );
        } catch (error) {
          Log.warn(
            "[WorkflowExecutor] Failed to capture parallel group workspace snapshot:",
            error
          );
        }
      },
      cancelTarget: context.cancelTarget,
      releaseTargetResources: context.releaseTargetResources,
      getRuntimeStatus: () => this.getRuntime().status,
      subscribeToStop: (onStop) =>
        this.getRuntime().onDidTransition((transition) => {
          if (
            transition.current.status === EXECUTION_STATES.CANCELLING ||
            transition.current.status === EXECUTION_STATES.STOPPED
          ) {
            onStop();
          }
        }),
      getCurrentGroup: (groupId) =>
        this.promptQueue
          .getState()
          .parallelGroups.find((candidate) => candidate.id === groupId),
      commitJoin: (joinGroup, outcomes) =>
        this.promptQueue.commitParallelGroupJoin(joinGroup, outcomes),
      persistAdmission: (admission) =>
        this.promptQueue.setActiveParallelGroupAdmission(group.id, admission),
      reconcileAndClose: ({
        groupId,
        outcomes,
        isKnownMember,
        reconcileMembers,
      }) =>
        this.promptQueue.reconcileAndCloseParallelGroup(
          groupId,
          outcomes,
          isKnownMember,
          reconcileMembers
        ),
      confirmPause: () =>
        this.confirmPauseAndStop(
          "[WorkflowExecutor] Workflow paused after parallel group members settled"
        ).then(() => undefined),
    });
  }

  /**
   * Await one group run to completion and apply the run-level consequences.
   * Shared by the queue loop and by the sequential settlement that consumes a
   * run started early by an ad-hoc promotion.
   */
  private async finishParallelGroupRun(
    groupRun: ParallelGroupRun<WorkflowExecutionContext>,
    runOutcome: Promise<ParallelGroupOutcome>,
    group: ParallelGroupDefinition,
    context: WorkflowExecutionContext
  ): Promise<ParallelGroupOutcome> {
    const anchorSnapshotId =
      this.promptQueue.getState().steps[group.startIndex]?._runtime?.stepId;
    try {
      const groupOutcome = await runOutcome;
      if (!groupOutcome.paused) {
        // The promoted anchor's held before-state has now been consumed as the
        // group snapshot. Release it here rather than leaving a workspace
        // capture pinned for the lifetime of the executor. A paused group is
        // re-entered on resume and still needs it, so it is kept in that case.
        if (anchorSnapshotId) {
          this.pendingSequentialSnapshotBeforeStates.delete(anchorSnapshotId);
        }
        try {
          await context.releaseCoordinationGroupClaims?.(groupOutcome.group);
        } catch (error) {
          Log.warn(
            "[WorkflowExecutor] Failed to release parallel-group coordination claims:",
            error
          );
        }
        this.broadcastProgress(context);
        if (
          groupOutcome.stopped &&
          this.getRuntime().status === EXECUTION_STATES.CANCELLING &&
          this.getRuntime().confirmStopped()
        ) {
          await this.promptQueue.commitRuntimeTransition();
        }
        if (groupOutcome.terminalFailure && !groupOutcome.stopped) {
          this.getRuntime().fail();
          await this.promptQueue.commitRuntimeTransition();
        }
      }
      return groupOutcome;
    } finally {
      if (this.activeParallelGroupRun === groupRun) {
        this.activeParallelGroupRun = undefined;
        this.activeParallelGroupPreflightMembers = undefined;
      }
      if (this.promotedParallelGroupRun?.run === groupRun) {
        this.promotedParallelGroupRun = undefined;
      }
    }
  }

  private takePromotedParallelGroupRun(groupId: string) {
    const promoted = this.promotedParallelGroupRun;
    if (!promoted || promoted.groupId !== groupId) {
      return undefined;
    }
    this.promotedParallelGroupRun = undefined;
    return promoted;
  }

  /**
   * Start the coordinator for a group created by an ad-hoc promotion, with the
   * still-executing sequential anchor adopted as a member.
   *
   * Without this the new member would sit pending until the anchor settled and
   * the queue loop re-entered the group, which defeats the point of "run this
   * beside the step that is running now". The sequential settlement hands the
   * anchor's outcome to this run (`commitSequentialOutcome`) and then awaits it.
   *
   * A rejection here leaves the group untouched — `executeEphemeralParallelPrompt`
   * rolls the member back — and never fails the anchor.
   */
  private async startPromotedParallelGroupRun(
    group: ParallelGroupDefinition,
    anchorIndex: number,
    memberIndex: number
  ): Promise<ParallelGroupJoinResult> {
    const active = this.activeExecution;
    const state = this.promptQueue.getState();
    const anchor = state.steps[anchorIndex];
    const anchorId = anchor?._runtime?.stepId;
    const member = state.steps[memberIndex];
    const memberId = member?._runtime?.stepId;
    if (!anchor || !anchorId || !member || !memberId) {
      return {
        accepted: false,
        diagnostic: `Step ${memberIndex + 1} is missing its stable identity.`,
      };
    }
    if (member.enabled === false) {
      return {
        accepted: false,
        diagnostic: `Step ${memberIndex + 1} is disabled and cannot run in parallel.`,
      };
    }
    // Without a live execution context there is nothing to attach a run to.
    // Accept the member anyway: the queue loop still starts the promoted group
    // once the anchor settles, which is strictly better than rejecting it.
    if (!active) {
      return { accepted: true };
    }
    const effectiveWidth = getEffectiveParallelGroupWidth(
      active.context.dynamicQueueConfig.maxParallelSteps,
      active.context.parallelGroupFanOutEnabled
    );
    if (effectiveWidth <= 1) {
      return { accepted: true };
    }

    // The anchor is mid-flight: resolving it again must not mint a second
    // integration for a target that already owns one, so its reservation is
    // resolved without `ensureIsolatedIntegration`. It exists only so the new
    // member's preflight can see the session the anchor is holding.
    let anchorReservation: ParallelGroupPreflightMember;
    try {
      const { ensureIsolatedIntegration: _ignored, ...preflightOptions } =
        this.getParallelGroupPreflightOptions(group, active.context);
      anchorReservation = (
        await preflightParallelGroupMember({
          ...preflightOptions,
          step: anchor,
          stepIndex: anchorIndex,
        })
      ).member;
    } catch (error: unknown) {
      return {
        accepted: false,
        diagnostic: `Parallel-group promotion failed to resolve the running step: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const liveAnchorSessionId = anchor._runtime?.sessionId;
    if (typeof liveAnchorSessionId === "string") {
      anchorReservation = {
        ...anchorReservation,
        resolvedSessionId: liveAnchorSessionId,
      };
    }

    let preflight: ParallelGroupMemberPreflightResult;
    try {
      preflight = await this.preflightGroupMember(
        group,
        member,
        memberIndex,
        active.context,
        [anchorReservation]
      );
    } catch (error: unknown) {
      await this.releaseRejectedParallelGroupMemberResources(
        active.context,
        memberIndex
      );
      return {
        accepted: false,
        diagnostic: `Parallel step ${memberIndex + 1} failed preflight: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (preflight.issues.length > 0) {
      await this.releaseRejectedParallelGroupMemberResources(
        active.context,
        memberIndex
      );
      return { accepted: false, diagnostic: preflight.failureMessage };
    }

    const groupRun = this.createParallelGroupRun({
      group,
      context: active.context,
      snapshotStrategy: active.snapshotStrategy,
      pendingIds: [memberId],
      initialOutcomes: new Map<string, StepExecutionOutcome>(),
      admissionTargets: new Map([[memberId, memberIndex]]),
      effectiveWidth,
      // The anchor's own before-state is the group's before-state: it was
      // captured before any sibling existed (PARALLEL_STEPS_PLAN Decision 8).
      groupBeforeState:
        this.pendingSequentialSnapshotBeforeStates.get(anchorId),
      adoptedMemberIds: [anchorId],
      adoptedReservations: () =>
        this.promptQueue
          .getState()
          .steps.find((candidate) => candidate._runtime?.stepId === anchorId)
          ?._runtime?.completedAt === undefined
          ? [anchorReservation]
          : [],
    });
    this.activeParallelGroupRun = groupRun;
    this.activeParallelGroupPreflightMembers = new Map([
      [anchorIndex, anchorReservation],
      [memberIndex, preflight.member],
    ]);
    const outcome = groupRun.run();
    // The sequential settlement is what awaits this; keep the rejection from
    // surfacing as an unhandled promise in the meantime.
    outcome.catch(() => undefined);
    this.promotedParallelGroupRun = {
      groupId: group.id,
      run: groupRun,
      outcome,
    };
    Log.info(
      `[WorkflowExecutor] Parallel steps ${group.startIndex + 1}–${group.endIndex + 1}: ` +
        `step ${memberIndex + 1} joined the promoted group beside running step ${anchorIndex + 1} ` +
        `(effective width ${effectiveWidth})`
    );
    return { accepted: true };
  }

  public joinRunningParallelGroup(
    stepIndex: number
  ): Promise<ParallelGroupJoinResult> {
    const join = this.parallelGroupJoinQueue.then(() =>
      this.admitParallelGroupMember(stepIndex)
    );
    this.parallelGroupJoinQueue = join.then(
      () => undefined,
      () => undefined
    );
    return join.catch((error: unknown) => ({
      accepted: false,
      diagnostic: `Parallel-group join failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }));
  }

  private async admitParallelGroupMember(
    stepIndex: number
  ): Promise<ParallelGroupJoinResult> {
    const groupRun = this.activeParallelGroupRun;
    if (!groupRun) {
      // An ad-hoc promotion happens while the anchor is still in the
      // sequential execution path, so there is no ParallelGroupRun object to
      // admit into yet. Start one that adopts the in-flight anchor, so the new
      // member runs beside it instead of waiting for it to settle.
      const state = this.promptQueue.getState();
      const activeRuntime = this.promptQueue.getActiveParallelGroupRuntime();
      const promotedGroup = state.parallelGroups.find(
        (candidate) =>
          candidate.id === activeRuntime?.groupId &&
          candidate.startIndex === state.currentIndex &&
          stepIndex === candidate.endIndex
      );
      const anchor = state.steps[state.currentIndex];
      if (
        activeRuntime &&
        promotedGroup?.id === activeRuntime.groupId &&
        activeRuntime.admission === PARALLEL_GROUP_ADMISSION.ACCEPTING &&
        anchor?._runtime?.startedAt !== undefined &&
        anchor._runtime.completedAt === undefined &&
        state.steps[stepIndex]?._runtime?.startedAt === undefined
      ) {
        return this.startPromotedParallelGroupRun(
          promotedGroup,
          state.currentIndex,
          stepIndex
        );
      }
      if (
        activeRuntime &&
        activeRuntime.admission !== PARALLEL_GROUP_ADMISSION.ACCEPTING
      ) {
        return {
          accepted: false,
          diagnostic:
            "The promoted parallel group is no longer accepting members.",
        };
      }
      return {
        accepted: false,
        diagnostic: "No parallel group is currently running.",
      };
    }
    if (!groupRun.isAdmissionOpen) {
      return {
        accepted: false,
        diagnostic:
          "The running parallel group is no longer accepting members.",
      };
    }

    const liveGroup = this.promptQueue
      .getState()
      .parallelGroups.find((candidate) => candidate.id === groupRun.group.id);
    if (!liveGroup) {
      return {
        accepted: false,
        diagnostic: `Parallel group ${groupRun.group.id} is missing from the current definition.`,
      };
    }
    if (stepIndex < liveGroup.startIndex || stepIndex > liveGroup.endIndex) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} is not a member of the running parallel group.`,
      };
    }

    const step = this.promptQueue.getState().steps[stepIndex];
    if (!step) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} does not exist in the current definition.`,
      };
    }
    if (
      step._runtime?.startedAt !== undefined ||
      step._runtime?.completedAt !== undefined
    ) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} has already started and cannot join the running parallel group.`,
      };
    }
    if (step.enabled === false) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} is disabled and cannot join the running parallel group.`,
      };
    }

    const stepId = step._runtime?.stepId;
    if (!stepId) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} is missing its stable identity.`,
      };
    }
    if (
      groupRun.pendingIds.includes(stepId) ||
      groupRun.running.has(stepId) ||
      groupRun.outcomes.has(stepId)
    ) {
      return {
        accepted: false,
        diagnostic: `Step ${stepIndex + 1} is already admitted to the running parallel group.`,
      };
    }

    let preflight: ParallelGroupMemberPreflightResult;
    try {
      const reservedMembers = new Map(
        this.activeParallelGroupPreflightMembers ?? []
      );
      for (const member of groupRun.running.values()) {
        if (member.preflightMember) {
          reservedMembers.set(
            member.preflightMember.stepIndex,
            member.preflightMember
          );
        }
      }
      preflight = await this.preflightGroupMember(
        liveGroup,
        step,
        stepIndex,
        groupRun.groupContext,
        [...reservedMembers.values()].filter(
          (member) =>
            member.stepIndex !== stepIndex &&
            member.stepIndex >= liveGroup.startIndex &&
            member.stepIndex <= liveGroup.endIndex
        )
      );
    } catch (error: unknown) {
      await this.releaseRejectedParallelGroupMemberResources(
        groupRun.groupContext,
        stepIndex
      );
      return {
        accepted: false,
        diagnostic: `Parallel step ${stepIndex + 1} failed preflight: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (preflight.issues.length > 0) {
      await this.releaseRejectedParallelGroupMemberResources(
        groupRun.groupContext,
        stepIndex
      );
      return { accepted: false, diagnostic: preflight.failureMessage };
    }

    if (!groupRun.admit(stepId)) {
      await this.releaseRejectedParallelGroupMemberResources(
        groupRun.groupContext,
        stepIndex
      );
      return {
        accepted: false,
        diagnostic: `The running parallel group stopped accepting members before step ${stepIndex + 1} could join.`,
      };
    }

    return { accepted: true };
  }

  private async releaseRejectedParallelGroupMemberResources(
    context: WorkflowExecutionContext,
    stepIndex: number
  ): Promise<void> {
    try {
      await context.releaseTargetResources?.({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex,
      });
    } catch (error) {
      Log.warn(
        `[WorkflowExecutor] Failed to release rejected parallel-group join resources for step ${stepIndex}:`,
        error
      );
    }
  }

  private async persistGroupSettlement(
    outcome: StepExecutionOutcome,
    context: WorkflowExecutionContext
  ): Promise<void> {
    await this.promptQueue.persistStepOutcome(outcome);
    await this.settleCoordinationParticipant(outcome.target, context);
    this.broadcastProgress(context);
  }

  private async settleCoordinationParticipant(
    target: WorkflowAttemptTarget,
    context: WorkflowExecutionContext
  ): Promise<void> {
    try {
      await context.closeCoordinationParticipant?.(target);
    } catch (error) {
      // Coordination is advisory. A board failure must not turn a settled
      // workflow target into an execution failure.
      Log.warn(
        "[WorkflowExecutor] Failed to close coordination participant lease:",
        error
      );
    }
  }

  /**
   * `PROGRESS_UPDATE.current` is the dashboard's `currentStep` — the boundary
   * between settled and pending work — and never a count of finished steps.
   * A live parallel group deliberately holds `currentIndex` at its anchor
   * until every member settles (`reconcileGroupOutcomes`), so broadcasting the
   * settled *count* from here moved that boundary into the middle of a running
   * group: the steps panel then had no container left to draw the group in and
   * painted the running outline on whichever member the moved boundary landed
   * on — a step showing a completed check. Always publish the queue's own
   * `currentIndex`, exactly like every other `updateProgress` call site.
   */
  private broadcastProgress(context: WorkflowExecutionContext): void {
    const progress = this.promptQueue.getProgress();
    context.dashboardProvider?.updateProgress(progress.current, progress.total);
  }

  private async commitSequentialOutcome(
    outcome: StepExecutionOutcome,
    context: WorkflowExecutionContext
  ): Promise<boolean> {
    const settlement =
      await this.promptQueue.commitStepOutcomeAndAdvance(outcome);
    await this.settleCoordinationParticipant(outcome.target, context);
    this.broadcastProgress(context);

    // A promotion committed while the sequential target was running owns the
    // target's outcome as a group member. Leave currentIndex at the group's
    // anchor so the normal loop starts one shared ParallelGroupRun, and hand
    // the outcome to an already-running coordinator when one exists.
    if (settlement.promotedGroup) {
      const stepId =
        outcome.target.kind === FINAL_STEP_PHASES.QUEUE
          ? this.promptQueue.getState().steps[outcome.target.stepIndex]
              ?._runtime?.stepId
          : undefined;
      // A promotion that started its own run adopted this target. Hand it the
      // outcome and let that run finish here, so the queue loop never forks a
      // second coordinator for a group that is already live.
      const promoted = this.takePromotedParallelGroupRun(
        settlement.promotedGroup.id
      );
      if (promoted && stepId) {
        await promoted.run.settleAdoptedMember(stepId, outcome);
        const groupOutcome = await this.finishParallelGroupRun(
          promoted.run,
          promoted.outcome,
          settlement.promotedGroup,
          context
        );
        return !(
          groupOutcome.paused ||
          groupOutcome.stopped ||
          groupOutcome.terminalFailure
        );
      }
      if (promoted) {
        this.promotedParallelGroupRun = promoted;
      }
      if (stepId) {
        this.activeParallelGroupRun?.reconcileMembers([stepId]);
      }
      if (
        await this.confirmPauseAndStop("[WorkflowExecutor] Workflow paused")
      ) {
        return false;
      }
      return true;
    }

    if (outcome.status === PROMPT_TERMINAL_STATUS.FAILED) {
      if (outcome.terminalFailure !== false) {
        this.getRuntime().fail();
        await this.promptQueue.commitRuntimeTransition();
        const targetKey = getExecutionTargetRunKey(outcome.target);
        const executionError = this.targetExecutionErrors.get(targetKey);
        this.targetExecutionErrors.delete(targetKey);
        if (executionError !== undefined) {
          throw new RecordedTargetFailureError(outcome.target, executionError);
        }
        return false;
      }
      return true;
    }
    if (outcome.status === PROMPT_TERMINAL_STATUS.CANCELLED) {
      if (this.getRuntime().status === EXECUTION_STATES.CANCELLING) {
        this.getRuntime().confirmStopped();
        await this.promptQueue.commitRuntimeTransition();
      }
      return false;
    }
    if (await this.confirmPauseAndStop("[WorkflowExecutor] Workflow paused")) {
      return false;
    }
    return true;
  }

  private async executeTarget(
    target: ExecutionTarget,
    step: WorkflowStep,
    context: WorkflowExecutionContext,
    preflightMember?: ParallelGroupPreflightMember
  ): Promise<StepExecutionOutcome> {
    let shouldContinue: boolean;
    try {
      shouldContinue = await this.executeTargetContract(
        target,
        step,
        context,
        preflightMember
      );
    } catch (error) {
      const failureReason =
        error instanceof Error ? error.message : String(error);
      if (
        context.abortSignal?.aborted ||
        this.getRuntime().status === EXECUTION_STATES.CANCELLING ||
        this.getRuntime().status === EXECUTION_STATES.STOPPED
      ) {
        const attempt = this.getRuntime().getAttempt(target);
        if (attempt) {
          this.getRuntime().cancelAttempt(
            target,
            attempt.attemptIndex,
            failureReason
          );
        }
        return {
          target,
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          failureReason,
        };
      }
      this.targetExecutionErrors.set(getExecutionTargetRunKey(target), error);
      const attempt = this.getRuntime().getAttempt(target);
      if (attempt) {
        this.getRuntime().failAttempt(
          target,
          attempt.attemptIndex,
          failureReason
        );
      }
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.failStep(target.stepIndex, failureReason);
        context.dashboardProvider?.updateStepStatus(target.stepIndex, {
          state: STEP_STATUS.FAILED,
          message: failureReason,
        });
      } else {
        await this.setFinalStepRuntime(context, {
          phase: FINAL_STEP_PHASES.FINAL_STEP,
          loopCount: target.loopIndex,
          status: STEP_STATUS.FAILED,
          startedAt:
            this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
          completedAt: Date.now(),
        });
      }
      return {
        target,
        status: PROMPT_TERMINAL_STATUS.FAILED,
        failureReason,
      };
    }
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      const result = this.promptQueue.getState().results[target.stepIndex];
      if (result?.status === STEP_STATUS.SKIPPED) {
        return { target, status: PROMPT_TERMINAL_STATUS.SKIPPED };
      }
      if (result?.status === STEP_STATUS.CANCELLED) {
        return { target, status: PROMPT_TERMINAL_STATUS.CANCELLED };
      }
      if (result?.status === STEP_STATUS.FAILED) {
        return {
          target,
          status: PROMPT_TERMINAL_STATUS.FAILED,
          ...(result.error ? { failureReason: result.error } : {}),
          ...(shouldContinue ? { terminalFailure: false } : {}),
        };
      }
    } else {
      const finalStatus = this.promptQueue.getFinalStepRuntime()?.status;
      if (finalStatus === STEP_STATUS.SKIPPED) {
        return { target, status: PROMPT_TERMINAL_STATUS.SKIPPED };
      }
      if (finalStatus === STEP_STATUS.FAILED) {
        return { target, status: PROMPT_TERMINAL_STATUS.FAILED };
      }
    }

    if (shouldContinue) {
      return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
    }
    const runtime = this.getRuntime();
    return {
      target,
      status:
        context.abortSignal?.aborted ||
        runtime.status === EXECUTION_STATES.CANCELLING ||
        runtime.status === EXECUTION_STATES.STOPPED
          ? PROMPT_TERMINAL_STATUS.CANCELLED
          : PROMPT_TERMINAL_STATUS.FAILED,
    };
  }

  private async executeTargetContract(
    target: ExecutionTarget,
    step: WorkflowStep,
    context: WorkflowExecutionContext,
    preflightMember?: ParallelGroupPreflightMember
  ): Promise<boolean> {
    const state = this.promptQueue.getState();
    const runtime = this.getRuntime();
    const currentStatus = runtime.status;

    if (
      context.abortSignal?.aborted ||
      currentStatus === EXECUTION_STATES.STOPPED ||
      currentStatus === EXECUTION_STATES.CANCELLING
    ) {
      Log.info(
        "[WorkflowExecutor] Workflow stopped before executing next prompt"
      );
      return false;
    }

    const progress = this.promptQueue.getProgress();

    if (!isStepEnabled(step)) {
      return this.handleSkippedStep(
        step,
        target,
        context,
        "Skipped because enabled=false",
        "[Disabled]"
      );
    }

    // Route script steps directly — no AI harness interaction needed
    if (isScriptStep(step)) {
      const stepIndex =
        target.kind === FINAL_STEP_PHASES.QUEUE ? target.stepIndex : -1;
      return this.executeScriptStep(step, stepIndex, context, target);
    }

    let prompt: PromptStep = step as PromptStep;

    // The attempt loop intentionally encloses the entire step contract:
    // pre-condition -> prompt -> end-condition. A whole-step retry therefore
    // re-runs the gate before spending another harness call.
    let attemptIndex = 0;
    let preConditionErrorRetryCount = 0;
    const promptErrorRetryCounter = { count: 0 };
    let endConditionErrorRetryCount = 0;
    while (true) {
      if (context.abortSignal?.aborted) {
        return false;
      }
      runtime.beginAttempt(target, attemptIndex, Date.now());
      context.registerActiveTarget?.(target, attemptIndex);

      // Evaluate pre-condition gate before running the AI prompt.
      const workflowFileForPre = this.promptQueue.getWorkflowFile();
      let preResolvedProperties =
        preflightMember?.resolvedProperties ??
        PropertyResolver.resolve(prompt, workflowFileForPre, {
          hostCanProvidePty: context.hostCanProvidePty,
        });
      const preVars = preflightMember
        ? { ...preflightMember.variables }
        : workflowFileForPre.vars;
      if (!preflightMember && preVars && Object.keys(preVars).length > 0) {
        preResolvedProperties = VarSubstitutor.applyToResolvedProperties(
          preResolvedProperties,
          preVars
        );
      }
      const resolvedPreCondition = preResolvedProperties.preCondition;
      this.reportUnresolvedVariables(
        [
          {
            field: "preCondition.script",
            value: resolvedPreCondition?.script,
          },
          ...this.getEnvironmentFields(
            "preCondition.env",
            resolvedPreCondition?.env
          ),
        ],
        preVars ?? {},
        preResolvedProperties.harness,
        context,
        target,
        prompt
      );
      const preErrorBehavior = preResolvedProperties.errorBehavior;
      const preSecretNames = getEffectiveSecretGrants(
        prompt,
        preResolvedProperties.secrets,
        getProcessMapSecretNames(preResolvedProperties)
      );
      await this.registerResolvedSecrets(preSecretNames, context, target);
      await this.promptQueue.persistRuntimeMetadata(
        target.kind === FINAL_STEP_PHASES.QUEUE
          ? target.stepIndex
          : this.promptQueue.getState().steps.length,
        { secrets: preSecretNames }
      );

      if (
        resolvedPreCondition !== null &&
        resolvedPreCondition !== undefined &&
        resolvedPreCondition.script?.trim()
      ) {
        await this.trackStatusMessage(
          context,
          target,
          `Evaluating pre-condition: Running ${this.getConditionScriptName(
            resolvedPreCondition.script
          )}`
        );

        const preReport = await this.scriptExecutionReporter.report({
          context,
          source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
          properties: toReportedConditionProperties(resolvedPreCondition),
          phase: EXECUTION_PHASES.PRE_CONDITION,
          target: this.toOutputExecutionTarget(target),
          signedStepIndex: this.getSignedStepIndex(target),
          runIndex: this.getRunIndexForTarget(context, target),
          attemptIndex,
          startReason: getAttemptStartReason(attemptIndex),
          timestampMs: Date.now(),
          onPass: resolvedPreCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
          onFail: resolvedPreCondition.onFail ?? CONDITION_ACTIONS.SKIP_PROMPT,
          statusLabel:
            SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.PRE_CONDITION],
          timeoutMs:
            ConfigurationUtils.secondsToMs(resolvedPreCondition.timeoutSec) ??
            ConfigurationUtils.getScriptTimeoutMs(),
          vars: workflowFileForPre.vars,
          secretNames: preSecretNames,
          emitStatus: false,
          actionForErrored: this.getErrorConditionAction(preErrorBehavior),
        });
        const preResult = preReport.evaluationResult;
        this.recordPreConditionSummary(
          target,
          createConditionEvaluationSummary(
            resolvedPreCondition.script,
            preResult,
            {
              action: preReport.verdict.action,
              expected: preReport.verdict.expected,
              compareSource: preReport.verdict.compareSource,
              operator: preReport.verdict.operator,
            }
          )
        );

        if (preResult.errored) {
          const preDisposition = await this.handleEvaluationError(
            context,
            target,
            this.getSignedStepIndex(target),
            SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.PRE_CONDITION],
            preResult,
            preErrorBehavior,
            attemptIndex,
            preConditionErrorRetryCount
          );
          if (preDisposition.outcome === CONDITION_ACTIONS.RETRY) {
            attemptIndex = preDisposition.nextAttemptIndex ?? attemptIndex + 1;
            preConditionErrorRetryCount =
              preDisposition.nextErrorRetryCount ??
              preConditionErrorRetryCount + 1;
            continue;
          }
          if (preDisposition.outcome === WORKFLOW_EXECUTION_OUTCOMES.STOP) {
            return false;
          }
        } else {
          const preAction: PreConditionAction = preResult.passed
            ? (resolvedPreCondition.onPass ?? CONDITION_ACTIONS.CONTINUE)
            : (resolvedPreCondition.onFail ?? CONDITION_ACTIONS.SKIP_PROMPT);

          Log.info(
            `[WorkflowExecutor] Pre-condition ${
              preResult.passed
                ? SCRIPT_VERDICT_OUTCOMES.PASSED
                : SCRIPT_VERDICT_OUTCOMES.FAILED
            } action: ${preAction}`
          );

          await this.trackConditionResult(
            context,
            target,
            SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.PRE_CONDITION],
            preReport.verdict,
            STATUS_MESSAGE_SEVERITY.WARNING
          );

          if (preAction === CONDITION_ACTIONS.SKIP_PROMPT) {
            runtime.completeAttempt(target, attemptIndex);
            return this.handleSkippedStep(step, target, context);
          }
          if (preAction === CONDITION_ACTIONS.STOP_WORKFLOW) {
            Log.info("[WorkflowExecutor] Pre-condition stopWorkflow triggered");
            await this.failStepForInternalError(
              context,
              target,
              this.getSignedStepIndex(target),
              attemptIndex,
              "Pre-condition requested stopWorkflow"
            );
            return false;
          }
          // CONTINUE — fall through and run the step.
        }
      }

      const workflowFile = this.promptQueue.getWorkflowFile();
      let resolvedProperties =
        preflightMember?.resolvedProperties ??
        PropertyResolver.resolve(prompt, workflowFile, {
          hostCanProvidePty: context.hostCanProvidePty,
        });

      // Apply {{var}} substitution when the workflow has vars defined.
      const vars = preflightMember
        ? { ...preflightMember.variables }
        : workflowFile.vars;
      if (!preflightMember && vars && Object.keys(vars).length > 0) {
        resolvedProperties = VarSubstitutor.applyToResolvedProperties(
          resolvedProperties,
          vars
        );
      }

      // Substitute first, then resolve a standalone prompt-file reference into
      // a local copy. The queue and working file retain the authored path so
      // edits to the target file are visible on the next run.
      const effectivePromptText =
        preflightMember?.effectivePromptText ??
        (await this.resolveEffectivePrompt(prompt.prompt, context, vars));
      if (!effectivePromptText.trim()) {
        throw new Error("Prompt is empty after resolving its prompt file");
      }
      this.reportUnresolvedVariables(
        this.getResolvedPropertyVariableFields(resolvedProperties, {
          includePreCondition: false,
        }).concat({ field: "prompt text", value: effectivePromptText }),
        vars ?? {},
        resolvedProperties.harness,
        context,
        target,
        prompt
      );
      this.reportIgnoredSecretInterpolations(
        effectivePromptText,
        resolvedProperties,
        context
      );

      const mcpNormalization =
        await McpServerNormalizer.applyFromRegistryWithDiagnostics(
          resolvedProperties,
          context.workspaceFolderPath ??
            context.executionWorkspace.executionRoot,
          effectivePromptText
        );
      resolvedProperties = mcpNormalization.properties;
      const secretNames = getEffectiveSecretGrants(
        prompt,
        resolvedProperties.secrets,
        getProcessMapSecretNames(resolvedProperties)
      );
      const resolvedSecretValues = await this.resolveGrantedSecretValues(
        secretNames,
        context,
        target,
        mcpNormalization.trustedUserScopeSecretNames
      );
      context.secretRedactor?.addResolvedValues(resolvedSecretValues);
      resolvedProperties = {
        ...resolvedProperties,
        secrets: secretNames,
        hooks:
          resolvedProperties.hooks === null
            ? null
            : resolvedProperties.hooks?.map((hook) => ({
                ...hook,
                env: expandSecretInterpolations(
                  hook.env,
                  resolvedSecretValues,
                  secretNames
                ),
              })),
      };
      context.reportCompatibilityDiagnostics?.(mcpNormalization.diagnostics);
      this.assertContextResolutionDiagnosticsAllowed(
        mcpNormalization.diagnostics
      );

      const integration = context.getIntegrationForPrompt(
        prompt,
        resolvedProperties,
        target
      );

      const runtimeStepIndex =
        target.kind === FINAL_STEP_PHASES.QUEUE
          ? target.stepIndex
          : state.steps.length;
      await this.promptQueue.persistRuntimeMetadata(runtimeStepIndex, {
        harness: resolvedProperties.harness,
        model: resolvedProperties.model,
        executionMode: resolvedProperties.executionMode,
        agent: resolvedProperties.agent,
        skills: resolvedProperties.skills,
        secrets: resolvedProperties.secrets,
      });

      // Preserve the queue-owned _runtime object added above. Harness runtime
      // bookkeeping mutates that object to publish the resolved session ID;
      // only the prompt text itself is a just-in-time local copy.
      prompt = { ...prompt, prompt: effectivePromptText };

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.updateDashboardForPromptStart(
          context,
          prompt,
          target.stepIndex,
          resolvedProperties
        );
        integration.setWorkflowProgress(target.stepIndex + 1, progress.total);
        Log.info(
          `[WorkflowExecutor] Executing prompt ${target.stepIndex + 1}/${progress.total}`
        );
      } else {
        Log.info(
          `[WorkflowExecutor] Executing finalStep loop ${target.loopIndex + 1}`
        );
      }

      const signedStepIndex = this.getSignedStepIndex(target);
      const runIndex = this.getRunIndexForTarget(context, target);
      const sendPromptIndex =
        target.kind === FINAL_STEP_PHASES.QUEUE
          ? target.stepIndex
          : state.steps.length;

      let result: { responseText: string; duration: number } | null = null;
      const attemptProperties =
        attemptIndex === 0
          ? resolvedProperties
          : {
              ...resolvedProperties,
              // Whole-step retries deliberately start a fresh harness session.
              resumeSession: false,
              sessionId: undefined,
            };

      result = await this.executeWithStreaming(
        prompt,
        integration,
        context,
        target,
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
        runIndex,
        attemptIndex,
        {
          promptIndex: sendPromptIndex,
          terminalStepIndex: signedStepIndex,
          allPrompts: state.steps,
          filePath: context.currentPromptFilePath,
          workflowName: this.promptQueue.getState().workflowName,
          instanceId: context.instanceId,
          workingFilePath: context.workingFilePath,
          mcpToolSkillContext: this.getMcpToolSkillContext(
            context,
            sendPromptIndex,
            workflowFile
          ),
          resolvedProperties: attemptProperties,
          workflowFile,
          hostCanProvidePty: context.hostCanProvidePty,
          workingFilePersistence: this.promptQueue,
          preConditionResult: this.promptQueue.getPreConditionSummary(target),
          // End-condition output is only available to retry prompts. Leaving
          // this unset keeps first-attempt prompt text deterministic.
          reportCompatibilityDiagnostics:
            context.reportCompatibilityDiagnostics,
          analyzeCompatibilityForPrompt: context.analyzeCompatibilityForPrompt,
          resolvePriorContextItems: context.resolvePriorContextItems,
          releaseConflictingAiSession: context.releaseConflictingAiSession,
          ...(preflightMember
            ? {
                groupStartBoundary:
                  preflightMember.stepIndex >= 0
                    ? this.getParallelGroupStartBoundary(
                        preflightMember.stepIndex
                      )
                    : undefined,
                preflightSession: {
                  sessionId: preflightMember.resolvedSessionId,
                },
              }
            : {}),
          secretEnvironment: resolvedSecretValues,
          finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
            string | undefined,
        },
        async () => {
          if (target.kind === FINAL_STEP_PHASES.QUEUE) {
            await this.promptQueue.markStepAsSent(target.stepIndex);
          }
        },
        "initial",
        false
      );

      if (!result) {
        const failureDisposition = await this.handlePromptSendFailure(
          integration,
          context,
          target,
          prompt,
          signedStepIndex,
          runIndex,
          attemptIndex,
          promptErrorRetryCounter.count,
          resolvedProperties
        );

        if (failureDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex++;
          promptErrorRetryCounter.count =
            failureDisposition.nextErrorRetryCount ??
            promptErrorRetryCounter.count + 1;
          continue;
        }

        return (
          failureDisposition.outcome === WORKFLOW_EXECUTION_OUTCOMES.CONTINUE
        );
      }

      const { responseText, duration } = result;

      await this.updateDashboardWithResponse(
        context,
        integration,
        target,
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
        prompt,
        responseText,
        duration,
        runIndex,
        attemptIndex,
        resolvedProperties.harness
      );
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.persistRuntimeMetadata(target.stepIndex, {
          elapsed: duration,
        });
      }
      // The completed response is durable in events.jsonl before it becomes
      // visible to any active-only cache or subsequent prompt construction.
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.promptQueue.cacheRuntimeOutput(target.stepIndex, { responseText });
      } else {
        this.promptQueue.storeFinalStepResponseText(
          target.loopIndex,
          responseText
        );
      }

      // Use the resolved end condition (handles workflow-level inheritance via PropertyResolver)
      // rather than reading prompt.endCondition directly, which misses workflow-level defaults.
      const resolvedEndCondition = resolvedProperties.endCondition;
      const promptForEval =
        resolvedEndCondition && resolvedEndCondition !== prompt.endCondition
          ? { ...prompt, endCondition: resolvedEndCondition }
          : prompt;

      if (resolvedEndCondition) {
        const endDisposition = await this.evaluateEndCondition(
          promptForEval,
          integration,
          context,
          target,
          target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
          runIndex,
          attemptIndex,
          duration,
          promptErrorRetryCounter,
          endConditionErrorRetryCount,
          vars && Object.keys(vars).length > 0 ? vars : undefined,
          resolvedProperties.errorBehavior,
          resolvedProperties.secrets
        );

        if (endDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex = endDisposition.nextAttemptIndex ?? attemptIndex + 1;
          endConditionErrorRetryCount =
            endDisposition.nextErrorRetryCount ??
            endConditionErrorRetryCount + 1;
          continue;
        }

        if (endDisposition.outcome === WORKFLOW_EXECUTION_OUTCOMES.STOP) {
          Log.info(
            "[WorkflowExecutor] Workflow stopped due to end condition failure"
          );
          if (target.kind === FINAL_STEP_PHASES.QUEUE) {
            await this.promptQueue.failStep(
              target.stepIndex,
              "End condition requested stopWorkflow"
            );
          }
          return false;
        }

        if (
          target.kind === FINAL_STEP_PHASES.QUEUE &&
          context.dashboardProvider
        ) {
          context.dashboardProvider.updateStepStatus(
            signedStepIndex,
            { state: STEP_STATUS.COMPLETED, duration },
            {
              harness: prompt._runtime?.harness,
              model: prompt._runtime?.model,
            }
          );
        }
      } else {
        runtime.completeAttempt(target, attemptIndex);
        if (
          target.kind === FINAL_STEP_PHASES.QUEUE &&
          context.dashboardProvider
        ) {
          context.dashboardProvider.updateStepStatus(
            signedStepIndex,
            { state: STEP_STATUS.COMPLETED, duration },
            {
              harness: prompt._runtime?.harness,
              model: prompt._runtime?.model,
            }
          );
        }
      }

      return true;
    }
  }

  /**
   * Handle a step that has been skipped by a pre-condition gate.
   *
   * For mid-queue steps: broadcasts SKIPPED status and advances the queue.
   * For finalStep: marks the loop as skipped and exits cleanly (treated as "resolved").
   *
   * @returns true to continue to the next step, false to stop (finalStep skip exits loop)
   */
  private async handleSkippedStep(
    step: WorkflowStep,
    target: ExecutionTarget,
    context: WorkflowExecutionContext,
    reason: string = "Skipped by pre-condition",
    logPrefix: string = "[Pre-condition]"
  ): Promise<boolean> {
    const stepLabel =
      !isScriptStep(step) && (step as PromptStep).name
        ? (step as PromptStep).name!
        : step.type === STEP_TYPES.SCRIPT
          ? (step as ScriptStep).script.split(/\s+/)[0]
          : "prompt";

    Log.info(`${logPrefix} Step skipped — ${stepLabel}`);
    await this.trackStatusMessage(
      context,
      target,
      `${reason}: ${stepLabel}`,
      STATUS_MESSAGE_SEVERITY.INFO
    );

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      const stepIndex = target.stepIndex;
      if (context.dashboardProvider && stepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(stepIndex, {
          state: STEP_STATUS.SKIPPED,
          message: reason,
        });
      }
      await this.promptQueue.skipStep(stepIndex);
      return true;
    }

    // finalStep — skip = loop exits cleanly (the condition we were fixing is resolved)
    await this.setFinalStepRuntime(context, {
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: target.loopIndex,
      status: STEP_STATUS.SKIPPED,
      startedAt:
        this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
      completedAt: Date.now(),
    });

    return false;
  }

  /**
   * Execute a script step — runs a shell command with no AI harness interaction.
   *
   * In headless mode the script runs in a child process with stdout streamed live
   * to the CliOutput panel via updateCliStreamingChunk.
   *
   * In interactive mode the script runs inside a PTY session so it can prompt for
   * user input. Output is simultaneously streamed to the CliOutput panel (ANSI
   * stripped) and sent as TERMINAL_OUTPUT to the embedded xterm terminal.
   *
   * @param step      The ScriptStep to execute
   * @param stepIndex The queue step index (use -1 for finalStep)
   * @param context   Workflow execution context
   * @param target    Execution target for status machine tracking
   * @returns true to continue the workflow, false to stop
   */
  private async executeScriptStep(
    step: ScriptStep,
    stepIndex: number,
    context: WorkflowExecutionContext,
    target: ExecutionTarget
  ): Promise<boolean> {
    const runtime = this.getRuntime();
    const scriptVars = this.promptQueue.getWorkflowFile().vars;
    const effectiveStep =
      scriptVars && Object.keys(scriptVars).length > 0
        ? VarSubstitutor.applyToScriptStep(step, scriptVars)
        : step;
    const stepLabel = step.name ?? effectiveStep.script.split(/\s+/)[0];
    const resolvedScriptHarness = PropertyResolver.resolveHarnessValue(
      undefined,
      this.promptQueue.getWorkflowFile().harness
    );
    this.reportUnresolvedVariables(
      [
        { field: "script-step.script", value: effectiveStep.script },
        ...this.getEnvironmentFields("script-step.env", effectiveStep.env),
      ],
      scriptVars ?? {},
      resolvedScriptHarness,
      context,
      target,
      step
    );
    const runIndex = this.getRunIndexForTarget(context, target);
    const secretNames = getDeclaredSecretGrants(
      step,
      this.promptQueue.getWorkflowFile()
    );
    await this.registerResolvedSecrets(secretNames, context, target);
    Log.info(`[WorkflowExecutor] Executing script step: ${stepLabel}`);

    // Mark step as running in the dashboard
    if (context.dashboardProvider && stepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(stepIndex, {
        state: STEP_STATUS.RUNNING,
      });
    }

    // Persist resolved script metadata after the dispatch claim.
    await this.promptQueue.persistRuntimeMetadata(
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? stepIndex
        : this.promptQueue.getState().steps.length,
      { secrets: secretNames }
    );

    // Begin each whole-step attempt before the script executes. An evaluator
    // retry therefore re-runs the complete script step with the same budget.
    let attemptIndex = 0;
    let errorRetryCount = 0;
    while (true) {
      if (context.abortSignal?.aborted) {
        return false;
      }
      runtime.beginAttempt(target, attemptIndex, Date.now());

      const timeout =
        ConfigurationUtils.secondsToMs(step.timeoutSec) ??
        ConfigurationUtils.getScriptTimeoutMs();

      const signedStepIndex = this.getSignedStepIndex(target);
      const timestampMs = Date.now();

      // ─── Interactive mode: run inside a PTY so the user can provide input ────
      const resolvedExecutionMode = PropertyResolver.resolveExecutionMode(
        step,
        this.promptQueue.getWorkflowFile(),
        { hostCanProvidePty: context.hostCanProvidePty }
      );
      await this.promptQueue.persistRuntimeMetadata(
        target.kind === FINAL_STEP_PHASES.QUEUE
          ? stepIndex
          : this.promptQueue.getState().steps.length,
        { executionMode: resolvedExecutionMode }
      );
      const requestedInteractive =
        resolvedExecutionMode === EXECUTION_MODES.INTERACTIVE;
      const stderrComparison = step.compareSource === COMPARE_SOURCES.STDERR;
      const isInteractive = requestedInteractive && !stderrComparison;
      if (requestedInteractive && stderrComparison) {
        Log.warn(
          `[script:interactive] compareSource=stderr requires separate stderr; ` +
            `running headless: ${stepLabel}`
        );
      }
      const resolvedProperties = resolveReportedScriptProperties({
        script: effectiveStep.script,
        env: effectiveStep.env,
        compareSource: step.compareSource,
        operator: step.operator,
        expected: step.expected,
        ignoreCase: step.ignoreCase,
        timeoutSec: step.timeoutSec,
        shell: effectiveStep.shell,
      });
      const outputChunks: string[] = [];
      let ptyExitCode: number | undefined;
      let ptyTimedOut = false;

      const evaluation = async (onOutput: (chunk: string) => void) => {
        if (isInteractive && context.spawnScriptPty) {
          Log.info(`[script:interactive] spawning PTY for: ${stepLabel}`);
          ptyExitCode = await context.spawnScriptPty({
            stepName: stepLabel,
            stepIndex: signedStepIndex,
            parallelGroupId:
              stepIndex >= 0
                ? this.promptQueue
                    .getState()
                    .parallelGroups.find(
                      (group) =>
                        stepIndex >= group.startIndex &&
                        stepIndex <= group.endIndex
                    )?.id
                : undefined,
            targetKey: getExecutionTargetRunKey(target),
            script: effectiveStep.script,
            shell: effectiveStep.shell,
            cwd: context.executionWorkspace.executionRoot,
            env: await this.resolveScriptEnvironment(
              effectiveStep.env,
              secretNames,
              context
            ),
            onOutput: (chunk) => {
              outputChunks.push(chunk);
              onOutput(chunk);
            },
            timeout,
            onTimeout: () => {
              ptyTimedOut = true;
            },
            onSessionCreated: (sessionId) =>
              context.registerTargetPtySession?.(target, sessionId),
            onSessionEnded: () => context.clearTargetPtySession?.(target),
          });
        }

        if (!isInteractive || ptyExitCode === undefined) {
          return this.endConditionEvaluator.evaluateCondition(
            resolvedProperties,
            context.executionWorkspace.executionRoot,
            this.promptQueue.getWorkflowFile().vars,
            onOutput,
            secretNames,
            context.getScriptProcessRunner?.(target),
            context.workingFilePath
          );
        }

        const exitCode = ptyExitCode ?? 1;
        const comparison = await this.endConditionEvaluator.evaluateResult(
          {
            result: outputChunks.join(""),
            stdout: outputChunks.join(""),
            stderr: "",
            success: exitCode === 0,
            exitCode,
          },
          resolvedProperties
        );
        return {
          ...comparison,
          errored: ptyTimedOut,
          stdout: comparison.stdout,
          stderr: comparison.stderr,
          result: comparison.result,
          duration: Date.now() - timestampMs,
          exitCode,
          timeout: ptyTimedOut,
        };
      };

      const report = await this.scriptExecutionReporter.report({
        context,
        source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
        properties: resolvedProperties,
        phase: EXECUTION_PHASES.PROMPT,
        target,
        signedStepIndex,
        runIndex,
        attemptIndex,
        startReason: getAttemptStartReason(attemptIndex),
        timestampMs,
        onPass: step.onPass ?? CONDITION_ACTIONS.CONTINUE,
        onFail: step.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
        statusLabel: SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP],
        timeoutMs: timeout,
        vars: this.promptQueue.getWorkflowFile().vars,
        secretNames,
        evaluate: evaluation,
        emitStatus: false,
        actionForErrored: this.getErrorConditionAction(
          step.errorBehavior === null
            ? undefined
            : (step.errorBehavior ??
                this.promptQueue.getWorkflowFile().errorBehavior ??
                undefined)
        ),
      });

      const evalResult = report.evaluationResult;
      const scriptRuntimeOutput = report.scriptRuntimeOutput;
      const outputText = report.outputText;

      if (evalResult.cancelled) {
        runtime.cancelAttempt(target, attemptIndex);
        await this.recordAttemptTerminal(
          context,
          target,
          attemptIndex,
          TIMELINE_ATTEMPT_TERMINAL_STATES.CANCELLED
        );
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          await this.promptQueue.cancelStep(target.stepIndex);
        }
        return false;
      }

      const errorBehavior =
        step.errorBehavior === null
          ? undefined
          : (step.errorBehavior ??
            this.promptQueue.getWorkflowFile().errorBehavior);

      if (evalResult.errored) {
        const errorDisposition = await this.handleEvaluationError(
          context,
          target,
          signedStepIndex,
          SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP],
          evalResult,
          errorBehavior,
          attemptIndex,
          errorRetryCount,
          false
        );
        if (errorDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex = errorDisposition.nextAttemptIndex ?? attemptIndex + 1;
          errorRetryCount =
            errorDisposition.nextErrorRetryCount ?? errorRetryCount + 1;
          continue;
        }
        if (errorDisposition.outcome === WORKFLOW_EXECUTION_OUTCOMES.STOP) {
          return false;
        }
      } else {
        await this.trackConditionResult(
          context,
          target,
          SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP],
          report.verdict,
          STATUS_MESSAGE_SEVERITY.ERROR
        );
      }

      const succeeded = evalResult.errored ? true : evalResult.passed;

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.promptQueue.cacheRuntimeOutput(target.stepIndex, {
          responseText: outputText,
          scriptOutput: scriptRuntimeOutput,
        });
      } else {
        this.promptQueue.storeFinalStepResponseText(
          target.loopIndex,
          outputText
        );
      }

      const onPass = step.onPass ?? CONDITION_ACTIONS.CONTINUE;
      const onFail = step.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW;
      const shouldContinue = evalResult.errored
        ? true
        : succeeded
          ? onPass !== CONDITION_ACTIONS.STOP_WORKFLOW
          : onFail !== CONDITION_ACTIONS.STOP_WORKFLOW;
      const terminalStatus = shouldContinue
        ? STEP_STATUS.COMPLETED
        : STEP_STATUS.FAILED;
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.persistRuntimeMetadata(target.stepIndex, {
          elapsed: evalResult.duration / 1000,
        });
      }

      if (!succeeded && onFail === CONDITION_ACTIONS.STOP_WORKFLOW) {
        Log.error(
          `[WorkflowExecutor] Script step failed (exit code ${evalResult.exitCode}): ${stepLabel}`
        );
      } else if (succeeded && onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
        Log.info(
          `[WorkflowExecutor] Script step passed but onPass=stopWorkflow, stopping: ${stepLabel}`
        );
      } else if (!succeeded) {
        Log.warn(
          `[WorkflowExecutor] Script step failed but onFail=continue, continuing: ${stepLabel}`
        );
      }

      // Complete or fail the attempt in the state machine
      if (shouldContinue) {
        runtime.completeAttempt(target, attemptIndex);
      } else {
        runtime.failAttempt(
          target,
          attemptIndex,
          `Script exited with code ${evalResult.exitCode}`
        );
      }
      await this.recordAttemptTerminal(
        context,
        target,
        attemptIndex,
        shouldContinue
          ? TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED
          : TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED,
        shouldContinue
          ? undefined
          : `Script exited with code ${evalResult.exitCode}`
      );

      // Update dashboard step status
      if (context.dashboardProvider && stepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(stepIndex, {
          state: terminalStatus,
          duration: evalResult.duration / 1000,
        });
      }

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        if (shouldContinue) {
          // The coordinator commits the target outcome and advances at join.
        } else {
          await this.promptQueue.failStep(
            target.stepIndex,
            `Script exited with code ${evalResult.exitCode}`
          );
        }
      }

      return shouldContinue;
    }
  }

  /**
   * The timestamp every CLI output record for this attempt's *prompt* is
   * stamped with. Falls back to the whole-step attempt start only before the
   * prompt phase has begun — an attempt starts at its pre-condition gate, so
   * using `startedAt` here back-dates the prompt output ahead of the
   * pre-condition output it must follow.
   */
  private getPromptPhaseStartedAt(target: ExecutionTarget): number | undefined {
    const attempt = this.promptQueue
      .getRuntimeStateMachine()
      .getAttempt(target);
    return attempt?.promptStartedAt ?? attempt?.startedAt;
  }

  private async captureAndEmitSnapshot(
    target: ExecutionTarget,
    beforeState: RawWorkspaceState,
    strategy: "git" | "filesystem",
    context: WorkflowExecutionContext,
    parallelGroupId?: string
  ): Promise<void> {
    if (!context.snapshotService) {
      return;
    }

    const executionRoot = context.executionWorkspace.executionRoot;
    const namedRoots = context.executionWorkspace.namedWorkspaceRoots;

    const afterState = await context.snapshotService.captureWorkspaceState(
      executionRoot,
      strategy,
      namedRoots
    );

    const changedFiles = await context.snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      executionRoot
    );

    let snapshot: WorkspaceSnapshot = {
      capturedAt: afterState.capturedAt,
      strategy,
      git: afterState.git,
      repos: context.snapshotService.snapshotRepoInfos(afterState),
      changedFiles,
      ...(parallelGroupId ? { parallelGroupId } : {}),
    };

    snapshot = await context.snapshotService.enrichSnapshotBeforeContent(
      snapshot,
      executionRoot
    );

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager.saveSnapshotForTarget(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        snapshot
      );
    }

    // Publish after persistence so a client that immediately requests file
    // content can resolve it through OutputHistoryManager's enriched reader.
    context.onSnapshotCaptured?.(target, snapshot);
  }

  private toOutputExecutionTarget(
    target: ExecutionTarget
  ): OutputExecutionTarget {
    return toWorkflowOutputExecutionTarget(target);
  }

  private async recordAttemptTerminal(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    attemptIndex: number,
    terminalState: TimelineAttemptTerminalState,
    reason?: string,
    harnessId?: HarnessId
  ): Promise<void> {
    if (!context.historyFilePath || !context.outputHistoryManager) {
      return;
    }

    await context.outputHistoryManager.recordAttemptTerminal(
      context.historyFilePath,
      this.toOutputExecutionTarget(target),
      this.getRunIndexForTarget(context, target),
      attemptIndex,
      terminalState,
      context.getDefinitionRevisionContext?.(),
      reason,
      harnessId
    );
  }

  /**
   * Maps an ExecutionTarget to the signed integer index used by the dashboard
   * and CLI. Queue steps use their zero-based stepIndex; finalStep loops use
   * negative values (-(loopIndex+1)) so they never collide with queue indices
   * and callers can detect them with `< 0`.
   */
  private getSignedStepIndex(target: ExecutionTarget): number {
    return getSignedWorkflowStepIndex(target);
  }

  private getRunIndexForTarget(
    context: WorkflowExecutionContext,
    target: ExecutionTarget
  ): number {
    return context.targetRunIndices?.get(getExecutionTargetRunKey(target)) ?? 0;
  }

  private async selectSnapshotStrategy(
    context: WorkflowExecutionContext
  ): Promise<"git" | "filesystem" | undefined> {
    if (context.snapshotService) {
      try {
        return await context.snapshotService.selectStrategy(
          context.executionWorkspace.executionRoot
        );
      } catch {
        // ignore — snapshots unavailable
      }
    }
    return undefined;
  }

  private async initializeFinalStepRuntime(
    context: WorkflowExecutionContext
  ): Promise<void> {
    const initialFinalStep = this.promptQueue.getWorkflowFile().finalStep;

    if (initialFinalStep && !this.promptQueue.getFinalStepRuntime()) {
      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.QUEUE,
        loopCount: 0,
      });
    } else if (initialFinalStep) {
      const runtime = this.promptQueue.getFinalStepRuntime();
      context.dashboardProvider?.updateFinalStepStatus(
        runtime?.status ?? null,
        runtime?.loopCount ?? 0,
        runtime?.phase ?? null
      );
    } else {
      context.dashboardProvider?.updateFinalStepStatus(null, 0, null);
    }
  }

  private async executeWithSnapshot(
    target: ExecutionTarget,
    step: WorkflowStep,
    context: WorkflowExecutionContext,
    snapshotStrategy: "git" | "filesystem" | undefined,
    preflightMember?: ParallelGroupPreflightMember
  ): Promise<StepExecutionOutcome> {
    let beforeState: RawWorkspaceState | undefined;
    if (context.snapshotService && snapshotStrategy) {
      try {
        beforeState = await context.snapshotService.captureWorkspaceState(
          context.executionWorkspace.executionRoot,
          snapshotStrategy,
          context.executionWorkspace.namedWorkspaceRoots
        );
      } catch {
        // ignore
      }
    }

    const sequentialStepId =
      target.kind === FINAL_STEP_PHASES.QUEUE && preflightMember === undefined
        ? step._runtime?.stepId
        : undefined;
    if (beforeState && sequentialStepId) {
      this.pendingSequentialSnapshotBeforeStates.set(
        sequentialStepId,
        beforeState
      );
    }

    try {
      const outcome = await this.executeTarget(
        target,
        step,
        context,
        preflightMember
      );

      if (beforeState && context.snapshotService && snapshotStrategy) {
        try {
          const promotedGroup = this.getPromotedGroupForTarget(
            target,
            preflightMember
          );
          await this.captureAndEmitSnapshot(
            promotedGroup
              ? {
                  kind: FINAL_STEP_PHASES.QUEUE,
                  stepIndex: promotedGroup.startIndex,
                }
              : target,
            beforeState,
            snapshotStrategy,
            context,
            promotedGroup?.id
          );
        } catch (e) {
          Log.warn(
            "[WorkflowExecutor] Failed to capture workspace snapshot:",
            e
          );
        }
      }
      if (!this.getPromotedGroupForTarget(target, preflightMember)) {
        if (sequentialStepId) {
          this.pendingSequentialSnapshotBeforeStates.delete(sequentialStepId);
        }
      }
      return outcome;
    } finally {
      context.unregisterActiveTarget?.(target);
    }
  }

  private getPromotedGroupForTarget(
    target: ExecutionTarget,
    preflightMember?: ParallelGroupPreflightMember
  ): ParallelGroupDefinition | undefined {
    if (target.kind !== FINAL_STEP_PHASES.QUEUE || preflightMember) {
      return undefined;
    }
    return this.promptQueue
      .getState()
      .parallelGroups.find(
        (group) =>
          target.stepIndex >= group.startIndex &&
          target.stepIndex <= group.endIndex
      );
  }

  /**
   * If the workflow is paused (or pausing), confirms the pause transition and
   * returns true so the caller can stop execution. Returns false otherwise.
   */
  private async confirmPauseAndStop(logMessage: string): Promise<boolean> {
    const runtime = this.getRuntime();
    if (
      runtime.status === EXECUTION_STATES.PAUSED ||
      runtime.status === EXECUTION_STATES.PAUSING
    ) {
      if (runtime.status === EXECUTION_STATES.PAUSING) {
        runtime.confirmPaused();
        await this.promptQueue.commitRuntimeTransition();
      }
      Log.info(logMessage);
      return true;
    }
    return false;
  }

  /**
   * Routes a CliOutput to the dashboard — queue steps via `updateCliOutput`,
   * finalStep loops via `updateFinalStepOutput`.
   */
  private dispatchDashboardOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    output: CliOutput
  ): void {
    if (signedStepIndex !== undefined && signedStepIndex >= 0) {
      context.dashboardProvider?.updateCliOutput(signedStepIndex, output);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.dashboardProvider?.updateFinalStepOutput(
        target.loopIndex,
        output
      );
    }
  }

  /**
   * Dispatches a completed CliOutput to the dashboard and the always-on
   * capture buffer (for replay when the workflow is inactive/backgrounded).
   */
  private dispatchCompletedOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    output: CliOutput,
    integration: HarnessIntegration
  ): void {
    this.dispatchDashboardOutput(context, target, signedStepIndex, output);
    if (signedStepIndex !== undefined && signedStepIndex >= 0) {
      context.captureCompletedOutput?.(signedStepIndex, output, integration);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(
        target.loopIndex,
        output,
        integration
      );
    }
  }

  /** Persists a completed CliOutput to the history file, logging (not throwing) on failure. */
  private async persistExecutionOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    output: CliOutput,
    logContext: string
  ): Promise<void> {
    if (!context.historyFilePath || !context.outputHistoryManager) {
      return;
    }
    await context.outputHistoryManager
      .saveExecutionOutput(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        [output],
        context.getDefinitionRevisionContext?.()
      )
      .catch((err) =>
        Log.warn(
          `[WorkflowExecutor] Failed to save ${logContext} to history:`,
          err
        )
      );
  }

  /** Dispatches a completed CliOutput to the dashboard/capture buffer and persists it to history. */
  private async finalizeAndPersistOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    output: CliOutput,
    integration: HarnessIntegration,
    logContext: string
  ): Promise<void> {
    // The history manager's streaming buffer holds trailing text for up to
    // its age cap and only pushes it live once written. Land that tail first:
    // a streamed batch reaching the dashboard after this `isStreaming: false`
    // output reads as post-completion activity and draws a spurious
    // "Follow-up" divider. Same ordering as ScriptExecutionReporter.
    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager
        .flushPendingWrites(context.historyFilePath)
        .catch((err) =>
          Log.warn(
            `[WorkflowExecutor] Failed to flush streamed ${logContext} before completion:`,
            err
          )
        );
    }
    this.dispatchCompletedOutput(
      context,
      target,
      signedStepIndex,
      output,
      integration
    );
    await this.persistExecutionOutput(context, target, output, logContext);
  }

  /**
   * Emits an `isStreaming: true` placeholder CliOutput to the dashboard and
   * the always-on init-capture buffer. Used both for the initial placeholder
   * and the `onPromptReady` update (which fills in `cliCommand`).
   */
  private emitStreamingPlaceholder(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    prompt: string,
    cliCommand: string | undefined,
    cliCommandWasInjected: boolean | undefined,
    timestampMs: number,
    runIndex: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined
  ): CliOutput {
    const placeholder: CliOutput = {
      prompt,
      response: "",
      elapsed: 0,
      tokens: undefined,
      isStreaming: true,
      cliCommand,
      cliCommandWasInjected,
      workingDirectory: context.executionWorkspace.executionRoot,
      timestampMs,
      runIndex,
      attemptIndex,
      rawTextOutput,
    };

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      if (signedStepIndex === undefined) {
        return placeholder;
      }
      context.dashboardProvider?.updateCliOutput(signedStepIndex, placeholder);
      context.captureOutputInit?.(
        signedStepIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        context.executionWorkspace.executionRoot,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      );
    } else {
      context.dashboardProvider?.updateFinalStepOutput(
        target.loopIndex,
        placeholder
      );
      context.captureFinalStepOutputInit?.(
        target.loopIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        context.executionWorkspace.executionRoot,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      );
    }

    return placeholder;
  }

  /** Resolves token usage stats from parsed output metadata. */
  protected resolveTokenCounts(
    parsedOutput: ReturnType<HarnessIntegration["getLastParsedOutput"]>
  ): CliOutput["tokens"] {
    if (parsedOutput?.metadata.usage) {
      const u = parsedOutput.metadata.usage;
      const harness = parsedOutput.metadata.harness;
      const cacheInputIsSubset =
        harness !== undefined &&
        HARNESS_TOKEN_SEMANTICS[harness].cacheInputRelationship ===
          ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET;
      const compactionSummary = summarizeCompactionEvents(parsedOutput.events);
      const costResult = harness
        ? calculateAttemptCost({
            harnessId: harness,
            modelId: parsedOutput.metadata.model,
            pricingOverride: parsedOutput.metadata.model
              ? ConfigurationUtils.getModelPricingOverride(
                  harness,
                  parsedOutput.metadata.model
                )
              : undefined,
            harnessReportedCostUsd:
              parsedOutput.metadata.harnessReportedCostUsd,
            prompt: u.inputTokens,
            completion: u.outputTokens,
            cached: u.cachedInputTokens,
            cacheCreated: u.cacheCreatedTokens,
            reasoning: u.reasoningOutputTokens,
            totalConfidence: u.totalConfidence,
          })
        : {
            costUnavailableReason:
              ATTEMPT_COST_UNAVAILABLE_REASONS.UNKNOWN_MODEL,
          };
      const total = cacheInputIsSubset
        ? Math.max(u.inputTokens - (u.cachedInputTokens ?? 0), 0) +
          u.outputTokens
        : u.totalTokens;
      return {
        prompt: u.inputTokens,
        completion: u.outputTokens,
        cached: u.cachedInputTokens,
        cacheCreated: u.cacheCreatedTokens,
        reasoning: u.reasoningOutputTokens,
        total,
        contextWindowUsed: u.contextWindowUsedTokens,
        contextWindowSize: u.contextWindowSize,
        ...compactionSummary,
        totalConfidence: cacheInputIsSubset
          ? TOKEN_TOTAL_CONFIDENCE.ACCUMULATED
          : u.totalConfidence,
        ...costResult,
      };
    }
    return undefined;
  }

  private describeExecutionTarget(target: ExecutionTarget): string {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue prompt ${target.stepIndex + 1}`
      : `finalStep loop ${target.loopIndex + 1}`;
  }

  private async persistInterruptedFinalStepRuntime(
    context: WorkflowExecutionContext
  ): Promise<void> {
    const runtime = this.promptQueue.getFinalStepRuntime();
    if (!runtime) {
      return;
    }

    const executionState = this.getRuntime().status;
    const status =
      executionState === EXECUTION_STATES.ERROR
        ? STEP_STATUS.FAILED
        : executionState === EXECUTION_STATES.STOPPED ||
            executionState === EXECUTION_STATES.CANCELLING
          ? STEP_STATUS.CANCELLED
          : (runtime.status ?? STEP_STATUS.RUNNING);

    await this.setFinalStepRuntime(context, {
      ...runtime,
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      status,
      ...(executionState === EXECUTION_STATES.ERROR ||
      executionState === EXECUTION_STATES.STOPPED ||
      executionState === EXECUTION_STATES.CANCELLING
        ? { completedAt: Date.now() }
        : {}),
    });
  }

  private async trackStatusMessage(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    message: string,
    severity: string = STATUS_MESSAGE_SEVERITY.INFO,
    timestampMs?: number
  ): Promise<void> {
    const resolvedTimestampMs = timestampMs ?? Date.now();

    // Queue steps keep non-negative indices; finalStep loops use negative
    // signed indices (-(loopIndex+1)) to avoid collisions with queue steps.
    // The webview sorts output rows by timestamp (see core.instructions.md),
    // so this extension-clock timestamp must ride along with the live message
    // instead of being re-stamped on receipt — a webview-side Date.now() races
    // the CLI/script row it's meant to precede.
    context.statusReporter.report(
      target,
      message,
      severity as StatusMessageSeverity,
      { timestampMs: resolvedTimestampMs }
    );
  }

  private getConditionScriptName(script: string): string {
    return script.split(/[\\/]/).pop() || script;
  }

  private async resolveScriptEnvironment(
    processEnv: Record<string, string> | undefined,
    secretNames: readonly string[],
    context: WorkflowExecutionContext
  ): Promise<Record<string, string> | undefined> {
    const resolvedSecrets = await resolveSecretEnvironment(secretNames, {
      workspaceRoot: this.platform.getWorkspaceRoot(),
      secretStore: this.platform.getSecretStore?.(),
    });
    context.secretRedactor?.addResolvedValues(resolvedSecrets);
    const env = {
      ...(buildSecretProcessEnvironment(
        processEnv,
        resolvedSecrets,
        secretNames
      ) ?? {}),
    };
    if (context.workingFilePath) {
      env[CTRLYOKE_ENV_VARS.WORKING_FILE] = context.workingFilePath.replace(
        /\\/g,
        "/"
      );
    }
    return env;
  }

  private async registerResolvedSecrets(
    names: readonly string[],
    context: WorkflowExecutionContext,
    target: ExecutionTarget
  ): Promise<void> {
    if (names.length === 0) {
      return;
    }
    const values = await this.resolveGrantedSecretValues(
      names,
      context,
      target
    );
    context.secretRedactor?.addResolvedValues(values);
  }

  /**
   * Resolves a step's granted secrets. A name that cannot resolve is reported
   * as a warning status row (persisted to history like every other
   * context-resolution warning) and simply omitted from the returned map —
   * mirroring `execution.contextResolutionFailure`'s "warn" contract for every
   * other declared-reference category, instead of hard-stopping the run the
   * way this used to unconditionally. `"fail"` mode keeps today's hard stop
   * so `secret check`'s guarantee still has a live-run counterpart. A name
   * left unresolved here still throws downstream if something actually tries
   * to interpolate it (e.g. `expandSecretInterpolations`), so a step that
   * genuinely needs the credential still fails — just at the point of use,
   * not at preflight.
   *
   * The trust check runs only on names that resolve: a grant with no value
   * hands the step nothing, so there is nothing for approval to protect, and
   * an unapproved-but-missing name takes the missing-secret path above (its
   * warning also notes the missing approval). This matters most for steps
   * appended mid-run, which never pass the start-time approval prompt.
   */
  private async resolveGrantedSecretValues(
    names: readonly string[],
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    trustedNames: readonly string[] = []
  ): Promise<Record<string, string>> {
    if (names.length === 0) {
      return {};
    }
    const workspaceRoot = this.platform.getWorkspaceRoot();
    const resolutionContext = {
      workspaceRoot,
      secretStore: this.platform.getSecretStore?.(),
    };
    const missing = await findMissingSecretNames(names, resolutionContext);
    const resolvable = names.filter((name) => !missing.includes(name));
    assertSecretGrantTrust(
      resolvable,
      workspaceRoot,
      trustedNames,
      this.secretGrantTrustStore
    );
    if (missing.length > 0) {
      if (
        ConfigurationUtils.getContextResolutionFailureMode() ===
        CONTEXT_RESOLUTION_FAILURE_MODES.FAIL
      ) {
        throw new MissingSecretError(missing[0], missing);
      }
      const unapprovedMissing = findUnapprovedSecretGrants(
        missing,
        workspaceRoot,
        trustedNames,
        this.secretGrantTrustStore
      );
      const approvalNote =
        unapprovedMissing.length > 0
          ? ` The grant${
              unapprovedMissing.length > 1 ? "s" : ""
            } for ${unapprovedMissing.join(", ")} ${
              unapprovedMissing.length > 1 ? "are" : "is"
            } also not approved for this workspace; approve ${
              unapprovedMissing.length > 1 ? "them" : "it"
            } once a value is set.`
          : "";
      await this.trackStatusMessage(
        context,
        target,
        `Context resolution warning: declared secret${
          missing.length > 1 ? "s are" : " is"
        } not available: ${missing.join(", ")}.${approvalNote}`,
        STATUS_MESSAGE_SEVERITY.WARNING
      );
    }
    return resolveSecretEnvironment(resolvable, resolutionContext);
  }

  /**
   * Publishes the one-line condition verdict beside the CLI output group.
   */
  private async trackConditionResult(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    label: string,
    verdict: ScriptVerdict,
    failureSeverity: string = STATUS_MESSAGE_SEVERITY.ERROR
  ): Promise<void> {
    const severity =
      verdict.outcome === SCRIPT_VERDICT_OUTCOMES.PASSED
        ? STATUS_MESSAGE_SEVERITY.INFO
        : failureSeverity;

    await this.trackStatusMessage(
      context,
      target,
      formatVerdictSummary(label, verdict),
      severity
    );
  }

  private recordPreConditionSummary(
    target: ExecutionTarget,
    summary: ReturnType<typeof createConditionEvaluationSummary>
  ): void {
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.promptQueue.recordPreConditionSummary(target.stepIndex, summary);
    } else {
      this.promptQueue.recordFinalStepPreConditionSummary(summary);
    }
  }

  private recordEndConditionSummary(
    target: ExecutionTarget,
    summary: ReturnType<typeof createConditionEvaluationSummary>
  ): void {
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.promptQueue.recordEndConditionSummary(target.stepIndex, summary);
    } else {
      this.promptQueue.recordFinalStepEndConditionSummary(summary);
    }
  }

  private getErrorConditionAction(
    errorBehavior?: ErrorBehavior
  ): ConditionAction {
    switch (errorBehavior?.onError) {
      case CONDITION_ACTIONS.RETRY:
        return CONDITION_ACTIONS.RETRY;
      case CONDITION_ACTIONS.CONTINUE:
        return CONDITION_ACTIONS.CONTINUE;
      default:
        return CONDITION_ACTIONS.STOP_WORKFLOW;
    }
  }

  private getEvaluationErrorMessage(result: EvaluationResult): string {
    if (result.timeout) {
      return `timed out after ${result.duration}ms`;
    }
    return result.error ?? "evaluation failed";
  }

  /** Route an evaluator error through the one policy shared by all step phases. */
  private async handleEvaluationError(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number,
    phase: string,
    result: EvaluationResult,
    errorBehavior: ErrorBehavior | null | undefined,
    attemptIndex: number,
    errorRetryCount: number,
    completeAttemptOnContinue: boolean = false
  ): Promise<PhaseDisposition> {
    const policy = errorBehavior ?? {
      onError: CONDITION_ACTIONS.STOP_WORKFLOW,
    };
    const maxRetries = policy.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES;
    const canRetry = canRetryErrorBehavior(policy, errorRetryCount);
    const actionText = canRetry
      ? `retry ${errorRetryCount + 1} of ${formatRetryDenominator(maxRetries)}`
      : policy.onError === CONDITION_ACTIONS.CONTINUE
        ? CONDITION_ACTIONS.CONTINUE
        : WORKFLOW_EXECUTION_OUTCOMES.STOP;
    const severity =
      canRetry || policy.onError === CONDITION_ACTIONS.CONTINUE
        ? STATUS_MESSAGE_SEVERITY.WARNING
        : STATUS_MESSAGE_SEVERITY.ERROR;
    const reason = this.getEvaluationErrorMessage(result);

    await this.trackStatusMessage(
      context,
      target,
      `${phase} could not run: ${reason} → ${actionText}`,
      severity
    );

    if (canRetry) {
      const nextAttemptIndex = attemptIndex + 1;
      const runtime = this.getRuntime();
      runtime.failAttempt(target, attemptIndex, reason);
      await this.recordAttemptTerminal(
        context,
        target,
        attemptIndex,
        TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED,
        reason
      );
      runtime.scheduleRetry(
        target,
        nextAttemptIndex,
        errorRetryCount + 1,
        maxRetries
      );
      const retryDelayMs = ConfigurationUtils.secondsToMs(policy.retryDelaySec);
      if ((retryDelayMs ?? 0) > 0) {
        await this.delay(retryDelayMs!);
      }
      return {
        outcome: WORKFLOW_EXECUTION_OUTCOMES.RETRY,
        nextAttemptIndex,
        nextErrorRetryCount: errorRetryCount + 1,
      };
    }

    if (policy.onError === CONDITION_ACTIONS.CONTINUE) {
      if (completeAttemptOnContinue) {
        this.getRuntime().completeAttempt(target, attemptIndex);
      }
      return { outcome: WORKFLOW_EXECUTION_OUTCOMES.CONTINUE };
    }

    await this.failStepForInternalError(
      context,
      target,
      signedStepIndex,
      attemptIndex,
      `${phase}: ${reason}`,
      result.timeout ? FAILURE_KINDS.TIMEOUT : undefined
    );
    return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
  }

  private async failStepForInternalError(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number,
    attemptIndex: number,
    reason: string,
    failureKind?: typeof FAILURE_KINDS.TIMEOUT
  ): Promise<void> {
    const runtime = this.getRuntime();
    runtime.failAttempt(target, attemptIndex, reason);
    await this.recordAttemptTerminal(
      context,
      target,
      attemptIndex,
      TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED,
      reason
    );

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      if (context.dashboardProvider && signedStepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.FAILED,
          message: reason,
        });
      }
      await this.promptQueue.failStep(target.stepIndex, reason, failureKind);
    } else {
      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: target.loopIndex,
        status: STEP_STATUS.FAILED,
        failureKind,
        failureMessage: reason,
        startedAt:
          this.promptQueue.getFinalStepRuntime()?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      });
    }
  }

  private getBufferedCliOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number
  ): CliOutput | undefined {
    if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      return context.getFinalStepBufferedOutput?.(target.loopIndex);
    }

    return signedStepIndex >= 0
      ? context.getBufferedOutput?.(signedStepIndex)
      : undefined;
  }

  private createFinalCliOutput(params: {
    context: WorkflowExecutionContext;
    integration: HarnessIntegration;
    target: ExecutionTarget;
    signedStepIndex: number;
    prompt: PromptStep;
    runIndex: number;
    attemptIndex: number;
    responseText?: string;
    errorMessage?: string;
    rawTextOutput?: boolean;
  }): CliOutput {
    const {
      context,
      integration,
      target,
      signedStepIndex,
      prompt,
      runIndex,
      attemptIndex,
      responseText,
      errorMessage,
      rawTextOutput: rawTextOutputOverride,
    } = params;
    const bufferedOutput = this.getBufferedCliOutput(
      context,
      target,
      signedStepIndex
    );
    const parsedOutput = integration.getLastParsedOutput?.();
    const parsedStructured = parsedOutput
      ? CliOutputFormatter.toDashboardFormat(parsedOutput)
      : undefined;
    const bufferedStructured = bufferedOutput?.structured;
    let structured: DashboardOutput | undefined = parsedStructured;

    if (
      parsedStructured &&
      bufferedStructured?.events &&
      bufferedStructured.events.length > parsedStructured.events.length
    ) {
      structured = {
        ...parsedStructured,
        events: bufferedStructured.events,
      };
    } else if (!parsedStructured && bufferedStructured) {
      structured = bufferedStructured;
    }

    const tokens = this.resolveTokenCounts(parsedOutput);

    return {
      prompt: prompt.prompt,
      response: responseText ?? bufferedOutput?.response ?? "",
      structured,
      elapsed: bufferedOutput?.elapsed ?? 0,
      tokens,
      isStreaming: false,
      cliCommand: context.shouldShowCliCommand
        ? (integration.getLastCliCommand() ?? bufferedOutput?.cliCommand)
        : undefined,
      cliCommandWasInjected: context.shouldShowCliCommand
        ? (integration.getLastCliCommandWasInjected() ??
          bufferedOutput?.cliCommandWasInjected)
        : undefined,
      workingDirectory:
        bufferedOutput?.workingDirectory ??
        context.executionWorkspace.executionRoot,
      timestampMs:
        bufferedOutput?.timestampMs ??
        this.getPromptPhaseStartedAt(target) ??
        Date.now(),
      runIndex,
      attemptIndex,
      rawTextOutput:
        rawTextOutputOverride ??
        bufferedOutput?.rawTextOutput ??
        (integration.rawTextOutput || undefined),
      errorMessage,
    };
  }

  private async evaluateEndCondition(
    prompt: PromptStep,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    runIndex: number,
    attemptIndex: number,
    duration: number,
    promptErrorRetryCounter: { count: number },
    errorRetryCount: number,
    vars?: Record<string, string>,
    errorBehavior?: ErrorBehavior,
    secretNames: readonly string[] = []
  ): Promise<PhaseDisposition> {
    Log.trace(
      `[WorkflowExecutor] Evaluating end condition for ${this.describeExecutionTarget(target)}...`
    );

    if (!prompt.endCondition?.script) {
      Log.error(
        `[WorkflowExecutor] End condition for ${this.describeExecutionTarget(target)} is missing required 'script' property`
      );
      const missingScriptResult = {
        passed: false,
        matchRule: "none" as const,
        actual: "",
        actualSource: "exitCode" as const,
        errored: true,
        stdout: "",
        stderr: "",
        result: "",
        error: "End condition missing required 'script' property",
        duration,
      };
      this.recordEndConditionSummary(
        target,
        createConditionEvaluationSummary(
          prompt.endCondition?.script ?? "",
          missingScriptResult,
          {
            expected: prompt.endCondition?.expected,
            compareSource: prompt.endCondition?.compareSource,
            operator: prompt.endCondition?.operator,
          }
        )
      );
      return this.handleEvaluationError(
        context,
        target,
        signedStepIndex ?? this.getSignedStepIndex(target),
        SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
        missingScriptResult,
        errorBehavior,
        attemptIndex,
        errorRetryCount,
        true
      );
    }

    const endCondition = prompt.endCondition;
    const willRetryEndCondition = (result: EvaluationResult): boolean =>
      !result.errored &&
      (result.passed
        ? endCondition.onPass === CONDITION_ACTIONS.RETRY &&
          this.promptQueue.canPassRetry(prompt, target)
        : endCondition.onFail !== CONDITION_ACTIONS.CONTINUE &&
          this.promptQueue.canRetry(prompt, target));
    const endConditionActionForResult = (
      result: EvaluationResult
    ): ConditionAction => {
      if (result.errored) {
        return this.getErrorConditionAction(errorBehavior);
      }
      if (willRetryEndCondition(result)) {
        return CONDITION_ACTIONS.RETRY;
      }
      if (result.passed && endCondition.onPass === CONDITION_ACTIONS.RETRY) {
        return CONDITION_ACTIONS.CONTINUE;
      }
      if (!result.passed && endCondition.onFail === CONDITION_ACTIONS.RETRY) {
        return CONDITION_ACTIONS.STOP_WORKFLOW;
      }
      return result.passed
        ? (endCondition.onPass ?? CONDITION_ACTIONS.CONTINUE)
        : (endCondition.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW);
    };
    const endConditionActionDetail = (
      result: EvaluationResult
    ): string | undefined => {
      if (!willRetryEndCondition(result)) {
        return undefined;
      }

      return `retry ${this.promptQueue.getCurrentRetryCount(target) + 1} of ${formatRetryDenominator(this.promptQueue.getEffectiveMaxRetries(prompt))}`;
    };

    await this.trackStatusMessage(
      context,
      target,
      `Evaluating end condition: Running ${this.getConditionScriptName(
        endCondition.script
      )}`
    );

    const endReport = await this.scriptExecutionReporter.report({
      context,
      source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
      properties: toReportedConditionProperties(endCondition),
      phase: EXECUTION_PHASES.END_CONDITION,
      target: this.toOutputExecutionTarget(target),
      signedStepIndex: signedStepIndex ?? this.getSignedStepIndex(target),
      runIndex,
      attemptIndex,
      startReason: getAttemptStartReason(attemptIndex),
      timestampMs: Date.now(),
      onPass: endCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
      onFail: endCondition.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
      actionForErrored: this.getErrorConditionAction(errorBehavior),
      actionForResult: endConditionActionForResult,
      statusLabel: SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
      timeoutMs:
        ConfigurationUtils.secondsToMs(endCondition.timeoutSec) ??
        ConfigurationUtils.getScriptTimeoutMs(),
      vars,
      secretNames,
      actionDetail: endConditionActionDetail,
      emitStatus: false,
    });
    const evaluationResult = endReport.evaluationResult;

    if (evaluationResult.errored) {
      this.recordEndConditionSummary(
        target,
        createConditionEvaluationSummary(
          endCondition.script,
          evaluationResult,
          {
            expected: endCondition.expected,
            compareSource: endCondition.compareSource,
            operator: endCondition.operator,
          }
        )
      );
      return this.handleEvaluationError(
        context,
        target,
        signedStepIndex ?? this.getSignedStepIndex(target),
        SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
        evaluationResult,
        errorBehavior,
        attemptIndex,
        errorRetryCount,
        true
      );
    }

    await this.trackConditionResult(
      context,
      target,
      SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
      endReport.verdict,
      STATUS_MESSAGE_SEVERITY.ERROR
    );

    const retryContext: RetryContext = {
      integration,
      totalSteps: this.promptQueue.getState().steps.length,
      workspaceFolderPath: context.workspaceFolderPath,
      executionWorkspace: context.executionWorkspace,
      currentPromptFilePath: context.currentPromptFilePath,
      runtime: this.promptQueue.getRuntimeStateMachine(),
      attemptTarget: target,
      attemptIndex,
      vars,
      evaluateCondition: async (condition, retryAttemptIndex) =>
        this.scriptExecutionReporter.report({
          context,
          source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
          properties: toReportedConditionProperties(condition),
          phase: EXECUTION_PHASES.END_CONDITION,
          target: this.toOutputExecutionTarget(target),
          signedStepIndex: signedStepIndex ?? this.getSignedStepIndex(target),
          runIndex,
          attemptIndex: retryAttemptIndex,
          startReason: getAttemptStartReason(retryAttemptIndex),
          timestampMs: Date.now(),
          onPass: endCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
          onFail: endCondition.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
          actionForErrored: this.getErrorConditionAction(errorBehavior),
          actionForResult: endConditionActionForResult,
          statusLabel:
            SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
          timeoutMs:
            ConfigurationUtils.secondsToMs(condition.timeoutSec) ??
            ConfigurationUtils.getScriptTimeoutMs(),
          vars,
          secretNames,
          actionDetail: endConditionActionDetail,
          emitStatus: false,
        }),
      onEvaluation: async (
        _retryEvaluation,
        _retryAttemptIndex,
        retryVerdict
      ) => {
        // Reporter-backed retry evaluations always provide a verdict. Keep the
        // callback optional for direct EndConditionHandler tests.
        if (retryVerdict && retryVerdict.outcome !== "errored") {
          await this.trackConditionResult(
            context,
            target,
            SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
            retryVerdict,
            STATUS_MESSAGE_SEVERITY.ERROR
          );
        }
      },
    };

    const sendRetryPromptCallback = this.createSendRetryPromptCallback(
      integration,
      context,
      target,
      signedStepIndex,
      runIndex,
      promptErrorRetryCounter
    );

    const result = await this.endConditionHandler.handleEndConditionResult(
      prompt,
      evaluationResult,
      retryContext,
      sendRetryPromptCallback
    );

    if (result.errorResult) {
      return this.handleEvaluationError(
        context,
        target,
        signedStepIndex ?? this.getSignedStepIndex(target),
        SCRIPT_SOURCE_LABELS[SCRIPT_OUTPUT_SOURCES.END_CONDITION],
        result.errorResult,
        errorBehavior,
        result.errorAttemptIndex ?? attemptIndex,
        errorRetryCount,
        true
      );
    }

    if (!result.shouldContinue) {
      if (context.dashboardProvider && signedStepIndex !== undefined) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.FAILED,
          message: result.failureReason || "End condition failed",
          duration,
          endConditionResult: evaluationResult,
        });
      }
    }

    return {
      outcome: result.shouldContinue
        ? WORKFLOW_EXECUTION_OUTCOMES.CONTINUE
        : WORKFLOW_EXECUTION_OUTCOMES.STOP,
    };
  }

  /**
   * Waits for the integration to fire `onResponseComplete`.
   *
   * A pause request never intercepts this response. The caller finishes the
   * complete terminal pipeline and then honors PAUSING at the step boundary.
   *
   * There is intentionally no per-prompt timeout here. Complex prompts (large
   * refactors, full audits) can legitimately run for hours. The workflow-level
   * `maxWorkflowExecutionTime` setting guards against runaway workflows, and
   * users can stop manually at any time.
   */
  private async waitForResponseComplete(
    _prompt: PromptStep,
    integration: HarnessIntegration,
    target: ExecutionTarget,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const targetKey = getExecutionTargetRunKey(target);
    this.waitingResponseTargets.add(targetKey);
    return new Promise<string | null>((resolve) => {
      let responseHandled = false;
      let abortListener: (() => void) | undefined;

      const finish = (responseText: string | null): void => {
        if (responseHandled) {
          return;
        }
        responseHandled = true;
        disposable.dispose();
        if (abortListener) {
          abortSignal?.removeEventListener("abort", abortListener);
        }
        this.waitingResponseTargets.delete(targetKey);
        resolve(responseText);
      };

      const disposable = integration.onResponseComplete(
        (responseText: string) => {
          finish(responseText);
        }
      );

      if (abortSignal) {
        abortListener = () => finish(null);
        if (abortSignal.aborted) {
          abortListener();
        } else {
          abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      }
    });
  }

  /**
   * Sends a prompt and manages the full streaming lifecycle: dashboard init,
   * listener setup and teardown, and response-completion waiting.
   *
   * Used by both the main execution loop (`attemptIndex = 0`) and retry
   * callbacks (`attemptIndex = N`).
   *
   * @param onPromptSent Optional async callback invoked after a successful send
   *   but *before* awaiting the response. Use for queue bookkeeping that must
   *   happen in that specific window (e.g. `markStepAsSent`).
   * @returns `{ responseText, duration }` on success, `null` if `sendPrompt`
   *   returns false.
   */
  private async executeWithStreaming(
    promptStep: PromptStep,
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    runIndex: number,
    attemptIndex: number,
    sendOptions: WorkflowContext,
    onPromptSent?: () => Promise<void>,
    attemptStartReason: TimelineAttemptStartReason = TIMELINE_ATTEMPT_START_REASONS.INITIAL,
    beginAttempt: boolean = true
  ): Promise<{ responseText: string; duration: number } | null> {
    const runtime = this.promptQueue.getRuntimeStateMachine();
    if (beginAttempt) {
      runtime.beginAttempt(target, attemptIndex, Date.now());
    } else if (!runtime.getAttempt(target)) {
      runtime.beginAttempt(target, attemptIndex, Date.now());
    }
    const startTime = Date.now();

    // The attempt began at its pre-condition gate, which may have run for
    // minutes; the prompt's own output must be stamped from here so it sorts
    // after the pre-condition output rather than ahead of it.
    const initTimestampMs = runtime.markPromptStarted(target, startTime);
    const rawTextOutput = integration.rawTextOutput || undefined;

    const placeholder = this.emitStreamingPlaceholder(
      context,
      target,
      signedStepIndex,
      promptStep.prompt,
      undefined,
      undefined,
      initTimestampMs,
      runIndex,
      attemptIndex,
      rawTextOutput
    );
    if (context.historyFilePath && context.outputHistoryManager) {
      // Do not let a prompt that may consume prior context proceed until its
      // durable attempt identity and definition revision are committed.
      await context.outputHistoryManager.startStreamingExecutionOutput(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        placeholder,
        context.getDefinitionRevisionContext?.(),
        {
          kind: "ai",
          startReason: attemptStartReason,
          prompt: promptStep.prompt,
        }
      );
    }

    const responsePromise = this.waitForResponseComplete(
      promptStep,
      integration,
      target,
      context.abortSignal
    );

    let streamingDisposable: { dispose(): void } | undefined;
    let structuredStreamingDisposable: { dispose(): void } | undefined;
    let promptReadyDisposable: { dispose(): void } | undefined;

    promptReadyDisposable = integration.onPromptReady((data) => {
      const cliCommand = context.shouldShowCliCommand
        ? data.cliCommand
        : undefined;

      this.emitStreamingPlaceholder(
        context,
        target,
        signedStepIndex,
        promptStep.prompt,
        cliCommand,
        data.cliCommandWasInjected,
        initTimestampMs,
        runIndex,
        attemptIndex,
        rawTextOutput
      );
    });

    streamingDisposable = integration.onStreamingChunk((chunk) => {
      context.onTargetStreamingChunk?.({
        target,
        stepName:
          promptStep.name?.trim() ||
          (target.kind === FINAL_STEP_PHASES.QUEUE
            ? `Step ${target.stepIndex + 1}`
            : formatFinalPassLabel(target.loopIndex + 1)),
        chunk,
      });
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureChunk?.(signedStepIndex, chunk);
        if (!(
          context.historyFilePath &&
          context.outputHistoryManager?.hasOutputActivityHandler()
        )) {
          context.dashboardProvider?.updateCliStreamingChunk(
            signedStepIndex,
            chunk
          );
        }
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepChunk?.(target.loopIndex, chunk);
        if (!(
          context.historyFilePath &&
          context.outputHistoryManager?.hasOutputActivityHandler()
        )) {
          context.dashboardProvider?.updateFinalStepStreamingChunk(
            target.loopIndex,
            chunk
          );
        }
      }

      if (context.historyFilePath && context.outputHistoryManager) {
        void context.outputHistoryManager.appendStreamingChunk(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          runIndex,
          attemptIndex,
          chunk
        );
      }
    });

    structuredStreamingDisposable = integration.onStreamingEvents((events) => {
      context.onTargetStreamingEvents?.({
        target,
        stepName:
          promptStep.name?.trim() ||
          (target.kind === FINAL_STEP_PHASES.QUEUE
            ? `Step ${target.stepIndex + 1}`
            : formatFinalPassLabel(target.loopIndex + 1)),
        events,
      });
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureEvents?.(signedStepIndex, events);
        if (!(
          context.historyFilePath &&
          context.outputHistoryManager?.hasOutputActivityHandler()
        )) {
          context.dashboardProvider?.updateCliStreamingEvents(
            signedStepIndex,
            events,
            attemptIndex,
            runIndex,
            undefined
          );
        }
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepEvents?.(target.loopIndex, events);
        if (!(
          context.historyFilePath &&
          context.outputHistoryManager?.hasOutputActivityHandler()
        )) {
          context.dashboardProvider?.updateFinalStepStreamingEvents(
            target.loopIndex,
            events,
            attemptIndex,
            runIndex,
            undefined
          );
        }
      }

      if (context.historyFilePath && context.outputHistoryManager) {
        void context.outputHistoryManager.appendStreamingEvents(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          runIndex,
          attemptIndex,
          events
        );
      }
    });

    const contextWindowDisposable = integration.onContextWindowUpdate(
      ({ used, size }) => {
        if (
          target.kind === FINAL_STEP_PHASES.QUEUE &&
          signedStepIndex !== undefined
        ) {
          context.captureContextWindow?.(signedStepIndex, used, size);
          context.dashboardProvider?.updateContextWindow(
            signedStepIndex,
            used,
            size
          );
        }
      }
    );

    const disposeListeners = () => {
      streamingDisposable?.dispose();
      structuredStreamingDisposable?.dispose();
      contextWindowDisposable?.dispose();
      promptReadyDisposable?.dispose();
    };

    context.beginSessionActivityTargetCapture?.(integration, target);
    const success = await integration.sendPrompt(promptStep, true, {
      ...sendOptions,
      promptStartedAt: initTimestampMs,
    });
    if (!success) {
      this.waitingResponseTargets.delete(getExecutionTargetRunKey(target));
      disposeListeners();
      return null;
    }

    if (onPromptSent) {
      await onPromptSent();
    }

    const responseText = await responsePromise;
    disposeListeners();
    if (responseText === null) {
      return null;
    }

    const duration = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
    return { responseText, duration };
  }

  /**
   * Builds the retry-prompt callback passed to `EndConditionHandler`.
   *
   * Note: `EndConditionHandler` calls `incrementRetryCount()` on the queue
   * *before* invoking this callback, so `getCurrentRetryCount()` already
   * reflects the current attempt number when the callback fires.
   */
  private createSendRetryPromptCallback(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    runIndex: number,
    promptErrorRetryCounter: { count: number }
  ): SendRetryPromptCallback {
    return async (
      retryPromptStep: PromptStep,
      currentIndex: number,
      retryAttemptIndex: number
    ): Promise<{ responseText: string; attemptIndex: number } | null> => {
      const state = this.promptQueue.getState();
      const workflowFile = this.promptQueue.getWorkflowFile();
      let resolvedProperties = PropertyResolver.resolve(
        retryPromptStep,
        workflowFile,
        { hostCanProvidePty: context.hostCanProvidePty }
      );
      const retryVars = workflowFile.vars ?? {};
      if (Object.keys(retryVars).length > 0) {
        resolvedProperties = VarSubstitutor.applyToResolvedProperties(
          resolvedProperties,
          retryVars
        );
      }
      const effectiveRetryPrompt: PromptStep = {
        ...retryPromptStep,
        prompt: await this.resolveEffectivePrompt(
          retryPromptStep.prompt,
          context,
          workflowFile.vars
        ),
      };
      if (!effectiveRetryPrompt.prompt.trim()) {
        throw new Error(
          "Retry prompt is empty after resolving its prompt file"
        );
      }
      this.reportUnresolvedVariables(
        this.getResolvedPropertyVariableFields(resolvedProperties).concat({
          field: "retry prompt text",
          value: effectiveRetryPrompt.prompt,
        }),
        retryVars,
        resolvedProperties.harness,
        context,
        target,
        retryPromptStep,
        "retry prompt"
      );
      this.reportIgnoredSecretInterpolations(
        effectiveRetryPrompt.prompt,
        resolvedProperties,
        context
      );

      const mcpNormalization =
        await McpServerNormalizer.applyFromRegistryWithDiagnostics(
          resolvedProperties,
          context.workspaceFolderPath ??
            context.executionWorkspace.executionRoot,
          effectiveRetryPrompt.prompt
        );
      resolvedProperties = mcpNormalization.properties;
      const retrySecretNames = getEffectiveSecretGrants(
        retryPromptStep,
        resolvedProperties.secrets,
        getProcessMapSecretNames(resolvedProperties)
      );
      const retrySecretValues = await this.resolveGrantedSecretValues(
        retrySecretNames,
        context,
        target,
        mcpNormalization.trustedUserScopeSecretNames
      );
      context.secretRedactor?.addResolvedValues(retrySecretValues);
      resolvedProperties = {
        ...resolvedProperties,
        secrets: retrySecretNames,
        hooks:
          resolvedProperties.hooks === null
            ? null
            : resolvedProperties.hooks?.map((hook) => ({
                ...hook,
                env: expandSecretInterpolations(
                  hook.env,
                  retrySecretValues,
                  retrySecretNames
                ),
              })),
      };
      context.reportCompatibilityDiagnostics?.(mcpNormalization.diagnostics);
      this.assertContextResolutionDiagnosticsAllowed(
        mcpNormalization.diagnostics
      );

      if (context.historyFilePath && context.outputHistoryManager) {
        await context.outputHistoryManager.recordRetryScheduled(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          runIndex,
          retryAttemptIndex,
          retryAttemptIndex - 1,
          effectiveRetryPrompt.prompt,
          context.getDefinitionRevisionContext?.()
        );
      }

      let sendAttemptIndex = retryAttemptIndex;
      let result: { responseText: string; duration: number } | null;
      while (true) {
        const retryAttemptProperties =
          sendAttemptIndex === retryAttemptIndex
            ? resolvedProperties
            : {
                ...resolvedProperties,
                resumeSession: false,
                sessionId: undefined,
              };
        result = await this.executeWithStreaming(
          effectiveRetryPrompt,
          integration,
          context,
          target,
          target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
          runIndex,
          sendAttemptIndex,
          {
            promptIndex: currentIndex,
            // A final-step retry's `currentIndex` is `results.length` — positive,
            // like any queue index — so without this the terminal would fall back
            // to it and disagree with the single signed notation
            // `getActiveStepIndices()` now reports, leaving a running final step's
            // terminal ungated mid-retry.
            terminalStepIndex: signedStepIndex,
            allPrompts: state.steps,
            filePath: context.currentPromptFilePath,
            workflowName: this.promptQueue.getState().workflowName,
            instanceId: context.instanceId,
            workingFilePath: context.workingFilePath,
            mcpToolSkillContext: this.getMcpToolSkillContext(
              context,
              currentIndex,
              workflowFile
            ),
            resolvedProperties: retryAttemptProperties,
            workflowFile,
            workingFilePersistence: this.promptQueue,
            preConditionResult: this.promptQueue.getPreConditionSummary(target),
            endConditionResult: this.promptQueue.getEndConditionSummary(target),
            reportCompatibilityDiagnostics:
              context.reportCompatibilityDiagnostics,
            analyzeCompatibilityForPrompt:
              context.analyzeCompatibilityForPrompt,
            resolvePriorContextItems: context.resolvePriorContextItems,
            releaseConflictingAiSession: context.releaseConflictingAiSession,
            ...(target.kind === FINAL_STEP_PHASES.QUEUE
              ? {
                  groupStartBoundary: this.getParallelGroupStartBoundary(
                    target.stepIndex
                  ),
                }
              : {}),
            secretEnvironment: retrySecretValues,
            finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
              string | undefined,
          },
          undefined,
          TIMELINE_ATTEMPT_START_REASONS.RETRY
        );

        if (result) {
          break;
        }

        const failureDisposition = await this.handlePromptSendFailure(
          integration,
          context,
          target,
          effectiveRetryPrompt,
          signedStepIndex ?? this.getSignedStepIndex(target),
          runIndex,
          sendAttemptIndex,
          promptErrorRetryCounter.count,
          retryAttemptProperties
        );
        if (failureDisposition.outcome !== WORKFLOW_EXECUTION_OUTCOMES.RETRY) {
          return null;
        }
        promptErrorRetryCounter.count =
          failureDisposition.nextErrorRetryCount ??
          promptErrorRetryCounter.count + 1;
        sendAttemptIndex += 1;
      }

      await this.updateDashboardWithResponse(
        context,
        integration,
        target,
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
        retryPromptStep,
        result.responseText,
        result.duration,
        runIndex,
        sendAttemptIndex,
        resolvedProperties.harness
      );

      return {
        responseText: result.responseText,
        attemptIndex: sendAttemptIndex,
      };
    };
  }

  /**
   * `${secret:NAME}` in prompt text is never substituted — prompt bodies are
   * not a resolution boundary. This is reported as an advisory only: it is
   * deliberately excluded from `isContextResolutionDiagnostic`, so it never
   * blocks a step even in `"fail"` mode. Prompts legitimately quote the syntax
   * (plans and instruction files that document it), and hard-failing those was
   * the behavior this replaced.
   */
  private reportIgnoredSecretInterpolations(
    promptText: string,
    resolvedProperties: ResolvedProperties,
    context: WorkflowExecutionContext
  ): void {
    const tokens = findSecretInterpolationsInPrompt(promptText);
    if (tokens.length === 0) {
      return;
    }
    context.reportCompatibilityDiagnostics?.([
      {
        code: PROMPT_DIAGNOSTIC_CODES.SECRET_INTERPOLATION_IGNORED,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        harnessId: resolvedProperties.harness,
        capability: "promptInputs",
        state: {
          fidelity: CAPABILITY_FIDELITIES.PARTIAL,
          mechanism: CAPABILITY_MECHANISMS.NONE,
          verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
        },
        message:
          `Secret interpolation is not substituted in prompt text (${tokens.join(
            ", "
          )}); the text is sent to the harness verbatim. ` +
          "Use !NAME to grant an environment variable to the step.",
      },
    ]);
  }

  private getEnvironmentFields(
    prefix: string,
    env: Record<string, string> | undefined
  ): Array<{ field: string; value: string }> {
    return env
      ? Object.entries(env).map(([key, value]) => ({
          field: `${prefix}.${key}`,
          value,
        }))
      : [];
  }

  private getResolvedPropertyVariableFields(
    properties: ResolvedProperties,
    options: { includePreCondition?: boolean } = {}
  ): Array<{ field: string; value: string | undefined }> {
    const fields: Array<{ field: string; value: string | undefined }> = [
      { field: "model", value: properties.model },
      { field: "additionalArgs", value: properties.additionalArgs },
    ];

    properties.hooks?.forEach((hook, index) => {
      fields.push({ field: `hook[${index}].command`, value: hook.command });
      fields.push(...this.getEnvironmentFields(`hook[${index}].env`, hook.env));
    });

    if (options.includePreCondition !== false) {
      fields.push({
        field: "preCondition.script",
        value: properties.preCondition?.script,
      });
      fields.push(
        ...this.getEnvironmentFields(
          "preCondition.env",
          properties.preCondition?.env
        )
      );
    }

    fields.push({
      field: "endCondition.script",
      value: properties.endCondition?.script,
    });
    fields.push(
      ...this.getEnvironmentFields(
        "endCondition.env",
        properties.endCondition?.env
      ),
      {
        field: "endCondition.retryPrompt",
        value: properties.endCondition?.retryPrompt,
      },
      {
        field: "endCondition.passRetryPrompt",
        value: properties.endCondition?.passRetryPrompt,
      }
    );
    return fields;
  }

  private reportUnresolvedVariables(
    fields: ReadonlyArray<{ field: string; value: string | undefined }>,
    vars: Record<string, string>,
    harnessId: HarnessId,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    step: WorkflowStep,
    phase?: string
  ): void {
    if (Object.keys(vars).length === 0) {
      return;
    }

    const findings = fields.flatMap(({ field, value }) =>
      value === undefined
        ? []
        : VarSubstitutor.findUnresolvedVariables(value, vars).map(
            (placeholder) => ({ field, placeholder })
          )
    );
    if (findings.length === 0) {
      return;
    }

    const stepLabel =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? `step ${target.stepIndex + 1}${step.name ? ` ("${step.name}")` : ""}`
        : "final step";
    const phaseLabel = phase ? ` during ${phase}` : "";
    const locations = findings.map(
      ({ field, placeholder }) => `${placeholder} in ${field}`
    );
    context.reportCompatibilityDiagnostics?.([
      {
        code: PROMPT_DIAGNOSTIC_CODES.VARIABLE_SUBSTITUTION_IGNORED,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        harnessId,
        capability: "variableSubstitution",
        consumer: this.toOutputExecutionTarget(target),
        state: {
          fidelity: CAPABILITY_FIDELITIES.PARTIAL,
          mechanism: CAPABILITY_MECHANISMS.NONE,
          verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
        },
        message:
          `Unresolved variable placeholders were left literal in ${stepLabel}${phaseLabel}: ` +
          `${locations.join(", ")}. ` +
          "Define the variable in vars or remove the placeholder if it was intended as text.",
        remediation:
          "Define the variable in the workflow vars section or remove the placeholder if it was intended as text.",
      },
    ]);
  }

  private assertContextResolutionDiagnosticsAllowed(
    diagnostics: readonly CompatibilityDiagnostic[]
  ): void {
    const blockingDiagnostics = diagnostics.filter((diagnostic) =>
      isContextResolutionDiagnostic(diagnostic.code)
    );
    if (
      ConfigurationUtils.getContextResolutionFailureMode() ===
        CONTEXT_RESOLUTION_FAILURE_MODES.FAIL &&
      blockingDiagnostics.length > 0
    ) {
      throw new Error(
        formatContextResolutionFailureMessage(blockingDiagnostics)
      );
    }
  }

  private async resolveEffectivePrompt(
    promptText: string,
    context: WorkflowExecutionContext,
    variables: Record<string, string> | undefined
  ): Promise<string> {
    const { promptFileResolver, sourceDefinitionPath } =
      this.getPromptFileResolutionOptions(context);
    return resolvePromptTextWithVariables(
      promptText,
      variables ?? {},
      promptFileResolver,
      sourceDefinitionPath
    );
  }

  private getPromptFileResolutionOptions(context: WorkflowExecutionContext): {
    promptFileResolver: PromptFileResolver;
    sourceDefinitionPath?: string;
  } {
    const executionWorkspace = context.executionWorkspace;
    const usesLegacyNoWorktreeContext =
      !executionWorkspace.sourceCheckoutRoot &&
      !executionWorkspace.executionCheckoutRoot &&
      context.workspaceFolderPath !== undefined &&
      !pathsEqual(
        path.resolve(context.workspaceFolderPath),
        path.resolve(executionWorkspace.executionRoot)
      );
    const executionRoot = usesLegacyNoWorktreeContext
      ? context.workspaceFolderPath!
      : executionWorkspace.executionRoot;
    const workspaceRoots = usesLegacyNoWorktreeContext
      ? [executionRoot]
      : executionWorkspace.workspaceRoots;
    const namedRoots = usesLegacyNoWorktreeContext
      ? (context.namedWorkspaceRoots ?? this.platform.getNamedWorkspaceRoots())
      : executionWorkspace.namedWorkspaceRoots;
    const definitionPath = mapSourceDefinitionPathToExecution(
      context.sourceDefinitionPath,
      executionWorkspace.sourceCheckoutRoot,
      executionWorkspace.executionCheckoutRoot
    );
    const resolver = new PromptFileResolver({
      workspaceRoot: executionRoot,
      namedRoots,
      trustedRoots: workspaceRoots,
      sourceCheckoutRoot: executionWorkspace.sourceCheckoutRoot,
      approvedExternalRoots: executionWorkspace.approvedExternalRoots,
      allowWorkflowRelativeReferences:
        definitionPath.allowWorkflowRelativeReferences,
    });
    return {
      promptFileResolver: resolver,
      sourceDefinitionPath: definitionPath.executionPath,
    };
  }

  private getParallelGroupStartBoundary(stepIndex: number): number {
    return (
      this.promptQueue
        .getState()
        .parallelGroups.find(
          (group) =>
            stepIndex >= group.startIndex && stepIndex <= group.endIndex
        )?.startIndex ?? stepIndex
    );
  }

  private getMcpToolSkillContext(
    context: WorkflowExecutionContext,
    stepIndex: number,
    workflowFile: WorkflowContext["workflowFile"]
  ): WorkflowContext["mcpToolSkillContext"] {
    if (!context.mcpToolSkillContext) return undefined;
    const parallelGroup = workflowFile?.parallelGroups?.find(
      (group) => stepIndex >= group.startIndex && stepIndex <= group.endIndex
    );
    return {
      ...context.mcpToolSkillContext,
      executionRoot: context.executionWorkspace.executionRoot,
      stepIndex,
      ...(parallelGroup ? { parallelGroupId: parallelGroup.id } : {}),
    };
  }

  clearResponseWaitState(): void {
    this.waitingResponseTargets.clear();
  }

  isAwaitingResponse(): boolean {
    return this.waitingResponseTargets.size > 0;
  }

  private logWorkflowStart(
    context: WorkflowExecutionContext,
    totalSteps: number
  ): void {
    const tag = context.instanceTag ? `${context.instanceTag} ` : "";
    const workflowName = path.basename(
      context.currentPromptFilePath ?? "unknown"
    );
    const nextTarget = this.describeNextExecutionTarget(context);
    Log.info(
      `${tag}Workflow started - ${workflowName}, ${totalSteps} step(s), ${nextTarget}`
    );
  }

  /**
   * Describe the next enabled execution target without creating an integration.
   * A workflow may switch harnesses per step, so its pre-created default
   * integration is not necessarily the harness that will actually run next.
   */
  private describeNextExecutionTarget(
    context: WorkflowExecutionContext
  ): string {
    const state = this.promptQueue.getState();
    const workflowFile = this.promptQueue.getWorkflowFile();
    const nextQueueStep = state.steps
      .slice(state.currentIndex)
      .find(isStepEnabled);
    const nextStep =
      nextQueueStep ??
      (isStepEnabled(workflowFile.finalStep)
        ? workflowFile.finalStep
        : undefined);

    if (!nextStep) {
      return "next target: none";
    }
    if (isScriptStep(nextStep)) {
      return "next target: script";
    }

    let resolvedProperties = PropertyResolver.resolve(nextStep, workflowFile, {
      hostCanProvidePty: context.hostCanProvidePty,
    });
    const vars = workflowFile.vars;
    if (vars && Object.keys(vars).length > 0) {
      resolvedProperties = VarSubstitutor.applyToResolvedProperties(
        resolvedProperties,
        vars
      );
    }
    return `next harness: ${resolvedProperties.harness}`;
  }

  private logWorkflowCompletion(
    context: WorkflowExecutionContext,
    totalSteps: number
  ): void {
    const tag = context.instanceTag ? `${context.instanceTag} ` : "";
    const workflowName = path.basename(
      context.currentPromptFilePath ?? "unknown"
    );
    const completedCount = this.promptQueue.getCompletedCount();
    Log.info(
      `${tag}Workflow complete - ${workflowName}, ${completedCount}/${totalSteps} steps completed`
    );
  }

  private async showDashboard(): Promise<void> {
    try {
      this.platform.focusDashboard?.();
    } catch (error) {
      Log.error("[WorkflowExecutor] Could not focus dashboard panel:", error);
    }
  }

  private async checkExecutionTimeLimit(
    dynamicConfig: DynamicQueueConfig,
    currentIndex: number,
    totalSteps: number
  ): Promise<boolean> {
    const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
    if (isUnlimited(maxTimeSec)) {
      return false;
    }

    const elapsedMs = this.getRuntime().getActiveExecutionTime();
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (elapsedSec >= maxTimeSec) {
      const completedCount = this.promptQueue.getCompletedCount();
      const remainingCount = totalSteps - currentIndex;

      const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalSteps} steps. ${remainingCount} steps remaining in queue.`;

      notifyUserFeedback(this.userFeedbackSink, "warning", message);
      Log.trace(`[WorkflowExecutor] ${message}`);

      this.promptQueue.getRuntimeStateMachine().fail();
      await this.promptQueue.commitRuntimeTransition();
      return true;
    }

    return false;
  }

  private async checkStepLimit(
    workflowMaxSteps: number | undefined,
    totalSteps: number
  ): Promise<boolean> {
    const effectiveMaxSteps = resolveEffectiveMaxSteps(
      workflowMaxSteps,
      ConfigurationUtils.getGlobalMaxSteps()
    );
    if (!exceedsLimit(totalSteps, effectiveMaxSteps)) {
      return false;
    }

    const message = buildStepLimitError(
      totalSteps,
      effectiveMaxSteps,
      getEffectiveMaxStepsSource(workflowMaxSteps)
    );
    notifyUserFeedback(this.userFeedbackSink, "warning", message);
    Log.trace(`[WorkflowExecutor] ${message}`);
    this.promptQueue.getRuntimeStateMachine().fail();
    await this.promptQueue.commitRuntimeTransition();
    return true;
  }

  private updateDashboardForPromptStart(
    context: WorkflowExecutionContext,
    _step: WorkflowStep,
    currentIndex: number,
    resolvedProperties?: ResolvedProperties
  ): void {
    if (!context.dashboardProvider) {
      return;
    }

    context.dashboardProvider.updateStepStatus(
      currentIndex,
      { state: STEP_STATUS.RUNNING },
      {
        harness: resolvedProperties?.harness,
        model: resolvedProperties?.model,
      }
    );
  }

  private async handlePromptSendFailure(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    prompt: PromptStep,
    signedStepIndex: number,
    runIndex: number,
    attemptIndex: number,
    errorRetryCount: number,
    resolvedProperties?: ResolvedProperties
  ): Promise<PromptFailureDisposition> {
    const runtime = this.getRuntime();
    if (context.abortSignal?.aborted && !runtime.stopped) {
      const attempt = runtime.getAttempt(target);
      if (attempt) {
        runtime.cancelAttempt(
          target,
          attempt.attemptIndex,
          "Cancelled by parallel group"
        );
      }
      await context.outputHistoryManager?.recordAttemptTerminal?.(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        runIndex,
        attemptIndex,
        "cancelled",
        context.getDefinitionRevisionContext?.(),
        "Cancelled by parallel group",
        resolvedProperties?.harness
      );
      return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
    }
    if (runtime.stopped) {
      // Workflow was stopped by the user. Flush whatever partial output is available
      // so the history file is not empty and the user can resume from the stopped state.
      const failureOutput = integration.getLastFailureOutput?.();
      const stoppedOutput = this.createFinalCliOutput({
        context,
        integration,
        target,
        signedStepIndex,
        prompt,
        runIndex,
        attemptIndex,
        responseText: failureOutput,
      });
      const statusTimestampMs = Math.max(
        Date.now(),
        (stoppedOutput.timestampMs ?? Date.now()) + 1
      );

      await this.finalizeAndPersistOutput(
        context,
        target,
        signedStepIndex,
        stoppedOutput,
        integration,
        "stopped-by-user output"
      );
      await context.outputHistoryManager?.recordAttemptTerminal?.(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        runIndex,
        attemptIndex,
        "stopped",
        context.getDefinitionRevisionContext?.(),
        undefined,
        resolvedProperties?.harness
      );

      if (stoppedOutput.response) {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          this.promptQueue.cacheRuntimeOutput(target.stepIndex, {
            responseText: stoppedOutput.response,
          });
        } else {
          this.promptQueue.storeFinalStepResponseText(
            target.loopIndex,
            stoppedOutput.response
          );
        }
      }

      await this.trackStatusMessage(
        context,
        target,
        "Stopped by user",
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.cancelStep(target.stepIndex);
      }

      return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
    }

    if (integration.wasLastFailureUserCancellation()) {
      const failureReason = integration.getLastFailureReason();
      runtime.cancelAttempt(target, attemptIndex, failureReason);
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.cancelStep(target.stepIndex);
      }
      await context.outputHistoryManager?.recordAttemptTerminal?.(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        runIndex,
        attemptIndex,
        "cancelled",
        context.getDefinitionRevisionContext?.(),
        failureReason,
        resolvedProperties?.harness
      );
      return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
    }

    const failureKind =
      integration.getLastFailureKind() ??
      (integration.wasLastFailureProcessExit()
        ? FAILURE_KINDS.PROCESS_EXIT
        : integration.wasLastFailureHarnessError()
          ? FAILURE_KINDS.HARNESS_ERROR
          : integration.wasLastFailureTimeout()
            ? FAILURE_KINDS.TIMEOUT
            : undefined);

    if (
      failureKind === FAILURE_KINDS.PROCESS_EXIT ||
      failureKind === FAILURE_KINDS.HARNESS_ERROR ||
      failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED ||
      failureKind === FAILURE_KINDS.TIMEOUT
    ) {
      return this.handleHarnessFailure(
        integration,
        context,
        target,
        prompt,
        signedStepIndex,
        runIndex,
        attemptIndex,
        errorRetryCount,
        failureKind,
        resolvedProperties
      );
    }

    const failureReason = integration.getLastFailureReason();
    const stepLabel =
      signedStepIndex >= 0
        ? `prompt ${signedStepIndex + 1}`
        : formatFinalPassPhrase(Math.abs(signedStepIndex));
    notifyUserFeedback(
      this.userFeedbackSink,
      "error",
      `Failed to execute ${stepLabel}: ${failureReason}`
    );

    // Send FAILED status before markErrored() so the step icon updates
    // before the execution state transitions to ERROR (separate postMessages
    // arrive in the same render cycle this way).
    if (context.dashboardProvider && signedStepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(signedStepIndex, {
        state: STEP_STATUS.FAILED,
        message: failureReason,
      });
    }

    runtime.failAttempt(target, attemptIndex, failureReason);
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      await this.promptQueue.failStep(
        target.stepIndex,
        failureReason,
        failureKind
      );
    }

    // Write a final (non-streaming) error CLI output so the failure is visible
    // in the dashboard and persisted to history. This replaces the initial
    // isStreaming:true output that was set up before sendPrompt was called.
    const errorCliOutput = {
      prompt: prompt.prompt,
      response: "",
      isStreaming: false,
      elapsed: 0,
      tokens: undefined,
      cliCommand: context.shouldShowCliCommand
        ? integration.getLastCliCommand()
        : undefined,
      cliCommandWasInjected: context.shouldShowCliCommand
        ? integration.getLastCliCommandWasInjected()
        : undefined,
      workingDirectory: context.executionWorkspace.executionRoot,
      timestampMs: this.getPromptPhaseStartedAt(target) ?? Date.now(),
      attemptIndex,
      runIndex,
      rawTextOutput: integration.rawTextOutput || undefined,
      errorMessage: failureReason,
    };

    await this.finalizeAndPersistOutput(
      context,
      target,
      signedStepIndex,
      errorCliOutput,
      integration,
      "error output"
    );
    await context.outputHistoryManager?.recordAttemptTerminal?.(
      context.historyFilePath,
      this.toOutputExecutionTarget(target),
      runIndex,
      attemptIndex,
      "failed",
      context.getDefinitionRevisionContext?.(),
      failureReason,
      resolvedProperties?.harness
    );

    return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
  }

  private async handleHarnessFailure(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    prompt: PromptStep,
    signedStepIndex: number,
    runIndex: number,
    attemptIndex: number,
    errorRetryCount: number,
    failureKind:
      | typeof FAILURE_KINDS.PROCESS_EXIT
      | typeof FAILURE_KINDS.HARNESS_ERROR
      | typeof FAILURE_KINDS.HARNESS_NOT_INSTALLED
      | typeof FAILURE_KINDS.TIMEOUT,
    resolvedProperties?: ResolvedProperties
  ): Promise<PromptFailureDisposition> {
    const runtime = this.getRuntime();
    const failureReason = integration.getLastFailureReason();
    const failureOutput = integration.getLastFailureOutput?.();
    const attemptTimestampMs =
      this.getPromptPhaseStartedAt(target) ?? Date.now();
    const statusTimestampMs = Math.max(Date.now(), attemptTimestampMs + 1);
    const errorBehavior = resolvedProperties?.errorBehavior ?? {
      onError: CONDITION_ACTIONS.STOP_WORKFLOW,
    };

    const failureLabel =
      failureKind === FAILURE_KINDS.PROCESS_EXIT
        ? "Process exited unexpectedly"
        : failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED
          ? "Harness CLI is unavailable"
          : failureKind === FAILURE_KINDS.TIMEOUT
            ? "Harness execution timed out"
            : "Harness reported an error";

    if (canRetryErrorBehavior(errorBehavior, errorRetryCount)) {
      const nextAttemptIndex = attemptIndex + 1;
      const retryCount = errorRetryCount + 1;
      const maxRetries =
        errorBehavior.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES;
      const retryLimit = isUnlimited(maxRetries) ? "unlimited" : maxRetries;

      runtime.failAttempt(target, attemptIndex, failureReason);
      runtime.scheduleRetry(target, nextAttemptIndex, retryCount, maxRetries);

      await this.trackStatusMessage(
        context,
        target,
        `${failureLabel}. Retrying attempt ${retryCount}/${retryLimit}. ${failureReason}`,
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

      const retryDelayMs = ConfigurationUtils.secondsToMs(
        errorBehavior.retryDelaySec
      );
      if ((retryDelayMs ?? 0) > 0) {
        await this.delay(retryDelayMs!);
      }

      return {
        outcome: WORKFLOW_EXECUTION_OUTCOMES.RETRY,
        nextErrorRetryCount: retryCount,
      };
    }

    runtime.failAttempt(target, attemptIndex, failureReason);

    const failureOutputRecord = this.createFinalCliOutput({
      context,
      integration,
      target,
      signedStepIndex,
      prompt,
      runIndex,
      attemptIndex,
      responseText: failureOutput,
      errorMessage: failureReason,
      rawTextOutput:
        failureKind === FAILURE_KINDS.PROCESS_EXIT ? true : undefined,
    });

    const persistFailureOutput = async (): Promise<void> => {
      await this.finalizeAndPersistOutput(
        context,
        target,
        signedStepIndex,
        failureOutputRecord,
        integration,
        `${failureKind} output`
      );
      await context.outputHistoryManager?.recordAttemptTerminal?.(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        runIndex,
        attemptIndex,
        "failed",
        context.getDefinitionRevisionContext?.(),
        failureReason,
        resolvedProperties?.harness
      );

      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        context.dashboardProvider &&
        signedStepIndex >= 0
      ) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.FAILED,
          message: failureReason,
        });
      }
    };

    if (errorBehavior.onError === CONDITION_ACTIONS.CONTINUE) {
      await this.trackStatusMessage(
        context,
        target,
        `${failureLabel}. Continuing to the next step. ${failureReason}`,
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

      await persistFailureOutput();

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.failStep(
          target.stepIndex,
          failureReason,
          failureKind
        );
        return { outcome: WORKFLOW_EXECUTION_OUTCOMES.CONTINUE };
      }

      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: target.loopIndex,
        status: STEP_STATUS.FAILED,
        failureKind,
        failureMessage: failureReason,
        startedAt:
          this.promptQueue.getFinalStepRuntime()?.startedAt ??
          attemptTimestampMs,
        completedAt: Date.now(),
      });
      return { outcome: WORKFLOW_EXECUTION_OUTCOMES.CONTINUE };
    }

    await this.trackStatusMessage(
      context,
      target,
      `${failureLabel}. Stopping workflow. ${failureReason}`,
      STATUS_MESSAGE_SEVERITY.ERROR,
      statusTimestampMs
    );

    await persistFailureOutput();

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      await this.promptQueue.failStep(
        target.stepIndex,
        failureReason,
        failureKind
      );
    } else {
      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: target.loopIndex,
        status: STEP_STATUS.FAILED,
        failureKind,
        failureMessage: failureReason,
        startedAt:
          this.promptQueue.getFinalStepRuntime()?.startedAt ??
          attemptTimestampMs,
        completedAt: Date.now(),
      });
    }

    return { outcome: WORKFLOW_EXECUTION_OUTCOMES.STOP };
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async updateDashboardWithResponse(
    context: WorkflowExecutionContext,
    integration: HarnessIntegration,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    prompt: PromptStep,
    responseText: string,
    duration: number,
    runIndex: number,
    attemptIndex: number = 0,
    harnessId?: HarnessId
  ): Promise<void> {
    const parsedOutput = integration.getLastParsedOutput?.();
    let structured: DashboardOutput | undefined;
    if (parsedOutput) {
      structured = CliOutputFormatter.toDashboardFormat(parsedOutput);
    }

    const tokens = this.resolveTokenCounts(parsedOutput);

    const cliCommand = context.shouldShowCliCommand
      ? integration.getLastCliCommand()
      : undefined;
    const cliCommandWasInjected = context.shouldShowCliCommand
      ? integration.getLastCliCommandWasInjected()
      : undefined;

    const cliOutputObj = {
      prompt: prompt.prompt,
      response: responseText,
      structured,
      elapsed: duration,
      tokens,
      isStreaming: false,
      cliCommand,
      cliCommandWasInjected,
      workingDirectory: context.executionWorkspace.executionRoot,
      timestampMs: this.getPromptPhaseStartedAt(target) ?? Date.now(),
      runIndex,
      attemptIndex,
      rawTextOutput: integration.rawTextOutput || undefined,
    };

    await this.finalizeAndPersistOutput(
      context,
      target,
      signedStepIndex,
      cliOutputObj,
      integration,
      "step output"
    );
    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager.recordAttemptTerminal(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        runIndex,
        attemptIndex,
        "completed",
        context.getDefinitionRevisionContext?.(),
        undefined,
        harnessId
      );
    }
  }

  private async finalizeWorkflowExecution(): Promise<void> {
    const finalState = this.getRuntime().status;
    if (finalState === EXECUTION_STATES.RUNNING && this.promptQueue.hasNext()) {
      return;
    }
    const hasExecutableFinalStep = isStepEnabled(
      this.promptQueue.getWorkflowFile().finalStep
    );
    const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
    const finalStepCompleted =
      finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepRuntime.status === STEP_STATUS.COMPLETED;
    // A pause on the last executable step has no continuation boundary, so the
    // run completes. An unexecuted finalStep still keeps a drained queue paused.
    const pausedWithQueueDrained =
      finalState === EXECUTION_STATES.PAUSED &&
      !this.promptQueue.hasNext() &&
      (!hasExecutableFinalStep || finalStepCompleted);
    if (
      pausedWithQueueDrained ||
      (finalState !== EXECUTION_STATES.PAUSED &&
        finalState !== EXECUTION_STATES.STOPPED &&
        finalState !== EXECUTION_STATES.CANCELLING &&
        finalState !== EXECUTION_STATES.ERROR)
    ) {
      this.getRuntime().complete();
      await this.promptQueue.commitRuntimeTransition();
    }
  }

  private async setFinalStepRuntime(
    context: WorkflowExecutionContext,
    runtime: FinalStepRuntimeState
  ): Promise<void> {
    await this.promptQueue.setFinalStepRuntime(runtime);
    context.dashboardProvider?.updateFinalStepStatus(
      runtime.status ?? null,
      runtime.loopCount,
      runtime.phase
    );
  }
}
