import * as assert from "assert";
import chalk from "chalk";
import { setup, suite, teardown, test } from "mocha";
import {
  CliRunProgressReporter,
  getCliWorkflowLabel,
  type CliProgressSource,
} from "../../cli/CliRunProgressReporter";
import { CliTerminalFormatter } from "../../cli/CliTerminalFormatter";
import { CliTerminalOutputGate } from "../../cli/CliTerminalOutputGate";
import type { PromptQueue } from "../../core/PromptQueue";
import type { WorkflowInstance } from "../../core/WorkflowInstance";
import type {
  PromptFile,
  QueueState,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  STEP_STATUS,
  STEP_TYPES,
} from "../../types/DashboardConstants";
import { TypedEmitter } from "../../utils/TypedEmitter";

type EventPayload<K extends keyof WorkflowInstance> =
  WorkflowInstance[K] extends (listener: (data: infer T) => void) => unknown
    ? T
    : never;

/** A workflow instance that fires whatever a case tells it to. */
class FakeProgressSource implements CliProgressSource {
  workflowName = "";
  readonly attemptStart = new TypedEmitter<
    EventPayload<"onTargetAttemptStart">
  >();
  readonly attemptComplete = new TypedEmitter<
    EventPayload<"onTargetAttemptComplete">
  >();
  readonly promptStart = new TypedEmitter<EventPayload<"onPromptStart">>();
  readonly scriptOutput = new TypedEmitter<
    EventPayload<"onTargetScriptOutput">
  >();
  readonly streamingEvents = new TypedEmitter<
    EventPayload<"onTargetStreamingEvents">
  >();
  readonly streamingChunk = new TypedEmitter<
    EventPayload<"onTargetStreamingChunk">
  >();
  readonly statusMessage = new TypedEmitter<
    EventPayload<"onWorkflowStatusMessage">
  >();
  readonly stateChange = new TypedEmitter<QueueState>();
  readonly onTargetAttemptStart = this.attemptStart.event;
  readonly onTargetAttemptComplete = this.attemptComplete.event;
  readonly onPromptStart = this.promptStart.event;
  readonly onTargetScriptOutput = this.scriptOutput.event;
  readonly onTargetStreamingEvents = this.streamingEvents.event;
  readonly onTargetStreamingChunk = this.streamingChunk.event;
  readonly onWorkflowStatusMessage = this.statusMessage.event;
  readonly promptQueue: CliProgressSource["promptQueue"];

  constructor(
    readonly state: QueueState,
    readonly workflowFile: PromptFile,
    private readonly sourcePath?: string
  ) {
    const queue: Pick<
      PromptQueue,
      "getState" | "getWorkflowFile" | "onDidChangeState"
    > = {
      getState: () => this.state,
      getWorkflowFile: () => this.workflowFile,
      onDidChangeState: this.stateChange.event,
    };
    this.promptQueue = queue;
  }

  getCurrentPromptFilePath(): string | undefined {
    return this.sourcePath;
  }
}

function queueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    status: EXECUTION_STATES.RUNNING,
    stopped: false,
    totalPausedDuration: 0,
    currentIndex: 0,
    steps: [
      { name: "ask", prompt: "hello" },
      { name: "lane", prompt: "lane prompt" },
      { name: "other", prompt: "other prompt" },
    ],
    parallelGroups: [{ id: "g1", startIndex: 1, endIndex: 2, failFast: false }],
    results: [],
    completedIndices: new Set(),
    totalExecutionTime: 0,
    queueExtensions: 0,
    definitionRevision: 0,
    ...overrides,
  };
}

const WORKFLOW: PromptFile = {
  harness: HARNESS_IDS.COPILOT_CLI,
  model: "gpt-5",
  steps: [],
  finalStep: { type: STEP_TYPES.SCRIPT, name: "wrap", script: "node wrap.js" },
};

/** One step retried, a parallel member, a status line and a finalStep pass. */
function driveRun(source: FakeProgressSource): void {
  const queueTarget = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
  const prompt = {
    stepIndex: 0,
    totalSteps: 3,
    stepName: "ask",
    promptText: "hello",
    runIndex: 0,
  };
  for (const attemptIndex of [0, 1]) {
    source.attemptStart.fire({ target: queueTarget, attemptIndex });
    source.promptStart.fire({ ...prompt, attemptIndex });
    source.attemptComplete.fire({
      target: queueTarget,
      stats: { elapsed: 2 },
    });
  }
  source.statusMessage.fire({
    stepIndex: 0,
    message: "End condition passed",
    severity: "info",
  });
  source.promptStart.fire({
    stepIndex: 1,
    totalSteps: 3,
    stepName: "lane",
    promptText: "lane prompt",
    attemptIndex: 0,
    runIndex: 0,
    parallelGroupId: "g1",
  });
  source.stateChange.fire(
    queueState({
      results: [
        { status: STEP_STATUS.COMPLETED },
        { status: STEP_STATUS.COMPLETED },
      ] as QueueState["results"],
    })
  );
  source.scriptOutput.fire({
    target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
    output: { elapsed: 0, isStreaming: false },
  });
}

suite("CliRunProgressReporter", () => {
  let originalLevel: typeof chalk.level;
  let originalLog: PropertyDescriptor | undefined;
  let lines: string[];

  setup(() => {
    originalLevel = chalk.level;
    chalk.level = 0;
    lines = [];
    // The extension host installs its own `console.log`; a plain assignment
    // does not replace it, so swap the property itself.
    originalLog = Object.getOwnPropertyDescriptor(console, "log");
    Object.defineProperty(console, "log", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      },
    });
  });

  teardown(() => {
    if (originalLog) Object.defineProperty(console, "log", originalLog);
    chalk.level = originalLevel;
    CliTerminalFormatter.disposeEventStreams();
  });

  function report(
    subscribe: (
      reporter: CliRunProgressReporter,
      source: FakeProgressSource
    ) => void,
    source = new FakeProgressSource(queueState(), WORKFLOW)
  ): string[] {
    const gate = new CliTerminalOutputGate(
      { isOwned: () => false, onDidChange: () => ({ dispose() {} }) },
      () => {}
    );
    const reporter = new CliRunProgressReporter(gate);
    subscribe(reporter, source);
    driveRun(source);
    reporter.release();
    return lines.filter((line) => line.trim() !== "" && !/^─+$/.test(line));
  }

  test("reports the root run without a prefix", () => {
    const output = report((reporter, source) =>
      reporter.subscribeRoot(source, { harness: HARNESS_IDS.CLAUDE_CLI })
    );

    assert.ok(output.includes("│ Step 1/3 — ask"), output.join("\n"));
    assert.ok(output.includes("│ Retry 1 — Step 1/3 — ask"));
    assert.ok(output.includes("│ Harness: copilot-cli"));
    assert.ok(output.includes("│ Model: gpt-5"));
    assert.ok(output.includes("│ ℹ End condition passed"));
    assert.ok(output.includes("Parallel group g1 — 2 member(s)"));
    assert.ok(
      output.includes("  Parallel group g1: 1 running · 0 done · 0 failed")
    );
    assert.ok(
      output.includes("  Parallel group g1: 0 running · 1 done · 0 failed")
    );
    assert.ok(output.includes("│ Final Step Pass 1"));
    assert.ok(output.includes("↻ ask: 2 attempts · 4s total"));
    assert.ok(!output.some((line) => line.includes("[")), output.join("\n"));
  });

  test("reports a child through the same handlers under its workflow label", () => {
    const child = new FakeProgressSource(queueState(), WORKFLOW);
    child.workflowName = "Kid";
    const output = report(
      (reporter, source) =>
        reporter.subscribeChild(source, { harness: HARNESS_IDS.CLAUDE_CLI }),
      child
    );

    assert.ok(output.includes("│ Step 1/3 — [Kid] ask"), output.join("\n"));
    assert.ok(output.includes("│ Retry 1 — Step 1/3 — [Kid] ask"));
    assert.ok(output.includes("│ Harness: copilot-cli"));
    assert.ok(output.includes("│ Model: gpt-5"));
    assert.ok(output.includes("│ ℹ [Kid] End condition passed"));
    assert.ok(output.includes("[Kid] Parallel group g1 — 2 member(s)"));
    assert.ok(
      output.includes(
        "  [Kid] Parallel group g1: 1 running · 0 done · 0 failed"
      )
    );
    assert.ok(output.includes("│ [Kid] Final Step Pass 1"));
    assert.ok(output.includes("↻ [Kid] ask: 2 attempts · 4s total"));
  });

  test("keeps root and child retry tallies apart and flushes both once", () => {
    const root = new FakeProgressSource(queueState(), WORKFLOW);
    const child = new FakeProgressSource(queueState(), WORKFLOW);
    child.workflowName = "Kid";
    const gate = new CliTerminalOutputGate(
      { isOwned: () => false, onDidChange: () => ({ dispose() {} }) },
      () => {}
    );
    const reporter = new CliRunProgressReporter(gate);
    reporter.subscribeRoot(root, { harness: HARNESS_IDS.CLAUDE_CLI });
    reporter.subscribeChild(child, { harness: HARNESS_IDS.CLAUDE_CLI });
    driveRun(root);
    driveRun(child);
    reporter.release();
    reporter.release();

    const tallies = lines.filter((line) => line.startsWith("↻ "));
    assert.deepStrictEqual(tallies, [
      "↻ ask: 2 attempts · 4s total",
      "↻ [Kid] ask: 2 attempts · 4s total",
    ]);
  });

  test("labels a nameless file child from its lineage, never generically", () => {
    const nameless = new FakeProgressSource(
      queueState({
        workflowKey: "build-and-test-2026-11-27T08-00-00-000Z" as WorkflowKey,
      }),
      { steps: [] }
    );
    assert.strictEqual(getCliWorkflowLabel(nameless), "build-and-test");

    const keyless = new FakeProgressSource(
      queueState(),
      { steps: [] },
      "/work/flows/release.ctrlyoke.yml"
    );
    assert.strictEqual(getCliWorkflowLabel(keyless), "release");

    const named = new FakeProgressSource(
      queueState({ workflowName: "  Release  " }),
      { steps: [] }
    );
    assert.strictEqual(getCliWorkflowLabel(named), "Release");
  });
});
