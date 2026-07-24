import * as vscode from "vscode";
import { getErrorMessage } from "../utils/ErrorUtils";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { WorkflowDefinitionMutation } from "../types/WebviewMessageTypes";
import type { WebviewClientContext } from "./WebviewClientContext";

/**
 * The addressed-mutation / revision-republish protocol shared by every
 * definition-writing message handler delegated by `WebviewMessageRouter`.
 *
 * Every definition write must leave the originating client holding the
 * revisions its *next* mutation needs (`publishViewIdentity`), and every
 * rejected write must both report the failure and re-publish those revisions
 * (`reportActionFailure`) — otherwise a single conflict wedges every later
 * edit on that address, because the client keeps retrying with a superseded
 * `definitionRevision`. `WebviewMessageRouter.routeSingleMessage`'s catch-all
 * also calls `reportActionFailure`, which is why this must be a shared
 * collaborator taking `WebviewClientContext` per call rather than living
 * inside a single handler file.
 */
export class WorkflowMutationCoordinator {
  constructor(
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined
  ) {}

  /**
   * A property-only write leaves steps and output untouched, so it must not
   * trigger the full `RUN_VIEW_LOADED` snapshot replay — the webview treats
   * that snapshot as a workflow load and rebuilds its entire output model,
   * visibly redrawing already-rendered output rows. `WORKFLOW_PROPERTIES_UPDATE`
   * (sent by the settings sync / run-view invalidation) carries the values, and
   * `publishViewIdentity()` republishes the bumped revisions every definition
   * write requires. Only a first edit that just seeded the client's ephemeral
   * working file still needs the full snapshot, so the client learns its new
   * lineage view (address, run summaries, workflow name).
   */
  async finishWorkflowPropertiesMutation(
    ctx: WebviewClientContext,
    message: { mutation?: unknown },
    createdWorkingFile: boolean
  ): Promise<void> {
    if (createdWorkingFile) {
      await this.refreshDefinitionMutationView(ctx, message);
    } else {
      await this.publishViewIdentity(ctx);
    }
  }

  /** Validate a promoted-run edit in place, or step this client onto its draft. */
  async prepareDefinitionMutation(
    ctx: WebviewClientContext,
    message: {
      mutation?: unknown;
    }
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      throw new Error("WorkflowOrchestrator not initialized");
    }
    await orchestrator.prepareDefinitionMutation(
      this.asWorkflowDefinitionMutation(message),
      ctx.clientId
    );
  }

  /** Keep workflow settings on an executing run's own definition head. */
  async prepareWorkflowPropertiesMutation(
    ctx: WebviewClientContext,
    message: {
      mutation?: unknown;
    }
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      throw new Error("WorkflowOrchestrator not initialized");
    }
    await orchestrator.prepareWorkflowPropertiesMutation(
      this.asWorkflowDefinitionMutation(message),
      ctx.clientId
    );
  }

  asWorkflowDefinitionMutation(message: {
    mutation?: unknown;
  }): WorkflowDefinitionMutation | undefined {
    return message.mutation as WorkflowDefinitionMutation | undefined;
  }

  /**
   * A run-addressed mutation refreshes every viewer of that run (including
   * this client) via `invalidateRunViews` inside the orchestrator call
   * itself, so a follow-up single-client refresh here would be redundant.
   * Draft/ephemeral edits have no such broadcast and still need it.
   */
  async refreshDefinitionMutationView(
    ctx: WebviewClientContext,
    message?: {
      mutation?: unknown;
    }
  ): Promise<void> {
    if (
      this.asWorkflowDefinitionMutation(message ?? {})?.address.kind !== "run"
    ) {
      const orchestrator = this.getOrchestrator();
      const address = orchestrator?.getViewAddress(ctx.clientId);
      if (orchestrator && address) {
        await orchestrator.loadRunViewForClient(
          address,
          ctx.postMessage,
          ctx.clientId
        );
      }
    }
    await this.publishViewIdentity(ctx);
  }

  /**
   * Hands the client the revisions its next mutation must carry. Required after
   * every definition write, including the ones that broadcast nothing else
   * (queueing a step, renaming, creating a lineage's first draft) — a client
   * left holding a superseded `definitionRevision` has its next edit rejected
   * as a conflict.
   */
  async publishViewIdentity(ctx: WebviewClientContext): Promise<void> {
    const identity = await this.getOrchestrator()?.publishViewIdentityToViewers(
      ctx.clientId
    );
    if (identity) {
      ctx.postMessage(identity);
    }
  }

  /**
   * Reports a rejected addressed action to the client *and* re-publishes the
   * authoritative revisions.
   *
   * A conflict is nearly always the client holding a superseded
   * `definitionRevision`, and until this ran the rejection was terminal: the
   * stale revision stayed in the store, so every following edit and every Run
   * press was rejected the same way and the header looked like a dead button.
   * Re-publishing turns a wedge into a single failed attempt.
   */
  async reportActionFailure(
    ctx: WebviewClientContext,
    action: string,
    error: unknown,
    requestId?: string
  ): Promise<void> {
    ctx.emit({
      type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
      action,
      error: getErrorMessage(error),
      ...(requestId ? { requestId } : {}),
    });
    await this.publishViewIdentity(ctx);
  }

  /**
   * Gate for every command that *starts* execution. ctrlyoke has no path that
   * auto-starts a workflow, so a run-starting command that arrives before the
   * orchestrator finished initializing was never a live user click — the known
   * source is a hosted client flushing a command queued before an extension-host
   * restart, which launched a whole run seconds after VS Code came back. Pause /
   * cancel-pause / stop stay ungated: they only ever reduce activity.
   */
  canStartRun(ctx: WebviewClientContext, action: string): boolean {
    if (this.getOrchestrator()?.isInitialized()) {
      return true;
    }
    Log.warn(
      `Refused to ${action}: ctrlyoke is still starting up. Run-starting commands are ignored until initialization completes.`
    );
    this.showRunActionFailure(
      ctx,
      action,
      new Error("ctrlyoke is still starting up — try again in a moment")
    );
    return false;
  }

  showRunActionFailure(
    ctx: WebviewClientContext,
    action: string,
    error: unknown
  ): void {
    Log.error(`Failed to ${action}:`, error);
    void vscode.window.showErrorMessage(
      `Failed to ${action}: ${getErrorMessage(error)}`
    );
    // A hosted browser client never sees the VS Code notification, so without
    // this the rejected run action is indistinguishable from a dead button.
    void this.reportActionFailure(ctx, action, error);
  }
}
