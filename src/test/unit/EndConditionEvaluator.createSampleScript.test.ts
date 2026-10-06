import { INTERACTIVE_TERMINAL_MODES } from "../../types/DashboardConstants";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { EndConditionEvaluator } from "../../core/EndConditionEvaluator";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import { END_CONDITION_SCRIPT_TYPES } from "../../types/DashboardConstants";

suite("EndConditionEvaluator.createSampleScript", () => {
  let workspaceRoot: string;

  teardown(async () => {
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  async function createEvaluator(): Promise<EndConditionEvaluator> {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-create-script-")
    );
    const platform: PlatformAdapter = {
      interactiveTerminal: INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY,
    getWorkspaceRoot: () => workspaceRoot,
      getWorkspaceRoots: () => [workspaceRoot],
      getNamedWorkspaceRoots: () => [],
      getExtensionPath: () => path.resolve(__dirname, "../../.."),
    };
    return new EndConditionEvaluator(platform);
  }

  test("rejects duplicate names without changing the existing script", async () => {
    const evaluator = await createEvaluator();
    const scriptPath = await evaluator.createSampleScript(
      END_CONDITION_SCRIPT_TYPES.PYTHON,
      "custom.py"
    );
    assert.ok(scriptPath);
    const originalContent = await fs.readFile(scriptPath);

    await assert.rejects(
      evaluator.createSampleScript(
        END_CONDITION_SCRIPT_TYPES.PYTHON,
        "custom.py"
      ),
      /A script named "custom\.py" already exists in \.ctrlyoke\/scripts/
    );
    assert.deepStrictEqual(await fs.readFile(scriptPath), originalContent);
  });

  test("uses the shell template matching the destination extension", async () => {
    const evaluator = await createEvaluator();
    const shPath = await evaluator.createSampleScript(
      END_CONDITION_SCRIPT_TYPES.SHELL,
      "check_condition.sh"
    );
    const batPath = await evaluator.createSampleScript(
      END_CONDITION_SCRIPT_TYPES.SHELL,
      "foo.bat"
    );

    assert.ok(shPath);
    assert.ok(batPath);
    assert.deepStrictEqual(
      await fs.readFile(shPath),
      await fs.readFile(
        path.resolve(__dirname, "../../templates/check_condition.sh")
      )
    );
    assert.deepStrictEqual(
      await fs.readFile(batPath),
      await fs.readFile(
        path.resolve(__dirname, "../../templates/check_condition.bat")
      )
    );
  });
});
