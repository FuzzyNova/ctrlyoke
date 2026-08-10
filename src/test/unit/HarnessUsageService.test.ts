import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
} from "../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../types/UsageTypes";
import {
  HARNESS_USAGE_ERROR_CODES,
  HarnessUsageService,
} from "../../core/harness/shared/usage/HarnessUsageService";
import type { IHarnessUsageProvider } from "../../core/harness/shared/usage/IHarnessUsageProvider";

class LiveProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.CLAUDE_CLI;

  async refreshUsage(): Promise<HarnessQuotaSnapshot> {
    return {
      harnessId: this.harnessId,
      source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
      fetchedAt: 1_000_000_000_000,
      staleAfterMs: 0,
      windows: [
        {
          id: "five-hour",
          kind: "rolling",
          label: "5 hours",
          resetAt: 1_000_000_200_000,
          unit: "tokens",
          confidence: "exact",
        },
      ],
    };
  }
}

class ThrowingProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.CODEX_CLI;

  async refreshUsage(): Promise<HarnessQuotaSnapshot> {
    throw new Error("account details must not escape the service");
  }
}

suite("HarnessUsageService", () => {
  let workspaceRoot: string;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-usage-service-"));
  });

  test("uses source freshness and known reset times for stale decisions", async () => {
    const service = new HarnessUsageService(
      workspaceRoot,
      [new LiveProvider()],
      undefined,
      undefined,
      () => 1_000
    );

    await service.refreshHarnessUsage(HARNESS_IDS.CLAUDE_CLI);
    assert.strictEqual(service.isQuotaStale(HARNESS_IDS.CLAUDE_CLI), false);
    assert.strictEqual(
      service.isQuotaStale(
        HARNESS_IDS.CLAUDE_CLI,
        1_000_000_000_000 + 5 * 60 * 1000
      ),
      true
    );
  });

  test("turns provider failures into safe snapshots without rejecting", async () => {
    const service = new HarnessUsageService(
      workspaceRoot,
      [new ThrowingProvider()],
      undefined,
      undefined,
      () => 1_000
    );

    const snapshot = await service.refreshHarnessUsage(HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(
      snapshot.quota.errorCode,
      HARNESS_USAGE_ERROR_CODES.PROVIDER_REFRESH_FAILED
    );
    assert.strictEqual(snapshot.quota.source, HARNESS_QUOTA_SOURCES.UNAVAILABLE);
    assert.strictEqual(snapshot.quota.message, undefined);
  });
});
