import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_STATUS_CODES,
} from "../../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../../types/UsageTypes";
import {
  CopilotQuotaClient,
  type CopilotQuotaClientOptions,
  type CopilotQuotaProbeResult,
  type CopilotQuotaReader,
} from "../../../copilot/CopilotQuotaClient";
import { COPILOT_QUOTA_STATUS_CODES } from "../../../copilot/CopilotUsageNormalization";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";

export interface CopilotUsageProviderOptions {
  client?: CopilotQuotaReader;
  quotaClientOptions?: CopilotQuotaClientOptions;
}

function unavailableQuota(errorCode: string): HarnessQuotaSnapshot {
  return {
    harnessId: HARNESS_IDS.COPILOT_CLI,
    source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
    staleAfterMs: 0,
    windows: [],
    errorCode,
  };
}

function safeErrorCode(errorCode: string | undefined): string {
  if (
    errorCode === HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED ||
    errorCode === COPILOT_QUOTA_STATUS_CODES.UNSUPPORTED ||
    errorCode === COPILOT_QUOTA_STATUS_CODES.TIMEOUT ||
    errorCode === COPILOT_QUOTA_STATUS_CODES.MALFORMED_RESPONSE ||
    errorCode === COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
  ) {
    return errorCode;
  }
  return COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED;
}

/** Provider-live Copilot account quota collector. */
export class CopilotUsageProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.COPILOT_CLI;
  private readonly quotaClient: CopilotQuotaReader;
  private refreshPromise: Promise<HarnessQuotaSnapshot> | undefined;

  constructor(options: CopilotUsageProviderOptions = {}) {
    this.quotaClient =
      options.client ?? new CopilotQuotaClient(options.quotaClientOptions);
  }

  refreshUsage(signal?: AbortSignal): Promise<HarnessQuotaSnapshot> {
    const existing = this.refreshPromise;
    if (existing) return existing;

    const refresh = this.refreshOnce(signal).finally(() => {
      this.refreshPromise = undefined;
    });
    this.refreshPromise = refresh;
    return refresh;
  }

  private async refreshOnce(
    signal?: AbortSignal
  ): Promise<HarnessQuotaSnapshot> {
    try {
      const result: CopilotQuotaProbeResult =
        await this.quotaClient.readQuota(signal);
      if (result.quota) return result.quota;
      return unavailableQuota(safeErrorCode(result.errorCode));
    } catch {
      return unavailableQuota(COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED);
    }
  }
}
