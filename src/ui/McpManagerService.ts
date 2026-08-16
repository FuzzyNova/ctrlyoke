import { MESSAGE_TYPES, SPECIAL_TARGET_IDS } from "../types/DashboardConstants";
import type {
  DeleteMcpFromHarnessMessage,
  DeleteMcpRegistryServerMessage,
  ExportMcpToHarnessMessage,
  RequestMcpConfigPreviewMessage,
  RequestMcpRegistrySearchMessage,
  SaveMcpRegistryServerMessage,
} from "../types/WebviewMessageTypes";
import { getErrorMessage } from "../utils/ErrorUtils";
import { HarnessMcpExporter } from "../utils/HarnessMcpExporter";
import {
  safeDiscoverLocalMcpServers,
  safeFetchMcpRegistry,
} from "../utils/McpDiscoveryUtils";
import {
  McpRegistryFileManager,
  resolveCtrlYokeMcpInvocation,
} from "../utils/McpRegistryFileManager";
import { Log } from "../utils/Log";
import type { WebviewClientContext } from "./WebviewClientContext";

/**
 * Static preview shown for `/mcp:ctrlyoke` — the reserved built-in-server
 * sentinel is never a registry entry (see `resolveCtrlYokeMcpInvocation`,
 * which only resolves user-registered servers), so there is no
 * `McpServerConfig` to read back for it.
 */
const CTRLYOKE_BUILTIN_MCP_SERVER_PREVIEW = {
  id: SPECIAL_TARGET_IDS.CTRLYOKE,
  type: "built-in",
  description:
    "ctrlyoke's built-in MCP server. Gives the model queue-status and append-queue tools scoped to the current workflow run.",
  tools: ["ctrlyoke_queue_status", "ctrlyoke_append_queue"],
};

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

  private emitActionFailure(
    ctx: WebviewClientContext,
    action: string,
    error: string
  ): void {
    ctx.emit({
      type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
      action,
      error,
    });
  }

  async handleRequestRegistryServers(ctx: WebviewClientContext): Promise<void> {
    try {
      await this.emitManagedRegistryServers(ctx);
    } catch (error) {
      const message = `Failed to load MCP registry servers: ${getErrorMessage(error)}`;
      Log.error(message);
      this.emitActionFailure(ctx, "load MCP registry servers", message);
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
      this.emitActionFailure(ctx, "save MCP registry server", errorMessage);
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
      this.emitActionFailure(ctx, "delete MCP registry server", errorMessage);
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
        this.emitActionFailure(
          ctx,
          "export MCP servers",
          `No stdio MCP servers were exported to ${result.filePath}.`
        );
        return;
      }
      await this.emitLocalScan(ctx);
    } catch (error) {
      const errorMessage = `Failed to export MCP servers: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      this.emitActionFailure(ctx, "export MCP servers", errorMessage);
    }
  }

  async handleDeleteFromHarness(
    ctx: WebviewClientContext,
    message: DeleteMcpFromHarnessMessage
  ): Promise<void> {
    try {
      await this.getHarnessExporter().remove(
        message.ids ?? [],
        message.targetId,
        message.scope,
        message.filePath
      );
      await this.emitLocalScan(ctx);
    } catch (error) {
      const errorMessage = `Failed to delete MCP servers from harness config: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      this.emitActionFailure(
        ctx,
        "delete MCP servers from harness config",
        errorMessage
      );
    }
  }

  /**
   * Resolve a `/mcp:<name>` reference to the exact JSON config that would be
   * attached, for the prompt editor's content preview modal. An unresolved
   * name (deleted registry entry, typo) reports `found: false` rather than
   * throwing — the modal surfaces that as "not found" instead of erroring.
   */
  async handleRequestMcpConfigPreview(
    ctx: WebviewClientContext,
    message: RequestMcpConfigPreviewMessage
  ): Promise<void> {
    const mcpServerName = message.mcpServerName;

    if (mcpServerName === SPECIAL_TARGET_IDS.CTRLYOKE) {
      ctx.emit({
        type: MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT,
        mcpServerName,
        content: JSON.stringify(CTRLYOKE_BUILTIN_MCP_SERVER_PREVIEW, null, 2),
        found: true,
      });
      return;
    }

    const servers = await this.getRegistryFileManager().readAll();
    const config = resolveCtrlYokeMcpInvocation(servers, mcpServerName);
    ctx.emit({
      type: MESSAGE_TYPES.MCP_CONFIG_PREVIEW_RESULT,
      mcpServerName,
      content: config ? JSON.stringify(config, null, 2) : "",
      found: Boolean(config),
    });
  }
}
