import {
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
  HISTORY_SEARCH_COUNT_STATES,
  HISTORY_SEARCH_INDEX_STATES,
  type ExecutionPhase,
  type ExecutionState,
} from "./DashboardConstants";
import type {
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
  WorkflowKey,
  RunRef,
  WorkflowStep,
  ParallelGroupDefinition,
  WorkflowTokenTotals,
  WorktreeConfig,
  WorktreeRunProjection,
  WorkflowStopReason,
} from "./CtrlYokeTypes";
import type {
  OutputExecutionTarget,
  WorkspaceSnapshot,
  UndoRecord,
} from "./OutputHistoryTypes";
import type { CliEvent, CliOutput, StatusMessage } from "./WebviewMessageTypes";

export const TIMELINE_STORAGE_FILES = {
  MANIFEST: "manifest.json",
  EVENTS: "events.jsonl",
} as const;

export const TIMELINE_STORAGE_KIND = "timeline" as const;
export const TIMELINE_SCHEMA_VERSION = 2 as const;

/** Timeline-v1 output shape retained only for per-line legacy reads. */
export type LegacyCliOutputV1 = CliOutput & {
  response?: string;
  prompt?: string;
};

export const TIMELINE_EVENT_TYPES = {
  WORKFLOW_RUNTIME_TRANSITION_RECORDED: "workflowRuntimeTransitionRecorded",
  CLI_OUTPUT_RECORDED: "cliOutputRecorded",
  CLI_OUTPUT_CHUNK_APPENDED: "cliOutputChunkAppended",
  CLI_OUTPUT_EVENTS_APPENDED: "cliOutputEventsAppended",
  ATTEMPT_STARTED: "attemptStarted",
  ATTEMPT_TERMINATED: "attemptTerminated",
  SCRIPT_EXECUTION_RECORDED: "scriptExecutionRecorded",
  RETRY_SCHEDULED: "retryScheduled",
  FOLLOW_UP_RESPONSE_APPENDED: "followUpResponseAppended",
  RUN_TERMINATED: "runTerminated",
  STATUS_MESSAGE_RECORDED: "statusMessageRecorded",
  DEFINITION_REVISION_COMMITTED: "definitionRevisionCommitted",
  // Legacy aggregate event retained for read compatibility only.
  STATUS_MESSAGES_UPDATED: "statusMessagesUpdated",
  WORKSPACE_SNAPSHOT_CAPTURED: "workspaceSnapshotCaptured",
  // Legacy aggregate event retained for read compatibility only.
  WORKSPACE_SNAPSHOT_UPDATED: "workspaceSnapshotUpdated",
  UNDO_APPLIED: "undoApplied",
  REDO_APPLIED: "redoApplied",
  // Legacy aggregate event retained for read compatibility only.
  UNDO_RECORD_UPDATED: "undoRecordUpdated",
} as const;

export type WorkflowTimelineEventType =
  (typeof TIMELINE_EVENT_TYPES)[keyof typeof TIMELINE_EVENT_TYPES];

/** Why an attempt exists. This is independent of its target, so final-step loops
 * and resumed queue work use the same durable attempt model. */
export const TIMELINE_ATTEMPT_START_REASONS = {
  INITIAL: "initial",
  RETRY: "retry",
  RESUMED: "resumed",
} as const;

export type TimelineAttemptStartReason =
  (typeof TIMELINE_ATTEMPT_START_REASONS)[keyof typeof TIMELINE_ATTEMPT_START_REASONS];

export const TIMELINE_ATTEMPT_KINDS = {
  AI: "ai",
  SCRIPT: "script",
  CONDITION: "condition",
  SETUP: "setup",
} as const;

export type TimelineAttemptKind =
  (typeof TIMELINE_ATTEMPT_KINDS)[keyof typeof TIMELINE_ATTEMPT_KINDS];

export const TIMELINE_ATTEMPT_TERMINAL_STATES = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  STOPPED: "stopped",
} as const;

export type TimelineAttemptTerminalState =
  (typeof TIMELINE_ATTEMPT_TERMINAL_STATES)[keyof typeof TIMELINE_ATTEMPT_TERMINAL_STATES];

export interface WorkflowRunManifest {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  storageKind: typeof TIMELINE_STORAGE_KIND;
  workflowId: string;
  runId: number;
  startedAt: number;
  completedAt?: number;
  /** Pause-aware active execution time; absent on runs created before this field. */
  activeExecutionMs?: number;
  executionState: ExecutionState;
  /** Structured reason when a run ended because an execution guardrail fired. */
  stopReason?: WorkflowStopReason;
  /** Definition revision most recently committed for this run (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision: number;
  /**
   * Immutable starting definition for revision 1. Later revisions are recorded
   * as `DEFINITION_REVISION_COMMITTED` events. Keeping this in the small
   * manifest makes revision-1 attempts resolvable even after an in-place
   * continuation advances the run's working-file head.
   */
  initialDefinition?: WorkflowDefinitionSnapshot;
  stepCount: number;
  eventCount: number;
  nextSequence: number;
  lastUpdatedAt: number;
  /** Latest run-scoped token aggregate projected from timeline history. */
  tokenTotals?: WorkflowTokenTotals;
}

/**
 * Lightweight, manifest-only projection of a run's identity and state — the
 * shape `OutputHistoryManager.getRunSummaries` returns for run listing/navigation
 * without loading the run's full definition or output events.
 */
export interface RunSummary {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runDirectory: string;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  /** Structured reason when a run ended because an execution guardrail fired. */
  stopReason?: WorkflowStopReason;
  definitionRevision: number;
  stepCount: number;
  /** Step count from the persisted working file, which is current during a run. */
  workingFileStepCount?: number;
  /** Whether the run's persisted working definition includes a final step. */
  hasFinalStep?: boolean;
  /** Harness used by the most non-script steps; ties go to the earliest step. */
  primaryHarness?: string;
  /** Model used by the most non-script steps; ties go to the earliest step. */
  primaryModel?: string;
  hasMixedHarnesses: boolean;
  hasMixedModels: boolean;
  /**
   * Pause-aware active execution time once the run's clock has stopped
   * (settled or paused). Absent while it is still ticking or never started.
   */
  activeExecutionMs?: number;
  /**
   * True when the run was prepared but has executed nothing (`isUnstartedRun`).
   * Display-only, like the rest of this summary.
   */
  unstarted?: boolean;
  tokenTotals?: WorkflowTokenTotals;
  /** Status projection sourced from this run's persisted `_runtime.worktree`. */
  worktree?: WorktreeRunProjection;
  /** Durable notice when an inherited worktree default degraded to none. */
  worktreeNotice?: string;
}

export interface HistorySearchResult {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workflowName: string;
  runId: number;
  startedAt: number;
  executionState: string;
  target: OutputExecutionTarget;
  eventKind: HistoryEventKind;
  matchField: HistoryMatchField;
  matchSnippet: string;
  matchContext: string;
  filePath?: string;
}

export type HistorySearchIndexState =
  (typeof HISTORY_SEARCH_INDEX_STATES)[keyof typeof HISTORY_SEARCH_INDEX_STATES];

/**
 * Whether `HistorySearchResponse.totalCount` is the true match count or a
 * lower bound. Early termination (see `HistorySearchIndexService`) can answer
 * a page without scanning the whole index, which means it cannot always know
 * the real total — `"atLeast"` says so explicitly rather than letting a
 * partial count be mistaken for an exact one. A consumer must not size a
 * fixed-length UI (e.g. a scrollbar) from an `"atLeast"` total as if it were
 * final; `hasMore` still correctly indicates more pages remain.
 */
export type HistorySearchCountState =
  (typeof HISTORY_SEARCH_COUNT_STATES)[keyof typeof HISTORY_SEARCH_COUNT_STATES];

export interface HistorySearchQuery {
  query: string;
  limit: number;
  /**
   * Absolute index of the first result to return. Paging is random-access, not
   * a sequential cursor chain: a client that scrolls a virtualized list to row
   * 4000 of 5000 asks for that window directly instead of walking 80 pages to
   * reach it.
   */
  offset?: number;
  filters?: HistorySearchFilters;
  /** Also re-read each visited run's events uncapped, to reach matches past `MAX_INDEXED_TEXT_LENGTH`. */
  deep?: boolean;
  /** Interpret `query` as a case-insensitive regular expression. */
  regex?: boolean;
  /** Scan the complete index for an exact total while retaining only the requested result window. */
  exhaustive?: boolean;
}

export interface HistorySearchFilters {
  eventKinds?: HistoryEventKind[];
  workflowKeys?: WorkflowKey[];
  since?: number;
  until?: number;
  harnesses?: string[];
  executionStates?: string[];
  pathContains?: string;
}

export interface HistorySearchResponse {
  query: string;
  /** Absolute index of `results[0]` within the full match list. */
  offset: number;
  results: HistorySearchResult[];
  /** A lower bound when `countState` is `"atLeast"`; the true count when `"exact"`. */
  totalCount: number;
  countState: HistorySearchCountState;
  hasMore: boolean;
  indexState: HistorySearchIndexState;
}

export interface HistorySearchDocument {
  id: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workflowName: string;
  runId: number;
  startedAt: number;
  executionState: string;
  target: OutputExecutionTarget;
  attemptIndex: number;
  sequence: number;
  timestampMs: number;
  eventKind: HistoryEventKind;
  matchField: HistoryMatchField;
  text: string;
  textLower: string;
  filePath?: string;
  harness?: string;
  model?: string;
  sessionId?: string;
}

export type HistoryEventKind =
  (typeof HISTORY_EVENT_KINDS)[keyof typeof HISTORY_EVENT_KINDS];
export type HistoryMatchField =
  (typeof HISTORY_MATCH_FIELDS)[keyof typeof HISTORY_MATCH_FIELDS];

interface TargetedTimelineEventDraftBase {
  timestampMs: number;
  target: OutputExecutionTarget;
}

interface RunTimelineEventDraftBase {
  timestampMs: number;
}

interface TargetedTimelineEventBase extends TargetedTimelineEventDraftBase {
  workflowId: string;
  runId: number;
  sequence: number;
}

interface RunTimelineEventBase extends RunTimelineEventDraftBase {
  workflowId: string;
  runId: number;
  sequence: number;
}

export interface WorkflowRuntimeTransitionPayload {
  command: WorkflowRuntimeCommand;
  previous: WorkflowRuntimeState;
  current: WorkflowRuntimeState;
}

/**
 * Execution-relevant definition content, transient runtime removed — the
 * durable record of exactly what a `definitionRevision` executed.
 */
export interface WorkflowDefinitionSnapshot {
  workflowName: string;
  steps: WorkflowStep[];
  parallelGroups?: ParallelGroupDefinition[];
  /** Workflow-level worktree definition that produced this revision. */
  worktree?: WorktreeConfig;
  /** The final-step definition that belongs to this revision, if configured. */
  finalStep?: WorkflowStep;
  /** Present for the mutable suffix revision created by a same-run rewind. */
  rewindBoundary?: number;
}

export interface DefinitionRevisionCommittedEventDraft extends RunTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED;
  payload: {
    definitionRevision: number;
    priorDefinitionRevision?: number;
    definition: WorkflowDefinitionSnapshot;
  };
}

export interface WorkflowRuntimeTransitionRecordedEventDraft extends RunTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED;
  payload: {
    transition: WorkflowRuntimeTransitionPayload;
  };
}

export interface CliOutputRecordedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  /** The definitionRevision that produced this attempt (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision?: number;
  /** The output role is explicit so a later resolver never infers retry/script semantics from runtime fields. */
  responseKind?: TimelineAttemptKind;
  payload: {
    cliOutput: CliOutput;
  };
}

export interface CliOutputChunkAppendedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  payload: {
    chunk: string;
  };
}

export interface CliOutputEventsAppendedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision?: number;
  payload: {
    events: CliEvent[];
  };
}

/** A durable identity and input record for one executable attempt. */
export interface AttemptStartedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_STARTED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: {
    kind: TimelineAttemptKind;
    startReason: TimelineAttemptStartReason;
    prompt: string;
  };
}

/** The definitive outcome for an attempt, including failures where no response was produced. */
export interface AttemptTerminatedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: {
    terminalState: TimelineAttemptTerminalState;
    reason?: string;
  };
}

/** Preserves script stdout/stderr separately from its display-formatted response. */
export interface ScriptExecutionRecordedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: {
    command: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
  };
}

/** Captures the exact retry prompt before the next attempt is constructed/sent. */
export interface RetryScheduledEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.RETRY_SCHEDULED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: {
    retryPrompt: string;
    previousAttemptIndex: number;
  };
}

/** Records post-completion session activity without relying on mutable responseText. */
export interface FollowUpResponseAppendedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: {
    /** Content remains in the one canonical CLI response event; avoid duplicating large payloads. */
    responseTextLength: number;
    eventCount: number;
    contextWindow?: { used: number; size: number };
  };
}

/** Matches the terminal manifest transition, so an event-only reader does not infer terminal state from a manifest. */
export interface RunTerminatedEventDraft extends RunTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.RUN_TERMINATED;
  payload: {
    executionState: ExecutionState;
    stepCount: number;
  };
}

export interface StatusMessageRecordedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED;
  payload: {
    statusMessage: StatusMessage;
  };
}

export interface StatusMessagesUpdatedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.STATUS_MESSAGES_UPDATED;
  payload: {
    statusMessages: StatusMessage[];
  };
}

export interface WorkspaceSnapshotCapturedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED;
  payload: {
    workspaceSnapshot: WorkspaceSnapshot;
  };
}

export interface WorkspaceSnapshotUpdatedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_UPDATED;
  payload: {
    workspaceSnapshot: WorkspaceSnapshot;
  };
}

export interface UndoAppliedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.UNDO_APPLIED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export interface RedoAppliedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.REDO_APPLIED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export interface UndoRecordUpdatedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export type WorkflowTimelineEventDraft =
  | DefinitionRevisionCommittedEventDraft
  | WorkflowRuntimeTransitionRecordedEventDraft
  | CliOutputRecordedEventDraft
  | CliOutputChunkAppendedEventDraft
  | CliOutputEventsAppendedEventDraft
  | AttemptStartedEventDraft
  | AttemptTerminatedEventDraft
  | ScriptExecutionRecordedEventDraft
  | RetryScheduledEventDraft
  | FollowUpResponseAppendedEventDraft
  | RunTerminatedEventDraft
  | StatusMessageRecordedEventDraft
  | StatusMessagesUpdatedEventDraft
  | WorkspaceSnapshotCapturedEventDraft
  | WorkspaceSnapshotUpdatedEventDraft
  | UndoAppliedEventDraft
  | RedoAppliedEventDraft
  | UndoRecordUpdatedEventDraft;

export interface CliOutputRecordedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  /** The definitionRevision that produced this attempt (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision?: number;
  responseKind?: TimelineAttemptKind;
  payload: {
    cliOutput: CliOutput;
  };
}

export interface CliOutputChunkAppendedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  payload: {
    chunk: string;
  };
}

export interface CliOutputEventsAppendedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision?: number;
  payload: {
    events: CliEvent[];
  };
}

export interface AttemptStartedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_STARTED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: AttemptStartedEventDraft["payload"];
}

export interface AttemptTerminatedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: AttemptTerminatedEventDraft["payload"];
}

export interface ScriptExecutionRecordedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: ScriptExecutionRecordedEventDraft["payload"];
}

export interface RetryScheduledEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.RETRY_SCHEDULED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: RetryScheduledEventDraft["payload"];
}

export interface FollowUpResponseAppendedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definitionRevision: number;
  payload: FollowUpResponseAppendedEventDraft["payload"];
}

export interface RunTerminatedEvent extends RunTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.RUN_TERMINATED;
  payload: RunTerminatedEventDraft["payload"];
}

export interface WorkflowRuntimeTransitionRecordedEvent extends RunTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED;
  payload: {
    transition: WorkflowRuntimeTransitionPayload;
  };
}

export interface StatusMessageRecordedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED;
  payload: {
    statusMessage: StatusMessage;
  };
}

export interface StatusMessagesUpdatedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.STATUS_MESSAGES_UPDATED;
  payload: {
    statusMessages: StatusMessage[];
  };
}

export interface WorkspaceSnapshotCapturedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED;
  payload: {
    workspaceSnapshot: WorkspaceSnapshot;
  };
}

export interface WorkspaceSnapshotUpdatedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_UPDATED;
  payload: {
    workspaceSnapshot: WorkspaceSnapshot;
  };
}

export interface UndoAppliedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.UNDO_APPLIED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export interface RedoAppliedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.REDO_APPLIED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export interface UndoRecordUpdatedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED;
  payload: {
    undoRecord: UndoRecord;
  };
}

export interface DefinitionRevisionCommittedEvent extends RunTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED;
  payload: {
    definitionRevision: number;
    priorDefinitionRevision?: number;
    definition: WorkflowDefinitionSnapshot;
  };
}

export type WorkflowTimelineEvent =
  | DefinitionRevisionCommittedEvent
  | WorkflowRuntimeTransitionRecordedEvent
  | CliOutputRecordedEvent
  | CliOutputChunkAppendedEvent
  | CliOutputEventsAppendedEvent
  | AttemptStartedEvent
  | AttemptTerminatedEvent
  | ScriptExecutionRecordedEvent
  | RetryScheduledEvent
  | FollowUpResponseAppendedEvent
  | RunTerminatedEvent
  | StatusMessageRecordedEvent
  | StatusMessagesUpdatedEvent
  | WorkspaceSnapshotCapturedEvent
  | WorkspaceSnapshotUpdatedEvent
  | UndoAppliedEvent
  | RedoAppliedEvent
  | UndoRecordUpdatedEvent;
