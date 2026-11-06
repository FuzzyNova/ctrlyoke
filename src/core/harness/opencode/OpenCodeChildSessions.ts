import type {
  BackgroundTaskSummary,
  BackgroundWorkHoldSnapshot,
} from "../../../types/CliOutputTypes";
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import {
  OPENCODE_EVENT_TYPES,
  OPENCODE_TOOL_NAMES,
} from "./OpenCodeProtocolConstants";

/** One subagent child session a step is waiting on. */
interface OpenCodeChildSession {
  /** The child's own background jobs, tracked exactly like the parent's. */
  readonly followUp: BackgroundFollowUpState;
  /** Shown while the step is held on this child. */
  readonly summary: BackgroundTaskSummary;
  /** A read found the child mid-execution, and no `idle` has closed it yet. */
  busy: boolean;
  /** Read the child's export on the next poll. */
  live: boolean;
}

/**
 * OpenCode 2 subagent child sessions, followed so a parent step does not
 * complete while a child still has work in flight.
 *
 * A subagent's job ends at the child's first `idle`. If the child started a
 * background shell (or its own subagent) and ended its turn, the parent gets
 * the subagent's result and can finish, while the child later wakes for its
 * job's completion notice and keeps working. OpenCode never tells the parent
 * about that second execution, so the parent's own export never shows it.
 *
 * State changes only through `track()`, from the child lifecycle events the
 * parser synthesises (`OPENCODE_EVENT_TYPES.SUBAGENT_SESSION` and the
 * `CHILD_*` events), so a replayed event stream rebuilds it exactly.
 */
export class OpenCodeChildSessions {
  private readonly children = new Map<string, OpenCodeChildSession>();

  /** Children whose export the next poll should read. */
  liveSessionIds(): string[] {
    return [...this.children]
      .filter(([, child]) => child.live)
      .map(([id]) => id);
  }

  /**
   * Whether this child is holding the step: background work pending, a
   * notice awaiting its follow-up execution, or an execution running.
   * Side-effect free, unlike `isBlocked()`.
   */
  isHolding(sessionId: string): boolean {
    const child = this.children.get(sessionId);
    if (!child) return false;
    const { pendingTasks, awaitingResumedTurn } = child.followUp.snapshot();
    return child.busy || pendingTasks.length > 0 || awaitingResumedTurn;
  }

  /** Whether the child is already known to be mid-execution. */
  isBusy(sessionId: string): boolean {
    return this.children.get(sessionId)?.busy ?? false;
  }

  track(event: BaseCliEvent): void {
    const e = event as Record<string, any>;
    const id =
      typeof e.childSessionID === "string" ? e.childSessionID : undefined;
    if (!id) return;

    if (event.type === OPENCODE_EVENT_TYPES.SUBAGENT_SESSION) {
      const existing = this.children.get(id);
      if (existing) {
        existing.live = true;
      } else {
        this.children.set(id, {
          followUp: new BackgroundFollowUpState(),
          summary: {
            toolName: OPENCODE_TOOL_NAMES.SUBAGENT,
            taskId: id,
            ...(typeof e.description === "string" && e.description
              ? { description: e.description }
              : {}),
          },
          busy: false,
          live: true,
        });
      }
      return;
    }

    // A child's events only count once its spawn has been seen in this
    // monitored turn; a child from an earlier turn is not this step's work.
    const child = this.children.get(id);
    if (!child) return;
    switch (event.type) {
      case OPENCODE_EVENT_TYPES.CHILD_BUSY:
        child.busy = true;
        child.live = true;
        break;
      case OPENCODE_EVENT_TYPES.CHILD_BACKGROUND_LAUNCH:
        if (typeof e.taskId === "string") {
          child.followUp.launch(e.taskId, e.summary);
          child.live = true;
        }
        break;
      case OPENCODE_EVENT_TYPES.CHILD_BACKGROUND_NOTICE:
        if (typeof e.taskId === "string") {
          child.followUp.consumeNotification(e.taskId);
        }
        break;
      case OPENCODE_EVENT_TYPES.CHILD_IDLE: {
        child.busy = false;
        child.followUp.resumedTurnClosed();
        const { pendingTasks, awaitingResumedTurn } = child.followUp.snapshot();
        // Nothing left that can wake it: stop reading its export until a
        // later `subagent` call names it again.
        child.live = pendingTasks.length > 0 || awaitingResumedTurn;
        break;
      }
    }
  }

  /** Whether any child is executing or still has background work pending. */
  isBlocked(): boolean {
    let blocked = false;
    for (const child of this.children.values()) {
      // Every child is checked (no short-circuit): isCompletionBlocked() is
      // the state's one consuming read.
      if (child.followUp.isCompletionBlocked() || child.busy) blocked = true;
    }
    return blocked;
  }

  /** What the children are holding the step on, for display. */
  snapshot(): BackgroundWorkHoldSnapshot {
    const pendingTasks: BackgroundTaskSummary[] = [];
    let awaitingResumedTurn = false;
    for (const child of this.children.values()) {
      const own = child.followUp.snapshot();
      pendingTasks.push(...own.pendingTasks);
      awaitingResumedTurn ||= own.awaitingResumedTurn;
      if (child.busy && own.pendingTasks.length === 0) {
        pendingTasks.push(child.summary);
      }
    }
    return { pendingTasks, awaitingResumedTurn };
  }

  reset(): void {
    this.children.clear();
  }
}
