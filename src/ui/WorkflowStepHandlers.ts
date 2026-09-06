import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import {
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../types/DashboardConstants";
import type {
  AppendAndContinueRunMessage,
  ContinueRunMessage,
  DiscardContinuationMessage,
  ExecuteDraftMessage,
  InsertWorkflowStepMessage,
  RunExecutionControlMessage,
  ReorderPromptsMessage,
  SeedNewRunMessage,
  SetStartPositionMessage,
  StartNewRunInsteadMessage,
  UpdatePromptMessage,
  UpdateStepColorMessage,
} from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";
import type { WebviewClientContext } from "./WebviewClientContext";
import type { WebviewSettingsSync } from "./WebviewSettingsSync";
import type { WorkflowMutationCoordinator } from "./WorkflowMutationCoordinator";

/**
 * Step-definition mutations and stable-address run lifecycle actions delegated
 * by {@link WebviewMessageRouter}.
 */
export class WorkflowStepHandlers {
  constructor(
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly settingsSync: WebviewSettingsSync,
    private readonly mutationCoordinator: WorkflowMutationCoordinator
  ) {}

  async handleExecutePrompt(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { text, properties, action, promptName, forceNewWorkflow } = message;

    try {
      await orchestrator.executeEphemeralPrompt(
        text,
        properties,
        action,
        promptName,
        forceNewWorkflow,
        ctx.clientId,
        this.mutationCoordinator.asWorkflowDefinitionMutation(message)
      );
      // Queueing a step is a definition mutation with no other back-channel, so
      // without this the following property edit would carry a stale revision.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to execute ephemeral prompt:", error);
      ctx.emit({
        type: MESSAGE_TYPES.EXECUTE_PROMPT_ERROR,
        text,
      });
      // A rejection is usually a superseded revision; hand the authoritative
      // revisions back so the next submission isn't rejected identically.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    }
  }

  async handleUpdatePrompt(
    ctx: WebviewClientContext,
    message: UpdatePromptMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { index, text, properties, clearProperties, promptName } = message;
    const mutation =
      this.mutationCoordinator.asWorkflowDefinitionMutation(message);

    try {
      // A nonzero completed-step edit is one logical action: establish the
      // durable pre-edit rewind snapshot first, then write the changed suffix
      // against the revisions that rewind produced. Posting UPDATE_PROMPT and
      // SET_START_POSITION independently raced both operations with the same
      // stale definitionRevision.
      if (
        message.rewindCompletedStep === true &&
        index > 0 &&
        mutation?.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ) {
        await orchestrator.updateCompletedPromptInQueue(
          mutation,
          index,
          text,
          properties,
          promptName,
          clearProperties,
          ctx.clientId
        );
      } else {
        // Step zero deliberately keeps full-rerun semantics: editing advances
        // the selected run head, while the header's Re-run action allocates a
        // fresh RunRef. Same-run pending continuations begin only after a
        // preserved prefix.
        await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
        await orchestrator.updatePromptInQueue(
          mutation,
          index,
          text,
          properties,
          promptName,
          clearProperties,
          ctx.clientId
        );
      }
      // Identity-only, not a full RUN_VIEW_LOADED snapshot: the editing
      // client already holds the post-edit content from its own STEPS_EXTENDED
      // broadcast. A full snapshot here arrives with a bumped
      // definitionRevision the client hasn't recorded yet, so RUN_VIEW_LOADED's
      // isSameViewReplay check always reads it as a genuine new view and wipes
      // the entire zundo undo stack (see ui.instructions.md) — silently
      // erasing the undo entry STEPS_EXTENDED just recorded for this edit.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to update prompt:", error);
    }
  }

  async handleUpdateStepColor(
    ctx: WebviewClientContext,
    message: UpdateStepColorMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
      await orchestrator.updateStepColorInQueue(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.index,
        message.color,
        ctx.clientId
      );
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to update step color:", error);
    }
  }

  async handleInsertWorkflowStep(
    ctx: WebviewClientContext,
    message: InsertWorkflowStepMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);

    try {
      await orchestrator.insertWorkflowStepAfterIndex(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.afterIndex,
        message.step,
        ctx.clientId
      );
      // Identity-only — see the comment in handleUpdatePrompt above; the
      // inserting client already holds the post-insert steps via its own
      // STEPS_EXTENDED broadcast.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to insert workflow step:", error);
    }
  }

  async handleUpdateFinalStep(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);

    try {
      await orchestrator.updateFinalStepInQueue(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.finalStep ?? null,
        message.clearProperties,
        ctx.clientId
      );
      // Identity-only — see the comment in handleUpdatePrompt above.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to update finalStep:", error);
    }
  }

  async handleDeletePrompt(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);

    const { index } = message;

    try {
      await orchestrator.deletePromptFromQueue(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        index,
        ctx.clientId
      );
      // Identity-only — see the comment in handleUpdatePrompt above; the
      // deleting client already holds the post-delete steps via its own
      // PROMPT_DELETED broadcast.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
    }
  }

  async handleReorderPrompts(
    ctx: WebviewClientContext,
    message: ReorderPromptsMessage
  ): Promise<void> {
    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    await orchestrator.reorderPendingPrompts(
      this.mutationCoordinator.asWorkflowDefinitionMutation(message),
      message.newPendingOrder,
      ctx.clientId,
      message.pendingGroups
    );
    await this.mutationCoordinator.publishViewIdentity(ctx);
  }

  async handleUpdateWorkflowProperty(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    await this.mutationCoordinator.prepareWorkflowPropertiesMutation(
      ctx,
      message
    );
    const createdWorkingFile =
      await this.settingsSync.handleUpdateWorkflowProperty(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.property,
        message.value,
        ctx.postMessage,
        ctx.clientId
      );
    await this.mutationCoordinator.finishWorkflowPropertiesMutation(
      ctx,
      message,
      createdWorkingFile
    );
  }

  async handleUpdateWorkflowProperties(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    await this.mutationCoordinator.prepareWorkflowPropertiesMutation(
      ctx,
      message
    );
    const createdWorkingFile =
      await this.settingsSync.handleUpdateWorkflowProperties(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.properties,
        ctx.postMessage,
        ctx.clientId
      );
    await this.mutationCoordinator.finishWorkflowPropertiesMutation(
      ctx,
      message,
      createdWorkingFile
    );
  }

  async handleUndoRedoSync(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    try {
      await this.syncUndoRedo(ctx, message);
    } catch (error) {
      // The client already applied this undo/redo optimistically to its own
      // zundo-backed state before the write was confirmed. A rejected write
      // (e.g. a stale expectedDefinitionRevision) leaves that optimistic
      // change resident locally with nothing persisted to back it — a silent
      // client/server desync that would only surface on reload or promotion.
      // A full resync overwrites the client's local guess with the actual
      // persisted definition; the caller's catch-all still reports the
      // failure toast via reportActionFailure.
      await this.mutationCoordinator.refreshDefinitionMutationView(
        ctx,
        message
      );
      throw error;
    }
  }

  private async syncUndoRedo(
    ctx: WebviewClientContext,
    message: any
  ): Promise<void> {
    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
    const mutation =
      this.mutationCoordinator.asWorkflowDefinitionMutation(message);
    const orchestrator = this.getOrchestrator();
    let latest = await orchestrator?.syncStepsForUndoRedo(
      mutation,
      message.steps,
      message.finalStep ?? null,
      ctx.clientId,
      message.parallelGroups
    );
    if (typeof message.workflowName === "string") {
      // Undo/redo tracks workflowName as part of its zundo-covered state
      // (UndoRedoControl's describeChange shows "Renamed to X" and the
      // client already reverted its local display), but nothing previously
      // sent the restored name back to the server — undoing a rename was a
      // pure client-side illusion that a following resync (or simply this
      // handler's own steps write, for a run address) would silently
      // overwrite back to the never-reverted persisted name. Same stale-
      // revision reasoning as the workflowProperties chaining below: target
      // the steps write's fresh revision, not the one this message started with.
      const nameMutation =
        mutation && latest
          ? {
              ...mutation,
              expectedDefinitionRevision: latest.definitionRevision,
              expectedDescriptorRevision: latest.descriptorRevision,
            }
          : mutation;
      const nameLatest = await orchestrator?.updateWorkflowName(
        nameMutation,
        message.workflowName,
        ctx.clientId
      );
      if (nameLatest) {
        latest = nameLatest;
      }
    }
    if ("workflowProperties" in message) {
      const raw = {
        harness: message.workflowProperties?.harness,
        model: message.workflowProperties?.model,
        executionMode: message.workflowProperties?.executionMode,
        agent: message.workflowProperties?.agent,
        skills: message.workflowProperties?.skills,
        resumeSession: message.workflowProperties?.resumeSession,
        sessionId: message.workflowProperties?.sessionId,
        mcpServers: message.workflowProperties?.mcpServers,
        hooks: message.workflowProperties?.hooks,
        endCondition: message.workflowProperties?.endCondition,
        preCondition: message.workflowProperties?.preCondition,
        priorContext: message.workflowProperties?.priorContext,
        additionalArgs: message.workflowProperties?.additionalArgs,
        toolPermissions: message.workflowProperties?.toolPermissions,
      };
      // Strip undefined values: undo restores known state but should not delete
      // properties the undo snapshot predates (e.g. toolPermissions seeded after
      // snapshot capture). Passing undefined would trigger allowDeletes and wipe
      // the live working file value, causing inject-mode mismatches on the next step.
      const workflowProperties = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined)
      );
      if (Object.keys(workflowProperties).length > 0) {
        // `syncStepsForUndoRedo`'s static-path write(s) above already advanced
        // the run's revision — target that fresh revision here instead of the
        // now-stale one this message started with. `latest` is only set for
        // that static path; the live-instance and non-run cases fall back to
        // the original mutation, whose one-shot revision guard is already
        // consumed by the first write and imposes no further check.
        const propertiesMutation =
          mutation && latest
            ? {
                ...mutation,
                expectedDefinitionRevision: latest.definitionRevision,
                expectedDescriptorRevision: latest.descriptorRevision,
              }
            : mutation;
        await this.settingsSync.handleUpdateWorkflowProperties(
          propertiesMutation,
          workflowProperties,
          ctx.postMessage,
          ctx.clientId
        );
      }
    }
    // Identity-only, like every other successful definition mutation
    // (finishWorkflowPropertiesMutation, updateWorkingFileProperties, ...).
    // The client already holds the post-undo/redo content it just sent —
    // it applied the zundo pop locally before syncing — so a full
    // RUN_VIEW_LOADED snapshot here would be redundant. Worse, that
    // snapshot's bumped definitionRevision never equals the client's prior
    // one (this write bumped it), so `RUN_VIEW_LOADED`'s isSameViewReplay
    // check would always read this as a genuine new view and clear the
    // entire zundo temporal stack (past *and* future) after every single
    // undo/redo — which is why more than one undo/redo in a row used to
    // stop working.
    await this.mutationCoordinator.publishViewIdentity(ctx);
  }

  async handleExecuteDraft(
    ctx: WebviewClientContext,
    message: ExecuteDraftMessage
  ): Promise<void> {
    if (!this.mutationCoordinator.canStartRun(ctx, "run draft")) return;
    try {
      await this.getOrchestrator()?.executeDraftAtAddress(
        message.address,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        ctx.clientId
      );
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(ctx, "run draft", error);
    }
  }

  async handleSeedNewRun(
    ctx: WebviewClientContext,
    message: SeedNewRunMessage
  ): Promise<void> {
    if (!this.mutationCoordinator.canStartRun(ctx, "re-run")) return;
    try {
      await this.getOrchestrator()?.seedAndExecuteAtRun(
        message.address,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        ctx.clientId
      );
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(ctx, "re-run", error);
    }
  }

  async handleStartNewRunInstead(
    ctx: WebviewClientContext,
    message: StartNewRunInsteadMessage
  ): Promise<void> {
    if (!this.mutationCoordinator.canStartRun(ctx, "start new run")) return;
    try {
      const result = await this.getOrchestrator()?.startNewRunInsteadAtRun(
        message.address,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        message.confirmEditedSuffix === true,
        ctx.clientId
      );
      if (result && "hasSuffixEdits" in result) {
        // Never a native VS Code dialog here — hosted browser clients never see
        // those. Ask the webview to render its own confirmation modal instead;
        // confirming resends this same message with confirmEditedSuffix: true.
        ctx.emit({
          type: MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED,
          action: "startNewRunInstead",
          address: message.address,
          expectedDefinitionRevision: message.expectedDefinitionRevision,
          expectedDescriptorRevision: message.expectedDescriptorRevision,
        });
      }
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(
        ctx,
        "start new run",
        error
      );
    }
  }

  async handleContinueRun(
    ctx: WebviewClientContext,
    message: ContinueRunMessage
  ): Promise<void> {
    if (!this.mutationCoordinator.canStartRun(ctx, "continue run")) return;
    try {
      await this.getOrchestrator()?.continueAtRun(
        message.address,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        ctx.clientId
      );
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(ctx, "continue run", error);
    }
  }

  async handleAppendAndContinue(
    ctx: WebviewClientContext,
    message: AppendAndContinueRunMessage
  ): Promise<void> {
    if (!this.mutationCoordinator.canStartRun(ctx, "append and continue")) {
      return;
    }
    try {
      await this.getOrchestrator()?.appendAndContinueAtRun(
        message.address,
        message.tail,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        ctx.clientId
      );
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(
        ctx,
        "append and continue",
        error
      );
    }
  }

  async handleRunExecutionControl(
    ctx: WebviewClientContext,
    message: RunExecutionControlMessage
  ): Promise<void> {
    if (
      message.type === MESSAGE_TYPES.RESUME_RUN &&
      !this.mutationCoordinator.canStartRun(ctx, "resume run")
    ) {
      return;
    }
    try {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) {
        throw new Error("WorkflowOrchestrator not initialized");
      }
      if (message.type === MESSAGE_TYPES.PAUSE_RUN) {
        await orchestrator.pauseAtRun(message.address);
      } else if (message.type === MESSAGE_TYPES.CANCEL_PAUSE_RUN) {
        await orchestrator.cancelPauseAtRun(message.address);
      } else if (message.type === MESSAGE_TYPES.RESUME_RUN) {
        await orchestrator.resumeAtRun(message.address);
      } else {
        await orchestrator.stopAtRun(message.address);
      }
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(
        ctx,
        "control execution",
        error
      );
    }
  }

  async handleSetStartPosition(
    ctx: WebviewClientContext,
    message: SetStartPositionMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await orchestrator.setStartPositionAtRun(
        {
          workflowKey: message.address.workflowKey,
          runRef: message.address.runRef,
        },
        message.toIndex,
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        ctx.clientId
      );
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(
        ctx,
        "set start position",
        error
      );
    }
  }

  async handleDiscardContinuation(
    ctx: WebviewClientContext,
    message: DiscardContinuationMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      throw new Error("WorkflowOrchestrator not initialized");
    }
    try {
      const result = await orchestrator.discardContinuationAtRun(
        {
          workflowKey: message.address.workflowKey,
          runRef: message.address.runRef,
        },
        message.expectedDefinitionRevision,
        message.expectedDescriptorRevision,
        message.confirmEditedSuffix,
        ctx.clientId
      );
      if (!result.discarded && result.hasSuffixEdits) {
        // Never a native VS Code dialog here — hosted browser clients never see
        // those. Ask the webview to render its own confirmation modal instead;
        // confirming resends this same message with confirmEditedSuffix: true.
        ctx.emit({
          type: MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED,
          action: "discardContinuation",
          address: message.address,
          expectedDefinitionRevision: message.expectedDefinitionRevision,
          expectedDescriptorRevision: message.expectedDescriptorRevision,
        });
      }
    } catch (error) {
      this.mutationCoordinator.showRunActionFailure(
        ctx,
        "discard continuation",
        error
      );
    }
  }
}
