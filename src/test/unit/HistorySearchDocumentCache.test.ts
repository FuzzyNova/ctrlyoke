import * as assert from "assert";
import { suite, test } from "mocha";
import {
  estimateHistorySearchDocumentBytes,
  HistorySearchDocumentCache,
} from "../../core/orchestration/HistorySearchDocumentCache";
import {
  FINAL_STEP_PHASES,
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
} from "../../types/DashboardConstants";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

const TARGET: OutputExecutionTarget = {
  kind: FINAL_STEP_PHASES.QUEUE,
  stepIndex: 0,
};

function makeDocument(
  shardId: string,
  startedAt: number,
  textLength = 100
): HistorySearchDocument {
  const text = "x".repeat(textLength);
  return {
    id: `${shardId}:0:doc`,
    workflowKey: `${shardId}-workflow` as WorkflowKey,
    runRef: `run-${startedAt}` as RunRef,
    workflowName: shardId,
    runId: 1,
    startedAt,
    executionState: "completed",
    target: TARGET,
    attemptIndex: 0,
    sequence: 0,
    timestampMs: startedAt,
    eventKind: HISTORY_EVENT_KINDS.RESPONSE,
    matchField: HISTORY_MATCH_FIELDS.RESPONSE,
    text,
    textLower: text.toLowerCase(),
  };
}

suite("HistorySearchDocumentCache", () => {
  test("a zero budget disables the cache cleanly", () => {
    const cache = new HistorySearchDocumentCache(0);
    assert.strictEqual(cache.disabled, true);
    assert.strictEqual(cache.wouldRetain(1000), false);

    cache.set("shard-a.jsonl", 1000, [makeDocument("a", 1000)]);
    assert.strictEqual(cache.get("shard-a.jsonl"), undefined);
  });

  test("shrinking the budget to zero at runtime drains everything already cached", () => {
    const documents = [makeDocument("a", 1000)];
    const budget = estimateHistorySearchDocumentBytes(documents[0]) + 1;
    const cache = new HistorySearchDocumentCache(budget);
    cache.set("shard-a.jsonl", 1000, documents);
    assert.deepStrictEqual(cache.get("shard-a.jsonl"), documents);

    cache.setBudgetBytes(0);
    assert.strictEqual(cache.get("shard-a.jsonl"), undefined);
    assert.strictEqual(cache.disabled, true);
  });

  test("a cache hit returns exactly what was cached, with no disk involved", () => {
    const documents = [makeDocument("a", 1000), makeDocument("a", 1000, 40)];
    const cache = new HistorySearchDocumentCache(1024 * 1024);
    cache.set("shard-a.jsonl", 1000, documents);

    assert.deepStrictEqual(cache.get("shard-a.jsonl"), documents);
    assert.strictEqual(cache.get("shard-missing.jsonl"), undefined);
  });

  test("evicts the oldest run first once the budget is exceeded", () => {
    const oldest = [makeDocument("oldest", 1000, 200)];
    const middle = [makeDocument("middle", 2000, 200)];
    const newest = [makeDocument("newest", 3000, 200)];
    const oneEntryBytes = estimateHistorySearchDocumentBytes(oldest[0]);
    // Room for two entries, not three.
    const cache = new HistorySearchDocumentCache(
      Math.floor(oneEntryBytes * 2.5)
    );

    cache.set("oldest.jsonl", 1000, oldest);
    cache.set("middle.jsonl", 2000, middle);
    assert.deepStrictEqual(cache.get("oldest.jsonl"), oldest);
    assert.deepStrictEqual(cache.get("middle.jsonl"), middle);

    // Adding the newest run should evict the oldest one, not the middle one,
    // even though the middle entry was inserted second.
    cache.set("newest.jsonl", 3000, newest);
    assert.strictEqual(cache.get("oldest.jsonl"), undefined);
    assert.deepStrictEqual(cache.get("middle.jsonl"), middle);
    assert.deepStrictEqual(cache.get("newest.jsonl"), newest);
  });

  test("wouldRetain reports whether a run is worth a full parse before it is read", () => {
    const oldest = [makeDocument("oldest", 1000, 200)];
    const oneEntryBytes = estimateHistorySearchDocumentBytes(oldest[0]);
    const cache = new HistorySearchDocumentCache(oneEntryBytes);
    cache.set("oldest.jsonl", 1000, oldest);

    // Budget is full: an older run than everything cached is not worth
    // parsing (it could never survive eviction), but a newer one is (it
    // would displace the current oldest entry).
    assert.strictEqual(cache.wouldRetain(500), false);
    assert.strictEqual(cache.wouldRetain(2000), true);
  });

  test("does not cache a single run too large to fit the whole budget", () => {
    const huge = [makeDocument("huge", 1000, 10000)];
    const cache = new HistorySearchDocumentCache(100);
    cache.set("huge.jsonl", 1000, huge);
    assert.strictEqual(cache.get("huge.jsonl"), undefined);
  });

  test("invalidate evicts exactly the named run, leaving others cached", () => {
    const kept = [makeDocument("kept", 1000)];
    const rewritten = [makeDocument("rewritten", 2000)];
    const cache = new HistorySearchDocumentCache(1024 * 1024);
    cache.set("kept.jsonl", 1000, kept);
    cache.set("rewritten.jsonl", 2000, rewritten);

    cache.invalidate("rewritten.jsonl");

    assert.strictEqual(cache.get("rewritten.jsonl"), undefined);
    assert.deepStrictEqual(cache.get("kept.jsonl"), kept);
    // The freed budget is available again — the whole point of invalidating
    // one run instead of dropping the whole cache.
    assert.strictEqual(cache.wouldRetain(2000), true);
  });

  test("clear drops every cached run", () => {
    const cache = new HistorySearchDocumentCache(1024 * 1024);
    cache.set("a.jsonl", 1000, [makeDocument("a", 1000)]);
    cache.set("b.jsonl", 2000, [makeDocument("b", 2000)]);

    cache.clear();

    assert.strictEqual(cache.get("a.jsonl"), undefined);
    assert.strictEqual(cache.get("b.jsonl"), undefined);
  });

  test("estimated size scales with document text length rather than a flat constant", () => {
    const short = estimateHistorySearchDocumentBytes(makeDocument("s", 1, 10));
    const long = estimateHistorySearchDocumentBytes(makeDocument("l", 1, 1000));
    assert.ok(
      long > short,
      `expected a longer document to estimate larger: short=${short} long=${long}`
    );
  });
});
