/**
 * RunSummaryCache — keeping a per-run cache honest under ctrlyoke's own writers.
 *
 * `getRunSummaries` reads two files per run in the lineage and retention is off
 * by default, so the listing is the one genuinely O(runs) read on a view load.
 * Caching it is only safe if every writer is accounted for: the executor and the
 * dashboard write in-process, the CLI binary and MCP server write from another
 * process entirely, and on Windows two writes inside one ~15.6 ms clock tick
 * share an mtime — which is why stamp validation alone cannot carry this.
 */
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  clearRunSummaryCache,
  invalidateRunSummaryFor,
  lookupRunSummary,
  runSummaryCacheSize,
  stampRunFiles,
  storeRunSummary,
} from "../../core/orchestration/RunSummaryCache";
import type { RunSummaryRecord } from "../../core/orchestration/OutputHistoryManager";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

const MANIFEST = "manifest.json";
const DEFINITION = "workflow.ctrlyoke.json";

function recordFor(runRef: string): RunSummaryRecord {
  return {
    manifestExecutionState: EXECUTION_STATES.COMPLETED,
    summary: {
      workflowKey: "lineage" as WorkflowKey,
      runRef: runRef as RunRef,
      runDirectory: "run-directory",
      runId: 1,
      startedAt: 1_753_000_000_000,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 1,
      hasMixedHarnesses: false,
      hasMixedModels: false,
    },
  };
}

suite("RunSummaryCache", () => {
  let runDir: string;

  setup(async () => {
    clearRunSummaryCache();
    runDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-summary-cache-")
    );
    await fs.writeFile(path.join(runDir, MANIFEST), '{"runId":1}');
    await fs.writeFile(path.join(runDir, DEFINITION), '{"steps":[]}');
  });

  teardown(async () => {
    clearRunSummaryCache();
    await fs.rm(runDir, { recursive: true, force: true });
  });

  async function stampRun(): Promise<
    Awaited<ReturnType<typeof stampRunFiles>>
  > {
    return stampRunFiles(
      path.join(runDir, MANIFEST),
      path.join(runDir, DEFINITION)
    );
  }

  test("serves a record back only while both files are unchanged", async () => {
    const stamp = await stampRun();
    storeRunSummary(runDir, stamp, recordFor("run-a"));

    assert.strictEqual(
      lookupRunSummary(runDir, await stampRun())?.summary.runRef,
      "run-a",
      "an untouched run must hit"
    );
  });

  // Stamp validation is the only mechanism that can see another process write —
  // the CLI binary, the MCP server, or a hand edit. Both halves of the pair
  // matter: a summary discloses harness/model from the definition and lifecycle
  // state from either file.
  for (const changed of [MANIFEST, DEFINITION]) {
    test(`misses after an out-of-process write to ${changed}`, async () => {
      storeRunSummary(runDir, await stampRun(), recordFor("run-a"));

      await fs.writeFile(
        path.join(runDir, changed),
        '{"written":"by another process"}'
      );

      assert.strictEqual(
        lookupRunSummary(runDir, await stampRun()),
        undefined,
        `a changed ${changed} must not serve the cached summary`
      );
      assert.strictEqual(
        runSummaryCacheSize(),
        0,
        "a failed validation must drop the entry, not leave it to be re-tested"
      );
    });
  }

  // A run that never wrote a working file is a real shape — the summary falls
  // back to the manifest. Absent must be a distinguishable state, or the
  // definition appearing later would go unnoticed.
  test("treats a file appearing where there was none as a change", async () => {
    await fs.rm(path.join(runDir, DEFINITION));
    storeRunSummary(runDir, await stampRun(), recordFor("run-a"));
    assert.ok(lookupRunSummary(runDir, await stampRun()));

    await fs.writeFile(path.join(runDir, DEFINITION), '{"steps":[]}');

    assert.strictEqual(
      lookupRunSummary(runDir, await stampRun()),
      undefined,
      "a definition written after the summary was cached must invalidate it"
    );
  });

  // Mechanism 1/3: the writers invalidate by their own file path, and the two
  // cached files are siblings — so either path must reach the same entry.
  for (const writtenFile of [MANIFEST, DEFINITION]) {
    test(`invalidates the run when a writer reports ${writtenFile}`, async () => {
      storeRunSummary(runDir, await stampRun(), recordFor("run-a"));

      invalidateRunSummaryFor(path.join(runDir, writtenFile));

      assert.strictEqual(runSummaryCacheSize(), 0);
    });
  }

  // The write-through hooks exist precisely because a same-tick write can leave
  // the stamp unchanged (Windows sets timestamps from a ~15.6 ms clock). Forcing
  // the stamp to match proves invalidation does not depend on it.
  test("invalidation does not depend on the stamp changing", async () => {
    const stamp = await stampRun();
    storeRunSummary(runDir, stamp, recordFor("run-a"));

    invalidateRunSummaryFor(path.join(runDir, DEFINITION));

    assert.strictEqual(
      lookupRunSummary(runDir, stamp),
      undefined,
      "a write that produced an identical stamp must still have evicted the entry"
    );
  });

  test("invalidating an uncached path is a no-op", async () => {
    storeRunSummary(runDir, await stampRun(), recordFor("run-a"));

    // Drafts and staging directories share the writer but are never cached.
    invalidateRunSummaryFor(path.join(runDir, "draft", DEFINITION));

    assert.strictEqual(runSummaryCacheSize(), 1);
  });

  test("evicts least-recently-used entries so a long session cannot grow forever", async () => {
    const stamp = await stampRun();
    // One more than the cap, touching the first entry partway through so it is
    // the *use* order and not the insert order that decides what survives.
    for (let index = 0; index < 501; index++) {
      storeRunSummary(path.join(runDir, `run-${index}`), stamp, recordFor("x"));
      if (index === 400) {
        lookupRunSummary(path.join(runDir, "run-0"), stamp);
      }
    }

    assert.strictEqual(
      runSummaryCacheSize(),
      500,
      "the cache must stay bounded"
    );
    assert.ok(
      lookupRunSummary(path.join(runDir, "run-0"), stamp),
      "a recently used entry must outlive older untouched ones"
    );
    assert.strictEqual(
      lookupRunSummary(path.join(runDir, "run-1"), stamp),
      undefined,
      "the least recently used entry is the one that goes"
    );
  });
});
