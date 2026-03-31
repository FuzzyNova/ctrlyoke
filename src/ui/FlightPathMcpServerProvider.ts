import * as vscode from "vscode";
import type { McpServerConfig } from "../types/FlightPathTypes";

/**
 * Dynamically injects user-defined MCP servers into VS Code's MCP subsystem
 * for the duration of a FlightPath workflow prompt.
 *
 * Only used for the copilot-chat harness. CLI harnesses use CliMcpConfigGenerator
 * to pass --mcp-config flags instead.
 *
 * The "flightpath" built-in server is not managed here — FlightPath's LM tools
 * (flightpath_append_queue, flightpath_queue_status, etc.) are registered
 * unconditionally at activation via registerLanguageModelTools() and are always
 * available to Copilot Chat regardless of mcpServers.
 */
export class FlightPathMcpServerProvider
  implements vscode.McpServerDefinitionProvider
{
  private activeServers: McpServerConfig[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  /**
   * Called by WorkflowExecutor when a chat prompt starts.
   * Filters out the "flightpath" shorthand — only user-defined McpServerConfig
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
