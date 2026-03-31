import * as assert from "assert";
import { suite, test } from "mocha";
import { setRuntimeMode, isCli } from "../../utils/RuntimeMode";
import { RUNNER_IDS } from "../../types/DashboardConstants";

suite("RuntimeMode", () => {
  // Reset to default after each test to avoid cross-test pollution
  teardown(() => {
    setRuntimeMode(RUNNER_IDS.VSCODE);
  });

  suite("isCli", () => {
    test("returns false by default (vscode mode)", () => {
      setRuntimeMode(RUNNER_IDS.VSCODE);
      assert.strictEqual(isCli(), false);
    });

    test("returns true after setting CLI mode", () => {
      setRuntimeMode(RUNNER_IDS.CLI);
      assert.strictEqual(isCli(), true);
    });

    test("returns false after switching back to vscode mode", () => {
      setRuntimeMode(RUNNER_IDS.CLI);
      assert.strictEqual(isCli(), true);
      setRuntimeMode(RUNNER_IDS.VSCODE);
      assert.strictEqual(isCli(), false);
    });
  });

  suite("setRuntimeMode", () => {
    test("sets mode to CLI", () => {
      setRuntimeMode(RUNNER_IDS.CLI);
      assert.strictEqual(isCli(), true);
    });

    test("sets mode to VSCODE", () => {
      setRuntimeMode(RUNNER_IDS.VSCODE);
      assert.strictEqual(isCli(), false);
    });

    test("can be called multiple times", () => {
      setRuntimeMode(RUNNER_IDS.CLI);
      setRuntimeMode(RUNNER_IDS.CLI);
      assert.strictEqual(isCli(), true);
    });
  });

  suite("RUNNER_IDS constants", () => {
    test("VSCODE is 'vscode'", () => {
      assert.strictEqual(RUNNER_IDS.VSCODE, "vscode");
    });

    test("CLI is 'cli'", () => {
      assert.strictEqual(RUNNER_IDS.CLI, "cli");
    });
  });
});
