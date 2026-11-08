import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";
import type { CapabilitiesModel } from "../../../types/CapabilitiesTypes";
import { HARNESS_USAGE_STATUS_CODES } from "../../../types/DashboardConstants";
import { normalizeCodexAppServerQuota } from "./CodexUsageNormalization";
import { CTRLYOKE_VERSION } from "../../../utils/BuildConfig";
import { resolveCliCommand } from "../shared/CliLauncherResolver";
import {
  defaultStdioProbeSpawn,
  runStdioProbe,
  type StdioProbeProcess,
  type StdioProbeSession,
  type StdioProbeSpawn,
} from "../shared/StdioProbe";

export const CODEX_APP_SERVER_PROBE_TIMEOUT_MS = 5_000;

/** Codex app-server `account.type` value for a ChatGPT-authenticated session. */
const CODEX_ACCOUNT_TYPE_CHATGPT = "chatgpt";

/**
 * `model/list` is paginated. Codex returns every model in one page today; the
 * cap only stops a misbehaving server that keeps handing back a cursor.
 */
const CODEX_MODEL_LIST_MAX_PAGES = 20;

export type CodexAppServerProcess = StdioProbeProcess;

export interface CodexAppServerProbeResult {
  quota?: HarnessQuotaSnapshot;
  errorCode?: string;
}

export interface CodexAppServerClientOptions {
  spawnProcess?: StdioProbeSpawn;
  resolveCommand?: typeof resolveCliCommand;
  timeoutMs?: number;
  now?: () => number;
}

export interface CodexModelListPage {
  models: CapabilitiesModel[];
  nextCursor?: string;
}

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize one `model/list` response page (`{ data: Model[], nextCursor }`).
 * `model` is the value `codex -m` takes (it equals `id` in every release seen
 * so far); `displayName` is Codex's own label and `hidden` marks a model Codex
 * leaves out of its default picker. Entries without a usable ID are skipped.
 */
export function normalizeCodexModelListPage(
  result: unknown
): CodexModelListPage {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return { models: [] };
  }
  const models: CapabilitiesModel[] = [];
  for (const entry of result.data) {
    if (!isRecord(entry)) continue;
    const value =
      typeof entry.model === "string" && entry.model
        ? entry.model
        : typeof entry.id === "string"
          ? entry.id
          : "";
    if (!value) continue;
    const label =
      typeof entry.displayName === "string" && entry.displayName
        ? entry.displayName
        : value;
    models.push(
      entry.hidden === true ? { value, label, hidden: true } : { value, label }
    );
  }
  const nextCursor =
    typeof result.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : undefined;
  return nextCursor ? { models, nextCursor } : { models };
}

/**
 * Short-lived, read-only stdio client for Codex's app-server: the account
 * surface (rate limits) and the model catalog. It never starts a thread or
 * turn and never retains the account response.
 */
export class CodexAppServerClient {
  private readonly spawnProcess: StdioProbeSpawn;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly resolveCommand: typeof resolveCliCommand;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultStdioProbeSpawn;
    this.resolveCommand = options.resolveCommand ?? resolveCliCommand;
    this.timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  readRateLimits(signal?: AbortSignal): Promise<CodexAppServerProbeResult> {
    return this.runSession(signal, async (session) => {
      // Read only the auth mode discriminator. Any account identity returned
      // by this sibling method is deliberately discarded.
      const accountResult = await this.request(session, 2, "account/read", {
        refreshToken: false,
      });
      const authErrorCode = this.getAuthErrorCode(accountResult);
      if (authErrorCode) {
        return { errorCode: authErrorCode };
      }

      const rateLimitResult = await this.request(
        session,
        3,
        "account/rateLimits/read",
        undefined
      );
      const quota = normalizeCodexAppServerQuota(rateLimitResult, this.now());
      return quota ? { quota } : {};
    });
  }

  /**
   * Every model the signed-in account can use, hidden ones included (flagged
   * `hidden`), in Codex's own picker order. Rejects when Codex is missing,
   * times out or refuses the request; callers fall back to a static list.
   */
  listModels(signal?: AbortSignal): Promise<CapabilitiesModel[]> {
    return this.runSession(signal, async (session) => {
      const models: CapabilitiesModel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CODEX_MODEL_LIST_MAX_PAGES; page++) {
        const result = await this.request(session, 2 + page, "model/list", {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        });
        const normalized = normalizeCodexModelListPage(result);
        models.push(...normalized.models);
        cursor = normalized.nextCursor;
        if (!cursor) break;
      }
      return models;
    });
  }

  /** Spawn `codex app-server`, complete the `initialize` handshake, run `body`. */
  private runSession<T>(
    signal: AbortSignal | undefined,
    body: (session: StdioProbeSession) => Promise<T>
  ): Promise<T> {
    return runStdioProbe(
      {
        label: "Codex app-server",
        commandName: "codex",
        args: ["app-server", "--listen", "stdio://"],
        timeoutMs: this.timeoutMs,
        spawnProcess: this.spawnProcess,
        resolveCommand: this.resolveCommand,
        signal,
      },
      async (session) => {
        await this.request(session, 1, "initialize", {
          clientInfo: {
            name: "ctrlyoke",
            title: "ctrlyoke",
            version: CTRLYOKE_VERSION,
          },
        });
        session.send({ method: "initialized", params: {} });
        return body(session);
      }
    );
  }

  private getAuthErrorCode(accountResult: unknown): string | undefined {
    if (!isRecord(accountResult)) return undefined;
    const account = isRecord(accountResult.account)
      ? accountResult.account
      : undefined;
    const accountType =
      typeof account?.type === "string" ? account.type : undefined;
    if (accountType && accountType !== CODEX_ACCOUNT_TYPE_CHATGPT) {
      return HARNESS_USAGE_STATUS_CODES.UNSUPPORTED_AUTH_MODE;
    }
    return accountResult.requiresOpenaiAuth === true &&
      accountType !== CODEX_ACCOUNT_TYPE_CHATGPT
      ? HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED
      : undefined;
  }

  private request(
    session: StdioProbeSession,
    id: number,
    method: string,
    params: Record<string, unknown> | undefined
  ): Promise<unknown> {
    const reply = session.awaitMessage((message) => {
      const rpc = message as JsonRpcMessage | null;
      if (rpc?.id !== id) return undefined;
      if (rpc.error !== undefined) {
        throw new Error(`Codex app-server rejected ${method}`);
      }
      // A missing result is still this request's reply.
      return { result: rpc.result };
    });
    try {
      session.send({ id, method, ...(params ? { params } : {}) });
    } catch {
      reply.catch(() => undefined);
      return Promise.reject(
        new Error(`Codex app-server request failed: ${method}`)
      );
    }
    return reply.then(({ result }) => result);
  }
}
