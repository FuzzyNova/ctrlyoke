/**
 * Message type definitions for extension <-> webview communication
 * Single source of truth: src/types/DashboardConstants.ts
 */

// Re-export MESSAGE_TYPES from DashboardConstants (if available in webview)
// For now, define locally to avoid module resolution issues in webview context
export const MESSAGE_TYPES = {
  // Extension -> Webview
  INIT: "init",
  FILE_SELECTED: "fileSelected",
  SESSION_RESTORED: "sessionRestored",
  EXECUTION_STARTED: "executionStarted",
  EXECUTION_STATE_CHANGED: "executionStateChanged",
  PROGRESS_UPDATE: "progressUpdate",
  STEP_STATUS_CHANGED: "stepStatusChanged",
  RETRY_ATTEMPT_CHANGED: "retryAttemptChanged",
  CLI_OUTPUT: "cliOutput",
  CLI_STREAMING_CHUNK: "cliStreamingChunk",
  CLI_STREAMING_EVENTS: "cliStreamingEvents",
  STATUS_MESSAGE: "statusMessage",
  EXECUTION_COMPLETED: "executionCompleted",
  QUEUE_EXTENDED: "queueExtended",
  PROMPTS_EXTENDED: "promptsExtended",
  PROMPTS_APPENDED: "promptsAppended",
  PROMPT_DELETED: "promptDeleted",
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",
  DYNAMIC_QUEUE_ENABLED: "dynamicQueueEnabled",
  DYNAMIC_QUEUE_DISABLED: "dynamicQueueDisabled",
  WORKFLOW_NAME_UPDATED: "workflowNameUpdated",
  RECENT_WORKFLOWS: "recentWorkflows",
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate",
  PROVIDER_STATUS_UPDATE: "providerStatusUpdate",
  AGENTS_UPDATE: "agentsUpdate",
  WORKFLOW_PROPERTIES_UPDATE: "workflowPropertiesUpdate",
  WORKFLOW_LOADED: "workflowLoaded",
  WORKFLOW_UNLOADED: "workflowUnloaded",
  OPEN_NEW_WORKFLOW_MODAL: "openNewWorkflowModal",
  TEMPLATE_INFO: "templateInfo",
  DEFAULT_TEMPLATE_SET: "defaultTemplateSet",
  WORKFLOW_CREATED: "workflowCreated",
  CLOSE_MODAL: "closeModal",
  COMPLETIONS_RESPONSE: "completionsResponse",

  // Webview -> Extension
  READY: "ready",
  NEW_PROMPT: "newPrompt",
  SELECT_FILE: "selectFile",
  APPEND_FILE: "appendFile",
  EDIT_FILE: "editFile",
  CLEAR_WORKFLOW: "clearWorkflow",
  RUN: "run",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  SHOW_OUTPUT: "showOutput",
  EXPORT_OUTPUT: "exportOutput",
  CHANGE_PROVIDER: "changeProvider",
  CHANGE_MODEL: "changeModel",
  CHANGE_AGENT: "changeAgent",
  CHANGE_EXECUTION_MODE: "changeExecutionMode",
  CHANGE_RESUME_SESSION: "changeResumeSession",
  CHANGE_DYNAMIC_QUEUE: "changeDynamicQueue",
  OPEN_SETTINGS: "openSettings",
  EXECUTE_PROMPT: "executePrompt",
  UPDATE_PROMPT: "updatePrompt",
  CANCEL_EDIT: "cancelEdit",
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit",
  DELETE_PROMPT: "deletePrompt",
  UPDATE_WORKFLOW_NAME: "updateWorkflowName",
  GET_RECENT_WORKFLOWS: "getRecentWorkflows",
  LOAD_WORKFLOW: "loadWorkflow",
  CLEAR_WORKFLOW_HISTORY: "clearWorkflowHistory",
  UPDATE_WORKFLOW_PROPERTY: "updateWorkflowProperty",
  SET_AS_DEFAULT: "setAsDefault",
  GET_CONFIG: "getConfig",
  UPDATE_CONFIG: "updateConfig",
  CONFIG_VALUE: "configValue",
  NEW_WORKFLOW: "newWorkflow",
  TEMPLATE_SELECTED: "templateSelected",
  SET_DEFAULT_TEMPLATE: "setDefaultTemplate",
  CREATE_WORKFLOW: "createWorkflow",
  CREATE_NEW_TEMPLATE: "createNewTemplate",
  REQUEST_COMPLETIONS: "requestCompletions",
  OPEN_FILE: "openFile",
} as const;

export const EXECUTION_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  CANCELLING: "cancelling",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

export const STEP_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export const STATUS_MESSAGE_SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

export const ACTION_TYPES = {
  RUN: "run",
  QUEUE: "queue",
  RUN_NEXT: "runNext",
  QUEUE_NEXT: "queueNext",
  RUN_BEFORE_CURRENT: "runBeforeCurrent",
} as const;

export const PROVIDER_IDS = {
  COPILOT_CLI: "copilot-cli",
  COPILOT_CHAT: "copilot-chat",
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
} as const;

// Type helpers
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type ExecutionState = (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
export type StatusMessageSeverity = (typeof STATUS_MESSAGE_SEVERITY)[keyof typeof STATUS_MESSAGE_SEVERITY];
export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];
export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

// Message payload types
export interface InitMessageData {
  fileName: string;
  workflowName: string;
  prompts: any[];
  executionState: ExecutionState;
  currentIndex: number;
  results: any[];
  globalSettings: {
    provider: ProviderId;
    model: string;
    agent: string;
    executionMode: "interactive" | "headless";
    resumeSession: boolean;
    allowDynamicExtension: boolean;
  };
  workflowProperties: Record<string, any>;
  modelOptions: Record<ProviderId, Array<{ value: string; label: string }>>;
  providerStatus: Record<string, { available: boolean; status: string; message?: string }>;
  availableAgents: Array<{ name: string; path: string; description?: string }>;
}

export interface FileSelectedMessage {
  type: typeof MESSAGE_TYPES.FILE_SELECTED;
  fileName: string;
  prompts: any[];
  workflowName?: string;
}

export interface SessionRestoredMessage {
  type: typeof MESSAGE_TYPES.SESSION_RESTORED;
  fileName: string;
  prompts: any[];
  results: any[];
  executionState: ExecutionState;
  currentIndex: number;
  workflowName?: string;
}

export interface ExecutionStartedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STARTED;
  fileName: string;
  totalSteps: number;
}

export interface ExecutionStateChangedMessage {
  type: typeof MESSAGE_TYPES.EXECUTION_STATE_CHANGED;
  state: ExecutionState;
}

export interface ProgressUpdateMessage {
  type: typeof MESSAGE_TYPES.PROGRESS_UPDATE;
  current: number;
  total: number;
}

export interface StepStatusChangedMessage {
  type: typeof MESSAGE_TYPES.STEP_STATUS_CHANGED;
  stepIndex: number;
  status: StepStatus;
  details?: any;
}

export interface RetryAttemptChangedMessage {
  type: typeof MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED;
  stepIndex: number;
  currentRetry: number;
  maxRetries: number;
}

export interface CliOutputMessage {
  type: typeof MESSAGE_TYPES.CLI_OUTPUT;
  stepIndex: number;
  output: {
    prompt: string;
    response: string;
    structured?: any;
    elapsed: number;
    tokens?: { prompt: number; completion: number };
    isStreaming: boolean;
    cliCommand?: string;
    workingDirectory?: string;
  };
}

export interface CliStreamingChunkMessage {
  type: typeof MESSAGE_TYPES.CLI_STREAMING_CHUNK;
  stepIndex: number;
  chunk: string;
}

export interface CliStreamingEventsMessage {
  type: typeof MESSAGE_TYPES.CLI_STREAMING_EVENTS;
  stepIndex: number;
  events: any[];
}

export interface StatusMessageMessage {
  type: typeof MESSAGE_TYPES.STATUS_MESSAGE;
  stepIndex: number;
  message: string;
  severity: StatusMessageSeverity;
}

export interface PromptsExtendedMessage {
  type: typeof MESSAGE_TYPES.PROMPTS_EXTENDED;
  prompts: any[];
}

export interface PromptDeletedMessage {
  type: typeof MESSAGE_TYPES.PROMPT_DELETED;
  fileName: string;
  prompts: any[];
}

export interface ModelOptionsUpdateMessage {
  type: typeof MESSAGE_TYPES.MODEL_OPTIONS_UPDATE;
  data: {
    modelOptions: Record<ProviderId, Array<{ value: string; label: string }>>;
  };
}

export interface ProviderStatusUpdateMessage {
  type: typeof MESSAGE_TYPES.PROVIDER_STATUS_UPDATE;
  data: {
    providerStatus: Record<string, { available: boolean; status: string; message?: string }>;
  };
}

export interface AgentsUpdateMessage {
  type: typeof MESSAGE_TYPES.AGENTS_UPDATE;
  data: {
    availableAgents: Array<{ name: string; path: string; description?: string }>;
  };
}

export interface WorkflowPropertiesUpdateMessage {
  type: typeof MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE;
  workflowProperties: Record<string, any>;
}

export interface OpenNewWorkflowModalMessage {
  type: typeof MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL;
  templates: Array<{
    id: string;
    name: string;
    description: string;
    variables?: Record<string, any>;
    isBuiltIn: boolean;
    isAction: boolean;
  }>;
  workflowsDir: string;
  defaultTemplateId?: string;
}

export interface RecentWorkflowsMessage {
  type: typeof MESSAGE_TYPES.RECENT_WORKFLOWS;
  workflows: Array<{ name: string; path: string; lastUsed: number }>;
}

// Union type for all incoming messages
export type IncomingMessage =
  | { type: typeof MESSAGE_TYPES.INIT; data: InitMessageData }
  | FileSelectedMessage
  | SessionRestoredMessage
  | ExecutionStartedMessage
  | ExecutionStateChangedMessage
  | ProgressUpdateMessage
  | StepStatusChangedMessage
  | RetryAttemptChangedMessage
  | CliOutputMessage
  | CliStreamingChunkMessage
  | CliStreamingEventsMessage
  | StatusMessageMessage
  | { type: typeof MESSAGE_TYPES.EXECUTION_COMPLETED }
  | PromptsExtendedMessage
  | PromptDeletedMessage
  | ModelOptionsUpdateMessage
  | ProviderStatusUpdateMessage
  | AgentsUpdateMessage
  | WorkflowPropertiesUpdateMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_LOADED }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_UNLOADED }
  | OpenNewWorkflowModalMessage
  | { type: typeof MESSAGE_TYPES.WORKFLOW_NAME_UPDATED; workflowName: string }
  | RecentWorkflowsMessage
  | { type: typeof MESSAGE_TYPES.TEMPLATE_INFO; template: any }
  | { type: typeof MESSAGE_TYPES.DEFAULT_TEMPLATE_SET; templateId: string }
  | { type: typeof MESSAGE_TYPES.WORKFLOW_CREATED; filePath: string }
  | { type: typeof MESSAGE_TYPES.COMPLETIONS_RESPONSE; completions: any[]; trigger: string };
