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
  generateId,
} from "./string";

// End condition utilities
export {
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
  createPromptStep,
  promptStepToRaw,
  isPromptExecuted,
  isPromptRunning,
  isPromptPending,
  getPromptLabel,
  type EndCondition,
  type RawPrompt,
  type PromptDetails,
  type PromptStep,
} from "./prompt";

// Status/icon utilities
export {
  STATUS_ICONS,
  STATUS_COLORS,
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
  generateDiffLines,
  type DiffLine,
} from "./outputUtils";
export { generateMarkdownExport } from "./markdownExport";

// Tokenizer utilities
export { countTokens } from "./tokenizer";
