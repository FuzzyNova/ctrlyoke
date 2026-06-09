import * as fs from "fs";
import * as path from "path";
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
  getCodexUserMcpConfigPath,
  getCodexWorkspaceMcpConfigPath,
  getCopilotUserMcpConfigPath,
  getOpenCodeUserMcpConfigPath,
  getOpenCodeWorkspaceMcpConfigPath,
  getPreferredCopilotWorkspaceMcpConfigPath,
  getQwenUserMcpConfigPath,
  getQwenWorkspaceMcpConfigPath,
  getVscodeUserMcpConfigPath,
  getVscodeWorkspaceMcpConfigPath,
} from "./McpConfigPaths";
import { writeJsonFileAtomic } from "./McpRegistryFileManager";

interface JsonDocument extends Record<string, unknown> {}
type JsonObject = Record<string, unknown>;

export interface HarnessMcpExportResult {
  filePath: string;
  exportedCount: number;
  skippedIds: string[];
}

export interface HarnessMcpDeleteResult {
  filePath: string;
  removedCount: number;
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<JsonDocument> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function toVsCodeEntry(server: McpServerConfig): JsonObject | null {
  if (server.url) {
    return {
      type: server.transport === "sse" ? "sse" : "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for VS Code export.`
    );
    return null;
  }

  return {
    type: "stdio",
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

function toClaudeEntry(server: McpServerConfig): JsonObject | null {
  if (server.url) {
    return {
      type: server.transport === "sse" ? "sse" : "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for Claude export.`
    );
    return null;
  }

  return {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

function toCopilotEntry(server: McpServerConfig): JsonObject | null {
  if (server.url) {
    return {
      type: server.transport === "sse" ? "sse" : "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      tools: ["*"],
    };
  }

  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for Copilot export.`
    );
    return null;
  }

  return {
    type: "local",
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    tools: ["*"],
  };
}

function toQwenEntry(server: McpServerConfig): JsonObject | null {
  if (server.url) {
    return {
      ...(server.transport === "sse"
        ? { url: server.url }
        : { httpUrl: server.url }),
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for Qwen export.`
    );
    return null;
  }

  return {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

function toOpenCodeEntry(server: McpServerConfig): JsonObject | null {
  if (server.url) {
    return {
      type: "remote",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for OpenCode export.`
    );
    return null;
  }

  return {
    type: "local",
    command: [server.command, ...(server.args ?? [])],
    ...(server.env ? { environment: server.env } : {}),
  };
}

function escapeTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

function toTomlArray(values: string[]): string {
  return `[${values.map((value) => escapeTomlString(value)).join(", ")}]`;
}

function toTomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${escapeTomlString(key)} = ${escapeTomlString(value)}`
  );
  return `{ ${entries.join(", ")} }`;
}

function getTomlSectionName(id: string): string {
  return `[mcp_servers.${escapeTomlString(id)}]`;
}

function toCodexBlock(server: McpServerConfig): string | null {
  if (!server.url && (!server.command || server.command.trim().length === 0)) {
    Log.warn(
      `[HarnessMcpExporter] Skipping unsupported MCP server "${server.id}" for Codex export.`
    );
    return null;
  }

  const lines = [getTomlSectionName(server.id)];

  if (server.command) {
    lines.push(`command = ${escapeTomlString(server.command)}`);
  }
  if (server.args?.length) {
    lines.push(`args = ${toTomlArray(server.args)}`);
  }
  if (server.env && Object.keys(server.env).length > 0) {
    lines.push(`env = ${toTomlInlineTable(server.env)}`);
  }
  if (server.url) {
    lines.push(`url = ${escapeTomlString(server.url)}`);
  }
  if (server.transport === "sse") {
    lines.push(`transport = "sse"`);
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    lines.push(`headers = ${toTomlInlineTable(server.headers)}`);
  }

  return lines.join("\n");
}

function parseTomlTargetSectionId(headerLine: string): string | null {
  const trimmed = headerLine.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  const sectionName = trimmed.slice(1, -1).trim();
  if (!sectionName.startsWith("mcp_servers.")) {
    return null;
  }

  const remainder = sectionName.slice("mcp_servers.".length).trim();
  if (!remainder) {
    return null;
  }

  if (
    (remainder.startsWith(`"`) && remainder.endsWith(`"`)) ||
    (remainder.startsWith(`'`) && remainder.endsWith(`'`))
  ) {
    return remainder.slice(1, -1).replace(/\\"/g, `"`).replace(/\\\\/g, "\\");
  }

  return remainder;
}

async function writeJsonServerMap(
  filePath: string,
  key: string,
  servers: McpServerConfig[],
  mapper: (server: McpServerConfig) => JsonObject | null
): Promise<HarnessMcpExportResult> {
  const document = await readJsonObject(filePath);
  const existingServers = isPlainObject(document[key]) ? { ...document[key] } : {};
  const skippedIds: string[] = [];
  let exportedCount = 0;

  for (const server of servers) {
    const entry = mapper(server);
    if (!entry) {
      skippedIds.push(server.id);
      continue;
    }
    existingServers[server.id] = entry;
    exportedCount += 1;
  }

  await writeJsonFileAtomic(filePath, {
    ...document,
    [key]: existingServers,
  });

  return { filePath, exportedCount, skippedIds };
}

async function removeJsonServerMapEntries(
  filePath: string,
  key: string,
  ids: string[]
): Promise<HarnessMcpDeleteResult> {
  const document = await readJsonObject(filePath);
  const existingServers = isPlainObject(document[key]) ? { ...document[key] } : {};
  let removedCount = 0;

  for (const id of ids) {
    if (!(id in existingServers)) {
      continue;
    }
    delete existingServers[id];
    removedCount += 1;
  }

  await writeJsonFileAtomic(filePath, {
    ...document,
    [key]: existingServers,
  });

  return { filePath, removedCount };
}

async function writeCodexTomlFile(
  filePath: string,
  servers: McpServerConfig[]
): Promise<HarnessMcpExportResult> {
  const existingText = await readTextFile(filePath);
  const blocks = new Map<string, string>();
  const skippedIds: string[] = [];

  for (const server of servers) {
    const block = toCodexBlock(server);
    if (!block) {
      skippedIds.push(server.id);
      continue;
    }
    blocks.set(server.id, block);
  }

  const targetIds = new Set(blocks.keys());
  const lines = existingText.split(/\r?\n/);
  const sectionStartIndices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      sectionStartIndices.push(index);
    }
  }

  const keptSegments: string[] = [];
  let cursor = 0;

  for (let index = 0; index < sectionStartIndices.length; index += 1) {
    const start = sectionStartIndices[index]!;
    const end =
      index + 1 < sectionStartIndices.length
        ? sectionStartIndices[index + 1]!
        : lines.length;

    if (start > cursor) {
      keptSegments.push(lines.slice(cursor, start).join("\n"));
    }

    const blockLines = lines.slice(start, end);
    const blockId = parseTomlTargetSectionId(blockLines[0] ?? "");
    if (!(blockId && targetIds.has(blockId))) {
      keptSegments.push(blockLines.join("\n"));
    }

    cursor = end;
  }

  if (cursor < lines.length) {
    keptSegments.push(lines.slice(cursor).join("\n"));
  }

  let nextText = keptSegments.join("\n").trimEnd();
  const renderedBlocks = [...blocks.values()];
  if (renderedBlocks.length > 0) {
    nextText = nextText.length > 0 ? `${nextText}\n\n` : "";
    nextText += renderedBlocks.join("\n\n");
    nextText += "\n";
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, nextText, "utf-8");

  return {
    filePath,
    exportedCount: renderedBlocks.length,
    skippedIds,
  };
}

async function removeCodexTomlServers(
  filePath: string,
  ids: string[]
): Promise<HarnessMcpDeleteResult> {
  const existingText = await readTextFile(filePath);
  const targetIds = new Set(ids);
  const lines = existingText.split(/\r?\n/);
  const sectionStartIndices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      sectionStartIndices.push(index);
    }
  }

  const keptSegments: string[] = [];
  let cursor = 0;
  let removedCount = 0;

  for (let index = 0; index < sectionStartIndices.length; index += 1) {
    const start = sectionStartIndices[index]!;
    const end =
      index + 1 < sectionStartIndices.length
        ? sectionStartIndices[index + 1]!
        : lines.length;

    if (start > cursor) {
      keptSegments.push(lines.slice(cursor, start).join("\n"));
    }

    const blockLines = lines.slice(start, end);
    const blockId = parseTomlTargetSectionId(blockLines[0] ?? "");
    if (blockId && targetIds.has(blockId)) {
      removedCount += 1;
    } else {
      keptSegments.push(blockLines.join("\n"));
    }

    cursor = end;
  }

  if (cursor < lines.length) {
    keptSegments.push(lines.slice(cursor).join("\n"));
  }

  const nextText = keptSegments.join("\n").trimEnd();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(
    filePath,
    nextText.length > 0 ? `${nextText}\n` : "",
    "utf-8"
  );

  return { filePath, removedCount };
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
      return writeJsonServerMap(filePath, "servers", servers, toVsCodeEntry);
    }

    if (targetId === HARNESS_IDS.CLAUDE_CLI) {
      return writeJsonServerMap(filePath, "mcpServers", servers, toClaudeEntry);
    }

    if (targetId === HARNESS_IDS.COPILOT_CLI) {
      return writeJsonServerMap(filePath, "mcpServers", servers, toCopilotEntry);
    }

    if (targetId === HARNESS_IDS.QWEN_CLI) {
      return writeJsonServerMap(filePath, "mcpServers", servers, toQwenEntry);
    }

    if (targetId === HARNESS_IDS.OPENCODE_CLI) {
      return writeJsonServerMap(filePath, "mcp", servers, toOpenCodeEntry);
    }

    if (targetId === HARNESS_IDS.CODEX_CLI) {
      return writeCodexTomlFile(filePath, servers);
    }

    throw new Error(`Unsupported MCP export target: ${targetId}`);
  }

  async remove(
    ids: string[],
    targetId: AnyTargetId,
    scope: SettingWriteScope,
    filePathOverride?: string
  ): Promise<HarnessMcpDeleteResult> {
    const filePath = filePathOverride ?? this.resolveTargetPath(targetId, scope);

    if (targetId === SPECIAL_TARGET_IDS.VSCODE) {
      return removeJsonServerMapEntries(filePath, "servers", ids);
    }

    if (targetId === HARNESS_IDS.CLAUDE_CLI) {
      return removeJsonServerMapEntries(filePath, "mcpServers", ids);
    }

    if (targetId === HARNESS_IDS.COPILOT_CLI) {
      return removeJsonServerMapEntries(filePath, "mcpServers", ids);
    }

    if (targetId === HARNESS_IDS.QWEN_CLI) {
      return removeJsonServerMapEntries(filePath, "mcpServers", ids);
    }

    if (targetId === HARNESS_IDS.OPENCODE_CLI) {
      return removeJsonServerMapEntries(filePath, "mcp", ids);
    }

    if (targetId === HARNESS_IDS.CODEX_CLI) {
      return removeCodexTomlServers(filePath, ids);
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

    if (targetId === HARNESS_IDS.COPILOT_CLI) {
      return scope === SETTING_SCOPES.USER
        ? getCopilotUserMcpConfigPath()
        : getPreferredCopilotWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    if (targetId === HARNESS_IDS.CODEX_CLI) {
      return scope === SETTING_SCOPES.USER
        ? getCodexUserMcpConfigPath()
        : getCodexWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    if (targetId === HARNESS_IDS.OPENCODE_CLI) {
      return scope === SETTING_SCOPES.USER
        ? getOpenCodeUserMcpConfigPath()
        : getOpenCodeWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    if (targetId === HARNESS_IDS.QWEN_CLI) {
      return scope === SETTING_SCOPES.USER
        ? getQwenUserMcpConfigPath()
        : getQwenWorkspaceMcpConfigPath(this.workspaceRoot!);
    }

    throw new Error(`Unsupported MCP export target: ${targetId}`);
  }
}
