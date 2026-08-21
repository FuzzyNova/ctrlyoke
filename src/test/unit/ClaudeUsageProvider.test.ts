import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { ClaudeStatuslineSidecar } from "../../core/harness/claude/ClaudeStatuslineSidecar";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import {
  parseClaudeQuotaSnapshot,
  parseClaudeRateLimitWindows,
} from "../../core/harness/shared/usage/providers/ClaudeUsageProvider";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import { HARNESS_USAGE_WINDOW_KINDS } from "../../types/DashboardConstants";

function backend(data: PartialCtrlYokeSettings): ConfigBackend {
  return { getAll: () => data, set: async () => {} };
}

suite("ClaudeUsageProvider", () => {
  let tempDirectory: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    configService.setUserBackend(backend({}));
    configService.setWorkspaceBackend(backend({}));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("normalizes Claude rate-limit windows and ISO reset timestamps", () => {
    const windows = parseClaudeRateLimitWindows({
      account: { email: "must-not-be-retained@example.com" },
      rate_limits: {
        five_hour: {
          used_percentage: 37.5,
          resets_at: "2026-08-09T12:34:56.000Z",
        },
        seven_day: { used_percentage: 4 },
      },
    });

    assert.strictEqual(windows.length, 2);
    assert.strictEqual(windows[0].percentUsed, 37.5);
    assert.strictEqual(
      windows[0].resetAt,
      Date.parse("2026-08-09T12:34:56.000Z")
    );
    assert.strictEqual(windows[1].windowMinutes, 10080);
    assert.strictEqual(
      JSON.stringify(windows).includes("must-not-be-retained"),
      false
    );
  });

  test("derives window label and kind from duration, matching Codex's shared formatter", () => {
    const windows = parseClaudeRateLimitWindows({
      rate_limits: {
        five_hour: { used_percentage: 10 },
        seven_day: { used_percentage: 20 },
      },
    });

    assert.strictEqual(windows[0].label, "5h");
    assert.strictEqual(windows[0].kind, HARNESS_USAGE_WINDOW_KINDS.ROLLING);
    assert.strictEqual(windows[1].label, "week");
    assert.strictEqual(windows[1].kind, HARNESS_USAGE_WINDOW_KINDS.WEEKLY);
  });

  test("treats absent, partial, and drifted rate_limits as normal", () => {
    assert.deepStrictEqual(parseClaudeRateLimitWindows({}), []);
    assert.deepStrictEqual(
      parseClaudeRateLimitWindows({ rate_limits: { five_hour: {} } }),
      []
    );
    assert.deepStrictEqual(
      parseClaudeRateLimitWindows({ rate_limits: { renamed_window: {} } }),
      []
    );
    assert.strictEqual(parseClaudeQuotaSnapshot({}), undefined);
  });

  test("pushes only normalized windows from the sidecar", async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-claude-usage-")
    );
    const snapshotPath = path.join(tempDirectory, "statusline.json");
    const updates: Array<{ windows: number; resetAt?: number }> = [];
    const sidecar = new ClaudeStatuslineSidecar({
      snapshotPath,
      onProviderUsageUpdate: (quota) =>
        updates.push({
          windows: quota.windows.length,
          resetAt: quota.windows[0]?.resetAt,
        }),
    });

    try {
      await fs.writeFile(
        snapshotPath,
        JSON.stringify({
          rate_limits: {
            five_hour: {
              used_percentage: 55,
              resets_at: "2026-08-09T12:34:56.000Z",
            },
          },
          account: { id: "private-account-id" },
          _ctrlyoke: { sequence: 1, writtenAt: Date.now() },
        })
      );
      for (
        let attempt = 0;
        attempt < 50 && updates.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepStrictEqual(updates[0], {
        windows: 1,
        resetAt: Date.parse("2026-08-09T12:34:56.000Z"),
      });
    } finally {
      sidecar.stop();
    }
  });

  test("keeps the Claude statusline installed across cleanup", async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-claude-settings-")
    );
    process.env.HOME = tempDirectory;
    process.env.USERPROFILE = tempDirectory;
    configService.setUserBackend(
      backend({
        permissions: {
          statusLineTracking: {
            claude: {
              enabled: true,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
        usageTracking: { enabled: false },
      })
    );
    configService.setWorkspaceBackend(backend({}));

    const settingsPath = path.join(tempDirectory, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "node user-statusline.js" },
        theme: "dark",
      })
    );

    const provider = new ClaudeCliProvider();
    await provider.buildCliArgs(
      {} as never,
      false,
      "C:/extension root",
      path.join(tempDirectory, "workspace"),
      undefined,
      { promptIndex: 0, allPrompts: [], workingFilePath: "workflow.md" }
    );

    const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.match(
      installed.statusLine.command,
      /ctrlyoke-claude-statusline\.js/
    );
    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_CLAUDE_STATUSLINE_FORWARD,
      undefined
    );

    await provider.cleanupWorkspaceArtifacts(
      path.join(tempDirectory, "workspace"),
      "workflow.md"
    );
    assert.match(
      JSON.parse(await fs.readFile(settingsPath, "utf8")).statusLine.command,
      /ctrlyoke-claude-statusline\.js/
    );
  });

  test("does not install the statusline collector when Claude tracking is disabled", async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-claude-usage-disabled-")
    );
    process.env.HOME = tempDirectory;
    process.env.USERPROFILE = tempDirectory;
    configService.setUserBackend(
      backend({
        permissions: {
          statusLineTracking: {
            claude: {
              enabled: false,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
        usageTracking: { enabled: true },
      })
    );
    configService.setWorkspaceBackend(backend({}));

    const settingsPath = path.join(tempDirectory, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "node user-statusline.js" },
      })
    );

    const provider = new ClaudeCliProvider();
    await provider.buildCliArgs(
      {} as never,
      false,
      "C:/extension root",
      path.join(tempDirectory, "workspace"),
      undefined,
      { promptIndex: 0, allPrompts: [], workingFilePath: "workflow.md" }
    );

    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_CLAUDE_STATUSLINE_FORWARD,
      undefined
    );
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      { statusLine: { type: "command", command: "node user-statusline.js" } }
    );
  });
});
