import { EXECUTION_MODES } from "../types/DashboardConstants";
import type { ExecutionMode } from "../types/DashboardConstants";

export interface CliExecutionModeResolution {
  executionMode: ExecutionMode;
  hostCanProvidePty: boolean;
  supportsConcurrentInteractiveSessions: boolean;
}

/**
 * Resolve the CLI's operational mode and whether its host can provide a PTY.
 *
 * TTYs determine both the settings-tier default and whether the host can
 * provide an interactive PTY. Explicit execution flags are workflow overrides.
 */
export function resolveCliExecutionMode(
  stdoutIsTTY: boolean,
  stdinIsTTY: boolean
): CliExecutionModeResolution {
  const executionMode: ExecutionMode =
    stdoutIsTTY && stdinIsTTY
      ? EXECUTION_MODES.INTERACTIVE
      : EXECUTION_MODES.HEADLESS;

  return {
    executionMode,
    hostCanProvidePty: stdoutIsTTY && stdinIsTTY,
    supportsConcurrentInteractiveSessions: false,
  };
}
