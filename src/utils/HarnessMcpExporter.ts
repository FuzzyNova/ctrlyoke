import * as fs from "fs";
import type {
  AnyTargetId,
  SettingWriteScope,
} from "../types/DashboardConstants";
import {
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../types/DashboardConstants";
import type { McpServerConfig } from "../types/FlightPathTypes";
import { Log } from "./Log";
import {
  getClaudeUserConfigPath,
  getClaudeWorkspaceMcpConfigPath,
  getVscodeUserMcpConfigPath,
  getVscodeWorkspaceMcpConfigPath,
} from "./McpConfigPaths";
import { writeJsonFileAtomic } from "./McpRegistryFileManager";

interface ClaudeMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface VsCodeMcpEntry extends ClaudeMcpEntry {
  type: "stdio";
}

export interface HarnessMcpExportResult {
  filePath: string;
  exportedCount: number;
  skippedIds: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toStdioEntry(
  server: McpServerConfig,
  targetLabel: string
): ClaudeMcpEntry | null {
  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping remote/unsupported MCP server "${server.id}" for ${targetLabel} export.`
    );
    return null;
  }

  const entry: ClaudeMcpEntry = { command: server.command };
  if (server.args && server.args.length > 0) entry.args = server.args;
  if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
  return entry;
}

function toClaudeEntry(server: McpServerConfig): ClaudeMcpEntry | null {
  return toStdioEntry(server, "Claude");
}

function toVsCodeEntry(server: McpServerConfig): VsCodeMcpEntry | null {
  const baseEntry = toStdioEntry(server, "VS Code");
  if (!baseEntry) return null;
  return {
    type: "stdio",
    ...baseEntry,
  };
}

export class HarnessMcpExporter {
  constructor(private readonly workspaceRoot?: string) {}

  async export(
    servers: McpServerConfig[],
    targetId: AnyTargetId,
    scope: SettingWriteScope
  ): Promise<HarnessMcpExportResult> {
    const filePath = this.resolveTargetPath(targetId, scope);

    if (targetId === SPECIAL_TARGET_IDS.VSCODE) {
      return this.exportToVsCode(filePath, servers);
    }

    if (targetId === HARNESS_IDS.CLAUDE_CLI) {
      return this.exportToClaude(filePath, servers);
    }

    throw new Error(`Unsupported MCP export target: ${targetId}`);
  }

  private resolveTargetPath(
    targetId: AnyTargetId,
    scope: SettingWriteScope
  ): string {
    if (scope === SETTING_SCOPES.WORKSPACE && !this.workspaceRoot) {
      throw new Error(
        "Workspace-scoped MCP export is unavailable because no workspace folder is open."
      );
    }

    if (targetId === SPECIAL_TARGET_IDS.VSCODE) {
      return scope === SETTING_SCOPES.USER
        ? getVscodeUserMcpConfigPath()
        : getVscodeWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    if (targetId === HARNESS_IDS.CLAUDE_CLI) {
      return scope === SETTING_SCOPES.USER
        ? getClaudeUserConfigPath()
        : getClaudeWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    throw new Error(`Unsupported MCP export target: ${targetId}`);
  }

  private async exportToVsCode(
    filePath: string,
    servers: McpServerConfig[]
  ): Promise<HarnessMcpExportResult> {
    const document = await readJsonObject(filePath);
    const existingServers = isPlainObject(document.servers)
      ? { ...document.servers }
      : {};
    const skippedIds: string[] = [];
    let exportedCount = 0;

    for (const server of servers) {
      const entry = toVsCodeEntry(server);
      if (entry) {
        existingServers[server.id] = entry;
        exportedCount += 1;
      } else {
        skippedIds.push(server.id);
      }
    }

    await writeJsonFileAtomic(filePath, {
      ...document,
      servers: existingServers,
    });

    return { filePath, exportedCount, skippedIds };
  }

  private async exportToClaude(
    filePath: string,
    servers: McpServerConfig[]
  ): Promise<HarnessMcpExportResult> {
    const document = await readJsonObject(filePath);
    const existingServers = isPlainObject(document.mcpServers)
      ? { ...document.mcpServers }
      : {};
    const skippedIds: string[] = [];
    let exportedCount = 0;

    for (const server of servers) {
      const entry = toClaudeEntry(server);
      if (entry) {
        existingServers[server.id] = entry;
        exportedCount += 1;
      } else {
        skippedIds.push(server.id);
      }
    }

    await writeJsonFileAtomic(filePath, {
      ...document,
      mcpServers: existingServers,
    });

    return { filePath, exportedCount, skippedIds };
  }
}
