import type { CliOutput } from "@root/types/WebviewMessageTypes";
import { getOutputContextWindow } from "@root/utils/OutputContextWindow";

/**
 * Returns the context window usage percentage (0-100), or undefined if data unavailable.
 */
export function calcContextPct(
  contextWindowUsed: number | undefined,
  contextWindowSize: number | undefined
): number | undefined {
  if (contextWindowUsed === undefined || !contextWindowSize) return undefined;
  return Math.round((contextWindowUsed / contextWindowSize) * 100);
}

export interface ContextWindowSnapshot {
  used: number;
  size: number;
}

interface ContextWindowTokens {
  contextWindowUsed?: number;
  contextWindowSize?: number;
}

/**
 * Resolves the context-window snapshot a step row/chip should display: live
 * telemetry while the step is the one currently running, otherwise the
 * durable snapshot from its latest completed attempt or cached runtime
 * metadata. Single source shared by the full step row and the chip rail so
 * both surfaces (bar fill and hover tooltip) report the same numbers.
 */
export function resolveEffectiveContextWindow(params: {
  isCurrent: boolean;
  liveContextWindow?: ContextWindowSnapshot;
  latestOutput?: Pick<CliOutput, "tokens" | "contextWindow"> | null;
  runtimeContextWindow?: ContextWindowTokens;
}): ContextWindowSnapshot | undefined {
  const { isCurrent, liveContextWindow, latestOutput, runtimeContextWindow } =
    params;
  const completed =
    getOutputContextWindow(latestOutput) ??
    (runtimeContextWindow?.contextWindowSize
      ? {
          used: runtimeContextWindow.contextWindowUsed ?? 0,
          size: runtimeContextWindow.contextWindowSize,
        }
      : undefined);
  return isCurrent && liveContextWindow
    ? liveContextWindow
    : (completed ?? liveContextWindow);
}
