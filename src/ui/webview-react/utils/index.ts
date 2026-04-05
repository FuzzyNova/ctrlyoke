/**
 * Utility functions index
 * Re-exports all utilities for convenient importing
 */

// Time utilities
export {
  getTimestamp,
  formatTime,
  formatRelativeTime,
  formatRelativeTimeVerbose,
  formatDuration,
} from "./time";

// String utilities
export {
  escapeHtml,
  truncate,
  getWorkflowName,
  capitalize,
  toTitleCase,
} from "./string";

// End condition utilities
export {
  END_CONDITION_PROPERTIES,
  DEFAULT_END_CONDITION_VALUES,
  getEndConditionValue,
  buildEndConditionFromValues,
  endConditionToFormValues,
  hasEndCondition,
  type EndConditionDefaults,
  type EndConditionFormValues,
} from "./endCondition";

// Prompt utilities
export {
  PROMPT_PROPERTIES,
  createPromptItem,
  promptStepToRaw,
  isPromptExecuted,
  isPromptRunning,
  isPromptPending,
  getPromptLabel,
  type EndCondition,
  type PromptRuntime,
  type RawPrompt,
  type PromptDetails,
  type PromptStep,
} from "./prompt";

// Status/icon utilities
export {
  STATUS_ICONS,
  STATUS_COLORS,
  STATUS_LABELS,
  EXECUTION_STATE_ICONS,
  EXECUTION_STATE_COLORS,
  EXECUTION_STATE_LABELS,
  getStatusIconClass,
  getStatusIconClassName,
  getStatusColorClass,
  getStatusLabel,
  getExecutionStateIconClass,
  getExecutionStateColorClass,
  getExecutionStateLabel,
  isExecutionBusy,
  canStartExecution,
  canPauseExecution,
  canResumeExecution,
  canStopExecution,
} from "./status";

// Diff utilities
export { generateDiff, applyDiff } from "./diff";

// Output rendering utilities
export {
  shortenPath,
  extractKeyParameters,
  parseUnifiedDiff,
  generateDiffLines,
  type DiffLine,
} from "./outputUtils";
export { generateMarkdownExport } from "./markdownExport";

// Tokenizer utilities
export { countTokens } from "./tokenizer";
