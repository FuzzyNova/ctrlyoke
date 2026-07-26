import { create } from "zustand";
import { useState, useEffect, useRef } from "react";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import {
  EXECUTION_STATES,
  EXECUTION_PHASES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  type ExecutionState,
  type StepStatus,
  type FinalStepPhase,
  type PromptStep,
  type CliOutput,
  type RetryState,
  type ExecutionPhase,
  getStreamingChunkKey,
} from "../types/messages";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { isWorkflowRunning, isWorkflowActive } from "../utils/status";

/**
 * Webview-local WorkflowStep union: uses WebviewMessageTypes.PromptStep
 * to avoid _runtime type incompatibility with CtrlYokeTypes.PromptStep.
 */
export type WorkflowStep = PromptStep | ScriptStep;

/** Type guard for script steps (webview-local version) */
function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}
import type {
  OrderedHistoryEntry,
  OrderedCliHistoryEntry,
  OrderedStatusHistoryEntry,
  OutputExecutionTarget,
  WorkflowOutputHistory,
  WorkflowRunMetadata,
  StepOutput,
  WorkspaceSnapshot,
  UndoExecutionTarget,
  UndoRecord,
} from "@root/types/OutputHistoryTypes";
import type { UndoResult } from "../types/messages";
import { useUiStore } from "./uiStore";
import { WebviewLog } from "@utils/logger";
import { preserveReferences } from "@utils/structuralSharing";
import { CLI_EVENT_TYPES } from "../types/cliEvents";
import type { WorkflowProperties } from "./settingsStore";
import { normalizeCliEvents } from "@root/utils/CliEventNormalizer";

/**
 * Merge incoming structured events into an existing CliOutput array.
 * Consecutive TEXT or THINKING events of the same type (and same label) are
 * concatenated into a single event so the UI renders them as continuous text.
 */
function mergeStreamingEvents(existing: any[], incoming: any[]): any[] {
  const result = [...existing];
  for (const event of incoming) {
    if (
      event.type === CLI_EVENT_TYPES.TEXT ||
      event.type === CLI_EVENT_TYPES.THINKING
    ) {
      const last = result[result.length - 1];
      if (
        last &&
        last.type === event.type &&
        (event.type !== CLI_EVENT_TYPES.THINKING ||
          (last.data?.label ?? undefined) === (event.data?.label ?? undefined))
      ) {
        result[result.length - 1] = {
          ...last,
          data: {
            ...last.data,
            text: (last.data?.text || "") + (event.data?.text || ""),
          },
        };
        continue;
      }
    }
    result.push(event);
  }
  return normalizeCliEvents(result);
}

/**
 * Merge an incoming batch of streamed events into an existing CliOutput.
 *
 * When `existing` is already complete (`isStreaming: false`), the batch is
 * post-completion follow-up activity — a harness auto-resuming a backgrounded
 * task, or a human typing into the still-open terminal (see
 * `SessionActivityWatcher` / `WorkflowInstance.handleSessionActivityResumed`).
 * In that case: insert a one-time "follow-up" divider before the new content
 * (so later batches from the same follow-up burst just append past it), and
 * refresh the stats footer (elapsed/context window) so it doesn't go stale
 * while resumed activity streams in. `CONTEXT_WINDOW_SYNC` is an invisible
 * marker consumed here, never rendered as a row.
 *
 * When `existing` is still mid-flight (`isStreaming: true`), this is an
 * ordinary incremental append — no divider, no footer refresh (those only
 * apply once the step is actually done).
 */
function mergeResumedActivityIntoOutput(
  existing: CliOutput,
  incomingEvents: any[]
): CliOutput {
  const isFollowUp = existing.isStreaming === false;
  const contentEvents = incomingEvents.filter(
    (event) => event.type !== CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC
  );
  const latestContextWindowSync = [...incomingEvents]
    .reverse()
    .find((event) => event.type === CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC)
    ?.data as { used: number; size: number } | undefined;

  const existingStructured = existing.structured as any;
  const existingEvents = existingStructured?.events || [];
  const hasFollowUpDivider = existingEvents.some(
    (event: any) => event.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
  );

  const eventsToMerge =
    isFollowUp && contentEvents.length > 0 && !hasFollowUpDivider
      ? [
          {
            type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
            timestamp: Date.now(),
            data: { resumedAt: Date.now() },
          },
          ...contentEvents,
        ]
      : contentEvents;

  return {
    ...existing,
    structured: {
      ...existingStructured,
      events: mergeStreamingEvents(existingEvents, eventsToMerge),
      metadata: existingStructured?.metadata || {},
    },
    tokens:
      isFollowUp && latestContextWindowSync && existing.tokens
        ? {
            ...existing.tokens,
            contextWindowUsed: latestContextWindowSync.used,
            contextWindowSize: latestContextWindowSync.size,
          }
        : existing.tokens,
    elapsed:
      isFollowUp && existing.timestampMs != null
        ? (Date.now() - existing.timestampMs) / 1000
        : existing.elapsed,
  };
}

/**
 * Workflow state - Core workflow execution data
 */
interface WorkflowState {
  // Core workflow data
  fileName: string | null;
  workflowName: string | null;
  steps: WorkflowStep[];
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  finalStep: WorkflowStep | null;
  finalStepStatus: StepStatus | null;
  finalStepLoopCount: number;
  finalStepPhase: FinalStepPhase | null;

  // Live ordered output entries (queue + finalStep outputs and status messages)
  liveOrderedEntries: OrderedHistoryEntry[];
  liveSequence: number;
  retryStates: Record<number, RetryState>;

  // Streaming state (for incremental output)
  streamingChunks: Record<string, string>;
  finalStepStreamingChunks: Record<string, string>;

  // Self-contained history snapshot for the currently-viewed historical run.
  // When isViewingHistory=true (in uiStore), OutputSection renders from historyOutputs
  // instead of liveOrderedEntries. The live entries continue to be updated normally —
  // history browsing has zero impact on live capture.
  historyOutputs: {
    orderedEntries: OrderedHistoryEntry[];
    promptOutputs: Record<number, StepOutput>;
    finalStepOutputs?: Record<number, StepOutput>;
    runMetadata: WorkflowRunMetadata;
  } | null;
  /** Live workspace snapshots keyed by stepIndex (queue) */
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  /** Live workspace snapshots keyed by loopIndex (finalStep) */
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  /** Undo result state keyed by requestId — ephemeral, cleared after use */
  undoResults: Record<string, UndoResult>;
  /** UndoRecord per execution target (keyed by target key, same format as workspaceSnapshots) */
  undoRecords: Record<string, UndoRecord>;
  /** Shadow copy of settingsStore.workflowProperties for undo tracking. Kept in sync
   *  with settingsStore but stored here so zundo can snapshot it alongside prompts. */
  undoWorkflowProperties: WorkflowProperties;
  /** Incremented for user actions whose only undoable change may be runtime state. */
  runtimeUndoGeneration: number;
  /** Live context window usage per step index, updated during prompt execution */
  liveContextWindow: Record<number, { used: number; size: number }>;
}

/**
 * Workflow actions
 */
interface WorkflowActions {
  // Setters
  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (steps: WorkflowStep[]) => void;
  updatePrompt: (index: number, updates: Partial<PromptStep>) => void;
  setExecutionState: (state: ExecutionState) => void;
  setCurrentStep: (step: number) => void;
  setTotalSteps: (total: number) => void;
  setFinalStep: (finalStep: WorkflowStep | null) => void;
  setFinalStepStatus: (
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null
  ) => void;

  // Live entry management
  appendLiveEntry: (entry: OrderedHistoryEntry) => void;
  clearLiveEntries: () => void;
  appendStreamingChunk: (
    stepIndex: number,
    chunk: string,
    phase?: ExecutionPhase
  ) => void;
  clearStreamingChunk: (stepIndex: number, phase?: ExecutionPhase) => void;
  appendStreamingEvents: (
    stepIndex: number,
    events: any[],
    attemptIndex?: number,
    runIndex?: number
  ) => void;
  appendFinalStepStreamingChunk: (
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase
  ) => void;
  clearFinalStepStreamingChunk: (
    loopIndex: number,
    phase?: ExecutionPhase
  ) => void;
  appendFinalStepStreamingEvents: (
    loopIndex: number,
    events: any[],
    attemptIndex?: number,
    runIndex?: number
  ) => void;

  // Retry management
  setRetryState: (
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ) => void;
  clearRetryState: (stepIndex: number) => void;

  // Step status management
  setStepStatus: (stepIndex: number, status: StepStatus) => void;

  // History management
  loadHistoryRun: (history: WorkflowOutputHistory) => void;
  /** Seed an executing run's live output view from its complete persisted timeline. */
  hydrateLiveRunHistory: (history: WorkflowOutputHistory) => void;
  clearHistoryOutputs: () => void;

  // Partial runtime state clear (for append-continuation runs)
  clearRuntimeStateFromStep: (startStep: number) => void;

  // Promote completed history entries into the live ordered timeline for preserved steps.
  // Called before switching from history→live view on a continuation run so the user
  // still sees previous prompts' output in the live panel.
  promoteHistoryToLive: (stepCount: number) => void;

  // Bulk operations
  loadWorkflow: (data: {
    fileName: string;
    workflowName?: string;
    steps: WorkflowStep[];
    executionState?: ExecutionState;
    currentStep?: number;
    results?: Array<{ status?: StepStatus }>;
    finalStep?: WorkflowStep | null;
    finalStepStatus?: StepStatus | null;
    finalStepLoopCount?: number;
    finalStepPhase?: FinalStepPhase | null;
    /**
     * Same-view snapshot replay: keep live output, streaming/runtime state,
     * and the zundo history instead of clearing them. Only pass true when the
     * incoming snapshot re-describes the workflow the store already holds
     * (same address, same definition revision) — for a genuine workflow/run
     * switch the runtime state belongs to the previous view and must clear.
     */
    preserveLiveOutput?: boolean;
  }) => void;
  resetWorkflow: () => void;
  clearAllRuntimeState: () => void;
  setWorkspaceSnapshot: (
    target: UndoExecutionTarget,
    snapshot: WorkspaceSnapshot
  ) => void;
  setUndoRecord: (target: UndoExecutionTarget, record: UndoRecord) => void;
  updateHistoryStepUndoRecord: (
    target: UndoExecutionTarget,
    undoRecord: UndoRecord
  ) => void;
  setUndoResult: (requestId: string, result: UndoResult) => void;
  clearUndoResult: (requestId: string) => void;
  /** Creates an undo snapshot: call when the user changes workflowProperties (WorkflowPropertiesPanel). */
  setUndoWorkflowProperties: (props: WorkflowProperties) => void;
  /** Silently syncs the shadow copy without creating an undo snapshot (for incoming extension messages). */
  syncIncomingWorkflowProperties: (props: WorkflowProperties) => void;
  updateLiveContextWindow: (
    stepIndex: number,
    used: number,
    size: number
  ) => void;
  clearLiveContextWindow: (stepIndex: number) => void;
}

/**
 * Computed selectors (derived state)
 */
interface WorkflowSelectors {
  // Check if there are pending prompts in the queue
  hasPendingPrompts: () => boolean;
  // Get current prompt being executed
  getCurrentPrompt: () => WorkflowStep | null;
  // Get prompt by index
  getPromptByIndex: (index: number) => WorkflowStep | null;
  // Check if workflow is currently running (RUNNING or PAUSING)
  isWorkflowRunning: () => boolean;
  // Check if workflow is active (RUNNING, PAUSING, or PAUSED)
  isWorkflowActive: () => boolean;
  // Check if workflow is paused
  isWorkflowPaused: () => boolean;
  // Check if workflow is stopped
  isWorkflowStopped: () => boolean;
  // Check if workflow is idle
  isWorkflowIdle: () => boolean;
  // Check if workflow is complete
  isWorkflowComplete: () => boolean;
  // Get all outputs for a step (including retries)
  getStepOutputs: (stepIndex: number) => CliOutput[];
  // Get latest output for a step
  getLatestOutput: (stepIndex: number) => CliOutput | null;
  // Check if a step has failed
  isStepFailed: (stepIndex: number) => boolean;
  // Get completed step count
  getCompletedCount: () => number;
}

const initialState: WorkflowState = {
  fileName: null,
  workflowName: null,
  steps: [],
  executionState: EXECUTION_STATES.IDLE,
  currentStep: 0,
  totalSteps: 0,
  finalStep: null,
  finalStepStatus: null,
  finalStepLoopCount: 0,
  finalStepPhase: null,
  liveOrderedEntries: [],
  liveSequence: 0,
  retryStates: {},
  streamingChunks: {},
  finalStepStreamingChunks: {},
  historyOutputs: null,
  workspaceSnapshots: {},
  finalStepWorkspaceSnapshots: {},
  undoResults: {},
  undoRecords: {},
  undoWorkflowProperties: {},
  runtimeUndoGeneration: 0,
  liveContextWindow: {},
};

function targetsEqual(
  a: OutputExecutionTarget,
  b: OutputExecutionTarget
): boolean {
  if (a.kind !== b.kind) return false;
  if (
    a.kind === FINAL_STEP_PHASES.QUEUE &&
    b.kind === FINAL_STEP_PHASES.QUEUE
  ) {
    return a.stepIndex === b.stepIndex;
  }
  if (
    a.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    b.kind === FINAL_STEP_PHASES.FINAL_STEP
  ) {
    return a.loopIndex === b.loopIndex;
  }
  return false;
}

function getCliEntryRunIndex(entry: OrderedCliHistoryEntry): number {
  return entry.runIndex ?? entry.cliOutput.runIndex ?? 0;
}

function findMatchingCliEntryIndex(
  entries: OrderedHistoryEntry[],
  cliEntry: OrderedCliHistoryEntry
): number {
  return entries.findIndex(
    (entry): entry is OrderedCliHistoryEntry =>
      entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
      targetsEqual(entry.target, cliEntry.target) &&
      getCliEntryRunIndex(entry) === getCliEntryRunIndex(cliEntry) &&
      entry.attemptIndex === cliEntry.attemptIndex &&
      (entry.phase ?? EXECUTION_PHASES.PROMPT) ===
        (cliEntry.phase ?? EXECUTION_PHASES.PROMPT)
  );
}

function overlayLiveHistoryEntries(
  persistedEntries: OrderedHistoryEntry[],
  overlayEntries: OrderedHistoryEntry[]
): { entries: OrderedHistoryEntry[]; nextSequence: number } {
  const entries = [...persistedEntries];
  const matchedStatusIndices = new Set<number>();
  let nextSequence =
    persistedEntries.reduce((max, entry) => Math.max(max, entry.sequence), -1) +
    1;

  for (const overlayEntry of overlayEntries) {
    if (overlayEntry.kind === OUTPUT_HISTORY_KINDS.CLI) {
      const matchingIdx = findMatchingCliEntryIndex(entries, overlayEntry);
      if (matchingIdx >= 0) {
        entries[matchingIdx] = {
          ...overlayEntry,
          sequence: entries[matchingIdx].sequence,
        };
        continue;
      }
    }
    if (overlayEntry.kind === OUTPUT_HISTORY_KINDS.STATUS) {
      const matchingIdx = entries.findIndex(
        (entry, index): entry is OrderedStatusHistoryEntry =>
          !matchedStatusIndices.has(index) &&
          entry.kind === OUTPUT_HISTORY_KINDS.STATUS &&
          targetsEqual(entry.target, overlayEntry.target) &&
          entry.statusMessage.message === overlayEntry.statusMessage.message &&
          entry.statusMessage.severity === overlayEntry.statusMessage.severity
      );
      if (matchingIdx >= 0) {
        // Status replay does not preserve its original timestamp. Match each
        // semantic occurrence once so the full buffer can overlay history
        // without duplicating it, while genuinely newer repeats still append.
        matchedStatusIndices.add(matchingIdx);
        continue;
      }
    }
    entries.push({ ...overlayEntry, sequence: nextSequence });
    nextSequence += 1;
  }

  return { entries, nextSequence };
}

function getUndoRecordKey(target: UndoExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `queue-${target.stepIndex}`
    : `finalStep-${target.loopIndex}`;
}

function projectLiveHistoryArtifacts(
  history: WorkflowOutputHistory
): Pick<
  WorkflowState,
  "workspaceSnapshots" | "finalStepWorkspaceSnapshots" | "undoRecords"
> {
  const workspaceSnapshots: Record<number, WorkspaceSnapshot> = {};
  const finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot> = {};
  const undoRecords: Record<string, UndoRecord> = {};

  for (const [rawStepIndex, output] of Object.entries(history.promptOutputs)) {
    const stepIndex = Number(rawStepIndex);
    if (!Number.isInteger(stepIndex)) continue;
    if (output.workspaceSnapshot) {
      workspaceSnapshots[stepIndex] = output.workspaceSnapshot;
    }
    if (output.undoRecord) {
      undoRecords[
        getUndoRecordKey({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex })
      ] = output.undoRecord;
    }
  }

  for (const [rawLoopIndex, output] of Object.entries(
    history.finalStepOutputs ?? {}
  )) {
    const loopIndex = Number(rawLoopIndex);
    if (!Number.isInteger(loopIndex)) continue;
    if (output.workspaceSnapshot) {
      finalStepWorkspaceSnapshots[loopIndex] = output.workspaceSnapshot;
    }
    if (output.undoRecord) {
      undoRecords[
        getUndoRecordKey({
          kind: FINAL_STEP_PHASES.FINAL_STEP,
          loopIndex,
        })
      ] = output.undoRecord;
    }
  }

  return {
    workspaceSnapshots,
    finalStepWorkspaceSnapshots,
    undoRecords,
  };
}

export const useWorkflowStore = create<
  WorkflowState & WorkflowActions & WorkflowSelectors
>()(
  temporal(
    (set, get) => ({
      ...initialState,

      // ============================================================================
      // SETTERS
      // ============================================================================

      setFileName: (fileName) => withUndoPause(() => set({ fileName })),

      setWorkflowName: (workflowName) => set({ workflowName }),

      setPrompts: (steps) => {
        set({
          steps,
          totalSteps: steps.length,
        });
      },

      updatePrompt: (index, updates) => {
        set((state) => ({
          steps: state.steps.map((p, i) =>
            i === index ? ({ ...p, ...updates } as WorkflowStep) : p
          ),
        }));
      },

      setExecutionState: (executionState) =>
        withUndoPause(() => set({ executionState })),

      setCurrentStep: (currentStep) =>
        withUndoPause(() => set({ currentStep })),

      setTotalSteps: (totalSteps) => withUndoPause(() => set({ totalSteps })),

      setFinalStep: (finalStep) =>
        set((state) => ({
          finalStep,
          ...(finalStep
            ? {}
            : {
                finalStepStatus: null,
                finalStepLoopCount: 0,
                finalStepPhase: null,
                finalStepStreamingChunks: {},
                liveOrderedEntries: state.liveOrderedEntries.filter(
                  (e) =>
                    "target" in e &&
                    e.target.kind !== FINAL_STEP_PHASES.FINAL_STEP
                ),
              }),
          steps: state.steps,
        })),

      setFinalStepStatus: (status, loopCount, phase) =>
        withUndoPause(() =>
          set({
            finalStepStatus: status,
            finalStepLoopCount: loopCount,
            finalStepPhase: phase,
          })
        ),

      // ============================================================================
      // LIVE ENTRY MANAGEMENT
      // ============================================================================

      appendLiveEntry: (entry) =>
        withUndoPause(() =>
          set((state) => {
            if (entry.kind === "cli") {
              const cliEntry = entry as OrderedCliHistoryEntry;
              const matchingIdx = findMatchingCliEntryIndex(
                state.liveOrderedEntries,
                cliEntry
              );
              if (matchingIdx >= 0) {
                const newEntries = [...state.liveOrderedEntries];
                newEntries[matchingIdx] = {
                  ...entry,
                  // An overlay updates the same logical attempt in place. Keep
                  // its persisted position even though the replacement arrived
                  // after the snapshot.
                  sequence: newEntries[matchingIdx].sequence,
                };
                return {
                  liveOrderedEntries: newEntries,
                  liveSequence: state.liveSequence + 1,
                };
              }
            }
            return {
              liveOrderedEntries: [...state.liveOrderedEntries, entry],
              liveSequence: state.liveSequence + 1,
            };
          })
        ),

      clearLiveEntries: () =>
        withUndoPause(() => set({ liveOrderedEntries: [], liveSequence: 0 })),

      appendStreamingChunk: (stepIndex, chunk, phase) =>
        withUndoPause(() =>
          set((state) => ({
            streamingChunks: {
              ...state.streamingChunks,
              [getStreamingChunkKey(stepIndex, phase)]:
                (state.streamingChunks[
                  getStreamingChunkKey(stepIndex, phase)
                ] || "") + chunk,
            },
          }))
        ),

      clearStreamingChunk: (stepIndex, phase) =>
        withUndoPause(() =>
          set((state) => ({
            streamingChunks: {
              ...state.streamingChunks,
              [getStreamingChunkKey(stepIndex, phase)]: "",
            },
          }))
        ),

      appendStreamingEvents: (
        stepIndex,
        events,
        attemptIndex = 0,
        runIndex = 0
      ) =>
        withUndoPause(() =>
          set((state) => {
            const target: OutputExecutionTarget = {
              kind: FINAL_STEP_PHASES.QUEUE,
              stepIndex,
            };
            const existingIdx = state.liveOrderedEntries.findIndex(
              (e): e is OrderedCliHistoryEntry =>
                e.kind === "cli" &&
                "target" in e &&
                (e as OrderedCliHistoryEntry).target.kind ===
                  FINAL_STEP_PHASES.QUEUE &&
                (
                  (e as OrderedCliHistoryEntry).target as {
                    kind: typeof FINAL_STEP_PHASES.QUEUE;
                    stepIndex: number;
                  }
                ).stepIndex === stepIndex &&
                getCliEntryRunIndex(e as OrderedCliHistoryEntry) === runIndex &&
                (e as OrderedCliHistoryEntry).attemptIndex === attemptIndex
            );
            if (existingIdx >= 0) {
              const existing = state.liveOrderedEntries[
                existingIdx
              ] as OrderedCliHistoryEntry;
              const updatedOutput = mergeResumedActivityIntoOutput(
                existing.cliOutput,
                events
              );
              const newEntries = [...state.liveOrderedEntries];
              newEntries[existingIdx] = {
                ...existing,
                cliOutput: updatedOutput,
              };
              return { liveOrderedEntries: newEntries };
            }
            const streamingOutput: CliOutput = {
              prompt: "",
              response: "",
              structured: {
                events: mergeStreamingEvents([], events),
                metadata: {},
              },
              elapsed: 0,
              isStreaming: true,
              timestampMs: Date.now(),
              attemptIndex,
              runIndex,
            };
            const newEntry: OrderedCliHistoryEntry = {
              kind: OUTPUT_HISTORY_KINDS.CLI,
              target,
              runIndex,
              attemptIndex,
              cliOutput: streamingOutput,
              timestampMs: streamingOutput.timestampMs!,
              sequence: state.liveSequence,
            };
            return {
              liveOrderedEntries: [...state.liveOrderedEntries, newEntry],
              liveSequence: state.liveSequence + 1,
            };
          })
        ),

      appendFinalStepStreamingChunk: (loopIndex, chunk, phase) =>
        withUndoPause(() =>
          set((state) => ({
            finalStepStreamingChunks: {
              ...state.finalStepStreamingChunks,
              [getStreamingChunkKey(loopIndex, phase)]:
                (state.finalStepStreamingChunks[
                  getStreamingChunkKey(loopIndex, phase)
                ] || "") + chunk,
            },
          }))
        ),

      clearFinalStepStreamingChunk: (loopIndex, phase) =>
        withUndoPause(() =>
          set((state) => ({
            finalStepStreamingChunks: {
              ...state.finalStepStreamingChunks,
              [getStreamingChunkKey(loopIndex, phase)]: "",
            },
          }))
        ),

      appendFinalStepStreamingEvents: (
        loopIndex,
        events,
        attemptIndex = 0,
        runIndex = 0
      ) =>
        withUndoPause(() =>
          set((state) => {
            const target: OutputExecutionTarget = {
              kind: FINAL_STEP_PHASES.FINAL_STEP,
              loopIndex,
            };
            const existingIdx = state.liveOrderedEntries.findIndex(
              (e): e is OrderedCliHistoryEntry =>
                e.kind === "cli" &&
                "target" in e &&
                (e as OrderedCliHistoryEntry).target.kind ===
                  FINAL_STEP_PHASES.FINAL_STEP &&
                (
                  (e as OrderedCliHistoryEntry).target as {
                    kind: typeof FINAL_STEP_PHASES.FINAL_STEP;
                    loopIndex: number;
                  }
                ).loopIndex === loopIndex &&
                getCliEntryRunIndex(e as OrderedCliHistoryEntry) === runIndex &&
                (e as OrderedCliHistoryEntry).attemptIndex === attemptIndex
            );
            if (existingIdx >= 0) {
              const existing = state.liveOrderedEntries[
                existingIdx
              ] as OrderedCliHistoryEntry;
              const updatedOutput = mergeResumedActivityIntoOutput(
                existing.cliOutput,
                events
              );
              const newEntries = [...state.liveOrderedEntries];
              newEntries[existingIdx] = {
                ...existing,
                cliOutput: updatedOutput,
              };
              return { liveOrderedEntries: newEntries };
            }
            const streamingOutput: CliOutput = {
              prompt: "",
              response: "",
              structured: {
                events: mergeStreamingEvents([], events),
                metadata: {},
              },
              elapsed: 0,
              isStreaming: true,
              timestampMs: Date.now(),
              attemptIndex,
              runIndex,
            };
            const newEntry: OrderedCliHistoryEntry = {
              kind: OUTPUT_HISTORY_KINDS.CLI,
              target,
              runIndex,
              attemptIndex,
              cliOutput: streamingOutput,
              timestampMs: streamingOutput.timestampMs!,
              sequence: state.liveSequence,
            };
            return {
              liveOrderedEntries: [...state.liveOrderedEntries, newEntry],
              liveSequence: state.liveSequence + 1,
            };
          })
        ),

      // ============================================================================
      // RETRY MANAGEMENT
      // ============================================================================

      setRetryState: (stepIndex, currentRetry, maxRetries) =>
        withUndoPause(() =>
          set((state) => ({
            retryStates: {
              ...state.retryStates,
              [stepIndex]: { currentRetry, maxRetries },
            },
          }))
        ),

      clearRetryState: (stepIndex) =>
        withUndoPause(() =>
          set((state) => {
            const { [stepIndex]: _, ...rest } = state.retryStates;
            return { retryStates: rest };
          })
        ),

      // ============================================================================
      // STEP STATUS MANAGEMENT
      // ============================================================================

      setStepStatus: (stepIndex, status) =>
        withUndoPause(() =>
          set((state) => ({
            steps: state.steps.map((p, i) =>
              i === stepIndex ? ({ ...p, status } as WorkflowStep) : p
            ),
          }))
        ),

      // ============================================================================
      // BULK OPERATIONS
      // ============================================================================

      loadWorkflow: ({
        fileName,
        workflowName,
        steps,
        executionState = EXECUTION_STATES.IDLE,
        currentStep = 0,
        results = [],
        finalStep = null,
        finalStepStatus = null,
        finalStepLoopCount = 0,
        finalStepPhase = null,
        preserveLiveOutput = false,
      }) => {
        // Apply status from results to prompts
        const promptsWithStatus = steps.map((prompt, index) => ({
          ...prompt,
          status: (results[index]?.status as StepStatus) || STEP_STATUS.PENDING,
        })) as WorkflowStep[];

        withUndoPause(() =>
          set((state) => ({
            fileName,
            workflowName: workflowName ?? null,
            // Structural sharing: snapshot replays of an unchanged definition
            // must not hand the output pane fresh step identities — that alone
            // rebuilds every rendered row (see utils/structuralSharing.ts).
            steps: preserveReferences(state.steps, promptsWithStatus),
            executionState,
            currentStep,
            totalSteps: steps.length,
            finalStep: preserveReferences(state.finalStep, finalStep),
            finalStepStatus,
            finalStepLoopCount,
            finalStepPhase,
            // Clear runtime state on new workflow. `preserveReferences`
            // keeps the existing (already-empty) references stable so a
            // replayed clear is identity-neutral.
            ...(preserveLiveOutput
              ? {}
              : {
                  liveOrderedEntries: preserveReferences(
                    state.liveOrderedEntries,
                    []
                  ) as OrderedHistoryEntry[],
                  liveSequence: 0,
                  retryStates: preserveReferences(state.retryStates, {}),
                  streamingChunks: preserveReferences(
                    state.streamingChunks,
                    {}
                  ),
                  finalStepStreamingChunks: preserveReferences(
                    state.finalStepStreamingChunks,
                    {}
                  ),
                  liveContextWindow: preserveReferences(
                    state.liveContextWindow,
                    {}
                  ),
                  workspaceSnapshots: preserveReferences(
                    state.workspaceSnapshots,
                    {}
                  ),
                  finalStepWorkspaceSnapshots: preserveReferences(
                    state.finalStepWorkspaceSnapshots,
                    {}
                  ),
                  undoResults: preserveReferences(state.undoResults, {}),
                  undoRecords: preserveReferences(state.undoRecords, {}),
                }),
          }))
        );
        // A same-view replay is not a new editing epoch — keep undo history.
        if (!preserveLiveOutput) {
          useWorkflowStore.temporal.getState().clear();
        }
      },

      // ============================================================================
      // HISTORY MANAGEMENT
      // ============================================================================

      loadHistoryRun: (history) =>
        withUndoPause(() =>
          set((state) => {
            // Update uiStore for history view state
            useUiStore.getState().setHistoryView();

            // Populate self-contained history snapshot.
            // Clear live-store undo records and snapshots so stale state from
            // a previous run or a different history selection doesn't bleed into
            // this run's view. History data in historyOutputs is the sole source
            // of truth for undo state while in history mode.
            // Structural sharing keeps identities stable when a replayed
            // snapshot re-delivers the history the store already holds.
            return {
              historyOutputs: preserveReferences(state.historyOutputs, {
                orderedEntries: history.orderedEntries,
                promptOutputs: history.promptOutputs,
                finalStepOutputs: history.finalStepOutputs,
                runMetadata: {
                  runId: history.runId,
                  startedAt: history.startedAt,
                  completedAt: history.completedAt,
                  executionState: history.executionState,
                },
              }),
              undoRecords: preserveReferences(state.undoRecords, {}),
              workspaceSnapshots: preserveReferences(
                state.workspaceSnapshots,
                {}
              ),
              finalStepWorkspaceSnapshots: preserveReferences(
                state.finalStepWorkspaceSnapshots,
                {}
              ),
            };
          })
        ),

      hydrateLiveRunHistory: (history) =>
        withUndoPause(() =>
          set((state) => {
            const projected = projectLiveHistoryArtifacts(history);
            const overlay = overlayLiveHistoryEntries(
              history.orderedEntries,
              state.liveOrderedEntries
            );
            return {
              // The executing run must remain in live mode so buffered and
              // future events can update it. Its durable timeline is the
              // baseline; any already-replayed in-memory entries overlay it.
              // Structural sharing keeps entry/record identities stable when
              // the rehydrated timeline matches what the store already holds,
              // so the output pane doesn't redraw unchanged rows.
              historyOutputs: null,
              liveOrderedEntries: preserveReferences(
                state.liveOrderedEntries,
                overlay.entries
              ),
              liveSequence: overlay.nextSequence,
              workspaceSnapshots: preserveReferences(state.workspaceSnapshots, {
                ...projected.workspaceSnapshots,
                ...state.workspaceSnapshots,
              }),
              finalStepWorkspaceSnapshots: preserveReferences(
                state.finalStepWorkspaceSnapshots,
                {
                  ...projected.finalStepWorkspaceSnapshots,
                  ...state.finalStepWorkspaceSnapshots,
                }
              ),
              undoRecords: preserveReferences(state.undoRecords, {
                ...projected.undoRecords,
                ...state.undoRecords,
              }),
            };
          })
        ),

      clearHistoryOutputs: () =>
        withUndoPause(() => set(() => ({ historyOutputs: null }))),

      clearRuntimeStateFromStep: (startStep) =>
        withUndoPause(() =>
          set((state) => {
            const newRetryStates = { ...state.retryStates };
            const newStreamingChunks = { ...state.streamingChunks };
            const newLiveContextWindow = { ...state.liveContextWindow };

            Object.keys(newRetryStates).forEach((key) => {
              if (Number(key) >= startStep) {
                delete newRetryStates[Number(key)];
              }
            });
            Object.keys(newStreamingChunks).forEach((key) => {
              if (Number(key.split(":", 1)[0]) >= startStep) {
                delete newStreamingChunks[key];
              }
            });
            Object.keys(newLiveContextWindow).forEach((key) => {
              if (Number(key) >= startStep) {
                delete newLiveContextWindow[Number(key)];
              }
            });

            return {
              retryStates: newRetryStates,
              streamingChunks: newStreamingChunks,
              liveContextWindow: newLiveContextWindow,
              finalStepStreamingChunks: {},
              finalStepStatus: null,
              finalStepLoopCount: 0,
              finalStepPhase: null,
            };
          })
        ),

      promoteHistoryToLive: (stepCount) =>
        withUndoPause(() =>
          set((state) => {
            if (!state.historyOutputs?.orderedEntries?.length) {
              WebviewLog.debug(
                `[WorkflowStore] promoteHistoryToLive(${stepCount}): no history orderedEntries, nothing to promote`
              );
              return {};
            }

            const entriesToPromote = state.historyOutputs.orderedEntries.filter(
              (e) =>
                "target" in e &&
                e.target.kind === FINAL_STEP_PHASES.QUEUE &&
                (
                  e.target as {
                    kind: typeof FINAL_STEP_PHASES.QUEUE;
                    stepIndex: number;
                  }
                ).stepIndex < stepCount
            );

            WebviewLog.debug(
              `[WorkflowStore] promoteHistoryToLive(${stepCount}): promoting ${entriesToPromote.length} entries from history`
            );

            return {
              liveOrderedEntries: [
                ...entriesToPromote,
                ...state.liveOrderedEntries.filter(
                  (e) =>
                    !("target" in e) ||
                    e.target.kind === FINAL_STEP_PHASES.FINAL_STEP ||
                    (e.target.kind === FINAL_STEP_PHASES.QUEUE &&
                      (
                        e.target as {
                          kind: typeof FINAL_STEP_PHASES.QUEUE;
                          stepIndex: number;
                        }
                      ).stepIndex >= stepCount)
                ),
              ],
            };
          })
        ),

      resetWorkflow: () => {
        withUndoPause(() => set(initialState));
        useWorkflowStore.temporal.getState().clear();
      },

      clearAllRuntimeState: () =>
        withUndoPause(() =>
          set({
            liveOrderedEntries: [],
            liveSequence: 0,
            retryStates: {},
            streamingChunks: {},
            finalStepStreamingChunks: {},
            finalStepStatus: null,
            finalStepLoopCount: 0,
            finalStepPhase: null,
            workspaceSnapshots: {},
            finalStepWorkspaceSnapshots: {},
            undoResults: {},
            undoRecords: {},
          })
        ),

      setWorkspaceSnapshot: (target, snapshot) =>
        withUndoPause(() => {
          if (target.kind === FINAL_STEP_PHASES.QUEUE) {
            set((state) => ({
              workspaceSnapshots: {
                ...state.workspaceSnapshots,
                [target.stepIndex]: snapshot,
              },
            }));
          } else {
            set((state) => ({
              finalStepWorkspaceSnapshots: {
                ...state.finalStepWorkspaceSnapshots,
                [target.loopIndex]: snapshot,
              },
            }));
          }
        }),

      setUndoRecord: (target, record) => {
        const key = getUndoRecordKey(target);
        withUndoPause(() =>
          set((s) => ({ undoRecords: { ...s.undoRecords, [key]: record } }))
        );
      },

      updateHistoryStepUndoRecord: (target, undoRecord) =>
        withUndoPause(() =>
          set((state) => {
            if (!state.historyOutputs) return {};
            if (target.kind === FINAL_STEP_PHASES.QUEUE) {
              const step = state.historyOutputs.promptOutputs[target.stepIndex];
              if (!step) return {};
              return {
                historyOutputs: {
                  ...state.historyOutputs,
                  promptOutputs: {
                    ...state.historyOutputs.promptOutputs,
                    [target.stepIndex]: { ...step, undoRecord },
                  },
                },
              };
            } else {
              if (!state.historyOutputs.finalStepOutputs) return {};
              const step =
                state.historyOutputs.finalStepOutputs[target.loopIndex];
              if (!step) return {};
              return {
                historyOutputs: {
                  ...state.historyOutputs,
                  finalStepOutputs: {
                    ...state.historyOutputs.finalStepOutputs,
                    [target.loopIndex]: { ...step, undoRecord },
                  },
                },
              };
            }
          })
        ),

      setUndoResult: (requestId, result) =>
        withUndoPause(() =>
          set((state) => ({
            undoResults: { ...state.undoResults, [requestId]: result },
          }))
        ),

      clearUndoResult: (requestId) =>
        withUndoPause(() =>
          set((state) => {
            const { [requestId]: _, ...rest } = state.undoResults;
            return { undoResults: rest };
          })
        ),

      setUndoWorkflowProperties: (props) =>
        set({ undoWorkflowProperties: props }),

      syncIncomingWorkflowProperties: (props) =>
        withUndoPause(() => set({ undoWorkflowProperties: props })),

      updateLiveContextWindow: (stepIndex, used, size) =>
        withUndoPause(() =>
          set((state) => ({
            liveContextWindow: {
              ...state.liveContextWindow,
              [stepIndex]: { used, size },
            },
          }))
        ),

      clearLiveContextWindow: (stepIndex) =>
        withUndoPause(() =>
          set((state) => {
            const next = { ...state.liveContextWindow };
            delete next[stepIndex];
            return { liveContextWindow: next };
          })
        ),

      // ============================================================================
      // COMPUTED SELECTORS
      // ============================================================================

      /**
       * Check if there are pending prompts in the queue.
       * Returns true if there are prompts that haven't been executed yet.
       * Used to determine whether Run button should say "Run" or "Run Next".
       */
      hasPendingPrompts: () => {
        const {
          steps: prompts,
          executionState,
          currentStep,
          totalSteps,
        } = get();

        if (prompts.length === 0) {
          return false;
        }

        // If we're idle, check if this is a fresh workflow or resumed workflow
        if (executionState === EXECUTION_STATES.IDLE) {
          // Fresh workflow (not started yet) - no pending prompts, just "Run"
          if (currentStep === 0) {
            return false;
          }
          // Resumed workflow (some prompts completed) - has pending prompts, show "Run Next"
          return currentStep < totalSteps;
        }

        // If stopped, there are pending prompts (current was cancelled, may have more after)
        if (executionState === EXECUTION_STATES.STOPPED) {
          return currentStep < totalSteps;
        }

        // If running/paused, check if there are prompts after current step
        if (isWorkflowActive(executionState)) {
          return currentStep < totalSteps;
        }

        // If completed, no pending prompts
        return false;
      },

      getCurrentPrompt: () => {
        const { steps: prompts, currentStep } = get();
        if (currentStep >= 0 && currentStep < prompts.length) {
          return prompts[currentStep];
        }
        return null;
      },

      getPromptByIndex: (index) => {
        const { steps: prompts } = get();
        if (index >= 0 && index < prompts.length) {
          return prompts[index];
        }
        return null;
      },

      isWorkflowRunning: () => isWorkflowRunning(get().executionState),

      isWorkflowActive: () => isWorkflowActive(get().executionState),

      isWorkflowPaused: () => get().executionState === EXECUTION_STATES.PAUSED,

      isWorkflowStopped: () =>
        get().executionState === EXECUTION_STATES.STOPPED,

      isWorkflowIdle: () => get().executionState === EXECUTION_STATES.IDLE,

      isWorkflowComplete: () =>
        get().executionState === EXECUTION_STATES.COMPLETED,

      getStepOutputs: (stepIndex) => {
        const entries = get().liveOrderedEntries;
        return entries
          .filter(
            (e): e is OrderedCliHistoryEntry =>
              e.kind === "cli" &&
              "target" in e &&
              (e as OrderedCliHistoryEntry).target.kind ===
                FINAL_STEP_PHASES.QUEUE &&
              (
                (e as OrderedCliHistoryEntry).target as {
                  kind: typeof FINAL_STEP_PHASES.QUEUE;
                  stepIndex: number;
                }
              ).stepIndex === stepIndex
          )
          .map((e) => e.cliOutput);
      },

      getLatestOutput: (stepIndex) => {
        const entries = get().liveOrderedEntries;
        const cliEntries = entries
          .filter(
            (e): e is OrderedCliHistoryEntry =>
              e.kind === "cli" &&
              "target" in e &&
              (e as OrderedCliHistoryEntry).target.kind ===
                FINAL_STEP_PHASES.QUEUE &&
              (
                (e as OrderedCliHistoryEntry).target as {
                  kind: typeof FINAL_STEP_PHASES.QUEUE;
                  stepIndex: number;
                }
              ).stepIndex === stepIndex
          )
          .map((e) => e.cliOutput);
        return cliEntries.length > 0 ? cliEntries[cliEntries.length - 1] : null;
      },

      isStepFailed: (stepIndex) => {
        const { steps: prompts } = get();
        const step = prompts[stepIndex];
        if (!step || isScriptStep(step)) return false;
        return step.status === STEP_STATUS.FAILED;
      },

      getCompletedCount: () => {
        const { steps: prompts } = get();
        return prompts.filter(
          (p) => !isScriptStep(p) && p.status === STEP_STATUS.COMPLETED
        ).length;
      },
    }),
    {
      partialize: (state): UndoableWorkflowState => ({
        steps: state.steps,
        workflowName: state.workflowName,
        finalStep: state.finalStep,
        undoWorkflowProperties: state.undoWorkflowProperties,
        runtimeUndoGeneration: state.runtimeUndoGeneration,
      }),
      // Prevent snapshot creation when only runtime fields changed.
      // Snapshots should only record user-editable content (prompt text, step
      // structure, workflow properties). Runtime-only changes (_runtime, status,
      // details) should never pollute the undo stack — running a workflow must
      // not cause undo to become enabled.
      equality: (a, b) => {
        if (
          a.workflowName !== b.workflowName ||
          a.steps.length !== b.steps.length ||
          a.finalStep !== b.finalStep ||
          a.runtimeUndoGeneration !== b.runtimeUndoGeneration ||
          JSON.stringify(a.undoWorkflowProperties) !==
            JSON.stringify(b.undoWorkflowProperties)
        ) {
          return false;
        }
        for (let i = 0; i < a.steps.length; i++) {
          const sa = a.steps[i] as any;
          const sb = b.steps[i] as any;
          if (
            sa.prompt !== sb.prompt ||
            sa.script !== sb.script ||
            sa.name !== sb.name ||
            sa.model !== sb.model ||
            sa.harness !== sb.harness ||
            sa.type !== sb.type ||
            sa.enabled !== sb.enabled
          ) {
            return false;
          }
        }
        return true;
      },
      limit: 100,
    }
  )
);

/**
 * Wraps a state mutation in a temporal pause/resume so it does NOT create an
 * undo snapshot. Use for every system-driven mutation (streaming chunks,
 * execution-state bookkeeping, etc.) that should be invisible to undo/redo.
 *
 * Defined as a function declaration (hoisted) so actions in the store creator
 * can reference it even though it appears after `useWorkflowStore` in source.
 */
function withUndoPause<T>(fn: () => T): T {
  useWorkflowStore.temporal.getState().pause();
  const result = fn();
  useWorkflowStore.temporal.getState().resume();
  return result;
}

// Re-export types for convenience (imported from consolidated sources)
export type {
  PromptStep,
  CliOutput,
  RetryState,
  StatusMessage,
} from "../types/messages";
// WorkflowStep is exported above as a webview-local union type (PromptStep | ScriptStep)

export interface UndoableWorkflowState {
  steps: WorkflowStep[];
  workflowName: string | null;
  finalStep: WorkflowStep | null;
  undoWorkflowProperties: WorkflowProperties;
  runtimeUndoGeneration: number;
}

/**
 * Safe hook to subscribe to the zundo temporal store.
 *
 * Uses useState + useEffect instead of useSyncExternalStore (used by Zustand's
 * useStore). In React 18 concurrent mode, useSyncExternalStore's tearing
 * detection calls forceStoreRerender on work-in-progress fibers when the
 * temporal store changes mid-render (e.g. from loadWorkflow → t.clear()),
 * causing getRootForUpdatedFiber to throw React error #185.
 *
 * The setState-from-useEffect pattern is safe because React processes these
 * updates normally outside the concurrent render cycle.
 */
export function useWorkflowTemporalStore<T>(
  selector: (state: TemporalState<UndoableWorkflowState>) => T
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const [value, setValue] = useState<T>(() =>
    selector(useWorkflowStore.temporal.getState())
  );

  useEffect(() => {
    // Sync any change that happened between render and this effect
    setValue(selectorRef.current(useWorkflowStore.temporal.getState()));

    return useWorkflowStore.temporal.subscribe((state) => {
      setValue(selectorRef.current(state));
    });
  }, []);

  return value;
}
