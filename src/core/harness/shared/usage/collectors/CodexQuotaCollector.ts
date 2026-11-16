import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
} from "../../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../../types/UsageTypes";
import { HarnessAdapterUtils } from "../../../shared/HarnessAdapterUtils";
import type { IHarnessQuotaCollector } from "../IHarnessQuotaCollector";
import {
  CodexAppServerClient,
  isCodexAppServerVersionSupported,
  type CodexAppServerClientOptions,
} from "../../../codex/CodexAppServerClient";

export const CODEX_APP_SERVER_UNSUPPORTED = "codex-app-server-unsupported";
const CODEX_APP_SERVER_PROBE_FAILED = "codex-app-server-probe-failed";

export interface CodexQuotaCollectorOptions {
  appServer?: CodexAppServerClientOptions;
  getVersion?: () => Promise<string | undefined>;
}

function unsupportedQuota(errorCode: string): HarnessQuotaSnapshot {
  return {
    harnessId: HARNESS_IDS.CODEX_CLI,
    source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
    staleAfterMs: 0,
    windows: [],
    errorCode,
  };
}

function defaultGetVersion(): Promise<string | undefined> {
  return HarnessAdapterUtils.getCliVersion("codex --version", {
    parseVersion: (stdout) => {
      const match = stdout.match(
        /(?:codex\s+version\s+)?(\d+\.\d+(?:\.\d+)?)/i
      );
      return match?.[1];
    },
  });
}

/**
 * Codex quota provider. The documented app-server probe is preferred, while
 * rollout `token_count.rate_limits` is pushed by CodexLogParser as a fallback.
 */
export class CodexQuotaCollector implements IHarnessQuotaCollector {
  readonly harnessId = HARNESS_IDS.CODEX_CLI;
  private readonly appServer: CodexAppServerClient;
  private readonly getVersion: () => Promise<string | undefined>;

  constructor(options: CodexQuotaCollectorOptions = {}) {
    this.appServer = new CodexAppServerClient(options.appServer);
    this.getVersion = options.getVersion ?? defaultGetVersion;
  }

  async refreshUsage(signal?: AbortSignal): Promise<HarnessQuotaSnapshot> {
    let version: string | undefined;
    try {
      version = await this.getVersion();
    } catch {
      return unsupportedQuota(CODEX_APP_SERVER_UNSUPPORTED);
    }
    if (!isCodexAppServerVersionSupported(version)) {
      return unsupportedQuota(CODEX_APP_SERVER_UNSUPPORTED);
    }

    try {
      const result = await this.appServer.readRateLimits(signal);
      if (result.quota) return result.quota;
      return unsupportedQuota(
        result.errorCode ?? CODEX_APP_SERVER_PROBE_FAILED
      );
    } catch {
      // The app-server is experimental and may be unavailable, unauthenticated,
      // or incompatible. Rollout log pushes and observed totals remain usable.
      return unsupportedQuota(CODEX_APP_SERVER_PROBE_FAILED);
    }
  }
}
