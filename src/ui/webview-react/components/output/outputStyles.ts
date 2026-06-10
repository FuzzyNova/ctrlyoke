/** Terminal-style tool call container */
export const TOOL_CALL_TERMINAL =
  "font-[Consolas,Monaco,'Courier_New',monospace] my-2 leading-relaxed";

/** Tool call header line (bullet + command text) */
export const TOOL_CALL_LINE =
  "text-editor-fg text-[length:var(--fp-output-font-size)] flex flex-wrap items-baseline gap-1";

/** Tool result line (indented output) */
export const TOOL_RESULT_LINE =
  "text-description-fg pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Tool error line (indented error) */
export const TOOL_ERROR_LINE =
  "text-error-fg pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Shared output block base (prompt/response/command containers) */
export const OUTPUT_BLOCK_BASE =
  "py-[var(--spacing-sm)] px-[var(--spacing-sm)] my-[var(--spacing-sm)] border-l-[3px] whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:var(--fp-output-font-size-sm)] bg-transparent";
