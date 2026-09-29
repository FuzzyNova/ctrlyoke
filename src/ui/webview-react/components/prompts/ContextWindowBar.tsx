import React from "react";
import type { HarnessId } from "../../types/messages";
import type { CliOutput } from "../../store/workflowStore";
import type { ContextWindowSnapshot } from "@utils/tokenUtils";
import { buildAttemptTokenTooltipLines } from "@root/utils/TokenFormatting";
import { useSettingsStore } from "@store/settingsStore";
import { getUsageBarColorClass } from "@utils/usageBarColor";
import { Icon } from "../shared/Icon";

interface ContextWindowBarProps {
  /** Effective context window (see `resolveEffectiveContextWindow`). */
  contextWindow?: ContextWindowSnapshot;
  /** Token metadata of the attempt the bar describes. */
  attemptTokens?: CliOutput["tokens"];
  /** Harness used for token/cost tooltip lines. */
  harnessId?: HarnessId;
}

/**
 * Vertical context-window usage bar shown at the trailing edge of a step row.
 * Renders nothing when no context window size is known. The parent row must
 * be a flex row so the bar can `self-stretch` to the row height.
 */
export const ContextWindowBar: React.FC<ContextWindowBarProps> = ({
  contextWindow,
  attemptTokens,
  harnessId,
}) => {
  const showCostEstimates = useSettingsStore(
    (state) => state.fullGlobalSettings?.settings.ui.showCostEstimates !== false
  );
  if (!contextWindow?.size) {
    return null;
  }
  const contextPct = Math.round(
    (contextWindow.used / contextWindow.size) * 100
  );
  const compactionCount = attemptTokens?.compactionCount;
  const hasCompacted = compactionCount !== undefined && compactionCount > 0;
  const tokenTooltip = buildAttemptTokenTooltipLines({
    contextWindow,
    harness: harnessId,
    attemptTokens,
    showCostEstimates,
  }).join("\n");

  return (
    <div
      data-context-window-bar
      className="flex-shrink-0 flex flex-col items-center w-3 self-stretch ml-0.5"
    >
      {/* Compaction badge above the bar — only takes up space when present,
          so the bar fills the row when this attempt didn't compact. */}
      {hasCompacted && (
        <span
          className="flex-shrink-0 flex items-center justify-center"
          title={`Compactions: ${compactionCount}`}
        >
          <Icon
            name="fold"
            className="text-xxs text-description-fg opacity-90"
            aria-label={`Compactions: ${compactionCount}`}
          />
        </span>
      )}
      <div
        className="flex-1 min-h-0 w-full flex flex-col items-center"
        title={tokenTooltip || undefined}
      >
        {/* Track */}
        <div className="flex-1 w-1.5 rounded-full bg-ctx-bar-track overflow-hidden relative">
          {/* Fill */}
          <div
            key={contextPct}
            className={`absolute bottom-0 left-0 right-0 rounded-full animate-ctx-update ${getUsageBarColorClass(
              contextPct
            )}`}
            style={{ height: `${contextPct}%` }}
          />
        </div>
        {/* Percentage label */}
        <span className="text-xxs leading-none text-description-fg opacity-75 mt-0.5">
          {contextPct}%
        </span>
      </div>
    </div>
  );
};
