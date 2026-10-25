import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { buildAuthoredWorkflow } from "../../core/WorkflowStepSanitizer";
import { configService } from "../../config/CtrlYokeConfigService";
import {
  exportRunBundle,
  RunBundleExportError,
} from "../../core/orchestration/RunBundleExporter";
import {
  readRunBundle,
  RunBundleFormatError,
} from "../../core/orchestration/RunBundleReader";
import { ReplayIntegrationFactory } from "../../dev/replay/ReplayIntegration";
import { RunReplaySession } from "../../dev/replay/RunReplaySession";
import {
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
  EXECUTION_PHASES,
  EXECUTION_STATES,
  FILE_OPERATION_KINDS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import {
  RUN_BUNDLE_FILES,
  RUN_BUNDLE_KIND,
  RUN_BUNDLE_REDACTION_POLICY,
  RUN_BUNDLE_SCHEMA_VERSION,
  type RunBundleEvent,
  type RunBundleManifest,
} from "../../types/RunBundleTypes";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import { BUNDLE_WORKSPACE_TOKEN } from "../../utils/RunBundlePaths";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { MockPlatform } from "../helpers/mockHarness";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

/**
 * Run replay end to end: a real `WorkflowInstance` runs a run bundle's
 * workflow against `ReplayIntegrationFactory`, so the engine, the end-condition
 * policy and history persistence are all production code and only the
 * harness and script processes are recordings.
 *
 * The bundle's end condition would exit 7 if it ever really ran. The recording
 * says it failed once (exit 1) and passed after a retry (exit 0), so a
 * completed run with a second attempt proves the recording, not a process,
 * decided it.
 */

const NEVER_RUN_CHECK = 'node -e "process.exit(7)"';
/** A harness printing a credential it read; export must not keep it. */
const LEAKED_CREDENTIAL = "sk-test0123456789abcdefghij";
const QUEUE = FINAL_STEP_PHASES.QUEUE;

function queue(stepIndex: number) {
  return { kind: QUEUE, stepIndex } as const;
}

function buildEvents(): RunBundleEvent[] {
  let sequence = 0;
  const at = (timestampMs: number) => ({ timestampMs, sequence: ++sequence });
  const aiStarted = (
    stepIndex: number,
    attemptIndex: number,
    ts: number
  ): RunBundleEvent => ({
    eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
    ...at(ts),
    target: queue(stepIndex),
    runIndex: 0,
    attemptIndex,
    definitionRevision: 1,
    payload: {
      kind: TIMELINE_ATTEMPT_KINDS.AI,
      startReason:
        attemptIndex === 0
          ? TIMELINE_ATTEMPT_START_REASONS.INITIAL
          : TIMELINE_ATTEMPT_START_REASONS.RETRY,
      prompt: `step ${stepIndex + 1}`,
    },
  });
  const streamed = (
    stepIndex: number,
    attemptIndex: number,
    ts: number,
    text: string,
    extra: object[] = []
  ): RunBundleEvent => ({
    eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
    ...at(ts),
    target: queue(stepIndex),
    runIndex: 0,
    attemptIndex,
    payload: {
      events: [
        { type: CLI_EVENT_TYPES.TEXT, timestamp: ts, data: { text } },
        ...(extra as never[]),
      ],
    },
  });
  const sealed = (
    stepIndex: number,
    attemptIndex: number,
    ts: number,
    text: string
  ): RunBundleEvent[] => [
    {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      ...at(ts),
      target: queue(stepIndex),
      runIndex: 0,
      attemptIndex,
      payload: {
        cliOutput: {
          isStreaming: false,
          elapsed: 0.1,
          workingDirectory: BUNDLE_WORKSPACE_TOKEN,
          structured: {
            events: [
              { type: CLI_EVENT_TYPES.TEXT, timestamp: ts, data: { text } },
            ],
            metadata: { sessionId: `session-${stepIndex}` },
          },
        },
      },
    },
    {
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
      ...at(ts),
      target: queue(stepIndex),
      runIndex: 0,
      attemptIndex,
      definitionRevision: 1,
      payload: { terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED },
    },
  ];
  const check = (
    attemptIndex: number,
    ts: number,
    exitCode: number
  ): RunBundleEvent[] => [
    {
      eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
      ...at(ts),
      target: queue(1),
      runIndex: 0,
      attemptIndex,
      phase: EXECUTION_PHASES.END_CONDITION,
      definitionRevision: 1,
      payload: {
        kind: TIMELINE_ATTEMPT_KINDS.CONDITION,
        startReason: TIMELINE_ATTEMPT_START_REASONS.INITIAL,
        prompt: NEVER_RUN_CHECK,
      },
    },
    {
      eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
      ...at(ts + 50),
      target: queue(1),
      runIndex: 0,
      attemptIndex,
      phase: EXECUTION_PHASES.END_CONDITION,
      definitionRevision: 1,
      payload: {
        command: NEVER_RUN_CHECK,
        stdout: `exit ${exitCode}`,
        stderr: "",
        exitCode,
      },
    },
  ];

  return [
    aiStarted(0, 0, 1000),
    streamed(0, 0, 1100, "Hello from the recording", [
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: 1100,
        data: { text: `key ${LEAKED_CREDENTIAL}` },
      },
      {
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp: 1100,
        data: {
          path: `${BUNDLE_WORKSPACE_TOKEN}/notes/plan.md`,
          content: "# plan\n",
        },
      },
    ]),
    ...sealed(0, 0, 1500, "Hello from the recording"),
    aiStarted(1, 0, 2000),
    streamed(1, 0, 2100, "first try"),
    ...sealed(1, 0, 2200, "first try"),
    ...check(0, 2300, 1),
    aiStarted(1, 1, 2500),
    streamed(1, 1, 2600, "fixed it"),
    ...sealed(1, 1, 2700, "fixed it"),
    {
      eventType: TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED,
      ...at(2750),
      target: queue(1),
      payload: {
        workspaceSnapshot: {
          capturedAt: 2750,
          strategy: "filesystem",
          changedFiles: [
            {
              path: "a.txt",
              changeType: FILE_OPERATION_KINDS.MODIFIED,
              beforeContent: "one\n",
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-one", "+two"],
                },
              ],
            },
          ],
        },
      },
    },
    ...check(1, 2800, 0),
  ];
}

async function writeBundle(bundleDir: string): Promise<void> {
  await fs.mkdir(bundleDir, { recursive: true });
  const manifest: RunBundleManifest = {
    schemaVersion: RUN_BUNDLE_SCHEMA_VERSION,
    kind: RUN_BUNDLE_KIND,
    exportedAt: new Date(0).toISOString(),
    exportedByVersion: "test",
    sourceRoot: "~/src/demo",
    lineage: { workflowName: "Replay Test" },
    provenance: {
      workflowKey: "replay-test" as WorkflowKey,
      runRef: "run-1970-01-01T00-00-01-000Z" as RunRef,
      runId: 1,
      steps: [],
    },
    includesSnapshots: true,
    redaction: {
      policy: RUN_BUNDLE_REDACTION_POLICY,
      removedCount: 0,
      byRule: {},
    },
    externalPaths: [],
  };
  const definition = buildAuthoredWorkflow({
    harness: HARNESS_IDS.CLAUDE_CLI,
    executionMode: EXECUTION_MODES.INTERACTIVE,
    steps: [
      { prompt: "step 1" },
      {
        prompt: "step 2",
        endCondition: {
          script: NEVER_RUN_CHECK,
          maxRetries: 1,
          retryPrompt: "try again",
        },
      },
    ],
  });
  await fs.writeFile(
    path.join(bundleDir, RUN_BUNDLE_FILES.BUNDLE),
    JSON.stringify(manifest)
  );
  await fs.writeFile(
    path.join(bundleDir, RUN_BUNDLE_FILES.DEFINITION),
    JSON.stringify(definition)
  );
  await fs.writeFile(
    path.join(bundleDir, RUN_BUNDLE_FILES.MANIFEST),
    JSON.stringify({
      schemaVersion: 2,
      storageKind: "timeline",
      startedAt: 1000,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 2,
      eventCount: 0,
      nextSequence: 0,
      lastUpdatedAt: 3000,
    })
  );
  await fs.writeFile(
    path.join(bundleDir, RUN_BUNDLE_FILES.EVENTS),
    buildEvents()
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n"
  );
}

suite("Run replay (bundle -> live engine)", function () {
  this.timeout(60_000);

  let root: string;
  let workspace: string;
  let instances: WorkflowInstance[] = [];

  setup(async () => {
    root = makeTempDir("ctrlyoke-replay-");
    workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n");
    await writeBundle(path.join(root, "test.ctrlyokerun"));
  });

  teardown(async () => {
    configService.setCliOverlay({});
    for (const instance of instances) {
      await instance.outputHistoryManager.flushPendingIndexRefresh();
      instance.dispose();
    }
    instances = [];
    removeTempDir(root);
  });

  interface Replayed {
    instance: WorkflowInstance;
    events: WorkflowTimelineEvent[];
    session: RunReplaySession;
  }

  async function replay(
    bundleDir = path.join(root, "test.ctrlyokerun"),
    workspaceRoot = workspace
  ): Promise<Replayed> {
    const session = new RunReplaySession({
      bundleDir,
      workspaceRoot,
      speed: 0,
    });
    await session.ready;
    const platform = new MockPlatform(workspaceRoot);
    const factory = new ReplayIntegrationFactory(platform, session);
    const detector = factory.createForExecution(HARNESS_IDS.CLAUDE_CLI);
    const instance = new WorkflowInstance(
      platform,
      undefined,
      factory,
      () => detector,
      () => {},
      () => {},
      workspaceRoot
    );
    instances.push(instance);
    assert.ok(session.workflowFile, "the session materializes the workflow");
    assert.strictEqual(
      await instance.loadPromptFile(session.workflowFile),
      true
    );
    await instance.executeLoadedPromptFile();

    const state = instance.promptQueue.getState();
    assert.ok(
      state.workflowKey && state.runRef,
      "the replay promotes a real run"
    );
    const lines = (
      await fs.readFile(
        WorkflowPaths.eventsPath(
          workspaceRoot,
          state.workflowKey,
          state.runRef
        ),
        "utf8"
      )
    )
      .split("\n")
      .filter(Boolean);
    return {
      instance,
      events: lines.map((line) => JSON.parse(line) as WorkflowTimelineEvent),
      session,
    };
  }

  test("plays the recording through the real engine to the recorded outcome", async () => {
    const { instance, events, session } = await replay();

    assert.strictEqual(
      instance.promptQueue.getState().status,
      EXECUTION_STATES.COMPLETED
    );

    const workflow = JSON.parse(
      await fs.readFile(session.workflowFile!, "utf8")
    );
    assert.strictEqual(
      workflow.executionMode,
      EXECUTION_MODES.HEADLESS,
      "replays run headless"
    );
    assert.ok(session.workflowFile!.endsWith(`replay-test.ctrlyoke.json`));
    assert.strictEqual(
      workflow.name,
      "Replay Test",
      "the recorded workflow's name becomes the file's root name"
    );

    const streamedText = events
      .filter(
        (event) =>
          event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
      )
      .flatMap(
        (event) =>
          (event.payload as { events: Array<{ data: { text?: string } }> })
            .events
      )
      .map((event) => event.data.text)
      .filter(Boolean);
    // The live pipeline may coalesce adjacent text, so check order, not events.
    const transcript = streamedText.join("\n");
    const positions = ["Hello from the recording", "first try", "fixed it"].map(
      (text) => transcript.indexOf(text)
    );
    assert.ok(
      positions.every((position) => position >= 0),
      transcript
    );
    assert.deepStrictEqual(
      [...positions].sort((a, b) => a - b),
      positions
    );

    const scripts = events.filter(
      (event) =>
        event.eventType === TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED
    );
    assert.deepStrictEqual(
      scripts.map((event) => (event.payload as { exitCode?: number }).exitCode),
      [1, 0],
      "end conditions return their recorded results; nothing ran"
    );
    const retried = events.find(
      (event) =>
        event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED &&
        event.attemptIndex === 1 &&
        event.phase === undefined
    );
    assert.ok(retried, "the recorded failure drove a real retry");
  });

  test("streams events larger than the configured whole-file cap", async () => {
    const bundleDir = path.join(root, "large-events.ctrlyokerun");
    await writeBundle(bundleDir);
    const event = { eventType: "large-test-event", text: "x".repeat(4096) };
    await fs.appendFile(
      path.join(bundleDir, RUN_BUNDLE_FILES.EVENTS),
      `${JSON.stringify(event)}\n`
    );
    const loaded = await readRunBundle(bundleDir, workspace, {
      maxBundleFileBytes: 512,
    });
    assert.strictEqual(loaded.events.length, buildEvents().length + 1);
    assert.strictEqual(loaded.events.at(-1)?.eventType, "large-test-event");
  });

  test("rejects an event line larger than the per-line cap", async () => {
    const bundleDir = path.join(root, "oversized-event.ctrlyokerun");
    await writeBundle(bundleDir);
    await fs.appendFile(
      path.join(bundleDir, RUN_BUNDLE_FILES.EVENTS),
      `${JSON.stringify({ text: "x".repeat(256) })}\n`
    );
    await assert.rejects(
      readRunBundle(bundleDir, workspace, { maxEventLineBytes: 128 }),
      (error: unknown) =>
        error instanceof RunBundleFormatError &&
        /events\.jsonl line \d+ exceeds the 128-byte limit/.test(error.message)
    );
  });

  test("puts each attempt's file changes on disk", async () => {
    await replay();
    assert.strictEqual(
      await fs.readFile(path.join(workspace, "a.txt"), "utf8"),
      "two\n"
    );
    assert.strictEqual(
      await fs.readFile(path.join(workspace, "notes", "plan.md"), "utf8"),
      "# plan\n"
    );
  });

  test("exports a replayed run to a portable, redacted bundle that replays again", async () => {
    // Record without live heuristics, so the credential reaches events.jsonl
    // and the export's own redaction is what removes it.
    configService.setCliOverlay({
      permissions: { heuristicSecretRedactionEnabled: false },
    });
    const first = await replay();
    configService.setCliOverlay({});
    const { workflowKey, runRef } = first.instance.promptQueue.getState();
    assert.ok(workflowKey && runRef);

    const exported = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      workflowKey,
      runRef,
      bundleDir: path.join(root, "exported.ctrlyokerun"),
      exportedByVersion: "test",
      includeSnapshots: true,
      homeDir: root,
    });

    const bundleText = (
      await Promise.all(
        Object.values(RUN_BUNDLE_FILES).map((file) =>
          fs.readFile(path.join(exported.bundleDir, file), "utf8")
        )
      )
    ).join("\n");
    for (const spelling of [
      workspace,
      workspace.replace(/\\/g, "/"),
      JSON.stringify(workspace).slice(1, -1),
    ]) {
      assert.ok(
        !bundleText.includes(spelling),
        `the bundle must not name the workspace (${spelling})`
      );
    }
    assert.ok(bundleText.includes(BUNDLE_WORKSPACE_TOKEN));
    assert.ok(
      !bundleText.includes(LEAKED_CREDENTIAL),
      "heuristic redaction removes the credential"
    );
    assert.ok(exported.manifest.redaction.removedCount > 0);
    assert.strictEqual(exported.manifest.provenance.runRef, runRef);
    assert.ok(
      !bundleText.includes(`"_runtime"`),
      "the definition carries no runtime state"
    );
    const exportedDefinition = JSON.parse(
      await fs.readFile(
        path.join(exported.bundleDir, RUN_BUNDLE_FILES.DEFINITION),
        "utf8"
      )
    ) as { name?: string };
    assert.strictEqual(
      exportedDefinition.name,
      "Replay Test",
      "the definition carries the lineage name as its root name"
    );

    const secondWorkspace = path.join(root, "second");
    await fs.mkdir(secondWorkspace);
    await fs.writeFile(path.join(secondWorkspace, "a.txt"), "one\n");
    const second = await replay(exported.bundleDir, secondWorkspace);
    assert.strictEqual(
      second.instance.promptQueue.getState().status,
      EXECUTION_STATES.COMPLETED
    );
    assert.strictEqual(
      await fs.readFile(path.join(secondWorkspace, "a.txt"), "utf8"),
      "two\n"
    );
    assert.strictEqual(
      second.events.filter(
        (event) =>
          event.eventType === TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED
      ).length,
      2
    );
  });

  test("refuses to replace an existing bundle unless asked", async () => {
    const { instance } = await replay();
    const { workflowKey, runRef } = instance.promptQueue.getState();
    assert.ok(workflowKey && runRef);
    const options = {
      stateRoot: workspace,
      workspaceRoot: workspace,
      workflowKey,
      runRef,
      bundleDir: path.join(root, "again.ctrlyokerun"),
      exportedByVersion: "test",
    };
    await exportRunBundle(options);
    await assert.rejects(exportRunBundle(options), RunBundleExportError);
    await exportRunBundle({ ...options, replace: true });
    const leftovers = (await fs.readdir(root)).filter((entry) =>
      entry.includes(".staging-")
    );
    assert.deepStrictEqual(leftovers, [], "no staging directory survives");
  });
});
