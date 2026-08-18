import * as assert from "assert";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { WorkflowCommandHandler } from "../../core/orchestration/WorkflowCommandHandler";

suite("WorkflowCommandHandler", () => {
  test("opens the dashboard without a harness-status gate", async () => {
    const originalExecuteCommand = vscode.commands.executeCommand;
    const commands: string[] = [];
    vscode.commands.executeCommand = (async (command: string) => {
      commands.push(command);
      return undefined;
    }) as typeof vscode.commands.executeCommand;

    try {
      await new WorkflowCommandHandler().openPanel();
    } finally {
      vscode.commands.executeCommand = originalExecuteCommand;
    }

    assert.deepStrictEqual(commands, ["ctrlyoke.dashboard.focus"]);
  });
});
