import * as assert from "assert";
import { suite, test, setup, teardown } from "mocha";
import {
  setTelemetrySink,
  type TelemetrySink,
} from "../../utils/TelemetryReporter";
import {
  TELEMETRY_EVENTS,
  reportWorkflowStarted,
  reportWorkflowCompleted,
  reportPromptCompleted,
  reportEndConditionEvaluated,
  reportCliNotFound,
  reportExtensionActivationFailed,
  getErrorTypeName,
} from "../../utils/TelemetryEvents";
import { HARNESS_IDS, EXECUTION_MODES } from "../../types/DashboardConstants";

interface RecordedCall {
  method: "sendTelemetryEvent" | "sendTelemetryErrorEvent";
  eventName: string;
  properties?: Record<string, string>;
}

/** Records every call so assertions can inspect event name + properties. */
class FakeTelemetryReporter implements TelemetrySink {
  calls: RecordedCall[] = [];
  throwOnSend = false;

  sendTelemetryEvent(
    eventName: string,
    properties?: Record<string, string>
  ): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.calls.push({ method: "sendTelemetryEvent", eventName, properties });
  }

  sendTelemetryErrorEvent(
    eventName: string,
    properties?: Record<string, string>
  ): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.calls.push({
      method: "sendTelemetryErrorEvent",
      eventName,
      properties,
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

suite("TelemetryEvents", () => {
  let fake: FakeTelemetryReporter;

  setup(() => {
    fake = new FakeTelemetryReporter();
    setTelemetrySink(fake);
  });

  teardown(() => {
    setTelemetrySink(undefined);
  });

  test("reportWorkflowStarted sends stringified properties", () => {
    reportWorkflowStarted({
      harness: HARNESS_IDS.CLAUDE_CLI,
      executionMode: EXECUTION_MODES.INTERACTIVE,
      stepCount: 3,
      hasFinalStep: true,
      hasEndCondition: false,
      resumeSession: false,
      dynamicQueueEnabled: false,
      mcpEnabled: false,
    });

    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(
      fake.calls[0].eventName,
      TELEMETRY_EVENTS.WORKFLOW_STARTED
    );
    assert.deepStrictEqual(fake.calls[0].properties, {
      harness: "claude-cli",
      executionMode: "interactive",
      stepCount: "3",
      hasFinalStep: "true",
      hasEndCondition: "false",
      resumeSession: "false",
      dynamicQueueEnabled: "false",
      mcpEnabled: "false",
    });
  });

  test("reportWorkflowCompleted sends the mapped outcome", () => {
    reportWorkflowCompleted({
      harness: HARNESS_IDS.CODEX_CLI,
      executionMode: EXECUTION_MODES.HEADLESS,
      outcome: "error",
      stepCount: 5,
      totalDurationMs: 42000,
    });

    assert.strictEqual(
      fake.calls[0].eventName,
      TELEMETRY_EVENTS.WORKFLOW_COMPLETED
    );
    assert.strictEqual(fake.calls[0].properties?.outcome, "error");
    assert.strictEqual(fake.calls[0].properties?.totalDurationMs, "42000");
  });

  test("reportPromptCompleted omits failureKind when undefined", () => {
    reportPromptCompleted({
      harness: HARNESS_IDS.CLAUDE_CLI,
      executionMode: EXECUTION_MODES.INTERACTIVE,
      promptIndex: 0,
      durationMs: 14200,
      outcome: "completed",
      endConditionUsed: false,
      resumeSession: false,
      injectMode: false,
    });

    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        fake.calls[0].properties,
        "failureKind"
      ),
      false
    );
  });

  test("reportPromptCompleted includes failureKind when present", () => {
    reportPromptCompleted({
      harness: HARNESS_IDS.CLAUDE_CLI,
      executionMode: EXECUTION_MODES.INTERACTIVE,
      promptIndex: 1,
      durationMs: 500,
      outcome: "failed",
      failureKind: "timeout",
      endConditionUsed: false,
      resumeSession: false,
      injectMode: false,
    });

    assert.strictEqual(fake.calls[0].properties?.failureKind, "timeout");
  });

  test("reportEndConditionEvaluated sends attempt/result/duration", () => {
    reportEndConditionEvaluated({
      harness: HARNESS_IDS.CLAUDE_CLI,
      result: "pass",
      attempt: 1,
      maxRetries: 3,
      durationMs: 850,
    });

    assert.strictEqual(
      fake.calls[0].eventName,
      TELEMETRY_EVENTS.END_CONDITION_EVALUATED
    );
    assert.deepStrictEqual(fake.calls[0].properties, {
      harness: "claude-cli",
      result: "pass",
      attempt: "1",
      maxRetries: "3",
      durationMs: "850",
    });
  });

  test("reportCliNotFound sends the harness id", () => {
    reportCliNotFound(HARNESS_IDS.QWEN_CLI);

    assert.strictEqual(fake.calls[0].eventName, TELEMETRY_EVENTS.CLI_NOT_FOUND);
    assert.deepStrictEqual(fake.calls[0].properties, { harness: "qwen-cli" });
  });

  test("reportExtensionActivationFailed uses sendTelemetryErrorEvent, never the message", () => {
    reportExtensionActivationFailed(
      getErrorTypeName(new TypeError("secret path leaked here"))
    );

    assert.strictEqual(fake.calls[0].method, "sendTelemetryErrorEvent");
    assert.strictEqual(
      fake.calls[0].eventName,
      TELEMETRY_EVENTS.EXTENSION_ACTIVATION_FAILED
    );
    assert.strictEqual(fake.calls[0].properties?.errorType, "TypeError");
    assert.strictEqual(
      Object.values(fake.calls[0].properties ?? {}).some((v) =>
        v.includes("secret path")
      ),
      false
    );
  });

  test("does nothing when no reporter is configured", () => {
    setTelemetrySink(undefined);
    assert.doesNotThrow(() => reportCliNotFound(HARNESS_IDS.CLAUDE_CLI));
    assert.strictEqual(fake.calls.length, 0);
  });

  test("swallows an exception thrown by the underlying reporter", () => {
    fake.throwOnSend = true;
    assert.doesNotThrow(() => reportCliNotFound(HARNESS_IDS.CLAUDE_CLI));
  });
});

suite("getErrorTypeName", () => {
  test("returns the constructor name for Error subclasses", () => {
    assert.strictEqual(getErrorTypeName(new RangeError("x")), "RangeError");
  });

  test("returns typeof for non-Error values", () => {
    assert.strictEqual(getErrorTypeName("boom"), "string");
    assert.strictEqual(getErrorTypeName(42), "number");
  });
});
