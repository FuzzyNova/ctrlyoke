import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { createHomeWorkspaceConfigDiagnostics } from "../../core/harness/shared/HomeWorkspaceConfigDiagnostic";
import type { PreparedMutation } from "../../core/harness/shared/interfaces/PreparedMutation";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../../types/CompatibilityTypes";

function mutation(
  filePath: string,
  workspaceHarnessConfig?: boolean
): PreparedMutation {
  return {
    path: filePath,
    ...(workspaceHarnessConfig ? { workspaceHarnessConfig } : {}),
    apply: async () => {},
  };
}

suite("HomeWorkspaceConfigDiagnostic", () => {
  const home = os.homedir();

  test("warns about workspace harness config written in the home directory", () => {
    const diagnostics = createHomeWorkspaceConfigDiagnostics(
      HARNESS_IDS.ANTIGRAVITY_CLI,
      home,
      [
        mutation(path.join(home, ".agents", "mcp_config.json"), true),
        mutation(path.join(home, ".ctrlyoke", "temp", "hooks.json")),
      ]
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(
      diagnostics[0].code,
      COMPATIBILITY_DIAGNOSTIC_CODES.HOME_WORKSPACE_USER_CONFIG
    );
    assert.strictEqual(
      diagnostics[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
    );
    assert.match(diagnostics[0].message, /~\/\.agents\/mcp_config\.json/);
    assert.doesNotMatch(diagnostics[0].message, /hooks\.json/);
  });

  test("stays silent outside the home directory", () => {
    const project = path.join(home, "some-project");
    assert.deepStrictEqual(
      createHomeWorkspaceConfigDiagnostics(HARNESS_IDS.COPILOT_CLI, project, [
        mutation(
          path.join(project, ".github", "hooks", "ctrlyoke-1.json"),
          true
        ),
      ]),
      []
    );
  });

  test("stays silent when the launch writes no workspace harness config", () => {
    assert.deepStrictEqual(
      createHomeWorkspaceConfigDiagnostics(HARNESS_IDS.CLAUDE_CLI, home, [
        mutation(path.join(home, ".ctrlyoke", "temp", "settings.json")),
      ]),
      []
    );
  });
});
