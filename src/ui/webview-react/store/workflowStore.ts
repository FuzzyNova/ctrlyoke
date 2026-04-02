import { create } from "zustand";
import { useState, useEffect, useRef } from "react";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_PROMPT_PHASES,
  type ExecutionState,
  type StepStatus,
  type FinalPromptPhase,
  type PromptItem,
  type CliOutput,
  type RetryState,
} from "../types/messages";
import type {
  OrderedHistoryEntry,
  OrderedCliHistoryEntry,
  OutputExecutionTarget,
  WorkflowOutputHistory,
  StepOutput,
  WorkspaceSnapshot,
  UndoExecutionTarget,
  UndoRecord,
} from "@root/types/OutputHistoryTypes";
import type { UndoResult } from "../types/messages";
import { useUiStore } from "./uiStore";
import { WebviewLog } from "@utils/logger";
import { CLI_EVENT_TYPES } from "../types/cliEvents";

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
  return result;
}

/**
 * Workflow state - Core workflow execution data
 */
interface WorkflowState {
  // Core workflow data
  fileName: string | null;
  workflowName: string | null;
  prompts: PromptItem[];
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  finalPrompt: PromptItem | null;
  finalPromptStatus: StepStatus | null;
  finalPromptLoopCount: number;
  finalPromptPhase: FinalPromptPhase | null;

  // Live ordered output entries (queue + finalPrompt outputs and status messages)
  liveOrderedEntries: OrderedHistoryEntry[];
  liveSequence: number;
  retryStates: Record<number, RetryState>;

  // Streaming state (for incremental output)
  streamingChunks: Record<number, string>;
  finalPromptStreamingChunks: Record<number, string>;

  // Self-contained history snapshot for the currently-viewed historical run.
  // When isViewingHistory=true (in uiStore), OutputSection renders from historyOutputs
  // instead of liveOrderedEntries. The live entries continue to be updated normally —
  // history browsing has zero impact on live capture.
  historyOutputs: {
    orderedEntries: OrderedHistoryEntry[];
    promptOutputs: Record<number, StepOutput>;
    finalPromptOutputs?: Record<number, StepOutput>;
    runMetadata: Pick<
      WorkflowOutputHistory,
      "runId" | "startedAt" | "completedAt" | "executionState"
    >;
  } | null;
  /** Live workspace snapshots keyed by stepIndex (queue) */
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  /** Live workspace snapshots keyed by loopIndex (finalPrompt) */
  finalPromptWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  /** Undo result state keyed by requestId — ephemeral, cleared after use */
  undoResults: Record<string, UndoResult>;
  /** UndoRecord per execution target (keyed by target key, same format as workspaceSnapshots) */
  undoRecords: Record<string, UndoRecord>;
}

/**
 * Workflow actions
 */
interface WorkflowActions {
  // Setters
  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (prompts: PromptItem[]) => void;
  updatePrompt: (index: number, updates: Partial<PromptItem>) => void;
  setExecutionState: (state: ExecutionState) => void;
  setCurrentStep: (step: number) => void;
  setTotalSteps: (total: number) => void;
  setFinalPrompt: (finalPrompt: PromptItem | null) => void;
  setFinalPromptStatus: (
    status: StepStatus | null,
    loopCount: number,
    phase: FinalPromptPhase | null
  ) => void;

  // Live entry management
  appendLiveEntry: (entry: OrderedHistoryEntry) => void;
  clearLiveEntries: () => void;
  appendStreamingChunk: (stepIndex: number, chunk: string) => void;
  clearStreamingChunk: (stepIndex: number) => void;
  appendStreamingEvents: (stepIndex: number, events: any[]) => void;
  appendFinalPromptStreamingChunk: (loopIndex: number, chunk: string) => void;
  appendFinalPromptStreamingEvents: (loopIndex: number, events: any[]) => void;

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
  loadHistoryRun: (
    history: WorkflowOutputHistory,
    availableRuns: number,
    runIndex: number
  ) => void;
  clearHistoryOutputs: () => void;

  // Reset execution state only — preserves all CLI outputs and run history.
  // Resets executionState→IDLE, currentStep→0, and all prompt statuses→PENDING.
  // Used by "Clear workflow state" so users can edit prompts without losing output.
  resetExecutionState: (prompts: PromptItem[]) => void;

  // Partial runtime state clear (for append-continuation runs)
  clearRuntimeStateFromStep: (startStep: number) => void;

  // Apply a start-position change — updates prompts, currentStep, totalSteps, and resets execution state to IDLE.
  applyStartPositionChange: (
    prompts: PromptItem[],
    newCurrentStep: number
  ) => void;

  // Promote history snapshot data into live cliOutputs/statusMessages for preserved steps.
  // Called before switching from history→live view on a continuation run so the user
  // still sees previous prompts' output in the live panel.
  promoteHistoryToLive: (stepCount: number) => void;

  // Bulk operations
  loadWorkflow: (data: {
    fileName: string;
    workflowName?: string;
    prompts: PromptItem[];
    executionState?: ExecutionState;
    currentStep?: number;
    results?: Array<{ status?: StepStatus }>;
    finalPrompt?: PromptItem | null;
    finalPromptStatus?: StepStatus | null;
    finalPromptLoopCount?: number;
    finalPromptPhase?: FinalPromptPhase | null;
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
}

/**
 * Computed selectors (derived state)
 */
interface WorkflowSelectors {
  // Check if there are pending prompts in the queue
  hasPendingPrompts: () => boolean;
  // Get current prompt being executed
  getCurrentPrompt: () => PromptItem | null;
  // Get prompt by index
  getPromptByIndex: (index: number) => PromptItem | null;
  // Check if workflow is currently running
  isWorkflowRunning: () => boolean;
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
  prompts: [],
  executionState: EXECUTION_STATES.IDLE,
  currentStep: 0,
  totalSteps: 0,
  finalPrompt: null,
  finalPromptStatus: null,
  finalPromptLoopCount: 0,
  finalPromptPhase: null,
  liveOrderedEntries: [],
  liveSequence: 0,
  retryStates: {},
  streamingChunks: {},
  finalPromptStreamingChunks: {},
  historyOutputs: null,
  workspaceSnapshots: {},
  finalPromptWorkspaceSnapshots: {},
  undoResults: {},
  undoRecords: {},
};

function targetsEqual(a: OutputExecutionTarget, b: OutputExecutionTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === FINAL_PROMPT_PHASES.QUEUE && b.kind === FINAL_PROMPT_PHASES.QUEUE) {
    return a.stepIndex === b.stepIndex;
  }
  if (a.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT && b.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
    return a.loopIndex === b.loopIndex;
  }
  return false;
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

      setPrompts: (prompts) => {
        set({
          prompts,
          totalSteps: prompts.length,
        });
      },

      updatePrompt: (index, updates) => {
        set((state) => ({
          prompts: state.prompts.map((p, i) =>
            i === index ? { ...p, ...updates } : p
          ),
        }));
      },

      setExecutionState: (executionState) =>
        withUndoPause(() => set({ executionState })),

      setCurrentStep: (currentStep) =>
        withUndoPause(() => set({ currentStep })),

      setTotalSteps: (totalSteps) => withUndoPause(() => set({ totalSteps })),

      setFinalPrompt: (finalPrompt) =>
        set((state) => ({
          finalPrompt,
          ...(finalPrompt
            ? {}
            : {
                finalPromptStatus: null,
                finalPromptLoopCount: 0,
                finalPromptPhase: null,
                finalPromptStreamingChunks: {},
                liveOrderedEntries: state.liveOrderedEntries.filter(
                  (e) => "target" in e && e.target.kind !== FINAL_PROMPT_PHASES.FINAL_PROMPT
                ),
              }),
          prompts: state.prompts,
        })),

      setFinalPromptStatus: (status, loopCount, phase) =>
        withUndoPause(() =>
          set({
            finalPromptStatus: status,
            finalPromptLoopCount: loopCount,
            finalPromptPhase: phase,
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
              const streamingIdx = state.liveOrderedEntries.findIndex(
                (e): e is OrderedCliHistoryEntry =>
                  e.kind === "cli" &&
                  "target" in e &&
                  targetsEqual((e as OrderedCliHistoryEntry).target, cliEntry.target) &&
                  (e as OrderedCliHistoryEntry).attemptIndex === cliEntry.attemptIndex &&
                  (e as OrderedCliHistoryEntry).cliOutput.isStreaming === true
              );
              if (streamingIdx >= 0) {
                const newEntries = [...state.liveOrderedEntries];
                newEntries[streamingIdx] = entry;
                return { liveOrderedEntries: newEntries, liveSequence: state.liveSequence + 1 };
              }
            }
            return {
              liveOrderedEntries: [...state.liveOrderedEntries, entry],
              liveSequence: state.liveSequence + 1,
            };
          })
        ),

      clearLiveEntries: () => withUndoPause(() => set({ liveOrderedEntries: [], liveSequence: 0 })),

      appendStreamingChunk: (stepIndex, chunk) =>
        withUndoPause(() =>
          set((state) => ({
            streamingChunks: {
              ...state.streamingChunks,
              [stepIndex]: (state.streamingChunks[stepIndex] || "") + chunk,
            },
          }))
        ),

      clearStreamingChunk: (stepIndex) =>
        withUndoPause(() =>
          set((state) => ({
            streamingChunks: {
              ...state.streamingChunks,
              [stepIndex]: "",
            },
          }))
        ),

      appendStreamingEvents: (stepIndex, events) =>
        withUndoPause(() =>
          set((state) => {
            const target: OutputExecutionTarget = { kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex };
            const existingIdx = state.liveOrderedEntries.findIndex(
              (e): e is OrderedCliHistoryEntry =>
                e.kind === "cli" &&
                "target" in e &&
                (e as OrderedCliHistoryEntry).target.kind === FINAL_PROMPT_PHASES.QUEUE &&
                ((e as OrderedCliHistoryEntry).target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex === stepIndex &&
                (e as OrderedCliHistoryEntry).cliOutput.isStreaming === true &&
                (e as OrderedCliHistoryEntry).attemptIndex === 0
            );
            if (existingIdx >= 0) {
              const existing = state.liveOrderedEntries[existingIdx] as OrderedCliHistoryEntry;
              const existingStructured = existing.cliOutput.structured as any;
              const updatedOutput: CliOutput = {
                ...existing.cliOutput,
                structured: {
                  ...existingStructured,
                  events: mergeStreamingEvents(existingStructured?.events || [], events),
                  metadata: existingStructured?.metadata || {},
                },
              };
              const newEntries = [...state.liveOrderedEntries];
              newEntries[existingIdx] = { ...existing, cliOutput: updatedOutput };
              return { liveOrderedEntries: newEntries };
            }
            const streamingOutput: CliOutput = {
              prompt: "",
              response: "",
              structured: { events: mergeStreamingEvents([], events), metadata: {} },
              elapsed: 0,
              isStreaming: true,
              timestampMs: Date.now(),
              attemptIndex: 0,
            };
            const newEntry: OrderedCliHistoryEntry = {
              kind: "cli",
              target,
              attemptIndex: 0,
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

      appendFinalPromptStreamingChunk: (loopIndex, chunk) =>
        withUndoPause(() =>
          set((state) => ({
            finalPromptStreamingChunks: {
              ...state.finalPromptStreamingChunks,
              [loopIndex]:
                (state.finalPromptStreamingChunks[loopIndex] || "") + chunk,
            },
          }))
        ),

      appendFinalPromptStreamingEvents: (loopIndex, events) =>
        withUndoPause(() =>
          set((state) => {
            const target: OutputExecutionTarget = { kind: FINAL_PROMPT_PHASES.FINAL_PROMPT, loopIndex };
            const existingIdx = state.liveOrderedEntries.findIndex(
              (e): e is OrderedCliHistoryEntry =>
                e.kind === "cli" &&
                "target" in e &&
                (e as OrderedCliHistoryEntry).target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT &&
                ((e as OrderedCliHistoryEntry).target as { kind: typeof FINAL_PROMPT_PHASES.FINAL_PROMPT; loopIndex: number }).loopIndex === loopIndex &&
                (e as OrderedCliHistoryEntry).cliOutput.isStreaming === true &&
                (e as OrderedCliHistoryEntry).attemptIndex === 0
            );
            if (existingIdx >= 0) {
              const existing = state.liveOrderedEntries[existingIdx] as OrderedCliHistoryEntry;
              const existingStructured = existing.cliOutput.structured as any;
              const updatedOutput: CliOutput = {
                ...existing.cliOutput,
                structured: {
                  ...existingStructured,
                  events: mergeStreamingEvents(existingStructured?.events || [], events),
                  metadata: existingStructured?.metadata || {},
                },
              };
              const newEntries = [...state.liveOrderedEntries];
              newEntries[existingIdx] = { ...existing, cliOutput: updatedOutput };
              return { liveOrderedEntries: newEntries };
            }
            const streamingOutput: CliOutput = {
              prompt: "",
              response: "",
              structured: { events: mergeStreamingEvents([], events), metadata: {} },
              elapsed: 0,
              isStreaming: true,
              timestampMs: Date.now(),
              attemptIndex: 0,
            };
            const newEntry: OrderedCliHistoryEntry = {
              kind: "cli",
              target,
              attemptIndex: 0,
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
            prompts: state.prompts.map((p, i) =>
              i === stepIndex ? { ...p, status } : p
            ),
          }))
        ),

      // ============================================================================
      // BULK OPERATIONS
      // ============================================================================

      loadWorkflow: ({
        fileName,
        workflowName,
        prompts,
        executionState = EXECUTION_STATES.IDLE,
        currentStep = 0,
        results = [],
        finalPrompt = null,
        finalPromptStatus = null,
        finalPromptLoopCount = 0,
        finalPromptPhase = null,
      }) => {
        // Apply status from results to prompts
        const promptsWithStatus = prompts.map((prompt, index) => ({
          ...prompt,
          status: (results[index]?.status as StepStatus) || STEP_STATUS.PENDING,
        }));

        withUndoPause(() =>
          set({
            fileName,
            workflowName: workflowName ?? null,
            prompts: promptsWithStatus,
            executionState,
            currentStep,
            totalSteps: prompts.length,
            finalPrompt,
            finalPromptStatus,
            finalPromptLoopCount,
            finalPromptPhase,
            // Clear runtime state on new workflow
            liveOrderedEntries: [],
            liveSequence: 0,
            retryStates: {},
            streamingChunks: {},
            finalPromptStreamingChunks: {},
          })
        );
        useWorkflowStore.temporal.getState().clear();
      },

      // ============================================================================
      // HISTORY MANAGEMENT
      // ============================================================================

      loadHistoryRun: (history, availableRuns, runIndex) =>
        withUndoPause(() =>
          set(() => {
            // Update uiStore for history view state
            useUiStore.getState().setHistoryView(runIndex, availableRuns);

            // Populate self-contained history snapshot.
            // Clear live-store undo records and snapshots so stale state from
            // a previous run or a different history selection doesn't bleed into
            // this run's view. History data in historyOutputs is the sole source
            // of truth for undo state while in history mode.
            return {
              historyOutputs: {
                orderedEntries: history.orderedEntries,
                promptOutputs: history.promptOutputs,
                finalPromptOutputs: history.finalPromptOutputs,
                runMetadata: {
                  runId: history.runId,
                  startedAt: history.startedAt,
                  completedAt: history.completedAt,
                  executionState: history.executionState,
                },
              },
              undoRecords: {},
              workspaceSnapshots: {},
              finalPromptWorkspaceSnapshots: {},
            };
          })
        ),

      clearHistoryOutputs: () =>
        withUndoPause(() => set(() => ({ historyOutputs: null }))),

      resetExecutionState: (prompts) => {
        // Not wrapped in pause/resume — this is a user-initiated action.
        // partialize ensures only prompts/workflowName/finalPrompt are snapshotted,
        // so executionState/currentStep changes here are NOT recorded in undo history.
        set(() => ({
          prompts: prompts.map((p) => ({ ...p, status: STEP_STATUS.PENDING })),
          totalSteps: prompts.length,
          executionState: EXECUTION_STATES.IDLE,
          currentStep: 0,
          finalPromptStatus: null,
          finalPromptLoopCount: 0,
          finalPromptPhase: null,
          // liveOrderedEntries, retryStates, streamingChunks, historyOutputs,
          // finalPromptStreamingChunks are intentionally preserved
          // so the run history and output panel are unaffected.
        }));
      },

      clearRuntimeStateFromStep: (startStep) =>
        withUndoPause(() =>
          set((state) => {
            const newRetryStates = { ...state.retryStates };
            const newStreamingChunks = { ...state.streamingChunks };

            Object.keys(newRetryStates).forEach((key) => {
              if (Number(key) >= startStep) {
                delete newRetryStates[Number(key)];
              }
            });
            Object.keys(newStreamingChunks).forEach((key) => {
              if (Number(key) >= startStep) {
                delete newStreamingChunks[Number(key)];
              }
            });

            return {
              liveOrderedEntries: state.liveOrderedEntries.filter(
                (e) => !("target" in e && (
                  (e.target.kind === FINAL_PROMPT_PHASES.QUEUE &&
                   (e.target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex >= startStep) ||
                  e.target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT
                ))
              ),
              retryStates: newRetryStates,
              streamingChunks: newStreamingChunks,
              finalPromptStreamingChunks: {},
              finalPromptStatus: null,
              finalPromptLoopCount: 0,
              finalPromptPhase: null,
            };
          })
        ),

      applyStartPositionChange: (prompts, newCurrentStep) => {
        // Not wrapped in pause/resume — this is a user-initiated action.
        // partialize ensures only prompts/workflowName/finalPrompt are snapshotted,
        // so currentStep/executionState changes here are NOT recorded in undo history.
        set(() => ({
          prompts,
          currentStep: newCurrentStep,
          totalSteps: prompts.length,
          executionState: EXECUTION_STATES.IDLE,
          finalPromptStatus: null,
        }));
      },

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
              (e) => "target" in e &&
                     e.target.kind === FINAL_PROMPT_PHASES.QUEUE &&
                     (e.target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex < stepCount
            );

            WebviewLog.debug(
              `[WorkflowStore] promoteHistoryToLive(${stepCount}): promoting ${entriesToPromote.length} entries from history`
            );

            return {
              liveOrderedEntries: [
                ...entriesToPromote,
                ...state.liveOrderedEntries.filter(
                  (e) => !("target" in e) ||
                         e.target.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT ||
                         (e.target.kind === FINAL_PROMPT_PHASES.QUEUE &&
                          (e.target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex >= stepCount)
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
            finalPromptStreamingChunks: {},
            finalPromptStatus: null,
            finalPromptLoopCount: 0,
            finalPromptPhase: null,
            workspaceSnapshots: {},
            finalPromptWorkspaceSnapshots: {},
            undoResults: {},
            undoRecords: {},
          })
        ),

      setWorkspaceSnapshot: (target, snapshot) =>
        withUndoPause(() => {
          if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
            set((state) => ({
              workspaceSnapshots: {
                ...state.workspaceSnapshots,
                [target.stepIndex]: snapshot,
              },
            }));
          } else {
            set((state) => ({
              finalPromptWorkspaceSnapshots: {
                ...state.finalPromptWorkspaceSnapshots,
                [target.loopIndex]: snapshot,
              },
            }));
          }
        }),

      setUndoRecord: (target, record) => {
        const key =
          target.kind === FINAL_PROMPT_PHASES.QUEUE
            ? `queue-${target.stepIndex}`
            : `finalPrompt-${target.loopIndex}`;
        withUndoPause(() =>
          set((s) => ({ undoRecords: { ...s.undoRecords, [key]: record } }))
        );
      },

      updateHistoryStepUndoRecord: (target, undoRecord) =>
        withUndoPause(() =>
          set((state) => {
            if (!state.historyOutputs) return {};
            if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
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
              if (!state.historyOutputs.finalPromptOutputs) return {};
              const step =
                state.historyOutputs.finalPromptOutputs[target.loopIndex];
              if (!step) return {};
              return {
                historyOutputs: {
                  ...state.historyOutputs,
                  finalPromptOutputs: {
                    ...state.historyOutputs.finalPromptOutputs,
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

      // ============================================================================
      // COMPUTED SELECTORS
      // ============================================================================

      /**
       * Check if there are pending prompts in the queue.
       * Returns true if there are prompts that haven't been executed yet.
       * Used to determine whether Run button should say "Run" or "Run Next".
       */
      hasPendingPrompts: () => {
        const { prompts, executionState, currentStep, totalSteps } = get();

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
        if (
          executionState === EXECUTION_STATES.RUNNING ||
          executionState === EXECUTION_STATES.PAUSED
        ) {
          return currentStep < totalSteps;
        }

        // If completed, no pending prompts
        return false;
      },

      getCurrentPrompt: () => {
        const { prompts, currentStep } = get();
        if (currentStep >= 0 && currentStep < prompts.length) {
          return prompts[currentStep];
        }
        return null;
      },

      getPromptByIndex: (index) => {
        const { prompts } = get();
        if (index >= 0 && index < prompts.length) {
          return prompts[index];
        }
        return null;
      },

      isWorkflowRunning: () =>
        get().executionState === EXECUTION_STATES.RUNNING,

      isWorkflowPaused: () => get().executionState === EXECUTION_STATES.PAUSED,

      isWorkflowStopped: () =>
        get().executionState === EXECUTION_STATES.STOPPED,

      isWorkflowIdle: () => get().executionState === EXECUTION_STATES.IDLE,

      isWorkflowComplete: () =>
        get().executionState === EXECUTION_STATES.COMPLETED,

      getStepOutputs: (stepIndex) => {
        const entries = get().liveOrderedEntries;
        return entries
          .filter((e): e is OrderedCliHistoryEntry =>
            e.kind === "cli" &&
            "target" in e &&
            (e as OrderedCliHistoryEntry).target.kind === FINAL_PROMPT_PHASES.QUEUE &&
            ((e as OrderedCliHistoryEntry).target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex === stepIndex
          )
          .map((e) => e.cliOutput);
      },

      getLatestOutput: (stepIndex) => {
        const entries = get().liveOrderedEntries;
        const cliEntries = entries
          .filter((e): e is OrderedCliHistoryEntry =>
            e.kind === "cli" &&
            "target" in e &&
            (e as OrderedCliHistoryEntry).target.kind === FINAL_PROMPT_PHASES.QUEUE &&
            ((e as OrderedCliHistoryEntry).target as { kind: typeof FINAL_PROMPT_PHASES.QUEUE; stepIndex: number }).stepIndex === stepIndex
          )
          .map((e) => e.cliOutput);
        return cliEntries.length > 0 ? cliEntries[cliEntries.length - 1] : null;
      },

      isStepFailed: (stepIndex) => {
        const { prompts } = get();
        const prompt = prompts[stepIndex];
        return prompt?.status === STEP_STATUS.FAILED;
      },

      getCompletedCount: () => {
        const { prompts } = get();
        return prompts.filter((p) => p.status === STEP_STATUS.COMPLETED).length;
      },
    }),
    {
      partialize: (state): UndoableWorkflowState => ({
        prompts: state.prompts,
        workflowName: state.workflowName,
        finalPrompt: state.finalPrompt,
        currentStep: state.currentStep,
      }),
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
  PromptItem,
  CliOutput,
  RetryState,
  StatusMessage,
} from "../types/messages";

export interface UndoableWorkflowState {
  prompts: PromptItem[];
  workflowName: string | null;
  finalPrompt: PromptItem | null;
  currentStep: number;
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
