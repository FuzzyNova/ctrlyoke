import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { scanHistoryRunDeep } from "../../core/orchestration/HistoryRunDeepScanner";
import { MAX_INDEXED_TEXT_LENGTH } from "../../core/orchestration/HistorySearchIndexService";
import { projectHistorySearchResult } from "../../core/orchestration/HistorySearchResultUtils";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("HistoryRunDeepScanner", () => {
  const tempDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      tempDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  test("yields a term that exists only past the indexed cap", async () => {
    const run = await createRun(
      `prefix ${"x".repeat(2400)} hidden-term suffix`
    );

    const documents = await collect(run, "hidden-term");

    assert.strictEqual(documents.length, 1);
    assert.ok(documents[0].text.includes("hidden-term"));
  });

  test("does not yield a term found in the indexed prefix", async () => {
    const run = await createRun(`visible-term ${"x".repeat(2400)}`);

    assert.deepStrictEqual(await collect(run, "visible-term"), []);
  });

  test("does not yield a candidate when the prefix hit wins", async () => {
    const run = await createRun(
      `visible-term ${"x".repeat(2400)} visible-term`
    );

    assert.deepStrictEqual(await collect(run, "visible-term"), []);
  });

  test("bounds yielded text while retaining snippet context", async () => {
    const run = await createRun(
      `${"left-context ".repeat(180)} hidden-term ${"right-context ".repeat(180)}`
    );

    const documents = await collect(run, "hidden-term");
    assert.strictEqual(documents.length, 1);
    assert.ok(documents[0].text.length < MAX_INDEXED_TEXT_LENGTH);
    assert.ok(documents[0].text.startsWith("…") === false);
    const result = projectHistorySearchResult(documents[0], "hidden-term");
    assert.ok(result.matchSnippet.startsWith("…"));
    assert.ok(result.matchSnippet.endsWith("…"));
  });

  test("stops between events when aborted", async () => {
    const run = await createRun(
      Array.from(
        { length: 20 },
        (_, index) => `${"x".repeat(2400)} hidden-term-${index}`
      )
    );
    const controller = new AbortController();
    const documents: Awaited<ReturnType<typeof collect>> = [];

    for await (const document of scanHistoryRunDeep(
      run.workspaceRoot,
      run.manifestPath,
      "hidden-term",
      async () => "Deep Scan",
      controller.signal
    )) {
      documents.push(document);
      controller.abort();
    }

    assert.strictEqual(documents.length, 1);
  });

  test("tolerates a missing events file", async () => {
    const run = await createRun("hidden-term");
    await fs.rm(
      WorkflowPaths.eventsPath(run.workspaceRoot, run.workflowKey, run.runRef)
    );

    assert.deepStrictEqual(await collect(run, "hidden-term"), []);
  });

  interface TestRun {
    workspaceRoot: string;
    workflowKey: WorkflowKey;
    runRef: RunRef;
    manifestPath: string;
  }

  async function createRun(content: string | string[]): Promise<TestRun> {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-deep-")
    );
    tempDirectories.push(workspaceRoot);
    const workflowKey = "deep-scan-workflow" as WorkflowKey;
    const runRef = WorkflowPaths.formatRunRef(Date.now()) as RunRef;
    const runDirectory = WorkflowPaths.runDir(
      workspaceRoot,
      workflowKey,
      runRef
    );
    await fs.mkdir(runDirectory, { recursive: true });
    const recorder = new TimelineRecorder();
    const manifestPath = await recorder.initializeRunAt(
      runDirectory,
      workflowKey,
      1,
      Date.now(),
      EXECUTION_STATES.COMPLETED
    );
    const contents = Array.isArray(content) ? content : [content];
    await recorder.appendEvents(
      manifestPath,
      contents.map((text) => ({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: Date.now(),
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        payload: {
          cliOutput: createCliOutput(text),
        },
      }))
    );
    return { workspaceRoot, workflowKey, runRef, manifestPath };
  }

  async function collect(run: TestRun, query: string) {
    const documents = [];
    for await (const document of scanHistoryRunDeep(
      run.workspaceRoot,
      run.manifestPath,
      query,
      async () => "Deep Scan"
    )) {
      documents.push(document);
    }
    return documents;
  }

  function createCliOutput(response: string): CliOutput {
    return {
      prompt: "prompt",
      response,
      elapsed: 1,
      isStreaming: false,
    };
  }
});
