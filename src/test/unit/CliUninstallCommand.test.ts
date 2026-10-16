import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  BUNDLED_CLI_UNINSTALL_MESSAGE,
  buildCliUninstallInfo,
  CLI_UNINSTALL_OUTCOMES,
  formatCliUninstallInfo,
  uninstallCommand,
} from "../../cli/CliUninstallCommand";
import { CLI_USAGE_EXIT_CODE } from "../../cli/CliExitCode";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { INSTALLATION_KINDS } from "../../utils/CtrlyokeInstallations";

suite("CliUninstallCommand", () => {
  test("refuses to run from the copy bundled in the extension", async () => {
    const extension = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-uninstall-")
    );
    try {
      await fs.writeFile(
        path.join(extension, "package.json"),
        JSON.stringify({ engines: { vscode: "^1.106.0" } })
      );
      const out: string[] = [];
      const err: string[] = [];

      const exitCode = await uninstallCommand(
        extension,
        {},
        (message) => out.push(message),
        (message) => err.push(message)
      );

      assert.strictEqual(exitCode, CLI_USAGE_EXIT_CODE);
      assert.deepStrictEqual(out, []);
      assert.deepStrictEqual(err, [BUNDLED_CLI_UNINSTALL_MESSAGE]);
    } finally {
      await fs.rm(extension, { recursive: true, force: true });
    }
  });

  test("names the installations that keep the statusline", () => {
    const info = buildCliUninstallInfo({
      otherInstallations: [
        {
          kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
          version: "0.3.0",
          packageRoot: "/ext",
          lastSeen: 1,
        },
      ],
      restored: [],
      failed: [],
      launcherRemoved: false,
    });

    assert.strictEqual(info.outcome, CLI_UNINSTALL_OUTCOMES.KEPT);
    const text = formatCliUninstallInfo(info);
    assert.match(text, /VS Code extension 0\.3\.0 {2}\/ext/);
    assert.match(text, /npm uninstall -g ctrlyoke/);
  });

  test("withholds the npm uninstall step when a harness could not be updated", () => {
    const info = buildCliUninstallInfo({
      otherInstallations: [],
      restored: [HARNESS_IDS.COPILOT_CLI],
      failed: [{ harnessId: HARNESS_IDS.CLAUDE_CLI, message: "bad JSON" }],
      launcherRemoved: false,
    });

    assert.strictEqual(info.outcome, CLI_UNINSTALL_OUTCOMES.REMOVED);
    assert.doesNotMatch(formatCliUninstallInfo(info), /npm uninstall/);
  });
});
