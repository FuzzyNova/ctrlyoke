import type { WorkflowInstance } from "../core/WorkflowInstance";
import type { PromptQueue } from "../core/PromptQueue";
import { resolveStepHarnessAndModel } from "../types/ExecutionPropertyResolver";
import {
  isPromptStep,
  isScriptStep,
  type HarnessId,
  type ParallelGroupDefinition,
} from "../types/CtrlYokeTypes";
import {
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { formatFinalPassLabel } from "../utils/FinalStepLabels";
import { outputTargetKey } from "../utils/OutputTargetKeys";
import {
  parseWorkingFileAddressFromPath,
  workflowNameFromKey,
} from "../utils/WorkflowPaths";
import { extractWorkflowName } from "../utils/WorkflowName";
import { CliAttemptTally } from "./CliAttemptTally";
import { settleCliParallelGroupMember } from "./CliParallelGroupTally";
import {
  applyCliLinePrefix,
  CliTerminalFormatter,
  type CliOutputTarget,
} from "./CliTerminalFormatter";
import type { CliTerminalOutputGate } from "./CliTerminalOutputGate";

/** What the reporter reads from a running workflow instance. */
export interface CliProgressSource extends Pick<
  WorkflowInstance,
  | "workflowName"
  | "getCurrentPromptFilePath"
  | "onTargetAttemptStart"
  | "onTargetAttemptComplete"
  | "onPromptStart"
  | "onTargetScriptOutput"
  | "onTargetStreamingEvents"
  | "onTargetStreamingChunk"
  | "onWorkflowStatusMessage"
> {
  readonly promptQueue: Pick<
    PromptQueue,
    "getState" | "getWorkflowFile" | "onDidChangeState"
  >;
}

/** Harness/model a prompt header falls back to when neither step nor workflow names one. */
export interface CliProgressDefaults {
  harness: HarnessId;
  model?: string;
}

interface CliParallelGroupState {
  group: ParallelGroupDefinition;
  memberCount: number;
  started: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
}

/** One reported instance: its line prefix, output-stream keys and live state. */
interface CliReportedRun {
  readonly source: CliProgressSource;
  readonly defaults: CliProgressDefaults;
  /** Undefined for the root run, whose output is never prefixed. */
  readonly prefix: () => string | undefined;
  /** Namespaces a child's stream keys so they never collide with the root's. */
  readonly keyNamespace: string | undefined;
  readonly parallelGroups: Map<string, CliParallelGroupState>;
  readonly renderedFinalStepLabels: Set<number>;
  readonly subscriptions: Array<{ dispose(): void }>;
}

/**
 * The label a child run's progress is prefixed with: its workflow name, else
 * its file name without the ctrlyoke extension, else its lineage name (an
 * inline child has no file, and a continued child is loaded from its run's
 * working file, whose name says nothing about the workflow).
 */
export function getCliWorkflowLabel(source: CliProgressSource): string {
  const state = source.promptQueue.getState();
  const sourcePath = source.getCurrentPromptFilePath();
  return (
    source.workflowName?.trim() ||
    state.workflowName?.trim() ||
    source.promptQueue.getWorkflowFile().name?.trim() ||
    (sourcePath && !parseWorkingFileAddressFromPath(sourcePath)
      ? extractWorkflowName(sourcePath).trim()
      : "") ||
    (state.workflowKey ? workflowNameFromKey(state.workflowKey) : "") ||
    "workflow"
  );
}

/**
 * Streams a `ctrlyoke run` to the terminal: the root instance and every
 * sub-workflow child it launches go through the same handlers, and a child's
 * lines carry its own workflow label (`applyCliLinePrefix`). Every write goes
 * through the run's `CliTerminalOutputGate`. The run summary is not printed
 * here; `run` prints it once for the root.
 */
export class CliRunProgressReporter {
  private readonly attempts = new CliAttemptTally();
  private readonly runs: CliReportedRun[] = [];
  private nextChildId = 1;
  private released = false;

  constructor(private readonly outputGate: CliTerminalOutputGate) {}

  /** Report the root run, unprefixed. */
  subscribeRoot(
    source: CliProgressSource,
    defaults: CliProgressDefaults
  ): void {
    this.subscribe({
      source,
      defaults,
      prefix: () => undefined,
      keyNamespace: undefined,
    });
  }

  /**
   * Report a sub-workflow child, prefixed with its own workflow label, until
   * the returned subscription is disposed (when the child settles) or
   * `release`.
   */
  subscribeChild(
    source: CliProgressSource,
    defaults: CliProgressDefaults
  ): { dispose(): void } {
    this.subscribe({
      source,
      defaults,
      prefix: () => getCliWorkflowLabel(source),
      keyNamespace: `child-${this.nextChildId++}`,
    });
    return { dispose: () => this.unsubscribeChild(source) };
  }

  /**
   * Stop reporting a settled child and drop its live state. Its retry tally
   * stays, so `release` still prints it with the root's.
   */
  private unsubscribeChild(source: CliProgressSource): void {
    const index = this.runs.findIndex(
      (run) => run.source === source && run.keyNamespace !== undefined
    );
    if (index < 0) return;
    const [run] = this.runs.splice(index, 1);
    for (const subscription of run.subscriptions.splice(0))
      subscription.dispose();
  }

  /** Flush retry tallies and drop live state; idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const run of this.runs)
      for (const subscription of run.subscriptions.splice(0))
        subscription.dispose();
    this.outputGate.write(() => {
      for (const attempt of this.attempts.retriedGroups()) {
        CliTerminalFormatter.renderAttemptGroupSummary(
          attempt.stepName,
          attempt.attemptCount,
          attempt.totalElapsed,
          attempt.tokenStats
        );
      }
      this.attempts.clear();
      for (const run of this.runs) {
        run.parallelGroups.clear();
        run.renderedFinalStepLabels.clear();
      }
      CliTerminalFormatter.disposeEventStreams();
    });
  }

  private subscribe(
    options: Pick<
      CliReportedRun,
      "source" | "defaults" | "prefix" | "keyNamespace"
    >
  ): void {
    const run: CliReportedRun = {
      ...options,
      parallelGroups: new Map(),
      renderedFinalStepLabels: new Set(),
      subscriptions: [],
    };
    this.runs.push(run);
    const { source } = run;
    const write = (render: () => void) => this.outputGate.write(render);
    const keep = (subscription: { dispose(): void }): void => {
      run.subscriptions.push(subscription);
    };

    // Every attempt, queue step or finalStep pass, streams into a fresh
    // stream; the stream outlives completion so follow-up activity pairs.
    // Retry tallies cover every target, keyed like its output stream.
    keep(
      source.onTargetAttemptStart(({ target, attemptIndex }) =>
        write(() => {
          const outputTarget = this.outputTarget(run, target);
          CliTerminalFormatter.replaceEventStream(outputTarget);
          this.attempts.start(
            outputTarget.key,
            outputTarget.stepName,
            attemptIndex
          );
        })
      )
    );
    keep(
      source.onTargetAttemptComplete(({ target, stats }) =>
        write(() => {
          const outputTarget = this.outputTarget(run, target);
          this.attempts.complete(outputTarget.key, stats);
          CliTerminalFormatter.finishEventStream(outputTarget);
          CliTerminalFormatter.renderStats(stats);
        })
      )
    );
    keep(
      source.onPromptStart((data) =>
        write(() => {
          const prefixed = {
            ...data,
            stepName: applyCliLinePrefix(run.prefix(), data.stepName),
          };
          if (data.cliCommand !== undefined) {
            CliTerminalFormatter.renderPromptHeader(prefixed);
            return;
          }
          const header = {
            ...prefixed,
            ...this.promptExecutionDetails(run, data.stepIndex),
          };
          const state = this.parallelGroup(run, data.parallelGroupId);
          if (!state) {
            CliTerminalFormatter.renderPromptHeader(header);
            return;
          }
          if (!state.started.has(data.stepIndex)) {
            state.started.add(data.stepIndex);
            CliTerminalFormatter.renderParallelGroupHeader(
              state.group,
              state.memberCount,
              run.prefix()
            );
          }
          // A retry re-opens a branch that was tentatively settled by its prior
          // attempt. The tally therefore remains truthful while branches stream
          // concurrently into one linear terminal.
          state.completed.delete(data.stepIndex);
          state.failed.delete(data.stepIndex);
          this.renderParallelGroupProgress(run, state);
          CliTerminalFormatter.renderPromptHeader(header);
        })
      )
    );
    keep(
      source.promptQueue.onDidChangeState((queueState) =>
        write(() => {
          for (const state of run.parallelGroups.values()) {
            for (const stepIndex of state.started) {
              if (
                settleCliParallelGroupMember(
                  state,
                  stepIndex,
                  queueState.results[stepIndex]?.status
                )
              ) {
                this.renderParallelGroupProgress(run, state);
              }
            }
          }
        })
      )
    );
    keep(
      source.onTargetScriptOutput((data) =>
        write(() => {
          this.renderFinalStepLabel(run, data.target);
          CliTerminalFormatter.renderScriptOutput(
            data.output,
            this.outputTarget(run, data.target),
            data.output.scriptOutput
          );
        })
      )
    );
    keep(
      source.onTargetStreamingEvents((data) => {
        if (data.executionMode === EXECUTION_MODES.INTERACTIVE) return;
        write(() => {
          this.renderFinalStepLabel(run, data.target);
          CliTerminalFormatter.renderEvents(
            data.events,
            this.outputTarget(run, data.target, data.stepName)
          );
        });
      })
    );
    keep(
      source.onTargetStreamingChunk((data) => {
        if (data.executionMode === EXECUTION_MODES.INTERACTIVE) return;
        write(() => {
          this.renderFinalStepLabel(run, data.target);
          CliTerminalFormatter.renderStreamingChunk(
            data.chunk,
            this.outputTarget(run, data.target, data.stepName)
          );
        });
      })
    );
    keep(
      source.onWorkflowStatusMessage((data) =>
        write(() =>
          CliTerminalFormatter.renderStatusMessage(
            data.message,
            data.severity,
            run.prefix()
          )
        )
      )
    );
  }

  /** The terminal output target for one of a run's execution targets. */
  private outputTarget(
    run: CliReportedRun,
    target: OutputExecutionTarget,
    stepName?: string
  ): CliOutputTarget & { key: string } {
    const name = applyCliLinePrefix(
      run.prefix(),
      stepName ?? getCliOutputStepName(run.source, target)
    );
    const targetKey = outputTargetKey(target);
    const key = run.keyNamespace
      ? `${run.keyNamespace}:${targetKey}`
      : targetKey;
    return {
      stepIndex:
        target.kind === FINAL_STEP_PHASES.QUEUE
          ? target.stepIndex
          : target.loopIndex,
      stepName: name,
      key,
    };
  }

  private renderFinalStepLabel(
    run: CliReportedRun,
    target: OutputExecutionTarget
  ): void {
    if (
      target.kind !== FINAL_STEP_PHASES.FINAL_STEP ||
      run.renderedFinalStepLabels.has(target.loopIndex)
    ) {
      return;
    }
    run.renderedFinalStepLabels.add(target.loopIndex);
    CliTerminalFormatter.renderFinalStepLabel(target.loopIndex, run.prefix());
  }

  private promptExecutionDetails(
    run: CliReportedRun,
    stepIndex: number
  ): { harness?: HarnessId; model?: string } {
    const workflow = run.source.promptQueue.getWorkflowFile();
    const step = run.source.promptQueue.getState().steps[stepIndex];
    const promptStep = step && isPromptStep(step) ? step : undefined;
    return resolveStepHarnessAndModel(promptStep ?? {}, workflow, {
      ...run.defaults,
      modelForHarness: (harness) =>
        ConfigurationUtils.getModelForHarness(harness) || undefined,
    });
  }

  private parallelGroup(
    run: CliReportedRun,
    parallelGroupId: string | undefined
  ): CliParallelGroupState | undefined {
    if (!parallelGroupId) return undefined;
    const group = run.source.promptQueue
      .getState()
      .parallelGroups.find((candidate) => candidate.id === parallelGroupId);
    if (!group) return undefined;
    let state = run.parallelGroups.get(group.id);
    if (!state) {
      state = {
        group,
        memberCount: group.endIndex - group.startIndex + 1,
        started: new Set<number>(),
        completed: new Set<number>(),
        failed: new Set<number>(),
      };
      run.parallelGroups.set(group.id, state);
    }
    return state;
  }

  private renderParallelGroupProgress(
    run: CliReportedRun,
    state: CliParallelGroupState
  ): void {
    const running = Math.max(
      0,
      state.started.size - state.completed.size - state.failed.size
    );
    CliTerminalFormatter.renderParallelGroupProgress(
      state.group.id,
      running,
      state.completed.size,
      state.failed.size,
      run.prefix()
    );
  }
}

/** A step's display name for its terminal output stream. */
function getCliOutputStepName(
  source: CliProgressSource,
  target: OutputExecutionTarget
): string {
  const workflow = source.promptQueue.getWorkflowFile();
  const step =
    target.kind === FINAL_STEP_PHASES.QUEUE
      ? source.promptQueue.getState().steps[target.stepIndex]
      : workflow.finalStep;
  if (step?.name?.trim()) return step.name.trim();
  if (step && isScriptStep(step))
    return step.script.split(/\s+/)[0] ?? "script";
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `Step ${target.stepIndex + 1}`
    : formatFinalPassLabel(target.loopIndex + 1);
}
