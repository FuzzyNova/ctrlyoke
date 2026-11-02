import * as assert from "assert";
import { Command } from "commander";
import { suite, test } from "mocha";
import {
  registerExportCommand,
  type RunExportOptions,
} from "../../cli/RunExportCommand";
import { buildRunBundleExportOptions } from "../../core/orchestration/RunBundleExportOptions";

suite("RunExportCommand", () => {
  test("parses --no-changes as the negated changes option", async () => {
    let received: RunExportOptions | undefined;
    const program = new Command();
    registerExportCommand(program, async (options) => {
      received = options;
    });
    await program.parseAsync([
      "node",
      "ctrlyoke",
      "export",
      "--workflow",
      "fixture",
      "--out",
      "bundle",
      "--no-changes",
    ]);
    assert.strictEqual(received?.changes, false);
  });
});

suite("RunBundleExportOptions", () => {
  test("shares security context and defaults for CLI and dashboard exports", () => {
    const environment = { CTRLYOKE_TEST_SECRET: "value" };
    const options = buildRunBundleExportOptions({
      stateRoot: "state",
      workspaceRoot: "workspace",
      workflowKey: "workflow-a" as never,
      runRef: "run-a" as never,
      bundleDir: "bundle.ctrlyokerun",
      exportedByVersion: "test-version",
      environment,
      homeDir: "home",
      includeChanges: false,
      includeSnapshots: true,
    });

    assert.strictEqual(options.stateRoot, "state");
    assert.strictEqual(options.workspaceRoot, "workspace");
    assert.strictEqual(options.includeChanges, false);
    assert.strictEqual(options.includeSnapshots, true);
    assert.strictEqual(options.homeDir, "home");
    assert.strictEqual(options.secrets?.workspaceRoot, "workspace");
    assert.strictEqual(options.secrets?.environment, environment);
    assert.ok(options.secrets?.secretStore);
  });
});
