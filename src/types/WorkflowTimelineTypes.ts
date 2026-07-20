import type { ExecutionState } from "./DashboardConstants";
import type {
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
  WorkflowKey,
  RunRef,
  WorkflowStep,
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
export const TIMELINE_SCHEMA_VERSION = "2.2.0" as const;

export const TIMELINE_EVENT_TYPES = {
  WORKFLOW_RUNTIME_TRANSITION_RECORDED: "workflowRuntimeTransitionRecorded",
  CLI_OUTPUT_RECORDED: "cliOutputRecorded",
  CLI_OUTPUT_CHUNK_APPENDED: "cliOutputChunkAppended",
  CLI_OUTPUT_EVENTS_APPENDED: "cliOutputEventsAppended",
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

export interface WorkflowRunManifest {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  storageKind: typeof TIMELINE_STORAGE_KIND;
  workflowId: string;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  /** Definition revision most recently committed for this run (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision: number;
  stepCount: number;
  eventCount: number;
  nextSequence: number;
  lastUpdatedAt: number;
}

/**
 * Lightweight, manifest-only projection of a run's identity and state — the
 * shape `OutputHistoryManager.getRunSummaries` returns for run listing/navigation
 * without loading the run's full definition or output events.
 */
export interface RunSummary {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  definitionRevision: number;
  stepCount: number;
  primaryHarness?: string;
  primaryModel?: string;
  hasMixedHarnesses: boolean;
  hasMixedModels: boolean;
}

export interface HistorySearchResult {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workflowName: string;
  runId: number;
  startedAt: number;
  executionState: string;
  target: OutputExecutionTarget;
  matchType:
    | "response"
    | "file"
    | "bash"
    | "status"
    | "prompt"
    | "tool"
    | "diff";
  matchSnippet: string;
  matchContext: string;
  filePath?: string;
}

export type HistorySearchIndexState = "ready" | "building" | "fallback";

export interface HistorySearchQuery {
  query: string;
  limit: number;
  cursor?: string;
  filters?: {
    matchTypes?: HistorySearchResult["matchType"][];
    workflowKeys?: WorkflowKey[];
    since?: number;
    until?: number;
  };
}

export interface HistorySearchResponse {
  query: string;
  results: HistorySearchResult[];
  totalCount: number;
  nextCursor?: string;
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
  matchType: HistorySearchResult["matchType"];
  text: string;
  filePath?: string;
}

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
  /** The definitionRevision that produced this attempt (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision?: number;
  payload: {
    cliOutput: CliOutput;
  };
}

export interface CliOutputChunkAppendedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  payload: {
    chunk: string;
  };
}

export interface CliOutputEventsAppendedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  payload: {
    events: CliEvent[];
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
  /** The definitionRevision that produced this attempt (see `DEFINITION_REVISION_COMMITTED`). */
  definitionRevision?: number;
  payload: {
    cliOutput: CliOutput;
  };
}

export interface CliOutputChunkAppendedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  payload: {
    chunk: string;
  };
}

export interface CliOutputEventsAppendedEvent extends TargetedTimelineEventBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED;
  runIndex?: number;
  attemptIndex: number;
  payload: {
    events: CliEvent[];
  };
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
  | StatusMessageRecordedEvent
  | StatusMessagesUpdatedEvent
  | WorkspaceSnapshotCapturedEvent
  | WorkspaceSnapshotUpdatedEvent
  | UndoAppliedEvent
  | RedoAppliedEvent
  | UndoRecordUpdatedEvent;
