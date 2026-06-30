import * as vscode from "vscode";
import type { McpServerConfig } from "../types/CtrlYokeTypes";

/**
 * Dynamically injects user-defined MCP servers into VS Code's MCP subsystem
 * for the duration of a ctrlyoke workflow prompt.
 *
 * Only used for the copilot-chat harness. CLI harnesses use CliMcpConfigGenerator
 * to pass --mcp-config flags instead.
 *
 * The "ctrlyoke" built-in server is not managed here — ctrlyoke's LM tools
 * (ctrlyoke_append_queue, ctrlyoke_queue_status, etc.) are registered
 * unconditionally at activation via registerLanguageModelTools() and are always
 * available to Copilot Chat regardless of mcpServers.
 */
export class CtrlYokeMcpServerProvider
  implements vscode.McpServerDefinitionProvider
{
  private activeServers: McpServerConfig[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  /**
   * Called by WorkflowExecutor when a chat prompt starts.
   * Filters out the "ctrlyoke" shorthand — only user-defined McpServerConfig
   * objects are injected here.
   */
  setActiveServers(servers: McpServerConfig[]): void {
    this.activeServers = servers;
    this._onDidChange.fire();
  }

  provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
    // Only stdio servers are supported here — remote (URL-based) servers are not
    // representable as McpStdioServerDefinition and are skipped for copilot-chat.
    return this.activeServers
      .filter((s) => !!s.command)
      .map(
        (s) =>
          new vscode.McpStdioServerDefinition(
            s.id,
            s.command!,
            s.args ?? [],
            s.env ?? {}
          )
      );
  }

  resolveMcpServerDefinition(
    server: vscode.McpStdioServerDefinition
  ): vscode.McpStdioServerDefinition {
    return server;
  }

  dispose(): void {
    this.activeServers = [];
    this._onDidChange.fire();
    this._onDidChange.dispose();
  }
}
