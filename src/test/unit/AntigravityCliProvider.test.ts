import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return { getAll: () => data, set: async () => {} };
}

suite("AntigravityCliProvider", () => {
  let tempHome: string;
  let workspaceRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  const extensionPath = "C:\\extension root";

  setup(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-provider-home-"));
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agy-provider-workspace-")
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    await fs.mkdir(path.join(tempHome, ".gemini", "config"), {
      recursive: true,
    });
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
    SettingsJsonMcpTracker.resetAll();
  });

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return path.join(tempHome, ".gemini", "antigravity-cli", "settings.json");
  }

  async function buildArgs(provider: AntigravityCliProvider) {
    return provider.buildCliArgs(
      {} as never,
      false,
      extensionPath,
      workspaceRoot,
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        workingFilePath: path.join(workspaceRoot, "workflow.md"),
      }
    );
  }

  test("retains hook artifacts while its process can receive injected turns", () => {
    const provider = new AntigravityCliProvider();

    assert.strictEqual(provider.shouldRetainWorkflowArtifactsForReuse(), true);
  });

  test("routes headless output through the transcript log parser", () => {
    const provider = new AntigravityCliProvider();

    assert.strictEqual(provider.headlessSource, "log");
    assert.ok(provider.logParser);
    assert.ok(provider.extractSessionIdFromLogs);
  });

  test("regenerates the token for every prompt and forwards it to both spawn modes", async () => {
    const provider = new AntigravityCliProvider();
    const inheritedKey = "CTRLYOKE_AGY_PROVIDER_TEST_ENV";
    process.env[inheritedKey] = "preserve-me";

    try {
      await buildArgs(provider);
      const firstHeadless = provider.getHeadlessSpawnEnv();
      const firstInteractive = provider.getInteractiveSpawnEnv();
      await buildArgs(provider);
      const secondHeadless = provider.getHeadlessSpawnEnv();

      assert.ok(firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN);
      assert.ok(firstHeadless.CTRLYOKE_AGY_STATUSLINE_DIR);
      assert.strictEqual(
        firstInteractive.CTRLYOKE_AGY_STATUSLINE_TOKEN,
        firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN
      );
      assert.strictEqual(firstInteractive[inheritedKey], "preserve-me");
      assert.ok(secondHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN);
      assert.notStrictEqual(
        secondHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN,
        firstHeadless.CTRLYOKE_AGY_STATUSLINE_TOKEN
      );
    } finally {
      delete process.env[inheritedKey];
      await provider.cleanupWorkspaceArtifacts(
        workspaceRoot,
        path.join(workspaceRoot, "workflow.md")
      );
    }
  });

  test("registers an unquoted forward-slash command and forwards the baseline command", async () => {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({
        statusLine: { type: "command", command: "node user-statusline.js" },
        theme: "dark",
      })
    );
    const provider = new AntigravityCliProvider();

    try {
      await buildArgs(provider);
      const settings = JSON.parse(await fs.readFile(settingsPath(), "utf8"));
      assert.strictEqual(
        settings.statusLine.command,
        "node C:/extension root/out/scripts/ctrlyoke-antigravity-statusline.js"
      );
      assert.ok(!settings.statusLine.command.includes('"'));
      assert.strictEqual(
        provider.getHeadlessSpawnEnv().CTRLYOKE_AGY_STATUSLINE_FORWARD,
        "node user-statusline.js"
      );
    } finally {
      await provider.cleanupWorkspaceArtifacts(
        workspaceRoot,
        path.join(workspaceRoot, "workflow.md")
      );
    }

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath(), "utf8")),
      {
        statusLine: { type: "command", command: "node user-statusline.js" },
        theme: "dark",
      }
    );
  });

  test("does not write settings or statusline env when tracking is disabled", async () => {
    const original = { theme: "dark" };
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(original));
    configService.setUserBackend(
      makeBackend({ permissions: { antigravityStatusLineTracking: false } })
    );
    const provider = new AntigravityCliProvider();

    await buildArgs(provider);

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath(), "utf8")),
      original
    );
    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_AGY_STATUSLINE_TOKEN,
      undefined
    );
    assert.strictEqual(
      provider.getInteractiveSpawnEnv().CTRLYOKE_AGY_STATUSLINE_DIR,
      undefined
    );
  });

  test("unregisters the statusline lease during cleanup", async () => {
    const provider = new AntigravityCliProvider();
    await buildArgs(provider);
    assert.ok(
      (await fs.readFile(settingsPath(), "utf8")).includes("statusLine")
    );

    await provider.cleanupWorkspaceArtifacts(
      workspaceRoot,
      path.join(workspaceRoot, "workflow.md")
    );

    await assert.rejects(fs.access(settingsPath()), /ENOENT/);
    assert.strictEqual(
      provider.getAdditionalCleanupFilePaths(workspaceRoot).length,
      1
    );
  });
});
