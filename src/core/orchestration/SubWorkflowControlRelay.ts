import type { SubWorkflowControl } from "../../types/SubWorkflowTypes";
import { Log } from "../../utils/Log";

export type SubWorkflowControlAction = keyof SubWorkflowControl;

const RELAY_LOG_SOURCE = "SubWorkflowControlRelay";

/**
 * Forward one control to a child. A failure is logged, never thrown: a
 * parent's own stop or pause must not fail because its child's did.
 */
export async function forwardSubWorkflowControl(
  control: SubWorkflowControl | undefined,
  action: SubWorkflowControlAction,
  logSource: string
): Promise<void> {
  if (!control) return;
  try {
    await control[action]();
  } catch (error) {
    Log.warn(
      `[${logSource}] Failed to forward ${action} to sub-workflow:`,
      error
    );
  }
}

/**
 * The control a sub-workflow step registers before its child exists.
 *
 * `SubWorkflowHost.launch` loads the child, prepares its worktree and waits
 * for its run identity before returning a handle, so a stop or pause that
 * arrives meanwhile has nothing to reach. The relay records it and replays it
 * on the handle as soon as one is attached; after that it forwards directly.
 * Stopping through the relay never confirms the parent's stop: the stopped
 * child settles the step CANCELLED, the one confirmation point (D2).
 */
export class SubWorkflowControlRelay implements SubWorkflowControl {
  private handle: SubWorkflowControl | undefined;
  private stopRequested = false;
  private pauseRequested = false;

  /** A stop arrived, whether or not a handle was attached yet. */
  get wasStopRequested(): boolean {
    return this.stopRequested;
  }

  /** Bind the launched child and replay any stop or pause it missed. */
  async attach(handle: SubWorkflowControl): Promise<void> {
    this.handle = handle;
    const missed = this.stopRequested
      ? "stop"
      : this.pauseRequested
        ? "pause"
        : undefined;
    if (missed) {
      await forwardSubWorkflowControl(handle, missed, RELAY_LOG_SOURCE);
    }
  }

  async pause(): Promise<void> {
    if (this.stopRequested) return;
    this.pauseRequested = true;
    if (this.handle) await this.handle.pause();
  }

  async cancelPause(): Promise<void> {
    this.pauseRequested = false;
    if (this.handle) await this.handle.cancelPause();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    // A stop supersedes a held pause; only the stop is replayed.
    this.pauseRequested = false;
    if (this.handle) await this.handle.stop();
  }
}
