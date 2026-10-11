import { create } from "zustand";
import { useState, useEffect, useRef } from "react";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
  type ExecutionState,
  type StepStatus,
  type FinalStepPhase,
  type PromptStep,
  type CliOutput,
  type RetryState,
  type ExecutionPhase,
  getStreamingChunkKey,
  parseStreamingChunkKey,
  isPromptExecutionPhase,
} from "../types/messages";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { isWorkflowRunning, isWorkflowActive } from "../utils/status";
import { joinCliTextEvents } from "../utils/outputUtils";
import { appendResponseText } from "@root/utils/ResponseTextJoin";
import type {
  WorktreeRunProjection,
  CoordinationScopeSnapshot,
  WorkflowStopReason,
} from "@root/types/CtrlYokeTypes";
import type {
  ParallelGroupDefinition,
  WorkflowValidationWarning,
} from "@root/types/CtrlYokeTypes";

/**
 * Runtime execution status the extension stamps onto each step (`setStepStatus`
 * below, and the STEPS_EXTENDED handler). It is not an authored field, so it
 * lives here rather than on `StepDisplayProperties`; declaring it keeps readers
 * from re-inventing `step as { status?: string }` casts, which hid the field
 * from the language service and from `find-dead-methods.mjs`.
 */
interface StepRuntimeStatus {
  status?: StepStatus;
}

/**
 * Webview-local WorkflowStep union: uses WebviewMessageTypes.PromptStep
 * to avoid _runtime type incompatibility with CtrlYokeTypes.PromptStep.
 */
export type WorkflowStep = (PromptStep | ScriptStep) & StepRuntimeStatus;

/** Type guard for script steps (webview-local version) */
function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

/**
 * Deep, key-order-independent equality for JSON-shaped values. A key present
 * with value `undefined` is treated as absent, matching how the rest of the
 * codebase treats an omitted optional field.
 */
function deepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepValueEqual(item, b[index]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const aKeys = Object.keys(ra).filter((key) => ra[key] !== undefined);
  const bKeys = Object.keys(rb).filter((key) => rb[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => bKeys.includes(key) && deepValueEqual(ra[key], rb[key])
  );
}

/**
 * Whether two workflow steps are equal in every user-editable field — the
 * single source of truth for "did the user change this step's content."
 * Ignores runtime-only fields (`status`, `_runtime`) so execution bookkeeping
 * never pollutes the undo stack.
 *
 * Used by both zundo's `equality` option below and the STEPS_EXTENDED handler
 * in useMessageHandler.ts. Previously each kept its own hand-written allow-list
 * of fields to compare, so any step property missing from *both* lists (e.g.
 * `resumeSession`, `mcpServers`, `toolPermissions`, `additionalArgs`) never
 * registered as undoable no matter which one edited it.
 */
export function isStepContentEqual(a: WorkflowStep, b: WorkflowStep): boolean {
  const {
    status: _statusA,
    _runtime: _runtimeA,
    ...restA
  } = a as unknown as Record<string, unknown>;
  const {
    status: _statusB,
    _runtime: _runtimeB,
    ...restB
  } = b as unknown as Record<string, unknown>;
  return deepValueEqual(restA, restB);
}
import type {
  OrderedHistoryEntry,
  OrderedCliHistoryEntry,
  OrderedStatusHistoryEntry,
  OutputActivityEntry,
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
import {
  canCoalesceTextEvents,
  coalesceTextEvents,
} from "@root/utils/ThinkingBlockFormat";
import {
  cliEntryIdentityKey,
  getCliEntryIdentity,
  matchesCliEntryIdentity,
  type CliEntryIdentity,
} from "@utils/outputProjection";

/**
 * Merge incoming structured events into an existing CliOutput array.
 * Consecutive TEXT or THINKING events of the same type (and same label) are
 * concatenated into a single event so the UI renders them as continuous text.
 */
function mergeStreamingEvents(existing: any[], incoming: any[]): any[] {
  const result = [...existing];
  for (const event of incoming) {
    const last = result[result.length - 1];
    if (canCoalesceTextEvents(last, event)) {
      result[result.length - 1] = coalesceTextEvents(last, event);
      continue;
    }
    result.push(event);
  }
  return normalizeCliEvents(result);
}

/**
 * Decide what a batch of incoming streamed events should open with, prefixing
 * the one-time "follow-up" divider when `existing` is already complete
 * (`isStreaming: false`) — post-completion follow-up activity, a harness
 * auto-resuming a backgrounded task or a human typing into the still-open
 * terminal (see `SessionActivityWatcher` /
 * `WorkflowInstance.handleSessionActivityResumed`). `CONTEXT_WINDOW_SYNC` is
 * an invisible marker, filtered out here rather than rendered as a row.
 *
 * Single-sourced so the aggregate CliOutput merge below and the raw activity
 * entry recorded alongside it (`appendStreamingEventsToOutputState`) always
 * agree on whether this batch carries the divider: `mapOrderedHistoryEntriesToMessages`
 * renders a target from its activity entries whenever any exist, so a divider
 * only the aggregate saw would never reach the rendered rows.
 */
function computeStreamingEventsToMerge(
  existing: CliOutput | undefined,
  incomingEvents: any[]
): any[] {
  const isFollowUp = existing?.isStreaming === false;
  const contentEvents = incomingEvents.filter(
    (event) => event.type !== CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC
  );
  if (!isFollowUp) {
    return contentEvents;
  }

  const existingStructured = existing?.structured as any;
  const existingEvents = existingStructured?.events || [];
  const hasFollowUpDivider = existingEvents.some(
    (event: any) => event.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
  );

  return contentEvents.length > 0 && !hasFollowUpDivider
    ? [
        {
          type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
          timestamp: Date.now(),
          data: { resumedAt: Date.now() },
        },
        ...contentEvents,
      ]
    : contentEvents;
}

/**
 * Merge an incoming batch of streamed events into an existing CliOutput. When
 * the batch is post-completion follow-up activity, also appends its text to
 * `response` (mirroring what `SessionActivityRecorder` persists, so copy reads
 * the same thing live and after a reload) and refreshes the stats footer
 * (elapsed/context window) so it doesn't go stale while resumed activity
 * streams in — otherwise this is an ordinary incremental append.
 */
function mergeResumedActivityIntoOutput(
  existing: CliOutput,
  incomingEvents: any[]
): CliOutput {
  const isFollowUp = existing.isStreaming === false;
  const latestContextWindowSync = [...incomingEvents]
    .reverse()
    .find((event) => event.type === CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC)
    ?.data as { used: number; size: number } | undefined;

  const existingStructured = existing.structured as any;
  const existingEvents = existingStructured?.events || [];
  const eventsToMerge = computeStreamingEventsToMerge(existing, incomingEvents);

  const followUpText = isFollowUp ? joinCliTextEvents(eventsToMerge) : "";

  return {
    ...existing,
    response: followUpText
      ? appendResponseText(existing.response ?? "", followUpText)
      : existing.response,
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
  parallelGroups: ParallelGroupDefinition[];
  executionState: ExecutionState;
  stopReason?: WorkflowStopReason;
  currentStep: number;
  activeStepIndices: number[];
  totalSteps: number;
  finalStep: WorkflowStep | null;
  finalStepStatus: StepStatus | null;
  finalStepLoopCount: number;
  finalStepPhase: FinalStepPhase | null;
  schemaWarnings: WorkflowValidationWarning[];

  // Live ordered output entries (queue + finalStep outputs and status messages)
  liveOrderedEntries: OrderedHistoryEntry[];
  liveSequence: number;
  /** Target-attributed semantic activities shared by live output and replay. */
  liveActivityEntries: OutputActivityEntry[];
  retryStates: Record<number, RetryState>;

  // Streaming state (for incremental output)
  streamingChunks: Record<string, string>;
  finalStepStreamingChunks: Record<string, string>;

  // Self-contained history snapshot for the currently-viewed historical run.
  // When isViewingHistory=true (in uiStore), OutputSection renders from historyOutputs
  // instead of liveOrderedEntries. Post-completion session activity updates both
  // collections so a retired run remains live while its terminal is still open.
  historyOutputs: {
    orderedEntries: OrderedHistoryEntry[];
    activityEntries?: OutputActivityEntry[];
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
  /** Live context window usage per final-step pass. */
  liveFinalStepContextWindow: Record<number, { used: number; size: number }>;
  coordinationScope: CoordinationScopeSnapshot | null;
}

/**
 * Workflow actions
 */
interface WorkflowActions {
  // Setters
  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (steps: WorkflowStep[]) => void;
  setParallelGroups: (parallelGroups: ParallelGroupDefinition[]) => void;
  /**
   * Apply a step list and its parallel-group topology in one `set`, i.e. as a
   * single undo entry.
   *
   * A reorder can move either half independently — dragging the last member of
   * a group down one slot leaves the step order untouched and changes only the
   * group's membership — so both have to reach zundo, and they have to reach
   * it together. Two separate setters give a topology-only drag no undo entry
   * at all (the parallel-group half is paused to avoid double-recording), and
   * a drag that moves both would cost two undos to reverse one gesture.
   */
  setStepsAndParallelGroups: (
    steps: WorkflowStep[],
    parallelGroups: ParallelGroupDefinition[]
  ) => void;
  updatePrompt: (index: number, updates: Partial<PromptStep>) => void;
  setExecutionState: (state: ExecutionState) => void;
  setStopReason: (reason?: WorkflowStopReason) => void;
  setCurrentStep: (step: number) => void;
  setActiveStepIndices: (stepIndices: number[]) => void;
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
    phase?: ExecutionPhase,
    runIndex?: number,
    attemptIndex?: number,
    timestampMs?: number,
    sequence?: number
  ) => void;
  clearStreamingChunk: (
    stepIndex: number,
    phase?: ExecutionPhase,
    runIndex?: number,
    attemptIndex?: number
  ) => void;
  appendStreamingEvents: (
    stepIndex: number,
    events: any[],
    attemptIndex?: number,
    runIndex?: number,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ) => void;
  appendFinalStepStreamingChunk: (
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    runIndex?: number,
    attemptIndex?: number,
    timestampMs?: number,
    sequence?: number
  ) => void;
  clearFinalStepStreamingChunk: (
    loopIndex: number,
    phase?: ExecutionPhase,
    runIndex?: number,
    attemptIndex?: number
  ) => void;
  appendFinalStepStreamingEvents: (
    loopIndex: number,
    events: any[],
    attemptIndex?: number,
    runIndex?: number,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
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
  updateHistoryWorktree: (worktree: WorktreeRunProjection) => void;
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
    parallelGroups?: ParallelGroupDefinition[];
    executionState?: ExecutionState;
    stopReason?: WorkflowStopReason;
    currentStep?: number;
    activeStepIndices?: number[];
    results?: Array<{ status?: StepStatus }>;
    finalStep?: WorkflowStep | null;
    finalStepStatus?: StepStatus | null;
    finalStepLoopCount?: number;
    finalStepPhase?: FinalStepPhase | null;
    schemaWarnings?: WorkflowValidationWarning[];
    /**
     * Same-view snapshot replay: keep live output and streaming/runtime state
     * instead of clearing them. Only pass true when the incoming snapshot
     * re-describes the workflow the store already holds (same address, same
     * definition revision) — for a genuine workflow/run switch the runtime
     * state belongs to the previous view and must clear.
     */
    preserveLiveOutput?: boolean;
    /**
     * Whether the zundo history survives this load. Defaults to
     * `preserveLiveOutput`, which is the right answer for every caller that
     * only ever loads a *different* workflow.
     *
     * It is a separate decision because the two answer different questions.
     * Runtime state belongs to one revision of one run; an editing epoch
     * belongs to the *address*. Every run-addressed write publishes a full
     * invalidation snapshot back to the very client that made it, carrying a
     * bumped revision — so tying the history to `preserveLiveOutput` meant the
     * client's own edit came back and erased the undo entry it had just
     * recorded (the "undo lights up for an instant after a drag-reorder"
     * report), and one undo erased the rest of the stack along with any
     * chance of redoing it. The epoch genuinely restarts on an address change
     * or a definition rollback, and RUN_VIEW_LOADED passes that judgement in.
     */
    preserveUndoHistory?: boolean;
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
  updateLiveFinalStepContextWindow: (
    loopIndex: number,
    used: number,
    size: number
  ) => void;
  setCoordinationScope: (scope: CoordinationScopeSnapshot | null) => void;
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
  parallelGroups: [],
  executionState: EXECUTION_STATES.IDLE,
  stopReason: undefined,
  currentStep: 0,
  activeStepIndices: [],
  totalSteps: 0,
  finalStep: null,
  finalStepStatus: null,
  finalStepLoopCount: 0,
  finalStepPhase: null,
  schemaWarnings: [],
  liveOrderedEntries: [],
  liveSequence: 0,
  liveActivityEntries: [],
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
  liveFinalStepContextWindow: {},
  coordinationScope: null,
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

/**
 * The identity tuple that decides whether two CLI records describe the same
 * logical attempt output. `phase` is part of it: one step's pre-condition,
 * prompt, and end-condition all share `(target, runIndex, attemptIndex)`.
 */
function findCliEntryIndexByIdentity(
  entries: OrderedHistoryEntry[],
  identity: CliEntryIdentity
): number {
  return entries.findIndex((entry) => matchesCliEntryIdentity(entry, identity));
}

function findMatchingCliEntryIndex(
  entries: OrderedHistoryEntry[],
  cliEntry: OrderedCliHistoryEntry
): number {
  return findCliEntryIndexByIdentity(entries, getCliEntryIdentity(cliEntry));
}

function activityEntryKey(entry: OutputActivityEntry): string {
  // Compose the canonical identity key rather than re-deriving its fields by
  // hand — a hand-rolled duplicate of the same format is exactly what let the
  // outputProjection.ts activity/aggregate lookup silently drift apart.
  return `${cliEntryIdentityKey(entry)}:${entry.kind}`;
}

function mergeActivityEntry(
  entries: readonly OutputActivityEntry[],
  incoming: OutputActivityEntry
): OutputActivityEntry[] {
  const key = activityEntryKey(incoming);
  const index = entries.findIndex(
    (entry) =>
      activityEntryKey(entry) === key && entry.sequence === incoming.sequence
  );
  if (index < 0) return [...entries, incoming];

  const existing = entries[index];
  const merged: OutputActivityEntry = {
    ...existing,
    timestampMs: Math.min(existing.timestampMs, incoming.timestampMs),
    sequence: Math.min(existing.sequence, incoming.sequence),
    text:
      incoming.text === undefined
        ? existing.text
        : `${existing.text ?? ""}${incoming.text}`,
    events:
      incoming.events === undefined
        ? existing.events
        : mergeStreamingEvents(existing.events ?? [], incoming.events),
  };
  const next = [...entries];
  next[index] = merged;
  return next;
}

/**
 * Content identity for a status activity, used instead of its sequence.
 * `appendLiveEntry` stamps a live status with the webview's own `liveSequence`,
 * which has no relationship to the timeline sequence the durable copy carries.
 */
function statusActivityContentKey(entry: OutputActivityEntry): string {
  return `${activityEntryKey(entry)}:${entry.severity ?? ""}:${entry.text ?? ""}`;
}

/**
 * Overlay the panel's live activity entries onto the run's durable timeline.
 *
 * Both sides describe the same run, so a live entry the timeline has already
 * persisted must be recognised as *the same* entry rather than merged into it.
 * Folding it in with `mergeActivityEntry` instead concatenated its events onto
 * the identical durable copy, and this runs on every re-delivery of an
 * executing run's snapshot: each one added another copy of every already-
 * persisted batch, so the output pane showed a step's events twice after one
 * re-hydration, three times after two, and only came right once the run
 * finished and a pure history load replaced the accumulated entries.
 *
 * Matching differs by kind because the two sides only agree on different
 * fields:
 * - Streamed text/structured batches carry the timeline sequence the extension
 *   published them under (`publishStreamingFlush`), so identity + sequence is
 *   exact. The live copy wins: it is the same timeline event already projected
 *   for display, with the follow-up divider decided and the invisible
 *   context-window markers filtered out.
 * - Status messages carry a webview-local sequence, and a replayed status does
 *   not preserve its original timestamp, so they match on content and each
 *   durable occurrence is claimed at most once — the same rule
 *   `overlayLiveHistoryEntries` applies to the ordered status entries.
 *
 * A live entry with no durable counterpart has not reached the timeline yet and
 * is appended, which is what keeps the newest streamed batch on screen.
 */
function reconcileActivityEntries(
  durable: readonly OutputActivityEntry[],
  live: readonly OutputActivityEntry[]
): OutputActivityEntry[] {
  const merged = [...durable];
  const claimedStatusIndices = new Set<number>();

  for (const entry of live) {
    if (entry.kind === OUTPUT_ACTIVITY_KINDS.STATUS) {
      const contentKey = statusActivityContentKey(entry);
      const matchingIdx = merged.findIndex(
        (candidate, candidateIdx) =>
          !claimedStatusIndices.has(candidateIdx) &&
          candidate.kind === OUTPUT_ACTIVITY_KINDS.STATUS &&
          statusActivityContentKey(candidate) === contentKey
      );
      if (matchingIdx >= 0) {
        claimedStatusIndices.add(matchingIdx);
        continue;
      }
      merged.push(entry);
      continue;
    }

    const key = activityEntryKey(entry);
    const matchingIdx = merged.findIndex(
      (candidate) =>
        activityEntryKey(candidate) === key &&
        candidate.sequence === entry.sequence
    );
    if (matchingIdx < 0) {
      merged.push(entry);
      continue;
    }
    merged[matchingIdx] = entry;
  }

  return merged.sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.sequence - right.sequence
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

interface StreamingEventsEntryMerge {
  entries: OrderedHistoryEntry[];
  matchedEntry?: OrderedCliHistoryEntry;
}

function mergeStreamingEventsIntoEntries(
  entries: OrderedHistoryEntry[],
  identity: CliEntryIdentity,
  events: any[]
): StreamingEventsEntryMerge {
  const existingIdx = findCliEntryIndexByIdentity(entries, identity);
  if (existingIdx < 0) {
    return { entries };
  }

  const existing = entries[existingIdx] as OrderedCliHistoryEntry;
  const matchedEntry: OrderedCliHistoryEntry = {
    ...existing,
    cliOutput: mergeResumedActivityIntoOutput(existing.cliOutput, events),
  };
  const updatedEntries = [...entries];
  updatedEntries[existingIdx] = matchedEntry;
  return { entries: updatedEntries, matchedEntry };
}

function appendStreamingEventsToOutputState(
  state: WorkflowState,
  target: OutputExecutionTarget,
  events: any[],
  attemptIndex: number,
  runIndex: number,
  phase: ExecutionPhase | undefined,
  timestampMs: number | undefined,
  sequence: number | undefined
): Pick<
  WorkflowState,
  | "liveOrderedEntries"
  | "liveSequence"
  | "historyOutputs"
  | "liveActivityEntries"
> {
  const identity: CliEntryIdentity = {
    target,
    runIndex,
    attemptIndex,
    phase,
  };
  const liveMerge = mergeStreamingEventsIntoEntries(
    state.liveOrderedEntries,
    identity,
    events
  );
  const historyMerge = state.historyOutputs
    ? mergeStreamingEventsIntoEntries(
        state.historyOutputs.orderedEntries,
        identity,
        events
      )
    : undefined;

  // The activity entry below feeds `mapOrderedHistoryEntriesToMessages`,
  // which renders a target from its activity entries whenever any exist —
  // so it must carry the same follow-up divider the aggregate merge above
  // just decided on, computed against the same pre-merge existing output, or
  // the divider row would exist in the aggregate but never reach the screen.
  // A "retired run" (see workflowStore.test.ts) has no live entry yet, so
  // fall back to the persisted history entry exactly like the fallback below.
  const existingLiveIdx = findCliEntryIndexByIdentity(
    state.liveOrderedEntries,
    identity
  );
  const existingHistoryIdx = state.historyOutputs
    ? findCliEntryIndexByIdentity(state.historyOutputs.orderedEntries, identity)
    : -1;
  const existingOutputForActivity =
    existingLiveIdx >= 0
      ? (state.liveOrderedEntries[existingLiveIdx] as OrderedCliHistoryEntry)
          .cliOutput
      : existingHistoryIdx >= 0
        ? (
            state.historyOutputs!.orderedEntries[
              existingHistoryIdx
            ] as OrderedCliHistoryEntry
          ).cliOutput
        : undefined;
  const eventsForActivity = computeStreamingEventsToMerge(
    existingOutputForActivity,
    events
  );

  let liveOrderedEntries = liveMerge.entries;
  let liveSequence = state.liveSequence;
  if (!liveMerge.matchedEntry) {
    const historyEntry = historyMerge?.matchedEntry;
    const cliOutput: CliOutput = historyEntry?.cliOutput ?? {
      prompt: "",
      response: "",
      structured: {
        events: mergeStreamingEvents([], events),
        metadata: {},
      },
      elapsed: 0,
      isStreaming: true,
      timestampMs: timestampMs ?? Date.now(),
      attemptIndex,
      runIndex,
    };
    const entry: OrderedCliHistoryEntry = {
      ...(historyEntry ?? {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target,
        runIndex,
        attemptIndex,
        // `phase` is part of the identity this entry is looked up by, so
        // omitting it filed a condition/worktree-setup batch under the prompt
        // phase: the next batch for the same script never matched it, and the
        // step's own AI output did.
        phase,
        cliOutput,
        timestampMs: cliOutput.timestampMs!,
      }),
      sequence: sequence ?? liveSequence,
    };
    liveOrderedEntries = [...liveOrderedEntries, entry];
    liveSequence = Math.max(liveSequence + 1, (sequence ?? liveSequence) + 1);
  }

  const activityEntry: OutputActivityEntry = {
    timestampMs: timestampMs ?? Date.now(),
    sequence: sequence ?? liveSequence,
    target,
    runIndex,
    attemptIndex,
    phase,
    kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
    events: eventsForActivity,
  };
  const liveActivityEntries = mergeActivityEntry(
    state.liveActivityEntries,
    activityEntry
  );
  const historyActivityEntries = state.historyOutputs
    ? mergeActivityEntry(
        state.historyOutputs.activityEntries ?? [],
        activityEntry
      )
    : undefined;

  return {
    liveOrderedEntries,
    liveSequence,
    liveActivityEntries,
    historyOutputs: state.historyOutputs
      ? {
          ...state.historyOutputs,
          orderedEntries:
            historyMerge?.entries ?? state.historyOutputs.orderedEntries,
          activityEntries:
            historyActivityEntries ??
            state.historyOutputs.activityEntries ??
            [],
        }
      : state.historyOutputs,
  };
}

function appendStreamingChunkToActivityState(
  state: WorkflowState,
  target: OutputExecutionTarget,
  chunk: string,
  runIndex: number,
  attemptIndex: number,
  phase: ExecutionPhase | undefined,
  timestampMs: number | undefined,
  sequence: number | undefined
): Pick<
  WorkflowState,
  "liveActivityEntries" | "historyOutputs" | "liveSequence"
> {
  const activityEntry: OutputActivityEntry = {
    timestampMs: timestampMs ?? Date.now(),
    sequence: sequence ?? state.liveSequence,
    target,
    runIndex,
    attemptIndex,
    phase,
    kind: OUTPUT_ACTIVITY_KINDS.TEXT,
    text: chunk,
  };
  const liveActivityEntries = mergeActivityEntry(
    state.liveActivityEntries,
    activityEntry
  );
  return {
    liveActivityEntries,
    liveSequence: Math.max(
      state.liveSequence + 1,
      (sequence ?? state.liveSequence) + 1
    ),
    historyOutputs: state.historyOutputs
      ? {
          ...state.historyOutputs,
          activityEntries: mergeActivityEntry(
            state.historyOutputs.activityEntries ?? [],
            activityEntry
          ),
        }
      : state.historyOutputs,
  };
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

      setCoordinationScope: (coordinationScope) => set({ coordinationScope }),

      setPrompts: (steps) => {
        // Diagnostic logging for the "running badge/highlight never appear on
        // start" bug — correlates step-count changes against the
        // executionState/currentStep transitions logged below.
        const prevStepCount = get().steps.length;
        if (prevStepCount !== steps.length) {
          WebviewLog.debug(
            `[workflowStore.setPrompts] steps.length ${prevStepCount} -> ${steps.length} ` +
              `(executionState=${get().executionState}, currentStep=${get().currentStep})`
          );
        }
        set({
          steps,
          totalSteps: steps.length,
        });
      },

      setParallelGroups: (parallelGroups) =>
        set({
          parallelGroups,
        }),

      setStepsAndParallelGroups: (steps, parallelGroups) =>
        set({
          steps,
          totalSteps: steps.length,
          parallelGroups,
        }),

      updatePrompt: (index, updates) => {
        set((state) => ({
          steps: state.steps.map((p, i) =>
            i === index ? ({ ...p, ...updates } as WorkflowStep) : p
          ),
        }));
      },

      setExecutionState: (executionState) => {
        // Diagnostic logging for the "running badge/highlight never appear on
        // start" bug — every transition this store makes, so we can tell
        // whether the store itself ever saw RUNNING (vs. a render-only bug).
        const prevExecutionState = get().executionState;
        if (prevExecutionState !== executionState) {
          WebviewLog.debug(
            `[workflowStore.setExecutionState] ${prevExecutionState} -> ${executionState} ` +
              `(currentStep=${get().currentStep}, steps.length=${get().steps.length})`
          );
        }
        withUndoPause(() => set({ executionState }));
      },
      setStopReason: (stopReason) => withUndoPause(() => set({ stopReason })),

      setCurrentStep: (currentStep) => {
        const prevCurrentStep = get().currentStep;
        if (prevCurrentStep !== currentStep) {
          WebviewLog.debug(
            `[workflowStore.setCurrentStep] ${prevCurrentStep} -> ${currentStep} ` +
              `(executionState=${get().executionState}, steps.length=${get().steps.length})`
          );
        }
        withUndoPause(() => set({ currentStep }));
      },

      setActiveStepIndices: (activeStepIndices) =>
        withUndoPause(() => set({ activeStepIndices: [...activeStepIndices] })),

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
                liveFinalStepContextWindow: {},
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
          set((state) => ({
            finalStepStatus: status,
            finalStepLoopCount: loopCount,
            finalStepPhase: phase,
            ...(state.finalStepLoopCount !== loopCount
              ? { liveFinalStepContextWindow: {} }
              : {}),
          }))
        ),

      // ============================================================================
      // LIVE ENTRY MANAGEMENT
      // ============================================================================

      appendLiveEntry: (entry) =>
        withUndoPause(() =>
          set((state) => {
            if (entry.kind === OUTPUT_HISTORY_KINDS.CLI) {
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
            const activityEntries =
              entry.kind === OUTPUT_HISTORY_KINDS.STATUS
                ? mergeActivityEntry(state.liveActivityEntries, {
                    timestampMs: entry.timestampMs,
                    sequence: entry.sequence,
                    target: entry.target,
                    runIndex: 0,
                    attemptIndex: 0,
                    kind: OUTPUT_ACTIVITY_KINDS.STATUS,
                    text: entry.statusMessage.message,
                    severity: entry.statusMessage.severity,
                  })
                : state.liveActivityEntries;
            return {
              liveOrderedEntries: [...state.liveOrderedEntries, entry],
              liveActivityEntries: activityEntries,
              liveSequence: state.liveSequence + 1,
              historyOutputs:
                state.historyOutputs &&
                entry.kind === OUTPUT_HISTORY_KINDS.STATUS
                  ? {
                      ...state.historyOutputs,
                      activityEntries: mergeActivityEntry(
                        state.historyOutputs.activityEntries ?? [],
                        {
                          timestampMs: entry.timestampMs,
                          sequence: entry.sequence,
                          target: entry.target,
                          runIndex: 0,
                          attemptIndex: 0,
                          kind: OUTPUT_ACTIVITY_KINDS.STATUS,
                          text: entry.statusMessage.message,
                          severity: entry.statusMessage.severity,
                        }
                      ),
                    }
                  : state.historyOutputs,
            };
          })
        ),

      clearLiveEntries: () =>
        withUndoPause(() =>
          set({
            liveOrderedEntries: [],
            liveActivityEntries: [],
            liveSequence: 0,
          })
        ),

      appendStreamingChunk: (
        stepIndex,
        chunk,
        phase,
        runIndex = 0,
        attemptIndex = 0,
        timestampMs,
        sequence
      ) =>
        withUndoPause(() =>
          set((state) => ({
            ...appendStreamingChunkToActivityState(
              state,
              { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
              chunk,
              runIndex,
              attemptIndex,
              phase,
              timestampMs,
              sequence
            ),
            streamingChunks: {
              ...state.streamingChunks,
              [getStreamingChunkKey(
                stepIndex,
                phase,
                runIndex,
                attemptIndex,
                OUTPUT_ACTIVITY_KINDS.TEXT,
                FINAL_STEP_PHASES.QUEUE
              )]:
                (state.streamingChunks[
                  getStreamingChunkKey(
                    stepIndex,
                    phase,
                    runIndex,
                    attemptIndex,
                    OUTPUT_ACTIVITY_KINDS.TEXT,
                    FINAL_STEP_PHASES.QUEUE
                  )
                ] || "") + chunk,
            },
          }))
        ),

      clearStreamingChunk: (stepIndex, phase, runIndex = 0, attemptIndex = 0) =>
        withUndoPause(() =>
          set((state) => ({
            streamingChunks: {
              ...state.streamingChunks,
              [getStreamingChunkKey(
                stepIndex,
                phase,
                runIndex,
                attemptIndex,
                OUTPUT_ACTIVITY_KINDS.TEXT,
                FINAL_STEP_PHASES.QUEUE
              )]: "",
            },
          }))
        ),

      appendStreamingEvents: (
        stepIndex,
        events,
        attemptIndex = 0,
        runIndex = 0,
        phase,
        timestampMs,
        sequence
      ) =>
        withUndoPause(() =>
          set((state) =>
            appendStreamingEventsToOutputState(
              state,
              {
                kind: FINAL_STEP_PHASES.QUEUE,
                stepIndex,
              },
              events,
              attemptIndex,
              runIndex,
              phase,
              timestampMs,
              sequence
            )
          )
        ),

      appendFinalStepStreamingChunk: (
        loopIndex,
        chunk,
        phase,
        runIndex = 0,
        attemptIndex = 0,
        timestampMs,
        sequence
      ) =>
        withUndoPause(() =>
          set((state) => ({
            ...appendStreamingChunkToActivityState(
              state,
              { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex },
              chunk,
              runIndex,
              attemptIndex,
              phase,
              timestampMs,
              sequence
            ),
            finalStepStreamingChunks: {
              ...state.finalStepStreamingChunks,
              [getStreamingChunkKey(
                loopIndex,
                phase,
                runIndex,
                attemptIndex,
                OUTPUT_ACTIVITY_KINDS.TEXT,
                FINAL_STEP_PHASES.FINAL_STEP
              )]:
                (state.finalStepStreamingChunks[
                  getStreamingChunkKey(
                    loopIndex,
                    phase,
                    runIndex,
                    attemptIndex,
                    OUTPUT_ACTIVITY_KINDS.TEXT,
                    FINAL_STEP_PHASES.FINAL_STEP
                  )
                ] || "") + chunk,
            },
          }))
        ),

      clearFinalStepStreamingChunk: (
        loopIndex,
        phase,
        runIndex = 0,
        attemptIndex = 0
      ) =>
        withUndoPause(() =>
          set((state) => ({
            finalStepStreamingChunks: {
              ...state.finalStepStreamingChunks,
              [getStreamingChunkKey(
                loopIndex,
                phase,
                runIndex,
                attemptIndex,
                OUTPUT_ACTIVITY_KINDS.TEXT,
                FINAL_STEP_PHASES.FINAL_STEP
              )]: "",
            },
          }))
        ),

      appendFinalStepStreamingEvents: (
        loopIndex,
        events,
        attemptIndex = 0,
        runIndex = 0,
        phase,
        timestampMs,
        sequence
      ) =>
        withUndoPause(() =>
          set((state) =>
            appendStreamingEventsToOutputState(
              state,
              {
                kind: FINAL_STEP_PHASES.FINAL_STEP,
                loopIndex,
              },
              events,
              attemptIndex,
              runIndex,
              phase,
              timestampMs,
              sequence
            )
          )
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
        parallelGroups = [],
        executionState = EXECUTION_STATES.IDLE,
        stopReason,
        currentStep = 0,
        activeStepIndices = [],
        results = [],
        finalStep = null,
        finalStepStatus = null,
        finalStepLoopCount = 0,
        finalStepPhase = null,
        schemaWarnings = [],
        preserveLiveOutput = false,
        preserveUndoHistory = preserveLiveOutput,
      }) => {
        // Apply status from results to prompts
        const promptsWithStatus = steps.map((prompt, index) => ({
          ...prompt,
          status: (results[index]?.status as StepStatus) || STEP_STATUS.PENDING,
        })) as WorkflowStep[];

        // Diagnostic logging for the "running badge/highlight never appear on
        // start" bug — loadWorkflow (RUN_VIEW_LOADED snapshots) sets
        // executionState/currentStep/steps in one shot, bypassing the
        // setExecutionState/setCurrentStep/setPrompts logging above, so log
        // it separately here.
        {
          const prev = get();
          if (
            prev.executionState !== executionState ||
            prev.currentStep !== currentStep ||
            prev.steps.length !== steps.length
          ) {
            WebviewLog.debug(
              `[workflowStore.loadWorkflow] fileName="${fileName}" executionState=${prev.executionState}->${executionState}, ` +
                `currentStep=${prev.currentStep}->${currentStep}, steps.length=${prev.steps.length}->${steps.length}`
            );
          }
        }

        withUndoPause(() =>
          set((state) => ({
            fileName,
            workflowName: workflowName ?? null,
            // Structural sharing: snapshot replays of an unchanged definition
            // must not hand the output pane fresh step identities — that alone
            // rebuilds every rendered row (see utils/structuralSharing.ts).
            steps: preserveReferences(state.steps, promptsWithStatus),
            parallelGroups: preserveReferences(
              state.parallelGroups,
              parallelGroups
            ),
            executionState,
            stopReason,
            currentStep,
            activeStepIndices: [...activeStepIndices],
            totalSteps: steps.length,
            finalStep: preserveReferences(state.finalStep, finalStep),
            finalStepStatus,
            finalStepLoopCount,
            finalStepPhase,
            schemaWarnings,
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
                  liveActivityEntries: preserveReferences(
                    state.liveActivityEntries,
                    []
                  ) as OutputActivityEntry[],
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
                  liveFinalStepContextWindow: preserveReferences(
                    state.liveFinalStepContextWindow,
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
        // Only a new editing epoch drops the undo history — see
        // `preserveUndoHistory`. A revision bump on the address the client is
        // already editing is not one.
        if (!preserveUndoHistory) {
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
                activityEntries: history.activityEntries ?? [],
                promptOutputs: history.promptOutputs,
                finalStepOutputs: history.finalStepOutputs,
                runMetadata: {
                  runId: history.runId,
                  startedAt: history.startedAt,
                  completedAt: history.completedAt,
                  executionState: history.executionState,
                  worktree: history.worktree,
                  worktreeNotice: history.worktreeNotice,
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

      updateHistoryWorktree: (worktree) =>
        set((state) => {
          if (!state.historyOutputs) return state;
          return {
            historyOutputs: {
              ...state.historyOutputs,
              runMetadata: {
                ...state.historyOutputs.runMetadata,
                worktree,
              },
            },
          };
        }),

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
              liveActivityEntries: preserveReferences(
                state.liveActivityEntries,
                reconcileActivityEntries(
                  history.activityEntries ?? [],
                  state.liveActivityEntries
                )
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
              const target = parseStreamingChunkKey(key);
              if (
                target?.targetKind === FINAL_STEP_PHASES.QUEUE &&
                target.targetIndex >= startStep
              ) {
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
              liveFinalStepContextWindow: {},
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
              liveActivityEntries: reconcileActivityEntries(
                state.historyOutputs.activityEntries ?? [],
                state.liveActivityEntries
              ),
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
            liveActivityEntries: [],
            retryStates: {},
            streamingChunks: {},
            finalStepStreamingChunks: {},
            finalStepStatus: null,
            finalStepLoopCount: 0,
            finalStepPhase: null,
            liveFinalStepContextWindow: {},
            activeStepIndices: [],
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

      updateLiveFinalStepContextWindow: (loopIndex, used, size) =>
        withUndoPause(() =>
          set((state) => ({
            liveFinalStepContextWindow: {
              ...state.liveFinalStepContextWindow,
              [loopIndex]: { used, size },
            },
          }))
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
              e.kind === OUTPUT_HISTORY_KINDS.CLI &&
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
        // Prompt phase only — a condition script's entry shares this stepIndex
        // but carries none of the step's own tokens/session/duration.
        const cliEntries = entries
          .filter(
            (e): e is OrderedCliHistoryEntry =>
              e.kind === OUTPUT_HISTORY_KINDS.CLI &&
              isPromptExecutionPhase((e as OrderedCliHistoryEntry).phase) &&
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
        parallelGroups: state.parallelGroups,
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
          !deepValueEqual(a.parallelGroups, b.parallelGroups) ||
          a.finalStep !== b.finalStep ||
          a.runtimeUndoGeneration !== b.runtimeUndoGeneration ||
          JSON.stringify(a.undoWorkflowProperties) !==
            JSON.stringify(b.undoWorkflowProperties)
        ) {
          return false;
        }
        for (let i = 0; i < a.steps.length; i++) {
          if (!isStepContentEqual(a.steps[i], b.steps[i])) {
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
  parallelGroups: ParallelGroupDefinition[];
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
