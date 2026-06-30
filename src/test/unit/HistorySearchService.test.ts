import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HistorySearchService } from "../../core/orchestration/HistorySearchService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

suite("HistorySearchService", () => {
  let workspaceRoot: string;
  let service: HistorySearchService;
  let recorder: TimelineRecorder;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(process.cwd(), "history-search-service-")
    );
    service = new HistorySearchService();
    recorder = new TimelineRecorder();
    await fs.mkdir(
      path.join(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      ),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.HISTORY_DIR
      ),
      { recursive: true }
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("returns newest matches first with queue metadata and run indexes", async () => {
    const workflowId = "demo-2026-06-09T17-00-00";
    await writeWorkingFile(workflowId, {
      workflowName: "Demo Workflow",
      originalFile: "C:\\dev\\ctrlyoke\\demo.flightpath.yaml",
    });

    await createRun(workflowId, 1, 1000, [
      createCliOutputDraft(
        1100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "first prompt",
          response: "older needle response",
          elapsed: 1,
          isStreaming: false,
        }
      ),
    ]);

    await createRun(workflowId, 2, 2000, [
      createStatusDraft(
        2100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        "latest needle status"
      ),
    ]);

    const response = await service.search("needle", workspaceRoot);
    const results = response.results;

    assert.strictEqual(results.length, 2);
    assert.strictEqual(response.totalCount, 2);
    assert.strictEqual(response.hasMore, false);
    assert.strictEqual(response.indexState, "ready");
    assert.strictEqual(results[0]?.startedAt, 2000);
    assert.strictEqual(results[0]?.runIndex, 0);
    assert.strictEqual(results[0]?.workflowName, "Demo Workflow");
    assert.strictEqual(
      results[0]?.workflowFilePath,
      path.join(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.QUEUE_DIR,
        `${workflowId}.flightpath.json`
      )
    );
    assert.strictEqual(results[0]?.matchType, "status");
    assert.strictEqual(results[0]?.matchContext, "Prompt 2");

    assert.strictEqual(results[1]?.startedAt, 1000);
    assert.strictEqual(results[1]?.runIndex, 1);
    assert.strictEqual(results[1]?.matchType, "response");
    assert.strictEqual(results[1]?.matchContext, "Prompt 1");
  });

  test("classifies structured CLI event matches and derives final-step context", async () => {
    const workflowId = "orphan-2026-06-09T17-30-00";
    await createRun(workflowId, 1, 3000, [
      createCliOutputDraft(
        3100,
        { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 },
        {
          prompt: "final prompt",
          response: "final response",
          elapsed: 1,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                data: {
                  command: "echo bash-term",
                  output: "bash-term output",
                },
              },
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/history-search.ts",
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-old line", "+diff-term line"],
                    },
                  ],
                },
              },
              {
                type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
                data: {
                  server: "history-server",
                  tool: "tool-call-term",
                },
              },
              {
                type: CLI_EVENT_TYPES.TOOL_RESULT,
                data: {
                  toolCallId: "1",
                  result: {
                    success: true,
                    output: "tool-result-term output",
                  },
                },
              },
            ],
            metadata: {},
          },
        }
      ),
    ]);

    const bashResults = (await service.search("bash-term", workspaceRoot))
      .results;
    assert.strictEqual(bashResults[0]?.matchType, "bash");
    assert.strictEqual(bashResults[0]?.matchContext, "Final Step Loop 2");

    const fileResults = (
      await service.search("src/history-search.ts", workspaceRoot)
    ).results;
    assert.strictEqual(fileResults[0]?.matchType, "file");
    assert.strictEqual(fileResults[0]?.filePath, "src/history-search.ts");
    assert.strictEqual(fileResults[0]?.workflowName, "orphan");

    const toolResults = (
      await service.search("tool-result-term", workspaceRoot)
    ).results;
    assert.strictEqual(toolResults[0]?.matchType, "tool");

    const diffResults = (await service.search("diff-term", workspaceRoot))
      .results;
    assert.strictEqual(diffResults[0]?.matchType, "diff");
    assert.strictEqual(diffResults[0]?.filePath, "src/history-search.ts");
  });

  test("returns no results for short queries", async () => {
    const response = await service.search("a", workspaceRoot);
    assert.deepStrictEqual(response.results, []);
    assert.strictEqual(response.totalCount, 0);
  });

  test("returns accurate counts and stable cursor pages", async () => {
    const workflowId = "paged-2026-06-09T18-00-00";
    await writeWorkingFile(workflowId, { workflowName: "Paged Workflow" });
    await createRun(workflowId, 1, 1000, [
      createStatusDraft(
        1100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "needle first"
      ),
      createStatusDraft(
        1200,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        "needle second"
      ),
      createStatusDraft(
        1300,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
        "needle third"
      ),
    ]);

    const firstPage = await service.search(
      { query: "needle", limit: 2 },
      workspaceRoot
    );

    assert.strictEqual(firstPage.totalCount, 3);
    assert.strictEqual(firstPage.results.length, 2);
    assert.strictEqual(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    assert.strictEqual(firstPage.results[0]?.matchContext, "Prompt 3");

    const secondPage = await service.search(
      { query: "needle", limit: 2, cursor: firstPage.nextCursor },
      workspaceRoot
    );

    assert.strictEqual(secondPage.totalCount, 3);
    assert.strictEqual(secondPage.results.length, 1);
    assert.strictEqual(secondPage.hasMore, false);
    assert.strictEqual(secondPage.results[0]?.matchContext, "Prompt 1");
  });

  test("rebuilds missing, corrupt, and stale index data", async () => {
    const workflowId = "rebuild-2026-06-09T19-00-00";
    await writeWorkingFile(workflowId, { workflowName: "Rebuild Workflow" });
    const manifestPath = await createRun(workflowId, 1, 1000, [
      createStatusDraft(
        1100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "needle before corruption"
      ),
    ]);

    const initial = await service.search("needle", workspaceRoot);
    assert.strictEqual(initial.totalCount, 1);

    const documentsPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.SEARCH_INDEX_DIR,
      "documents.jsonl"
    );
    await fs.writeFile(documentsPath, "{not-json}\n", "utf8");

    service = new HistorySearchService();
    const afterCorruption = await service.search("needle", workspaceRoot);
    assert.strictEqual(afterCorruption.totalCount, 1);
    assert.strictEqual(afterCorruption.indexState, "ready");

    await recorder.appendEvents(manifestPath, [
      createStatusDraft(
        1200,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        "fresh-term after stale index"
      ),
    ]);

    const afterStaleSource = await service.search("fresh-term", workspaceRoot);
    assert.strictEqual(afterStaleSource.totalCount, 1);
    assert.strictEqual(afterStaleSource.results[0]?.matchContext, "Prompt 2");
  });

  async function writeWorkingFile(
    workflowId: string,
    overrides: Partial<WorkingFile>
  ): Promise<void> {
    const workingFile: WorkingFile = {
      workflowName: overrides.workflowName ?? workflowId,
      startedAt: overrides.startedAt ?? 0,
      originalFile: overrides.originalFile,
      steps: [],
    };

    await fs.writeFile(
      path.join(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.QUEUE_DIR,
        `${workflowId}.flightpath.json`
      ),
      JSON.stringify({ ...workingFile, ...overrides }, null, 2),
      "utf8"
    );
  }

  async function createRun(
    workflowId: string,
    runId: number,
    startedAt: number,
    events: WorkflowTimelineEventDraft[]
  ): Promise<string> {
    const historyDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.HISTORY_DIR,
      workflowId
    );
    await fs.mkdir(historyDir, { recursive: true });
    const manifestPath = await recorder.initializeRun(
      historyDir,
      workflowId,
      runId,
      startedAt,
      EXECUTION_STATES.RUNNING
    );

    if (events.length > 0) {
      await recorder.appendEvents(manifestPath, events);
    }

    await recorder.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      executionState: EXECUTION_STATES.COMPLETED,
      completedAt: startedAt + 10,
      runStepCount: 1,
      lastUpdatedAt: startedAt + 10,
    }));
    return manifestPath;
  }

  function createCliOutputDraft(
    timestampMs: number,
    target:
      | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
      | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number },
    cliOutput: {
      prompt: string;
      response: string;
      elapsed: number;
      isStreaming: boolean;
      structured?: { events: CliEvent[]; metadata: Record<string, unknown> };
    }
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs,
      target,
      attemptIndex: 0,
      payload: {
        cliOutput,
      },
    };
  }

  function createStatusDraft(
    timestampMs: number,
    target:
      | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
      | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number },
    message: string
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      timestampMs,
      target,
      payload: {
        statusMessage: {
          message,
          severity: "info",
          timestamp: timestampMs,
        },
      },
    };
  }
});
