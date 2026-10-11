import * as vscode from "vscode";
import type { HostedServerControl } from "../core/HostPorts";
import { VSCODE_COMMANDS } from "../types/DashboardConstants";

/**
 * Argument of the start and stop server commands. The Command Palette passes
 * none, so the command confirms the result in a toast; callers whose own UI
 * already shows the server state pass `quiet: true`.
 */
export interface ServerCommandOptions {
  quiet?: boolean;
}

export const QUIET_SERVER_COMMAND: ServerCommandOptions = { quiet: true };

/** VS Code command implementation for hosted dashboard lifecycle controls. */
export class VsCodeHostedServerControl implements HostedServerControl {
  async enable(): Promise<void> {
    await vscode.commands.executeCommand(
      VSCODE_COMMANDS.ENABLE_SERVER,
      QUIET_SERVER_COMMAND
    );
  }

  async disable(): Promise<void> {
    await vscode.commands.executeCommand(
      VSCODE_COMMANDS.DISABLE_SERVER,
      QUIET_SERVER_COMMAND
    );
  }

  async regenerateToken(): Promise<void> {
    await vscode.commands.executeCommand(
      VSCODE_COMMANDS.REGENERATE_SERVER_TOKEN
    );
  }
}
