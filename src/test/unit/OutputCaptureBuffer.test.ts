import * as assert from "assert";
import { suite, test } from "mocha";
import {
  OutputCaptureBuffer,
  type OutputCaptureCallbacks,
  type PromptStartData,
  type PromptCompleteData,
} from "../../flightpath/OutputCaptureBuffer";
import { EXECUTION_STATES } from "../../types/FlightPathTypes";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import type { PromptStep } from "../../types/FlightPathTypes";

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeCallbacks(overrides?: Partial<OutputCaptureCallbacks>): {
  callbacks: OutputCaptureCallbacks;
  promptStarts: PromptStartData[];
  promptCompletes: PromptCompleteData[];
  statusMessages: Array<{
    stepIndex: number;
    message: string;
    severity: string;
  }>;
} {
  const promptStarts: PromptStartData[] = [];
  const promptCompletes: PromptCompleteData[] = [];
  const statusMessages: Array<{
    stepIndex: number;
    message: string;
    severity: string;
  }> = [];

  const callbacks: OutputCaptureCallbacks = {
    onPromptStart: (data) => promptStarts.push(data),
    onPromptComplete: (data) => promptCompletes.push(data),
    onStatusMessage: (stepIndex, message, severity) =>
      statusMessages.push({ stepIndex, message, severity }),
    getWorkflowStep: () => undefined,
    getTotalSteps: () => 3,
    ...overrides,
  };
  return { callbacks, promptStarts, promptCompletes, statusMessages };
}

/** Minimal mock dashboard sink that records calls. */
function makeDashboardSink(): {
  sink: IDashboardSink & {
    updateStatusMessage: (
      stepIndex: number,
      message: string,
      severity?: string
    ) => void;
  };
  calls: Array<{ method: string; args: any[] }>;
} {
  const calls: Array<{ method: string; args: any[] }> = [];
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      return (...args: any[]) => {
        calls.push({ method: String(prop), args });
      };
    },
  };
  return {
    sink: new Proxy({}, handler) as any,
    calls,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite("OutputCaptureBuffer", () => {
  suite("construction", () => {
    test("should create with default empty buffers", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("test-tag", callbacks);
      assert.strictEqual(buffer.stepBufferSize, 0);
      assert.strictEqual(buffer.finalStepBufferSize, 0);
    });
  });

  suite("captureOutputInit", () => {
    test("should store initialization data and fire onPromptStart", () => {
      const { callbacks, promptStarts } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "Do something",
        "copilot --prompt",
        undefined,
        "/ws",
        1000,
        0,
        false
      );

      assert.strictEqual(buffer.stepBufferSize, 1);
      assert.strictEqual(promptStarts.length, 1);
      assert.strictEqual(promptStarts[0].stepIndex, 0);
      assert.strictEqual(promptStarts[0].promptText, "Do something");
      assert.strictEqual(promptStarts[0].cliCommand, "copilot --prompt");
      assert.strictEqual(promptStarts[0].attemptIndex, 0);
      assert.strictEqual(promptStarts[0].totalSteps, 3);
    });

    test("should preserve accumulated text/events across double-init (cliCommand update)", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      // First init (cliCommand undefined)
      buffer.captureOutputInit(
        0,
        "prompt",
        undefined,
        undefined,
        "/ws",
        1000,
        0,
        false
      );
      // Accumulate some data
      buffer.captureChunk(0, "partial response");
      // Second init (cliCommand populated)
      buffer.captureOutputInit(
        0,
        "prompt",
        "copilot --prompt foo",
        undefined,
        "/ws",
        1000,
        0,
        false
      );

      // Verify accumulated text was preserved
      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 0 },
        null,
        "tag"
      );
      const streamingOutput = calls.find(
        (c) =>
          c.method === "updateCliOutput" &&
          c.args[0] === 0 &&
          c.args[1]?.isStreaming
      );
      assert.ok(streamingOutput, "should have streaming output");
      assert.strictEqual(
        streamingOutput!.args[1].cliCommand,
        "copilot --prompt foo"
      );
      const chunkCall = calls.find(
        (c) => c.method === "updateCliStreamingChunk"
      );
      assert.ok(chunkCall);
      assert.strictEqual(chunkCall!.args[1], "partial response");
    });

    test("should fire onPromptStart with correct totalSteps from callback", () => {
      const { callbacks, promptStarts } = makeCallbacks({
        getTotalSteps: () => 7,
      });
      const buffer = new OutputCaptureBuffer("tag", callbacks);
      buffer.captureOutputInit(
        2,
        "step 3",
        undefined,
        undefined,
        undefined,
        500,
        0,
        undefined
      );
      assert.strictEqual(promptStarts[0].totalSteps, 7);
    });
  });

  suite("captureChunk", () => {
    test("should accumulate text chunks for a step", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "prompt",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      buffer.captureChunk(0, "hello ");
      buffer.captureChunk(0, "world");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 0 },
        null,
        "tag"
      );
      const chunkCall = calls.find(
        (c) => c.method === "updateCliStreamingChunk"
      );
      assert.ok(chunkCall);
      assert.strictEqual(chunkCall!.args[1], "hello world");
    });

    test("should be a no-op if step was never initialized", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      // No init for step 5
      buffer.captureChunk(5, "orphan data");
      assert.strictEqual(buffer.stepBufferSize, 0);
    });
  });

  suite("captureEvents", () => {
    test("should accumulate events for a step", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "prompt",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      const event1 = { type: "tool_call", name: "bash" } as unknown as CliEvent;
      const event2 = {
        type: "tool_result",
        name: "bash",
      } as unknown as CliEvent;
      buffer.captureEvents(0, [event1]);
      buffer.captureEvents(0, [event2]);

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 0 },
        null,
        "tag"
      );
      const eventsCall = calls.find(
        (c) => c.method === "updateCliStreamingEvents"
      );
      assert.ok(eventsCall);
      assert.strictEqual(eventsCall!.args[1].length, 2);
    });

    test("should be a no-op if step was never initialized", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);
      buffer.captureEvents(99, [{ type: "tool_call" } as unknown as CliEvent]);
      assert.strictEqual(buffer.stepBufferSize, 0);
    });
  });

  suite("getBufferedOutput", () => {
    test("should materialize in-flight output for stop persistence", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);
      const event = {
        type: "text",
        data: { text: "structured partial" },
      } as unknown as CliEvent;

      buffer.captureOutputInit(
        0,
        "prompt",
        "codex exec",
        undefined,
        "/workspace",
        100,
        0,
        false
      );
      buffer.captureChunk(0, "partial text");
      buffer.captureEvents(0, [event]);

      const output = buffer.getBufferedOutput(0);

      assert.ok(output);
      assert.strictEqual(output.prompt, "prompt");
      assert.strictEqual(output.response, "partial text");
      assert.strictEqual(output.isStreaming, false);
      assert.strictEqual(output.cliCommand, "codex exec");
      assert.strictEqual(output.workingDirectory, "/workspace");
      assert.strictEqual(output.timestampMs, 100);
      assert.deepStrictEqual(output.structured?.events, [event]);
    });
  });

  suite("captureCompletedOutput", () => {
    test("should store final output and fire onPromptComplete", () => {
      const { callbacks, promptCompletes } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "prompt",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      buffer.captureCompletedOutput(0, {
        response: "done",
        tokens: { prompt: 100, completion: 50 },
        elapsed: 2.5,
        structured: {
          metadata: { sessionId: "sess-1", harness: "copilot-cli" },
        },
      });

      assert.strictEqual(
        buffer.stepBufferSize,
        0,
        "streaming buffer should be cleared"
      );
      assert.strictEqual(promptCompletes.length, 1);
      assert.strictEqual(promptCompletes[0].stepIndex, 0);
      assert.strictEqual(promptCompletes[0].tokens?.prompt, 100);
      assert.strictEqual(promptCompletes[0].sessionId, "sess-1");
      assert.strictEqual(promptCompletes[0].harness, "copilot-cli");
      assert.strictEqual(promptCompletes[0].elapsed, 2.5);
    });

    test("should accumulate multiple attempts for retries", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureCompletedOutput(0, {
        response: "attempt 0",
        attemptIndex: 0,
      });
      buffer.captureCompletedOutput(0, {
        response: "attempt 1",
        attemptIndex: 1,
      });

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );
      const outputCalls = calls.filter((c) => c.method === "updateCliOutput");
      assert.strictEqual(outputCalls.length, 2, "should replay both attempts");
    });

    test("should set retryState when attemptIndex > 0", () => {
      const promptStep: Partial<PromptStep> = {
        endCondition: { maxRetries: 3 } as any,
      };
      const { callbacks } = makeCallbacks({
        getWorkflowStep: () => promptStep as PromptStep,
      });
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureCompletedOutput(0, { response: "r0", attemptIndex: 0 });
      buffer.captureCompletedOutput(0, { response: "r1", attemptIndex: 1 });

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );
      const retryCalls = calls.filter((c) => c.method === "updateRetryAttempt");
      assert.ok(retryCalls.length > 0, "should replay retry state");
      assert.strictEqual(retryCalls[0].args[1], 1); // currentRetry
      assert.strictEqual(retryCalls[0].args[2], 3); // maxRetries
    });

    test("should remove step from streaming buffer after completion", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "p",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      assert.strictEqual(buffer.stepBufferSize, 1);

      buffer.captureCompletedOutput(0, { response: "done" });
      assert.strictEqual(buffer.stepBufferSize, 0);
    });
  });

  suite("finalStep capture", () => {
    test("should buffer finalStep init and chunks", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureFinalStepOutputInit(
        0,
        "final q",
        "cmd",
        undefined,
        "/ws",
        999,
        0,
        false
      );
      buffer.captureFinalStepChunk(0, "response chunk");

      assert.strictEqual(buffer.finalStepBufferSize, 1);
    });

    test("should accumulate finalStep events", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureFinalStepOutputInit(
        0,
        "q",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      buffer.captureFinalStepEvents(0, [
        { type: "tool_call" } as unknown as CliEvent,
      ]);
      buffer.captureFinalStepEvents(0, [
        { type: "tool_result" } as unknown as CliEvent,
      ]);

      assert.strictEqual(buffer.finalStepBufferSize, 1);
    });

    test("should store finalStep completed output and remove from streaming buffer", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureFinalStepOutputInit(
        0,
        "q",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      assert.strictEqual(buffer.finalStepBufferSize, 1);

      buffer.captureFinalStepCompletedOutput(0, { response: "final done" });
      assert.strictEqual(
        buffer.finalStepBufferSize,
        0,
        "streaming buffer should be cleared"
      );
    });

    test("should accumulate multiple loop completed outputs", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureFinalStepCompletedOutput(0, { response: "loop0" });
      buffer.captureFinalStepCompletedOutput(1, { response: "loop1" });

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );
      const fpCalls = calls.filter((c) => c.method === "updateFinalStepOutput");
      assert.strictEqual(fpCalls.length, 2);
    });
  });

  suite("onFinalStepStatusMessage", () => {
    test("should buffer status messages and fire callback with legacy negative index", () => {
      const { callbacks, statusMessages } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.onFinalStepStatusMessage(0, "Evaluating end condition", "info");
      buffer.onFinalStepStatusMessage(0, "Condition met", "success");

      assert.strictEqual(statusMessages.length, 2);
      // Legacy encoding: loop 0 => -(0+1) = -1
      assert.strictEqual(statusMessages[0].stepIndex, -1);
      assert.strictEqual(statusMessages[0].message, "Evaluating end condition");
      assert.strictEqual(statusMessages[1].stepIndex, -1);
    });

    test("should use correct legacy index for different loop indices", () => {
      const { callbacks, statusMessages } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.onFinalStepStatusMessage(2, "msg", "info");
      // Legacy encoding: loop 2 => -(2+1) = -3
      assert.strictEqual(statusMessages[0].stepIndex, -3);
    });
  });

  suite("cacheHistoricalStepOutput", () => {
    test("should pre-cache outputs for replay", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.cacheHistoricalStepOutput(0, [{ response: "old" }]);
      buffer.cacheHistoricalStepOutput(1, [{ response: "old2" }]);

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 2 },
        null,
        "tag"
      );
      const outputCalls = calls.filter((c) => c.method === "updateCliOutput");
      assert.strictEqual(outputCalls.length, 2);
    });

    test("should include retryState when provided", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.cacheHistoricalStepOutput(
        0,
        [{ response: "r0" }, { response: "r1" }],
        { currentRetry: 1, maxRetries: 2 }
      );

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 1 },
        null,
        "tag"
      );
      const retryCalls = calls.filter((c) => c.method === "updateRetryAttempt");
      assert.strictEqual(retryCalls.length, 1);
      assert.strictEqual(retryCalls[0].args[1], 1);
      assert.strictEqual(retryCalls[0].args[2], 2);
    });
  });

  suite("clear", () => {
    test("should reset all buffers", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "p",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      buffer.captureCompletedOutput(0, { response: "done" });
      buffer.captureFinalStepOutputInit(
        0,
        "fp",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );

      buffer.clear();

      assert.strictEqual(buffer.stepBufferSize, 0);
      assert.strictEqual(buffer.finalStepBufferSize, 0);

      // Verify completed outputs also cleared
      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );
      const outputCalls = calls.filter((c) => c.method === "updateCliOutput");
      assert.strictEqual(
        outputCalls.length,
        0,
        "no completed outputs after clear"
      );
    });
  });

  suite("replayTo", () => {
    test("should replay nothing when buffer is empty", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);
      const { sink, calls } = makeDashboardSink();

      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );
      assert.strictEqual(calls.length, 0);
    });

    test("should replay completed steps in order", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureCompletedOutput(0, { response: "r0" });
      buffer.captureCompletedOutput(1, { response: "r1" });

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 2 },
        null,
        "tag"
      );

      const outputCalls = calls.filter((c) => c.method === "updateCliOutput");
      assert.strictEqual(outputCalls.length, 2);
      assert.strictEqual(outputCalls[0].args[0], 0);
      assert.strictEqual(outputCalls[1].args[0], 1);
    });

    test("should replay streaming buffer when status is RUNNING and step matches currentIndex", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        2,
        "streaming prompt",
        "cmd",
        undefined,
        "/ws",
        500,
        0,
        true
      );
      buffer.captureChunk(2, "partial ");
      buffer.captureChunk(2, "data");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 2 },
        null,
        "tag"
      );

      const outputCall = calls.find(
        (c) => c.method === "updateCliOutput" && c.args[1]?.isStreaming
      );
      assert.ok(outputCall, "should replay streaming output init");
      assert.strictEqual(outputCall!.args[1].prompt, "streaming prompt");
      assert.strictEqual(outputCall!.args[1].rawTextOutput, true);

      const chunkCall = calls.find(
        (c) => c.method === "updateCliStreamingChunk"
      );
      assert.ok(chunkCall, "should replay accumulated text");
      assert.strictEqual(chunkCall!.args[1], "partial data");
    });

    test("should NOT replay streaming buffer when status is not RUNNING", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureOutputInit(
        0,
        "p",
        undefined,
        undefined,
        undefined,
        100,
        0,
        false
      );
      buffer.captureChunk(0, "data");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.PAUSED, currentIndex: 0 },
        null,
        "tag"
      );

      const streamingCalls = calls.filter(
        (c) => c.method === "updateCliOutput" && c.args[1]?.isStreaming
      );
      assert.strictEqual(streamingCalls.length, 0);
    });

    test("should replay finalStep streaming when phase is FINAL_PROMPT", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.captureFinalStepOutputInit(
        0,
        "final q",
        "cmd",
        undefined,
        "/ws",
        999,
        0,
        false
      );
      buffer.captureFinalStepChunk(0, "fp response");
      buffer.captureFinalStepEvents(0, [
        { type: "tool_call" } as unknown as CliEvent,
      ]);

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 0 },
        { phase: FINAL_STEP_PHASES.FINAL_STEP, loopCount: 0 },
        "tag"
      );

      const fpCall = calls.find((c) => c.method === "updateFinalStepOutput");
      assert.ok(fpCall, "should replay finalStep streaming output");
      assert.strictEqual(fpCall!.args[0], 0); // loopIndex
      assert.strictEqual(fpCall!.args[1].isStreaming, true);
      assert.strictEqual(fpCall!.args[1].response, "fp response");
      assert.ok(fpCall!.args[1].structured?.events?.length === 1);
    });

    test("should replay finalStep status messages", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      buffer.onFinalStepStatusMessage(0, "status msg", "info");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.IDLE, currentIndex: 0 },
        null,
        "tag"
      );

      const statusCalls = calls.filter(
        (c) => c.method === "updateStatusMessage"
      );
      assert.strictEqual(statusCalls.length, 1);
      assert.strictEqual(statusCalls[0].args[0], -1); // legacy index for loop 0
      assert.strictEqual(statusCalls[0].args[1], "status msg");
      assert.strictEqual(statusCalls[0].args[2], "info");
    });

    test("should replay completed + streaming in a multi-step scenario", () => {
      const { callbacks } = makeCallbacks();
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      // Steps 0 and 1 completed
      buffer.captureCompletedOutput(0, { response: "done0" });
      buffer.captureCompletedOutput(1, { response: "done1" });
      // Step 2 still streaming
      buffer.captureOutputInit(
        2,
        "step3",
        "cmd",
        undefined,
        "/ws",
        500,
        0,
        false
      );
      buffer.captureChunk(2, "in progress");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 2 },
        null,
        "tag"
      );

      const completedOutputs = calls.filter(
        (c) => c.method === "updateCliOutput" && !c.args[1]?.isStreaming
      );
      assert.strictEqual(completedOutputs.length, 2);

      const streamingOutput = calls.find(
        (c) => c.method === "updateCliOutput" && c.args[1]?.isStreaming
      );
      assert.ok(streamingOutput);
    });

    test("should send retryState before streaming output when attemptIndex > 0", () => {
      const promptStep: Partial<PromptStep> = {
        endCondition: { maxRetries: 2 } as any,
      };
      const { callbacks } = makeCallbacks({
        getWorkflowStep: () => promptStep as PromptStep,
      });
      const buffer = new OutputCaptureBuffer("tag", callbacks);

      // Step 0 attempt 1 is streaming (retry in progress)
      buffer.captureOutputInit(
        0,
        "retry prompt",
        "cmd",
        undefined,
        "/ws",
        100,
        1,
        false
      );
      buffer.captureChunk(0, "retry response");

      const { sink, calls } = makeDashboardSink();
      buffer.replayTo(
        sink,
        { status: EXECUTION_STATES.RUNNING, currentIndex: 0 },
        null,
        "tag"
      );

      // Verify retryState was sent
      const retryCall = calls.find((c) => c.method === "updateRetryAttempt");
      assert.ok(retryCall, "should send retryState for attemptIndex > 0");
      assert.strictEqual(retryCall!.args[1], 1); // currentRetry
      assert.strictEqual(retryCall!.args[2], 2); // maxRetries
    });
  });
});
