/** Terminal-style tool call container */
export const TOOL_CALL_TERMINAL =
  "font-[Consolas,Monaco,'Courier_New',monospace] my-2 leading-relaxed";

/** Tool call header line (bullet + command text) */
export const TOOL_CALL_LINE =
  "text-editor-fg text-[length:var(--fp-output-font-size)] flex flex-wrap items-baseline gap-1";

/**
 * Tool result line (⎿ output).
 *
 * Carries no left padding: inside a ToolCallBlock the gutter column already
 * supplies the offset, and the body is meant to sit flush with the header text.
 * A bare TOOL_RESULT event rendered outside a block adds its own indent.
 */
export const TOOL_RESULT_LINE =
  "text-description-fg text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Tool error line (⎿ error). Same no-padding contract as TOOL_RESULT_LINE. */
export const TOOL_ERROR_LINE =
  "text-error-fg text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Indent for a ⎿ line rendered standalone, outside a ToolCallBlock. */
export const TOOL_RESULT_STANDALONE_INDENT = "pl-4 ml-2";

/** Shared output block base (prompt/response/command containers) */
export const OUTPUT_BLOCK_BASE =
  "py-[var(--spacing-sm)] px-[var(--spacing-sm)] my-[var(--spacing-sm)] border-l-[3px] whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:var(--fp-output-font-size-sm)] bg-transparent";
