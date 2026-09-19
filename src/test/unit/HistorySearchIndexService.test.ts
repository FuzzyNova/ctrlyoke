import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  HistorySearchCancelledError,
  HistorySearchIndexService,
} from "../../core/orchestration/HistorySearchIndexService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  computeHistorySearchIndexDiff,
  checkHistorySearchIndexFreshness,
  DOCUMENTS_DIR_NAME,
  DOCUMENTS_SHARD_EXTENSION,
  getDocumentsShardPath,
  MAX_INDEXED_TEXT_LENGTH,
  type HistorySearchIndexManifest,
  INDEX_SCHEMA_VERSION,
  listRunSources,
  runHistorySearchRebuild,
} from "../../core/orchestration/historySearchRebuildWorker";
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
  type WorkflowRunManifest,
  type WorkflowTimelineEventDraft,
  type HistorySearchResponse,
} from "../../types/WorkflowTimelineTypes";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import { Log } from "../../utils/Log";
import { getFrozenRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../utils/ConfigurationUtils";

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

  test("streams large event text while preserving index truncation", async () => {
    const visibleTerm = "streamed-visible-term";
    const hiddenTerm = "streamed-hidden-term";
    const response = `${visibleTerm}${"x".repeat(
      MAX_INDEXED_TEXT_LENGTH - visibleTerm.length
    )}${hiddenTerm}`;
    await createRun("streaming-large-event-2026-06-09T22-02-00", 1, 3000, [
      createCliOutputDraft(3100, HARNESS_IDS.CODEX_CLI, response, 0),
    ]);

    const index = new HistorySearchIndexService();
    const visibleResponse = await index.search(
      { query: visibleTerm, limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(visibleResponse.totalCount, 1);

    const hiddenResponse = await index.search(
      { query: hiddenTerm, limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(hiddenResponse.totalCount, 0);

    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);
    const indexDir = path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
    const documents = (
      await fs.readFile(
        getDocumentsShardPath(indexDir, source.manifestPath),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string; textLower: string });
    assert.strictEqual(documents.length, 1);
    assert.strictEqual(documents[0]?.text.length, MAX_INDEXED_TEXT_LENGTH);
    assert.strictEqual(
      documents[0]?.textLower,
      documents[0]?.text.toLowerCase()
    );
  });

  test("stores one document shard per run and searches across shards", async () => {
    const firstWorkflowId = "sharded-first-2026-06-09T22-00-00";
    const secondWorkflowId = "sharded-second-2026-06-09T22-01-00";
    await createRun(firstWorkflowId, 1, 1000, [
      createStatusDraft(1100, "sharded-search-term"),
    ]);
    await createRun(secondWorkflowId, 1, 2000, [
      createStatusDraft(2100, "sharded-search-term"),
    ]);

    const index = new HistorySearchIndexService();
    const response = await index.search(
      { query: "sharded-search-term", limit: 10 },
      workspaceRoot
    );

    const documentsDir = path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR,
      DOCUMENTS_DIR_NAME
    );
    const shardFiles = await fs.readdir(documentsDir);
    assert.strictEqual(shardFiles.length, 2);
    assert.ok(
      shardFiles.every((fileName) =>
        fileName.endsWith(DOCUMENTS_SHARD_EXTENSION)
      )
    );
    assert.deepStrictEqual(
      new Set(shardFiles),
      new Set(
        (await listRunSources(workspaceRoot)).map((source) =>
          path.basename(
            getDocumentsShardPath(
              path.dirname(documentsDir),
              source.manifestPath
            )
          )
        )
      )
    );
    assert.strictEqual(response.totalCount, 2);
    assert.strictEqual(response.results.length, 2);
  });

  test("orders results by startedAt across shards regardless of creation order, including a tie", async () => {
    // Runs are created out of startedAt order, and workflow C shares its
    // startedAt with workflow B, on purpose: the shard scanner now visits
    // shards in descending startedAt order (an on-disk detail), but the
    // result order the client sees must be unaffected by either the creation
    // order or which of the tied shards is visited first.
    const term = "shard-order-term";
    await createRun("shard-order-a-2026-06-09T22-20-00", 1, 5000, [
      createStatusDraft(5100, term),
    ]);
    await createRun("shard-order-d-2026-06-09T22-20-03", 1, 3000, [
      createStatusDraft(3100, term),
    ]);
    await createRun("shard-order-b-2026-06-09T22-20-01", 1, 7000, [
      createStatusDraft(7100, term),
    ]);
    await createRun("shard-order-c-2026-06-09T22-20-02", 1, 7000, [
      createStatusDraft(7050, term),
    ]);

    const index = new HistorySearchIndexService();
    const response = await index.search(
      { query: term, limit: 10 },
      workspaceRoot
    );

    assert.strictEqual(response.totalCount, 4);
    assert.deepStrictEqual(
      response.results.map((result) => result.workflowKey),
      [
        "shard-order-b-2026-06-09T22-20-01",
        "shard-order-c-2026-06-09T22-20-02",
        "shard-order-a-2026-06-09T22-20-00",
        "shard-order-d-2026-06-09T22-20-03",
      ]
    );
  });

  test("caches an empty sharded index for a workspace with no history yet", async () => {
    const index = new HistorySearchIndexService();
    const messages: string[] = [];
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };

    try {
      const first = await index.search(
        { query: "no-runs-yet-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(first.totalCount, 0);
      const second = await index.search(
        { query: "no-runs-yet-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(second.totalCount, 0);
    } finally {
      Log.info = originalInfo;
    }

    assert.strictEqual(
      messages.filter((message) => message.includes("rebuild starting:"))
        .length,
      1,
      messages.join("\n")
    );
  });

  test("does not serve a paged offset from another filter's snapshot", async () => {
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
    assert.strictEqual(firstPage.totalCount, 2);
    assert.strictEqual(firstPage.hasMore, true);

    // The retained match snapshot is keyed by filters as well as query text, so
    // an offset request under different filters must re-derive rather than
    // slice the previous query's results.
    const changedFilters = await index.search(
      {
        query: "cursor-filter-term",
        limit: 1,
        offset: 1,
        filters: { eventKinds: ["fileEdit"] },
      },
      workspaceRoot
    );
    assert.strictEqual(changedFilters.totalCount, 1);
    assert.strictEqual(changedFilters.results.length, 0);
    assert.strictEqual(changedFilters.hasMore, false);

    const fileEditPage = await index.search(
      {
        query: "cursor-filter-term",
        limit: 1,
        filters: { eventKinds: ["fileEdit"] },
      },
      workspaceRoot
    );
    assert.strictEqual(fileEditPage.results[0]?.eventKind, "fileEdit");
  });

  test("serves an immediate repeat query from the snapshot without rescanning", async () => {
    const workflowId = "repeat-query-snapshot-2026-06-09T22-55-00";
    await createRun(workflowId, 1, 8000, [
      createStatusDraft(8100, "repeat-query-term"),
    ]);

    const index = new HistorySearchIndexService();
    const messages: string[] = [];
    const originalDebug = Log.debug;
    Log.debug = (message: string) => {
      messages.push(message);
    };

    try {
      const first = await index.search(
        { query: "repeat-query-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(first.totalCount, 1);

      messages.length = 0;
      const second = await index.search(
        { query: "repeat-query-term", limit: 10 },
        workspaceRoot
      );

      assert.deepStrictEqual(second, first);
      assert.ok(
        messages.some((message) =>
          message.includes("search page-0 from snapshot (index unchanged)")
        ),
        messages.join("\n")
      );
      assert.ok(
        !messages.some((message) =>
          message.includes("[HistorySearchIndexService] search start:")
        ),
        messages.join("\n")
      );
    } finally {
      Log.debug = originalDebug;
    }
  });

  test("re-derives a repeated query once the index has changed", async () => {
    const firstWorkflowId = "repeat-query-stale-first-2026-06-09T22-56-00";
    await createRun(firstWorkflowId, 1, 8500, [
      createStatusDraft(8600, "repeat-query-stale-term"),
    ]);

    const index = new HistorySearchIndexService();
    const first = await index.search(
      { query: "repeat-query-stale-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(first.totalCount, 1);

    const secondWorkflowId = "repeat-query-stale-second-2026-06-09T22-57-00";
    await createRun(secondWorkflowId, 1, 8700, [
      createStatusDraft(8800, "repeat-query-stale-term"),
    ]);

    const messages: string[] = [];
    const originalDebug = Log.debug;
    Log.debug = (message: string) => {
      messages.push(message);
    };

    try {
      const second = await index.search(
        { query: "repeat-query-stale-term", limit: 10 },
        workspaceRoot
      );

      assert.strictEqual(second.totalCount, 2);
      assert.ok(
        messages.some((message) =>
          message.includes("freshness check stale: run count changed")
        ),
        messages.join("\n")
      );
      assert.ok(
        !messages.some((message) =>
          message.includes("search page-0 from snapshot (index unchanged)")
        ),
        messages.join("\n")
      );
    } finally {
      Log.debug = originalDebug;
    }
  });

  test("cancels a search via AbortSignal instead of returning stale-looking results", async () => {
    const workflowId = "cancelled-search-2026-06-09T22-58-00";
    await createRun(workflowId, 1, 9000, [
      createStatusDraft(9100, "cancelled-search-term"),
    ]);

    const index = new HistorySearchIndexService();
    // Warm the index so the cancellation check under test is the one at the
    // top of `search()`, not an incidental rebuild.
    await index.search(
      { query: "warm-up-term-not-matched", limit: 10 },
      workspaceRoot
    );

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      index.search(
        { query: "cancelled-search-term", limit: 10 },
        workspaceRoot,
        undefined,
        controller.signal
      ),
      (error: unknown) => error instanceof HistorySearchCancelledError
    );

    // A cancelled search must leave no trace: the next, un-cancelled request
    // for the same query must still do a real scan rather than serving
    // something the cancelled attempt might have cached.
    const messages: string[] = [];
    const originalDebug = Log.debug;
    Log.debug = (message: string) => {
      messages.push(message);
    };
    try {
      const followUp = await index.search(
        { query: "cancelled-search-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(followUp.totalCount, 1);
      assert.ok(
        !messages.some((message) =>
          message.includes("search page-0 from snapshot (index unchanged)")
        ),
        messages.join("\n")
      );
    } finally {
      Log.debug = originalDebug;
    }
  });

  test("answers a far offset in one request instead of walking pages", async () => {
    const workflowId = "offset-paging-2026-06-09T22-40-00";
    await createRun(
      workflowId,
      1,
      4000,
      Array.from({ length: 25 }, (_unused, index) =>
        createStatusDraft(4100 + index, `offset-paging-term ${index}`)
      )
    );

    const index = new HistorySearchIndexService();
    const firstPage = await index.search(
      { query: "offset-paging-term", limit: 5 },
      workspaceRoot
    );
    assert.strictEqual(firstPage.totalCount, 25);
    assert.strictEqual(firstPage.offset, 0);
    assert.strictEqual(firstPage.results.length, 5);

    const lastPage = await index.search(
      { query: "offset-paging-term", limit: 5, offset: 20 },
      workspaceRoot
    );
    assert.strictEqual(lastPage.offset, 20);
    assert.strictEqual(lastPage.totalCount, 25);
    assert.strictEqual(lastPage.results.length, 5);
    assert.strictEqual(lastPage.hasMore, false);

    const fullListing = await index.search(
      { query: "offset-paging-term", limit: 25 },
      workspaceRoot
    );
    assert.deepStrictEqual(
      lastPage.results.map((result) => result.matchSnippet),
      fullListing.results
        .slice(20)
        .map((result: { matchSnippet: string }) => result.matchSnippet)
    );
  });

  test("returns a first page without scanning every shard when matches cluster in recent runs", async () => {
    const term = "shard-scan-budget-term";
    const totalRuns = 40;
    for (let i = 0; i < totalRuns; i += 1) {
      await createRun(
        `shard-scan-budget-run-${i}-2026-06-09T22-30-00`,
        1,
        10000 + i * 100,
        [createStatusDraft(10100 + i * 100, term)]
      );
    }

    const index = new HistorySearchIndexService();
    const messages: string[] = [];
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };

    let response: HistorySearchResponse;
    try {
      response = await index.search({ query: term, limit: 5 }, workspaceRoot);
    } finally {
      Log.info = originalInfo;
    }

    assert.strictEqual(response.results.length, 5);
    assert.strictEqual(response.totalCount, 5);
    assert.strictEqual(response.countState, "atLeast");
    assert.strictEqual(response.hasMore, true);

    const completeLine = messages.find((message) =>
      message.includes("[HistorySearchIndexService] search complete:")
    );
    assert.ok(completeLine, messages.join("\n"));
    const scannedMatch = completeLine?.match(/documentsScanned=(\d+)/);
    assert.ok(scannedMatch, completeLine);
    const documentsScanned = Number(scannedMatch?.[1]);
    assert.ok(
      documentsScanned <= 10,
      `expected an early-terminated scan to read only a handful of the ${totalRuns} shards, read ${documentsScanned}`
    );
  });

  test("pushes growing partial results while a scan can't stop early", async () => {
    // Five runs, one match each, and a limit far above the match count: the
    // scan can never satisfy `targetCount` early, so it has to read every
    // shard — exactly the case the partial-results push exists for (a rare
    // term costing a full scan). Distinct startedAt values (rather than one
    // run with five documents) are what create the group boundaries a push
    // fires at.
    const term = "partial-progress-term";
    const totalRuns = 5;
    for (let i = 0; i < totalRuns; i += 1) {
      await createRun(
        `partial-progress-run-${i}-2026-06-09T22-35-00`,
        1,
        50000 + i * 100,
        [createStatusDraft(50100 + i * 100, term)]
      );
    }

    const index = new HistorySearchIndexService();
    const partials: HistorySearchResponse[] = [];
    const response = await index.search(
      { query: term, limit: 100 },
      workspaceRoot,
      undefined,
      undefined,
      (partial) => {
        partials.push(partial);
      }
    );

    assert.strictEqual(response.totalCount, 5);
    assert.strictEqual(response.countState, "exact");
    assert.ok(partials.length > 0, "expected at least one partial push");
    assert.ok(
      partials.length < totalRuns,
      "the final group's results must arrive with the final response, not duplicated as a partial push first"
    );

    let previousTotal = 0;
    for (const partial of partials) {
      assert.strictEqual(partial.countState, "atLeast");
      assert.strictEqual(partial.hasMore, true);
      assert.ok(
        partial.totalCount > previousTotal,
        `expected a growing total, got ${partial.totalCount} after ${previousTotal}`
      );
      previousTotal = partial.totalCount;
    }
    assert.ok(previousTotal < response.totalCount);
  });

  test("pushes no partial results when the first group already satisfies the page", async () => {
    // A single run whose one shard both opens and closes the scan: there is
    // no "next shard differs" transition to push a partial at, since the
    // group is only finalized once, after the loop ends — matching the
    // common, already-fast case (see option A) where nothing should fire.
    const term = "partial-none-needed-term";
    await createRun("partial-none-needed-2026-06-09T22-36-00", 1, 51000, [
      createStatusDraft(51100, term),
    ]);

    const index = new HistorySearchIndexService();
    const partials: HistorySearchResponse[] = [];
    const response = await index.search(
      { query: term, limit: 1 },
      workspaceRoot,
      undefined,
      undefined,
      (partial) => {
        partials.push(partial);
      }
    );

    assert.strictEqual(response.totalCount, 1);
    assert.deepStrictEqual(partials, []);
  });

  test("resumes a scan from its retained cursor instead of restarting when paging past the retained prefix", async () => {
    const term = "resume-cursor-term";
    const totalRuns = 40;
    for (let i = 0; i < totalRuns; i += 1) {
      await createRun(
        `resume-cursor-run-${i}-2026-06-09T22-31-00`,
        1,
        20000 + i * 100,
        [createStatusDraft(20100 + i * 100, term)]
      );
    }

    const index = new HistorySearchIndexService();
    await index.search({ query: term, limit: 5 }, workspaceRoot);

    const messages: string[] = [];
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };

    let response: HistorySearchResponse;
    try {
      response = await index.search(
        { query: term, limit: 5, offset: 30 },
        workspaceRoot
      );
    } finally {
      Log.info = originalInfo;
    }

    assert.strictEqual(response.offset, 30);
    assert.strictEqual(response.results.length, 5);
    assert.strictEqual(response.totalCount, 35);
    assert.strictEqual(response.countState, "atLeast");

    const extendedLine = messages.find((message) =>
      message.includes("[HistorySearchIndexService] search extended snapshot:")
    );
    assert.ok(extendedLine, messages.join("\n"));
    const newScannedMatch = extendedLine?.match(/newDocumentsScanned=(\d+)/);
    assert.ok(newScannedMatch, extendedLine);
    const newDocumentsScanned = Number(newScannedMatch?.[1]);
    assert.ok(
      newDocumentsScanned <= 31,
      `expected resuming to scan only the ~30 shards past the retained prefix, scanned ${newDocumentsScanned}`
    );
  });

  test("does not lose matches after a resumed scan is cancelled mid-extend", async () => {
    // A resumed scan reuses the retained cursor's dedupe set by reference, so
    // a cancelled extend that had already admitted some matches must put them
    // back — otherwise those documents look "already seen" when the scan is
    // resumed later and never appear in any page again.
    const term = "cancelled-extend-term";
    const totalRuns = 40;
    for (let i = 0; i < totalRuns; i += 1) {
      await createRun(
        `cancelled-extend-run-${i}-2026-06-09T22-34-00`,
        1,
        26000 + i * 100,
        [createStatusDraft(26050 + i * 100, term)]
      );
    }

    const index = new HistorySearchIndexService();
    const firstPage = await index.search(
      { query: term, limit: 5 },
      workspaceRoot
    );
    assert.strictEqual(firstPage.countState, "atLeast");

    // Abort from the first partial push: by then the extend has finalized at
    // least one `startedAt` group, so its dedupe keys are already in the
    // shared set when the cancellation lands.
    const controller = new AbortController();
    await assert.rejects(
      index.search(
        { query: term, limit: 5, offset: 30 },
        workspaceRoot,
        undefined,
        controller.signal,
        () => controller.abort()
      ),
      (error: unknown) => error instanceof HistorySearchCancelledError
    );

    const full = await index.search({ query: term, limit: 100 }, workspaceRoot);
    assert.strictEqual(full.countState, "exact");
    assert.strictEqual(full.totalCount, totalRuns);
    assert.strictEqual(full.results.length, totalRuns);
  });

  test("matches a full scan's ordering and dedupe for the same query when paged incrementally", async () => {
    // Runs b/c tie on startedAt (a multi-shard group early termination must
    // finish before stopping), and d records the same response twice at the
    // same attempt (a dedupe case that must collapse to one result whether
    // the scan stops early or runs to completion).
    const term = "dedupe-consistency-term";
    await createRun("dedupe-consistency-b-2026-06-09T22-32-00", 1, 4000, [
      createStatusDraft(4100, term),
    ]);
    await createRun("dedupe-consistency-c-2026-06-09T22-32-01", 1, 4000, [
      createStatusDraft(4050, term),
    ]);
    await createRun("dedupe-consistency-d-2026-06-09T22-32-02", 1, 3000, [
      createCliOutputDraft(
        3100,
        HARNESS_IDS.CLAUDE_CLI,
        `${term} duplicate content`,
        0
      ),
      createCliOutputDraft(
        3150,
        HARNESS_IDS.CLAUDE_CLI,
        `${term} duplicate content`,
        0
      ),
    ]);
    await createRun("dedupe-consistency-a-2026-06-09T22-32-03", 1, 2000, [
      createStatusDraft(2100, term),
    ]);

    const fullIndex = new HistorySearchIndexService();
    const fullResponse = await fullIndex.search(
      { query: term, limit: 100 },
      workspaceRoot
    );
    assert.strictEqual(fullResponse.countState, "exact");
    assert.strictEqual(fullResponse.totalCount, 4);

    const earlyIndex = new HistorySearchIndexService();
    const collected: HistorySearchResponse["results"] = [];
    for (let offset = 0; ; offset += 1) {
      const page = await earlyIndex.search(
        { query: term, limit: 1, offset },
        workspaceRoot
      );
      if (page.results.length === 0) {
        break;
      }
      collected.push(...page.results);
      if (!page.hasMore) {
        break;
      }
    }

    assert.deepStrictEqual(collected, fullResponse.results);
  });

  test("preserves timestamp and sequence ordering within a run", async () => {
    await createRun("same-run-order-2026-06-09T22-45-00", 1, 4500, [
      createStatusDraft(4510, "same-run-order-term older"),
      createStatusDraft(4520, "same-run-order-term newer first"),
      createStatusDraft(4520, "same-run-order-term newer second"),
    ]);

    const response = await new HistorySearchIndexService().search(
      { query: "same-run-order-term", limit: 10 },
      workspaceRoot
    );

    assert.strictEqual(response.totalCount, 3);
    assert.match(response.results[0]?.matchSnippet ?? "", /newer second/);
    assert.match(response.results[1]?.matchSnippet ?? "", /newer first/);
    assert.match(response.results[2]?.matchSnippet ?? "", /older/);
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

  test("indexes structured events streamed via cliOutputEventsAppended", async () => {
    const workflowId = "streamed-events-2026-06-09T22-22-00";
    await createRun(workflowId, 1, 3000, [
      createCliOutputEventsAppendedDraft(3050, 0, [
        {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          data: {
            command: "echo hi",
            output: "streamed-appended-term",
            error: "",
          },
        },
      ]),
    ]);

    const index = new HistorySearchIndexService();
    const response = await index.search(
      { query: "streamed-appended-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(response.totalCount, 1);
  });

  test("does not double-count a streamed event once its attempt's completed snapshot supersedes it", async () => {
    const workflowId = "streamed-then-sealed-2026-06-09T22-23-00";
    const structuredEvents: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "echo hi",
          output: "sealed-supersedes-term",
          error: "",
        },
      },
    ];
    await createRun(workflowId, 1, 3000, [
      createCliOutputEventsAppendedDraft(3050, 0, structuredEvents),
      createCliOutputDraft(
        3100,
        HARNESS_IDS.CLAUDE_CLI,
        "",
        0,
        structuredEvents
      ),
    ]);

    const index = new HistorySearchIndexService();
    const response = await index.search(
      { query: "sealed-supersedes-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(response.totalCount, 1);
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

  test("records over-cap and zero counts on full rebuilds", async () => {
    await createRun("over-cap-counted-2026-06-09T22-26-00", 1, 3600, [
      createStatusDraft(3650, "x".repeat(MAX_INDEXED_TEXT_LENGTH + 1)),
    ]);
    await createRun("under-cap-counted-2026-06-09T22-27-00", 1, 3700, [
      createStatusDraft(3750, "short text"),
    ]);

    await runHistorySearchRebuild({
      workspaceFolderPath: workspaceRoot,
      runHistoryLocation: getFrozenRunHistoryLocation(),
    });

    const manifest = await readSearchIndexManifest();
    const countedRun = findIndexedRun(manifest, "over-cap-counted");
    const underCapRun = findIndexedRun(manifest, "under-cap-counted");
    assert.ok(countedRun);
    assert.strictEqual(countedRun.overCapCandidateCount, 1);
    assert.ok(underCapRun);
    assert.strictEqual(underCapRun.overCapCandidateCount, 0);
  });

  test("records over-cap counts on the incremental rebuild path", async () => {
    await createRun("incremental-count-initial-2026-06-09T22-28-00", 1, 3800, [
      createStatusDraft(3850, "short initial text"),
    ]);
    await runHistorySearchRebuild({
      workspaceFolderPath: workspaceRoot,
      runHistoryLocation: getFrozenRunHistoryLocation(),
    });

    await createRun("incremental-count-added-2026-06-09T22-29-00", 1, 3900, [
      createStatusDraft(3950, "y".repeat(MAX_INDEXED_TEXT_LENGTH + 1)),
    ]);
    await runHistorySearchRebuild({
      workspaceFolderPath: workspaceRoot,
      runHistoryLocation: getFrozenRunHistoryLocation(),
    });

    const manifest = await readSearchIndexManifest();
    const addedRun = findIndexedRun(manifest, "incremental-count-added");
    assert.ok(addedRun);
    assert.strictEqual(addedRun.overCapCandidateCount, 1);
  });

  test("keeps a manifest without over-cap counts fresh", async () => {
    await createRun("unknown-count-fresh-2026-06-09T22-30-00", 1, 4000, [
      createStatusDraft(4050, "fresh without count"),
    ]);
    await runHistorySearchRebuild({
      workspaceFolderPath: workspaceRoot,
      runHistoryLocation: getFrozenRunHistoryLocation(),
    });

    const manifestPath = getSearchIndexManifestPath();
    const manifest = await readSearchIndexManifest();
    for (const indexedRun of Object.values(manifest.indexedRuns)) {
      delete indexedRun.overCapCandidateCount;
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const freshness = await checkHistorySearchIndexFreshness(
      workspaceRoot,
      manifest
    );
    assert.strictEqual(freshness.fresh, true);
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

  test("reports a run added after the manifest was built", async () => {
    await createRun("diff-added-initial-2026-06-09T23-00-00", 1, 8000, [
      createStatusDraft(8100, "diff-added-initial-term"),
    ]);
    const manifest = await createIndexManifestFixture();
    await createRun("diff-added-new-2026-06-09T23-01-00", 1, 9000, [
      createStatusDraft(9100, "diff-added-new-term"),
    ]);

    const diff = await computeHistorySearchIndexDiff(workspaceRoot, manifest);

    assert.deepStrictEqual(
      diff.newRuns.map((run) => run.manifestPath),
      [
        WorkflowPaths.manifestPath(
          workspaceRoot,
          "diff-added-new-2026-06-09T23-01-00" as WorkflowKey,
          WorkflowPaths.formatRunRef(9000)
        ),
      ]
    );
    assert.strictEqual(diff.changedRuns.length, 0);
    assert.strictEqual(diff.removedManifestPaths.length, 0);
    assert.strictEqual(diff.unchangedManifestPaths.length, 1);
  });

  test("reports a run changed after the manifest was built", async () => {
    await createRun("diff-changed-2026-06-09T23-02-00", 1, 10000, [
      createStatusDraft(10100, "diff-changed-before-term"),
    ]);
    const manifest = await createIndexManifestFixture();
    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);
    await recorder.appendEvents(source.manifestPath, [
      createStatusDraft(10200, "diff-changed-after-term"),
    ]);

    const diff = await computeHistorySearchIndexDiff(workspaceRoot, manifest);

    assert.deepStrictEqual(
      diff.changedRuns.map((run) => run.manifestPath),
      [source.manifestPath]
    );
    assert.strictEqual(diff.newRuns.length, 0);
    assert.strictEqual(diff.removedManifestPaths.length, 0);
    assert.strictEqual(diff.unchangedManifestPaths.length, 0);
  });

  test("reports a manifest entry removed from disk", async () => {
    await createRun("diff-removed-2026-06-09T23-03-00", 1, 11000, [
      createStatusDraft(11100, "diff-removed-term"),
    ]);
    const manifest = await createIndexManifestFixture();
    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);
    await fs.rm(path.dirname(source.manifestPath), { recursive: true });

    const diff = await computeHistorySearchIndexDiff(workspaceRoot, manifest);

    assert.deepStrictEqual(diff.removedManifestPaths, [
      path.resolve(source.manifestPath),
    ]);
    assert.strictEqual(diff.newRuns.length, 0);
    assert.strictEqual(diff.changedRuns.length, 0);
    assert.strictEqual(diff.unchangedManifestPaths.length, 0);
  });

  test("reports an unchanged run only in unchangedManifestPaths", async () => {
    await createRun("diff-unchanged-2026-06-09T23-04-00", 1, 12000, [
      createStatusDraft(12100, "diff-unchanged-term"),
    ]);
    const manifest = await createIndexManifestFixture();
    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);

    const diff = await computeHistorySearchIndexDiff(workspaceRoot, manifest);

    assert.deepStrictEqual(diff.unchangedManifestPaths, [
      path.resolve(source.manifestPath),
    ]);
    assert.strictEqual(diff.newRuns.length, 0);
    assert.strictEqual(diff.changedRuns.length, 0);
    assert.strictEqual(diff.removedManifestPaths.length, 0);
  });

  test("incrementally indexes a new run without rewriting untouched shards", async () => {
    await createRun("incremental-new-first-2026-06-09T23-05-00", 1, 13000, [
      createStatusDraft(13100, "incremental-untouched-first-term"),
    ]);
    await createRun("incremental-new-second-2026-06-09T23-06-00", 1, 14000, [
      createStatusDraft(14100, "incremental-untouched-second-term"),
    ]);
    await createRun("incremental-new-third-2026-06-09T23-07-00", 1, 15000, [
      createStatusDraft(15100, "incremental-untouched-third-term"),
    ]);

    const index = new HistorySearchIndexService();
    await index.search(
      { query: "incremental-untouched-first-term", limit: 10 },
      workspaceRoot
    );
    const indexDir = path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
    const initialSources = await listRunSources(workspaceRoot);
    const initialShardStats = new Map(
      await Promise.all(
        initialSources.map(
          async (source) =>
            [
              source.manifestPath,
              (
                await fs.stat(
                  getDocumentsShardPath(indexDir, source.manifestPath)
                )
              ).mtimeMs,
            ] as const
        )
      )
    );

    await createRun("incremental-new-added-2026-06-09T23-08-00", 1, 16000, [
      createStatusDraft(16100, "incremental-new-term"),
    ]);
    const onDiskManifest = JSON.parse(
      await fs.readFile(path.join(indexDir, "manifest.json"), "utf8")
    ) as HistorySearchIndexManifest;
    const pendingDiff = await computeHistorySearchIndexDiff(
      workspaceRoot,
      onDiskManifest
    );
    assert.strictEqual(pendingDiff.newRuns.length, 1);
    assert.strictEqual(pendingDiff.changedRuns.length, 0);
    assert.strictEqual(pendingDiff.removedManifestPaths.length, 0);
    assert.strictEqual(pendingDiff.unchangedManifestPaths.length, 3);
    await index.enqueueWorkspaceRefresh(workspaceRoot);

    const currentSources = await listRunSources(workspaceRoot);
    assert.strictEqual(currentSources.length, 4);
    for (const source of initialSources) {
      assert.strictEqual(
        (await fs.stat(getDocumentsShardPath(indexDir, source.manifestPath)))
          .mtimeMs,
        initialShardStats.get(source.manifestPath)
      );
    }
    assert.ok(
      await fs.stat(
        getDocumentsShardPath(
          indexDir,
          currentSources.find((source) =>
            source.manifestPath.includes("incremental-new-added")
          )!.manifestPath
        )
      )
    );

    const response = await index.search(
      { query: "incremental-new-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(response.totalCount, 1);
  });

  test("incrementally removes a missing run shard and manifest entry", async () => {
    await createRun("incremental-remove-kept-2026-06-09T23-09-00", 1, 17000, [
      createStatusDraft(17100, "incremental-kept-term"),
    ]);
    await createRun("incremental-remove-target-2026-06-09T23-10-00", 1, 18000, [
      createStatusDraft(18100, "incremental-removed-term"),
    ]);
    await createRun("incremental-remove-other-2026-06-09T23-11-00", 1, 19000, [
      createStatusDraft(19100, "incremental-other-term"),
    ]);

    const index = new HistorySearchIndexService();
    await index.search(
      { query: "incremental-removed-term", limit: 10 },
      workspaceRoot
    );
    const removedSource = (await listRunSources(workspaceRoot)).find((source) =>
      source.manifestPath.includes("incremental-remove-target")
    );
    assert.ok(removedSource);
    const indexDir = path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
    const removedShardPath = getDocumentsShardPath(
      indexDir,
      removedSource.manifestPath
    );
    await fs.rm(path.dirname(removedSource.manifestPath), {
      recursive: true,
      force: true,
    });

    await index.enqueueWorkspaceRefresh(workspaceRoot);

    await assert.rejects(fs.stat(removedShardPath), /ENOENT/);
    const manifest = JSON.parse(
      await fs.readFile(path.join(indexDir, "manifest.json"), "utf8")
    ) as HistorySearchIndexManifest;
    assert.ok(!manifest.indexedRuns[path.resolve(removedSource.manifestPath)]);
    const removedResponse = await index.search(
      { query: "incremental-removed-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(removedResponse.totalCount, 0);
    const keptResponse = await index.search(
      { query: "incremental-kept-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(keptResponse.totalCount, 1);
  });

  test("falls back to a full rebuild when more than half the runs change", async () => {
    await createRun("incremental-ratio-first-2026-06-09T23-12-00", 1, 20000, [
      createStatusDraft(20100, "incremental-ratio-first-term"),
    ]);
    await createRun("incremental-ratio-second-2026-06-09T23-13-00", 1, 21000, [
      createStatusDraft(21100, "incremental-ratio-second-term"),
    ]);
    await createRun("incremental-ratio-third-2026-06-09T23-14-00", 1, 22000, [
      createStatusDraft(22100, "incremental-ratio-third-term"),
    ]);

    await new HistorySearchIndexService().search(
      { query: "incremental-ratio-first-term", limit: 10 },
      workspaceRoot
    );
    const sources = await listRunSources(workspaceRoot);
    const changedSources = sources.filter((source) =>
      /incremental-ratio-(first|second)/.test(source.manifestPath)
    );
    for (const source of changedSources) {
      await recorder.appendEvents(source.manifestPath, [
        createStatusDraft(23000, "incremental-ratio-changed-term"),
      ]);
    }

    const messages: string[] = [];
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };
    try {
      await runHistorySearchRebuild({
        workspaceFolderPath: workspaceRoot,
        runHistoryLocation: getFrozenRunHistoryLocation(),
      });
    } finally {
      Log.info = originalInfo;
    }

    assert.ok(
      messages.some((message) =>
        message.includes("rebuild path: full-rebuild-fallback")
      ),
      messages.join("\n")
    );
  });

  test("returns correct results after a mixed incremental rebuild", async () => {
    await createRun(
      "incremental-mixed-untouched-1-2026-06-09T23-15-00",
      1,
      24000,
      [createStatusDraft(24100, "incremental-mixed-untouched-term")]
    );
    await createRun(
      "incremental-mixed-untouched-2-2026-06-09T23-16-00",
      1,
      25000,
      [createStatusDraft(25100, "incremental-mixed-second-untouched-term")]
    );
    await createRun(
      "incremental-mixed-untouched-3-2026-06-09T23-17-00",
      1,
      26000,
      [createStatusDraft(26100, "incremental-mixed-third-untouched-term")]
    );
    await createRun(
      "incremental-mixed-untouched-4-2026-06-09T23-18-00",
      1,
      27000,
      [createStatusDraft(27100, "incremental-mixed-fourth-untouched-term")]
    );
    await createRun("incremental-mixed-changed-2026-06-09T23-19-00", 1, 28000, [
      createStatusDraft(28100, "incremental-mixed-before-term"),
    ]);
    await createRun("incremental-mixed-removed-2026-06-09T23-20-00", 1, 29000, [
      createStatusDraft(29100, "incremental-mixed-removed-term"),
    ]);

    const index = new HistorySearchIndexService();
    await index.search(
      { query: "incremental-mixed-before-term", limit: 10 },
      workspaceRoot
    );
    const sources = await listRunSources(workspaceRoot);
    const changedSource = sources.find((source) =>
      source.manifestPath.includes("incremental-mixed-changed")
    );
    const removedSource = sources.find((source) =>
      source.manifestPath.includes("incremental-mixed-removed")
    );
    assert.ok(changedSource);
    assert.ok(removedSource);
    await recorder.appendEvents(changedSource.manifestPath, [
      createStatusDraft(29200, "incremental-mixed-after-term"),
    ]);
    await fs.rm(path.dirname(removedSource.manifestPath), {
      recursive: true,
      force: true,
    });
    await createRun("incremental-mixed-new-2026-06-09T23-21-00", 1, 30000, [
      createStatusDraft(30100, "incremental-mixed-new-term"),
    ]);

    await index.enqueueWorkspaceRefresh(workspaceRoot);

    for (const query of [
      "incremental-mixed-after-term",
      "incremental-mixed-new-term",
      "incremental-mixed-untouched-term",
    ]) {
      const response = await index.search({ query, limit: 10 }, workspaceRoot);
      assert.strictEqual(response.totalCount, 1, query);
    }
    const removedResponse = await index.search(
      { query: "incremental-mixed-removed-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(removedResponse.totalCount, 0);
  });

  test("returns complete results after an incremental rebuild", async () => {
    await createRun("splice-existing-2026-06-09T23-30-00", 1, 20000, [
      createStatusDraft(20100, "splice-existing-term"),
    ]);

    const index = new HistorySearchIndexService();
    await index.search(
      { query: "splice-existing-term", limit: 10 },
      workspaceRoot
    );

    await createRun("splice-added-2026-06-09T23-31-00", 1, 21000, [
      createStatusDraft(21100, "splice-added-term"),
    ]);

    const addedResponse = await index.search(
      { query: "splice-added-term", limit: 10 },
      workspaceRoot
    );
    const existingResponse = await index.search(
      { query: "splice-existing-term", limit: 10 },
      workspaceRoot
    );

    assert.strictEqual(addedResponse.totalCount, 1);
    assert.strictEqual(existingResponse.totalCount, 1);
  });

  test("skips a redundant rebuild after waiting for a sibling and returns results", async () => {
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

  test("serves matches from the document cache without re-reading the shard", async () => {
    const workflowId = "doc-cache-hit-2026-09-19T00-00-00";
    await createRun(workflowId, 1, 40000, [
      createStatusDraft(40100, "doc-cache-warm-term"),
      createStatusDraft(40200, "doc-cache-second-term"),
    ]);

    const index = new HistorySearchIndexService();
    const warm = await index.search(
      { query: "doc-cache-warm-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(warm.totalCount, 1);

    // Empty the on-disk shard without removing it. The shard must stay in the
    // directory listing, because that listing — not the cache — decides which
    // runs a scan visits at all: a cache that resurrected a shard the index no
    // longer lists would report runs the index does not contain, so deleting
    // the file would prove the wrong thing. With the file listed but empty, a
    // disk read yields no documents, and the run's own run-storage manifest
    // (which freshness checks against) is untouched so nothing triggers a
    // rebuild. The only way the second query below still finds a match is the
    // in-memory document cache the first search populated.
    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);
    const indexDir = path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
    await fs.writeFile(
      getDocumentsShardPath(indexDir, source.manifestPath),
      "",
      "utf8"
    );

    const second = await index.search(
      { query: "doc-cache-second-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(second.totalCount, 1);
  });

  test("evicts a rewritten run's cached documents after an incremental rebuild", async () => {
    await createRun("doc-cache-invalidate-2026-09-19T00-01-00", 1, 41000, [
      createStatusDraft(41100, "doc-cache-invalidate-before-term"),
    ]);

    const index = new HistorySearchIndexService();
    const before = await index.search(
      { query: "doc-cache-invalidate-before-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(before.totalCount, 1);

    const source = (await listRunSources(workspaceRoot))[0];
    assert.ok(source);
    await recorder.appendEvents(source.manifestPath, [
      createStatusDraft(41200, "doc-cache-invalidate-after-term"),
    ]);
    await index.enqueueWorkspaceRefresh(workspaceRoot);

    // If the cached (pre-append) document list for this run had survived the
    // rebuild instead of being evicted, this would still find nothing.
    const after = await index.search(
      { query: "doc-cache-invalidate-after-term", limit: 10 },
      workspaceRoot
    );
    assert.strictEqual(after.totalCount, 1);
  });

  test("a zero-MB history search cache setting disables caching cleanly", async () => {
    const workflowId = "doc-cache-disabled-2026-09-19T00-02-00";
    await createRun(workflowId, 1, 42000, [
      createStatusDraft(42100, "doc-cache-disabled-warm-term"),
      createStatusDraft(42200, "doc-cache-disabled-second-term"),
    ]);

    const originalGetBudget =
      ConfigurationUtils.getHistorySearchCacheBudgetBytes;
    ConfigurationUtils.getHistorySearchCacheBudgetBytes = () => 0;
    try {
      const index = new HistorySearchIndexService();
      const warm = await index.search(
        { query: "doc-cache-disabled-warm-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(warm.totalCount, 1);

      const source = (await listRunSources(workspaceRoot))[0];
      assert.ok(source);
      const indexDir = path.join(
        projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
        PATH_CONSTANTS.SEARCH_INDEX_DIR
      );
      await fs.rm(getDocumentsShardPath(indexDir, source.manifestPath));

      // With caching disabled, a query needing this run's documents must go
      // back to disk and find the shard gone, rather than serving a cached
      // copy — the mirror image of the cache-hit test above.
      const second = await index.search(
        { query: "doc-cache-disabled-second-term", limit: 10 },
        workspaceRoot
      );
      assert.strictEqual(second.totalCount, 0);
    } finally {
      ConfigurationUtils.getHistorySearchCacheBudgetBytes = originalGetBudget;
    }
  });

  async function readSearchIndexManifest(): Promise<HistorySearchIndexManifest> {
    return JSON.parse(
      await fs.readFile(getSearchIndexManifestPath(), "utf8")
    ) as HistorySearchIndexManifest;
  }

  function getSearchIndexManifestPath(): string {
    return path.join(
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR,
      "manifest.json"
    );
  }

  function findIndexedRun(
    manifest: HistorySearchIndexManifest,
    workflowIdFragment: string
  ): HistorySearchIndexManifest["indexedRuns"][string] | undefined {
    return Object.values(manifest.indexedRuns).find((indexedRun) =>
      indexedRun.workflowId.includes(workflowIdFragment)
    );
  }

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

  async function createIndexManifestFixture(): Promise<HistorySearchIndexManifest> {
    const indexedRuns: Record<
      string,
      {
        manifestPath: string;
        eventsPath: string;
        workflowId: string;
        runId: number;
        startedAt: number;
        eventCount: number;
        lastUpdatedAt: number;
        sourceManifestMtimeMs: number;
        sourceEventsMtimeMs: number;
      }
    > = {};
    for (const source of await listRunSources(workspaceRoot)) {
      const runManifest: WorkflowRunManifest = await recorder.readManifest(
        source.manifestPath
      );
      const [manifestStats, eventsStats] = await Promise.all([
        fs.stat(source.manifestPath),
        fs.stat(source.eventsPath),
      ]);
      indexedRuns[path.resolve(source.manifestPath)] = {
        manifestPath: source.manifestPath,
        eventsPath: source.eventsPath,
        workflowId: runManifest.workflowId,
        runId: runManifest.runId,
        startedAt: runManifest.startedAt,
        eventCount: runManifest.eventCount,
        lastUpdatedAt: runManifest.lastUpdatedAt,
        sourceManifestMtimeMs: manifestStats.mtimeMs,
        sourceEventsMtimeMs: eventsStats.mtimeMs,
      };
    }
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      builtAt: Date.now(),
      workspaceRootHash: "fixture-workspace-hash",
      indexedRuns,
    };
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

  function createCliOutputEventsAppendedDraft(
    timestampMs: number,
    attemptIndex: number,
    events: CliEvent[]
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      timestampMs,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex,
      payload: { events },
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
