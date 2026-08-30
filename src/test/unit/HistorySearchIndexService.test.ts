import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HistorySearchIndexService } from "../../core/orchestration/HistorySearchIndexService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  computeHistorySearchIndexDiff,
  DOCUMENTS_DIR_NAME,
  DOCUMENTS_SHARD_EXTENSION,
  getDocumentsShardPath,
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
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

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
        retainDocuments: false,
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
