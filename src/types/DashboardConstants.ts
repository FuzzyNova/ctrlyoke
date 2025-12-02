/**
 * Shared constants for FlightPath Dashboard
 * SINGLE SOURCE OF TRUTH for all message types, states, and status values
 * Used by both TypeScript extension code AND JavaScript webview code
 */

// ============================================================================
// MESSAGE TYPES - Communication between extension and webview
// ============================================================================
export const MESSAGE_TYPES = {
  // Extension -> Webview
  INIT: "init",
  FILE_SELECTED: "fileSelected",
  EXECUTION_STARTED: "executionStarted",
  EXECUTION_STATE_CHANGED: "executionStateChanged",
  PROGRESS_UPDATE: "progressUpdate",
  STEP_STATUS_CHANGED: "stepStatusChanged",
  RETRY_ATTEMPT_CHANGED: "retryAttemptChanged",
  CLI_OUTPUT: "cliOutput",
  CLI_STREAMING_CHUNK: "cliStreamingChunk",
  STATUS_MESSAGE: "statusMessage",
  EXECUTION_COMPLETED: "executionCompleted",
  QUEUE_EXTENDED: "queueExtended",
  PROMPTS_EXTENDED: "promptsExtended", // Send updated prompt list after queue extension
  QUEUE_SIZE_LIMIT_REACHED: "queueSizeLimitReached",
  EXECUTION_TIME_LIMIT_REACHED: "executionTimeLimitReached",
  DYNAMIC_QUEUE_ENABLED: "dynamicQueueEnabled",
  DYNAMIC_QUEUE_DISABLED: "dynamicQueueDisabled",

  // Webview -> Extension
  READY: "ready",
  NEW_PROMPT: "newPrompt",
  SELECT_FILE: "selectFile",
  EDIT_FILE: "editFile",
  RUN: "run",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  SHOW_OUTPUT: "showOutput",
  EXPORT_OUTPUT: "exportOutput",
  CHANGE_PROVIDER: "changeProvider",

  // Settings view messages
  CHANGE_MODEL: "changeModel",
  CHANGE_DYNAMIC_QUEUE: "changeDynamicQueue",
  MODEL_OPTIONS_UPDATE: "modelOptionsUpdate", // Refresh model lists after registry loads
  PROVIDER_STATUS_UPDATE: "providerStatusUpdate", // Update provider availability

  // New Workflow Modal - Extension -> Webview
  OPEN_NEW_WORKFLOW_MODAL: "openNewWorkflowModal",
  TEMPLATE_INFO: "templateInfo",
  DEFAULT_TEMPLATE_SET: "defaultTemplateSet",
  WORKFLOW_CREATED: "workflowCreated",
  CLOSE_MODAL: "closeModal",

  // New Workflow Modal - Webview -> Extension
  NEW_WORKFLOW: "newWorkflow", // Opens modal (from button click)
  TEMPLATE_SELECTED: "templateSelected",
  SET_DEFAULT_TEMPLATE: "setDefaultTemplate",
  CREATE_WORKFLOW: "createWorkflow",
  CREATE_NEW_TEMPLATE: "createNewTemplate",
} as const;

// ============================================================================
// EXECUTION STATES - QueueState.status values
// ============================================================================
export const EXECUTION_STATES = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

// ============================================================================
// STEP STATUS - PromptResult.status values
// ============================================================================
export const STEP_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

// ============================================================================
// TYPE HELPERS - For TypeScript type safety
// ============================================================================
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
