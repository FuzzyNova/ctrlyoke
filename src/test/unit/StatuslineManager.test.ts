import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import { StatuslineManager } from "../../core/harness/shared/StatuslineManager";
import {
  resetStatuslineLauncherCache,
  STATUSLINE_LAUNCHER_FILES,
  statuslineLauncherDirectory,
} from "../../core/harness/shared/StatuslineLauncher";
import {
  INSTALLATION_KINDS,
  recordInstallation,
} from "../../utils/CtrlyokeInstallations";
import { configService } from "../../config/CtrlYokeConfigService";
import { writeStatuslinePackage } from "../helpers/statuslinePackage";
import {
  HARNESS_IDS,
  STATUS_LINE_HARNESS_IDS,
} from "../../types/DashboardConstants";
import type {
  PartialCtrlYokeSettings,
  StatusLineHarnessSettings,
} from "../../types/CtrlYokeSettings";

suite("StatuslineManager", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let userSettings: PartialCtrlYokeSettings;
  let originalCtrlyokeHome: string | undefined;

  setup(async () => {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "statusline-manager-home-")
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    originalCtrlyokeHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = path.join(tempHome, "state");
    resetStatuslineLauncherCache();
    userSettings = {};
    configService.setUserBackend({
      getAll: () => userSettings,
      set: async (settingPath, value) => {
        if (settingPath === "statusLine.byHarness.qwen-cli") {
          userSettings = {
            statusLine: {
              byHarness: { "qwen-cli": value as StatusLineHarnessSettings },
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
    if (originalCtrlyokeHome === undefined) delete process.env.CTRLYOKE_HOME;
    else process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    resetStatuslineLauncherCache();
    configService.setCliOverlay({});
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  test("maps Copilot and Qwen harnesses to their statusline providers", () => {
    assert.strictEqual(
      StatuslineManager.providerForHarness(HARNESS_IDS.COPILOT_CLI),
      STATUS_LINE_HARNESS_IDS.COPILOT
    );
    assert.strictEqual(
      StatuslineManager.providerForHarness(HARNESS_IDS.QWEN_CLI),
      STATUS_LINE_HARNESS_IDS.QWEN
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
    const disabledSettings = userSettings.statusLine?.byHarness?.["qwen-cli"];
    assert.strictEqual(disabledSettings?.enabled, false);

    userSettings = {
      permissions: {},
      statusLine: {
        byHarness: {
          "qwen-cli": {
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

  suite("shared launcher", () => {
    /** A package whose statusline scripts can be deployed. */
    function packageRoot(name: string): Promise<string> {
      return writeStatuslinePackage(path.join(tempHome, name), {
        version: "0.2.0",
      });
    }

    function disableAllProviders(): void {
      const disabled = {
        enabled: false,
        customCommand: "",
        useCtrlyokeStyle: true,
      } as StatusLineHarnessSettings;
      userSettings = {
        statusLine: {
          byHarness: Object.fromEntries(
            Object.values(STATUS_LINE_HARNESS_IDS).map((provider) => [
              provider,
              disabled,
            ])
          ),
        },
      };
    }

    async function launcherExists(): Promise<boolean> {
      return fs
        .access(
          path.join(statuslineLauncherDirectory(), STATUSLINE_LAUNCHER_FILES[0])
        )
        .then(
          () => true,
          () => false
        );
    }

    /** Install Copilot's statusline from the launcher, then disable everything. */
    async function installFromLauncher(
      root: string
    ): Promise<StatuslineManager> {
      const manager = StatuslineManager.forHarness(HARNESS_IDS.COPILOT_CLI);
      const scriptPath = await manager.resolveScriptPath(root);
      assert.ok(scriptPath?.startsWith(statuslineLauncherDirectory()));
      await manager.install(tempHome, `node "${scriptPath}"`);
      disableAllProviders();
      return manager;
    }

    test("uninstall removes the launcher once nothing uses it", async () => {
      const root = await packageRoot("pkg");
      await recordInstallation({
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.2.0",
        packageRoot: root,
      });
      const manager = await installFromLauncher(root);

      await manager.uninstall(tempHome, false);

      assert.strictEqual(await launcherExists(), false);
    });

    test("keeps the launcher while another installation is live", async () => {
      const root = await packageRoot("pkg");
      const other = await packageRoot("other");
      for (const packageRootPath of [root, other]) {
        await recordInstallation({
          kind: INSTALLATION_KINDS.CLI,
          version: "0.2.0",
          packageRoot: packageRootPath,
        });
      }
      const manager = await installFromLauncher(root);

      await manager.uninstall(tempHome, false);

      assert.strictEqual(await launcherExists(), true);
    });

    test("keeps the launcher while another harness still runs it", async () => {
      const root = await packageRoot("pkg");
      const claude = StatuslineManager.forHarness(HARNESS_IDS.CLAUDE_CLI);
      await claude.install(
        tempHome,
        `node "${await claude.resolveScriptPath(root)}"`
      );
      const manager = await installFromLauncher(root);

      await manager.uninstall(tempHome, false);

      assert.strictEqual(await launcherExists(), true);
    });

    test("keeps the launcher while any provider has tracking enabled", async () => {
      const root = await packageRoot("pkg");
      const manager = await installFromLauncher(root);
      userSettings = {};

      await manager.uninstall(tempHome, false);

      assert.strictEqual(await launcherExists(), true);
    });
  });
});
