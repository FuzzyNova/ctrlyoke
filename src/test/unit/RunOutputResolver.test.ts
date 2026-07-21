import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_STORAGE_FILES,
  type WorkflowDefinitionSnapshot,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";

suite("RunOutputResolver", () => {
  let workspaceRoot: string;
  let runDirectory: string;
  let manifestPath: string;
  let recorder: TimelineRecorder;

  const revisionOne: WorkflowDefinitionSnapshot = {
    workflowName: "resolver parity",
    steps: [
      { prompt: "original queue prompt" },
      { type: "script", script: "npm test" },
    ],
    finalStep: { prompt: "original final step" },
  };
  const revisionTwo: WorkflowDefinitionSnapshot = {
    workflowName: "resolver parity",
    steps: [
      { prompt: "revised queue prompt" },
      { type: "script", script: "npm test -- --runInBand" },
    ],
    finalStep: { prompt: "revised final step" },
  };

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-resolver-"));
    runDirectory = path.join(workspaceRoot, "run-2026-07-20T00-00-00-000Z");
    recorder = new TimelineRecorder();
    manifestPath = await recorder.initializeRunAt(
      runDirectory,
      "resolver-workflow",
      1,
      1,
      EXECUTION_STATES.RUNNING,
      1,
      revisionOne
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("reconstructs runtime response, prior-context, preview, script, retry, resumed, and terminal values", async () => {
    const queueZero = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const queueScript = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 1,
    } as const;
    const finalLoop = {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      loopIndex: 3,
    } as const;
    const followUp = "follow-up ".repeat(64 * 1024);
    const finalResponse = `first response${followUp}`;
    const drafts: WorkflowTimelineEventDraft[] = [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 100,
        target: queueZero,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          kind: "ai",
          startReason: "initial",
          prompt: "original queue prompt",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 101,
        target: queueZero,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "original queue prompt",
            response: "original response",
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 102,
        target: queueZero,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: { terminalState: "completed" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        timestampMs: 102,
        payload: {
          transition: {
            command: "pause",
            previous: {
              status: EXECUTION_STATES.RUNNING,
              stopped: false,
              totalPausedDuration: 0,
            },
            current: {
              status: EXECUTION_STATES.PAUSED,
              stopped: false,
              totalPausedDuration: 0,
            },
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        timestampMs: 103,
        payload: {
          transition: {
            command: "resume",
            previous: {
              status: EXECUTION_STATES.PAUSED,
              stopped: false,
              totalPausedDuration: 0,
            },
            current: {
              status: EXECUTION_STATES.RUNNING,
              stopped: false,
              totalPausedDuration: 0,
            },
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED,
        timestampMs: 104,
        payload: {
          definitionRevision: 2,
          priorDefinitionRevision: 1,
          definition: revisionTwo,
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 104,
        target: queueScript,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: {
          kind: "script",
          startReason: "initial",
          prompt: "npm test -- --runInBand",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
        timestampMs: 105,
        target: queueScript,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: {
          command: "npm test -- --runInBand",
          stdout: "pass",
          stderr: "",
          exitCode: 0,
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 106,
        target: queueScript,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        responseKind: "script",
        payload: {
          cliOutput: {
            prompt: "npm test -- --runInBand",
            response: "pass",
            elapsed: 1,
            isStreaming: false,
            source: "script",
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 107,
        target: queueScript,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: { terminalState: "failed", reason: "script stopped workflow" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 108,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: {
          kind: "ai",
          startReason: "initial",
          prompt: "revised queue prompt",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 109,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: { terminalState: "failed", reason: "first retry failed" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.RETRY_SCHEDULED,
        timestampMs: 110,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 1,
        definitionRevision: 2,
        payload: {
          previousAttemptIndex: 0,
          retryPrompt: "retry with diagnostics",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 111,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 1,
        definitionRevision: 2,
        payload: {
          kind: "ai",
          startReason: "retry",
          prompt: "retry with diagnostics",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 112,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 1,
        definitionRevision: 2,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "retry with diagnostics",
            response: "partial retry response",
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 113,
        target: queueZero,
        runIndex: 1,
        attemptIndex: 1,
        definitionRevision: 2,
        payload: { terminalState: "stopped" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 114,
        target: finalLoop,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: {
          kind: "ai",
          startReason: "resumed",
          prompt: "revised final step",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 115,
        target: finalLoop,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "revised final step",
            response: "first response",
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 116,
        target: finalLoop,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: { terminalState: "cancelled", reason: "pause and restart" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED,
        timestampMs: 117,
        target: finalLoop,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        payload: { responseTextLength: followUp.length, eventCount: 1 },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 118,
        target: finalLoop,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 2,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "revised final step",
            response: finalResponse,
            elapsed: 2,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
        timestampMs: 119,
        payload: { executionState: EXECUTION_STATES.STOPPED, stepCount: 2 },
      },
    ];
    await recorder.appendEvents(manifestPath, drafts);

    const resolver = new RunOutputResolver(recorder);
    const streamedKinds: string[] = [];
    for await (const event of resolver.stream(manifestPath)) {
      streamedKinds.push(event.kind);
    }
    assert.deepStrictEqual(streamedKinds, [
      "attemptStarted",
      "output",
      "attemptTerminated",
      "runtimeTransition",
      "runtimeTransition",
      "attemptStarted",
      "scriptExecution",
      "output",
      "attemptTerminated",
      "attemptStarted",
      "attemptTerminated",
      "retryScheduled",
      "attemptStarted",
      "output",
      "attemptTerminated",
      "attemptStarted",
      "output",
      "attemptTerminated",
      "followUpResponseAppended",
      "output",
      "runTerminated",
    ]);

    const original = await resolver.resolveAttempt(
      manifestPath,
      queueZero,
      0,
      0
    );
    assert.strictEqual(original?.responseText, "original response");
    assert.strictEqual(original?.definition?.definitionRevision, 1);
    assert.strictEqual(
      (original?.definition?.step as { prompt?: string }).prompt,
      "original queue prompt"
    );

    const script = await resolver.resolveAttempt(
      manifestPath,
      queueScript,
      0,
      0
    );
    assert.deepStrictEqual(script?.scriptOutput, {
      command: "npm test -- --runInBand",
      stdout: "pass",
      stderr: "",
      exitCode: 0,
    });
    assert.strictEqual(script?.responseText, "pass");
    assert.strictEqual(script?.terminalState, "failed");

    const retry = await resolver.resolveAttempt(manifestPath, queueZero, 1, 1);
    assert.strictEqual(retry?.prompt, "retry with diagnostics");
    assert.strictEqual(retry?.startReason, "retry");
    assert.strictEqual(retry?.responseText, "partial retry response");
    assert.strictEqual(retry?.terminalState, "stopped");

    const resumedFinal = await resolver.resolveAttempt(
      manifestPath,
      finalLoop,
      0,
      0
    );
    assert.strictEqual(resumedFinal?.startReason, "resumed");
    assert.strictEqual(resumedFinal?.responseText, finalResponse);
    assert.strictEqual(resumedFinal?.output?.response, finalResponse);
    assert.strictEqual(resumedFinal?.terminalState, "cancelled");
    assert.strictEqual(resumedFinal?.definition?.definitionRevision, 2);
    assert.strictEqual(
      (resumedFinal?.definition?.step as { prompt?: string }).prompt,
      "revised final step"
    );

    const latest = await resolver.resolveLatestAttempts(manifestPath, [
      queueZero,
      queueScript,
    ]);
    assert.strictEqual(
      latest.get("queue:0")?.responseText,
      "partial retry response",
      "read-output and active restore use the latest run/attempt for a target"
    );
    const priorItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["all", "finalStepAll"],
      revisionTwo.steps,
      2
    );
    assert.deepStrictEqual(
      priorItems.map((item) => item.text),
      ["partial retry response", "pass\n0", finalResponse],
      "prior context is resolved from timeline attempts, including scripts and final loops"
    );
  });

  test("streams very large logs without readEvents or response truncation", async () => {
    const eventCount = 65_536;
    const response = "x".repeat(1024 * 1024);
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const eventsPath = path.join(runDirectory, TIMELINE_STORAGE_FILES.EVENTS);
    const lines: string[] = [];
    for (let index = 0; index < eventCount; index++) {
      lines.push(
        JSON.stringify({
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
          timestampMs: eventCount - index,
          workflowId: "resolver-workflow",
          runId: 1,
          sequence: index + 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          payload: { chunk: "a" },
        })
      );
    }
    lines.push(
      JSON.stringify({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 0,
        workflowId: "resolver-workflow",
        runId: 1,
        sequence: eventCount + 1,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "large",
            response,
            elapsed: 1,
            isStreaming: false,
          },
        },
      })
    );
    await fs.writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");

    class StreamingOnlyRecorder extends TimelineRecorder {
      override async readEvents(): Promise<never> {
        throw new Error("RunOutputResolver must stream events instead");
      }
    }
    const resolver = new RunOutputResolver(new StreamingOnlyRecorder());
    let chunks = 0;
    let lastSequenceKind = "";
    for await (const event of resolver.stream(manifestPath)) {
      chunks += event.kind === "streamingChunk" ? 1 : 0;
      lastSequenceKind = event.kind;
    }
    assert.strictEqual(chunks, eventCount);
    assert.strictEqual(
      lastSequenceKind,
      "output",
      "append order must win over timestamps"
    );

    const resolved = await resolver.resolveAttempt(manifestPath, target, 0, 0);
    const resolvedResponse = resolved?.responseText;
    assert.strictEqual(resolvedResponse?.length, response.length);
    assert.strictEqual(resolvedResponse, response);
  });

  test("reconstructs exactly after restart at every response persistence boundary", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const boundaries: Array<{
      draft: WorkflowTimelineEventDraft;
      response: string | undefined;
      terminal?: string;
    }> = [
      {
        draft: {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
          timestampMs: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: { kind: "ai", startReason: "initial", prompt: "recover" },
        },
        response: undefined,
      },
      {
        draft: {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          responseKind: "ai",
          payload: {
            cliOutput: {
              prompt: "recover",
              response: "initial",
              elapsed: 1,
              isStreaming: false,
            },
          },
        },
        response: "initial",
      },
      {
        draft: {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
          timestampMs: 3,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: { terminalState: "cancelled", reason: "restart" },
        },
        response: "initial",
        terminal: "cancelled",
      },
      {
        draft: {
          eventType: TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED,
          timestampMs: 4,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: { responseTextLength: 8, eventCount: 1 },
        },
        response: "initial",
        terminal: "cancelled",
      },
      {
        draft: {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: 5,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          responseKind: "ai",
          payload: {
            cliOutput: {
              prompt: "recover",
              response: "initial follow-up",
              elapsed: 2,
              isStreaming: false,
            },
          },
        },
        response: "initial follow-up",
        terminal: "cancelled",
      },
    ];

    for (const boundary of boundaries) {
      await recorder.appendEvents(manifestPath, [boundary.draft]);
      // A new resolver represents a process restart; it has no cache from the
      // preceding iteration and can only use the committed timeline prefix.
      const restored = await new RunOutputResolver(recorder).resolveAttempt(
        manifestPath,
        target,
        0,
        0
      );
      assert.strictEqual(restored?.responseText, boundary.response);
      assert.strictEqual(restored?.terminalState, boundary.terminal);
    }
  });
});
