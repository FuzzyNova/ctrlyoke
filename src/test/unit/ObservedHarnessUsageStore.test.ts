import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import type {
  HarnessId,
  WorkflowKey,
  WorkflowTokenTotals,
} from "../../types/CtrlYokeTypes";
import { formatRunRef } from "../../utils/WorkflowPaths";
import {
  ObservedHarnessUsageStore,
  OBSERVED_USAGE_SCHEMA_VERSION,
} from "../../core/harness/shared/usage/ObservedHarnessUsageStore";

suite("ObservedHarnessUsageStore", () => {
  let workspaceRoot: string;
  let store: ObservedHarnessUsageStore;
  const now = new Date(2026, 7, 9, 12, 0, 0).getTime();
  const workflowKey = "usage-test-workflow-2026" as WorkflowKey;
  const runRef = formatRunRef(now);

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-usage-"));
    store = new ObservedHarnessUsageStore(workspaceRoot);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function totals(
    byLocalDay: WorkflowTokenTotals["byLocalDay"]
  ): WorkflowTokenTotals {
    return {
      total: 100,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 2,
      attemptCount: 2,
      isFinal: true,
      byHarness: {},
      byLocalDay,
    };
  }

  function subtotal(total: number) {
    return {
      input: total,
      output: 0,
      total,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 1,
      attemptCount: 1,
    };
  }

  test("buckets local days into Monday ISO weeks and calendar months", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(12) } }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.daily["2026-08-08"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
    assert.strictEqual(
      data.buckets.weekly["2026-08-03"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
  });

  test("attributes mixed harnesses and multi-day runs independently", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({
        "2026-08-03": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(7) },
        "2026-08-08": { [HARNESS_IDS.CODEX_CLI]: subtotal(11) },
      }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.daily["2026-08-03"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      7
    );
    assert.strictEqual(
      data.buckets.daily["2026-08-08"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      11
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      7
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      11
    );
  });

  test("replaces a same-run continuation and repeated terminal notification", async () => {
    const first = totals({
      "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(12) },
    });
    const replacement = totals({
      "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(4) },
      "2026-08-09": { [HARNESS_IDS.CODEX_CLI]: subtotal(6) },
    });
    await store.upsertRunContribution(workflowKey, runRef, first, now);
    await store.upsertRunContribution(workflowKey, runRef, replacement, now);
    await store.upsertRunContribution(workflowKey, runRef, replacement, now);

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      4
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      6
    );
    assert.strictEqual(Object.keys(data.runs).length, 1);
  });

  test("recovers from corrupt data without blocking the next write", async () => {
    await fs.mkdir(path.dirname(store.getPath()), { recursive: true });
    await fs.writeFile(store.getPath(), "not-json", "utf8");

    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-09": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(3) } }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(data.schemaVersion, OBSERVED_USAGE_SCHEMA_VERSION);
    assert.strictEqual(
      data.buckets.daily["2026-08-09"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      3
    );
    const files = await fs.readdir(path.dirname(store.getPath()));
    assert.ok(
      files.some((file) => file.startsWith("observed-usage.json.corrupt-"))
    );
  });

  test("prunes contributions that cannot affect current day, week, or month", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-07-01": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(99) } }),
      now
    );

    const data = await store.read(now);
    assert.deepStrictEqual(data.runs, {});
    assert.deepStrictEqual(data.buckets.daily, {});
    assert.deepStrictEqual(data.buckets.weekly, {});
    assert.deepStrictEqual(data.buckets.monthly, {});
  });

  test("does not require byHarness to build observed usage", async () => {
    const harness: HarnessId = HARNESS_IDS.QWEN_CLI;
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-09": { [harness]: subtotal(5) } }),
      now
    );
    const data = await store.read(now);
    assert.strictEqual(data.buckets.daily["2026-08-09"]?.[harness]?.total, 5);
  });
});
