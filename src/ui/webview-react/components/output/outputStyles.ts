/** Terminal-style tool call container */
export const TOOL_CALL_TERMINAL = "font-[Consolas,Monaco,'Courier_New',monospace] my-2 leading-relaxed";

/** Tool call header line (bullet + command text) */
export const TOOL_CALL_LINE = "text-editor-fg text-xs flex flex-wrap items-baseline gap-1";

/** Tool result line (indented output) */
export const TOOL_RESULT_LINE = "text-description-fg pl-4 ml-2 text-[11px] whitespace-pre-wrap break-words";

/** Tool error line (indented error) */
export const TOOL_ERROR_LINE = "text-error-fg pl-4 ml-2 text-[11px] whitespace-pre-wrap break-words";

/** Shared output block base (prompt/response/command containers) */
export const OUTPUT_BLOCK_BASE = "py-[var(--spacing-sm)] px-[var(--spacing-sm)] my-[var(--spacing-sm)] border-l-[3px] whitespace-pre-wrap break-words font-mono text-[11px] bg-transparent";
