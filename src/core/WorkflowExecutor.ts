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
} from "../types/CtrlYokeTypes";
import {
  WorkflowContext,
  type ExecutionWorkspace,
} from "../types/WorkflowContextTypes";
import {
  EXECUTION_MODES,
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
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  EXECUTION_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  FAILURE_KINDS,
  ATTEMPT_COST_UNAVAILABLE_REASONS,
  type ConditionAction,
  type StatusMessageSeverity,
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
import { sanitizeTerminalOutput } from "../utils/TerminalOutputSanitizer";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import {
  findSecretInterpolationsInPrompt,
  buildSecretProcessEnvironment,
  expandSecretInterpolations,
  findMissingSecretNames,
  getProcessMapSecretNames,
  getDeclaredSecretGrants,
  MissingSecretError,
  resolveSecretEnvironment,
} from "../utils/SecretResolver";
import { getEffectiveSecretGrants } from "../utils/SecretReferenceParser";
import { McpServerNormalizer } from "../utils/McpServerNormalizer";
import { PromptFileResolver } from "./PromptFileResolver";
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
import {
  formatVerdictSummary,
  createConditionEvaluationSummary,
  ScriptExecutionReporter,
} from "./orchestration/ScriptExecutionReporter";
import {
  getSignedStepIndex as getSignedWorkflowStepIndex,
  toOutputExecutionTarget as toWorkflowOutputExecutionTarget,
  type StatusMessageReporter,
} from "./orchestration/StatusMessageReporter";

export interface WorkflowExecutionContext {
  /** Immutable state/execution roots for this workflow run. */
  executionWorkspace: ExecutionWorkspace;
  /** Whether this host can provide a PTY for interactive execution. */
  hostCanProvidePty?: boolean;
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
  getIntegrationForPrompt: (
    prompt: PromptStep,
    harnessOverride?: HarnessId
  ) => HarnessIntegration;
  historyFilePath: string;
  workingFilePath?: string;
  instanceTag?: string;
  /** Workflow instance UUID — used as the PTY workflowId so terminal sessions
   *  are keyed by the same ID the webview uses for activeWorkflowId. */
  instanceId?: string;
  onStatusMessage?: (
    stepIndex: number,
    message: string,
    severity: string
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
  captureCompletedOutput?: (stepIndex: number, output: any) => void;
  /** Always-on structured event buffer for queue steps — enables replay on workflow switch. */
  captureEvents?: (stepIndex: number, events: CliEvent[]) => void;
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
  beginSessionActivityTargetCapture?: () => void;
  captureFinalStepChunk?: (loopIndex: number, chunk: string) => void;
  captureFinalStepEvents?: (loopIndex: number, events: CliEvent[]) => void;
  captureFinalStepCompletedOutput?: (loopIndex: number, output: any) => void;
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
    /** Raw script string from the step definition (e.g. ".ctrlyoke/scripts/check.py arg"). */
    script: string;
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

type ExecutionTarget = WorkflowAttemptTarget;

function getExecutionTargetRunKey(target: ExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
}

function isStepEnabled(step: WorkflowStep | undefined | null): boolean {
  return step != null && step.enabled !== false;
}

type PromptFailureDisposition =
  | { outcome: "retry" }
  | { outcome: "continue" }
  | { outcome: "stop" };

type PhaseDisposition = {
  outcome: "retry" | "continue" | "stop";
  nextAttemptIndex?: number;
};

function canRetryErrorBehavior(
  errorBehavior: ErrorBehavior,
  attemptIndex: number
): boolean {
  return (
    errorBehavior.onError === CONDITION_ACTIONS.RETRY &&
    (errorBehavior.maxRetries === -1 ||
      attemptIndex < (errorBehavior.maxRetries ?? 0))
  );
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
  private isWaitingForResponse: boolean = false;
  private readonly scriptExecutionReporter: ScriptExecutionReporter;

  constructor(
    private readonly promptQueue: PromptQueue,
    private readonly endConditionHandler: EndConditionHandler,
    private readonly endConditionEvaluator: EndConditionEvaluator,
    private readonly platform: PlatformAdapter,
    private readonly userFeedbackSink?: UserFeedbackSink
  ) {
    this.scriptExecutionReporter = new ScriptExecutionReporter(
      endConditionEvaluator
    );
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

    this.logWorkflowStart(context, this.promptQueue.getProgress().total);

    const snapshotStrategy = await this.selectSnapshotStrategy(context);

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
          const target: ExecutionTarget = {
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: state.currentIndex,
          };
          const prompt = state.steps[state.currentIndex];

          const shouldContinue = await this.executeWithSnapshot(
            target,
            prompt,
            context,
            snapshotStrategy
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
      const shouldContinue = await this.executeWithSnapshot(
        finalTarget,
        currentFinalStep,
        context,
        snapshotStrategy
      );

      if (!shouldContinue) {
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
        const hitQueueSizeLimit = await this.checkQueueSizeLimit(
          context.dynamicQueueConfig,
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
            "Workflow paused after final step appended queue work"
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

      if (await this.confirmPauseAndStop("Workflow paused after final step")) {
        break;
      }

      break;
    }

    Log.info("Workflow execution complete");
    await this.finalizeWorkflowExecution();
    this.logWorkflowCompletion(context, this.promptQueue.getProgress().total);
  }

  private async executeSinglePrompt(
    target: ExecutionTarget,
    step: WorkflowStep,
    context: WorkflowExecutionContext
  ): Promise<boolean> {
    const state = this.promptQueue.getState();
    const runtime = this.getRuntime();
    const currentStatus = runtime.status;

    if (
      await this.confirmPauseAndStop(
        "Workflow paused before executing next prompt"
      )
    ) {
      return false;
    }
    if (
      currentStatus === EXECUTION_STATES.STOPPED ||
      currentStatus === EXECUTION_STATES.CANCELLING
    ) {
      Log.info("Workflow stopped before executing next prompt");
      return false;
    }

    const progress = this.promptQueue.getProgress();
    const guardIndex =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? target.stepIndex
        : state.currentIndex;
    const shouldStopForTime = await this.checkExecutionTimeLimit(
      context.dynamicQueueConfig,
      guardIndex,
      progress.total
    );
    if (shouldStopForTime) {
      return false;
    }

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
    while (true) {
      runtime.beginAttempt(target, attemptIndex, Date.now());

      // Evaluate pre-condition gate before running the AI prompt.
      const workflowFileForPre = this.promptQueue.getWorkflowFile();
      let preResolvedProperties = PropertyResolver.resolve(
        prompt,
        workflowFileForPre,
        { hostCanProvidePty: context.hostCanProvidePty }
      );
      const preVars = workflowFileForPre.vars;
      if (preVars && Object.keys(preVars).length > 0) {
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
          properties: {
            script: resolvedPreCondition.script,
            env: resolvedPreCondition.env,
            compareSource:
              resolvedPreCondition.compareSource ?? COMPARE_SOURCES.AUTO,
            returns: resolvedPreCondition.returns,
            timeout: resolvedPreCondition.timeout,
          },
          phase: EXECUTION_PHASES.PRE_CONDITION,
          target: this.toOutputExecutionTarget(target),
          signedStepIndex: this.getSignedStepIndex(target),
          runIndex: this.getRunIndexForTarget(context, target),
          attemptIndex,
          timestampMs: Date.now(),
          onPass: resolvedPreCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
          onFail: resolvedPreCondition.onFail ?? CONDITION_ACTIONS.SKIP_PROMPT,
          statusLabel: "Pre-condition",
          timeoutMs: resolvedPreCondition.timeout,
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
            }
          )
        );

        if (preResult.errored) {
          const preDisposition = await this.handleEvaluationError(
            context,
            target,
            this.getSignedStepIndex(target),
            "Pre-condition",
            preResult,
            preErrorBehavior,
            attemptIndex
          );
          if (preDisposition.outcome === CONDITION_ACTIONS.RETRY) {
            attemptIndex = preDisposition.nextAttemptIndex ?? attemptIndex + 1;
            continue;
          }
          if (preDisposition.outcome === "stop") {
            return false;
          }
        } else {
          const preAction: PreConditionAction = preResult.passed
            ? (resolvedPreCondition.onPass ?? CONDITION_ACTIONS.CONTINUE)
            : (resolvedPreCondition.onFail ?? CONDITION_ACTIONS.SKIP_PROMPT);

          Log.info(
            `Pre-condition ${preResult.passed ? "passed" : "failed"} → action: ${preAction}`
          );

          await this.trackConditionResult(
            context,
            target,
            "Pre-condition",
            preReport.verdict,
            STATUS_MESSAGE_SEVERITY.WARNING
          );

          if (preAction === CONDITION_ACTIONS.SKIP_PROMPT) {
            runtime.completeAttempt(target, attemptIndex);
            return this.handleSkippedStep(step, target, context);
          }
          if (preAction === CONDITION_ACTIONS.STOP_WORKFLOW) {
            Log.info("Pre-condition stopWorkflow triggered");
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
      let resolvedProperties = PropertyResolver.resolve(prompt, workflowFile, {
        hostCanProvidePty: context.hostCanProvidePty,
      });

      // Apply {{var}} substitution when the workflow has vars defined.
      const vars = workflowFile.vars;
      if (vars && Object.keys(vars).length > 0) {
        resolvedProperties = VarSubstitutor.applyToResolvedProperties(
          resolvedProperties,
          vars
        );
      }

      // Substitute first, then resolve a standalone prompt-file reference into
      // a local copy. The queue and working file retain the authored path so
      // edits to the target file are visible on the next run.
      const effectivePromptText = await this.resolveEffectivePrompt(
        prompt.prompt,
        context,
        vars
      );
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
        target
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
        resolvedProperties.harness
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
        Log.info(`Executing prompt ${target.stepIndex + 1}/${progress.total}`);
      } else {
        Log.info(`Executing finalStep loop ${target.loopIndex + 1}`);
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
          allPrompts: state.steps,
          filePath: context.currentPromptFilePath,
          workflowName: this.promptQueue.getState().workflowName,
          instanceId: context.instanceId,
          workingFilePath: context.workingFilePath,
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
          secretEnvironment: resolvedSecretValues,
          finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
            | string
            | undefined,
        },
        async () => {
          if (target.kind === FINAL_STEP_PHASES.QUEUE) {
            await this.promptQueue.markCurrentAsSent();
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
          resolvedProperties
        );

        if (failureDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex++;
          continue;
        }

        return failureDisposition.outcome === "continue";
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
          vars && Object.keys(vars).length > 0 ? vars : undefined,
          resolvedProperties.errorBehavior,
          resolvedProperties.secrets
        );

        if (endDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex = endDisposition.nextAttemptIndex ?? attemptIndex + 1;
          continue;
        }

        if (endDisposition.outcome === "stop") {
          Log.info("Workflow stopped due to end condition failure");
          if (
            runtime.status === EXECUTION_STATES.RUNNING ||
            runtime.status === EXECUTION_STATES.PAUSING ||
            runtime.status === EXECUTION_STATES.PAUSED
          ) {
            this.promptQueue.finalizeFailedInFlightPrompt();
            runtime.fail();
            await this.promptQueue.commitRuntimeTransition();
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

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        await this.promptQueue.completeCurrentAndMoveNext();

        if (context.dashboardProvider) {
          const live = this.promptQueue.getProgress();
          context.dashboardProvider.updateProgress(live.current, live.total);
        }

        if (await this.confirmPauseAndStop("Workflow paused")) {
          return false;
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
        : step.type === "script"
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
      await this.promptQueue.skipCurrentAndMoveNext();
      if (context.dashboardProvider) {
        const live = this.promptQueue.getProgress();
        context.dashboardProvider.updateProgress(live.current, live.total);
      }
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
    Log.info(`Executing script step: ${stepLabel}`);

    // Mark step as running in the dashboard
    if (context.dashboardProvider && stepIndex >= 0) {
      context.dashboardProvider.updateStepStatus(stepIndex, {
        state: STEP_STATUS.RUNNING,
      });
    }

    // Record startedAt on the step's _runtime
    await this.promptQueue.persistRuntimeMetadata(
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? stepIndex
        : this.promptQueue.getState().steps.length,
      { startedAt: Date.now(), secrets: secretNames }
    );

    // Begin each whole-step attempt before the script executes. An evaluator
    // retry therefore re-runs the complete script step with the same budget.
    let attemptIndex = 0;
    while (true) {
      runtime.beginAttempt(target, attemptIndex, Date.now());

      const timeout =
        step.timeout != null
          ? step.timeout * 1000
          : ConfigurationUtils.getScriptTimeoutMs();

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
      const resolvedProperties = {
        script: effectiveStep.script,
        env: effectiveStep.env,
        compareSource: step.compareSource ?? COMPARE_SOURCES.EXIT_CODE,
        returns: step.returns ?? "0",
        timeout,
      };
      const outputChunks: string[] = [];
      let ptyExitCode: number | undefined;
      let ptyTimedOut = false;

      const evaluation = async (onOutput: (chunk: string) => void) => {
        if (isInteractive && context.spawnScriptPty) {
          Log.info(`[script:interactive] spawning PTY for: ${stepLabel}`);
          ptyExitCode = await context.spawnScriptPty({
            stepName: stepLabel,
            stepIndex: signedStepIndex,
            script: effectiveStep.script,
            cwd: context.executionWorkspace.executionRoot,
            env: await this.resolveScriptEnvironment(
              effectiveStep.env,
              secretNames,
              context
            ),
            onOutput: (chunk) => {
              outputChunks.push(sanitizeTerminalOutput(chunk));
              onOutput(chunk);
            },
            timeout,
            onTimeout: () => {
              ptyTimedOut = true;
            },
          });
        }

        if (!isInteractive || ptyExitCode === undefined) {
          return this.endConditionEvaluator.evaluateCondition(
            resolvedProperties,
            context.executionWorkspace.executionRoot,
            this.promptQueue.getWorkflowFile().vars,
            onOutput,
            secretNames
          );
        }

        const exitCode = ptyExitCode ?? 1;
        const stdout = sanitizeTerminalOutput(outputChunks.join(""));
        const comparison = this.endConditionEvaluator.evaluateResult(
          {
            result: stdout,
            stdout,
            stderr: "",
            success: exitCode === 0,
            exitCode,
          },
          resolvedProperties.returns,
          resolvedProperties.compareSource
        );
        return {
          ...comparison,
          errored: ptyTimedOut,
          matchRule: ptyTimedOut ? "none" : comparison.matchRule,
          stdout,
          stderr: "",
          result: "",
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
        timestampMs,
        onPass: step.onPass ?? CONDITION_ACTIONS.CONTINUE,
        onFail: step.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
        statusLabel: "Script step",
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
          "Script step",
          evalResult,
          errorBehavior,
          attemptIndex,
          false
        );
        if (errorDisposition.outcome === CONDITION_ACTIONS.RETRY) {
          attemptIndex = errorDisposition.nextAttemptIndex ?? attemptIndex + 1;
          continue;
        }
        if (errorDisposition.outcome === "stop") {
          return false;
        }
      } else {
        await this.trackConditionResult(
          context,
          target,
          "Script step",
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

      if (!succeeded && onFail === CONDITION_ACTIONS.STOP_WORKFLOW) {
        Log.error(
          `Script step failed (exit code ${evalResult.exitCode}): ${stepLabel}`
        );
      } else if (succeeded && onPass === CONDITION_ACTIONS.STOP_WORKFLOW) {
        Log.info(
          `Script step passed but onPass=stopWorkflow, stopping: ${stepLabel}`
        );
      } else if (!succeeded) {
        Log.warn(
          `Script step failed but onFail=continue, continuing: ${stepLabel}`
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
      if (context.historyFilePath && context.outputHistoryManager) {
        await context.outputHistoryManager.recordAttemptTerminal(
          context.historyFilePath,
          this.toOutputExecutionTarget(target),
          runIndex,
          attemptIndex,
          shouldContinue ? "completed" : "failed",
          context.getDefinitionRevisionContext?.(),
          shouldContinue
            ? undefined
            : `Script exited with code ${evalResult.exitCode}`
        );
      }

      // Update dashboard step status
      if (context.dashboardProvider && stepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(stepIndex, {
          state: terminalStatus,
          duration: evalResult.duration / 1000,
        });
      }

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        if (shouldContinue) {
          await this.promptQueue.completeCurrentAndMoveNext();
          if (context.dashboardProvider) {
            const live = this.promptQueue.getProgress();
            context.dashboardProvider.updateProgress(live.current, live.total);
          }
        } else {
          this.promptQueue.finalizeFailedInFlightPrompt(
            `Script exited with code ${evalResult.exitCode}`
          );
          runtime.fail();
          await this.promptQueue.commitRuntimeTransition();
        }

        if (
          await this.confirmPauseAndStop("Workflow paused after script step")
        ) {
          return false;
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
    context: WorkflowExecutionContext
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
    };

    snapshot = await context.snapshotService.enrichSnapshotBeforeContent(
      snapshot,
      executionRoot
    );

    context.onSnapshotCaptured?.(target, snapshot);

    if (context.historyFilePath && context.outputHistoryManager) {
      await context.outputHistoryManager.saveSnapshotForTarget(
        context.historyFilePath,
        this.toOutputExecutionTarget(target),
        snapshot
      );
    }
  }

  private toOutputExecutionTarget(
    target: ExecutionTarget
  ): OutputExecutionTarget {
    return toWorkflowOutputExecutionTarget(target);
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
    snapshotStrategy: "git" | "filesystem" | undefined
  ): Promise<boolean> {
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

    const shouldContinue = await this.executeSinglePrompt(
      target,
      step,
      context
    );

    if (beforeState && context.snapshotService && snapshotStrategy) {
      try {
        await this.captureAndEmitSnapshot(
          target,
          beforeState,
          snapshotStrategy,
          context
        );
      } catch (e) {
        Log.warn("Failed to capture workspace snapshot:", e);
      }
    }

    return shouldContinue;
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
    output: CliOutput
  ): void {
    this.dispatchDashboardOutput(context, target, signedStepIndex, output);
    if (signedStepIndex !== undefined && signedStepIndex >= 0) {
      context.captureCompletedOutput?.(signedStepIndex, output);
    } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      context.captureFinalStepCompletedOutput?.(target.loopIndex, output);
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
        Log.warn(`Failed to save ${logContext} to history:`, err)
      );
  }

  /** Dispatches a completed CliOutput to the dashboard/capture buffer and persists it to history. */
  private async finalizeAndPersistOutput(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number | undefined,
    output: CliOutput,
    logContext: string
  ): Promise<void> {
    this.dispatchCompletedOutput(context, target, signedStepIndex, output);
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
  private resolveTokenCounts(
    parsedOutput: ReturnType<HarnessIntegration["getLastParsedOutput"]>
  ): CliOutput["tokens"] {
    if (parsedOutput?.metadata.usage) {
      const u = parsedOutput.metadata.usage;
      const compactionSummary = summarizeCompactionEvents(parsedOutput.events);
      const costResult = parsedOutput.metadata.harness
        ? calculateAttemptCost({
            harnessId: parsedOutput.metadata.harness,
            modelId: parsedOutput.metadata.model,
            pricingOverride: parsedOutput.metadata.model
              ? ConfigurationUtils.getModelPricingOverride(
                  parsedOutput.metadata.harness,
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
      return {
        prompt: u.inputTokens,
        completion: u.outputTokens,
        cached: u.cachedInputTokens,
        cacheCreated: u.cacheCreatedTokens,
        reasoning: u.reasoningOutputTokens,
        total: u.totalTokens,
        contextWindowUsed: u.contextWindowUsedTokens,
        contextWindowSize: u.contextWindowSize,
        ...compactionSummary,
        totalConfidence: u.totalConfidence,
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
    return buildSecretProcessEnvironment(
      processEnv,
      resolvedSecrets,
      secretNames
    );
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
   * mirroring `execution.strictContextResolution`'s "warn" contract for every
   * other declared-reference category, instead of hard-stopping the run the
   * way this used to unconditionally. `"fail"` mode keeps today's hard stop
   * so `secret check`'s guarantee still has a live-run counterpart. A name
   * left unresolved here still throws downstream if something actually tries
   * to interpolate it (e.g. `expandSecretInterpolations`), so a step that
   * genuinely needs the credential still fails — just at the point of use,
   * not at preflight.
   */
  private async resolveGrantedSecretValues(
    names: readonly string[],
    context: WorkflowExecutionContext,
    target: ExecutionTarget
  ): Promise<Record<string, string>> {
    if (names.length === 0) {
      return {};
    }
    const resolutionContext = {
      workspaceRoot: this.platform.getWorkspaceRoot(),
      secretStore: this.platform.getSecretStore?.(),
    };
    const missing = await findMissingSecretNames(names, resolutionContext);
    if (missing.length > 0) {
      if (
        ConfigurationUtils.getContextResolutionFailureMode() ===
        CONTEXT_RESOLUTION_FAILURE_MODES.FAIL
      ) {
        throw new MissingSecretError(missing[0], missing);
      }
      await this.trackStatusMessage(
        context,
        target,
        `Context resolution warning: declared secret${
          missing.length > 1 ? "s are" : " is"
        } not available: ${missing.join(", ")}.`,
        STATUS_MESSAGE_SEVERITY.WARNING
      );
    }
    const resolvable = names.filter((name) => !missing.includes(name));
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
      verdict.outcome === "passed"
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
      case "continue":
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
    completeAttemptOnContinue: boolean = false
  ): Promise<PhaseDisposition> {
    const policy = errorBehavior ?? { onError: "stop" as const };
    const maxRetries = policy.maxRetries ?? 0;
    const canRetry = canRetryErrorBehavior(policy, attemptIndex);
    const actionText = canRetry
      ? `retry ${attemptIndex + 1} of ${maxRetries === -1 ? "unlimited" : maxRetries}`
      : policy.onError === "continue"
        ? "continue"
        : "stop";
    const severity =
      canRetry || policy.onError === "continue"
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
      runtime.scheduleRetry(
        target,
        nextAttemptIndex,
        nextAttemptIndex,
        maxRetries
      );
      if ((policy.retryDelayMs ?? 0) > 0) {
        await this.delay(policy.retryDelayMs!);
      }
      return { outcome: "retry", nextAttemptIndex };
    }

    if (policy.onError === "continue") {
      if (completeAttemptOnContinue) {
        this.getRuntime().completeAttempt(target, attemptIndex);
      }
      return { outcome: "continue" };
    }

    await this.failStepForInternalError(
      context,
      target,
      signedStepIndex,
      attemptIndex,
      `${phase}: ${reason}`
    );
    return { outcome: "stop" };
  }

  private async failStepForInternalError(
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    signedStepIndex: number,
    attemptIndex: number,
    reason: string
  ): Promise<void> {
    const runtime = this.getRuntime();
    runtime.failAttempt(target, attemptIndex, reason);

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      if (context.dashboardProvider && signedStepIndex >= 0) {
        context.dashboardProvider.updateStepStatus(signedStepIndex, {
          state: STEP_STATUS.FAILED,
          message: reason,
        });
      }
      this.promptQueue.finalizeFailedInFlightPrompt(reason);
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

    runtime.fail();
    await this.promptQueue.commitRuntimeTransition();
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
    vars?: Record<string, string>,
    errorBehavior?: ErrorBehavior,
    secretNames: readonly string[] = []
  ): Promise<PhaseDisposition> {
    Log.trace(
      `Evaluating end condition for ${this.describeExecutionTarget(target)}...`
    );

    if (!prompt.endCondition?.script) {
      Log.error(
        `End condition for ${this.describeExecutionTarget(target)} is missing required 'script' property`
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
            expected: prompt.endCondition?.returns,
            compareSource: prompt.endCondition?.compareSource,
          }
        )
      );
      return this.handleEvaluationError(
        context,
        target,
        signedStepIndex ?? this.getSignedStepIndex(target),
        "End condition",
        missingScriptResult,
        errorBehavior,
        attemptIndex,
        true
      );
    }

    const endCondition = prompt.endCondition;
    const endConditionActionDetail = (result: {
      passed: boolean;
    }): string | undefined => {
      if (result.passed && endCondition.onPass !== CONDITION_ACTIONS.RETRY) {
        return undefined;
      }

      return `retry ${this.promptQueue.getCurrentRetryCount()} of ${this.promptQueue.getEffectiveMaxRetries(prompt)}`;
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
      properties: {
        script: endCondition.script,
        env: endCondition.env,
        compareSource: endCondition.compareSource ?? COMPARE_SOURCES.AUTO,
        returns: endCondition.returns,
        timeout: endCondition.timeout,
      },
      phase: EXECUTION_PHASES.END_CONDITION,
      target: this.toOutputExecutionTarget(target),
      signedStepIndex: signedStepIndex ?? this.getSignedStepIndex(target),
      runIndex,
      attemptIndex,
      timestampMs: Date.now(),
      onPass: endCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
      onFail: endCondition.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
      actionForErrored: this.getErrorConditionAction(errorBehavior),
      statusLabel: "End condition",
      timeoutMs: endCondition.timeout,
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
            expected: endCondition.returns,
            compareSource: endCondition.compareSource,
          }
        )
      );
      return this.handleEvaluationError(
        context,
        target,
        signedStepIndex ?? this.getSignedStepIndex(target),
        "End condition",
        evaluationResult,
        errorBehavior,
        attemptIndex,
        true
      );
    }

    await this.trackConditionResult(
      context,
      target,
      "End condition",
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
          properties: {
            script: condition.script,
            env: condition.env,
            compareSource: condition.compareSource ?? COMPARE_SOURCES.AUTO,
            returns: condition.returns,
            timeout: condition.timeout,
          },
          phase: EXECUTION_PHASES.END_CONDITION,
          target: this.toOutputExecutionTarget(target),
          signedStepIndex: signedStepIndex ?? this.getSignedStepIndex(target),
          runIndex,
          attemptIndex: retryAttemptIndex,
          timestampMs: Date.now(),
          onPass: endCondition.onPass ?? CONDITION_ACTIONS.CONTINUE,
          onFail: endCondition.onFail ?? CONDITION_ACTIONS.STOP_WORKFLOW,
          actionForErrored: this.getErrorConditionAction(errorBehavior),
          statusLabel: "End condition",
          timeoutMs: condition.timeout,
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
            "End condition",
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
      runIndex
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
        "End condition",
        result.errorResult,
        errorBehavior,
        result.errorAttemptIndex ?? attemptIndex,
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

    return { outcome: result.shouldContinue ? "continue" : "stop" };
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
    integration: HarnessIntegration
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let responseHandled = false;

      const disposable = integration.onResponseComplete(
        (responseText: string) => {
          if (responseHandled) {
            return;
          }
          responseHandled = true;
          disposable.dispose();

          this.isWaitingForResponse = false;
          resolve(responseText);
        }
      );
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
   *   happen in that specific window (e.g. `markCurrentAsSent`,
   *   `isWaitingForResponse = true`).
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
    attemptStartReason: "initial" | "retry" | "resumed" = "initial",
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
      integration
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
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureChunk?.(signedStepIndex, chunk);
        context.dashboardProvider?.updateCliStreamingChunk(
          signedStepIndex,
          chunk
        );
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepChunk?.(target.loopIndex, chunk);
        context.dashboardProvider?.updateFinalStepStreamingChunk(
          target.loopIndex,
          chunk
        );
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
      if (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        signedStepIndex !== undefined
      ) {
        context.captureEvents?.(signedStepIndex, events);
        context.dashboardProvider?.updateCliStreamingEvents(
          signedStepIndex,
          events,
          attemptIndex,
          runIndex
        );
      } else if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        context.captureFinalStepEvents?.(target.loopIndex, events);
        context.dashboardProvider?.updateFinalStepStreamingEvents(
          target.loopIndex,
          events,
          attemptIndex,
          runIndex
        );
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

    this.isWaitingForResponse = true;
    context.beginSessionActivityTargetCapture?.();
    const success = await integration.sendPrompt(promptStep, true, {
      ...sendOptions,
      promptStartedAt: initTimestampMs,
    });
    if (!success) {
      this.isWaitingForResponse = false;
      disposeListeners();
      return null;
    }

    if (onPromptSent) {
      await onPromptSent();
    }

    const responseText = await responsePromise;
    disposeListeners();

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
    runIndex: number
  ): SendRetryPromptCallback {
    return async (
      retryPromptStep: PromptStep,
      currentIndex: number,
      retryAttemptIndex: number
    ): Promise<string | null> => {
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
        target
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

      const result = await this.executeWithStreaming(
        effectiveRetryPrompt,
        integration,
        context,
        target,
        target.kind === FINAL_STEP_PHASES.QUEUE ? signedStepIndex : undefined,
        runIndex,
        retryAttemptIndex,
        {
          promptIndex: currentIndex,
          allPrompts: state.steps,
          filePath: context.currentPromptFilePath,
          workflowName: this.promptQueue.getState().workflowName,
          instanceId: context.instanceId,
          workingFilePath: context.workingFilePath,
          resolvedProperties: { ...resolvedProperties, resumeSession: true },
          workflowFile,
          workingFilePersistence: this.promptQueue,
          preConditionResult: this.promptQueue.getPreConditionSummary(target),
          endConditionResult: this.promptQueue.getEndConditionSummary(target),
          reportCompatibilityDiagnostics:
            context.reportCompatibilityDiagnostics,
          analyzeCompatibilityForPrompt: context.analyzeCompatibilityForPrompt,
          resolvePriorContextItems: context.resolvePriorContextItems,
          secretEnvironment: retrySecretValues,
          finalStepSessionId: workflowFile.finalStep?._runtime?.sessionId as
            | string
            | undefined,
        },
        undefined,
        "retry"
      );

      if (!result) {
        await this.handlePromptSendFailure(
          integration,
          context,
          target,
          effectiveRetryPrompt,
          signedStepIndex ?? this.getSignedStepIndex(target),
          runIndex,
          retryAttemptIndex,
          resolvedProperties
        );
        return null;
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
        retryAttemptIndex,
        resolvedProperties.harness
      );

      return result.responseText;
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
    const substituted = VarSubstitutor.applyToPromptText(
      promptText,
      variables ?? {}
    );
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
    return resolver.resolvePromptValue(
      substituted,
      definitionPath.executionPath
    );
  }

  clearResponseWaitState(): void {
    this.isWaitingForResponse = false;
  }

  isAwaitingResponse(): boolean {
    return this.isWaitingForResponse;
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
      Log.error("Could not focus dashboard panel:", error);
    }
  }

  private async checkExecutionTimeLimit(
    dynamicConfig: DynamicQueueConfig,
    currentIndex: number,
    totalSteps: number
  ): Promise<boolean> {
    const maxTimeSec = dynamicConfig.maxWorkflowExecutionTime;
    const unlimitedWorkflow = dynamicConfig.unlimitedMode || maxTimeSec === -1;

    if (unlimitedWorkflow) {
      return false;
    }

    const elapsedMs = this.getRuntime().getActiveExecutionTime();
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (elapsedSec >= maxTimeSec) {
      const completedCount = this.promptQueue.getCompletedCount();
      const remainingCount = totalSteps - currentIndex;

      const message = `Workflow stopped - Maximum execution time reached (${elapsedSec}s / ${maxTimeSec}s).\nCompleted ${completedCount} of ${totalSteps} steps. ${remainingCount} steps remaining in queue.`;

      notifyUserFeedback(this.userFeedbackSink, "warning", message);
      Log.trace(`⏱️ ${message}`);

      this.promptQueue.getRuntimeStateMachine().fail();
      await this.promptQueue.commitRuntimeTransition();
      return true;
    }

    return false;
  }

  private async checkQueueSizeLimit(
    dynamicConfig: DynamicQueueConfig,
    totalSteps: number
  ): Promise<boolean> {
    if (dynamicConfig.unlimitedMode || dynamicConfig.maxQueueSize <= 0) {
      return false;
    }

    if (totalSteps <= dynamicConfig.maxQueueSize) {
      return false;
    }

    const message = `Workflow stopped - Maximum queue size reached (${totalSteps}/${dynamicConfig.maxQueueSize}).`;
    notifyUserFeedback(this.userFeedbackSink, "warning", message);
    Log.trace(`📏 ${message}`);
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
    resolvedProperties?: ResolvedProperties
  ): Promise<PromptFailureDisposition> {
    const runtime = this.getRuntime();
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

      // The send attempt has already returned, so the process is done -
      // finalize CANCELLING -> STOPPED now rather than waiting for the
      // onResponseComplete listener registered by the stop request.
      if (runtime.confirmStopped()) {
        this.promptQueue.finalizeCancelledPromptAfterStop();
        await this.promptQueue.commitRuntimeTransition();
      }

      return { outcome: "stop" };
    }

    if (integration.wasLastFailureUserCancellation()) {
      const failureReason = integration.getLastFailureReason();
      runtime.cancelAttempt(target, attemptIndex, failureReason);
      this.promptQueue.markInFlightPromptCancelled();
      if (runtime.requestStop()) {
        await this.promptQueue.commitRuntimeTransition({ persist: false });
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
      return { outcome: "stop" };
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
        failureKind,
        resolvedProperties
      );
    }

    const failureReason = integration.getLastFailureReason();
    const stepLabel =
      signedStepIndex >= 0
        ? `prompt ${signedStepIndex + 1}`
        : `finalStep loop ${Math.abs(signedStepIndex)}`;
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
    this.promptQueue.finalizeFailedInFlightPrompt(failureReason);
    runtime.fail();
    await this.promptQueue.commitRuntimeTransition();

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

    return { outcome: "stop" };
  }

  private async handleHarnessFailure(
    integration: HarnessIntegration,
    context: WorkflowExecutionContext,
    target: ExecutionTarget,
    prompt: PromptStep,
    signedStepIndex: number,
    runIndex: number,
    attemptIndex: number,
    failureKind:
      | typeof FAILURE_KINDS.PROCESS_EXIT
      | typeof FAILURE_KINDS.HARNESS_ERROR
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
      onError: "stop" as const,
    };

    const failureLabel =
      failureKind === FAILURE_KINDS.PROCESS_EXIT
        ? "Process exited unexpectedly"
        : failureKind === FAILURE_KINDS.TIMEOUT
          ? "Harness execution timed out"
          : "Harness reported an error";

    if (canRetryErrorBehavior(errorBehavior, attemptIndex)) {
      const nextAttemptIndex = attemptIndex + 1;
      const retryCount = nextAttemptIndex;
      const maxRetries = errorBehavior.maxRetries ?? 0;
      const retryLimit = maxRetries === -1 ? "unlimited" : maxRetries;

      runtime.failAttempt(target, attemptIndex, failureReason);
      runtime.scheduleRetry(target, nextAttemptIndex, retryCount, maxRetries);

      await this.trackStatusMessage(
        context,
        target,
        `${failureLabel}. Retrying attempt ${retryCount}/${retryLimit}. ${failureReason}`,
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

      if ((errorBehavior.retryDelayMs ?? 0) > 0) {
        await this.delay(errorBehavior.retryDelayMs!);
      }

      return { outcome: "retry" };
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

    if (errorBehavior.onError === "continue") {
      await this.trackStatusMessage(
        context,
        target,
        `${failureLabel}. Continuing to the next step. ${failureReason}`,
        STATUS_MESSAGE_SEVERITY.WARNING,
        statusTimestampMs
      );

      await persistFailureOutput();

      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.promptQueue.finalizeFailedInFlightPrompt(failureReason);
        await this.promptQueue.commitRuntimeTransition();
        if (context.dashboardProvider) {
          const live = this.promptQueue.getProgress();
          context.dashboardProvider.updateProgress(live.current, live.total);
        }
        return { outcome: "continue" };
      }

      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: target.loopIndex,
        status: STEP_STATUS.FAILED,
        startedAt:
          this.promptQueue.getFinalStepRuntime()?.startedAt ??
          attemptTimestampMs,
        completedAt: Date.now(),
      });
      return { outcome: "continue" };
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
      this.promptQueue.finalizeFailedInFlightPrompt(failureReason);
    } else {
      await this.setFinalStepRuntime(context, {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: target.loopIndex,
        status: STEP_STATUS.FAILED,
        startedAt:
          this.promptQueue.getFinalStepRuntime()?.startedAt ??
          attemptTimestampMs,
        completedAt: Date.now(),
      });
    }

    runtime.fail();
    await this.promptQueue.commitRuntimeTransition();
    return { outcome: "stop" };
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
