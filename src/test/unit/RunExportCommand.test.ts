import * as assert from "assert";
import { Command } from "commander";
import { suite, test } from "mocha";
import {
  registerExportCommand,
  type RunExportOptions,
} from "../../cli/RunExportCommand";

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
