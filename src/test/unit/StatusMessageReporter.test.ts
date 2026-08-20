import * as assert from "assert";
import { suite, test } from "mocha";
import type { IDashboardSink } from "../../types/IDashboardSink";
import {
  FINAL_STEP_PHASES,
  type StatusMessageSeverity,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { StatusMessage } from "../../types/WebviewMessageTypes";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import {
  StatusMessageReporter,
  type WorkflowEventTarget,
} from "../../core/orchestration/StatusMessageReporter";

class DashboardSinkDouble implements IDashboardSink {
  readonly statusMessages: Array<{
    stepIndex: number;
    message: string;
    severity: StatusMessageSeverity | undefined;
    workflowId: string | undefined;
    timestampMs: number | undefined;
  }> = [];

  updateFileSelected(): Promise<void> {
    return Promise.resolve();
  }
  updateSessionRestored(): Promise<void> {
    return Promise.resolve();
  }
  updateExecutionStarted(): void {}
  updateProgress(): void {}
  updateExecutionState(): void {}
  updateStepStatus(): void {}
  updateRetryAttempt(): void {}
  updateCliOutput(): void {}
  updateCliStreamingChunk(): void {}
  updateCliStreamingEvents(): void {}
  updateContextWindow(): void {}
  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string,
    timestampMs?: number
  ): void {
    this.statusMessages.push({
      stepIndex,
      message,
      severity,
      workflowId,
      timestampMs,
    });
  }
  updateStepsExtended(): void {}
  updatePromptDeleted(): void {}
  updateFinalStep(): void {}
  updateFinalStepStatus(): void {}
  updateFinalStepOutput(): void {}
  updateFinalStepStreamingChunk(): void {}
  updateFinalStepStreamingEvents(): void {}
  notifyPromptsReordered(): void {}
  notifyUndoRedoSynced(): void {}
  updateWorkflowName(): void {}
  sendStepUndoDataUpdated(): void {}
  updateHarnessUsage(): void {}
  updateWorktreeMerge(): void {}
}

class HistoryManagerDouble extends OutputHistoryManager {
  readonly statusMessages: Array<{
    filePath: string;
    target: OutputExecutionTarget;
    statusMessage: StatusMessage;
  }> = [];
  rejectWrites = false;

  constructor() {
    super(".");
  }

  override appendStatusMessage(
    filePath: string,
    target: OutputExecutionTarget,
    statusMessage: StatusMessage
  ): Promise<void> {
    this.statusMessages.push({ filePath, target, statusMessage });
    return this.rejectWrites
      ? Promise.reject(new Error("write failed"))
      : Promise.resolve();
  }
}

const queueTarget: WorkflowEventTarget = {
  kind: FINAL_STEP_PHASES.QUEUE,
  stepIndex: 2,
};
const finalStepTarget: WorkflowEventTarget = {
  kind: FINAL_STEP_PHASES.FINAL_STEP,
  loopIndex: 3,
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
}

suite("StatusMessageReporter", () => {
  test("pushes live without persisting when no history sink is active", () => {
    const dashboard = new DashboardSinkDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => undefined
    );

    reporter.report(queueTarget, "warning", "warning");

    assert.strictEqual(dashboard.statusMessages.length, 1);
    assert.strictEqual(dashboard.statusMessages[0].stepIndex, 2);
  });

  test("pushes live and persists when a history sink is active", () => {
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => ({ filePath: "run/events.jsonl", manager: history }),
      undefined,
      () => "workflow-1"
    );

    reporter.report(queueTarget, "failure", "error", { timestampMs: 123 });

    assert.deepStrictEqual(dashboard.statusMessages, [
      {
        stepIndex: 2,
        message: "failure",
        severity: "error",
        workflowId: "workflow-1",
        timestampMs: 123,
      },
    ]);
    assert.deepStrictEqual(history.statusMessages, [
      {
        filePath: "run/events.jsonl",
        target: queueTarget,
        statusMessage: {
          message: "failure",
          severity: "error",
          timestamp: 123,
        },
      },
    ]);
  });

  test("live dedupe does not suppress persistence", () => {
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => ({ filePath: "run/events.jsonl", manager: history })
    );

    reporter.report(queueTarget, "notice", "info", {
      liveDedupeKey: "notice",
    });
    reporter.report(queueTarget, "notice", "info", {
      liveDedupeKey: "notice",
    });

    assert.strictEqual(dashboard.statusMessages.length, 1);
    assert.strictEqual(history.statusMessages.length, 2);
  });

  test("persist dedupe does not suppress the live push", () => {
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => ({ filePath: "run/events.jsonl", manager: history })
    );

    reporter.report(queueTarget, "notice", "info", {
      persistDedupeKey: "notice",
    });
    reporter.report(queueTarget, "notice", "info", {
      persistDedupeKey: "notice",
    });

    assert.strictEqual(dashboard.statusMessages.length, 2);
    assert.strictEqual(history.statusMessages.length, 1);
  });

  test("catches a rejected persist without throwing from report", async () => {
    const history = new HistoryManagerDouble();
    history.rejectWrites = true;
    const reporter = new StatusMessageReporter(
      () => undefined,
      () => ({ filePath: "run/events.jsonl", manager: history })
    );

    assert.doesNotThrow(() =>
      reporter.report(queueTarget, "failure", "error")
    );
    await flushPromises();
  });

  test("resetDedupeState allows both effects to fire again", () => {
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => ({ filePath: "run/events.jsonl", manager: history })
    );
    const options = {
      liveDedupeKey: "notice",
      persistDedupeKey: "notice",
    };

    reporter.report(queueTarget, "notice", "info", options);
    reporter.report(queueTarget, "notice", "info", options);
    reporter.resetDedupeState();
    reporter.report(queueTarget, "notice", "info", options);

    assert.strictEqual(dashboard.statusMessages.length, 2);
    assert.strictEqual(history.statusMessages.length, 2);
  });

  test("encodes finalStep targets as negative signed indices", () => {
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const reporter = new StatusMessageReporter(
      () => dashboard,
      () => ({ filePath: "run/events.jsonl", manager: history })
    );

    reporter.report(finalStepTarget, "loop failure", "error", {
      timestampMs: 456,
    });

    assert.strictEqual(dashboard.statusMessages[0].stepIndex, -4);
    assert.deepStrictEqual(history.statusMessages[0].target, finalStepTarget);
  });

  test("notifies with the original target shape for queue and finalStep", () => {
    const notified: Array<{
      target: WorkflowEventTarget;
      message: string;
      severity: StatusMessageSeverity;
    }> = [];
    const reporter = new StatusMessageReporter(
      () => undefined,
      () => undefined,
      (target, message, severity) => {
        notified.push({ target, message, severity });
      }
    );

    reporter.report(queueTarget, "queue notice", "warning");
    reporter.report(finalStepTarget, "loop notice", "error");

    assert.deepStrictEqual(notified, [
      { target: queueTarget, message: "queue notice", severity: "warning" },
      { target: finalStepTarget, message: "loop notice", severity: "error" },
    ]);
  });
});
