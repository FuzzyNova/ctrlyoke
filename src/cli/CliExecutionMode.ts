import { EXECUTION_MODES } from "../types/DashboardConstants";
import type { ExecutionMode } from "../types/DashboardConstants";
import type { CliExecutionOptions } from "./CliRunCommandDefinitions";

export interface CliExecutionModeResolution {
  executionMode: ExecutionMode;
  hostCanProvidePty: boolean;
  supportsConcurrentInteractiveSessions: boolean;
}

/**
 * Resolve the CLI's operational mode and whether its host can provide a PTY.
 *
 * The returned capability is consumed by PropertyResolver, which owns the
 * workflow-level clamp. This helper only translates CLI flags and TTY state
 * into the host capability; it does not resolve any workflow properties.
 */
export function resolveCliExecutionMode(
  options: Pick<CliExecutionOptions, "headless" | "interactive">,
  stdoutIsTTY: boolean,
  stdinIsTTY: boolean
): CliExecutionModeResolution {
  let executionMode: ExecutionMode;
  if (options.headless) {
    executionMode = EXECUTION_MODES.HEADLESS;
  } else if (options.interactive) {
    executionMode = EXECUTION_MODES.INTERACTIVE;
  } else {
    executionMode =
      stdoutIsTTY && stdinIsTTY
        ? EXECUTION_MODES.INTERACTIVE
        : EXECUTION_MODES.HEADLESS;
  }

  return {
    executionMode,
    hostCanProvidePty: executionMode === EXECUTION_MODES.INTERACTIVE,
    supportsConcurrentInteractiveSessions: false,
  };
}
