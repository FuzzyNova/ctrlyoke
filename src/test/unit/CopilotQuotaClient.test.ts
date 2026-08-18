import * as assert from "assert";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { suite, test } from "mocha";
import {
  CopilotQuotaClient,
  type CopilotQuotaClientOptions,
  type CopilotQuotaProcess,
  type CopilotQuotaSpawnOptions,
} from "../../core/harness/copilot/CopilotQuotaClient";
import {
  COPILOT_QUOTA_STATUS_CODES,
} from "../../core/harness/copilot/CopilotUsageNormalization";
import type { CliResolvedCommand } from "../../core/harness/shared/CliLauncherResolver";
import { HARNESS_USAGE_STATUS_CODES } from "../../types/DashboardConstants";

const FETCHED_AT = 1_700_000_000_000;

interface FakeCopilotProcessOptions {
  connect: "success" | "method-not-found" | "error";
  quota: "success" | "error" | "malformed-frame" | "no-response";
  closeOnShutdown: boolean;
  splitResponses: boolean;
  stderr?: string;
}

class FakeCopilotProcess
  extends EventEmitter
  implements CopilotQuotaProcess
{
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: NodeJS.WritableStream;
  readonly pid = 4242;
  readonly methods: string[] = [];
  killCount = 0;
  private inputBuffer = "";

  constructor(private readonly options: FakeCopilotProcessOptions) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.inputBuffer += chunk.toString();
        this.consumeRequests();
        callback();
      },
    });
    if (options.stderr) this.stderr.write(options.stderr);
  }

  kill(): boolean {
    this.killCount += 1;
    return true;
  }

  private consumeRequests(): void {
    while (true) {
      const separator = this.inputBuffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.inputBuffer.slice(0, separator);
      const lengthHeader = header
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));
      const length = Number(lengthHeader?.split(":", 2)[1]?.trim());
      if (!Number.isFinite(length)) return;
      const contentStart = separator + 4;
      if (this.inputBuffer.length < contentStart + length) return;
      const content = this.inputBuffer.slice(contentStart, contentStart + length);
      this.inputBuffer = this.inputBuffer.slice(contentStart + length);
      const request = JSON.parse(content) as {
        id: number;
        method: string;
      };
      this.methods.push(request.method);
      this.respond(request.id, request.method);
    }
  }

  private respond(id: number, method: string): void {
    if (method === "connect") {
      if (this.options.connect === "success") {
        this.writeResponse({ id, result: {} });
      } else if (this.options.connect === "method-not-found") {
        this.writeResponse({
          id,
          error: { code: -32601, message: "method not found" },
        });
      } else {
        this.writeResponse({
          id,
          error: { code: -32000, message: "quota RPC failed" },
        });
      }
      return;
    }
    if (method === "ping") {
      this.writeResponse({ id, result: {} });
      return;
    }
    if (method === "account.getQuota") {
      if (this.options.quota === "success") {
        this.writeResponse({
          id,
          result: {
            quotaSnapshots: {
              premium_interactions: {
                entitlementRequests: 1_500,
                usedRequests: 555,
                remainingPercentage: 63,
                resetDate: "2026-09-01T00:00:00.000Z",
              },
            },
          },
        });
      } else if (this.options.quota === "error") {
        this.writeResponse({
          id,
          error: { code: -32000, message: "not authenticated" },
        });
      } else if (this.options.quota === "malformed-frame") {
        this.stdout.write("Content-Length: 7\r\n\r\n{broken");
      }
      return;
    }
    if (method === "runtime.shutdown") {
      this.writeResponse({ id, result: {} });
      if (this.options.closeOnShutdown) {
        this.emit("close");
      }
    }
  }

  private writeResponse(message: Record<string, unknown>): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    if (!this.options.splitResponses) {
      this.stdout.write(frame);
      return;
    }
    for (const character of frame) this.stdout.write(character);
  }

  emitEarlyExit(): void {
    this.emit("close");
  }
}

function resolvedCommand(
  launcherKind: "direct" | "powershell-file" | "cmd-file" | "node-shim",
  command: string,
  args: string[],
  requiresShellVerbatimArgs = false
): CliResolvedCommand {
  return {
    command,
    args,
    displayCommand: [command, ...args].join(" "),
    launcherKind,
    ...(requiresShellVerbatimArgs
      ? { requiresShellVerbatimArgs: true }
      : {}),
  };
}

function makeClient(
  processOptions: Partial<FakeCopilotProcessOptions> = {},
  resolved = resolvedCommand("direct", "copilot", [
    "--headless",
    "--no-auto-update",
    "--log-level",
    "error",
    "--stdio",
  ])
): {
  client: CopilotQuotaClient;
  process: FakeCopilotProcess;
  spawnOptions: CopilotQuotaSpawnOptions | undefined;
  spawnCall: { command: string; args: readonly string[] } | undefined;
  killedTrees: number[];
} {
  const process = new FakeCopilotProcess({
    connect: "success",
    quota: "success",
    closeOnShutdown: true,
    splitResponses: false,
    ...processOptions,
  });
  let spawnOptions: CopilotQuotaSpawnOptions | undefined;
  let spawnCall: { command: string; args: readonly string[] } | undefined;
  const killedTrees: number[] = [];
  const options: CopilotQuotaClientOptions = {
    resolveCliCommand: async (commandName, args) => {
      assert.strictEqual(commandName, "copilot");
      assert.deepStrictEqual(args, [
        "--headless",
        "--no-auto-update",
        "--log-level",
        "error",
        "--stdio",
      ]);
      return resolved;
    },
    spawnProcess: (command, args, spawnOptionsValue) => {
      spawnCall = { command, args };
      spawnOptions = spawnOptionsValue;
      return process;
    },
    killProcessTree: (pid) => killedTrees.push(pid),
    timeoutMs: 200,
    teardownGracePeriodMs: 5,
    now: () => FETCHED_AT,
  };
  return {
    client: new CopilotQuotaClient(options),
    process,
    get spawnOptions() {
      return spawnOptions;
    },
    get spawnCall() {
      return spawnCall;
    },
    killedTrees,
  };
}

suite("Copilot quota client", () => {
  test("uses the resolved launcher command, args, and hidden piped flags", async () => {
    const cases = [
      resolvedCommand("direct", "/usr/local/bin/copilot", ["--server"]),
      resolvedCommand("powershell-file", "powershell.exe", ["-NoProfile", "-File", "copilot.ps1"]),
      resolvedCommand("node-shim", "node.exe", ["copilot.js"]),
      resolvedCommand("cmd-file", "cmd.exe", ["/c", "copilot.cmd", "--stdio"], true),
    ] as const;

    for (const expected of cases) {
      const probe = makeClient({}, expected);
      await probe.client.readQuota();
      assert.deepStrictEqual(probe.spawnCall, {
        command: expected.command,
        args: expected.args,
      });
      assert.deepStrictEqual(probe.spawnOptions, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(expected.requiresShellVerbatimArgs
          ? { windowsVerbatimArguments: true }
          : {}),
      });
    }
  });

  test("reads Content-Length frames split across arbitrary chunks", async () => {
    const probe = makeClient({ splitResponses: true });
    const result = await probe.client.readQuota();
    assert.ok(result.quota);
    assert.strictEqual(result.quota?.windows[0]?.used, 555);
    assert.deepStrictEqual(probe.process.methods, [
      "connect",
      "account.getQuota",
      "runtime.shutdown",
    ]);
  });

  test("falls back from legacy connect method-not-found to ping", async () => {
    const probe = makeClient({ connect: "method-not-found" });
    const result = await probe.client.readQuota();
    assert.ok(result.quota);
    assert.deepStrictEqual(probe.process.methods, [
      "connect",
      "ping",
      "account.getQuota",
      "runtime.shutdown",
    ]);
  });

  test("issues no session or auth RPCs and maps authentication errors safely", async () => {
    const probe = makeClient({ quota: "error" });
    const result = await probe.client.readQuota();
    assert.strictEqual(result.errorCode, HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED);
    assert.strictEqual(
      probe.process.methods.some((method) => method.startsWith("session.")),
      false
    );
    assert.strictEqual(probe.process.methods.includes("account.getCurrentAuth"), false);
    assert.strictEqual(JSON.stringify(result).includes("not authenticated"), false);
  });

  test("maps malformed frames, RPC failures, process errors, and early exits", async () => {
    const malformed = makeClient({ quota: "malformed-frame", closeOnShutdown: false });
    assert.strictEqual(
      (await malformed.client.readQuota()).errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );

    const rpcFailure = makeClient({ connect: "error" });
    assert.strictEqual(
      (await rpcFailure.client.readQuota()).errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );

    const processError = makeClient({ quota: "no-response", closeOnShutdown: false });
    const processErrorRead = processError.client.readQuota();
    await new Promise((resolve) => setTimeout(resolve, 0));
    processError.process.emit("error", new Error("private process detail"));
    assert.strictEqual(
      (await processErrorRead).errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );

    const earlyExit = makeClient({ quota: "no-response", closeOnShutdown: false });
    const earlyExitRead = earlyExit.client.readQuota();
    await new Promise((resolve) => setTimeout(resolve, 0));
    earlyExit.process.emitEarlyExit();
    assert.strictEqual(
      (await earlyExitRead).errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );
  });

  test("maps timeout and abort without throwing", async () => {
    const timeout = makeClient({ quota: "no-response", closeOnShutdown: false });
    const timeoutResult = await timeout.client.readQuota();
    assert.strictEqual(
      timeoutResult.errorCode,
      COPILOT_QUOTA_STATUS_CODES.TIMEOUT
    );

    const abort = makeClient({ quota: "no-response", closeOnShutdown: false });
    const controller = new AbortController();
    const pending = abort.client.readQuota(controller.signal);
    controller.abort();
    const abortResult = await pending;
    assert.strictEqual(
      abortResult.errorCode,
      COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED
    );
  });

  test("shuts down gracefully and uses process-tree cleanup after the grace period", async () => {
    const graceful = makeClient();
    await graceful.client.readQuota();
    assert.strictEqual(graceful.process.killCount, 0);
    assert.deepStrictEqual(graceful.killedTrees, []);

    const forced = makeClient({ closeOnShutdown: false });
    await forced.client.readQuota();
    assert.deepStrictEqual(forced.killedTrees, [4242]);
  });

  test("bounds stderr and never returns it in a failure result", async () => {
    const secret = "token=must-not-escape";
    const probe = makeClient({
      quota: "no-response",
      closeOnShutdown: false,
      stderr: secret.repeat(10_000),
    });
    const result = await probe.client.readQuota();
    assert.strictEqual(result.errorCode, COPILOT_QUOTA_STATUS_CODES.TIMEOUT);
    assert.strictEqual(JSON.stringify(result).includes(secret), false);
  });
});
