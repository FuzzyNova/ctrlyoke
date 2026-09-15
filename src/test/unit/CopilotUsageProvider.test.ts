import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_STATUS_CODES,
} from "../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../types/UsageTypes";
import { COPILOT_QUOTA_STATUS_CODES } from "../../core/harness/copilot/CopilotUsageNormalization";
import type {
  CopilotQuotaProbeResult,
  CopilotQuotaReader,
} from "../../core/harness/copilot/CopilotQuotaClient";
import { CopilotUsageProvider } from "../../core/harness/shared/usage/providers/CopilotUsageProvider";

const liveQuota: HarnessQuotaSnapshot = {
  harnessId: HARNESS_IDS.COPILOT_CLI,
  source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
  fetchedAt: 1_700_000_000_000,
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
      resetAt: 1_800_000_000_000,
      unit: "requests",
      confidence: "exact",
    },
  ],
};

class FakeCopilotQuotaReader implements CopilotQuotaReader {
  calls = 0;
  private resolvePending:
    ((result: CopilotQuotaProbeResult) => void) | undefined;

  constructor(private readonly result?: CopilotQuotaProbeResult) {}

  readQuota(): Promise<CopilotQuotaProbeResult> {
    this.calls += 1;
    if (this.result) return Promise.resolve(this.result);
    return new Promise((resolve) => {
      this.resolvePending = resolve;
    });
  }

  resolve(result: CopilotQuotaProbeResult): void {
    this.resolvePending?.(result);
  }
}

class ThrowingCopilotQuotaReader implements CopilotQuotaReader {
  async readQuota(): Promise<CopilotQuotaProbeResult> {
    throw new Error("private process failure");
  }
}

suite("CopilotUsageProvider", () => {
  test("returns the provider-live snapshot on success", async () => {
    const reader = new FakeCopilotQuotaReader({ quota: liveQuota });
    const provider = new CopilotUsageProvider({ client: reader });

    assert.deepStrictEqual(await provider.refreshUsage(), liveQuota);
    assert.strictEqual(reader.calls, 1);
  });

  test("maps every safe probe failure without throwing", async () => {
    const cases: CopilotQuotaProbeResult[] = [
      { errorCode: COPILOT_QUOTA_STATUS_CODES.UNSUPPORTED },
      { errorCode: HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED },
      { errorCode: COPILOT_QUOTA_STATUS_CODES.TIMEOUT },
      { errorCode: COPILOT_QUOTA_STATUS_CODES.MALFORMED_RESPONSE },
      { errorCode: COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED },
    ];

    for (const result of cases) {
      const provider = new CopilotUsageProvider({
        client: new FakeCopilotQuotaReader(result),
      });
      const snapshot = await provider.refreshUsage();
      assert.strictEqual(snapshot.source, HARNESS_QUOTA_SOURCES.UNAVAILABLE);
      assert.strictEqual(snapshot.errorCode, result.errorCode);
      assert.strictEqual(snapshot.harnessId, HARNESS_IDS.COPILOT_CLI);
    }
  });

  test("maps an unexpected client failure to the generic safe code", async () => {
    const provider = new CopilotUsageProvider({
      client: new ThrowingCopilotQuotaReader(),
    });

    const snapshot = await provider.refreshUsage();
    assert.strictEqual(
      snapshot.errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );
  });

  test("single-flights simultaneous refreshes per provider instance", async () => {
    const reader = new FakeCopilotQuotaReader();
    const provider = new CopilotUsageProvider({ client: reader });
    const first = provider.refreshUsage();
    const second = provider.refreshUsage();

    assert.strictEqual(reader.calls, 1);
    reader.resolve({ quota: liveQuota });
    assert.deepStrictEqual(await Promise.all([first, second]), [
      liveQuota,
      liveQuota,
    ]);
  });
});
