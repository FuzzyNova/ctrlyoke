import * as assert from "assert";
import { suite, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { installHintFor } from "../../core/harness/shared/HarnessInstallHint";

const COMMANDS = {
  posix: "curl -fsSL https://example.test/install.sh | bash",
  windows: "irm https://example.test/install.ps1 | iex",
};

suite("HarnessInstallHint", () => {
  test("uses the PowerShell command on Windows", () => {
    assert.strictEqual(
      installHintFor(COMMANDS, "win32"),
      `Install via: ${COMMANDS.windows}`
    );
  });

  test("uses the shell command on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      assert.strictEqual(
        installHintFor(COMMANDS, platform),
        `Install via: ${COMMANDS.posix}`
      );
    }
  });

  test("every harness has an install hint and an npm package only when one exists", () => {
    for (const harnessId of Object.values(HARNESS_IDS)) {
      const { installHint, npmPackage } =
        IntegrationFactory.createCapabilityProvider(harnessId).config;
      assert.match(installHint, /^Install via: \S/, harnessId);
      if (harnessId === HARNESS_IDS.ANTIGRAVITY_CLI) {
        // agy ships only through Google's native installer, never npm.
        assert.strictEqual(npmPackage, undefined);
      } else {
        assert.ok(npmPackage, harnessId);
      }
    }
  });
});
