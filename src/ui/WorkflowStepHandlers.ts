import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  AppendAndContinueRunMessage,
  ContinueRunMessage,
  DiscardContinuationMessage,
  ExecuteDraftMessage,
  InsertWorkflowStepMessage,
  RunExecutionControlMessage,
  SeedNewRunMessage,
  SetStartPositionMessage,
  StartNewRunInsteadMessage,
  UpdatePromptMessage,
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
        mutation?.address.kind === "run"
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
      await this.mutationCoordinator.refreshDefinitionMutationView(
        ctx,
        message
      );
    } catch (error) {
      Log.error("Failed to update prompt:", error);
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
      await this.mutationCoordinator.refreshDefinitionMutationView(
        ctx,
        message
      );
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
      await this.mutationCoordinator.refreshDefinitionMutationView(
        ctx,
        message
      );
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
      await this.mutationCoordinator.refreshDefinitionMutationView(
        ctx,
        message
      );
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
    }
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
    await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
    const mutation =
      this.mutationCoordinator.asWorkflowDefinitionMutation(message);
    const latest = await this.getOrchestrator()?.syncStepsForUndoRedo(
      mutation,
      message.steps,
      message.finalStep ?? null,
      ctx.clientId
    );
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
    await this.mutationCoordinator.refreshDefinitionMutationView(ctx, message);
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
