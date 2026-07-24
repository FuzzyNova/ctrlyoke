import * as vscode from "vscode";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  DeleteMcpFromHarnessMessage,
  DeleteMcpRegistryServerMessage,
  ExportMcpToHarnessMessage,
  RequestMcpRegistrySearchMessage,
  SaveMcpRegistryServerMessage,
} from "../types/WebviewMessageTypes";
import { getErrorMessage } from "../utils/ErrorUtils";
import { HarnessMcpExporter } from "../utils/HarnessMcpExporter";
import {
  safeDiscoverLocalMcpServers,
  safeFetchMcpRegistry,
} from "../utils/McpDiscoveryUtils";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";
import { Log } from "../utils/Log";
import type { WebviewClientContext } from "./WebviewClientContext";

/**
 * MCP manager message handlers: manage ctrlyoke's MCP registry, discover MCP
 * servers in local harness configs and the remote registry, and export/remove
 * server definitions in harness config files.
 *
 * The dispatch table remains in {@link WebviewMessageRouter}; this service owns
 * the filesystem/discovery behavior and only needs a workspace root plus the
 * originating client's reply context.
 */
export class McpManagerService {
  constructor(private readonly getWorkspaceRoot: () => string) {}

  private getRegistryFileManager(): McpRegistryFileManager {
    const workspaceRoot = this.getWorkspaceRoot();
    return new McpRegistryFileManager(workspaceRoot || undefined);
  }

  private getHarnessExporter(): HarnessMcpExporter {
    const workspaceRoot = this.getWorkspaceRoot();
    return new HarnessMcpExporter(workspaceRoot || undefined);
  }

  private async emitManagedRegistryServers(
    ctx: WebviewClientContext
  ): Promise<void> {
    const servers = await this.getRegistryFileManager().readAll();
    ctx.emit({
      type: MESSAGE_TYPES.MCP_REGISTRY_SERVERS_UPDATE,
      servers,
    });
  }

  private async emitLocalScan(ctx: WebviewClientContext): Promise<void> {
    const result = await safeDiscoverLocalMcpServers(this.getWorkspaceRoot());
    ctx.emit({
      type: MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT,
      servers: result.servers,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  async handleRequestRegistryServers(ctx: WebviewClientContext): Promise<void> {
    try {
      await this.emitManagedRegistryServers(ctx);
    } catch (error) {
      const message = `Failed to load MCP registry servers: ${getErrorMessage(error)}`;
      Log.error(message);
      void vscode.window.showErrorMessage(message);
    }
  }

  async handleSaveRegistryServer(
    ctx: WebviewClientContext,
    message: SaveMcpRegistryServerMessage
  ): Promise<void> {
    try {
      const manager = this.getRegistryFileManager();
      if (message.previousId && message.previousId !== message.server.id) {
        await manager.remove(message.previousId, message.scope);
      }
      await manager.addOrUpdate(message.server, message.scope);
      await this.emitManagedRegistryServers(ctx);
    } catch (error) {
      const errorMessage = `Failed to save MCP registry server: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  async handleDeleteRegistryServer(
    ctx: WebviewClientContext,
    message: DeleteMcpRegistryServerMessage
  ): Promise<void> {
    try {
      await this.getRegistryFileManager().remove(message.id, message.scope);
      await this.emitManagedRegistryServers(ctx);
    } catch (error) {
      const errorMessage = `Failed to delete MCP registry server: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  async handleRequestLocalScan(ctx: WebviewClientContext): Promise<void> {
    await this.emitLocalScan(ctx);
  }

  async handleRequestRegistrySearch(
    ctx: WebviewClientContext,
    message: RequestMcpRegistrySearchMessage
  ): Promise<void> {
    const result = await safeFetchMcpRegistry({
      cursor: message.cursor,
      search: message.query || undefined,
      updatedSince: message.updatedSince,
    });
    ctx.emit({
      type: MESSAGE_TYPES.MCP_REGISTRY_SEARCH_RESULT,
      servers: result.servers,
      nextCursor: result.nextCursor,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  async handleExportToHarness(
    ctx: WebviewClientContext,
    message: ExportMcpToHarnessMessage
  ): Promise<void> {
    try {
      const result = await this.getHarnessExporter().export(
        message.servers ?? [],
        message.targetId,
        message.scope
      );
      if (result.exportedCount === 0) {
        void vscode.window.showWarningMessage(
          `No stdio MCP servers were exported to ${result.filePath}.`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Exported ${result.exportedCount} MCP server${result.exportedCount === 1 ? "" : "s"} to ${result.filePath}.`
      );
      await this.emitLocalScan(ctx);
    } catch (error) {
      const errorMessage = `Failed to export MCP servers: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  async handleDeleteFromHarness(
    ctx: WebviewClientContext,
    message: DeleteMcpFromHarnessMessage
  ): Promise<void> {
    try {
      const result = await this.getHarnessExporter().remove(
        message.ids ?? [],
        message.targetId,
        message.scope,
        message.filePath
      );
      void vscode.window.showInformationMessage(
        result.removedCount > 0
          ? `Removed ${result.removedCount} MCP server${result.removedCount === 1 ? "" : "s"} from ${result.filePath}.`
          : `No matching MCP servers were found in ${result.filePath}.`
      );
      await this.emitLocalScan(ctx);
    } catch (error) {
      const errorMessage = `Failed to delete MCP servers from harness config: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }
}
