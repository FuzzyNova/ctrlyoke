import * as vscode from "vscode";
import type { HostedServerControl } from "../core/HostPorts";
import { VSCODE_COMMANDS } from "../types/DashboardConstants";

/** VS Code command implementation for hosted dashboard lifecycle controls. */
export class VsCodeHostedServerControl implements HostedServerControl {
  async enable(): Promise<void> {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.ENABLE_SERVER);
  }

  async disable(): Promise<void> {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.DISABLE_SERVER);
  }

  async regenerateToken(): Promise<void> {
    await vscode.commands.executeCommand(
      VSCODE_COMMANDS.REGENERATE_SERVER_TOKEN
    );
  }
}
