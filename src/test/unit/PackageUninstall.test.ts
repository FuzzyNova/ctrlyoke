import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import { uninstallPackageIntegration } from "../../core/harness/shared/PackageUninstall";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import { StatuslineManager } from "../../core/harness/shared/StatuslineManager";
import { resetStatuslineLauncherCache } from "../../core/harness/shared/StatuslineLauncher";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import {
  INSTALLATION_KINDS,
  readLiveInstallations,
  recordInstallation,
} from "../../utils/CtrlyokeInstallations";
import { writeStatuslinePackage } from "../helpers/statuslinePackage";

suite("PackageUninstall", () => {
  let tempHome: string;
  let claudeSettingsPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["HOME", "USERPROFILE", "CTRLYOKE_HOME"] as const;

  setup(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "package-uninstall-"));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CTRLYOKE_HOME = path.join(tempHome, "state");
    resetStatuslineLauncherCache();
    const userSettings: PartialCtrlYokeSettings = {};
    configService.setUserBackend({
      getAll: () => userSettings,
      set: async () => userSettings,
    });
    configService.setCliOverlay({});
    claudeSettingsPath = path.join(tempHome, ".claude", "settings.json");
  });

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetStatuslineLauncherCache();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  /** Record an installation at `name` and point Claude's statusline at the launcher. */
  async function installAs(
    name: string,
    kind: (typeof INSTALLATION_KINDS)[keyof typeof INSTALLATION_KINDS]
  ): Promise<string> {
    const root = await writeStatuslinePackage(path.join(tempHome, name), {
      version: "0.2.0",
    });
    await recordInstallation({ kind, version: "0.2.0", packageRoot: root });
    const claude = StatuslineManager.forHarness(HARNESS_IDS.CLAUDE_CLI);
    await claude.install(
      tempHome,
      `node "${await claude.resolveScriptPath(root)}"`
    );
    return root;
  }

  async function claudeStatusLine(): Promise<unknown> {
    return (
      JSON.parse(await fs.readFile(claudeSettingsPath, "utf8")) as {
        statusLine?: unknown;
      }
    ).statusLine;
  }

  test("leaves the integration to another live installation", async () => {
    const extension = await installAs(
      "extension",
      INSTALLATION_KINDS.VSCODE_EXTENSION
    );
    const npmCli = await installAs("npm-cli", INSTALLATION_KINDS.CLI);
    const before = await claudeStatusLine();

    const result = await uninstallPackageIntegration(extension);

    assert.deepStrictEqual(
      result.otherInstallations.map((record) => record.packageRoot),
      [npmCli]
    );
    assert.deepStrictEqual(result.restored, []);
    assert.strictEqual(result.launcherRemoved, false);
    assert.deepStrictEqual(await claudeStatusLine(), before);
    assert.deepStrictEqual(
      (await readLiveInstallations()).map((record) => record.packageRoot),
      [npmCli]
    );
  });

  test("removes the integration when the last installation goes", async () => {
    const npmCli = await installAs("npm-cli", INSTALLATION_KINDS.CLI);

    const result = await uninstallPackageIntegration(npmCli);

    assert.deepStrictEqual(result.otherInstallations, []);
    assert.deepStrictEqual(result.restored, [HARNESS_IDS.CLAUDE_CLI]);
    assert.strictEqual(result.launcherRemoved, true);
    assert.strictEqual(await claudeStatusLine(), undefined);
    assert.deepStrictEqual(await readLiveInstallations(), []);
  });
});
