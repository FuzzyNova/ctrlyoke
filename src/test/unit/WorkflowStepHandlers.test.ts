import { suite, test } from "mocha";
import * as assert from "assert";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { WorkflowStepHandlers } from "../../ui/WorkflowStepHandlers";
import { WorkflowMutationCoordinator } from "../../ui/WorkflowMutationCoordinator";
import type { WebviewClientContext } from "../../ui/WebviewClientContext";
import type { WebviewSettingsSync } from "../../ui/WebviewSettingsSync";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";

/**
 * Regression coverage for the "step edit doesn't stay undoable" bug: a
 * successful step mutation must echo the acting client with
 * `publishViewIdentity` (revisions only), never a full `refreshDefinitionMutationView`
 * snapshot — the latter's `RUN_VIEW_LOADED` reply carries a bumped
 * `definitionRevision` the client hasn't recorded yet, so the webview's
 * `isSameViewReplay` check always reads it as a new view and wipes the
 * zundo undo stack the client's own STEPS_EXTENDED/PROMPT_DELETED handling
 * had just recorded an entry into. See `.github/instructions/ui.instructions.md`.
 */

/** Records which coordinator method a handler used on its success path. */
class RecordingMutationCoordinator extends WorkflowMutationCoordinator {
  readonly calls: string[] = [];

  constructor() {
    super(() => undefined);
  }

  override async prepareDefinitionMutation(): Promise<void> {
    this.calls.push("prepareDefinitionMutation");
  }

  override async publishViewIdentity(): Promise<void> {
    this.calls.push("publishViewIdentity");
  }

  override async refreshDefinitionMutationView(): Promise<void> {
    this.calls.push("refreshDefinitionMutationView");
  }
}

function makeOrchestrator(overrides: Record<string, unknown>) {
  const orchestrator = Object.create(
    WorkflowOrchestrator.prototype
  ) as WorkflowOrchestrator;
  Object.assign(orchestrator, overrides);
  return orchestrator;
}

function makeCtx(
  emit: (message: unknown) => void = () => {}
): WebviewClientContext {
  return {
    clientId: "panel",
    postMessage: () => undefined,
    emit,
  };
}

suite("WorkflowStepHandlers — steer messages", () => {
  test("dispatches the workflow, session, and raw draft without publishing an identity", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const calls: unknown[] = [];
    const orchestrator = makeOrchestrator({
      sendSteerMessage: async (...args: unknown[]) => {
        calls.push(args);
      },
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleSendSteerMessage(makeCtx(), {
      type: MESSAGE_TYPES.SEND_STEER_MESSAGE,
      workflowId: "workflow-1",
      sessionId: "session-1",
      text: "raw steer draft",
    });

    assert.deepStrictEqual(calls, [
      ["workflow-1", "session-1", "raw steer draft"],
    ]);
    assert.deepStrictEqual(coordinator.calls, []);
  });

  test("restores the raw draft and warns when dispatch is rejected", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const emitted: unknown[] = [];
    const orchestrator = makeOrchestrator({
      sendSteerMessage: async () => {
        throw new Error("That harness session has ended.");
      },
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleSendSteerMessage(
      makeCtx((message) => emitted.push(message)),
      {
        type: MESSAGE_TYPES.SEND_STEER_MESSAGE,
        workflowId: "workflow-1",
        sessionId: "session-1",
        text: "restore this draft",
      }
    );

    assert.deepStrictEqual(emitted, [
      {
        type: MESSAGE_TYPES.EXECUTE_PROMPT_ERROR,
        text: "restore this draft",
      },
      {
        type: MESSAGE_TYPES.USER_FEEDBACK,
        id: emitted[1] && (emitted[1] as { id: string }).id,
        severity: USER_FEEDBACK_SEVERITY.WARNING,
        message: "That harness session has ended.",
      },
    ]);
    assert.deepStrictEqual(coordinator.calls, []);
  });
});

suite("WorkflowStepHandlers — success-path client echo", () => {
  test("handleUpdatePrompt uses publishViewIdentity, not refreshDefinitionMutationView", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const orchestrator = makeOrchestrator({
      updatePromptInQueue: async () => undefined,
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleUpdatePrompt(makeCtx(), {
      index: 0,
      text: "edited",
      properties: { harness: "claude-cli" },
    } as any);

    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "publishViewIdentity",
    ]);
  });

  test("handleInsertWorkflowStep uses publishViewIdentity, not refreshDefinitionMutationView", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const orchestrator = makeOrchestrator({
      insertWorkflowStepAfterIndex: async () => undefined,
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleInsertWorkflowStep(makeCtx(), {
      afterIndex: 0,
      step: { prompt: "new step" },
    } as any);

    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "publishViewIdentity",
    ]);
  });

  test("handleUpdateFinalStep uses publishViewIdentity, not refreshDefinitionMutationView", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const orchestrator = makeOrchestrator({
      updateFinalStepInQueue: async () => undefined,
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleUpdateFinalStep(makeCtx(), {
      finalStep: { prompt: "final" },
    } as any);

    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "publishViewIdentity",
    ]);
  });

  test("handleDeletePrompt uses publishViewIdentity, not refreshDefinitionMutationView", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const orchestrator = makeOrchestrator({
      deletePromptFromQueue: async () => undefined,
    });

    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await handlers.handleDeletePrompt(makeCtx(), { index: 0 } as any);

    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "publishViewIdentity",
    ]);
  });

  test("handleReorderPrompts forwards the complete pending topology", async () => {
    const coordinator = new RecordingMutationCoordinator();
    let received: unknown[] = [];
    const orchestrator = makeOrchestrator({
      reorderPendingPrompts: async (...args: unknown[]) => {
        received = args;
      },
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );
    const pendingGroups = [
      { id: "group-1", start: 1, end: 2, failFast: false },
    ];

    await handlers.handleReorderPrompts(makeCtx(), {
      newPendingOrder: [0, 2, 1, 3],
      pendingGroups,
    } as any);

    assert.deepStrictEqual(received[1], [0, 2, 1, 3]);
    assert.strictEqual(received[2], "panel");
    assert.strictEqual(received[3], pendingGroups);
    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "publishViewIdentity",
    ]);
  });

  test("handleUndoRedoSync's failure path still forces a full refreshDefinitionMutationView resync", async () => {
    const coordinator = new RecordingMutationCoordinator();
    const orchestrator = makeOrchestrator({
      syncStepsForUndoRedo: async () => {
        throw new Error("Definition revision conflict: expected 3, found 4");
      },
    });
    const handlers = new WorkflowStepHandlers(
      () => orchestrator,
      {} as WebviewSettingsSync,
      coordinator
    );

    await assert.rejects(
      handlers.handleUndoRedoSync(makeCtx(), {
        steps: [],
      } as any)
    );

    assert.deepStrictEqual(coordinator.calls, [
      "prepareDefinitionMutation",
      "refreshDefinitionMutationView",
    ]);
  });
});

suite("WorkflowMutationCoordinator — property revision delegation", () => {
  test("delegates property revision validation once to the orchestrator", async () => {
    const calls: Array<{ mutation: unknown; clientId: string }> = [];
    const address = {
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      workflowKey: "workflow-key",
    } as const;
    const orchestrator = makeOrchestrator({
      prepareWorkflowPropertiesMutation: async (
        mutation: unknown,
        clientId: string
      ) => {
        calls.push({ mutation, clientId });
      },
    });
    const coordinator = new WorkflowMutationCoordinator(() => orchestrator);
    const mutation = {
      address,
      expectedDefinitionRevision: 1,
      expectedDescriptorRevision: 3,
    };
    const message: {
      mutation?: unknown;
    } = {
      mutation,
    };

    await coordinator.prepareWorkflowPropertiesMutation(makeCtx(), message);

    assert.deepStrictEqual(calls, [{ mutation, clientId: "panel" }]);
    assert.strictEqual(message.mutation, mutation);
  });
});
