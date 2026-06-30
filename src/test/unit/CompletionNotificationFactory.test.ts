import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import {
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
} from "../../ui/notifications/CompletionNotificationFactory";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";

suite("CompletionNotificationFactory", () => {
  test("builds workflow success notifications when workflow events are enabled", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-1",
        workflowName: "refactor.flightpath.yaml",
        filePath: "C:/dev/ctrlyoke/refactor.flightpath.yaml",
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
    assert.match(event?.body ?? "", /refactor\.flightpath\.yaml/);
    assert.strictEqual(event?.url, "http://localhost:4747/?token=test");
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

  test("suppresses workflow success notifications in failures-only mode", () => {
    const event = buildWorkflowCompletionNotification({
      summary: {
        id: "wf-2",
        workflowName: "compile",
        filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
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

  test("detects workflow completion transitions only from running", () => {
    assert.strictEqual(
      isWorkflowCompletionTransition(
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
        },
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
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
        filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
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
          filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 2,
          totalSteps: 2,
        },
        {
          id: "wf-2",
          workflowName: "compile",
          filePath: "C:/dev/ctrlyoke/compile.flightpath.yaml",
          executionState: EXECUTION_STATES.COMPLETED,
          currentStep: 2,
          totalSteps: 2,
        }
      ),
      false
    );
  });

  test("builds prompt failure notifications when prompt failures are enabled", () => {
    const event = buildPromptCompletionNotification({
      summary: {
        id: "wf-3",
        workflowName: "lint",
        filePath: "C:/dev/ctrlyoke/lint.flightpath.yaml",
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
