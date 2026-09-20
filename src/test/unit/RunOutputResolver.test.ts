import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  EXECUTION_STATES,
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
} from "../../types/DashboardConstants";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_STORAGE_FILES,
  type WorkflowDefinitionSnapshot,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";

suite("RunOutputResolver", () => {
  let workspaceRoot: string;
  let runDirectory: string;
  let manifestPath: string;
  let approvedExternalRoot: string;
  let recorder: TimelineRecorder;

  const revisionOne: WorkflowDefinitionSnapshot = {
    workflowName: "resolver parity",
    steps: [
      { prompt: "original queue prompt" },
      { type: "script", script: "npm test" },
    ],
    parallelGroups: [
      {
        id: "original-group",
        startIndex: 0,
        endIndex: 1,
        failFast: false,
      },
    ],
    finalStep: { prompt: "original final step" },
  };
  const revisionTwo: WorkflowDefinitionSnapshot = {
    workflowName: "resolver parity",
    steps: [
      { prompt: "revised queue prompt" },
      { type: "script", script: "npm test -- --runInBand" },
    ],
    parallelGroups: [
      {
        id: "revised-group",
        startIndex: 0,
        endIndex: 1,
        failFast: true,
      },
    ],
    finalStep: { prompt: "revised final step" },
  };

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-resolver-"));
    approvedExternalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-resolver-external-")
    );
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
    await fs.rm(approvedExternalRoot, { recursive: true, force: true });
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
        phase: EXECUTION_PHASES.PROMPT,
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
    assert.deepStrictEqual(original?.definition?.definition.parallelGroups, [
      {
        id: "original-group",
        startIndex: 0,
        endIndex: 1,
        failFast: false,
      },
    ]);

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
    assert.deepStrictEqual(
      resumedFinal?.definition?.definition.parallelGroups,
      [
        {
          id: "revised-group",
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        },
      ]
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
    const groupBoundaryItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["previous", "all", [2]],
      revisionTwo.steps,
      1
    );
    assert.deepStrictEqual(
      groupBoundaryItems.map((item) => item.text),
      ["partial retry response"],
      "previous/all stop at the group start and numeric same-group references are excluded"
    );
    const indexZeroItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["previous", "all", [1]],
      revisionTwo.steps,
      0
    );
    assert.deepStrictEqual(indexZeroItems, []);
  });

  test("folds streamed deltas and their later aggregate exactly once", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          kind: "ai",
          startReason: "initial",
          prompt: "fold this",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "fold this",
            response: "",
            elapsed: 0,
            isStreaming: true,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
        timestampMs: 3,
        target,
        runIndex: 0,
        attemptIndex: 0,
        payload: { chunk: "the " },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
        timestampMs: 4,
        target,
        runIndex: 0,
        attemptIndex: 0,
        payload: { chunk: "answer" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 5,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "fold this",
            response: "the answer",
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 6,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: { terminalState: "completed" },
      },
    ]);

    const settled = [];
    for await (const event of new RunOutputResolver(recorder).streamAttempts(
      manifestPath
    )) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        settled.push(event);
      }
    }

    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].attempt.responseText, "the answer");
    assert.strictEqual(
      settled[0].attempt.responseText?.split("the answer").length,
      2,
      "the aggregate must supersede the earlier deltas rather than append them"
    );
    assert.strictEqual(settled[0].unterminated, false);
  });

  test("yields unterminated attempts at end-of-stream", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          kind: "ai",
          startReason: "initial",
          prompt: "interrupted",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: "interrupted",
            response: "",
            elapsed: 0,
            isStreaming: true,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
        timestampMs: 3,
        target,
        runIndex: 0,
        attemptIndex: 0,
        payload: { chunk: "partial output" },
      },
    ]);

    const settled = [];
    for await (const event of new RunOutputResolver(recorder).streamAttempts(
      manifestPath
    )) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        settled.push(event);
      }
    }

    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].unterminated, true);
    assert.strictEqual(settled[0].attempt.responseText, "partial output");
    assert.strictEqual(settled[0].attempt.terminalState, undefined);
  });

  test("yields interleaved parallel attempts once in settle order", async () => {
    const firstTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    } as const;
    const secondTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 1,
    } as const;
    const start = (
      target: typeof firstTarget | typeof secondTarget,
      prompt: string
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
      timestampMs: 1,
      target,
      runIndex: 0,
      attemptIndex: 0,
      definitionRevision: 1,
      payload: { kind: "ai", startReason: "initial", prompt },
    });
    const output = (
      target: typeof firstTarget | typeof secondTarget,
      prompt: string
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs: 2,
      target,
      runIndex: 0,
      attemptIndex: 0,
      definitionRevision: 1,
      responseKind: "ai",
      payload: {
        cliOutput: {
          prompt,
          response: "",
          elapsed: 0,
          isStreaming: true,
        },
      },
    });
    const chunk = (
      target: typeof firstTarget | typeof secondTarget,
      value: string
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
      timestampMs: 3,
      target,
      runIndex: 0,
      attemptIndex: 0,
      payload: { chunk: value },
    });
    const terminate = (
      target: typeof firstTarget | typeof secondTarget,
      timestampMs: number
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
      timestampMs,
      target,
      runIndex: 0,
      attemptIndex: 0,
      definitionRevision: 1,
      payload: { terminalState: "completed" },
    });

    await recorder.appendEvents(manifestPath, [
      start(firstTarget, "first"),
      start(secondTarget, "second"),
      output(firstTarget, "first"),
      chunk(firstTarget, "first output"),
      output(secondTarget, "second"),
      chunk(secondTarget, "second output"),
      terminate(secondTarget, 4),
      chunk(firstTarget, " plus more"),
      terminate(firstTarget, 5),
    ]);

    const settled = [];
    for await (const event of new RunOutputResolver(recorder).streamAttempts(
      manifestPath
    )) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        settled.push(event);
      }
    }

    assert.deepStrictEqual(
      settled.map((event) => event.attempt.target),
      [secondTarget, firstTarget]
    );
    assert.deepStrictEqual(
      settled.map((event) => event.attempt.responseText),
      ["second output", "first output plus more"]
    );
    assert.strictEqual(
      new Set(settled.map((event) => event.attempt.runIndex)).size,
      1
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

  test("projects retries, scoped file events, and final loops in one pass", async () => {
    const queueTarget = {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    } as const;
    const finalLoopZero = {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      loopIndex: 0,
    } as const;
    const finalLoopOne = {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      loopIndex: 1,
    } as const;
    const workspaceFile = path.join(workspaceRoot, "src", "index.ts");
    const externalFile = path.join(approvedExternalRoot, "shared.txt");
    const fileEvents = [
      {
        type: "fileWrite" as const,
        data: {
          path: workspaceFile,
          content: "created",
          status: "completed" as const,
          success: true,
        },
      },
      {
        type: "fileEdit" as const,
        data: { path: "src/index.ts", success: true },
      },
      {
        type: "fileDelete" as const,
        data: { path: externalFile, success: true },
      },
      {
        type: "fileWrite" as const,
        data: {
          path: path.join(workspaceRoot, "failed.ts"),
          content: "",
          success: false,
        },
      },
    ];
    const output = (events: typeof fileEvents) => ({
      prompt: "prompt",
      response: "response",
      elapsed: 1,
      isStreaming: false,
      structured: { events, metadata: {} },
    });
    const start = (
      target: typeof queueTarget | typeof finalLoopZero | typeof finalLoopOne,
      runIndex: number,
      attemptIndex: number,
      startReason: "initial" | "retry" | "resumed",
      prompt = "prompt",
      kind: "ai" | "script" = "ai"
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
      timestampMs: runIndex * 100 + attemptIndex,
      target,
      runIndex,
      attemptIndex,
      definitionRevision: 1,
      payload: { kind, startReason, prompt },
    });
    const terminate = (
      target: typeof queueTarget | typeof finalLoopZero | typeof finalLoopOne,
      runIndex: number,
      attemptIndex: number,
      reason?: string
    ): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
      timestampMs: runIndex * 100 + attemptIndex + 50,
      target,
      runIndex,
      attemptIndex,
      definitionRevision: 1,
      payload: { terminalState: "completed", ...(reason ? { reason } : {}) },
    });
    const drafts: WorkflowTimelineEventDraft[] = [
      start(queueTarget, 0, 0, "initial"),
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
        timestampMs: 2,
        target: queueTarget,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: { events: fileEvents },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 3,
        target: queueTarget,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: { cliOutput: output(fileEvents) },
      },
      terminate(queueTarget, 0, 0, "initial complete"),
      start(queueTarget, 0, 1, "retry", "retry prompt"),
      terminate(queueTarget, 0, 1, "retry complete"),
      start(queueTarget, 1, 0, "resumed", "resumed prompt"),
      terminate(queueTarget, 1, 0, "latest terminal reason"),
      start(finalLoopZero, 0, 0, "initial"),
      terminate(finalLoopZero, 0, 0),
      start(finalLoopOne, 0, 0, "initial", "node check.js", "script"),
      {
        eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
        timestampMs: 12,
        target: finalLoopOne,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          command: "node check.js",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
        },
      },
      terminate(finalLoopOne, 0, 0),
    ];
    await recorder.appendEvents(manifestPath, drafts);

    class CountingRecorder extends TimelineRecorder {
      manifestReads = 0;
      streamReads = 0;

      override async readManifest(
        sourceManifestPath: string
      ): Promise<WorkflowRunManifest> {
        this.manifestReads++;
        return super.readManifest(sourceManifestPath);
      }

      override async *streamEvents(
        sourceManifestPath: string
      ): AsyncGenerator<WorkflowTimelineEvent, void, undefined> {
        this.streamReads++;
        yield* super.streamEvents(sourceManifestPath);
      }
    }

    const countingRecorder = new CountingRecorder();
    const projection = await new RunOutputResolver(
      countingRecorder
    ).resolveAttemptProjection(
      manifestPath,
      [queueTarget],
      [finalLoopZero, finalLoopOne],
      {
        workspaceRoot,
        approvedExternalRoots: [approvedExternalRoot],
      }
    );
    const queueProjection = projection.targets.get("queue:0");
    assert.strictEqual(countingRecorder.manifestReads, 1);
    assert.strictEqual(countingRecorder.streamReads, 1);
    assert.strictEqual(queueProjection?.attempts, 3);
    assert.deepStrictEqual(queueProjection?.latestAttempt, {
      number: 3,
      startReason: "resumed",
      terminalState: "completed",
      terminalReason: "latest terminal reason",
    });
    assert.deepStrictEqual(queueProjection?.filesChanged, [
      {
        path: "src/index.ts",
        scope: "workspace",
        operations: ["created", "modified"],
      },
      {
        path: externalFile,
        scope: "external",
        operations: ["deleted"],
      },
    ]);
    assert.strictEqual(projection.finalStep?.loopCount, 2);
    assert.strictEqual(projection.finalStep?.attempts, 2);
    assert.strictEqual(
      projection.finalStep?.latestLoop?.target.kind,
      "finalStep"
    );
    assert.strictEqual(
      projection.finalStep?.latestLoop?.target.kind === "finalStep"
        ? projection.finalStep.latestLoop.target.loopIndex
        : undefined,
      1
    );
    assert.deepStrictEqual(projection.finalStep?.latestLoop?.scriptOutput, {
      command: "node check.js",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
  });

  test("returns empty projections when the manifest or history cannot be read", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const projection = await new RunOutputResolver().resolveAttemptProjection(
      path.join(runDirectory, "missing-manifest.json"),
      [target],
      [],
      { workspaceRoot }
    );
    assert.strictEqual(projection.targets.get("queue:0")?.attempts, 0);
    assert.deepStrictEqual(projection.targets.get("queue:0")?.filesChanged, []);
  });
});
