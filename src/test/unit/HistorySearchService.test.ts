import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HistorySearchService } from "../../core/orchestration/HistorySearchService";
import {
  HistorySearchCancelledError,
  HistorySearchIndexService,
} from "../../core/orchestration/HistorySearchIndexService";
import { Log } from "../../utils/Log";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HISTORY_MATCH_FIELDS,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/DashboardConstants";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import { getSearchIndexDir } from "../../core/orchestration/HistorySearchIndexLayout";
import { getFrozenRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";

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
    await fs.mkdir(WorkflowPaths.runsRoot(workspaceRoot), {
      recursive: true,
    });
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("returns newest matches first with queue metadata and stable run addresses", async () => {
    const workflowId = "demo-2026-06-09T17-00-00";
    await writeWorkingFile(workflowId, {
      workflowName: "Demo Workflow",
      originalFile: "C:\\dev\\ctrlyoke\\demo.ctrlyoke.yaml",
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
    assert.strictEqual(results[0]?.workflowKey, workflowId);
    assert.strictEqual(results[0]?.runRef, WorkflowPaths.formatRunRef(2000));
    assert.strictEqual(results[0]?.workflowName, "Demo Workflow");
    assert.strictEqual(results[0]?.eventKind, "status");
    assert.strictEqual(results[0]?.matchField, "content");
    assert.strictEqual(results[0]?.matchContext, "Prompt 2");

    assert.strictEqual(results[1]?.startedAt, 1000);
    assert.strictEqual(results[1]?.workflowKey, workflowId);
    assert.strictEqual(results[1]?.runRef, WorkflowPaths.formatRunRef(1000));
    assert.strictEqual(results[1]?.eventKind, "response");
    assert.strictEqual(results[1]?.matchField, "content");
    assert.strictEqual(results[1]?.matchContext, "Prompt 1");

    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowId as WorkflowKey
    );
    const descriptor = JSON.parse(
      await fs.readFile(descriptorPath, "utf8")
    ) as WorkflowLineageDescriptor;
    descriptor.workflowName = "Renamed Demo";
    await fs.writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    const renamedResults = await service.search("needle", workspaceRoot);
    assert.deepStrictEqual(
      renamedResults.results.map((result) => result.workflowName),
      ["Renamed Demo", "Renamed Demo"]
    );
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
                  parameters: { prompt: "mcp-parameter-term" },
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
    assert.strictEqual(bashResults[0]?.eventKind, "bash");
    assert.strictEqual(bashResults[0]?.matchField, "command");
    assert.strictEqual(bashResults[0]?.matchContext, "Final Step Loop 2");

    const fileResults = (
      await service.search("src/history-search.ts", workspaceRoot)
    ).results;
    assert.strictEqual(fileResults[0]?.eventKind, "fileEdit");
    assert.strictEqual(fileResults[0]?.matchField, "path");
    assert.strictEqual(fileResults[0]?.filePath, "src/history-search.ts");
    assert.strictEqual(fileResults[0]?.workflowName, "orphan");

    const toolResults = (
      await service.search("tool-result-term", workspaceRoot)
    ).results;
    assert.strictEqual(toolResults[0]?.eventKind, "tool");
    assert.strictEqual(toolResults[0]?.matchField, "output");

    const mcpParameterResults = (
      await service.search("mcp-parameter-term", workspaceRoot)
    ).results;
    assert.strictEqual(mcpParameterResults[0]?.eventKind, "mcpTool");
    assert.strictEqual(mcpParameterResults[0]?.matchField, "content");

    const diffResults = (await service.search("diff-term", workspaceRoot))
      .results;
    assert.strictEqual(diffResults[0]?.eventKind, "fileEdit");
    assert.strictEqual(diffResults[0]?.matchField, "diff");
    assert.strictEqual(diffResults[0]?.filePath, "src/history-search.ts");
  });

  test("disk-scan fallback indexes structured events streamed via cliOutputEventsAppended", async () => {
    const workflowId = "streamed-events-fallback-2026-06-09T22-24-00";
    await createRun(workflowId, 1, 1000, [
      createCliOutputEventsAppendedDraft(
        1050,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        0,
        [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            data: {
              command: "echo hi",
              output: "fallback-appended-term",
              error: "",
            },
          },
        ]
      ),
    ]);

    const legacyResults = await (
      service as unknown as {
        searchLegacy: (
          query: string,
          workspaceFolderPath: string,
          limit: number,
          filters: undefined
        ) => Promise<Array<{ matchField: string }>>;
      }
    ).searchLegacy("fallback-appended-term", workspaceRoot, 50, undefined);

    assert.strictEqual(legacyResults.length, 1);
    assert.strictEqual(legacyResults[0]?.matchField, "output");
  });

  test("disk-scan fallback applies the regex matcher", async () => {
    const workflowId = "regex-fallback-2026-06-09T22-25-00";
    await createRun(workflowId, 1, 1100, [
      createStatusDraft(
        1150,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "fallback ERROR: 404"
      ),
    ]);

    const legacyResults = await (
      service as unknown as {
        searchLegacy: (
          query: string,
          workspaceFolderPath: string,
          limit: number,
          filters: undefined,
          snippetChars: undefined,
          regex: boolean
        ) => Promise<Array<{ matchSnippet: string }>>;
      }
    ).searchLegacy(
      "error[: ]+\\d+",
      workspaceRoot,
      50,
      undefined,
      undefined,
      true
    );

    assert.strictEqual(legacyResults.length, 1);
    assert.ok(legacyResults[0]?.matchSnippet.includes("ERROR: 404"));
  });

  test("returns no results for short queries", async () => {
    const response = await service.search("a", workspaceRoot);
    assert.deepStrictEqual(response.results, []);
    assert.strictEqual(response.totalCount, 0);
  });

  test("does not rebuild when rebuilds are disallowed", async () => {
    const workflowId = "no-rebuild-2026-06-09T19-01-00";
    await createRun(workflowId, 1, 1500, [
      createStatusDraft(
        1600,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "no-rebuild-term"
      ),
    ]);

    const response = await service.search(
      "no-rebuild-term",
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      {
        allowRebuild: false,
      }
    );

    assert.deepStrictEqual(response.results, []);
    assert.strictEqual(response.indexState, "building");
    await assert.rejects(
      fs.access(
        path.join(
          getSearchIndexDir(workspaceRoot, getFrozenRunHistoryLocation()),
          "manifest.json"
        )
      ),
      /ENOENT/
    );
  });

  test("can refuse the legacy fallback while preserving cancellation", async () => {
    const originalSearch = HistorySearchIndexService.prototype.search;
    HistorySearchIndexService.prototype.search = async () => {
      throw new Error("synthetic index failure");
    };

    try {
      await assert.rejects(
        service.search(
          "fallback-refusal-term",
          workspaceRoot,
          undefined,
          undefined,
          undefined,
          { allowLegacyFallback: false }
        ),
        /synthetic index failure/
      );

      const controller = new AbortController();
      controller.abort();
      HistorySearchIndexService.prototype.search = async () => {
        throw new HistorySearchCancelledError();
      };
      await assert.rejects(
        service.search(
          "fallback-cancelled-term",
          workspaceRoot,
          undefined,
          controller.signal,
          undefined,
          { allowLegacyFallback: false }
        ),
        (error: unknown) => error instanceof HistorySearchCancelledError
      );
    } finally {
      HistorySearchIndexService.prototype.search = originalSearch;
    }
  });

  test("widens snippets through the service while preserving the default", async () => {
    const workflowId = "snippet-width-2026-06-09T19-02-00";
    await createRun(workflowId, 1, 1700, [
      createCliOutputDraft(
        1800,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "",
          response: `${"a".repeat(80)}snippet-width-term${"b".repeat(90)}`,
          elapsed: 1,
          isStreaming: false,
        }
      ),
    ]);

    const defaultResult = (
      await service.search("snippet-width-term", workspaceRoot)
    ).results[0];
    const explicitDefaultResult = (
      await service.search(
        { query: "snippet-width-term", limit: 50 },
        workspaceRoot,
        undefined,
        undefined,
        undefined,
        { snippetChars: 100 }
      )
    ).results[0];
    const widenedResult = (
      await service.search(
        { query: "snippet-width-term", limit: 50 },
        workspaceRoot,
        undefined,
        undefined,
        undefined,
        { snippetChars: 200 }
      )
    ).results[0];

    assert.strictEqual(
      defaultResult?.matchSnippet,
      explicitDefaultResult?.matchSnippet
    );
    assert.ok(
      (widenedResult?.matchSnippet.length ?? 0) >
        (defaultResult?.matchSnippet.length ?? 0)
    );
  });

  test("keeps file operation kinds distinct and indexes edit paths and diffs", async () => {
    const workflowId = "file-kinds-2026-06-09T20-00-00";
    const sharedPath = "src/edited-content-term.ts";
    await createRun(workflowId, 1, 4000, [
      createCliOutputDraft(
        4100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "",
          response: "",
          elapsed: 1,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_READ,
                data: { path: sharedPath },
              },
              {
                type: CLI_EVENT_TYPES.FILE_WRITE,
                data: { path: sharedPath, content: "written-content-term" },
              },
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: sharedPath,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-old", "+edited-content-term"],
                    },
                  ],
                },
              },
              {
                type: CLI_EVENT_TYPES.FILE_DELETE,
                data: { path: sharedPath },
              },
            ],
            metadata: {},
          },
        }
      ),
    ]);

    const pathResults = (await service.search(sharedPath, workspaceRoot))
      .results;
    assert.deepStrictEqual(
      pathResults.map((result) => result.eventKind).sort(),
      ["fileDelete", "fileEdit", "fileRead", "fileWrite"]
    );
    assert.ok(
      pathResults.every(
        (result) => result.matchField === HISTORY_MATCH_FIELDS.PATH
      )
    );

    const editResults = (
      await service.search("edited-content-term", workspaceRoot)
    ).results;
    assert.deepStrictEqual(
      editResults
        .filter((result) => result.eventKind === "fileEdit")
        .map((result) => result.matchField)
        .sort(),
      ["diff", "path"]
    );

    const filteredEditResults = (
      await service.search(
        {
          query: sharedPath,
          limit: 50,
          filters: { eventKinds: ["fileEdit"] },
        },
        workspaceRoot
      )
    ).results;
    assert.strictEqual(filteredEditResults.length, 1);
    assert.strictEqual(filteredEditResults[0]?.eventKind, "fileEdit");
    assert.strictEqual(filteredEditResults[0]?.matchField, "path");

    const writeResults = (
      await service.search("written-content-term", workspaceRoot)
    ).results;
    assert.strictEqual(writeResults.length, 1);
    assert.strictEqual(writeResults[0]?.eventKind, "fileWrite");
    assert.strictEqual(writeResults[0]?.matchField, "content");
  });

  test("indexes script output with its source kind", async () => {
    const workflowId = "script-kinds-2026-06-09T21-00-00";
    await createRun(workflowId, 1, 5000, [
      createCliOutputDraft(
        5100,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "",
          response: "shared script stdout term",
          cliCommand: "script-command-term",
          source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
          elapsed: 1,
          isStreaming: false,
        }
      ),
      createCliOutputDraft(
        5200,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        {
          prompt: "",
          response: "shared script stdout term",
          cliCommand: "pre-condition-command-term",
          source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
          elapsed: 1,
          isStreaming: false,
        }
      ),
      createCliOutputDraft(
        5300,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
        {
          prompt: "",
          response: "shared script stdout term",
          cliCommand: "end-condition-command-term",
          source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
          elapsed: 1,
          isStreaming: false,
        }
      ),
    ]);

    const stdoutResults = (
      await service.search("shared script stdout term", workspaceRoot)
    ).results;
    assert.deepStrictEqual(
      stdoutResults.map((result) => result.eventKind).sort(),
      ["endCondition", "preCondition", "script"]
    );
    assert.ok(
      stdoutResults.every(
        (result) => result.matchField === HISTORY_MATCH_FIELDS.OUTPUT
      )
    );
    assert.ok(stdoutResults.every((result) => result.eventKind !== "response"));

    const commandResults = (
      await service.search("end-condition-command-term", workspaceRoot)
    ).results;
    assert.strictEqual(commandResults.length, 1);
    assert.strictEqual(commandResults[0]?.eventKind, "endCondition");
    assert.strictEqual(commandResults[0]?.matchField, "command");
  });

  test("returns accurate counts and stable offset pages", async () => {
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
    assert.strictEqual(firstPage.offset, 0);
    assert.strictEqual(firstPage.results[0]?.matchContext, "Prompt 3");

    const secondPage = await service.search(
      { query: "needle", limit: 2, offset: 2 },
      workspaceRoot
    );

    assert.strictEqual(secondPage.totalCount, 3);
    assert.strictEqual(secondPage.results.length, 1);
    assert.strictEqual(secondPage.hasMore, false);
    assert.strictEqual(secondPage.results[0]?.matchContext, "Prompt 1");
  });

  test("deduplicates cumulative structured output snapshots before pagination", async () => {
    const workflowId = "streaming-snapshots-2026-06-09T18-30-00";
    await writeWorkingFile(workflowId, {
      workflowName: "Streaming Snapshots",
    });

    const repeatedToolResult: CliEvent = {
      type: CLI_EVENT_TYPES.TOOL_RESULT,
      data: {
        toolCallId: "tool-1",
        result: {
          success: true,
          output: "snapshot-needle tool output",
        },
      },
    };
    const fileEdit: CliEvent = {
      type: CLI_EVENT_TYPES.FILE_EDIT,
      data: {
        path: "src/snapshot.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+snapshot-needle edit"],
          },
        ],
      },
    };

    await createRun(workflowId, 1, 3500, [
      createCliOutputDraft(
        3510,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "",
          response: "",
          elapsed: 1,
          isStreaming: true,
          structured: {
            events: [repeatedToolResult],
            metadata: {},
          },
        }
      ),
      createCliOutputDraft(
        3520,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          prompt: "",
          response: "",
          elapsed: 1,
          isStreaming: false,
          structured: {
            events: [repeatedToolResult, fileEdit],
            metadata: {},
          },
        }
      ),
    ]);

    const firstPage = await service.search(
      { query: "snapshot-needle", limit: 1 },
      workspaceRoot
    );
    assert.strictEqual(firstPage.totalCount, 2);
    assert.strictEqual(firstPage.results.length, 1);
    assert.strictEqual(firstPage.hasMore, true);
    assert.strictEqual(firstPage.offset, 0);

    const secondPage = await service.search(
      {
        query: "snapshot-needle",
        limit: 1,
        offset: 1,
      },
      workspaceRoot
    );
    assert.strictEqual(secondPage.totalCount, 2);
    assert.strictEqual(secondPage.results.length, 1);
    assert.strictEqual(secondPage.hasMore, false);
    assert.deepStrictEqual(
      [...firstPage.results, ...secondPage.results]
        .map((result) => result.eventKind)
        .sort(),
      ["fileEdit", "tool"]
    );
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
      getSearchIndexDir(workspaceRoot, getFrozenRunHistoryLocation()),
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

  test("propagates a cancelled search instead of falling back to a disk scan", async () => {
    const workflowId = "cancelled-fallback-2026-06-09T19-05-00";
    await writeWorkingFile(workflowId, { workflowName: "Cancelled Workflow" });
    await createRun(workflowId, 1, 1300, [
      createStatusDraft(
        1400,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        "cancelled-fallback-term"
      ),
    ]);

    // Warm the index so the abort under test hits the cheap top-of-method
    // check rather than being incidentally absorbed by a synchronous rebuild.
    await service.search("warm-up-term-not-matched", workspaceRoot);

    const controller = new AbortController();
    controller.abort();

    const messages: string[] = [];
    const originalWarn = Log.warn;
    Log.warn = (message: string) => {
      messages.push(message);
    };

    try {
      await assert.rejects(
        service.search(
          "cancelled-fallback-term",
          workspaceRoot,
          undefined,
          controller.signal
        ),
        (error: unknown) => error instanceof HistorySearchCancelledError
      );
      // A cancellation is not an index failure: it must never fall back to
      // the disk scan, which would spend the exact cost the cancellation was
      // meant to avoid.
      assert.ok(
        !messages.some((message) =>
          message.includes("falling back to disk scan")
        ),
        messages.join("\n")
      );
    } finally {
      Log.warn = originalWarn;
    }
  });

  /** Writes a lineage descriptor directly — the test-only equivalent of WorkflowLineageRepository.createLineage. */
  async function writeWorkingFile(
    workflowId: string,
    overrides: Partial<WorkingFile> & {
      workflowName?: string;
      originalFile?: string;
    }
  ): Promise<void> {
    const workflowKey = workflowId as WorkflowKey;
    await fs.mkdir(WorkflowPaths.lineageDir(workspaceRoot, workflowKey), {
      recursive: true,
    });
    const descriptor: WorkflowLineageDescriptor = {
      schemaVersion: 1,
      workflowKey,
      workflowName: overrides.workflowName ?? workflowId,
      originalFile: overrides.originalFile,
      isFavorite: false,
      createdAt: overrides.startedAt ?? 0,
      lastModifiedAt: overrides.startedAt ?? 0,
      nextRunId: 1,
      revision: 1,
    };
    await fs.writeFile(
      WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
      JSON.stringify(descriptor, null, 2),
      "utf8"
    );
  }

  /** Points an existing descriptor's latestRunRef at `runRef` (mimics WorkflowLineageRepository.allocateRun's bookkeeping). */
  async function setLatestRun(
    workflowId: string,
    runRef: RunRef
  ): Promise<void> {
    const workflowKey = workflowId as WorkflowKey;
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    const descriptor = JSON.parse(
      await fs.readFile(descriptorPath, "utf8")
    ) as WorkflowLineageDescriptor;
    descriptor.latestRunRef = runRef;
    await fs.writeFile(
      descriptorPath,
      JSON.stringify(descriptor, null, 2),
      "utf8"
    );
  }

  async function createRun(
    workflowId: string,
    runId: number,
    startedAt: number,
    events: WorkflowTimelineEventDraft[]
  ): Promise<string> {
    const workflowKey = workflowId as WorkflowKey;
    const runRef = WorkflowPaths.formatRunRef(startedAt);
    const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
    const manifestPath = await recorder.initializeRunAt(
      runDir,
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
      stepCount: 1,
      lastUpdatedAt: startedAt + 10,
    }));

    // Keep the descriptor's latestRunRef current when one exists (tests that
    // never call writeWorkingFile intentionally leave the lineage descriptor-less).
    await fs
      .access(WorkflowPaths.descriptorPath(workspaceRoot, workflowKey))
      .then(
        () => setLatestRun(workflowId, runRef),
        () => {}
      );

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
      cliCommand?: string;
      source?: (typeof SCRIPT_OUTPUT_SOURCES)[keyof typeof SCRIPT_OUTPUT_SOURCES];
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

  function createCliOutputEventsAppendedDraft(
    timestampMs: number,
    target:
      | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
      | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number },
    attemptIndex: number,
    events: CliEvent[]
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
      timestampMs,
      target,
      attemptIndex,
      payload: { events },
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
