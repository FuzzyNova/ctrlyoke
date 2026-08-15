import { SPECIAL_TARGET_IDS } from "../types/DashboardConstants";
import type { McpServerConfig } from "../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import type { ManagedMcpServer } from "../types/WebviewMessageTypes";
import {
  McpRegistryFileManager,
  resolveCtrlYokeMcpInvocation,
} from "./McpRegistryFileManager";
import { Log } from "./Log";

/**
 * Resolve registry IDs in the effective MCP property before any harness
 * consumer plans process configuration.
 *
 * The reserved ctrlyoke ID is intentionally kept as a string. Claude and
 * Copilot use that sentinel to decide whether their own MCP server must be
 * included, while every other managed server needs its full config.
 */
export class McpServerNormalizer {
  static async applyFromRegistry(
    properties: ResolvedProperties,
    workspaceRoot?: string
  ): Promise<ResolvedProperties> {
    const registry = new McpRegistryFileManager(workspaceRoot);
    return this.apply(properties, await registry.readAll());
  }

  static async apply(
    properties: ResolvedProperties,
    managedServers: readonly ManagedMcpServer[]
  ): Promise<ResolvedProperties> {
    if (properties.mcpServers === null) {
      return properties;
    }

    const unknownIds = new Set<string>();
    const normalizedServers: (string | McpServerConfig)[] = [];

    for (const server of properties.mcpServers) {
      if (typeof server !== "string") {
        normalizedServers.push(server);
        continue;
      }

      if (server === SPECIAL_TARGET_IDS.CTRLYOKE) {
        normalizedServers.push(server);
        continue;
      }

      const resolved = resolveCtrlYokeMcpInvocation(managedServers, server);
      if (resolved) {
        normalizedServers.push(resolved);
      } else {
        unknownIds.add(server);
      }
    }

    for (const unknownId of unknownIds) {
      Log.warn(
        `[McpServerNormalizer] MCP server ID "${unknownId}" was not found in the ctrlyoke registry; dropping it`
      );
    }

    return {
      ...properties,
      mcpServers: normalizedServers,
    };
  }
}
