import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { registerRunCommand } from "../../cli/CliRunCommandDefinitions";

suite("CLI run command definitions", () => {
  test("every execution setting in run help exists in the settings schema", () => {
    const program = new Command();
    registerRunCommand(program, async () => {});

    const runCommand = program.commands.find(
      (command) => command.name() === "run"
    );
    assert.ok(runCommand, "run command should be registered");

    const settingsSchemaPath = path.resolve(
      __dirname,
      "../../../schemas/settings-schema.json"
    );
    const settingsSchema = JSON.parse(
      fs.readFileSync(settingsSchemaPath, "utf-8")
    ) as {
      properties: {
        execution: { properties: Record<string, unknown> };
      };
    };
    const executionProperties = settingsSchema.properties.execution.properties;
    const executionSettingNames = new Set(
      runCommand
        .helpInformation()
        .match(/execution\.[A-Za-z][A-Za-z0-9]*/gu) ?? []
    );

    assert.ok(
      executionSettingNames.size > 0,
      "run help should mention at least one execution setting"
    );
    for (const settingName of executionSettingNames) {
      const propertyName = settingName.slice("execution.".length);
      assert.ok(
        Object.prototype.hasOwnProperty.call(executionProperties, propertyName),
        `${settingName} from run help must exist in schemas/settings-schema.json`
      );
    }
  });
});
