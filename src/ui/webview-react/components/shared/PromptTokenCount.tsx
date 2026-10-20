import React from "react";
import { formatMagnitude } from "../../utils/number";

/** Counts at or above these colour the label as a context-size warning. */
const TOKEN_COUNT_WARNING_THRESHOLD = 50_000;
const TOKEN_COUNT_ERROR_THRESHOLD = 100_000;

/**
 * Estimated token count of an expanded prompt, coloured once it grows large
 * enough to crowd a harness's context window. Shared by the prompt editor
 * header and the workspace viewer's `.prompt.md` toolbar.
 */
export const PromptTokenCount: React.FC<{
  tokenCount: number;
  /** Abbreviates the unit to "tks" for narrow headers. */
  compact?: boolean;
}> = ({ tokenCount, compact = false }) => (
  <span
    data-testid="prompt-token-count"
    title="Estimated tokens, including expanded references"
    className={`font-bold tabular-nums ${
      tokenCount >= TOKEN_COUNT_ERROR_THRESHOLD
        ? "text-error-fg"
        : tokenCount >= TOKEN_COUNT_WARNING_THRESHOLD
          ? "text-warning-fg"
          : ""
    }`}
  >
    {formatMagnitude(tokenCount)} {compact ? "tks" : "tokens"}
  </span>
);
