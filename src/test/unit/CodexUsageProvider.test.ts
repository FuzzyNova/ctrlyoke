import * as assert from "assert";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { suite, test } from "mocha";
import {
  CodexAppServerClient,
  type CodexAppServerProcess,
} from "../../core/harness/codex/CodexAppServerClient";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import {
  normalizeCodexAppServerQuota,
  normalizeCodexRolloutQuota,
} from "../../core/harness/codex/CodexUsageNormalization";
import {
  CODEX_APP_SERVER_UNSUPPORTED,
  CodexUsageProvider,
} from "../../core/harness/shared/usage/providers/CodexUsageProvider";
import {
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_STATUS_CODES,
} from "../../types/DashboardConstants";

class FakeAppServerProcess
  extends EventEmitter
  implements CodexAppServerProcess
{
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  killCount = 0;

  constructor(
    private readonly respond: boolean = true,
    private readonly accountType: string | null = "chatgpt"
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.respond) {
          const request = JSON.parse(String(chunk)) as {
            id?: number;
            method?: string;
          };
          if (request.id === undefined) {
            callback();
            return;
          }
          const result =
            request.method === "account/read"
              ? {
                  account: this.accountType ? { type: this.accountType } : null,
                  requiresOpenaiAuth: true,
                }
              : request.method === "account/rateLimits/read"
                ? {
                    rateLimitsByLimitId: {
                      codex: {
                        limitId: "codex",
                        primary: {
                          usedPercent: 63,
                          windowDurationMins: 300,
                          resetsAt: 1_700_000_000,
                        },
                        secondary: {
                          usedPercent: 24,
                          windowDurationMins: 10_080,
                          resetsAt: 1_700_100_000,
                        },
                      },
                    },
                    account: { email: "must-not-escape@example.com" },
                  }
                : {};
          this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.killCount += 1;
    return true;
  }
}

suite("Codex usage tracking", () => {
  test("normalizes duration-based windows from app-server and rollout sources", () => {
    const appQuota = normalizeCodexAppServerQuota(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 63,
              windowDurationMins: 300,
              resetsAt: 1_700_000_000,
            },
            secondary: {
              usedPercent: 24,
              windowDurationMins: 10_080,
              resetsAt: 1_700_100_000,
            },
          },
        },
        account: { email: "private@example.com" },
      },
      1_700_000_000_000
    );
    const rolloutQuota = normalizeCodexRolloutQuota(
      {
        primary: {
          used_percent: 63,
          window_minutes: 300,
          resets_at: 1_700_000_000,
        },
        secondary: {
          used_percent: 24,
          window_minutes: 10_080,
          resets_at: 1_700_100_000,
        },
        plan_type: "pro",
        credits: { private: "do-not-retain" },
      },
      1_700_000_000_000
    );

    assert.ok(appQuota);
    assert.ok(rolloutQuota);
    assert.deepStrictEqual(
      appQuota.windows.map((window) => [
        window.kind,
        window.label,
        window.resetAt,
      ]),
      [
        ["rolling", "5h", 1_700_000_000_000],
        ["weekly", "week", 1_700_100_000_000],
      ]
    );
    assert.strictEqual(rolloutQuota.source, HARNESS_QUOTA_SOURCES.PROVIDER_LOG);
    assert.strictEqual(rolloutQuota.windows[0].confidence, "last-known");
    assert.strictEqual(
      JSON.stringify(appQuota).includes("private@example.com"),
      false
    );
    assert.strictEqual(
      JSON.stringify(rolloutQuota).includes("do-not-retain"),
      false
    );
  });

  test("uses stable multi-bucket ids so duplicate windows replace", () => {
    const quota = normalizeCodexAppServerQuota(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 10, windowDurationMins: 300 },
          },
          other: {
            limitId: "other",
            primary: { usedPercent: 20, windowDurationMins: 300 },
          },
        },
      },
      1_700_000_000_000
    );
    assert.deepStrictEqual(
      quota?.windows.map((window) => window.id),
      ["codex:codex:primary", "codex:other:primary"]
    );
  });

  test("degrades provider-schema drift to an empty quota", () => {
    assert.strictEqual(
      normalizeCodexAppServerQuota({ renamed: true }),
      undefined
    );
    assert.strictEqual(
      normalizeCodexRolloutQuota({ primary: { used_percent: "not-a-number" } }),
      undefined
    );
  });

  test("pushes rollout rate limits at the existing token-count parse site", () => {
    const updates: Array<ReturnType<typeof normalizeCodexRolloutQuota>> = [];
    const parser = new CodexLogParser(
      (quota) => updates.push(quota),
      () => 1_700_000_000_000
    );
    parser.extractResponse([
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1, output_tokens: 2 },
          },
          rate_limits: {
            primary: {
              used_percent: 44,
              window_minutes: 300,
              resets_at: 1_700_000_000,
            },
          },
        },
      },
    ]);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(
      updates[0]?.["source"],
      HARNESS_QUOTA_SOURCES.PROVIDER_LOG
    );
    assert.strictEqual(updates[0]?.["windows"][0].resetAt, 1_700_000_000_000);
  });

  test("gates unsupported versions before spawning app-server", async () => {
    let spawned = false;
    const provider = new CodexUsageProvider({
      getVersion: async () => "0.145.0",
      appServer: {
        spawnProcess: () => {
          spawned = true;
          return new FakeAppServerProcess();
        },
      },
    });
    const quota = await provider.refreshUsage();
    assert.strictEqual(spawned, false);
    assert.strictEqual(quota.errorCode, CODEX_APP_SERVER_UNSUPPORTED);
  });

  test("reads account rate limits without starting a model turn and tears down", async () => {
    let process: FakeAppServerProcess | undefined;
    const client = new CodexAppServerClient({
      spawnProcess: () => {
        process = new FakeAppServerProcess();
        return process;
      },
      now: () => 1_700_000_000_000,
    });
    const result = await client.readRateLimits();
    assert.ok(result.quota);
    assert.strictEqual(result.quota?.windows.length, 2);
    assert.strictEqual(process?.killCount, 1);
    assert.strictEqual(
      JSON.stringify(result).includes("must-not-escape"),
      false
    );
  });

  test("aborts and tears down a hung app-server probe", async () => {
    let process: FakeAppServerProcess | undefined;
    const client = new CodexAppServerClient({
      spawnProcess: () => {
        process = new FakeAppServerProcess(false);
        return process;
      },
      timeoutMs: 50,
    });
    const controller = new AbortController();
    const pending = client.readRateLimits(controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted|timed out/);
    assert.strictEqual(process?.killCount, 1);
  });

  test("gates unsupported auth modes without retaining account details", async () => {
    const process = new FakeAppServerProcess(true, "apiKey");
    const client = new CodexAppServerClient({
      spawnProcess: () => process,
    });
    const result = await client.readRateLimits();
    assert.strictEqual(
      result.errorCode,
      HARNESS_USAGE_STATUS_CODES.UNSUPPORTED_AUTH_MODE
    );

    const unauthenticated = new CodexAppServerClient({
      spawnProcess: () => new FakeAppServerProcess(true, null),
    });
    const authResult = await unauthenticated.readRateLimits();
    assert.strictEqual(
      authResult.errorCode,
      HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED
    );
  });
});
