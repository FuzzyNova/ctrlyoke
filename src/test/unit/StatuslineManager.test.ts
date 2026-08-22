import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import { StatuslineManager } from "../../core/harness/shared/StatuslineManager";
import { configService } from "../../config/CtrlYokeConfigService";
import {
  HARNESS_IDS,
  STATUS_LINE_TRACKING_PROVIDERS,
} from "../../types/DashboardConstants";
import type {
  PartialCtrlYokeSettings,
  StatusLineTrackingSettings,
} from "../../types/CtrlYokeSettings";

suite("StatuslineManager", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let userSettings: PartialCtrlYokeSettings;

  setup(async () => {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "statusline-manager-home-")
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    userSettings = {};
    configService.setUserBackend({
      getAll: () => userSettings,
      set: async (settingPath, value) => {
        if (settingPath === "permissions.statusLineTracking.qwen") {
          userSettings = {
            permissions: {
              statusLineTracking: {
                qwen: value as StatusLineTrackingSettings,
              },
            },
          };
        }
      },
    });
    configService.setCliOverlay({});
  });

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    configService.setCliOverlay({});
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  test("maps Copilot and Qwen harnesses to their statusline providers", () => {
    assert.strictEqual(
      StatuslineManager.providerForHarness(HARNESS_IDS.COPILOT_CLI),
      STATUS_LINE_TRACKING_PROVIDERS.COPILOT
    );
    assert.strictEqual(
      StatuslineManager.providerForHarness(HARNESS_IDS.QWEN_CLI),
      STATUS_LINE_TRACKING_PROVIDERS.QWEN
    );
  });

  test("installs and uninstalls Copilot's flat statusline setting", async () => {
    const settingsPath = path.join(tempHome, ".copilot", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ theme: "dark" }));

    const manager = StatuslineManager.forHarness(HARNESS_IDS.COPILOT_CLI);
    await manager.install(tempHome, "node ctrlyoke-copilot-statusline.js");

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      {
        theme: "dark",
        statusLine: {
          type: "command",
          command: "node ctrlyoke-copilot-statusline.js",
        },
      }
    );

    await manager.uninstall(tempHome, false);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      {
        theme: "dark",
      }
    );
  });

  test("round-trips Qwen's nested statusline setting", async () => {
    const settingsPath = path.join(tempHome, ".qwen", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", ui: { sidebar: "visible" } })
    );

    const manager = StatuslineManager.forHarness(HARNESS_IDS.QWEN_CLI);
    await manager.install(tempHome, "node ctrlyoke-qwen-statusline.js");

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      {
        theme: "dark",
        ui: {
          sidebar: "visible",
          statusLine: {
            type: "command",
            command: "node ctrlyoke-qwen-statusline.js",
          },
        },
      }
    );

    await manager.uninstall(tempHome, false);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      {
        theme: "dark",
        ui: { sidebar: "visible" },
      }
    );
  });

  test("leaves a Qwen preset untouched until the user re-enables tracking", async () => {
    const settingsPath = path.join(tempHome, ".qwen", "settings.json");
    const presetText =
      JSON.stringify(
        {
          theme: "dark",
          ui: {
            statusLine: {
              type: "preset",
              items: ["project-name", "git-branch"],
              useThemeColors: true,
            },
          },
        },
        null,
        2
      ) + "\n";
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, presetText);

    const manager = StatuslineManager.forHarness(HARNESS_IDS.QWEN_CLI);
    const firstResult = await manager.install(
      tempHome,
      "node ctrlyoke-qwen-statusline.js"
    );

    assert.deepStrictEqual(firstResult, {
      kind: "declined",
      captured: false,
      collision: true,
    });
    assert.strictEqual(await fs.readFile(settingsPath, "utf8"), presetText);
    const disabledSettings = userSettings.permissions?.statusLineTracking?.qwen;
    assert.strictEqual(disabledSettings?.enabled, false);

    userSettings = {
      permissions: {
        statusLineTracking: {
          qwen: {
            ...disabledSettings!,
            enabled: true,
          },
        },
      },
    };
    const secondResult = await manager.install(
      tempHome,
      "node ctrlyoke-qwen-statusline.js"
    );

    assert.strictEqual(secondResult.kind, "written");
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      {
        theme: "dark",
        ui: {
          statusLine: {
            type: "command",
            command: "node ctrlyoke-qwen-statusline.js",
          },
        },
      }
    );
  });
});
