import type { ExecutionState } from "./DashboardConstants";
import type {
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
} from "./FlightPathTypes";
import type {
  OutputExecutionTarget,
  WorkspaceSnapshot,
  UndoRecord,
} from "./OutputHistoryTypes";
import type { CliOutput, StatusMessage } from "./WebviewMessageTypes";

export const TIMELINE_STORAGE_FILES = {
  MANIFEST: "manifest.json",
  EVENTS: "events.jsonl",
} as const;

export const TIMELINE_STORAGE_KIND = "timeline" as const;
export const TIMELINE_SCHEMA_VERSION = "2.0.0" as const;

export const TIMELINE_EVENT_TYPES = {
  WORKFLOW_RUNTIME_TRANSITION_RECORDED: "workflowRuntimeTransitionRecorded",
  CLI_OUTPUT_RECORDED: "cliOutputRecorded",
  STATUS_MESSAGE_RECORDED: "statusMessageRecorded",
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
  runStepCount: number;
  eventCount: number;
  nextSequence: number;
  lastUpdatedAt: number;
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
  payload: {
    cliOutput: CliOutput;
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
  | WorkflowRuntimeTransitionRecordedEventDraft
  | CliOutputRecordedEventDraft
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
  payload: {
    cliOutput: CliOutput;
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

export type WorkflowTimelineEvent =
  | WorkflowRuntimeTransitionRecordedEvent
  | CliOutputRecordedEvent
  | StatusMessageRecordedEvent
  | StatusMessagesUpdatedEvent
  | WorkspaceSnapshotCapturedEvent
  | WorkspaceSnapshotUpdatedEvent
  | UndoAppliedEvent
  | RedoAppliedEvent
  | UndoRecordUpdatedEvent;
