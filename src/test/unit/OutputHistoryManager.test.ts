import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { OutputHistoryManager } from "../../flightpath/orchestration/OutputHistoryManager";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import { WorkflowOutputHistory } from "../../types/OutputHistoryTypes";

suite("OutputHistoryManager execution target persistence", () => {
  let tempWorkspace: string;
  let manager: OutputHistoryManager;
  let historyFilePath: string;

  setup(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-history-"));
    manager = new OutputHistoryManager(tempWorkspace);

    const workflowId = "wf-test";
    const historyDir = path.join(manager.historyBaseDir, workflowId);
    await fs.mkdir(historyDir, { recursive: true });

    historyFilePath = path.join(historyDir, "run-test.json");
    const initial: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId,
      runId: 1,
      startedAt: Date.now(),
      executionState: EXECUTION_STATES.RUNNING,
      runStepCount: 2,
      promptOutputs: {},
    };

    await fs.writeFile(
      historyFilePath,
      JSON.stringify(initial, null, 2),
      "utf-8"
    );
  });

  teardown(async () => {
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("stores queue and finalPrompt outputs separately", async () => {
    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 0 },
      [
        {
          prompt: "queue-1",
          response: "ok",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 100,
        },
      ],
      []
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "finalPrompt", loopIndex: 0 },
      [
        {
          prompt: "final",
          response: "final-ok",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 200,
        },
      ],
      []
    );

    const loaded = await manager.loadHistory(historyFilePath);
    assert.strictEqual(loaded.promptOutputs[0]?.cliOutputs.length, 1);
    assert.strictEqual(loaded.finalPromptOutputs?.[0]?.cliOutputs.length, 1);
  });

  test("writes chronological outputTimeline metadata", async () => {
    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "finalPrompt", loopIndex: 0 },
      [
        {
          prompt: "final",
          response: "a",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 500,
        },
      ],
      []
    );

    await manager.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex: 1 },
      [
        {
          prompt: "queue-2",
          response: "b",
          elapsed: 1,
          isStreaming: false,
          timestampMs: 300,
        },
      ],
      []
    );

    const loaded = await manager.loadHistory(historyFilePath);
    assert.ok(loaded.outputTimeline);
    assert.strictEqual(loaded.outputTimeline?.length, 2);
    assert.strictEqual(loaded.outputTimeline?.[0].key, "queue:1");
    assert.strictEqual(loaded.outputTimeline?.[1].key, "final:0");
  });
});
