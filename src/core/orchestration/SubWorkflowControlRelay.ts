import type { SubWorkflowControl } from "../../types/SubWorkflowTypes";
import { Log } from "../../utils/Log";

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
    if (this.stopRequested) {
      await this.forward(handle, "stop");
    } else if (this.pauseRequested) {
      await this.forward(handle, "pause");
    }
  }

  async pause(): Promise<void> {
    this.pauseRequested = true;
    if (this.handle) await this.handle.pause();
  }

  async cancelPause(): Promise<void> {
    this.pauseRequested = false;
    if (this.handle) await this.handle.cancelPause();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.handle) await this.handle.stop();
  }

  private async forward(
    handle: SubWorkflowControl,
    action: "pause" | "stop"
  ): Promise<void> {
    try {
      await handle[action]();
    } catch (error) {
      Log.warn(
        `[SubWorkflowControlRelay] Failed to replay ${action} on the launched sub-workflow:`,
        error
      );
    }
  }
}
