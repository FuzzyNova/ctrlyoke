import * as path from "path";
import { TypedEmitter } from "../utils/TypedEmitter";
import { isDeepStrictEqual } from "util";
import { isUnlimited } from "../utils/LimitUtils";
import {
  PromptStep,
  PromptFile,
  FinalStepRuntimeState,
  QueueState,
  WorkflowRuntimeState,
  PromptResult,
  ConditionEvaluationSummary,
  WorkflowAttemptTarget,
  StepExecutionOutcome,
  EXECUTION_STATES,
  WorkflowStep,
  ScriptRuntimeOutput,
  isScriptStep,
  PromptRuntimeMetadata,
  ActiveParallelGroupRuntime,
  ParallelGroupDefinition,
  WorkflowTokenTotals,
  type WorkingFileWorktreeRuntimePatch,
  type RunRef,
  type WorkflowLineageCreationOptions,
} from "../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  PARALLEL_GROUP_ADMISSION,
  STEP_CLAIM_OUTCOMES,
  CONDITION_ACTIONS,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
  type ParallelGroupAdmission,
  type PromptTerminalStatus,
  STEP_STATUS,
} from "../types/DashboardConstants";

/**
 * Internal state shape: the queue's own topology fields only.
 * Runtime execution fields (status, stopped, startTime, pausedTime, totalPausedDuration)
 * are owned by WorkflowStateMachine and projected onto QueueState by getState().
 */
type InternalQueueState = Omit<QueueState, keyof WorkflowRuntimeState>;
import type { WorkingFile } from "../types/CtrlYokeTypes";
import type { WorkflowWorkingFilePersistence } from "../types/WorkflowContextTypes";
import {
  QUEUE_POSITION,
  resolveQueueInsertIndex,
  type QueuePosition,
} from "../types/DashboardConstants";
import {
  PARALLEL_GROUP_INSERT_POSITIONS,
  appendParallelGroupMember,
  deleteParallelGroupStep,
  insertParallelGroupTopology,
  insertParallelGroupSteps,
  normalizeParallelGroupTopology,
  reorderParallelGroupPendingSteps,
  type ParallelGroupTopology,
  type PendingParallelGroupRange,
  promoteStepToParallelGroup,
  replaceParallelGroupStep,
  resolveParallelGroupInsertIndex,
  snapParallelGroupStartPosition,
} from "./ParallelGroupTopology";
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

export interface SequentialStepSettlement {
  readonly promotedGroup?: ParallelGroupDefinition;
}

export interface ParallelGroupReconcileResult {
  readonly joined: boolean;
  readonly group?: ParallelGroupDefinition;
}
import { PropertyResolver } from "../utils/PropertyResolver";
import { reportPromptCompleted } from "../utils/TelemetryEvents";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { WorkingFileManager } from "./WorkingFileManager";
import type { IWorkingFileQueueAccess } from "./WorkingFileManager";
import { WorkflowStateMachine } from "./WorkflowStateMachine";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import {
  RunContinuationService,
  type RunStepClaimResult,
} from "./orchestration/RunContinuationService";
import {
  assertStartedStepPositionsPreserved,
  assertStepMutable,
  ensureStepIds,
  findStepIndexById,
  resetStepRuntimeForRewind,
} from "./StepIdentity";
import { hasStarted } from "../utils/StepStatusDerivation";
import { appendResponseText } from "../utils/ResponseTextJoin";

/** Resolver-derived, in-memory execution cache restored for an active run. */
export interface ResolvedRuntimeOutputCacheEntry {
  stepIndex: number;
  responseText?: string;
  scriptOutput?: ScriptRuntimeOutput;
}

/** Effective retry settings resolved from an end condition, including smart defaults. */
interface RetrySettings {
  maxRetries: number;
  retryPrompt: string | undefined;
  passRetryPrompt: string | undefined;
}

/**
 * Resolve effective maxRetries/retryPrompt from an end condition, applying
 * smart defaults when only one of the two is specified.
 */
function resolveRetrySettings(
  endCondition?: PromptStep["endCondition"]
): RetrySettings {
  if (!endCondition) {
    return {
      maxRetries: 0,
      retryPrompt: undefined,
      passRetryPrompt: undefined,
    };
  }

  const hasRetryPrompt = !!endCondition.retryPrompt;
  const hasMaxRetries = endCondition.maxRetries !== undefined;
  const hasNonZeroMaxRetries = hasMaxRetries && endCondition.maxRetries !== 0;
  const hasRetryAction =
    endCondition.onFail === CONDITION_ACTIONS.RETRY ||
    endCondition.onPass === CONDITION_ACTIONS.RETRY;

  const maxRetries = hasMaxRetries
    ? endCondition.maxRetries!
    : hasRetryAction
      ? DEFAULT_ERROR_BEHAVIOR_RETRIES
      : hasRetryPrompt
        ? ConfigurationUtils.getDefaultMaxRetries()
        : 0;

  const retryPrompt = hasRetryPrompt
    ? endCondition.retryPrompt
    : hasNonZeroMaxRetries
      ? ConfigurationUtils.getDefaultRetryPrompt() || undefined
      : undefined;

  const passRetryPrompt =
    (endCondition.passRetryPrompt ??
      ConfigurationUtils.getDefaultPassRetryPrompt()) ||
    undefined;

  return { maxRetries, retryPrompt, passRetryPrompt };
}

export class PromptQueue implements WorkflowWorkingFilePersistence {
  private state: InternalQueueState;
  private workflowFile?: PromptFile; // Store complete workflow file with workflow-level properties
  private workingFileWorkspaceRoot?: string;
  private finalStepRuntime?: FinalStepRuntimeState;
  private onStateChanged = new TypedEmitter<QueueState>();
  private readonly workingFileManager: WorkingFileManager;
  private readonly stateMachine: WorkflowStateMachine;
  private readonly runtimeArchive = new Map<string, PromptRuntimeMetadata>();
  private activeParallelGroupRuntime?: ActiveParallelGroupRuntime;
  private readonly onDiskStepsMergedEmitter = new TypedEmitter<
    readonly WorkflowStep[]
  >();
  /**
   * Resolver-derived active-execution output cache. These values deliberately
   * never live on WorkflowStep._runtime or in workflow.ctrlyoke.json.
   */
  private readonly runtimeOutputCache = new Map<
    number,
    Omit<ResolvedRuntimeOutputCacheEntry, "stepIndex">
  >();
  private readonly finalStepResponseCache = new Map<number, string>();

  // Public event for state changes
  public readonly onDidChangeState = this.onStateChanged.event;
  /** Fired when a working-file merge discovers new queue members. */
  public readonly onDidMergeDiskSteps = this.onDiskStepsMergedEmitter.event;

  constructor(stateMachine: WorkflowStateMachine = new WorkflowStateMachine()) {
    this.stateMachine = stateMachine;
    this.state = {
      currentIndex: 0,
      steps: [],
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 1,
    };

    // Create WorkingFileManager with adapter that provides access to queue state
    const queueAccess: IWorkingFileQueueAccess = {
      getWorkingFilePath: () => this.state.workingFilePath,
      getSteps: () => this.state.steps,
      getCurrentIndex: () => this.state.currentIndex,
      getStatus: () => this.stateMachine.status,
      getRuntimeState: () => this.stateMachine.getSnapshot(),
      getTokenTotals: () => this.state.tokenTotals,
      getWorkflowName: () => this.state.workflowName,
      getWorkflowVars: () => this.workflowFile?.vars,
      getParallelGroups: () => this.state.parallelGroups,
      getActiveParallelGroupRuntime: () =>
        this.activeParallelGroupRuntime
          ? { ...this.activeParallelGroupRuntime }
          : undefined,
      mergeDiskSteps: (
        diskSteps: WorkflowStep[],
        parallelGroups?: import("../types/CtrlYokeTypes").ParallelGroupDefinition[]
      ) => this.mergeDiskSteps(diskSteps, parallelGroups),
      onDiskStepsMerged: (steps) => this.onDiskStepsMergedEmitter.fire(steps),
      emitStateChange: () => this.emitStateChange(),
      getFinalStepRuntime: () => this.getFinalStepRuntime(),
      getFinalStepExecutionMetadata: () =>
        this.workflowFile?.finalStep?._runtime,
      getPendingRewind: () => this.state.pendingRewind,
      updateWorkflowProperty: (key: string, value: unknown) =>
        this.updateWorkflowProperty(key, value),
      getDefinitionRevision: () => this.state.definitionRevision,
      setDefinitionRevision: (revision: number) => {
        this.state.definitionRevision = revision;
      },
    };
    this.workingFileManager = new WorkingFileManager(queueAccess);
  }

  /**
   * Extract workflow name from file path
   * Strips ctrlyoke-specific extensions (.ctrlyoke.json, .ctrlyoke.yaml, .ctrlyoke.yml, .prompt.md)
   *
   * @param filePath - Full file path
   * @returns Workflow name without extensions
   *
   * @example
   * PromptQueue.extractWorkflowName("/path/to/my-workflow.ctrlyoke.yaml") // "my-workflow"
   * PromptQueue.extractWorkflowName("C:\\Users\\dev\\feature.ctrlyoke.json") // "feature"
   * PromptQueue.extractWorkflowName("/path/prompt.prompt.md") // "prompt"
   */
  static extractWorkflowName(filePath: string): string {
    const fileName = path.basename(filePath);
    // Remove ctrlyoke extensions: .ctrlyoke.json, .ctrlyoke.yaml, .ctrlyoke.yml, .prompt.md
    return fileName.replace(/\.(ctrlyoke\.(json|yaml|yml)|prompt\.md)$/, "");
  }

  /**
   * Update the workflow name in queue state and persist to working file.
   * Used when the name is derived after the working file is eagerly created
   * (e.g., first prompt text used to name an ephemeral workflow).
   */
  setWorkflowName(name: string): void {
    this.state.workflowName = name;
    this.emitStateChange();
  }

  /**
   * Clear the queue completely (reset to empty state)
   * Used when user clicks "New Workflow" button
   */
  clearQueue(): void {
    this.state = {
      currentIndex: 0,
      steps: [],
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 1,
      // Clear working file path and workflow name
      workingFilePath: undefined,
      workflowName: undefined,
    };

    this.workflowFile = undefined; // Clear workflow file reference
    this.finalStepRuntime = undefined;
    this.activeParallelGroupRuntime = undefined;
    this.stateMachine.restore({
      status: EXECUTION_STATES.IDLE,
      stopped: false,
      totalPausedDuration: 0,
    });

    this.emitStateChange();
    Log.info("[PromptQueue] Queue cleared - ready for new workflow");
  }

  public getRuntimeStateMachine(): WorkflowStateMachine {
    return this.stateMachine;
  }

  public async commitRuntimeTransition(
    options: {
      persist?: boolean;
      emitStateChange?: boolean;
      skipMerge?: boolean;
    } = {}
  ): Promise<void> {
    const {
      persist = true,
      emitStateChange = true,
      skipMerge = false,
    } = options;

    if (emitStateChange) {
      this.emitStateChange();
    }

    if (persist) {
      await this.updateWorkingFile(skipMerge);
    }
  }

  /** Return the durable projection for the currently executing parallel group. */
  public getActiveParallelGroupRuntime():
    ActiveParallelGroupRuntime | undefined {
    return this.activeParallelGroupRuntime
      ? { ...this.activeParallelGroupRuntime }
      : undefined;
  }

  /**
   * Persist a parallel group's admission state through the working-file
   * operation queue. Runtime coordination must not mutate queue state outside
   * this serialized read-modify-write path.
   */
  public async setActiveParallelGroupAdmission(
    groupId: string,
    admission: ParallelGroupAdmission
  ): Promise<void> {
    await this.workingFileManager.runInQueue(async () => {
      const next = { groupId, admission };
      if (isDeepStrictEqual(this.activeParallelGroupRuntime, next)) {
        return;
      }
      this.activeParallelGroupRuntime = next;
      this.emitStateChange();
      await this.workingFileManager.updateWorkingFileDirect();
    });
  }

  public markInFlightPromptCancelled(): void {
    const currentIndex = this.state.currentIndex;
    this.state.results.forEach((result, index) => {
      if (
        result.status === STEP_STATUS.SENT ||
        (result.status === STEP_STATUS.PENDING && index === currentIndex)
      ) {
        result.status = STEP_STATUS.CANCELLED;
      }
    });
  }

  public finalizeCancelledPromptAfterStop(): boolean {
    const index = this.state.currentIndex;
    if (!this.state.steps[index]) {
      return false;
    }
    if (
      this.state.parallelGroups.some(
        (group) => index >= group.startIndex && index <= group.endIndex
      )
    ) {
      return false;
    }

    void this.cancelStep(index);
    this.state.currentIndex++;
    this.emitStateChange();
    return true;
  }

  /**
   * Fail the in-flight step and advance past it.
   *
   * Returns the index of the step that was failed, or `undefined` when there
   * was nothing to finalize. Callers must use that index to report the failure
   * to the dashboard: this path bypasses the attempt state machine, so no
   * `WORKFLOW_ATTEMPT_COMMANDS.FAIL` transition fires and nothing else emits a
   * `STEP_STATUS_CHANGED` for it. Advancing `currentIndex` here means the
   * dashboard's `currentStep` points at the *next* step by the time the
   * workflow flips to ERROR, so without that report the webview cannot tell
   * which of the two actually failed and paints the error icon one row low.
   */
  public finalizeFailedInFlightPrompt(error?: string): number | undefined {
    if (!this.hasNext()) {
      return undefined;
    }

    const index = this.state.currentIndex;
    if (!this.canFinalizeStep(index)) {
      return undefined;
    }

    void this.failStep(index, error);
    this.state.currentIndex++;
    this.emitStateChange();
    return index;
  }

  /**
   * Clear only the working file path reference without affecting prompts or other state.
   * Used when the working file has been deleted externally (e.g., removed from history)
   * so that ensureEphemeralWorkingFile() will create a fresh one on the next write.
   */
  clearWorkingFilePath(): void {
    this.state.workingFilePath = undefined;
    this.emitStateChange();
  }

  /**
   * Load prompts into the queue
   * @param promptFile Complete workflow file with prompts and workflow-level properties
   * @param workingFilePath Optional path to working file (source of truth)
   */
  loadPrompts(promptFile: PromptFile, workingFilePath?: string): void {
    const topology = normalizeParallelGroupTopology({
      steps: promptFile.steps || [],
      parallelGroups: promptFile.parallelGroups,
    });
    const prompts = ensureStepIds(topology.steps);

    this.state = {
      currentIndex: 0,
      steps: [...prompts],
      parallelGroups: topology.parallelGroups,
      results: prompts.map((step) => ({
        prompt: isScriptStep(step) ? step.script : step.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      })),
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      workingFilePath,
      workflowName: this.state.workflowName, // Preserve workflow name across reloads
      // Preserve lineage identity across reloads. createWorkingFile() sets these just
      // before loadPrompts() is called (PromptFileLoader.loadParsedPromptFile); without
      // preserving them here, a freshly loaded prompt file's first execution could never
      // satisfy executeLoadedPromptFile's fresh-start guard (`... && workflowKey`) and
      // would silently keep writing to the draft forever instead of promoting a run.
      workflowKey: this.state.workflowKey,
      runRef: this.state.runRef,
      definitionRevision: this.state.definitionRevision, // Preserve across reloads (restoreFromWorkingFile sets the authoritative value)
      pendingRewind: this.state.pendingRewind,
      tokenTotals: undefined,
    };
    this.activeParallelGroupRuntime = undefined;

    // Store complete workflow file for property resolution
    this.workflowFile = {
      ...promptFile,
      steps: [...prompts],
      parallelGroups: topology.parallelGroups,
    };
    this.finalStepRuntime = undefined;
    this.clearRuntimeOutputCache();
    this.stateMachine.restore({
      status: EXECUTION_STATES.IDLE,
      stopped: false,
      totalPausedDuration: 0,
    });

    this.emitStateChange();
    Log.info(`[PromptQueue] Loaded ${prompts.length} prompts into queue`);
  }

  /**
   * Restore queue state from a working file (including runtime state)
   * This is used when resuming a previous session from run storage.
   * @param workingFilePath Path to the working file
   */
  async restoreFromWorkingFile(
    workingFilePath: string,
    preventRunningAutoStart: boolean = false
  ): Promise<void> {
    try {
      // Read the working file
      const workingFile = await this.readWorkingFile(workingFilePath);

      const runtime = workingFile._runtime;
      this.finalStepRuntime = runtime?.finalStep;
      this.clearRuntimeOutputCache();

      const topology = normalizeParallelGroupTopology({
        steps: workingFile.steps ?? [],
        parallelGroups: workingFile.parallelGroups,
      });
      const prompts = ensureStepIds(topology.steps);
      const recoveredIdsAdded = prompts.some(
        (prompt, index) => prompt !== topology.steps[index]
      );
      const pendingRewind = runtime?.pendingRewind
        ? {
            ...runtime.pendingRewind,
            fromStepIndex: snapParallelGroupStartPosition(
              topology,
              runtime.pendingRewind.fromStepIndex
            ),
          }
        : undefined;

      // Build completedIndices from per-prompt runtime (source of truth).
      // A startedAt-only member is still tracked per-step; in particular, a
      // parallel member may be started beyond currentIndex. Fall back to the
      // currentIndex boundary only for genuinely old files with no step runtime.
      const hasPerPromptTracking = prompts.some(
        (p) =>
          p._runtime?.startedAt !== undefined ||
          p._runtime?.completedAt !== undefined
      );

      const completedIndices = new Set<string>();
      if (hasPerPromptTracking) {
        // New format: use per-prompt completedAt
        prompts.forEach((p, i) => {
          if (p._runtime?.completedAt !== undefined) {
            completedIndices.add(String(i));
          }
        });
      } else if (runtime?.currentIndex && runtime.currentIndex > 0) {
        // Old format: treat prompts before currentIndex as completed
        Log.info(
          "[PromptQueue] Old working file format detected: using currentIndex for completion boundary"
        );
        for (let i = 0; i < runtime.currentIndex; i++) {
          completedIndices.add(String(i));
          // Self-heal old files with a terminal marker. Do not invent
          // startedAt here: it means the executor claimed the step, not that
          // runtime metadata was first upgraded.
          if (prompts[i]) {
            prompts[i]._runtime = {
              ...prompts[i]._runtime,
              completedAt: workingFile.startedAt
                ? workingFile.startedAt + 1
                : Date.now(),
            };
          }
        }
      }

      // Determine execution state
      // When loading a persisted working file for display, NEVER restore as active
      // unless the caller explicitly wants to continue execution. Loading a dashboard
      // view must not start or imply an active VS Code runner after a restart/crash.
      // Force to STOPPED — preserves per-prompt progress so the user can see how far the
      // workflow got and resume from the current prompt. PAUSED is semantically wrong here
      // (it implies the user intentionally paused); STOPPED signals "aborted, position kept".
      let executionState = runtime?.executionState || EXECUTION_STATES.IDLE;
      let forcedToStopped = false;
      if (
        preventRunningAutoStart &&
        (executionState === EXECUTION_STATES.RUNNING ||
          executionState === EXECUTION_STATES.PAUSING ||
          executionState === EXECUTION_STATES.CANCELLING)
      ) {
        executionState = EXECUTION_STATES.STOPPED;
        forcedToStopped = true;
        Log.info(
          "[PromptQueue] Working file load: forced active state to STOPPED to prevent auto-start"
        );
      }

      const lineageAddress =
        WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);

      const currentIndex =
        pendingRewind?.fromStepIndex ?? runtime?.currentIndex ?? 0;
      const persistedActiveParallelGroup = runtime?.activeParallelGroup;
      const recoveredActiveParallelGroup =
        !preventRunningAutoStart &&
        executionState === EXECUTION_STATES.RUNNING &&
        persistedActiveParallelGroup
          ? (() => {
              const group = topology.parallelGroups.find(
                (candidate) =>
                  candidate.id === persistedActiveParallelGroup.groupId
              );
              const hasUnsettledMember = group
                ? prompts
                    .slice(group.startIndex, group.endIndex + 1)
                    .some((step) => step._runtime?.completedAt === undefined)
                : false;
              return group &&
                currentIndex >= group.startIndex &&
                currentIndex <= group.endIndex &&
                hasUnsettledMember
                ? {
                    groupId: group.id,
                    admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
                  }
                : undefined;
            })()
          : undefined;
      const activeParallelGroupChanged = !isDeepStrictEqual(
        persistedActiveParallelGroup,
        recoveredActiveParallelGroup
      );
      this.activeParallelGroupRuntime = recoveredActiveParallelGroup;

      // Restore prompts and basic state
      // CRITICAL: Preserve _runtime metadata during load (Phase 4: Per-Prompt Session Management)
      // Each prompt's _runtime contains: harness, model, agent, sessionId, startedAt, completedAt
      this.state = {
        currentIndex,
        steps: prompts.map((prompt) => ({
          ...prompt,
          // Backward compatibility: _runtime is optional, old files won't have it
          // The spread operator preserves _runtime if it exists
        })),
        parallelGroups: topology.parallelGroups,
        results: [],
        completedIndices,
        totalExecutionTime: 0,
        queueExtensions: 0,
        workingFilePath,
        workflowKey: lineageAddress?.workflowKey,
        runRef: lineageAddress?.runRef,
        definitionRevision: workingFile.definitionRevision ?? 1,
        pendingRewind,
        tokenTotals: runtime?.tokenTotals,
      };

      // Store complete workflow file for property resolution
      this.workflowFile = {
        ...workingFile,
        steps: [...prompts],
        parallelGroups: topology.parallelGroups,
      };
      this.stateMachine.restore({
        status: executionState,
        stopped: executionState === EXECUTION_STATES.STOPPED,
        startTime: runtime?.startTime,
        pausedTime: runtime?.pausedTime,
        totalPausedDuration: runtime?.totalPausedDuration ?? 0,
        executionEndTime: runtime?.executionEndTime,
      });

      // Rebuild results array with proper status based on completion state
      this.state.results = prompts.map((prompt, index) => {
        let status: (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

        // Check if this prompt was processed (per-prompt completedAt is authoritative)
        // Use terminalStatus to restore the correct visual state (cancelled/failed vs completed).
        if (prompt._runtime?.completedAt !== undefined) {
          const terminal = prompt._runtime.terminalStatus;
          status =
            terminal === PROMPT_TERMINAL_STATUS.SKIPPED
              ? STEP_STATUS.SKIPPED
              : terminal === PROMPT_TERMINAL_STATUS.CANCELLED
                ? STEP_STATUS.CANCELLED
                : terminal === PROMPT_TERMINAL_STATUS.FAILED
                  ? STEP_STATUS.FAILED
                  : STEP_STATUS.COMPLETED;
        }
        // Check if this is the current prompt (always PENDING or SENT — never CANCELLED)
        else if (index === this.state.currentIndex) {
          // RUNNING → SENT (actively being processed)
          // Otherwise (IDLE, PAUSED, STOPPED, etc.) → PENDING
          status =
            executionState === EXECUTION_STATES.RUNNING
              ? STEP_STATUS.SENT
              : STEP_STATUS.PENDING;
        }
        // All other prompts are pending
        else {
          status = STEP_STATUS.PENDING;
        }

        return {
          prompt: isScriptStep(prompt) ? prompt.script : prompt.prompt,
          status,
          timestamp: new Date(),
        };
      });

      this.emitStateChange();

      // Persist forced STOPPED state to disk immediately so subsequent
      // handleGetRecentWorkflows reads see the correct state, not "running".
      if (recoveredIdsAdded || forcedToStopped || activeParallelGroupChanged) {
        await this.updateWorkingFile(recoveredIdsAdded).catch((err) =>
          Log.warn(
            "[PromptQueue] Working file load: failed to persist STOPPED state to disk:",
            err
          )
        );
      }

      // Log runtime metadata restoration (Phase 4: Session Management)
      const promptsWithRuntime = this.state.steps.filter(
        (p) => p._runtime
      ).length;
      Log.info(
        `[PromptQueue] Restored queue from working file: ${prompts.length} prompts, ` +
          `currentIndex=${this.state.currentIndex}, ` +
          `completed=${this.state.completedIndices.size}, ` +
          `status=${executionState}, ` +
          `_runtime: ${promptsWithRuntime}/${prompts.length} prompts`
      );
    } catch (error) {
      Log.error(
        "[PromptQueue] Failed to restore from working file:",
        error as Error
      );
      throw error;
    }
  }

  /**
   * Restart queue from the beginning
   * Resets index, results, and tracking state while keeping prompts loaded
   * Updates working file to clear completedPrompts array
   */
  async restart(): Promise<void> {
    this.stateMachine.reset();
    this.state.currentIndex = 0;

    // Reset all results to pending
    this.state.results = this.state.steps.map((step) => ({
      prompt: isScriptStep(step) ? step.script : step.prompt,
      status: STEP_STATUS.PENDING,
      timestamp: new Date(),
    }));

    // Reset tracking state
    this.state.completedIndices = new Set<string>();
    this.state.totalExecutionTime = 0;
    this.state.queueExtensions = 0;
    this.finalStepRuntime = undefined;
    this.activeParallelGroupRuntime = undefined;

    // Clear per-prompt _runtime data (sessionId, harness, model, etc.)
    // Stale session IDs from a previous run would cause log discovery and session
    // resumption to find the wrong session when re-running the same workflow.
    this.state.steps = this.state.steps.map(resetStepRuntimeForRewind);

    this.emitStateChange();
    Log.info("[PromptQueue] Queue restarted from beginning");

    // Update working file immediately to clear completedPrompts array
    // This prevents race condition where MCP appends during first prompt
    // would reload stale completedPrompts from disk
    await this.updateWorkingFile();
  }

  /**
   * Move the start position of a lineage that has never executed.
   *
   * A draft is the pre-execution definition, so its start position is draft
   * state rather than a run: the steps before `toIndex` are marked SKIPPED and
   * `currentIndex` moves to `toIndex`, and the lineage's first execution
   * promotes both into run 1 verbatim (`WorkingFileManager.promoteToNewRun`
   * copies the queue's steps and current index). A promoted run has no business
   * here — it rewinds in place through `beginPendingRewind` instead, which is
   * why this refuses to touch a queue that is bound to a RunRef.
   *
   * Every call rewrites the *whole* step list rather than layering marks onto
   * the previous one, so repositioning is idempotent and fully reversible:
   * `toIndex: 0` clears the prefix and restores a pristine draft. That is what
   * lets a user still choosing a start position change their mind freely —
   * seeding a run per adjustment left one dead run behind on every click.
   *
   * The skip marks are written directly instead of through `skipStep`: nothing
   * has executed, so this must not reach the harness-usage reporter or reset
   * attempt counters the way a genuine mid-run skip does.
   */
  public async setStartPosition(toIndex: number): Promise<void> {
    if (this.state.runRef !== undefined) {
      throw new Error(
        "Only a draft's start position can be set in place; a promoted run rewinds instead"
      );
    }
    if (this.isExecutionActive) {
      throw new Error(
        `Cannot set start position while in state ${this.stateMachine.status}`
      );
    }
    if (
      !Number.isInteger(toIndex) ||
      toIndex < 0 ||
      toIndex >= this.state.steps.length
    ) {
      throw new Error(
        "Start position must leave at least one suffix step to run"
      );
    }
    // A parallel group is admitted as a unit, so starting inside one is not a
    // representable position — snap to the group's first member, exactly as a
    // run's rewind boundary does.
    const topology = normalizeParallelGroupTopology({
      steps: this.state.steps,
      parallelGroups: this.state.parallelGroups,
    });
    const boundary = snapParallelGroupStartPosition(topology, toIndex);
    const markedAt = Date.now();
    this.state.steps = topology.steps.map((step, index) => {
      const cleared = resetStepRuntimeForRewind(step);
      return index < boundary
        ? {
            ...cleared,
            _runtime: {
              ...cleared._runtime,
              startedAt: markedAt,
              completedAt: markedAt,
              terminalStatus: PROMPT_TERMINAL_STATUS.SKIPPED,
            },
          }
        : cleared;
    });
    this.state.parallelGroups = topology.parallelGroups;
    this.state.currentIndex = boundary;
    this.state.completedIndices = new Set<string>(
      Array.from({ length: boundary }, (_, index) => String(index))
    );
    this.state.results = this.state.steps.map((step, index) => ({
      prompt: isScriptStep(step) ? step.script : step.prompt,
      status: this.getResultStatusFromRuntime(step, index, boundary),
      timestamp: new Date(),
    }));
    if (this.workflowFile) {
      this.workflowFile = {
        ...this.workflowFile,
        steps: [...this.state.steps],
        parallelGroups: this.state.parallelGroups,
      };
    }

    this.emitStateChange();
    Log.info(`[PromptQueue] Draft start position set to step ${boundary}`);

    // skipMerge: this rewrites every step's runtime deliberately, so a disk
    // merge would only risk reviving the marks it just cleared.
    await this.updateWorkingFile(true);
  }

  /**
   * Restore queue state after a dirty-file reload for an append continuation.
   *
   * When the prompt file was dirty in VS Code and `loadPrompts` was called (resetting
   * currentIndex to 0), we need to advance the queue past the N steps that were already
   * completed in the previous run, so the executor starts at step N.
   *
   * @param completedCount Number of steps from the previous run that were completed.
   */
  async restoreCompletedSteps(completedCount: number): Promise<void> {
    const cap = Math.min(completedCount, this.state.steps.length);
    for (let i = 0; i < cap; i++) {
      this.state.results[i].status = STEP_STATUS.COMPLETED;
    }
    this.state.currentIndex = cap;
    this.emitStateChange();
    Log.info(
      `[PromptQueue] Restored ${cap} completed step(s) for append continuation`
    );
  }

  /**
   * Get current queue state
   */
  getState(): QueueState {
    return {
      ...this.state,
      totalExecutionTime: this.stateMachine.getActiveExecutionTime(),
      ...this.stateMachine.getSnapshot(),
    };
  }

  /** Accept the latest aggregate projected by OutputHistoryManager. */
  public setTokenTotals(tokenTotals: WorkflowTokenTotals | undefined): void {
    this.state.tokenTotals = tokenTotals;
    this.emitStateChange();
  }

  /** Record the latest pre-condition evaluation for a queue step. */
  public recordPreConditionSummary(
    stepIndex: number,
    summary: ConditionEvaluationSummary
  ): void {
    const result = this.state.results[stepIndex];
    if (!result) {
      return;
    }
    result.preCondition = { ...summary };
  }

  /** Record the latest end-condition evaluation for a queue step. */
  public recordEndConditionSummary(
    stepIndex: number,
    summary: ConditionEvaluationSummary
  ): void {
    const result = this.state.results[stepIndex];
    if (!result) {
      return;
    }
    result.endCondition = { ...summary };
    result.endConditionResult = summary.passed;
    result.scriptOutput = summary.stdout;
  }

  /** Record the latest pre-condition evaluation for the active final step loop. */
  public recordFinalStepPreConditionSummary(
    summary: ConditionEvaluationSummary
  ): void {
    this.finalStepRuntime = {
      ...(this.finalStepRuntime ?? {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 0,
      }),
      preCondition: { ...summary },
    };
  }

  /** Record the latest end-condition evaluation for the active final step loop. */
  public recordFinalStepEndConditionSummary(
    summary: ConditionEvaluationSummary
  ): void {
    this.finalStepRuntime = {
      ...(this.finalStepRuntime ?? {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 0,
      }),
      endCondition: { ...summary },
    };
  }

  /** Read the latest pre-condition evaluation for a workflow attempt target. */
  public getPreConditionSummary(
    target: WorkflowAttemptTarget
  ): ConditionEvaluationSummary | undefined {
    const summary =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? this.state.results[target.stepIndex]?.preCondition
        : this.finalStepRuntime?.preCondition;
    return summary ? { ...summary } : undefined;
  }

  /** Read the latest end-condition evaluation for a workflow attempt target. */
  public getEndConditionSummary(
    target: WorkflowAttemptTarget
  ): ConditionEvaluationSummary | undefined {
    const summary =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? this.state.results[target.stepIndex]?.endCondition
        : this.finalStepRuntime?.endCondition;
    return summary ? { ...summary } : undefined;
  }

  /**
   * Check if queue has more prompts to execute
   */
  hasNext(): boolean {
    return this.state.currentIndex < this.state.steps.length;
  }

  /**
   * Get current prompt
   */
  getCurrentPrompt(): WorkflowStep | null {
    if (!this.hasNext()) {
      return null;
    }
    return this.state.steps[this.state.currentIndex];
  }

  async markStepAsSent(stepIndex: number): Promise<void> {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    currentResult.status = STEP_STATUS.SENT;
    currentResult.timestamp = new Date();
    this.emitStateChange();
  }

  async skipStep(
    stepIndex: number,
    terminalStatus: PromptTerminalStatus = PROMPT_TERMINAL_STATUS.SKIPPED
  ): Promise<void> {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    this.skipStepState(stepIndex, terminalStatus);
    this.emitStateChange();
  }

  async failStep(
    stepIndex: number,
    reason?: string,
    failureKind?: PromptRuntimeMetadata["failureKind"]
  ): Promise<void> {
    if (!this.canFinalizeStep(stepIndex)) {
      return;
    }

    this.failStepState(stepIndex, reason, true, failureKind);
    this.emitStateChange();
  }

  async cancelStep(stepIndex: number): Promise<void> {
    const currentResult = this.state.results[stepIndex];
    if (
      !currentResult ||
      (currentResult.status !== STEP_STATUS.CANCELLED &&
        !this.canFinalizeStep(stepIndex))
    ) {
      return;
    }

    this.cancelStepState(stepIndex);
    this.emitStateChange();
  }

  async persistStepOutcome(outcome: StepExecutionOutcome): Promise<void> {
    if (outcome.target.kind !== FINAL_STEP_PHASES.QUEUE) {
      return;
    }

    this.applyStepOutcome(outcome);
    this.emitStateChange();
    await this.updateWorkingFile();
  }

  async commitStepOutcomeAndAdvance(
    outcome: StepExecutionOutcome
  ): Promise<SequentialStepSettlement> {
    const target = outcome.target;
    if (target.kind !== FINAL_STEP_PHASES.QUEUE) {
      return {};
    }

    let settlement: SequentialStepSettlement = {};
    await this.workingFileManager.runInQueueWithWorkingFileLock(async () => {
      const workingFilePath = this.state.workingFilePath;
      if (workingFilePath) {
        const workingFile = await this.readWorkingFile(workingFilePath);
        const diskSteps = workingFile.steps ?? [];
        const diskDefinitionRevision = workingFile.definitionRevision ?? 1;
        const newStepsFromDisk = this.mergeDiskSteps(
          diskSteps,
          workingFile.parallelGroups
        );
        if (newStepsFromDisk.length > 0) {
          this.state.definitionRevision = diskDefinitionRevision;
          this.onDiskStepsMergedEmitter.fire(newStepsFromDisk);
          this.emitStateChange();
        }
      }

      const promotedGroup = this.state.parallelGroups.find(
        (group) =>
          target.stepIndex >= group.startIndex &&
          target.stepIndex <= group.endIndex
      );

      this.applyStepOutcome(outcome);
      if (promotedGroup) {
        settlement = { promotedGroup };
      } else {
        this.state.currentIndex = Math.max(
          this.state.currentIndex,
          target.stepIndex + 1
        );
      }
      this.emitStateChange();
      await this.workingFileManager.updateWorkingFileDirect(true, true);
    });
    return settlement;
  }

  /**
   * Merge the latest definition and atomically reconcile or close a live
   * group. The caller supplies the run's ID-keyed reconciliation so this
   * queue remains independent from the executor's worker pool.
   */
  public async reconcileAndCloseParallelGroup(
    groupId: string,
    outcomes: readonly StepExecutionOutcome[],
    isKnownMember: (stepId: string) => boolean,
    reconcileMembers: (stepIds: readonly string[]) => readonly string[]
  ): Promise<ParallelGroupReconcileResult> {
    let result: ParallelGroupReconcileResult = { joined: false };
    await this.workingFileManager.runInQueueWithWorkingFileLock(async () => {
      const workingFilePath = this.state.workingFilePath;
      if (workingFilePath) {
        const workingFile = await this.readWorkingFile(workingFilePath);
        const newStepsFromDisk = this.mergeDiskSteps(
          workingFile.steps ?? [],
          workingFile.parallelGroups
        );
        if (newStepsFromDisk.length > 0) {
          this.state.definitionRevision = workingFile.definitionRevision ?? 1;
          this.emitStateChange();
        }
      }

      const joinGroup = this.state.parallelGroups.find(
        (group) => group.id === groupId
      );
      if (!joinGroup) {
        throw new Error(
          `Cannot join parallel group ${groupId}: group is missing from the current definition`
        );
      }

      if (workingFilePath) {
        const survivingIds = this.state.steps
          .slice(joinGroup.startIndex, joinGroup.endIndex + 1)
          .map((step) => step._runtime?.stepId)
          .filter(
            (stepId): stepId is string =>
              stepId !== undefined && !isKnownMember(stepId)
          );
        if (survivingIds.length > 0) {
          const admitted = reconcileMembers(survivingIds);
          if (admitted.length > 0) {
            result = { joined: false, group: joinGroup };
            return;
          }
        }
      }

      this.activeParallelGroupRuntime = {
        groupId,
        admission: PARALLEL_GROUP_ADMISSION.CLOSING,
      };
      this.emitStateChange();
      this.applyParallelGroupJoin(joinGroup, outcomes);
      await this.workingFileManager.updateWorkingFileDirect(true, true);
      result = { joined: true, group: joinGroup };
    });
    return result;
  }

  async commitParallelGroupJoin(
    group: ParallelGroupDefinition,
    outcomes: readonly StepExecutionOutcome[]
  ): Promise<void> {
    await this.workingFileManager.runInQueue(async () => {
      this.applyParallelGroupJoin(group, outcomes);
      this.emitStateChange();
      await this.workingFileManager.updateWorkingFileDirect();
    });
  }

  private applyParallelGroupJoin(
    group: ParallelGroupDefinition,
    outcomes: readonly StepExecutionOutcome[]
  ): void {
    for (const outcome of outcomes) {
      if (outcome.target.kind !== FINAL_STEP_PHASES.QUEUE) {
        continue;
      }

      if (
        outcome.target.stepIndex < group.startIndex ||
        outcome.target.stepIndex > group.endIndex
      ) {
        continue;
      }

      this.applyStepOutcome(outcome);
    }

    this.state.currentIndex = Math.max(
      this.state.currentIndex,
      group.endIndex + 1
    );
    if (this.activeParallelGroupRuntime?.groupId === group.id) {
      this.activeParallelGroupRuntime = undefined;
    }
  }

  /**
   * Get execution progress
   */
  getProgress(): { current: number; total: number; percentage: number } {
    const total = this.state.steps.length;
    const current = this.state.currentIndex;
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    return { current, total, percentage };
  }

  getCurrentParallelGroup(): ParallelGroupDefinition | undefined {
    const { currentIndex } = this.state;
    return this.state.parallelGroups.find(
      (group) =>
        currentIndex >= group.startIndex && currentIndex <= group.endIndex
    );
  }

  /**
   * Get completed prompts count
   */
  getCompletedCount(): number {
    return this.state.results.filter(
      (result) => result.status === STEP_STATUS.COMPLETED
    ).length;
  }

  /**
   * Get the complete workflow file with workflow-level properties.
   * Used by PropertyResolver to apply three-tier property precedence.
   *
   * @returns Complete PromptFile with workflow-level properties, or empty object if not loaded
   */
  getWorkflowFile(): PromptFile {
    // Return the stored workflow file, or an empty topology if not available.
    return (
      this.workflowFile || {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      }
    );
  }

  /**
   * Update workflow-level property in the cached workflow file.
   * Ensures property resolution uses the latest values during execution.
   */
  updateWorkflowProperty(property: string, value: unknown): void {
    if (!this.workflowFile) {
      this.workflowFile = {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      };
    }

    if (value === undefined) {
      delete (this.workflowFile as any)[property];
      return;
    }

    (this.workflowFile as any)[property] = value;
  }

  /**
   * Check if current prompt can be retried
   */
  canRetry(
    prompt: PromptStep,
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): boolean {
    const { maxRetries, retryPrompt } = resolveRetrySettings(
      prompt.endCondition
    );
    if (
      !retryPrompt &&
      prompt.endCondition?.onFail !== CONDITION_ACTIONS.RETRY
    ) {
      return false;
    }

    // -1 means unlimited retries
    if (isUnlimited(maxRetries)) {
      return true;
    }

    return this.getRetryCount(target) < maxRetries;
  }

  /**
   * Check if the current prompt can be retried after a passing condition.
   * Pass retries intentionally do not require a configured template because
   * the handler falls back to the prompt's own text.
   */
  canPassRetry(
    prompt: PromptStep,
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): boolean {
    const { maxRetries } = resolveRetrySettings(prompt.endCondition);

    // -1 means unlimited retries
    if (isUnlimited(maxRetries)) {
      return true;
    }

    return this.getRetryCount(target) < maxRetries;
  }

  /**
   * Get effective maxRetries for current prompt (including defaults)
   */
  getEffectiveMaxRetries(prompt: PromptStep): number {
    return resolveRetrySettings(prompt.endCondition).maxRetries;
  }

  /**
   * Get effective retry prompt for current prompt (including defaults)
   */
  getEffectiveRetryPrompt(prompt: PromptStep): string | undefined {
    return resolveRetrySettings(prompt.endCondition).retryPrompt;
  }

  /**
   * Get effective pass-retry prompt for current prompt (including settings defaults)
   */
  getEffectivePassRetryPrompt(prompt: PromptStep): string | undefined {
    return resolveRetrySettings(prompt.endCondition).passRetryPrompt;
  }

  /**
   * Increment retry count for current prompt
   */
  incrementRetryCount(
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): number {
    const retryCount = this.stateMachine.incrementRetryCount(target);

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      const currentResult = this.state.results[target.stepIndex];
      if (currentResult) {
        currentResult.retryCount = retryCount;
        this.emitStateChange();
      }
    }
    return retryCount;
  }

  /**
   * Reset retry count (call when moving to next prompt or on success)
   */
  resetRetryCount(
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): void {
    this.stateMachine.resetRetryCount(target);
  }

  /**
   * Get current retry count
   */
  getCurrentRetryCount(
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): number {
    return this.getRetryCount(target);
  }

  getRetryCount(
    target: WorkflowAttemptTarget = this.getCurrentQueueTarget()
  ): number {
    return this.stateMachine.getRetryCount(target);
  }

  /**
   * Mark a prompt as completed.
   * Sets completedAt on the prompt's own _runtime (source of truth) and
   * updates the in-memory fast-lookup index keyed by prompt index.
   */
  markPromptCompleted(
    index: number,
    terminalStatus?: PromptRuntimeMetadata["terminalStatus"],
    metadata?: Partial<PromptRuntimeMetadata>
  ): void {
    const prompt = this.state.steps[index];
    if (prompt) {
      const now = Date.now();
      const startedAt =
        prompt._runtime?.startedAt ?? metadata?.startedAt ?? now;
      const outcome: PromptTerminalStatus =
        terminalStatus ??
        metadata?.terminalStatus ??
        PROMPT_TERMINAL_STATUS.COMPLETED;
      prompt._runtime = {
        ...prompt._runtime,
        ...metadata,
        startedAt,
        completedAt: now,
        terminalStatus: outcome,
      };

      const workflowFile = this.getWorkflowFile();
      const isScript = isScriptStep(prompt);
      reportPromptCompleted({
        harness: PropertyResolver.resolveHarnessValue(
          prompt._runtime.harness ?? (isScript ? undefined : prompt.harness),
          workflowFile.harness
        ),
        executionMode: PropertyResolver.resolveExecutionMode(
          {
            executionMode:
              prompt._runtime.executionMode ??
              (isScript ? undefined : prompt.executionMode),
          },
          workflowFile
        ),
        promptIndex: index,
        durationMs: now - startedAt,
        outcome,
        failureKind:
          outcome === PROMPT_TERMINAL_STATUS.FAILED
            ? prompt._runtime.failureKind
            : undefined,
        endConditionUsed: !isScript && prompt.endCondition != null,
        resumeSession: Boolean(
          prompt._runtime.resumeSession ??
          (isScript ? false : prompt.resumeSession)
        ),
        injectMode: ConfigurationUtils.isInjectModeEnabled(),
      });
    }
    // Update in-memory fast-lookup cache (key = prompt index as string)
    this.state.completedIndices.add(String(index));
  }

  private getCurrentQueueTarget(): WorkflowAttemptTarget {
    return {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: this.state.currentIndex,
    };
  }

  private canFinalizeStep(stepIndex: number): boolean {
    const currentResult = this.state.results[stepIndex];
    return (
      currentResult?.status === STEP_STATUS.SENT ||
      currentResult?.status === STEP_STATUS.RUNNING ||
      currentResult?.status === STEP_STATUS.PENDING
    );
  }

  private completeStepState(
    stepIndex: number,
    metadata?: Partial<PromptRuntimeMetadata>
  ): void {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    currentResult.status = STEP_STATUS.COMPLETED;
    currentResult.timestamp = new Date();
    if (metadata?.retryCount !== undefined) {
      currentResult.retryCount = metadata.retryCount;
    }

    this.markPromptCompleted(
      stepIndex,
      PROMPT_TERMINAL_STATUS.COMPLETED,
      metadata
    );
    this.stateMachine.resetRetryCount({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex,
    });
  }

  private skipStepState(
    stepIndex: number,
    terminalStatus: PromptTerminalStatus
  ): void {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    currentResult.status = terminalStatus;
    currentResult.timestamp = new Date();
    this.markPromptCompleted(stepIndex, terminalStatus);
    this.stateMachine.resetRetryCount({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex,
    });
  }

  private failStepState(
    stepIndex: number,
    error?: string,
    terminalFailure: boolean = true,
    failureKind?: PromptRuntimeMetadata["failureKind"]
  ): void {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    currentResult.status = STEP_STATUS.FAILED;
    if (error) {
      currentResult.error = error;
    }
    if (failureKind) {
      currentResult.failureKind = failureKind;
    }
    currentResult.timestamp = new Date();
    this.markPromptCompleted(stepIndex, PROMPT_TERMINAL_STATUS.FAILED, {
      ...(error ? { failureMessage: error } : {}),
      ...(failureKind ? { failureKind } : {}),
      terminalFailure,
    });
    this.stateMachine.resetRetryCount({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex,
    });
  }

  private cancelStepState(stepIndex: number): void {
    const currentResult = this.state.results[stepIndex];
    if (!currentResult) {
      return;
    }

    currentResult.status = STEP_STATUS.CANCELLED;
    currentResult.timestamp = new Date();
    this.markPromptCompleted(stepIndex, PROMPT_TERMINAL_STATUS.CANCELLED);
    this.stateMachine.resetRetryCount({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex,
    });
  }

  private applyStepOutcome(outcome: StepExecutionOutcome): void {
    if (outcome.target.kind !== FINAL_STEP_PHASES.QUEUE) {
      return;
    }

    switch (outcome.status) {
      case PROMPT_TERMINAL_STATUS.COMPLETED:
        this.completeStepState(outcome.target.stepIndex);
        break;
      case PROMPT_TERMINAL_STATUS.SKIPPED:
        this.skipStepState(
          outcome.target.stepIndex,
          PROMPT_TERMINAL_STATUS.SKIPPED
        );
        break;
      case PROMPT_TERMINAL_STATUS.FAILED:
        this.failStepState(
          outcome.target.stepIndex,
          outcome.failureReason,
          outcome.terminalFailure
        );
        break;
      case PROMPT_TERMINAL_STATUS.CANCELLED:
        this.cancelStepState(outcome.target.stepIndex);
        break;
    }
  }

  /**
   * Reload prompt file and merge new prompts into queue
   * @param filePath Path to the .ctrlyoke.json file
   * @param parser PromptFileParser instance for reloading
   * @param maxSteps Maximum allowed step count (-1 = unlimited)
   * @returns Number of new prompts added, or -1 if reload failed
   */
  /**
   * Persist partial runtime metadata updates for a workflow step. Queue steps
   * use their zero-based index; `steps.length` addresses the finalStep.
   * Merges durable execution metadata into the step's `_runtime` and flushes to
   * the working file. Response and script output are timeline-only.
   *
   * @param promptIndex 0-based queue index, or steps.length for finalStep
   * @param updates Partial metadata to merge into existing _runtime
   */
  async persistRuntimeMetadata(
    promptIndex: number,
    updates: Partial<PromptRuntimeMetadata>
  ): Promise<void> {
    const step = this.getRuntimeStep(promptIndex);
    if (!step) {
      return;
    }

    step._runtime = { ...step._runtime, ...updates };

    await this.updateWorkingFile();
  }

  /**
   * Claim a queue step by its stable identity immediately before dispatch.
   * Promoted runs use the same lock-held transaction as external mutations;
   * draft/unit-test queues use the equivalent in-memory transition.
   */
  public async claimStepById(
    stepId: string,
    startedAt: number = Date.now(),
    workspaceRoot: string | undefined = this.workingFileWorkspaceRoot
  ): Promise<RunStepClaimResult> {
    let result: RunStepClaimResult | undefined;

    await this.workingFileManager.runInQueue(async () => {
      const state = this.state;
      if (
        !workspaceRoot ||
        !state.workflowKey ||
        !state.runRef ||
        !state.workingFilePath
      ) {
        const stepIndex = findStepIndexById(state.steps, stepId);
        if (stepIndex < 0) {
          result = {
            status: STEP_CLAIM_OUTCOMES.MISSING,
            definitionRevision: state.definitionRevision,
          };
          return;
        }

        const step = state.steps[stepIndex];
        if (step._runtime?.completedAt !== undefined) {
          result = {
            status: STEP_CLAIM_OUTCOMES.TERMINAL,
            definitionRevision: state.definitionRevision,
            step,
            stepIndex,
          };
          return;
        }
        if (step._runtime?.startedAt !== undefined) {
          result = {
            status: STEP_CLAIM_OUTCOMES.ALREADY_CLAIMED,
            definitionRevision: state.definitionRevision,
            step,
            stepIndex,
          };
          return;
        }

        const claimedStep: WorkflowStep = {
          ...step,
          _runtime: { ...step._runtime, startedAt },
        };
        state.steps[stepIndex] = claimedStep;
        if (this.workflowFile?.steps) {
          this.workflowFile.steps[stepIndex] = claimedStep;
        }
        result = {
          status: STEP_CLAIM_OUTCOMES.CLAIMED,
          definitionRevision: state.definitionRevision,
          step: claimedStep,
          stepIndex,
        };
        this.emitStateChange();
        return;
      }

      result = await RunContinuationService.claimStepAtRun(
        workspaceRoot,
        state.workflowKey,
        state.runRef,
        stepId,
        startedAt
      );

      // The transaction read the current disk definition under the mutation
      // lock. Reuse the queue's existing merge contract to adopt that order,
      // then apply the claimed runtime object returned by the transaction.
      const workingFile = result.workingFile;
      if (!workingFile) {
        throw new Error("Persisted step claim did not return its working file");
      }
      this.mergeDiskSteps(workingFile.steps ?? [], workingFile.parallelGroups);
      state.definitionRevision = result.definitionRevision;
      if (
        result.status === STEP_CLAIM_OUTCOMES.CLAIMED &&
        result.stepIndex !== undefined &&
        result.step !== undefined
      ) {
        state.steps[result.stepIndex] = result.step;
        if (this.workflowFile?.steps) {
          this.workflowFile.steps[result.stepIndex] = result.step;
        }
      }
      this.emitStateChange();
    });

    if (!result) {
      throw new Error("Step claim did not produce an outcome");
    }
    return result;
  }

  /**
   * Persist a harness session ID as soon as startup/log discovery resolves it.
   * `promptIndex === steps.length` addresses the workflow finalStep.
   */
  async persistSessionId(
    promptIndex: number,
    sessionId: string
  ): Promise<void> {
    const step = this.getRuntimeStep(promptIndex);
    if (!step || step._runtime?.sessionId === sessionId) {
      return;
    }
    await this.persistRuntimeMetadata(promptIndex, { sessionId });
  }

  private getRuntimeStep(promptIndex: number): WorkflowStep | undefined {
    return (
      this.state.steps[promptIndex] ??
      (promptIndex === this.state.steps.length
        ? this.workflowFile?.finalStep
        : undefined)
    );
  }

  /**
   * Merge resolver-derived follow-up text into the active-only queue cache.
   */
  appendPromptResponseText(promptIndex: number, additionalText: string): void {
    if (!additionalText) {
      return;
    }
    if (!this.state.steps[promptIndex]) {
      return;
    }
    const existing =
      this.runtimeOutputCache.get(promptIndex)?.responseText ?? "";
    this.cacheRuntimeOutput(promptIndex, {
      responseText: appendResponseText(existing, additionalText),
    });
  }

  /**
   * Merge prompts from disk into the in-memory queue.
   * Adopts disk ordering as source of truth and preserves runtime metadata only
   * for the completed prefix whose boundary both copies agree on.
   *
   * @param diskSteps Steps read from the working file on disk
   * @returns Array of newly-discovered steps (empty if none)
   */
  private mergeDiskSteps(
    diskSteps: WorkflowStep[],
    parallelGroups: import("../types/CtrlYokeTypes").ParallelGroupDefinition[] = []
  ): WorkflowStep[] {
    const diskTopology = normalizeParallelGroupTopology({
      steps: diskSteps,
      parallelGroups,
    });
    // Every queue created by the current runtime already has IDs. The helper
    // also repairs test/legacy state where a runtime update replaced the
    // metadata object, and supplies the explicit index fallback needed to read
    // older working files that predate stepId.
    const memorySteps = ensureStepIds(this.state.steps);
    const identifiedDiskSteps = ensureStepIds(diskTopology.steps, memorySteps);
    const memoryById = new Map<
      string,
      { step: WorkflowStep; result?: PromptResult; index: number }
    >();
    for (const [index, step] of memorySteps.entries()) {
      const stepId = step._runtime?.stepId;
      if (stepId !== undefined) {
        memoryById.set(stepId, {
          step,
          result: this.state.results[index],
          index,
        });
      }
    }

    const sameDefinition = (left: WorkflowStep, right: WorkflowStep) =>
      isDeepStrictEqual(
        stripStepRuntime([left])[0],
        stripStepRuntime([right])[0]
      );

    // A missing disk ID is the only case where identity is inferred by index.
    // If memory also lacks an ID, keep the old structural sanity check so an
    // inserted or shifted legacy step cannot inherit a sibling's runtime. A
    // current queue with IDs can safely backfill an older disk snapshot by
    // position; there is no content-hash relocation in either path.
    const memoryMatchFor = (
      diskStep: WorkflowStep,
      index: number
    ):
      | { step: WorkflowStep; result?: PromptResult; index: number }
      | undefined => {
      const memoryMatch = memoryById.get(diskStep._runtime?.stepId ?? "");
      if (!memoryMatch) {
        return undefined;
      }
      const diskHadId = diskSteps[index]?._runtime?.stepId !== undefined;
      const memoryHadId =
        this.state.steps[memoryMatch.index]?._runtime?.stepId !== undefined;
      if (
        !diskHadId &&
        !memoryHadId &&
        !sameDefinition(diskStep, memoryMatch.step)
      ) {
        return undefined;
      }
      return memoryMatch;
    };

    // Disk owns order and topology. Memory contributes runtime metadata for
    // every matching step. It is also authoritative for a pending reset that
    // intentionally retains only stepId (for example, a restart after a
    // completed run); allowing stale terminal disk runtime to win would make
    // the next execution skip that step again.
    const mergedSteps = identifiedDiskSteps.map((diskStep, index) => {
      const memoryMatch = memoryMatchFor(diskStep, index);
      if (!memoryMatch) {
        return diskStep;
      }
      const memoryRuntime = memoryMatch.step._runtime;
      const diskRuntime = diskStep._runtime;
      const runtime = memoryRuntime ?? diskRuntime;
      return runtime ? { ...diskStep, _runtime: runtime } : diskStep;
    });

    // Keep the existing array/count contract, but define novelty by identity
    // instead of position or prompt text. This means duplicate prompt text can
    // never alias a different step's session.
    const newStepsFromDisk = identifiedDiskSteps.filter(
      (diskStep, index) => memoryMatchFor(diskStep, index) === undefined
    );

    // Results use exactly the same identity lookup as runtime metadata. A
    // started sibling therefore keeps condition summaries after a reorder or
    // removal of unrelated pending work.
    const newResults: PromptResult[] = identifiedDiskSteps.map(
      (step, index) => {
        const memoryMatch = memoryMatchFor(step, index);
        if (memoryMatch?.result) {
          return {
            ...memoryMatch.result,
            prompt: isScriptStep(step) ? step.script : step.prompt,
          };
        }
        const content = isScriptStep(step) ? step.script : step.prompt;
        return {
          prompt: content,
          status: STEP_STATUS.PENDING,
          timestamp: new Date(),
        };
      }
    );

    const identifiedSteps = ensureStepIds(mergedSteps, memorySteps);
    this.state.steps = identifiedSteps;
    this.state.parallelGroups = diskTopology.parallelGroups;
    if (this.workflowFile) {
      this.workflowFile = {
        ...this.workflowFile,
        steps: [...identifiedSteps],
        parallelGroups: diskTopology.parallelGroups,
      };
    }
    this.state.results = newResults;
    return newStepsFromDisk;
  }

  /**
   * Merge steps from working file disk into current queue (for MCP appends during execution)
   * This preserves execution state (currentIndex, status, results) while adding new steps
   * @returns Number of new steps merged (-1 if error)
   */
  public async mergeStepsFromDisk(): Promise<number> {
    if (!this.state.workingFilePath) {
      Log.warn("[PromptQueue] mergeStepsFromDisk: No working file path set");
      return -1;
    }

    try {
      // Read working file from disk
      const workingFile = await this.readWorkingFile(
        this.state.workingFilePath
      );
      const diskSteps = workingFile.steps || [];

      Log.trace(
        `[PromptQueue] mergeStepsFromDisk: Disk has ${diskSteps.length} steps, memory has ${this.state.steps.length} steps`
      );

      const newStepsFromDisk = this.mergeDiskSteps(
        diskSteps,
        workingFile.parallelGroups
      );

      if (newStepsFromDisk.length === 0) {
        Log.trace("[PromptQueue] mergeStepsFromDisk: No new steps found");
        return 0;
      }

      Log.info(
        `[PromptQueue] mergeStepsFromDisk: Found ${newStepsFromDisk.length} new steps from disk (MCP append), merging into queue`
      );

      this.onDiskStepsMergedEmitter.fire(newStepsFromDisk);

      // Update queue extension tracking
      this.state.queueExtensions++;
      this.state.lastReloadTime = Date.now();

      // Emit state change so dashboard updates
      this.emitStateChange();

      return newStepsFromDisk.length;
    } catch (error) {
      Log.error(
        "[PromptQueue] mergeStepsFromDisk: Failed to read working file",
        error as Error
      );
      return -1;
    }
  }

  /**
   * Append prompts to the current queue without clearing state
   * This method now uses working file operations for persistence
   * @param prompts - Prompts to append
   * @param source - Description of append source (e.g., filename or "MCP")
   * @param position - Where to insert prompts:
   *   - QUEUE_POSITION.NEXT: After current prompt (paused/running)
   *   - QUEUE_POSITION.BEFORE_CURRENT: Before current prompt (stopped/idle)
   *   - QUEUE_POSITION.END: At end of queue (default)
   * @throws Error if queue is in invalid state for appending
   */
  public async appendSteps(
    steps: WorkflowStep[],
    source: string = "User append",
    position: QueuePosition = QUEUE_POSITION.END,
    parallelGroups: import("../types/CtrlYokeTypes").ParallelGroupDefinition[] = []
  ): Promise<void> {
    if (!this.canAppend()) {
      throw new Error("Cannot append: Queue is in cancelled or error state");
    }

    // Serialize state mutations + file write through WorkingFileManager's operation queue
    await this.workingFileManager.runInQueue(async () => {
      const previousSteps = this.state.steps;
      const requestedIndex = resolveQueueInsertIndex(
        position,
        this.state.currentIndex,
        this.state.steps.length,
        this.state.parallelGroups
      );
      const identifiedSteps = ensureStepIds([
        ...this.state.steps,
        ...steps,
      ]).slice(this.state.steps.length);
      const placement = resolveParallelGroupInsertIndex(
        {
          steps: this.state.steps,
          parallelGroups: this.state.parallelGroups,
        },
        requestedIndex,
        PARALLEL_GROUP_INSERT_POSITIONS.AFTER
      );
      const insertIndex = placement.insertedIndex;

      // Insert steps at the specified position
      const identifiedTopology = insertParallelGroupTopology(
        {
          steps: this.state.steps,
          parallelGroups: this.state.parallelGroups,
        },
        requestedIndex,
        { steps: identifiedSteps, parallelGroups }
      );
      assertStartedStepPositionsPreserved(
        previousSteps,
        identifiedTopology.steps,
        "insert"
      );
      this.state.steps = identifiedTopology.steps;
      this.state.parallelGroups = identifiedTopology.parallelGroups;

      // Create new results for the inserted steps
      const newResults: PromptResult[] = steps.map((step) => ({
        prompt: isScriptStep(step) ? step.script : step.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      }));

      // Insert results at the same position
      this.state.results.splice(insertIndex, 0, ...newResults);

      Log.info(
        `[PromptQueue] appendSteps: preserving runtime ownership (current: ${this.stateMachine.status}, completed count: ${this.state.completedIndices.size})`
      );

      this.bumpDefinitionRevision();
      this.workflowFile = this.workflowFile
        ? {
            ...this.workflowFile,
            steps: [...this.state.steps],
            parallelGroups: this.state.parallelGroups,
          }
        : this.workflowFile;
      this.emitStateChange();

      // This is an intentional local definition mutation. The in-memory queue
      // already contains the append, so do not reconcile against the stale
      // pre-append disk snapshot and let disk-authoritative merge replace it.
      await this.workingFileManager.updateWorkingFileDirect(true);
      Log.info(
        `[PromptQueue] Working file updated. Appended ${steps.length} steps from: ${source} at position: ${position}`
      );
    });
  }

  /** Append a new pending member to an existing parallel group. */
  public async appendParallelGroupMember(
    group: string | number,
    step: WorkflowStep
  ): Promise<{ stepIndex: number; stepId?: string }> {
    return this.applyParallelGroupMemberInsertion(
      "append parallel group member",
      step,
      (topology) => topology.steps.length,
      (topology, identifiedStep) =>
        appendParallelGroupMember(topology, group, identifiedStep),
      undefined
    );
  }

  /** Promote an existing queue step and a new sibling into a parallel group. */
  public async promoteStepToParallelGroup(
    stepIndex: number,
    step: WorkflowStep,
    options?: { failFast?: boolean }
  ): Promise<{ stepIndex: number; stepId?: string }> {
    if (stepIndex < 0 || stepIndex >= this.state.steps.length) {
      throw new Error(`Invalid prompt index: ${stepIndex}`);
    }
    return this.applyParallelGroupMemberInsertion(
      "promote step to parallel group",
      step,
      () => stepIndex + 1,
      (topology, identifiedStep) =>
        promoteStepToParallelGroup(
          topology,
          stepIndex,
          identifiedStep,
          options
        ),
      (topology) =>
        topology.parallelGroups.find(
          (candidate) =>
            stepIndex >= candidate.startIndex && stepIndex <= candidate.endIndex
        )?.id
    );
  }

  /**
   * Shared read-modify-write for the two parallel-group member insertions.
   *
   * Runs inside the working-file operation queue and persists with
   * `updateWorkingFileDirect`, exactly like `insertStepAfterIndex`: the whole
   * transform must be atomic against a concurrent MCP append, and the
   * disk-authoritative merge would otherwise rebuild the queue from the
   * pre-insert snapshot and drop the member that was just added.
   */
  private async applyParallelGroupMemberInsertion(
    operation: string,
    step: WorkflowStep,
    resolveGuardIndex: (topology: ParallelGroupTopology) => number,
    transform: (
      topology: ParallelGroupTopology,
      identifiedStep: WorkflowStep
    ) => ParallelGroupTopology,
    getActiveGroupId?: (topology: ParallelGroupTopology) => string | undefined
  ): Promise<{ stepIndex: number; stepId?: string }> {
    if (!this.canAppend()) {
      throw new Error(
        `Cannot ${operation}: Queue is in cancelled or error state`
      );
    }

    let insertion: { stepIndex: number; stepId?: string } | undefined;
    await this.workingFileManager.runInQueue(async () => {
      const previousSteps = this.state.steps;
      const topology = normalizeParallelGroupTopology({
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      });
      const identifiedStep = ensureStepIds([...topology.steps, step]).at(-1)!;
      const guardIndex = resolveGuardIndex(topology);
      this.assertPendingRewindSuffixIndex(guardIndex, operation);
      this.assertEditableDuringExecution(guardIndex, operation);
      assertStepMutable(identifiedStep, operation);

      const nextTopology = transform(topology, identifiedStep);
      assertStartedStepPositionsPreserved(
        previousSteps,
        nextTopology.steps,
        operation
      );
      const insertIndex = nextTopology.steps.indexOf(identifiedStep);
      if (insertIndex < 0) {
        throw new Error(
          `Parallel group member was not inserted (${operation})`
        );
      }

      const activeGroupId = getActiveGroupId?.(nextTopology);
      if (
        activeGroupId &&
        this.state.currentIndex === guardIndex - 1 &&
        this.stateMachine.status === EXECUTION_STATES.RUNNING
      ) {
        this.activeParallelGroupRuntime = {
          groupId: activeGroupId,
          admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
        };
      }

      this.state.steps = nextTopology.steps;
      this.state.parallelGroups = nextTopology.parallelGroups;
      this.state.results.splice(insertIndex, 0, {
        prompt: isScriptStep(identifiedStep)
          ? identifiedStep.script
          : identifiedStep.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      });
      if (insertIndex < this.state.currentIndex) {
        this.state.currentIndex += 1;
      }
      if (this.state.completedIndices.size > 0) {
        this.state.completedIndices = new Set(
          Array.from(this.state.completedIndices, (entry) => {
            const index = parseInt(entry, 10);
            return String(index >= insertIndex ? index + 1 : index);
          })
        );
      }
      this.bumpDefinitionRevision();
      this.workflowFile = this.workflowFile
        ? {
            ...this.workflowFile,
            steps: [...this.state.steps],
            parallelGroups: this.state.parallelGroups,
          }
        : this.workflowFile;
      this.emitStateChange();
      await this.workingFileManager.updateWorkingFileDirect(true);
      Log.info(
        `[PromptQueue] ${operation} at index ${insertIndex} (definitionRevision=${this.state.definitionRevision})`
      );
      insertion = {
        stepIndex: insertIndex,
        stepId: identifiedStep._runtime?.stepId,
      };
    });
    return insertion!;
  }

  /**
   * Insert a single step immediately after an existing queue index.
   * Shifts currentIndex/completedIndices as needed so the currently-selected
   * execution position continues to point at the same logical step.
   */
  public async insertStepAfterIndex(
    afterIndex: number,
    step: WorkflowStep,
    source: string = "Clipboard paste"
  ): Promise<void> {
    if (!this.canAppend()) {
      throw new Error(
        "Cannot insert step: Queue is in cancelled or error state"
      );
    }

    const queueLength = this.state.steps.length;
    const isEmptyInsert = queueLength === 0 && afterIndex === -1;
    const isValidExistingIndex =
      queueLength > 0 && afterIndex >= 0 && afterIndex < queueLength;

    if (!isEmptyInsert && !isValidExistingIndex) {
      throw new Error(`Invalid insert index: ${afterIndex}`);
    }
    this.assertPendingRewindSuffixIndex(afterIndex + 1, "insert");
    // During execution an insert must land strictly after the running step so it
    // cannot shift the running/completed region (insertIndex = afterIndex + 1).
    this.assertEditableDuringExecution(afterIndex + 1, "insert");

    await this.workingFileManager.runInQueue(async () => {
      const previousSteps = this.state.steps;
      const topology = {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      };
      const requestedIndex = afterIndex + 1;
      const placement = resolveParallelGroupInsertIndex(
        topology,
        requestedIndex,
        PARALLEL_GROUP_INSERT_POSITIONS.AFTER
      );
      const insertIndex = placement.insertedIndex;
      const identifiedStep = ensureStepIds([...this.state.steps, step]).at(-1)!;
      const nextTopology = insertParallelGroupSteps(topology, requestedIndex, [
        identifiedStep,
      ]);
      assertStartedStepPositionsPreserved(
        previousSteps,
        nextTopology.steps,
        "insert"
      );
      this.state.steps = nextTopology.steps;
      this.state.parallelGroups = nextTopology.parallelGroups;
      this.state.results.splice(insertIndex, 0, {
        prompt: isScriptStep(identifiedStep)
          ? identifiedStep.script
          : identifiedStep.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      });

      // Only an insert strictly inside the completed prefix shifts the pointer.
      // An insert *at* `currentIndex` (reachable while paused or during a pending
      // rewind, where `currentIndex` is a not-yet-started step) must leave the
      // pointer alone so the inserted step is the next one to run — shifting it
      // would push the new step into the already-consumed region and skip it.
      if (insertIndex < this.state.currentIndex) {
        this.state.currentIndex += 1;
      }

      if (this.state.completedIndices.size > 0) {
        const updated = new Set<string>();
        for (const entry of this.state.completedIndices) {
          const index = parseInt(entry, 10);
          updated.add(String(index >= insertIndex ? index + 1 : index));
        }
        this.state.completedIndices = updated;
      }

      this.bumpDefinitionRevision();
      this.workflowFile = this.workflowFile
        ? {
            ...this.workflowFile,
            steps: [...this.state.steps],
            parallelGroups: this.state.parallelGroups,
          }
        : this.workflowFile;
      this.emitStateChange();
      // Intentional local definition mutation — same reasoning as `appendSteps`.
      // The merge in `updateWorkingFileDirect` is disk-authoritative for order
      // and topology, so letting it run here would rebuild the queue from the
      // pre-insert disk snapshot and drop the step that was just inserted.
      await this.workingFileManager.updateWorkingFileDirect(true);
      Log.info(
        `[PromptQueue] Inserted step from ${source} after index ${afterIndex} (insertIndex=${insertIndex})`
      );
    });
  }

  /**
   * Check if queue can accept appended prompts
   * @returns true if queue state allows appending
   */
  public canAppend(): boolean {
    return this.stateMachine.status !== EXECUTION_STATES.CANCELLING;
  }

  // ==================== Working File Operations (delegated to WorkingFileManager) ====================

  /**
   * Create working file from original prompt file
   * @param nameForFile Display name or file path used to generate the working file's filename
   * @param prompts Prompts to store in working file
   * @param workspaceFolderPath Path to the current workspace folder root
   * @param originalFilePath The true source file path (if any). Only set for file-based workflows;
   *   leave undefined for ephemeral/dashboard-created workflows so the save dialog defaults correctly.
   * @returns Path to created working file
   */
  public async createWorkingFile(
    nameForFile: string,
    prompts: WorkflowStep[],
    workspaceFolderPath: string,
    originalFilePath?: string,
    options?: WorkflowLineageCreationOptions,
    parallelGroups: import("../types/CtrlYokeTypes").ParallelGroupDefinition[] = []
  ): Promise<string> {
    this.workingFileWorkspaceRoot = workspaceFolderPath;
    // Compute workflow name and store back into state so loadPrompts preserves it
    const computedWorkflowName =
      this.state.workflowName || PromptQueue.extractWorkflowName(nameForFile);
    this.state.workflowName = computedWorkflowName;
    const identifiedPrompts = ensureStepIds(prompts);
    prompts.splice(0, prompts.length, ...identifiedPrompts);

    const { workingFilePath, workflowKey } =
      await this.workingFileManager.createWorkingFile(
        nameForFile,
        prompts,
        workspaceFolderPath,
        computedWorkflowName,
        originalFilePath,
        options,
        parallelGroups
      );

    // Update queue state with working file path and lineage identity
    this.state.workingFilePath = workingFilePath;
    this.state.workflowKey = workflowKey;
    this.state.runRef = undefined;
    this.state.definitionRevision = 1;
    this.emitStateChange();

    return workingFilePath;
  }

  /**
   * Promotes the lineage's draft (or previous run) into a freshly allocated run, using
   * the queue's current in-memory definition/runtime as the new run's starting state.
   * Returns `null` if this queue has no lineage yet (e.g. a manual-run source file that
   * was never loaded through `createWorkingFile`).
   */
  public async promoteToNewRun(
    workspaceFolderPath: string,
    startedAt: number
  ): Promise<{
    workingFilePath: string;
    runRef: RunRef;
    runId: number;
    runDir: string;
    stagingRunDir: string;
    stagingWorkingFilePath: string;
    allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun;
  } | null> {
    this.workingFileWorkspaceRoot = workspaceFolderPath;
    const workflowKey = this.state.workflowKey;
    if (!workflowKey) {
      return null;
    }

    const identifiedSteps = ensureStepIds(this.state.steps);
    this.state.steps = identifiedSteps;
    if (this.workflowFile) {
      this.workflowFile = { ...this.workflowFile, steps: [...identifiedSteps] };
    }

    const result = await this.workingFileManager.promoteToNewRun(
      workspaceFolderPath,
      workflowKey,
      startedAt
    );

    this.state.workingFilePath = result.workingFilePath;
    this.state.runRef = result.runRef;
    // A promoted run starts its own definition-revision sequence (mirrors the
    // hardcoded `definitionRevision: 1` WorkingFileManager.promoteToNewRun writes).
    this.state.definitionRevision = 1;
    this.state.tokenTotals = undefined;
    this.emitStateChange();

    return {
      workingFilePath: result.workingFilePath,
      runRef: result.runRef,
      runId: result.runId,
      runDir: result.runDir,
      stagingRunDir: result.stagingRunDir,
      stagingWorkingFilePath: result.stagingWorkingFilePath,
      allocation: result.allocation,
    };
  }

  /**
   * Read working file
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.workingFileManager.readWorkingFile(workingFilePath);
  }

  /**
   * Update working file with current queue state
   * This is called after prompt completion, append, or any queue modification
   * @param skipMerge If true, writes memory state directly without checking for MCP changes (used for deletes/updates)
   */
  public async updateWorkingFile(skipMerge: boolean = false): Promise<void> {
    return this.workingFileManager.updateWorkingFile(skipMerge);
  }

  /** Persist a typed patch to the disk-authoritative worktree runtime block. */
  public async updateWorktreeRuntime(
    patch: WorkingFileWorktreeRuntimePatch
  ): Promise<void> {
    return this.workingFileManager.updateWorktreeRuntime(patch);
  }

  /** Persist a durable notice for an inherited worktree default degradation. */
  public async updateWorktreeNotice(notice: string): Promise<void> {
    return this.workingFileManager.updateWorktreeNotice(notice);
  }

  /**
   * Get runtime state for workflow-level finalStep execution.
   */
  public getFinalStepRuntime(): FinalStepRuntimeState | undefined {
    return this.finalStepRuntime ? { ...this.finalStepRuntime } : undefined;
  }

  /**
   * Persist the next final-step loop number before an explicit continuation
   * reaches the final phase.  The response/session array is deliberately
   * retained: it belongs to the preserved prefix of this run.
   */
  public async prepareFinalStepContinuation(
    nextLoopIndex: number
  ): Promise<void> {
    if (
      !this.finalStepRuntime ||
      nextLoopIndex <= this.finalStepRuntime.loopCount
    ) {
      return;
    }
    this.finalStepRuntime = {
      ...this.finalStepRuntime,
      phase: FINAL_STEP_PHASES.QUEUE,
      loopCount: nextLoopIndex,
      status: STEP_STATUS.COMPLETED,
    };
    await this.updateWorkingFile();
  }

  /**
   * Applies a durable rewind already written by `WorkingFileManager` to the
   * live queue. It deliberately does not persist: the manager has just made
   * the disk transition atomically under the lineage/working-file locks.
   */
  public applyPendingRewind(
    fromStepIndex: number,
    baseDefinitionRevision: number,
    definitionRevision: number,
    preservePausedState: boolean
  ): void {
    const topology = normalizeParallelGroupTopology({
      steps: this.state.steps,
      parallelGroups: this.state.parallelGroups,
    });
    const boundary = snapParallelGroupStartPosition(topology, fromStepIndex);
    this.state.steps.forEach((step, index) => {
      if (index >= boundary) {
        this.archiveStepRuntime(step, index, "beginPendingRewind");
      }
    });
    this.state.steps = topology.steps.map((step, index) =>
      index < boundary
        ? stripViewOnlyWorkflowStepFields(step)
        : stripViewOnlyWorkflowStepFields(resetStepRuntimeForRewind(step))
    );
    this.state.results = this.state.results.map((result, index) =>
      index < boundary ? result : { ...result, status: STEP_STATUS.PENDING }
    );
    this.state.parallelGroups = topology.parallelGroups;
    this.state.currentIndex = boundary;
    this.state.completedIndices = new Set<string>(
      Array.from({ length: boundary }, (_, index) => String(index))
    );
    this.state.definitionRevision = definitionRevision;
    this.state.pendingRewind = {
      fromStepIndex: boundary,
      baseDefinitionRevision,
    };
    if (this.workflowFile) {
      this.workflowFile = {
        ...this.workflowFile,
        steps: [...this.state.steps],
        parallelGroups: this.state.parallelGroups,
      };
    }
    if (!preservePausedState) {
      this.stateMachine.reset();
    }
    this.emitStateChange();
  }

  /**
   * Forget an in-memory pending rewind once it can no longer be pending: the
   * continuation was committed on disk, or this run is starting to execute.
   * Nothing is written here — every runtime write serializes `pendingRewind`
   * from memory, so the next one persists the cleared state. Leaving it set
   * is what let a stale instance write the flag back into a committed run.
   */
  public clearPendingRewind(): void {
    if (!this.state.pendingRewind) {
      return;
    }
    Log.debug(
      `[PromptQueue] Cleared in-memory pendingRewind (fromStepIndex=${this.state.pendingRewind.fromStepIndex})`
    );
    this.state.pendingRewind = undefined;
  }

  /**
   * Persist durable runtime state for workflow-level finalStep execution.
   */
  public async setFinalStepRuntime(
    runtime: FinalStepRuntimeState | undefined
  ): Promise<void> {
    this.finalStepRuntime = runtime;
    await this.updateWorkingFile();
  }

  /**
   * Store finalStep output in the active-only cache. The timeline owns durability.
   *
   * @param loopIndex 0-based loop index (from ExecutionTarget.loopIndex)
   * @param text Plain-text AI response from this loop
   */
  public storeFinalStepResponseText(loopIndex: number, text: string): void {
    this.finalStepResponseCache.set(loopIndex, text);
  }

  /**
   * Append follow-up text to an active finalStep cache entry.
   *
   * @param loopIndex 0-based loop index (from ExecutionTarget.loopIndex)
   * @param additionalText Extracted text from the resumed follow-up events
   */
  public appendFinalStepResponseText(
    loopIndex: number,
    additionalText: string
  ): void {
    if (!additionalText) {
      return;
    }
    this.storeFinalStepResponseText(
      loopIndex,
      appendResponseText(
        this.finalStepResponseCache.get(loopIndex) ?? "",
        additionalText
      )
    );
  }

  /**
   * Restore only the response/script values an active executor needs after a
   * process restart. This deliberately does not write the working file.
   */
  public hydrateActiveRuntimeOutputCache(
    queueEntries: readonly ResolvedRuntimeOutputCacheEntry[],
    finalStepResponseTexts: ReadonlyMap<number, string>
  ): void {
    for (const entry of queueEntries) {
      if (!this.state.steps[entry.stepIndex]) continue;
      this.cacheRuntimeOutput(entry.stepIndex, entry);
    }

    for (const [loopIndex, responseText] of finalStepResponseTexts) {
      this.storeFinalStepResponseText(loopIndex, responseText);
    }
  }

  /** Cache authoritative resolver output for the currently executing process only. */
  public cacheRuntimeOutput(
    stepIndex: number,
    output: Omit<ResolvedRuntimeOutputCacheEntry, "stepIndex">
  ): void {
    this.runtimeOutputCache.set(stepIndex, {
      ...this.runtimeOutputCache.get(stepIndex),
      ...output,
    });
  }

  private clearRuntimeOutputCache(): void {
    this.runtimeOutputCache.clear();
    this.finalStepResponseCache.clear();
  }

  /**
   * Update workflow-level properties in the working file (atomic + serialized).
   */
  public async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.workingFileManager.updateWorkingFileProperties(
      properties,
      options
    );
  }

  /** Guard the next definition write against a stale addressed client snapshot. */
  public expectDefinitionRevision(revision: number): void {
    this.workingFileManager.expectDefinitionRevision(revision);
  }

  /**
   * Emit state change event
   */
  private emitStateChange(): void {
    this.onStateChanged.fire(this.getState());
  }

  /**
   * Bump the in-memory definition revision counter. Call from every step-definition
   * mutation (append/insert/replace/delete/reorder/property edit) — never for pure
   * runtime persistence (completion, pause/resume, session metadata).
   */
  private bumpDefinitionRevision(): void {
    this.state.definitionRevision = (this.state.definitionRevision ?? 1) + 1;
  }

  /**
   * Update an existing prompt in the queue
   * @param index - Prompt index (0-based)
   * @param updates - Partial PromptStep updates to apply
   * @throws Error if index is out of range
   */
  public async updatePrompt(
    index: number,
    updates: Partial<WorkflowStep>
  ): Promise<void> {
    if (index < 0 || index >= this.state.steps.length) {
      throw new Error(`Invalid prompt index: ${index}`);
    }
    this.assertPendingRewindSuffixIndex(index, "update");
    this.assertEditableDuringExecution(index, "edit");

    // Merge updates into existing step
    const nextTopology = replaceParallelGroupStep(
      {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      },
      index,
      {
        ...this.state.steps[index],
        ...updates,
      } as WorkflowStep
    );
    assertStartedStepPositionsPreserved(
      this.state.steps,
      nextTopology.steps,
      "edit"
    );
    this.state.steps = nextTopology.steps;
    this.state.parallelGroups = nextTopology.parallelGroups;
    this.workflowFile = this.workflowFile
      ? {
          ...this.workflowFile,
          steps: [...this.state.steps],
          parallelGroups: this.state.parallelGroups,
        }
      : this.workflowFile;

    this.bumpDefinitionRevision();

    // Persist to working file (skip merge to avoid undoing the update)
    await this.updateWorkingFile(true);

    // Emit state change
    this.emitStateChange();

    Log.debug(`[PromptQueue] Updated prompt at index ${index}`);
  }

  /**
   * Replace a step in the queue entirely (no merge).
   * Use this when the step type changes (e.g. PromptStep → ScriptStep) so stale
   * fields from the previous type are not carried over.
   * @param index - Step index (0-based)
   * @param step  - Replacement step
   * @throws Error if index is out of range
   */
  public async replaceStep(index: number, step: WorkflowStep): Promise<void> {
    if (index < 0 || index >= this.state.steps.length) {
      throw new Error(`Invalid prompt index: ${index}`);
    }
    this.assertPendingRewindSuffixIndex(index, "replace");
    this.assertEditableDuringExecution(index, "replace");
    const existingStepId = this.state.steps[index]._runtime?.stepId;
    const replacement: WorkflowStep =
      existingStepId === undefined
        ? step
        : { ...step, _runtime: { stepId: existingStepId } };
    const nextTopology = replaceParallelGroupStep(
      {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      },
      index,
      replacement
    );
    assertStartedStepPositionsPreserved(
      this.state.steps,
      nextTopology.steps,
      "replace"
    );
    this.state.steps = nextTopology.steps;
    this.state.parallelGroups = nextTopology.parallelGroups;
    this.workflowFile = this.workflowFile
      ? {
          ...this.workflowFile,
          steps: [...this.state.steps],
          parallelGroups: this.state.parallelGroups,
        }
      : this.workflowFile;
    this.bumpDefinitionRevision();
    await this.updateWorkingFile(true);
    this.emitStateChange();
    Log.debug(`[PromptQueue] Replaced step at index ${index}`);
  }

  /**
   * Delete a prompt from the queue
   * @param index - Prompt index (0-based)
   * @throws Error if index is out of range, or (while executing) if the step is
   *   the running step or an already-completed step — only the pending tail after
   *   the running step is deletable mid-run.
   */
  public async deletePrompt(index: number): Promise<void> {
    if (index < 0 || index >= this.state.steps.length) {
      throw new Error(`Invalid prompt index: ${index}`);
    }
    this.assertPendingRewindSuffixIndex(index, "delete");
    // While executing, only steps after the running step may be deleted;
    // completed steps and the running step stay locked.
    this.assertEditableDuringExecution(index, "delete");

    this.state.steps.forEach((step, stepIndex) => {
      this.archiveStepRuntime(step, stepIndex, "deletePrompt");
    });

    const previousSteps = this.state.steps;
    const nextTopology = deleteParallelGroupStep(
      {
        steps: this.state.steps,
        parallelGroups: this.state.parallelGroups,
      },
      index
    );
    if (this.isExecutionActive) {
      assertStartedStepPositionsPreserved(
        previousSteps,
        nextTopology.steps,
        "delete"
      );
    }
    this.state.steps = nextTopology.steps;
    this.state.parallelGroups = nextTopology.parallelGroups;
    this.workflowFile = this.workflowFile
      ? {
          ...this.workflowFile,
          steps: [...this.state.steps],
          parallelGroups: this.state.parallelGroups,
        }
      : this.workflowFile;

    // Update currentIndex if deletion affects it
    if (index < this.state.currentIndex) {
      this.state.currentIndex--;
    }

    // Update completedIndices to reflect the removed slot:
    // remove the deleted index and shift down all higher indices by 1.
    if (this.state.completedIndices.size > 0) {
      const updated = new Set<string>();
      for (const entry of this.state.completedIndices) {
        const n = parseInt(entry);
        if (n < index) {
          updated.add(entry);
        } else if (n > index) {
          updated.add(String(n - 1));
        }
        // n === index is dropped (the deleted prompt)
      }
      this.state.completedIndices = updated;
    }

    // Update results array to match
    if (this.state.results.length > index) {
      this.state.results.splice(index, 1);
    }

    this.bumpDefinitionRevision();

    // Persist to working file (skip merge to avoid undoing the delete)
    await this.updateWorkingFile(true);

    // Emit state change
    this.emitStateChange();

    Log.debug(`[PromptQueue] Deleted prompt at index ${index}`);
  }

  /**
   * Update workflow name in working file
   * @param workflowName - New workflow name
   */
  public async updateWorkflowName(workflowName: string): Promise<void> {
    this.assertNoPendingRewindWorkflowMutation("rename the workflow");
    this.syncWorkflowName(workflowName);
  }

  /**
   * Mirror the lineage descriptor's authoritative name into memory. Unlike
   * `updateWorkflowName` this is not a user rename, so it is not blocked by a
   * pending continuation — a reload that binds (or re-binds) a run with a
   * pending rewind must still be able to pick up the name it already has.
   */
  public syncWorkflowName(workflowName: string): void {
    this.state.workflowName = workflowName;
    this.emitStateChange();
    Log.debug(
      `[PromptQueue] Updated in-memory workflow name to: ${workflowName}`
    );
  }

  /**
   * Reorder the pending (not-yet-executed) prompts.
   * @param newPendingOrder Positions within the current pending slice (0-based)
   *   in the desired new order. These are slice-relative indices, not absolute
   *   indices into the full prompts array. Using absolute indices would break on
   *   the second reorder because state.steps has already been mutated.
   */
  async reorderPendingPrompts(
    newPendingOrder: number[],
    pendingGroups?: PendingParallelGroupRange[]
  ): Promise<void> {
    if (
      this.hasInFlightStep &&
      !this.state.pendingRewind &&
      newPendingOrder[0] !== 0
    ) {
      const currentStep = this.state.steps[this.state.currentIndex];
      assertStepMutable(currentStep, "reorder");
      // Legacy in-memory tests/files may advance the execution head before
      // the claim marker is reflected in the queue object.
      if (!hasStarted(currentStep)) {
        throw new Error(
          "Cannot reorder the currently executing step while the workflow is running"
        );
      }
    }
    // Serialize with the executor's own working-file writes (parity with
    // insert/delete) so a mid-run reorder cannot race a step-completion write.
    await this.workingFileManager.runInQueue(async () => {
      const currentIndex = this.state.currentIndex;
      const previousSteps = this.state.steps;
      const doneResults = this.state.results.slice(0, currentIndex);
      const pendingPrompts = this.state.steps.slice(currentIndex);
      const pendingResults = this.state.results.slice(currentIndex);
      const nextTopology = reorderParallelGroupPendingSteps(
        {
          steps: this.state.steps,
          parallelGroups: this.state.parallelGroups,
        },
        currentIndex,
        newPendingOrder,
        pendingGroups,
        this.hasInFlightStep
      );
      assertStartedStepPositionsPreserved(
        previousSteps,
        nextTopology.steps,
        "reorder"
      );
      const newPending = nextTopology.steps.slice(currentIndex);
      const newPendingResults = newPending.map((step) => {
        const sourceIndex = pendingPrompts.indexOf(step);
        if (sourceIndex < 0) {
          throw new Error("Pending reorder lost a step");
        }
        return pendingResults[sourceIndex];
      });
      this.state.steps = nextTopology.steps;
      this.state.parallelGroups = nextTopology.parallelGroups;
      this.state.results = [...doneResults, ...newPendingResults];
      this.workflowFile = this.workflowFile
        ? {
            ...this.workflowFile,
            steps: [...this.state.steps],
            parallelGroups: this.state.parallelGroups,
          }
        : this.workflowFile;
      this.bumpDefinitionRevision();
      this.emitStateChange();
      // Intentional local definition mutation — same reasoning as `appendSteps`.
      // A reorder is expressed entirely in memory, and the merge in
      // `updateWorkingFileDirect` treats disk as authoritative for both step
      // order and parallel-group topology, so running it here would restore
      // the pre-reorder disk snapshot and silently discard the move (and any
      // group the reorder created).
      await this.workingFileManager.updateWorkingFileDirect(true);
    });
  }

  /**
   * Undo a topology insertion when executor admission loses a race after the
   * queue mutation. The identity check prevents this rollback from removing a
   * later operation that reused the same array slot.
   */
  public async rollbackParallelGroupMemberInsertion(
    insertion: { stepIndex: number; stepId?: string },
    previousParallelGroups: readonly ParallelGroupDefinition[],
    previousActiveRuntime?: ActiveParallelGroupRuntime
  ): Promise<boolean> {
    let rolledBack = false;
    await this.workingFileManager.runInQueue(async () => {
      const insertedStep = this.state.steps[insertion.stepIndex];
      if (
        !insertedStep ||
        insertedStep._runtime?.stepId !== insertion.stepId ||
        insertion.stepIndex < this.state.currentIndex
      ) {
        return;
      }

      this.state.steps = [
        ...this.state.steps.slice(0, insertion.stepIndex),
        ...this.state.steps.slice(insertion.stepIndex + 1),
      ];
      this.state.results.splice(insertion.stepIndex, 1);
      this.state.parallelGroups = previousParallelGroups.map((group) => ({
        ...group,
      }));
      this.activeParallelGroupRuntime = previousActiveRuntime
        ? { ...previousActiveRuntime }
        : undefined;
      this.workflowFile = this.workflowFile
        ? {
            ...this.workflowFile,
            steps: [...this.state.steps],
            parallelGroups: this.state.parallelGroups,
          }
        : this.workflowFile;
      this.bumpDefinitionRevision();
      this.emitStateChange();
      await this.workingFileManager.updateWorkingFileDirect(true);
      rolledBack = true;
    });
    return rolledBack;
  }

  /**
   * Replace all prompts with the state restored by an undo/redo operation.
   * Rebuilds results/currentIndex from restored per-step runtime metadata.
   * Does NOT emit a state change event — the webview already has the correct state.
   * The working file watcher ignores changes in non-running states, so no re-broadcast occurs.
   */
  public async syncStepsForUndoRedo(
    newSteps: WorkflowStep[],
    parallelGroups?: import("../types/CtrlYokeTypes").ParallelGroupDefinition[]
  ): Promise<void> {
    const nextParallelGroups = parallelGroups ?? this.state.parallelGroups;
    this.assertPendingRewindUndoRedoSuffix(newSteps, nextParallelGroups);
    let restoredFromArchive = 0;
    const incomingWithRuntime = newSteps.filter((step) => step._runtime).length;

    this.state.steps.forEach((step, index) => {
      this.archiveStepRuntime(step, index, "syncStepsForUndoRedo");
    });

    // Preserve _runtime from existing steps when available, but also accept
    // _runtime from the restored undo/redo snapshot. That matters for redo after
    // undo removed a completed prompt: the deleted step has no same-index live
    // counterpart, so its runtime must come from the redo snapshot.
    const nextTopology = normalizeParallelGroupTopology({
      steps: newSteps,
      parallelGroups: nextParallelGroups,
    });
    const identifiedSteps = ensureStepIds(nextTopology.steps, this.state.steps);
    this.state.steps = identifiedSteps.map((newStep, i) => {
      const persistableStep = stripViewOnlyWorkflowStepFields(newStep);
      const suppressSuffixRuntime =
        this.state.pendingRewind !== undefined &&
        i >= this.state.pendingRewind.fromStepIndex;
      const runtimeSafeStep = suppressSuffixRuntime
        ? resetStepRuntimeForRewind(persistableStep)
        : persistableStep;
      const existing = this.state.steps[i];
      const existingRuntime =
        !suppressSuffixRuntime &&
        existing &&
        this.getStepIdentityKey(existing) ===
          this.getStepIdentityKey(runtimeSafeStep)
          ? existing._runtime
          : undefined;
      const archivedRuntime = suppressSuffixRuntime
        ? undefined
        : this.getArchivedRuntime(runtimeSafeStep, i);
      const runtime = this.mergeRuntimeMetadata(
        archivedRuntime,
        suppressSuffixRuntime ? undefined : runtimeSafeStep._runtime,
        existingRuntime
      );
      const persistableRuntime =
        this.stripHistoryOnlyRuntimeFieldsForUndoRedo(runtime);
      if (!existingRuntime && !runtimeSafeStep._runtime && archivedRuntime) {
        restoredFromArchive++;
      }
      if (persistableRuntime) {
        return { ...runtimeSafeStep, _runtime: persistableRuntime };
      }
      return runtimeSafeStep;
    });
    this.state.parallelGroups = nextTopology.parallelGroups;
    this.workflowFile = this.workflowFile
      ? {
          ...this.workflowFile,
          steps: [...this.state.steps],
          parallelGroups: this.state.parallelGroups,
        }
      : this.workflowFile;

    const restoredCurrentIndex = this.getCurrentIndexFromRuntime(
      this.state.steps
    );
    this.state.currentIndex = restoredCurrentIndex;
    this.state.completedIndices = new Set<string>(
      this.state.steps
        .map((step, index) =>
          step._runtime?.completedAt !== undefined ? String(index) : undefined
        )
        .filter((index): index is string => index !== undefined)
    );

    this.state.results = this.state.steps.map((step, index) => ({
      prompt: isScriptStep(step) ? step.script : step.prompt,
      status: this.getResultStatusFromRuntime(
        step,
        index,
        restoredCurrentIndex
      ),
      timestamp: new Date(),
    }));

    this.bumpDefinitionRevision();

    // Persist to working file (skip merge — we know exactly what we want)
    await this.updateWorkingFile(true);

    Log.debug(
      `[PromptQueue] syncStepsForUndoRedo: ${newSteps.length} steps, currentIndex=${restoredCurrentIndex}, ` +
        `incomingRuntime=${incomingWithRuntime}, restoredFromArchive=${restoredFromArchive}, archiveSize=${this.runtimeArchive.size}`
    );
  }

  private getCurrentIndexFromRuntime(steps: WorkflowStep[]): number {
    const firstPendingIndex = steps.findIndex(
      (step) => step._runtime?.completedAt === undefined
    );
    return firstPendingIndex === -1 ? steps.length : firstPendingIndex;
  }

  private assertPendingRewindSuffixIndex(
    index: number,
    operation: string
  ): void {
    const boundary = this.state.pendingRewind?.fromStepIndex;
    if (boundary !== undefined && index < boundary) {
      throw new Error(
        `Cannot ${operation} a preserved prefix step while a continuation is pending`
      );
    }
  }

  /**
   * True while execution owns the queue, i.e. the completed prefix
   * `[0, currentIndex)` belongs to a run in progress and must stay frozen.
   */
  private get isExecutionActive(): boolean {
    return ACTIVE_EXECUTION_STATES.has(this.stateMachine.status);
  }

  /**
   * True while a step is actually in flight, which is what makes the step at
   * `currentIndex` untouchable. PAUSED is deliberately excluded: a pause is only
   * ever confirmed at a step boundary (`WorkflowExecutor.confirmPauseAndStop`,
   * after `commitStepOutcomeAndAdvance()`), so a paused run's `currentIndex`
   * names the next PENDING step — nothing is executing. Treating PAUSED as
   * in-flight is what made "pause, then edit the next step" fail.
   *
   * The final-step phase is excluded for the same reason: while the final step
   * runs, `currentIndex` sits past the last queue step, so a step the final
   * step appends lands there without having started. It stays editable until
   * the executor flips the phase back to QUEUE and claims it.
   */
  private get hasInFlightStep(): boolean {
    const status = this.stateMachine.status;
    return (
      (status === EXECUTION_STATES.RUNNING ||
        status === EXECUTION_STATES.PAUSING ||
        status === EXECUTION_STATES.CANCELLING) &&
      this.finalStepRuntime?.phase !== FINAL_STEP_PHASES.FINAL_STEP
    );
  }

  /**
   * While the workflow is actively executing, only steps that have not started
   * yet may be edited: completed steps `[0, currentIndex)` are locked, and so is
   * `currentIndex` while a step is actually in flight. Steps after it are freely
   * editable so the pending tail can be reordered/edited/disabled mid-run. Once
   * PAUSED, `currentIndex` is itself a not-yet-started step and becomes editable
   * — editing the next step to run is the point of pausing. When idle, nothing
   * is executing (currentIndex is the start position) so no restriction applies.
   * This is defense-in-depth behind the dashboard gating — the queue must never
   * corrupt an executing run if a stale/rogue message arrives.
   */
  private assertEditableDuringExecution(
    index: number,
    operation: string
  ): void {
    // A pending rewind is a distinct suffix-editing mode: `currentIndex` is the
    // rewind boundary (a PENDING suffix step, not a running one), and prefix vs.
    // suffix editability is governed by `assertPendingRewindSuffixIndex`. Defer to
    // it entirely rather than treating the boundary as a locked running step.
    if (this.state.pendingRewind) return;
    if (!this.isExecutionActive) return;
    const step = this.state.steps[index];
    assertStepMutable(
      step,
      operation,
      index < this.state.currentIndex ? "completedPrefix" : undefined
    );
    if (
      index < this.state.currentIndex ||
      (index === this.state.currentIndex && this.hasInFlightStep)
    ) {
      // Legacy working files may predate per-step claim metadata. Keep the
      // execution-head boundary as a compatibility backstop until they claim.
      if (!hasStarted(step)) {
        throw new Error(
          index < this.state.currentIndex
            ? `Cannot ${operation} a completed step while the workflow is running`
            : `Cannot ${operation} the currently executing step`
        );
      }
    }
  }

  private assertNoPendingRewindWorkflowMutation(operation: string): void {
    if (this.state.pendingRewind) {
      throw new Error(
        `Cannot ${operation} while a continuation is pending; create a draft instead`
      );
    }
  }

  private assertPendingRewindUndoRedoSuffix(
    newSteps: WorkflowStep[],
    parallelGroups: import("../types/CtrlYokeTypes").ParallelGroupDefinition[]
  ): void {
    const boundary = this.state.pendingRewind?.fromStepIndex;
    if (boundary === undefined) {
      return;
    }
    if (newSteps.length < boundary) {
      throw new Error(
        "Cannot remove a preserved prefix step while a continuation is pending"
      );
    }
    const topology = normalizeParallelGroupTopology({
      steps: newSteps,
      parallelGroups,
    });
    for (let index = 0; index < boundary; index++) {
      const current = stripStepRuntime([this.state.steps[index]])[0];
      const incoming = stripStepRuntime([
        stripViewOnlyWorkflowStepFields(topology.steps[index]),
      ])[0];
      if (JSON.stringify(current) !== JSON.stringify(incoming)) {
        throw new Error(
          "Cannot modify a preserved prefix step while a continuation is pending"
        );
      }
    }
  }

  private getStepIdentityKey(step: WorkflowStep): string {
    const type = step.type ?? "prompt";
    const name = step.name ?? "";
    const text = isScriptStep(step) ? step.script : step.prompt;
    return `${type}\0${name}\0${text}`;
  }

  private getStepRuntimeArchiveKeys(
    step: WorkflowStep,
    index: number
  ): string[] {
    const identity = this.getStepIdentityKey(step);
    return [`${index}\0${identity}`, identity];
  }

  private archiveStepRuntime(
    step: WorkflowStep | undefined,
    index: number,
    reason: string
  ): void {
    if (!step?._runtime) {
      return;
    }

    const runtime = { ...step._runtime };
    for (const key of this.getStepRuntimeArchiveKeys(step, index)) {
      this.runtimeArchive.set(key, runtime);
    }
    Log.debug(
      `[PromptQueue] archived _runtime for undo (${reason}) index=${index}, archiveSize=${this.runtimeArchive.size}`
    );
  }

  private getArchivedRuntime(
    step: WorkflowStep,
    index: number
  ): PromptRuntimeMetadata | undefined {
    const boundary = this.state.pendingRewind?.fromStepIndex;
    if (boundary !== undefined && index >= boundary) {
      return undefined;
    }
    for (const key of this.getStepRuntimeArchiveKeys(step, index)) {
      const runtime = this.runtimeArchive.get(key);
      if (runtime) {
        return { ...runtime };
      }
    }
    return undefined;
  }

  private mergeRuntimeMetadata(
    ...candidates: Array<PromptRuntimeMetadata | undefined>
  ): PromptRuntimeMetadata | undefined {
    let merged: Partial<PromptRuntimeMetadata> | undefined;

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      merged ??= {};
      for (const [key, value] of Object.entries(candidate) as Array<
        [
          keyof PromptRuntimeMetadata,
          PromptRuntimeMetadata[keyof PromptRuntimeMetadata],
        ]
      >) {
        if (value !== undefined) {
          (merged as Record<keyof PromptRuntimeMetadata, unknown>)[key] = value;
        }
      }
    }

    return merged as PromptRuntimeMetadata | undefined;
  }

  private stripHistoryOnlyRuntimeFieldsForUndoRedo(
    runtime: PromptRuntimeMetadata | undefined
  ): PromptRuntimeMetadata | undefined {
    if (!runtime) {
      return undefined;
    }

    // Duration and context-window stats are canonical in output history
    // (events.jsonl / CliOutput tokens). They may be present in webview undo
    // snapshots because the UI decorates steps from history, but undo/redo
    // sync should not introduce them into the working file when normal
    // execution does not persist them there.
    const {
      elapsed: _elapsed,
      contextWindowUsed: _contextWindowUsed,
      contextWindowSize: _contextWindowSize,
      ...persistableRuntime
    } = runtime;
    void _elapsed;
    void _contextWindowUsed;
    void _contextWindowSize;

    return Object.keys(persistableRuntime).length > 0
      ? (persistableRuntime as PromptRuntimeMetadata)
      : undefined;
  }

  private getResultStatusFromRuntime(
    step: WorkflowStep,
    index: number,
    currentIndex: number
  ): (typeof STEP_STATUS)[keyof typeof STEP_STATUS] {
    if (step._runtime?.completedAt !== undefined) {
      const terminal = step._runtime.terminalStatus;
      return terminal === PROMPT_TERMINAL_STATUS.SKIPPED
        ? STEP_STATUS.SKIPPED
        : terminal === PROMPT_TERMINAL_STATUS.CANCELLED
          ? STEP_STATUS.CANCELLED
          : terminal === PROMPT_TERMINAL_STATUS.FAILED
            ? STEP_STATUS.FAILED
            : STEP_STATUS.COMPLETED;
    }

    return index === currentIndex &&
      this.stateMachine.status === EXECUTION_STATES.RUNNING
      ? STEP_STATUS.SENT
      : STEP_STATUS.PENDING;
  }
}
