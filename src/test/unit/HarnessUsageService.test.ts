import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { suite, test, setup, teardown } from "mocha";
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
import { providerSnapshotsPath } from "../../utils/UsagePaths";
import { COPILOT_QUOTA_STATUS_CODES } from "../../core/harness/copilot/CopilotUsageNormalization";

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
          isUnlimited: true,
          overage: 3,
          usageAllowedAfterLimit: true,
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

class CopilotProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.COPILOT_CLI;
  failed = false;

  async refreshUsage(): Promise<HarnessQuotaSnapshot> {
    if (this.failed) {
      return {
        harnessId: this.harnessId,
        source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
        staleAfterMs: 0,
        windows: [],
        errorCode: COPILOT_QUOTA_STATUS_CODES.TIMEOUT,
      };
    }
    return {
      harnessId: this.harnessId,
      source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
      fetchedAt: 2_000_000_000_000,
      staleAfterMs: 300_000,
      windows: [
        {
          id: "copilot:premium_interactions",
          kind: "monthly",
          label: "Premium interactions",
          used: 555,
          limit: 1_500,
          remaining: 945,
          percentUsed: 37,
          resetAt: 2_000_000_100_000,
          unit: "requests",
          confidence: "exact",
        },
      ],
    };
  }
}

suite("HarnessUsageService", () => {
  let workspaceRoot: string;
  let originalCtrlyokeHome: string | undefined;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-usage-service-")
    );
    originalCtrlyokeHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = workspaceRoot;
  });

  teardown(async () => {
    await removeTestHome(workspaceRoot);
    if (originalCtrlyokeHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    }
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

  test("persists and reloads provider-neutral window fields", async () => {
    const filePath = providerSnapshotsPath();
    const service = new HarnessUsageService(
      workspaceRoot,
      [new LiveProvider()],
      undefined,
      undefined,
      () => 1_000
    );

    await service.refreshHarnessUsage(HARNESS_IDS.CLAUDE_CLI);
    await waitForPersistedSnapshot(
      filePath,
      HARNESS_IDS.CLAUDE_CLI,
      1_000_000_000_000
    );

    const reloaded = new HarnessUsageService(workspaceRoot, []);
    await reloaded.initialize();
    assert.deepStrictEqual(
      reloaded.getHarnessUsage(HARNESS_IDS.CLAUDE_CLI).quota.windows[0],
      service.getHarnessUsage(HARNESS_IDS.CLAUDE_CLI).quota.windows[0]
    );
  });

  test("persists and reloads a live Copilot provider snapshot", async () => {
    const filePath = providerSnapshotsPath();
    const provider = new CopilotProvider();
    const service = new HarnessUsageService(
      workspaceRoot,
      [provider],
      undefined,
      undefined,
      () => 1_000
    );

    await service.refreshHarnessUsage(HARNESS_IDS.COPILOT_CLI);
    await waitForPersistedSnapshot(
      filePath,
      HARNESS_IDS.COPILOT_CLI,
      2_000_000_000_000
    );

    const reloaded = new HarnessUsageService(workspaceRoot, []);
    await reloaded.initialize();
    assert.deepStrictEqual(
      reloaded.getHarnessUsage(HARNESS_IDS.COPILOT_CLI).quota,
      service.getHarnessUsage(HARNESS_IDS.COPILOT_CLI).quota
    );
  });

  test("preserves the last live Copilot snapshot while annotating a failed refresh", async () => {
    const provider = new CopilotProvider();
    const service = new HarnessUsageService(
      workspaceRoot,
      [provider],
      undefined,
      undefined,
      () => 1_000
    );

    await service.refreshHarnessUsage(HARNESS_IDS.COPILOT_CLI);
    const successful = service.getHarnessUsage(HARNESS_IDS.COPILOT_CLI).quota;
    provider.failed = true;

    const afterFailure = await service.refreshHarnessUsage(
      HARNESS_IDS.COPILOT_CLI
    );
    assert.deepStrictEqual(afterFailure.quota.windows, successful.windows);
    assert.strictEqual(
      afterFailure.quota.source,
      HARNESS_QUOTA_SOURCES.PROVIDER_LIVE
    );
    assert.strictEqual(
      afterFailure.quota.errorCode,
      COPILOT_QUOTA_STATUS_CODES.TIMEOUT
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

  test("preserves a newer foreign provider snapshot during merge-on-write", async () => {
    const filePath = providerSnapshotsPath();
    const newerFetchedAt = 2_000_000_000_000;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        snapshots: {
          [HARNESS_IDS.CLAUDE_CLI]: {
            harnessId: HARNESS_IDS.CLAUDE_CLI,
            source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
            fetchedAt: newerFetchedAt,
            staleAfterMs: 300_000,
            windows: [],
          },
        },
      }),
      "utf8"
    );

    const service = new HarnessUsageService(
      workspaceRoot,
      [new LiveProvider()],
      undefined,
      undefined,
      () => 1_000
    );
    await service.initialize();
    service.ingestProviderUsage(await new LiveProvider().refreshUsage());

    const persisted = await waitForPersistedSnapshot(filePath);
    assert.strictEqual(
      persisted.snapshots[HARNESS_IDS.CLAUDE_CLI]?.fetchedAt,
      newerFetchedAt
    );
  });
});

async function waitForPersistedSnapshot(
  filePath: string,
  harnessId: string = HARNESS_IDS.CLAUDE_CLI,
  fetchedAt: number = 2_000_000_000_000
): Promise<{
  snapshots: Partial<Record<string, HarnessQuotaSnapshot>>;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        snapshots: Partial<Record<string, HarnessQuotaSnapshot>>;
      };
      if (
        parsed.snapshots[harnessId]?.fetchedAt === fetchedAt &&
        raw.includes("\n  \"schemaVersion\": 1")
      ) {
        return parsed;
      }
    } catch {
      // The persistence task may still be between its temp write and rename.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for provider snapshot persistence");
}

async function removeTestHome(home: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      await fs.access(home);
    } catch {
      return;
    }
  }
  throw new Error(`Timed out removing test state home: ${home}`);
}
