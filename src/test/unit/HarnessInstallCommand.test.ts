import * as assert from "assert";
import { suite, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { installCommandFor } from "../../core/harness/shared/HarnessInstallCommand";
import { formatHarnessInstallGuidance } from "../../utils/HarnessVersion";

const COMMANDS = {
  posix: "curl -fsSL https://example.test/install.sh | bash",
  windows: "irm https://example.test/install.ps1 | iex",
};

suite("HarnessInstallCommand", () => {
  test("uses the PowerShell command on Windows", () => {
    assert.strictEqual(installCommandFor(COMMANDS, "win32"), COMMANDS.windows);
  });

  test("uses the shell command on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      assert.strictEqual(installCommandFor(COMMANDS, platform), COMMANDS.posix);
    }
  });

  test("wraps the bare command in prose only through the shared formatter", () => {
    assert.strictEqual(
      formatHarnessInstallGuidance(COMMANDS.posix),
      `Install via: ${COMMANDS.posix}`
    );
  });

  test("every harness has a bare install command and an npm package only when one exists", () => {
    for (const harnessId of Object.values(HARNESS_IDS)) {
      const { installCommand, npmPackage } =
        IntegrationFactory.createCapabilityProvider(harnessId).config;
      assert.match(installCommand, /^\S/, harnessId);
      assert.doesNotMatch(installCommand, /^Install via:/, harnessId);
      if (harnessId === HARNESS_IDS.ANTIGRAVITY_CLI) {
        // agy ships only through Google's native installer, never npm.
        assert.strictEqual(npmPackage, undefined);
      } else {
        assert.ok(npmPackage, harnessId);
      }
    }
  });
});
