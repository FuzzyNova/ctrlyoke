import * as path from "path";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { ExecutionHarnessOverride } from "../../core/IntegrationFactory";
import { Log } from "../../utils/Log";
import { createReplayOverride } from "./ReplayIntegration";
import { RunReplaySession } from "./RunReplaySession";

/**
 * Run replay (dev/backlog/MEDIA_CAPTURE_AUTOMATION_PLAN.md §5): a dev build
 * started with `CTRLYOKE_DEV_REPLAY` naming a run bundle writes that run's
 * workflow into the workspace, and every run started in this window then
 * replays the recording instead of starting harnesses or scripts. The engine,
 * history and dashboard are the real ones, so the dashboard shows a live run.
 *
 * The media capture host sets these (media/lib/devHost.ts).
 */
export const RUN_REPLAY_ENV = {
  /** The run bundle directory to replay. */
  BUNDLE: "CTRLYOKE_DEV_REPLAY",
  /** Multiplies recorded timing (default 1); 0 jumps straight to the end state. */
  SPEED: "CTRLYOKE_DEV_REPLAY_SPEED",
  /** Holds playback before the recorded event with this sequence number. */
  PAUSE_AT: "CTRLYOKE_DEV_REPLAY_PAUSE_AT",
} as const;

export interface RunReplayHost {
  setExecutionOverride(override: ExecutionHarnessOverride | undefined): void;
}

function parseNonNegative(
  name: string,
  value: string | undefined
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got "${value}"`);
  }
  return parsed;
}

/**
 * Arms replay when the environment asks for it. Must run before the first
 * workflow instance exists, since an instance keeps the factory it was built
 * with; the bundle itself loads in the background.
 */
export function armRunReplayFromEnvironment(
  host: RunReplayHost,
  platform: PlatformAdapter,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): RunReplaySession | undefined {
  const bundle = environment[RUN_REPLAY_ENV.BUNDLE];
  if (!bundle) return undefined;
  try {
    const session = new RunReplaySession({
      bundleDir: path.resolve(workspaceRoot, bundle),
      workspaceRoot,
      speed:
        parseNonNegative(
          RUN_REPLAY_ENV.SPEED,
          environment[RUN_REPLAY_ENV.SPEED]
        ) ?? 1,
      pauseAtSequence: parseNonNegative(
        RUN_REPLAY_ENV.PAUSE_AT,
        environment[RUN_REPLAY_ENV.PAUSE_AT]
      ),
    });
    host.setExecutionOverride(createReplayOverride(platform, session));
    return session;
  } catch (error) {
    Log.error("[RunReplay] replay not armed:", error);
    return undefined;
  }
}
