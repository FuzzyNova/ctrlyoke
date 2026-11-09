import * as assert from "assert";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { WorkflowSummary } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import { NotificationManager } from "../../ui/NotificationManager";
import { snapshotProperty } from "../helpers/propertySnapshot";

suite("NotificationManager completion deduplication", () => {
  const makeSummary = (
    id: string,
    executionState: WorkflowSummary["executionState"],
    failure?: WorkflowSummary["failure"]
  ): WorkflowSummary => ({
    id,
    workflowKey: `lineage-${id}` as WorkflowSummary["workflowKey"],
    runRef: `run-${id}` as WorkflowSummary["runRef"],
    workflowName: "workflow",
    filePath: "workflow.ctrlyoke.yaml",
    executionState,
    ...(failure ? { failure } : {}),
    currentStep: 0,
    totalSteps: 1,
  });

  function withManager(
    run: (manager: NotificationManager, toastCount: () => number) => void
  ): void {
    const restoreToast = snapshotProperty(
      vscode.window,
      "showInformationMessage"
    );
    const restoreErrorToast = snapshotProperty(
      vscode.window,
      "showErrorMessage"
    );
    let toasts = 0;
    Object.defineProperty(vscode.window, "showInformationMessage", {
      configurable: true,
      value: () => {
        toasts++;
        return Promise.resolve(undefined);
      },
    });
    Object.defineProperty(vscode.window, "showErrorMessage", {
      configurable: true,
      value: () => {
        toasts++;
        return Promise.resolve(undefined);
      },
    });
    configService.setCliOverlay({
      notifications: {
        vscode: { enabled: true },
        onlyWhenWindowUnfocused: false,
        events: { promptComplete: NOTIFICATION_EVENT_MODES.ALL },
      },
    });
    try {
      const manager = new NotificationManager(
        () =>
          ({
            getWorkflow: () => ({
              getQueueState: () => ({ steps: [{}] }),
            }),
          }) as never
      );
      run(manager, () => toasts);
    } finally {
      restoreToast();
      restoreErrorToast();
      configService.setCliOverlay({});
    }
  }

  test("shows workflow completion again after append and continuation", () => {
    withManager((manager, toastCount) => {
      manager.notifyWorkflowAdded(
        makeSummary("instance-1", EXECUTION_STATES.RUNNING)
      );
      manager.notifyWorkflowSummaryUpdated(
        makeSummary("instance-1", EXECUTION_STATES.COMPLETED)
      );
      manager.notifyWorkflowSummaryUpdated(
        makeSummary("instance-1", EXECUTION_STATES.RUNNING)
      );
      manager.notifyWorkflowSummaryUpdated(
        makeSummary("instance-1", EXECUTION_STATES.COMPLETED)
      );

      assert.strictEqual(toastCount(), 2);
    });
  });

  test("shows a step completion again after the step is rewound and rerun", () => {
    withManager((manager, toastCount) => {
      manager.notifyWorkflowAdded(
        makeSummary("instance-1", EXECUTION_STATES.RUNNING)
      );
      manager.updateStepStatus(
        0,
        { state: STEP_STATUS.COMPLETED },
        undefined,
        "instance-1"
      );
      manager.updateStepStatus(
        0,
        { state: STEP_STATUS.RUNNING },
        undefined,
        "instance-1"
      );
      manager.updateStepStatus(
        0,
        { state: STEP_STATUS.COMPLETED },
        undefined,
        "instance-1"
      );

      assert.strictEqual(toastCount(), 2);
    });
  });

  test("shows one completion failure notice for each stopping reason", () => {
    withManager((manager, toastCount) => {
      const failures = [
        ["harness", "Harness failed"],
        ["time-limit", "Workflow time limit reached"],
        ["step-limit", "Step limit reached"],
      ] as const;
      for (const [id, message] of failures) {
        manager.notifyWorkflowAdded(makeSummary(id, EXECUTION_STATES.RUNNING));
        const failed = makeSummary(id, EXECUTION_STATES.ERROR, {
          stepLabel: "prompt 1",
          kind: "unknown",
          message,
        });
        manager.notifyWorkflowSummaryUpdated(failed);
        manager.notifyWorkflowSummaryUpdated(failed);
      }

      assert.strictEqual(toastCount(), failures.length);
    });
  });

  test("dismiss clears run notification keys", () => {
    withManager((manager, toastCount) => {
      manager.notifyWorkflowAdded(
        makeSummary("instance-1", EXECUTION_STATES.RUNNING)
      );
      manager.notifyWorkflowSummaryUpdated(
        makeSummary("instance-1", EXECUTION_STATES.COMPLETED)
      );
      manager.notifyWorkflowDismissed("instance-1");
      manager.notifyWorkflowAdded(
        makeSummary("instance-2", EXECUTION_STATES.RUNNING)
      );
      manager.notifyWorkflowSummaryUpdated(
        makeSummary("instance-2", EXECUTION_STATES.COMPLETED)
      );

      assert.strictEqual(toastCount(), 2);
    });
  });
});
