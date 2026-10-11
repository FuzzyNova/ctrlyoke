import * as assert from "assert";
import * as vscode from "vscode";
import {
  QUIET_SERVER_COMMAND,
  VsCodeHostedServerControl,
} from "../../platform/VsCodeHostedServerControl";
import { VSCODE_COMMANDS } from "../../types/DashboardConstants";

suite("VsCodeHostedServerControl", () => {
  const originalExecuteCommand = vscode.commands.executeCommand;
  let calls: unknown[][];

  setup(() => {
    calls = [];
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (...args: unknown[]) => {
        calls.push(args);
      },
    });
  });

  teardown(() => {
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: originalExecuteCommand,
    });
  });

  test("starts and stops quietly, because the dashboard shows the server state itself", async () => {
    const control = new VsCodeHostedServerControl();

    await control.enable();
    await control.disable();

    assert.deepStrictEqual(calls, [
      [VSCODE_COMMANDS.ENABLE_SERVER, QUIET_SERVER_COMMAND],
      [VSCODE_COMMANDS.DISABLE_SERVER, QUIET_SERVER_COMMAND],
    ]);
  });
});
