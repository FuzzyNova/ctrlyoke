import * as assert from "assert";
import { suite, test } from "mocha";
import {
  DERIVED_NOTIFICATION_EVENTS,
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import {
  buildHookNotificationEvent,
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
  notificationIdentityPrefix,
  type HookArtifact,
} from "../../core/notifications/NotificationEventFactory";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

suite("NotificationEventFactory", () => {
  const createHookArtifact = (
    overrides: Partial<HookArtifact> = {}
  ): HookArtifact => ({
    runId: "run-1",
    timestamp: 123,
    workflowId: "wf-hook",
    workflowName: "refactor",
    promptIndex: 1,
    promptName: "implement",
    hookEvent: "notification",
    nativeHookEvent: "Notification",
    harnessId: "claude-cli",
    rawHookData: {},
    ...overrides,
  });

  const notificationSettings = {
    ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
    events: {
      ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
      hookEvents: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents,
        notification: true,
      },
    },
  };

  test("suppresses disabled hook notifications", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({ notificationMessage: "Answer needed" }),
      CTRLYOKE_SETTINGS_DEFAULTS.notifications
    );

    assert.strictEqual(event, null);
  });

  test("surfaces decision-hook failures even when hook notifications are disabled", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        hookEvent: "error",
        nativeHookEvent: "decisionHookFailure",
        rawHookData: { message: "ETIMEDOUT: decision hook timed out" },
      }),
      CTRLYOKE_SETTINGS_DEFAULTS.notifications
    );

    assert.ok(event);
    assert.strictEqual(event?.title, "ctrlyoke - Decision hook failed");
    assert.strictEqual(
      event?.body,
      "refactor - implement - ETIMEDOUT: decision hook timed out"
    );
    assert.strictEqual(event?.severity, "error");
  });

  test("keeps workflow and prompt context with the native message", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({ notificationMessage: "Answer needed" }),
      notificationSettings
    );

    assert.ok(event);
    assert.strictEqual(event?.title, "ctrlyoke - Notification");
    assert.strictEqual(event?.body, "refactor - implement - Answer needed");
  });

  test("includes a distinct native title before its message", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        notificationTitle: "Permission required",
        notificationMessage: "Allow access to the repository?",
      }),
      notificationSettings
    );

    assert.strictEqual(
      event?.body,
      "refactor - implement - Permission required - Allow access to the repository?"
    );
  });

  test("does not repeat a native title that duplicates its message", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        notificationTitle: "  Answer needed ",
        notificationMessage: "Answer needed",
      }),
      notificationSettings
    );

    assert.strictEqual(event?.body, "refactor - implement - Answer needed");
  });

  test("trims empty native values and falls back to the notification type", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        notificationTitle: "  ",
        notificationMessage: "\t",
        notificationType: "  permission_prompt  ",
      }),
      notificationSettings
    );

    assert.strictEqual(event?.body, "refactor - implement - permission_prompt");
  });

  test("falls back to the shared notification label without native details", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        notificationTitle: "",
        notificationMessage: " ",
        notificationType: "\n",
        rawHookData: { message: "secret payload" },
      }),
      notificationSettings
    );

    assert.strictEqual(event?.body, "refactor - implement - Notification");
    assert.ok(!event?.body.includes("secret payload"));
  });

  test("builds awaiting-input notifications from the semantic setting", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        hookEvent: DERIVED_NOTIFICATION_EVENTS.AWAITING_INPUT,
        nativeHookEvent: "PermissionRequest",
        toolName: "Bash",
        notificationTitle: "Permission required",
        notificationMessage: "Allow this command?",
      }),
      {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
        events: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
          hookEvents: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents,
            permissionRequest: false,
          },
        },
      }
    );

    assert.ok(event);
    assert.strictEqual(event?.title, "ctrlyoke - Waiting for input");
    assert.strictEqual(
      event?.body,
      "refactor - implement - Bash - Permission required - Allow this command?"
    );
    assert.strictEqual(event?.hookEvent, undefined);
    assert.strictEqual(
      event?.derivedEvent,
      DERIVED_NOTIFICATION_EVENTS.AWAITING_INPUT
    );
  });

  test("gates awaiting-input artifacts on their own setting", () => {
    const event = buildHookNotificationEvent(
      createHookArtifact({
        hookEvent: DERIVED_NOTIFICATION_EVENTS.AWAITING_INPUT,
      }),
      {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
        events: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
          awaitingInput: false,
          hookEvents: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents,
            permissionRequest: true,
          },
        },
      }
    );

    assert.strictEqual(event, null);
  });

  test("builds workflow success notifications when workflow events are enabled", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-1",
        workflowName: "refactor.ctrlyoke.yaml",
        filePath: "C:/dev/ctrlyoke/refactor.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.COMPLETED,
        currentStep: 4,
        totalSteps: 4,
        startedAt: 0,
      },
      settings: CTRLYOKE_SETTINGS_DEFAULTS.notifications,
      url: "http://localhost:4747/?token=test",
    });

    assert.ok(event);
    assert.strictEqual(event?.title, "ctrlyoke - Workflow Complete");
    assert.match(event?.body ?? "", /refactor\.ctrlyoke\.yaml/);
    assert.strictEqual(event?.url, "http://localhost:4747/?token=test");
  });

  test("includes the failing step and reason in workflow failure notifications", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-failed",
        workflowName: "refactor",
        filePath: "refactor.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.ERROR,
        currentStep: 1,
        totalSteps: 4,
        failure: {
          stepLabel: "Step 2",
          kind: "harnessError",
          message: "Rate limit exceeded",
        },
      },
      settings: CTRLYOKE_SETTINGS_DEFAULTS.notifications,
    });

    assert.match(event?.body ?? "", /Step 2 - Rate limit exceeded/);
  });

  test("truncates failure notification reasons at a word boundary", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-long-failure",
        workflowName: "refactor",
        filePath: "refactor.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.ERROR,
        currentStep: 1,
        totalSteps: 4,
        failure: {
          stepLabel: "Step 2",
          kind: "harnessError",
          message: `${"word ".repeat(50)}tail`,
        },
      },
      settings: CTRLYOKE_SETTINGS_DEFAULTS.notifications,
    });

    assert.ok((event?.body.length ?? 0) < 260);
    assert.ok(!(event?.body ?? "").includes("tail"));
  });

  test("suppresses workflow failure notifications when workflow events are disabled", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-disabled",
        workflowName: "refactor",
        filePath: "refactor.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.ERROR,
        currentStep: 1,
        totalSteps: 4,
        failure: {
          stepLabel: "Step 2",
          kind: "harnessError",
          message: "Failed",
        },
      },
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
        events: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
          workflowComplete: NOTIFICATION_EVENT_MODES.NONE,
        },
      },
    });

    assert.strictEqual(event, undefined);
  });

  test("redacts resolved secrets from failure notification reasons", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ API_KEY: "notification-secret-value" });
    const release = secretRedactionService.register(redactor);
    try {
      const event = buildWorkflowCompletionNotification({
        summary: {
          id: "wf-secret-failure",
          workflowName: "refactor",
          filePath: "refactor.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.ERROR,
          currentStep: 1,
          totalSteps: 4,
          failure: {
            stepLabel: "Step 2",
            kind: "harnessError",
            message: "Token notification-secret-value rejected",
          },
        },
        settings: CTRLYOKE_SETTINGS_DEFAULTS.notifications,
      });

      assert.doesNotMatch(event?.body ?? "", /notification-secret-value/);
    } finally {
      release();
    }
  });

  test("builds test notifications with stable metadata", () => {
    const event = buildTestNotificationEvent(
      "http://localhost:4747/?token=test"
    );

    assert.strictEqual(event.title, "ctrlyoke - Test Notification");
    assert.strictEqual(event.body, "Developer test notification");
    assert.strictEqual(event.workflowId, "test");
    assert.strictEqual(event.url, "http://localhost:4747/?token=test");
  });

  test("uses durable run identity for notification cleanup prefixes", () => {
    assert.strictEqual(
      notificationIdentityPrefix({
        id: "instance-1",
        workflowKey: "lineage-1" as never,
        runRef: "run-1" as never,
        workflowName: "workflow",
        filePath: "workflow.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 0,
        totalSteps: 1,
      }),
      "lineage-1:run-1:"
    );
    assert.strictEqual(
      notificationIdentityPrefix({
        id: "instance-1",
        workflowName: "workflow",
        filePath: "workflow.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 0,
        totalSteps: 1,
      }),
      "instance-1:"
    );
  });

  test("suppresses workflow success notifications in failures-only mode", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-2",
        workflowName: "compile",
        filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.COMPLETED,
        currentStep: 2,
        totalSteps: 2,
      },
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
        events: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
          workflowComplete: NOTIFICATION_EVENT_MODES.FAILURES_ONLY,
        },
      },
    });

    assert.strictEqual(event, undefined);
  });

  test("detects workflow completion transitions from in-flight states", () => {
    assert.strictEqual(
      isWorkflowCompletionTransition(
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
        },
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 2,
          totalSteps: 2,
        }
      ),
      true
    );

    assert.strictEqual(
      isWorkflowCompletionTransition(undefined, {
        id: "wf-2",
        workflowName: "compile",
        filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.COMPLETED,
        currentStep: 2,
        totalSteps: 2,
      }),
      false
    );

    assert.strictEqual(
      isWorkflowCompletionTransition(
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 2,
          totalSteps: 2,
        },
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 2,
          totalSteps: 2,
        }
      ),
      false
    );

    const pausingSummary = {
      id: "wf-2",
      workflowName: "compile",
      filePath: "C:/dev/ctrlyoke/compile.ctrlyoke.yaml",
      executionState: EXECUTION_STATES.PAUSING,
      currentStep: 2,
      totalSteps: 2,
    };

    for (const [nextState, expectedTitle] of [
      [EXECUTION_STATES.ERROR, "ctrlyoke - Workflow Failed"],
      [EXECUTION_STATES.COMPLETED, "ctrlyoke - Workflow Complete"],
    ] as const) {
      const nextSummary = { ...pausingSummary, executionState: nextState };
      assert.strictEqual(
        isWorkflowCompletionTransition(pausingSummary, nextSummary),
        true
      );

      const event = buildWorkflowCompletionNotification({
        summary: nextSummary,
        settings: CTRLYOKE_SETTINGS_DEFAULTS.notifications,
      });
      assert.strictEqual(event?.title, expectedTitle);
    }

    // PAUSED means the in-flight step has already finished, so a later error
    // is not a completion transition for this notification path.
    assert.strictEqual(
      isWorkflowCompletionTransition(
        { ...pausingSummary, executionState: EXECUTION_STATES.PAUSED },
        { ...pausingSummary, executionState: EXECUTION_STATES.ERROR }
      ),
      false
    );
  });

  test("builds prompt failure notifications when prompt failures are enabled", () => {
    const event = buildPromptCompletionNotification({
      summary: {
        id: "wf-3",
        workflowName: "lint",
        filePath: "C:/dev/ctrlyoke/lint.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 1,
        totalSteps: 3,
      },
      steps: [
        { prompt: "step 1" },
        { name: "implement", prompt: "step 2" },
        { prompt: "step 3" },
      ],
      stepIndex: 1,
      stepStatus: {
        state: STEP_STATUS.FAILED,
        message: "End condition failed",
      },
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
        events: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
          promptComplete: NOTIFICATION_EVENT_MODES.FAILURES_ONLY,
        },
      },
    });

    assert.ok(event);
    assert.strictEqual(event?.title, "ctrlyoke - Prompt Failed");
    assert.match(event?.body ?? "", /step 2 "implement"/);
    assert.match(event?.body ?? "", /End condition failed/);
  });
});
