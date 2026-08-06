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

// Prompt utilities
export {
  createPromptStep,
  promptStepToRaw,
  isPromptExecuted,
  isPromptRunning,
  isPromptPending,
  getPromptLabel,
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
  getWorkflowExecutionControls,
  type WorkflowExecutionControlsInput,
  type WorkflowExecutionControlsState,
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
export {
  findOutputMatches,
  getOutputRowSearchSegments,
  highlightText,
  sliceDecorationMatches,
  type OutputFindMatch,
  type OutputRowSearchSegment,
  type RowFindDecoration,
} from "./outputFind";

export {
  projectAtomicReferenceFind,
  type AtomicReferenceCompactRange,
  type AtomicReferenceFindMark,
  type AtomicReferencePresentation,
  type AtomicReferenceRange,
  type AtomicReferenceRenderSegment,
} from "./atomicReferences";

// Tokenizer utilities
export { countTokens } from "./tokenizer";

// Date/filter utilities
export {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
  DATE_INPUT_FORMATTER,
  DEFAULT_DATE_RANGE_FILTER,
  formatDateInput,
  getDateEndMs,
  getDatePresetRange,
  getDateStartMs,
  WORKFLOW_HARNESS_OPTIONS,
  WORKFLOW_STATE_OPTIONS,
  type DateRangeFilter,
  type DateRangePreset,
} from "./dateRangeFilter";
export { formatMultiFilterLabel } from "./filterLabels";
