import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
} from "../../../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../../../types/UsageTypes";
import { CliProviderUtils } from "../../../shared/CliProviderUtils";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "../../../codex/CodexAppServerClient";

export const CODEX_APP_SERVER_UNSUPPORTED = "codex-app-server-unsupported";
export const CODEX_APP_SERVER_PROBE_FAILED = "codex-app-server-probe-failed";

/** Current documented app-server support is gated to the rechecked CLI line. */
export const CODEX_APP_SERVER_MIN_VERSION = {
  major: 0,
  minor: 146,
} as const;

export interface CodexUsageProviderOptions {
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

function parseVersion(
  version: string | undefined
): { major: number; minor: number } | undefined {
  if (!version) return undefined;
  const match = version.match(/(?:v)?(\d+)\.(\d+)/i);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]) }
    : undefined;
}

export function isCodexAppServerVersionSupported(
  version: string | undefined
): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return (
    parsed.major > CODEX_APP_SERVER_MIN_VERSION.major ||
    (parsed.major === CODEX_APP_SERVER_MIN_VERSION.major &&
      parsed.minor >= CODEX_APP_SERVER_MIN_VERSION.minor)
  );
}

function defaultGetVersion(): Promise<string | undefined> {
  return CliProviderUtils.getCliVersion("codex --version", {
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
export class CodexUsageProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.CODEX_CLI;
  private readonly appServer: CodexAppServerClient;
  private readonly getVersion: () => Promise<string | undefined>;

  constructor(options: CodexUsageProviderOptions = {}) {
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
