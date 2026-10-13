import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { buildPriorContextXmlFromItems } from "../../core/HarnessIntegration";
import { PriorContextPreviewBuilder } from "../../utils/PriorContextPreviewBuilder";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { getStepOutputText } from "../../utils/StepOutputText";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  EXECUTION_STATES,
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS,
  CLI_EVENT_TYPES,
  StepOutputTextMode,
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
  const getPriorText = (item: { text?: string; transcript?: Array<{ kind: string; text?: string }> }) =>
    item.text ?? item.transcript?.filter((entry) => entry.kind === PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TEXT).map((entry) => entry.text ?? "").join("");
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

  test("continues a v1 run with v2 output while resolving both record formats", async () => {
    const fixturePath = path.resolve(
      __dirname,
      "../../../src/test/fixtures/formats/timeline/v1/events.jsonl"
    );
    const legacyLine = (await fs.readFile(fixturePath, "utf8"))
      .trim()
      .split(/\r?\n/)[0]
      .replace('"fixture-workflow"', '"resolver-workflow"');
    await fs.writeFile(
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath),
      `${legacyLine}\n`,
      "utf8"
    );
    const legacyManifest = await recorder.readManifest(manifestPath);
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...legacyManifest,
        schemaVersion: 1,
        eventCount: 1,
        nextSequence: 2,
      }),
      "utf8"
    );

    const resolver = new RunOutputResolver(recorder);
    const legacyAttempt = await resolver.resolveAttempt(
      manifestPath,
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      0,
      0
    );
    assert.strictEqual(
      getStepOutputText({ output: legacyAttempt?.output }, StepOutputTextMode.TRANSCRIPT),
      "AI legacy text"
    );

    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            structured: {
              events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "v2 text" } }],
              metadata: {},
            },
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
    ]);

    const mixedAttempts = await resolver.resolveLatestAttempts(manifestPath, [
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
    ]);
    assert.strictEqual(
      getStepOutputText(
        { output: mixedAttempts.get("queue:0")?.output },
        StepOutputTextMode.TRANSCRIPT
      ),
      "AI legacy text"
    );
    assert.strictEqual(
      getStepOutputText(
        { output: mixedAttempts.get("queue:1")?.output },
        StepOutputTextMode.TRANSCRIPT
      ),
      "v2 text"
    );
    assert.strictEqual(
      (await recorder.readManifest(manifestPath)).schemaVersion,
      2
    );
    const storedEvents = await recorder.readEvents(manifestPath);
    const appendedOutput = storedEvents[1];
    assert.ok(appendedOutput?.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED);
    if (appendedOutput?.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
      assert.ok(!("response" in appendedOutput.payload.cliOutput));
      assert.ok(!("prompt" in appendedOutput.payload.cliOutput));
    }
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

            structured: { events: [{ type: "text", data: { text: "original response" } }], metadata: {} },
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

            structured: { events: [{ type: "text", data: { text: "pass" } }], metadata: {} },
            elapsed: 1,
            isStreaming: false,
            source: "script",
            scriptVerdict: {
              compareSource: "stdout",
              operator: "contains",
              expected: "pass",
              actual: "pass",
              exitCode: 0,
              outcome: "passed",
              action: "continue",
              durationMs: 1,
            },
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

            structured: { events: [{ type: "text", data: { text: "partial retry response" } }], metadata: {} },
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

            structured: { events: [{ type: "text", data: { text: "first response" } }], metadata: {} },
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

            structured: { events: [{ type: "text", data: { text: finalResponse } }], metadata: {} },
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
    assert.strictEqual(getStepOutputText({ output: original?.output }, StepOutputTextMode.TRANSCRIPT), "original response");
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
    assert.strictEqual(getStepOutputText({ output: script?.output }, StepOutputTextMode.TRANSCRIPT), "pass");
    assert.strictEqual(script?.terminalState, "failed");

    const retry = await resolver.resolveAttempt(manifestPath, queueZero, 1, 1);
    assert.strictEqual(retry?.prompt, "retry with diagnostics");
    assert.strictEqual(retry?.startReason, "retry");
    assert.strictEqual(getStepOutputText({ output: retry?.output }, StepOutputTextMode.TRANSCRIPT), "partial retry response");
    assert.strictEqual(retry?.terminalState, "stopped");

    const resumedFinal = await resolver.resolveAttempt(
      manifestPath,
      finalLoop,
      0,
      0
    );
    assert.strictEqual(resumedFinal?.startReason, "resumed");
    assert.strictEqual(getStepOutputText({ output: resumedFinal?.output }, StepOutputTextMode.TRANSCRIPT), finalResponse);
    assert.strictEqual(getStepOutputText({ output: resumedFinal?.output }, StepOutputTextMode.TRANSCRIPT), finalResponse);
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
      getStepOutputText({ output: latest.get("queue:0")?.output }, StepOutputTextMode.TRANSCRIPT),
      "partial retry response",
      "read-output and active restore use the latest run/attempt for a target"
    );
    const priorItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["all", "finalStepAll"],
      revisionTwo.steps,
      2,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      priorItems.map(getPriorText),
      ["partial retry response", "pass\n0", finalResponse],
      "prior context is resolved from timeline attempts, including scripts and final loops"
    );
    assert.strictEqual(
      priorItems[1].scriptVerdict?.outcome,
      "passed",
      "a script step's prior-context item carries its verdict"
    );
    const lastOneItems = await resolver.resolvePriorContextItems(
      manifestPath,
      [{ previous: 1 }],
      revisionTwo.steps,
      2,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      lastOneItems.map(getPriorText),
      ["pass\n0"],
      "{ previous: 1 } selects the same output as the previous keyword"
    );
    const lastNItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["previous", { previous: 5 }],
      revisionTwo.steps,
      2,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      lastNItems.map(getPriorText),
      ["partial retry response", "pass\n0"],
      "previous selectors merge to the largest N, capped at what exists, oldest first"
    );
    const preview = await PriorContextPreviewBuilder.buildPreview(
      "previous:2",
      2,
      revisionTwo.steps,
      resolver,
      manifestPath,
      { workspaceRoot }
    );
    assert.match(preview, /partial retry response/);
    assert.match(preview, /<stdout>\npass\n<\/stdout>/);
    assert.match(
      preview,
      /<verdict outcome="passed" compareSource="stdout" operator="contains" expected="pass"\/>/
    );
    const groupBoundaryItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["previous", "all", [2]],
      revisionTwo.steps,
      1,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      groupBoundaryItems.map(getPriorText),
      ["partial retry response"],
      "previous/all stop at the group start and numeric same-group references are excluded"
    );
    const indexZeroItems = await resolver.resolvePriorContextItems(
      manifestPath,
      ["previous", "all", [1]],
      revisionTwo.steps,
      0,
      { workspaceRoot }
    );
    assert.deepStrictEqual(indexZeroItems, []);
  });

  test("projects structured transcripts and earlier-attempt file changes into injection and preview", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const start = (attemptIndex: number, prompt: string): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
      timestampMs: 10 + attemptIndex,
      target,
      runIndex: 0,
      attemptIndex,
      definitionRevision: 1,
      payload: { kind: "ai", startReason: attemptIndex ? "retry" : "initial", prompt },
    });
    const output = (attemptIndex: number, events: CliEvent[]): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs: 20 + attemptIndex,
      target,
      runIndex: 0,
      attemptIndex,
      definitionRevision: 1,
      responseKind: "ai",
      payload: { cliOutput: {  elapsed: 1, isStreaming: false, structured: { events, metadata: {} } } },
    });
    await recorder.appendEvents(manifestPath, [
      start(0, "first prompt"),
      output(0, [{ type: CLI_EVENT_TYPES.FILE_EDIT, data: { path: "src/old.ts", oldContent: "one\n", newContent: "two\nthree\n" } }]),
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 30, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { terminalState: "failed" } },
      start(1, "latest prompt"),
      output(1, [{ type: CLI_EVENT_TYPES.THINKING, data: { text: "reasoning" } }, { type: CLI_EVENT_TYPES.TEXT, data: { text: "latest answer" } }]),
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 40, target, runIndex: 0, attemptIndex: 1, definitionRevision: 1, payload: { terminalState: "completed" } },
    ]);
    const resolver = new RunOutputResolver(recorder);
    const items = await resolver.resolvePriorContextItems(manifestPath, [[1]], revisionOne.steps, 1, { workspaceRoot });
    assert.deepStrictEqual(items[0].transcript?.map((entry) => entry.kind), ["thinking", "text"]);
    assert.strictEqual(items[0].text, undefined, "structured records use transcript entries instead of responseText");
    assert.deepStrictEqual(items[0].earlierAttempts, {
      count: 1,
      filesChanged: [{ path: "src/old.ts", operation: "modified", added: 2, removed: 1 }],
    });
    const injected = buildPriorContextXmlFromItems(items);
    assert.match(injected, /<earlierAttempts count="1">[\s\S]*Edited src\/old\.ts \+2 -1[\s\S]*<\/earlierAttempts>/);
    const preview = await PriorContextPreviewBuilder.buildPreview("step:1", 1, revisionOne.steps, resolver, manifestPath, { workspaceRoot });
    assert.strictEqual(preview, injected);
  });

  test("uses finalStep definition prompts and renders script passes from script output", async () => {
    const promptTarget = { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 } as const;
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        target: promptTarget,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: { kind: "ai", startReason: "initial", prompt: "the authored final prompt" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target: promptTarget,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: { cliOutput: { structured: { events: [{ type: "text", data: { text: "final response" } }], metadata: {} }, elapsed: 1, isStreaming: false } },
      },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 3, target: promptTarget, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { terminalState: "completed" } },
    ]);
    const resolver = new RunOutputResolver(recorder);
    const promptItems = await resolver.resolvePriorContextItems(manifestPath, ["finalStepPrevious"], revisionOne.steps, 1, { workspaceRoot });
    assert.strictEqual(promptItems[0].prompt, "original final step");

    const scriptDefinition: WorkflowDefinitionSnapshot = { ...revisionOne, finalStep: { type: "script", script: "node verify.js" } };
    await recorder.appendEvents(manifestPath, [
      { eventType: TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED, timestampMs: 4, payload: { definitionRevision: 2, priorDefinitionRevision: 1, definition: scriptDefinition } },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED, timestampMs: 5, target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }, runIndex: 0, attemptIndex: 0, definitionRevision: 2, payload: { kind: "script", startReason: "initial", prompt: "node verify.js" } },
      { eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED, timestampMs: 6, target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }, runIndex: 0, attemptIndex: 0, definitionRevision: 2, payload: { command: "node verify.js", stdout: "verified", stderr: "", exitCode: 0 } },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 7, target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }, runIndex: 0, attemptIndex: 0, definitionRevision: 2, payload: { terminalState: "completed" } },
    ]);
    const scriptItems = await resolver.resolvePriorContextItems(manifestPath, ["finalStepAll"], revisionOne.steps, 1, { workspaceRoot });
    assert.strictEqual(scriptItems[1].scriptOutput?.stdout, "verified");
    assert.ok(buildPriorContextXmlFromItems(scriptItems).includes("<command>\nnode verify.js\n</command>"));
    assert.ok(buildPriorContextXmlFromItems(scriptItems).includes('<step index="2" type="finalStep">'));
  });

  test("uses only the addressed run and skips an interrupted-only attempt", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const interruptedTarget = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    await recorder.appendEvents(manifestPath, [
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED, timestampMs: 1, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { kind: "ai", startReason: "initial", prompt: "appended to old run" } },
      { eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED, timestampMs: 2, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, responseKind: "ai", payload: { cliOutput: { structured: { events: [{ type: "text", data: { text: "older run output" } }], metadata: {} }, elapsed: 1, isStreaming: false } } },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 3, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { terminalState: "completed" } },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED, timestampMs: 4, target: interruptedTarget, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { kind: "ai", startReason: "initial", prompt: "interrupted" } },
    ]);
    const resolver = new RunOutputResolver(recorder);
    assert.deepStrictEqual(await resolver.resolvePriorContextItems(manifestPath, ["previous"], revisionOne.steps, 2, { workspaceRoot }).then(items => items.map(getPriorText)), ["older run output"]);
    assert.deepStrictEqual(await resolver.resolvePriorContextItems(manifestPath, [[2]], revisionOne.steps, 2, { workspaceRoot }), []);
    const otherRunDir = path.join(workspaceRoot, "run-newer");
    const otherManifest = await recorder.initializeRunAt(otherRunDir, "resolver-workflow", 2, 1, EXECUTION_STATES.RUNNING, 1, revisionOne);
    await recorder.appendEvents(otherManifest, [
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED, timestampMs: 1, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { kind: "ai", startReason: "initial", prompt: "newer run" } },
      { eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED, timestampMs: 2, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, responseKind: "ai", payload: { cliOutput: { structured: { events: [{ type: "text", data: { text: "newer run output" } }], metadata: {} }, elapsed: 1, isStreaming: false } } },
      { eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED, timestampMs: 3, target, runIndex: 0, attemptIndex: 0, definitionRevision: 1, payload: { terminalState: "completed" } },
    ]);
    assert.deepStrictEqual(await resolver.resolvePriorContextItems(manifestPath, ["previous"], revisionOne.steps, 2, { workspaceRoot }).then(items => items.map(getPriorText)), ["older run output"]);
  });

  test("does not resolve a skipped step's pre-condition output as its response", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        target,
        runIndex: 0,
        attemptIndex: 0,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        definitionRevision: 1,
        payload: {
          kind: "condition",
          startReason: "initial",
          prompt: "check whether to run",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target,
        runIndex: 0,
        attemptIndex: 0,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        definitionRevision: 1,
        responseKind: "condition",
        payload: {
          cliOutput: {

            structured: { events: [{ type: "text", data: { text: "checking before skip" } }], metadata: {} },
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
    ]);

    const resolver = new RunOutputResolver(recorder);
    const attempts = [];
    for await (const event of resolver.streamAttempts(manifestPath)) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        attempts.push(event.attempt);
      }
    }
    assert.strictEqual(getStepOutputText({ output: attempts[0]?.output }, StepOutputTextMode.TRANSCRIPT), "checking before skip");
    assert.strictEqual(attempts[0]?.kind, "condition");
    assert.strictEqual(
      await resolver.resolveAttempt(manifestPath, target, 0, 0),
      undefined,
      "a step-output lookup must not return the condition's attempt"
    );
    assert.strictEqual(
      (await resolver.resolveLatestAttempts(manifestPath, [target])).has(
        "queue:0"
      ),
      false,
      "read_output and prior context must not treat condition output as step output"
    );
    assert.deepStrictEqual(
      await resolver.resolvePriorContextItems(
        manifestPath,
        [[1]],
        [{ prompt: "the step prompt" }],
        1,
        { workspaceRoot }
      ),
      [],
      "a step that never started has no prior-context response"
    );
  });

  test("uses an interrupted step's partial response instead of its pre-condition output", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        target,
        runIndex: 0,
        attemptIndex: 0,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        definitionRevision: 1,
        payload: {
          kind: "condition",
          startReason: "initial",
          prompt: "check before step",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target,
        runIndex: 0,
        attemptIndex: 0,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        definitionRevision: 1,
        responseKind: "condition",
        payload: {
          cliOutput: {

            structured: { events: [{ type: "text", data: { text: "condition output" } }], metadata: {} },
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 3,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          kind: "ai",
          startReason: "initial",
          prompt: "the actual step prompt",
        },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 4,
        target,
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {

            structured: { events: [{ type: "text", data: { text: "partial step response" } }], metadata: {} },
            elapsed: 1,
            isStreaming: true,
          },
        },
      },
    ]);

    const resolver = new RunOutputResolver(recorder);
    const latest = await resolver.resolveLatestAttempts(manifestPath, [target]);
    assert.strictEqual(
      getStepOutputText({ output: latest.get("queue:0")?.output }, StepOutputTextMode.TRANSCRIPT),
      "partial step response"
    );
    assert.strictEqual(latest.get("queue:0")?.prompt, "the actual step prompt");
    assert.strictEqual(
      getStepOutputText({ output: (await resolver.resolveAttempt(manifestPath, target, 0, 0))?.output }, StepOutputTextMode.TRANSCRIPT),
      "partial step response"
    );
    const items = await resolver.resolvePriorContextItems(
      manifestPath,
      [[1]],
      [{ prompt: "the actual step prompt" }],
      1,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      items.map(getPriorText),
      ["partial step response"]
    );
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

            structured: { events: [{ type: "text", data: { text: "" } }], metadata: {} },
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

            structured: { events: [{ type: "text", data: { text: "the answer" } }], metadata: {} },
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
    assert.strictEqual(getStepOutputText({ output: settled[0].attempt.output }, StepOutputTextMode.TRANSCRIPT), "the answer");
    assert.strictEqual(
      getStepOutputText({ output: settled[0].attempt.output }, StepOutputTextMode.TRANSCRIPT).split("the answer").length,
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

            structured: { events: [{ type: "text", data: { text: "" } }], metadata: {} },
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
    assert.strictEqual(
      getStepOutputText(settled[0].attempt, StepOutputTextMode.TRANSCRIPT),
      "partial output",
      "interrupted attempts retain their streamed text in the event projection"
    );
    assert.strictEqual(settled[0].attempt.terminalState, undefined);
  });

  test("preserves recorded response kinds and uses source only for legacy events", async () => {
    const kinds = ["ai", "script", "condition", undefined] as const;
    const targets = kinds.map(
      (_, stepIndex) =>
        ({
          kind: FINAL_STEP_PHASES.QUEUE,
          stepIndex,
        }) as const
    );
    const drafts: WorkflowTimelineEventDraft[] = [];
    for (const [stepIndex, responseKind] of kinds.entries()) {
      const target = targets[stepIndex];
      drafts.push(
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
          timestampMs: stepIndex * 3 + 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: {
            kind: "ai",
            startReason: "initial",
            prompt: `step ${stepIndex}`,
          },
        },
        {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: stepIndex * 3 + 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          ...(responseKind ? { responseKind } : {}),
          payload: {
            cliOutput: {

              structured: { events: [{ type: "text", data: { text: `output ${stepIndex}` } }], metadata: {} },
              elapsed: 1,
              isStreaming: false,
              ...(stepIndex === 3 ? { source: "script" } : {}),
            },
          },
        },
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
          timestampMs: stepIndex * 3 + 3,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: { terminalState: "completed" },
        }
      );
    }
    await recorder.appendEvents(manifestPath, drafts);

    const settled = [];
    for await (const event of new RunOutputResolver(recorder).streamAttempts(
      manifestPath
    )) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        settled.push(event.attempt);
      }
    }

    assert.deepStrictEqual(
      settled.map((attempt) => attempt.kind),
      ["ai", "script", "condition", "script"]
    );
  });

  test("folds a follow-up recorded after run termination into the settled attempt", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const identity = { target, runIndex: 0, attemptIndex: 0 } as const;
    const output = (response: string): WorkflowTimelineEventDraft => ({
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs: 2,
      ...identity,
      definitionRevision: 1,
      responseKind: "ai",
      payload: {
        cliOutput: {
          structured: { events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: response } }], metadata: {} },
          elapsed: 1,
          isStreaming: false,
        },
      },
    });
    // Shape of a real run: the turn ends with a short acknowledgement, the run
    // completes, then a post-completion follow-up in the same session does the
    // actual work and re-records the cumulative aggregate.
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: 1,
        ...identity,
        definitionRevision: 1,
        payload: { kind: "ai", startReason: "initial", prompt: "run it" },
      },
      output("Waiting for the tests."),
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: 3,
        ...identity,
        definitionRevision: 1,
        payload: { terminalState: "completed" },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
        timestampMs: 4,
        payload: { executionState: EXECUTION_STATES.COMPLETED, stepCount: 1 },
      },
      {
        eventType: TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED,
        timestampMs: 5,
        ...identity,
        definitionRevision: 1,
        payload: { responseTextLength: 0, eventCount: 0 },
      },
      output("Waiting for the tests. All passed; committed."),
    ]);

    const resolver = new RunOutputResolver(recorder);
    const settled = [];
    for await (const event of resolver.streamAttempts(manifestPath)) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        settled.push(event);
      }
    }
    assert.deepStrictEqual(
      settled.map((event) => [event.continuation, event.unterminated]),
      [
        [false, false],
        [true, false],
      ]
    );

    const expected = "Waiting for the tests. All passed; committed.";
    const latest = (
      await resolver.resolveLatestAttempts(manifestPath, [target])
    ).get("queue:0");
    assert.strictEqual(getStepOutputText({ output: latest?.output }, StepOutputTextMode.TRANSCRIPT), expected);
    assert.strictEqual(latest?.prompt, "run it");
    assert.strictEqual(latest?.terminalState, "completed");

    const single = await resolver.resolveAttempt(manifestPath, target, 0, 0);
    assert.strictEqual(getStepOutputText({ output: single?.output }, StepOutputTextMode.TRANSCRIPT), expected);
    assert.strictEqual(single?.prompt, "run it");

    const priorItems = await resolver.resolvePriorContextItems(
      manifestPath,
      [[1]],
      [{ prompt: "run it" }],
      1,
      { workspaceRoot }
    );
    assert.deepStrictEqual(
      priorItems.map(getPriorText),
      [expected]
    );
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
      target: typeof firstTarget | typeof secondTarget
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
      output(firstTarget),
      chunk(firstTarget, "first output"),
      output(secondTarget),
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
      settled.map((event) => getStepOutputText({ output: event.attempt.output }, StepOutputTextMode.TRANSCRIPT)),
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
    const resolvedResponse = getStepOutputText({ output: resolved?.output }, StepOutputTextMode.TRANSCRIPT);
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

              structured: { events: [{ type: "text", data: { text: "initial" } }], metadata: {} },
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

              structured: { events: [{ type: "text", data: { text: "initial follow-up" } }], metadata: {} },
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
      assert.strictEqual(
        getStepOutputText({ output: restored?.output }, StepOutputTextMode.TRANSCRIPT),
        boundary.response ?? ""
      );
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
