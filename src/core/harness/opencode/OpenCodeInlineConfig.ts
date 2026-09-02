import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parse, type ParseError } from "jsonc-parser";
import type { McpServerConfig } from "../../../types/CtrlYokeTypes";
import type { ToolPermissionConfig } from "../shared/interfaces/IToolPermissionMapper";
import type { SettingsJsonPermissionPolicy } from "../shared/SettingsJsonMcpTracker";
import {
  transformMcpSecretMap,
  type McpSecretConfigOptions,
} from "../shared/CliMcpConfigGenerator";
import { Log } from "../../../utils/Log";
import { MCP_SECRET_CONFIG_MODES } from "../../../types/DashboardConstants";

export interface OpenCodeLocalMcpServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}

export interface OpenCodeRemoteMcpServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

export type OpenCodeMcpServer =
  | OpenCodeLocalMcpServer
  | OpenCodeRemoteMcpServer;

export type OpenCodeMcpEntries = Record<string, OpenCodeMcpServer>;

export const OPENCODE_INLINE_CONFIG_MAX_BYTES = 32 * 1024;
export const OPENCODE_CONFIG_SUBSTITUTION_PATTERN = /\{(?:env|file):/iu;

/** Permission keys from the user config layers below OPENCODE_CONFIG_CONTENT. */
export interface OpenCodePermissionCollisionContext {
  topLevelKeys: ReadonlySet<string>;
  nestedKeysByTool: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Return true when OpenCode will substitute a value before parsing the config. */
export function containsOpenCodeConfigSubstitution(value: string): boolean {
  return OPENCODE_CONFIG_SUBSTITUTION_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function mergePermissionLayer(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      mergePermissionLayer(current, value);
    } else {
      target[key] = value;
    }
  }
}

async function readPermissionLayer(
  configPath: string
): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    return undefined;
  }

  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    Log.warn(
      `[OpenCodeInlineConfig] Ignoring malformed config while resolving permission keys: ${configPath}`
    );
    return undefined;
  }

  return isPlainObject(parsed.permission) ? parsed.permission : undefined;
}

/**
 * Resolve the effective permission key set beneath OpenCode's inline config.
 * The order mirrors OpenCode's lower-precedence sources: global, OPENCODE_CONFIG,
 * then project config. Values are merged per key so type replacement is preserved.
 */
export async function resolveOpenCodePermissionCollisionContext(
  workspaceRoot?: string
): Promise<OpenCodePermissionCollisionContext> {
  const configPaths = [
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  ];
  const configuredPath = process.env.OPENCODE_CONFIG?.trim();
  if (configuredPath) {
    configPaths.push(
      path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath)
    );
  }
  if (workspaceRoot) {
    configPaths.push(path.join(workspaceRoot, "opencode.json"));
  }

  const effectivePermission: Record<string, unknown> = {};
  for (const configPath of [...new Set(configPaths)]) {
    const permission = await readPermissionLayer(configPath);
    if (permission) {
      mergePermissionLayer(effectivePermission, permission);
    }
  }

  const nestedKeysByTool = new Map<string, ReadonlySet<string>>();
  for (const [tool, value] of Object.entries(effectivePermission)) {
    if (isPlainObject(value)) {
      nestedKeysByTool.set(tool, new Set(Object.keys(value)));
    }
  }

  return {
    topLevelKeys: new Set(Object.keys(effectivePermission)),
    nestedKeysByTool,
  };
}

function warnAndDropSubstitution(location: string): undefined {
  Log.warn(
    `[OpenCodeInlineConfig] Refusing ${location} containing OpenCode substitution token`
  );
  return undefined;
}

function sanitizeMcpString(
  value: string,
  location: string,
  allowSecretReference = false
): string | undefined {
  if (!containsOpenCodeConfigSubstitution(value)) return value;
  if (!allowSecretReference) return warnAndDropSubstitution(location);
  const withoutSecretReferences = value.replace(
    /\{env:[A-Z][A-Z0-9_]*\}/gu,
    ""
  );
  return withoutSecretReferences.includes("{")
    ? warnAndDropSubstitution(location)
    : value;
}

function sanitizeMcpStringArray(values: string[], location: string): string[] {
  return values.flatMap((value, index) => {
    const sanitized = sanitizeMcpString(value, `${location}[${index}]`);
    return sanitized === undefined ? [] : [sanitized];
  });
}

function sanitizeMcpStringRecord(
  values: Record<string, string>,
  location: string,
  allowSecretReference = false
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const safeValue = sanitizeMcpString(
      value,
      `${location}.${key}`,
      allowSecretReference
    );
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

/** The ctrlyoke-owned settings delivered through OpenCode's inline config. */
export interface OpenCodeInlineConfig {
  permission?: SettingsJsonPermissionPolicy;
  mcp?: OpenCodeMcpEntries;
  plugin: string[];
}

export interface OpenCodeInlineConfigBuildOptions {
  extensionPath: string;
  toolPermissions?: ToolPermissionConfig | null;
  permissionCollisionContext?: OpenCodePermissionCollisionContext;
  mcpServerPath?: string;
  workspaceRoot?: string;
  workingFilePath?: string;
  additionalEnv?: Record<string, string>;
  userServers?: McpServerConfig[];
  stateRoot?: string;
  secretOptions?: McpSecretConfigOptions;
}

/**
 * Build OpenCode MCP entries without performing any file or tracker I/O.
 *
 * The entry construction is shared by the pure builder and the prompt
 * accumulator so the inline representation cannot drift between call paths.
 */
export function buildOpenCodeMcpEntries(
  mcpServerPath: string | undefined,
  workspaceRoot: string | undefined,
  workingFilePath?: string,
  additionalEnv?: Record<string, string>,
  userServers: McpServerConfig[] = [],
  stateRoot?: string,
  secretOptions?: McpSecretConfigOptions
): OpenCodeMcpEntries {
  if (mcpServerPath && !workspaceRoot) {
    throw new Error(
      "OpenCode MCP entries require a workspace root when the ctrlyoke server is enabled"
    );
  }

  const mcpEntries: OpenCodeMcpEntries = {};

  if (mcpServerPath && workspaceRoot) {
    const workspaceValue = sanitizeMcpString(
      (stateRoot ?? workspaceRoot).replace(/\\/g, "/"),
      "ctrlyoke MCP workspace"
    );
    const workingFileValue = workingFilePath
      ? sanitizeMcpString(
          workingFilePath.replace(/\\/g, "/"),
          "ctrlyoke MCP working file"
        )
      : undefined;
    if (workspaceValue !== undefined) {
      const env: Record<string, string> = {
        CTRLYOKE_WORKSPACE: workspaceValue,
        ...(workingFileValue
          ? { CTRLYOKE_WORKING_FILE: workingFileValue }
          : {}),
        ...(additionalEnv
          ? sanitizeMcpStringRecord(additionalEnv, "ctrlyoke MCP environment")
          : {}),
      };
      const command = sanitizeMcpString(
        mcpServerPath.replace(/\\/g, "/"),
        "ctrlyoke MCP command"
      );
      if (command !== undefined) {
        mcpEntries.ctrlyoke = {
          type: "local",
          command: ["node", command],
          environment: env,
        };
      } else {
        Log.warn(
          "[OpenCodeInlineConfig] Omitting ctrlyoke MCP server because its command is unsafe"
        );
      }
    }
    if (workspaceValue === undefined) {
      Log.warn(
        "[OpenCodeInlineConfig] Omitting ctrlyoke MCP server because its workspace is unsafe"
      );
    }
  }

  for (const rawServer of userServers) {
    const server = {
      ...rawServer,
      env: rawServer.env
        ? transformMcpSecretMap(rawServer.env, secretOptions)
        : undefined,
      headers: rawServer.headers
        ? transformMcpSecretMap(rawServer.headers, secretOptions)
        : undefined,
    };
    const serverId = sanitizeMcpString(server.id, "MCP server id");
    if (serverId === undefined) {
      continue;
    }
    if (server.url) {
      const url = sanitizeMcpString(server.url, `MCP server ${serverId} URL`);
      if (url === undefined) {
        continue;
      }
      const entry: OpenCodeRemoteMcpServer = {
        type: "remote",
        url,
      };
      if (server.headers) {
        entry.headers = sanitizeMcpStringRecord(
          server.headers,
          `MCP server ${serverId} headers`,
          secretOptions?.mode === MCP_SECRET_CONFIG_MODES.REFERENCE
        );
      }
      mcpEntries[serverId] = entry;
      continue;
    }

    const command = sanitizeMcpString(
      server.command ?? "",
      `MCP server ${serverId} command`
    );
    if (command === undefined) {
      continue;
    }
    const entry: OpenCodeLocalMcpServer = {
      type: "local",
      command: [
        command,
        ...sanitizeMcpStringArray(
          server.args ?? [],
          `MCP server ${serverId} args`
        ),
      ],
    };
    if (server.env) {
      entry.environment = sanitizeMcpStringRecord(
        server.env,
        `MCP server ${serverId} environment`,
        secretOptions?.mode === MCP_SECRET_CONFIG_MODES.REFERENCE
      );
    }
    mcpEntries[serverId] = entry;
  }

  return mcpEntries;
}
