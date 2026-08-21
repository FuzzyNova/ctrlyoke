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
  formatUsagePercentForDisplay(
    usedPercent: number,
    direction: "used" | "remaining"
  ): number;
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
  directory: string
): NodeJS.ProcessEnv {
  return {
    ...(provider === "claude"
      ? {
          CTRLYOKE_CLAUDE_STATUSLINE_DIR: directory,
          CTRLYOKE_CLAUDE_STATUSLINE_TOKEN: "claude-token",
        }
      : {
          CTRLYOKE_AGY_STATUSLINE_DIR: directory,
          CTRLYOKE_AGY_STATUSLINE_TOKEN: "agy-token",
        }),
  };
}

async function writeMachineSettings(
  homeDirectory: string,
  provider: "claude" | "antigravity",
  settings: {
    enabled?: boolean;
    customCommand?: string;
    useCtrlyokeStyle?: boolean;
  }
): Promise<void> {
  const filePath = path.join(homeDirectory, ".ctrlyoke", "settings.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      permissions: {
        statusLineTracking: {
          [provider]: {
            enabled: true,
            customCommand: "",
            useCtrlyokeStyle: true,
            ...settings,
          },
        },
      },
    })
  );
}

suite("Shared statusline wrappers", () => {
  let tempDirectory = "";
  let tempHome = "";
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalMarker = process.env.CTRLYOKE_STATUSLINE_TEST_MARKER;

  teardown(async () => {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = "";
    }
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalMarker === undefined) {
      delete process.env.CTRLYOKE_STATUSLINE_TEST_MARKER;
    } else {
      process.env.CTRLYOKE_STATUSLINE_TEST_MARKER = originalMarker;
    }
  });

  async function createHome(): Promise<string> {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-statusline-home-")
    );
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    return tempHome;
  }

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

  test("loads the shared formatter sibling and uses it in a child process", async () => {
    const formatPath = scriptPath("ctrlyoke-statusline-format.js");
    await fs.access(formatPath);
    assert.strictEqual(
      shared.formatUsagePercentForDisplay(37, "remaining"),
      63
    );

    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "const wrapper = require(process.argv[1]); process.stdout.write(String(wrapper.formatUsagePercentForDisplay(37, 'remaining')))",
            scriptPath("ctrlyoke-statusline-wrapper.js"),
          ],
          {
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          }
        );
        const output: Buffer[] = [];
        child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({
            code,
            stdout: Buffer.concat(output).toString("utf8"),
          })
        );
      }
    );

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, "63");
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
      await createHome();
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), `ctrlyoke-${provider}-statusline-`)
      );
      const marker = path.join(tempDirectory, "forwarded.txt");
      process.env.CTRLYOKE_STATUSLINE_TEST_MARKER = marker;
      const command = nodeCommand(
        "require('fs').writeFileSync(process.env.CTRLYOKE_STATUSLINE_TEST_MARKER, 'ran'); process.stdout.write('custom')"
      );
      await writeMachineSettings(tempHome, provider, {
        customCommand: command,
        useCtrlyokeStyle: true,
      });
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
        buildEnvironment(provider, tempDirectory)
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
      await createHome();
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), `ctrlyoke-${provider}-statusline-`)
      );
      await writeMachineSettings(tempHome, provider, {
        customCommand: nodeCommand("process.stdout.write('custom')"),
        useCtrlyokeStyle: false,
      });
      const forwarded = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        buildEnvironment(provider, tempDirectory)
      );
      assert.strictEqual(forwarded.code, 0);
      assert.strictEqual(forwarded.stdout, "custom");

      await writeMachineSettings(tempHome, provider, {
        customCommand: "",
        useCtrlyokeStyle: false,
      });
      const noCommand = await runWrapper(
        script,
        "not json",
        buildEnvironment(provider, tempDirectory)
      );
      assert.strictEqual(noCommand.code, 0);
      assert.strictEqual(noCommand.stdout, "");
    });
  }

  for (const [provider, script] of [
    ["claude", scriptPath("ctrlyoke-claude-statusline.js")],
    ["antigravity", scriptPath("ctrlyoke-antigravity-statusline.js")],
  ] as const) {
    test(`${provider} resolves persisted settings without a ctrlyoke launch environment`, async () => {
      await createHome();
      const first = nodeCommand("process.stdout.write('first')");
      await writeMachineSettings(tempHome, provider, {
        customCommand: first,
        useCtrlyokeStyle: false,
      });

      const firstResult = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        { HOME: tempHome, USERPROFILE: tempHome }
      );
      assert.strictEqual(firstResult.stdout, "first");

      await writeMachineSettings(tempHome, provider, {
        customCommand: nodeCommand("process.stdout.write('second')"),
        useCtrlyokeStyle: false,
      });
      const secondResult = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        { HOME: tempHome, USERPROFILE: tempHome }
      );
      assert.strictEqual(secondResult.stdout, "second");
    });

    test(`${provider} uses safe defaults for empty or malformed machine settings`, async () => {
      await createHome();
      const settingsPath = path.join(tempHome, ".ctrlyoke", "settings.json");
      const missing = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        { HOME: tempHome, USERPROFILE: tempHome }
      );
      assert.match(missing.stdout, /^ctrlyoke ⚡/);

      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "{}");
      const empty = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        { HOME: tempHome, USERPROFILE: tempHome }
      );
      assert.match(empty.stdout, /^ctrlyoke ⚡/);

      await fs.writeFile(settingsPath, "{ malformed");
      const malformed = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        { HOME: tempHome, USERPROFILE: tempHome }
      );
      assert.match(malformed.stdout, /^ctrlyoke ⚡/);
    });

    test(`${provider} forwards without snapshot or branding when disabled`, async () => {
      await createHome();
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), `ctrlyoke-${provider}-disabled-`)
      );
      await writeMachineSettings(tempHome, provider, {
        enabled: false,
        customCommand: nodeCommand("process.stdout.write('restored')"),
        useCtrlyokeStyle: true,
      });
      const result = await runWrapper(
        script,
        JSON.stringify({ model: { id: `${provider}-model` } }),
        {
          ...buildEnvironment(provider, tempDirectory),
          HOME: tempHome,
          USERPROFILE: tempHome,
        }
      );

      assert.strictEqual(result.stdout, "restored");
      assert.strictEqual((await fs.readdir(tempDirectory)).length, 0);
    });
  }
});
