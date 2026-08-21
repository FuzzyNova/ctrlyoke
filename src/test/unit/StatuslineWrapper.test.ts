import * as assert from "assert";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

type SharedWrapper = {
  FORWARD_TIMEOUT_MS: number;
  STATUSLINE_PROVIDERS: {
    CLAUDE: string;
    ANTIGRAVITY: string;
  };
  formatBrandedStatusLine(
    provider: string,
    payload: Record<string, unknown>
  ): string;
  forwardToCommand(
    command: string | undefined,
    input: string | Buffer,
    timeoutMs?: number
  ): Promise<Buffer>;
  parsePayload(input: string): Record<string, unknown>;
  writeSnapshotAtomic(
    directory: string,
    filePrefix: string,
    token: string,
    payload: Record<string, unknown>,
    writtenAt: number
  ): string | undefined;
};

const scriptPath = (name: string) =>
  path.resolve(__dirname, `../../scripts/${name}`);

const shared = require(
  scriptPath("ctrlyoke-statusline-wrapper.js")
) as SharedWrapper;

function nodeCommand(code: string): string {
  return `"${process.execPath}" -e "${code}"`;
}

async function runWrapper(
  script: string,
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, stdout: Buffer.concat(output).toString("utf8") })
    );
    child.stdin.end(input);
  });
}

function buildEnvironment(
  provider: "claude" | "antigravity",
  directory: string,
  style: boolean,
  forward?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(provider === "claude"
      ? {
          CTRLYOKE_CLAUDE_STATUSLINE_DIR: directory,
          CTRLYOKE_CLAUDE_STATUSLINE_TOKEN: "claude-token",
          CTRLYOKE_CLAUDE_STATUSLINE_USE_CTRLYOKE_STYLE: String(style),
        }
      : {
          CTRLYOKE_AGY_STATUSLINE_DIR: directory,
          CTRLYOKE_AGY_STATUSLINE_TOKEN: "agy-token",
          CTRLYOKE_AGY_STATUSLINE_USE_CTRLYOKE_STYLE: String(style),
        }),
  };
  if (forward) {
    env[
      provider === "claude"
        ? "CTRLYOKE_CLAUDE_STATUSLINE_FORWARD"
        : "CTRLYOKE_AGY_STATUSLINE_FORWARD"
    ] = forward;
  }
  return env;
}

suite("Shared statusline wrappers", () => {
  let tempDirectory = "";
  const originalMarker = process.env.CTRLYOKE_STATUSLINE_TEST_MARKER;

  teardown(async () => {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = "";
    }
    if (originalMarker === undefined) {
      delete process.env.CTRLYOKE_STATUSLINE_TEST_MARKER;
    } else {
      process.env.CTRLYOKE_STATUSLINE_TEST_MARKER = originalMarker;
    }
  });

  test("keeps the shared timeout and atomic filename prefixes", async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-statusline-wrapper-")
    );
    const payload = { model: { id: "test-model" } };

    assert.strictEqual(shared.FORWARD_TIMEOUT_MS, 200);
    const claudePath = shared.writeSnapshotAtomic(
      tempDirectory,
      "claude-statusline",
      "claude-token",
      payload,
      1234
    );
    const agyPath = shared.writeSnapshotAtomic(
      tempDirectory,
      "agy-statusline",
      "agy-token",
      payload,
      5678
    );

    assert.strictEqual(
      path.basename(claudePath!),
      "claude-statusline-claude-token.json"
    );
    assert.strictEqual(
      path.basename(agyPath!),
      "agy-statusline-agy-token.json"
    );
    const snapshot = JSON.parse(await fs.readFile(claudePath!, "utf8")) as {
      _ctrlyoke: { sequence: number; writtenAt: number };
    };
    assert.strictEqual(snapshot._ctrlyoke.writtenAt, 1234);
    assert.strictEqual(typeof snapshot._ctrlyoke.sequence, "number");
    assert.deepStrictEqual((await fs.readdir(tempDirectory)).sort(), [
      "agy-statusline-agy-token.json",
      "claude-statusline-claude-token.json",
    ]);
  });

  test("formats provider-specific rate and quota data through one formatter", () => {
    const payload = {
      model: { id: "claude-test" },
      context_window: {
        total_input_tokens: 12_000,
        total_output_tokens: 400,
        context_window_size: 1_000_000,
      },
      rate_limits: { five_hour: { used_percentage: 75 } },
      quota: { weekly: { remaining_fraction: 0.98 } },
      agent_state: "idle",
    };

    const claudeLine = shared.formatBrandedStatusLine(
      shared.STATUSLINE_PROVIDERS.CLAUDE,
      payload
    );
    const agyLine = shared.formatBrandedStatusLine(
      shared.STATUSLINE_PROVIDERS.ANTIGRAVITY,
      payload
    );
    assert.match(claudeLine, /claude-test/);
    assert.match(claudeLine, /12\.4k\/1\.0M ctx \(1\.2%\)/);
    assert.match(claudeLine, /rate 25% · idle/);
    assert.match(agyLine, /quota 98% · idle/);
  });

  test("treats malformed payloads and forwarding failures as non-fatal", async () => {
    assert.deepStrictEqual(shared.parsePayload("not json"), {});
    assert.deepStrictEqual(shared.parsePayload("[]"), {});

    const failed = await shared.forwardToCommand(
      nodeCommand("process.exit(1)"),
      "input",
      200
    );
    assert.strictEqual(failed.length, 0);

    const startedAt = Date.now();
    const timedOut = await shared.forwardToCommand(
      nodeCommand("setTimeout(() => {}, 1000)"),
      "input",
      25
    );
    assert.strictEqual(timedOut.length, 0);
    assert.ok(Date.now() - startedAt < 1000);
  });

  for (const [provider, script] of [
    ["claude", scriptPath("ctrlyoke-claude-statusline.js")],
    ["antigravity", scriptPath("ctrlyoke-antigravity-statusline.js")],
  ] as const) {
    test(`${provider} always writes and forwards while branded style discards stdout`, async () => {
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), `ctrlyoke-${provider}-statusline-`)
      );
      const marker = path.join(tempDirectory, "forwarded.txt");
      process.env.CTRLYOKE_STATUSLINE_TEST_MARKER = marker;
      const command = nodeCommand(
        "require('fs').writeFileSync(process.env.CTRLYOKE_STATUSLINE_TEST_MARKER, 'ran'); process.stdout.write('custom')"
      );
      const result = await runWrapper(
        script,
        JSON.stringify({
          model: { id: `${provider}-model` },
          context_window: {
            total_input_tokens: 100,
            total_output_tokens: 20,
            context_window_size: 1_000,
          },
          agent_state: "idle",
        }),
        buildEnvironment(provider, tempDirectory, true, command)
      );

      assert.strictEqual(result.code, 0);
      assert.strictEqual(await fs.readFile(marker, "utf8"), "ran");
      assert.match(result.stdout, /^ctrlyoke ⚡/);
      assert.doesNotMatch(result.stdout, /custom/);
      const filename =
        provider === "claude"
          ? "claude-statusline-claude-token.json"
          : "agy-statusline-agy-token.json";
      assert.ok(
        await fs
          .access(path.join(tempDirectory, filename))
          .then(() => true)
          .catch(() => false)
      );
    });

    test(`${provider} relays custom stdout or nothing when style is disabled`, async () => {
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), `ctrlyoke-${provider}-statusline-`)
      );
      const forwarded = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        buildEnvironment(
          provider,
          tempDirectory,
          false,
          nodeCommand("process.stdout.write('custom')")
        )
      );
      assert.strictEqual(forwarded.code, 0);
      assert.strictEqual(forwarded.stdout, "custom");

      const noCommand = await runWrapper(
        script,
        "not json",
        buildEnvironment(provider, tempDirectory, false)
      );
      assert.strictEqual(noCommand.code, 0);
      assert.strictEqual(noCommand.stdout, "");
    });
  }
});
