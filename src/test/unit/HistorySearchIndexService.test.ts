import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HistorySearchIndexService } from "../../core/orchestration/HistorySearchIndexService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import type { HarnessId } from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
  type HistorySearchResponse,
} from "../../types/WorkflowTimelineTypes";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("HistorySearchIndexService", () => {
  let workspaceRoot: string;
  let recorder: TimelineRecorder;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "history-search-index-")
    );
    recorder = new TimelineRecorder();
    await fs.mkdir(WorkflowPaths.runsRoot(workspaceRoot), {
      recursive: true,
    });
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("preserves harness attribution across same-step reruns", async () => {
    const workflowId = "harness-reruns-2026-06-09T22-00-00";
    await createRun(workflowId, 1, 1000, [
      createCliOutputDraft(
        1100,
        HARNESS_IDS.CLAUDE_CLI,
        "shared-harness-term",
        0
      ),
      createCliOutputDraft(
        1200,
        HARNESS_IDS.CODEX_CLI,
        "shared-harness-term",
        1
      ),
    ]);

    const index = new HistorySearchIndexService();
    const allResults = await index.search(
      { query: "shared-harness-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(allResults.totalCount, 2);

    const claudeResults = await index.search(
      {
        query: "shared-harness-term",
        limit: 10,
        filters: { harnesses: ["claude-cli"] },
      },
      workspaceRoot
    );
    assert.strictEqual(claudeResults.totalCount, 1);

    const codexResults = await index.search(
      {
        query: "shared-harness-term",
        limit: 10,
        filters: { harnesses: ["codex-cli"] },
      },
      workspaceRoot
    );
    assert.strictEqual(codexResults.totalCount, 1);
  });

  test("resets a cursor when its filters change", async () => {
    const workflowId = "cursor-filters-2026-06-09T22-10-00";
    await createRun(workflowId, 1, 2000, [
      createStatusDraft(2100, "cursor-filter-term"),
      createStatusDraft(2150, "cursor-filter-term"),
      createCliOutputDraft(2200, undefined, "cursor-filter-term", 0, [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          data: {
            path: "src/cursor-filter-term.ts",
            structuredPatch: [],
          },
        },
      ]),
    ]);

    const index = new HistorySearchIndexService();
    const firstPage = await index.search(
      {
        query: "cursor-filter-term",
        limit: 1,
        filters: { eventKinds: ["status"] },
      },
      workspaceRoot
    );
    assert.ok(firstPage.nextCursor);

    const changedFilters = await index.search(
      {
        query: "cursor-filter-term",
        limit: 1,
        cursor: firstPage.nextCursor,
        filters: { eventKinds: ["fileEdit"] },
      },
      workspaceRoot
    );
    assert.strictEqual(changedFilters.totalCount, 1);
    assert.strictEqual(changedFilters.results.length, 1);
    assert.strictEqual(changedFilters.results[0]?.eventKind, "fileEdit");
  });

  test("matches path filters across mixed separators and casing", async () => {
    const workflowId = "path-filter-2026-06-09T22-20-00";
    await createRun(workflowId, 1, 3000, [
      createCliOutputDraft(3100, HARNESS_IDS.CLAUDE_CLI, "mixed-path-term", 0, [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          data: {
            path: "src\\ui\\webview-react\\mixed-path-term.tsx",
            structuredPatch: [],
          },
        },
      ]),
    ]);

    const index = new HistorySearchIndexService();
    const response = await index.search(
      {
        query: "mixed-path-term",
        limit: 10,
        filters: { pathContains: "UI/webview-react" },
      },
      workspaceRoot
    );
    assert.strictEqual(response.totalCount, 1);
    assert.strictEqual(
      response.results[0]?.filePath,
      "src\\ui\\webview-react\\mixed-path-term.tsx"
    );
  });

  test("runs a real worker rebuild and relays progress to the caller", async () => {
    await createRun("worker-success-2026-06-09T22-25-00", 1, 3500, [
      createStatusDraft(3550, "worker-success-term"),
    ]);

    const progress: Array<[number, number]> = [];
    const response = await new HistorySearchIndexService().search(
      { query: "worker-success-term", limit: 10 },
      workspaceRoot,
      (processedRuns, totalRuns) => {
        progress.push([processedRuns, totalRuns]);
      }
    );

    assert.strictEqual(response.totalCount, 1);
    assert.ok(
      progress.some(([processed, total]) => processed === 0 && total === 1)
    );
    assert.ok(
      progress.some(([processed, total]) => processed === 1 && total === 1)
    );
  });

  test("propagates a real worker failure to the rebuild caller", async () => {
    const runsRoot = WorkflowPaths.runsRoot(workspaceRoot);
    await fs.rm(runsRoot, { recursive: true, force: true });
    await fs.writeFile(runsRoot, "not a directory", "utf8");

    await assert.rejects(
      new HistorySearchIndexService().search(
        { query: "worker-failure-term", limit: 10 },
        workspaceRoot
      ),
      /ENOTDIR|not a directory/i
    );
  });

  test("keeps unattributed documents unless harnesses are narrowed", async () => {
    const workflowId = "unattributed-2026-06-09T22-30-00";
    await createRun(workflowId, 1, 4000, [
      createStatusDraft(4100, "unattributed-term"),
    ]);

    const index = new HistorySearchIndexService();
    const withoutHarnessFilter = await index.search(
      { query: "unattributed-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(withoutHarnessFilter.totalCount, 1);

    const narrowed = await index.search(
      {
        query: "unattributed-term",
        limit: 10,
        filters: { harnesses: ["claude-cli"] },
      },
      workspaceRoot
    );
    assert.strictEqual(narrowed.totalCount, 0);
  });

  test("skips a redundant rebuild after waiting for a sibling and loads retained documents", async () => {
    const workflowId = "fresh-index-race-2026-06-09T22-40-00";
    await createRun(workflowId, 1, 5000, [
      createStatusDraft(5100, "fresh-index-race-term"),
    ]);

    const firstIndex = new HistorySearchIndexService();
    const secondIndex = new HistorySearchIndexService();
    const messages: string[] = [];
    const originalDebug = Log.debug;
    const originalInfo = Log.info;
    let resolveFirstRebuildStarted!: () => void;
    const firstRebuildStarted = new Promise<void>((resolve) => {
      resolveFirstRebuildStarted = resolve;
    });
    let secondSearch: Promise<HistorySearchResponse> | undefined;
    let firstRebuildStartObserved = false;

    Log.debug = (message: string) => {
      messages.push(message);
    };
    Log.info = (message: string) => {
      messages.push(message);
      if (!firstRebuildStartObserved && message.includes("rebuild starting:")) {
        firstRebuildStartObserved = true;
        secondSearch = secondIndex.search(
          { query: "fresh-index-race-term", limit: 10 },
          workspaceRoot
        );
        resolveFirstRebuildStarted();
      }
    };

    try {
      const firstRefresh = firstIndex.enqueueWorkspaceRefresh(workspaceRoot);
      await firstRebuildStarted;
      const secondSearchPromise = secondSearch;
      assert.ok(secondSearchPromise);
      const secondResponse = await secondSearchPromise;
      await firstRefresh;

      assert.strictEqual(secondResponse.totalCount, 1);
      assert.ok(
        messages.some((message) =>
          message.includes("rebuild skipped: on-disk index already fresh")
        )
      );
      assert.strictEqual(
        messages.filter((message) =>
          message.includes("[HistorySearchIndexService] rebuild starting:")
        ).length,
        1,
        messages.join("\n")
      );
    } finally {
      Log.debug = originalDebug;
      Log.info = originalInfo;
    }
  });

  test("falls through to a full rebuild when a new run is added during contention", async () => {
    const initialWorkflowId = "stale-index-race-2026-06-09T22-50-00";
    await createRun(initialWorkflowId, 1, 6000, [
      createStatusDraft(6100, "stale-index-race-initial-term"),
    ]);

    const firstIndex = new HistorySearchIndexService();
    const secondIndex = new HistorySearchIndexService();
    const messages: string[] = [];
    const originalDebug = Log.debug;
    const originalInfo = Log.info;
    let resolveFirstRebuildStarted!: () => void;
    const firstRebuildStarted = new Promise<void>((resolve) => {
      resolveFirstRebuildStarted = resolve;
    });
    let secondRefresh: Promise<void> | undefined;
    let firstRebuildStartObserved = false;

    Log.debug = (message: string) => {
      messages.push(message);
    };
    Log.info = (message: string) => {
      messages.push(message);
      if (!firstRebuildStartObserved && message.includes("rebuild starting:")) {
        firstRebuildStartObserved = true;
        const newRun = createRun(
          "stale-index-race-new-2026-06-09T22-51-00",
          1,
          7000,
          [createStatusDraft(7100, "stale-index-race-new-term")]
        );
        secondRefresh = newRun.then(() =>
          secondIndex.enqueueWorkspaceRefresh(workspaceRoot)
        );
        resolveFirstRebuildStarted();
      }
    };

    try {
      const firstRefresh = firstIndex.enqueueWorkspaceRefresh(workspaceRoot);
      await firstRebuildStarted;
      await firstRefresh;
      const secondRefreshPromise = secondRefresh;
      assert.ok(secondRefreshPromise);
      await secondRefreshPromise;

      assert.ok(
        messages.some((message) =>
          message.includes("freshness check stale: run count changed")
        )
      );
      assert.strictEqual(
        messages.filter((message) =>
          message.includes("[HistorySearchIndexService] rebuild starting:")
        ).length,
        2,
        messages.join("\n")
      );

      const verifier = new HistorySearchIndexService();
      const response = await verifier.search(
        { query: "stale-index-race-new-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(response.totalCount, 1);
    } finally {
      Log.debug = originalDebug;
      Log.info = originalInfo;
    }
  });

  async function createRun(
    workflowId: string,
    runId: number,
    startedAt: number,
    events: WorkflowTimelineEventDraft[]
  ): Promise<void> {
    const workflowKey = workflowId as WorkflowKey;
    const runRef = WorkflowPaths.formatRunRef(startedAt);
    const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
    const manifestPath = await recorder.initializeRunAt(
      runDir,
      workflowId,
      runId,
      startedAt,
      EXECUTION_STATES.COMPLETED
    );
    await recorder.appendEvents(manifestPath, events);
  }

  function createCliOutputDraft(
    timestampMs: number,
    harness: HarnessId | undefined,
    response: string,
    attemptIndex: number,
    structuredEvents: CliEvent[] = []
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex,
      payload: {
        cliOutput: {
          prompt: "",
          response,
          elapsed: 1,
          isStreaming: false,
          structured: {
            events: structuredEvents,
            metadata: harness ? { harness } : {},
          },
        },
      },
    };
  }

  function createStatusDraft(
    timestampMs: number,
    message: string
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      timestampMs,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
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
