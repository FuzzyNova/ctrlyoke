/**
 * MCP server discovery utilities.
 *
 * Reads local MCP server configurations from well-known config file locations
 * and fetches servers from the Anthropic MCP registry.
 *
 * All I/O runs in the extension host (Node.js) — never in the webview.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "../types/WebviewMessageTypes";
import { Log } from "./Log";

// ============================================================================
// Local config file discovery
// ============================================================================

/**
 * Returns the platform-specific path to the VS Code user MCP config file.
 *
 * VS Code uses `servers` as the top-level key (not `mcpServers`).
 */
function getVscodeUserMcpConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "mcp.json");
  } else if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "mcp.json"
    );
  } else {
    return path.join(home, ".config", "Code", "User", "mcp.json");
  }
}

/**
 * Returns the path to the Claude Code user config file (~/.claude.json).
 * This file stores user-scope MCP servers at the top-level `mcpServers` key.
 */
function getClaudeUserConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Reads a JSON file and returns its parsed content, or null on any error.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Normalizes a server map (id → { command, args?, env? }) into LocalMcpServerEntry[].
 *
 * Handles both VS Code stdio format (with explicit `type: "stdio"`) and Claude Code
 * format (where `type` defaults to stdio when absent). Skips http/sse entries since
 * McpServerConfig only supports stdio today.
 */
function normalizeServerMap(
  map: Record<string, unknown>,
  source: LocalMcpServerEntry["source"]
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    const v = value as Record<string, unknown>;

    // Skip non-stdio entries (http, sse) — McpServerConfig only supports stdio
    if (v.type === "http" || v.type === "sse") return [];
    if (typeof v.command !== "string") return [];

    const entry: LocalMcpServerEntry = { id, command: v.command, source };
    if (Array.isArray(v.args) && v.args.every((a) => typeof a === "string")) {
      entry.args = v.args as string[];
    }
    if (v.env && typeof v.env === "object" && !Array.isArray(v.env)) {
      const env: Record<string, string> = {};
      for (const [k, val] of Object.entries(v.env as Record<string, unknown>)) {
        if (typeof val === "string") env[k] = val;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }
    return [entry];
  });
}

/**
 * Discovers MCP servers from all known local config files.
 *
 * Sources (in priority order, first wins on duplicate id):
 * 1. `.vscode/mcp.json` in the workspace (VS Code workspace config, key: `servers`)
 * 2. `.mcp.json` in the workspace (Claude Code project config, key: `mcpServers`)
 * 3. VS Code user config (platform-specific path, key: `servers`)
 * 4. Claude Code user config `~/.claude.json` (top-level `mcpServers`, user-scope only)
 *
 * Note: local-scope Claude Code servers (`.claude.json` under projects[path]) are
 * deliberately excluded — they may contain secrets the user has not chosen to share.
 */
export async function discoverLocalMcpServers(
  workspaceRoot: string
): Promise<LocalMcpServerEntry[]> {
  const results: LocalMcpServerEntry[] = [];
  const seenIds = new Set<string>();

  const addEntries = (entries: LocalMcpServerEntry[]) => {
    for (const entry of entries) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        results.push(entry);
      }
    }
  };

  // 1. .vscode/mcp.json (workspace VS Code config)
  const vscodeMcpPath = path.join(workspaceRoot, ".vscode", "mcp.json");
  const vscodeWs = await readJsonFile(vscodeMcpPath);
  if (vscodeWs && typeof vscodeWs === "object") {
    const data = vscodeWs as Record<string, unknown>;
    if (
      data.servers &&
      typeof data.servers === "object" &&
      !Array.isArray(data.servers)
    ) {
      addEntries(
        normalizeServerMap(
          data.servers as Record<string, unknown>,
          "vscode-workspace"
        )
      );
    }
  }

  // 2. .mcp.json (workspace Claude Code project config)
  const claudeMcpPath = path.join(workspaceRoot, ".mcp.json");
  const claudeWs = await readJsonFile(claudeMcpPath);
  if (claudeWs && typeof claudeWs === "object") {
    const data = claudeWs as Record<string, unknown>;
    if (
      data.mcpServers &&
      typeof data.mcpServers === "object" &&
      !Array.isArray(data.mcpServers)
    ) {
      addEntries(
        normalizeServerMap(
          data.mcpServers as Record<string, unknown>,
          "claude-workspace"
        )
      );
    }
  }

  // 3. VS Code user-level MCP config
  const vscodeUserPath = getVscodeUserMcpConfigPath();
  const vscodeUser = await readJsonFile(vscodeUserPath);
  if (vscodeUser && typeof vscodeUser === "object") {
    const data = vscodeUser as Record<string, unknown>;
    if (
      data.servers &&
      typeof data.servers === "object" &&
      !Array.isArray(data.servers)
    ) {
      addEntries(
        normalizeServerMap(
          data.servers as Record<string, unknown>,
          "vscode-user"
        )
      );
    }
  }

  // 4. Claude Code user config — top-level mcpServers only (user scope)
  const claudeUserPath = getClaudeUserConfigPath();
  const claudeUser = await readJsonFile(claudeUserPath);
  if (claudeUser && typeof claudeUser === "object") {
    const data = claudeUser as Record<string, unknown>;
    if (
      data.mcpServers &&
      typeof data.mcpServers === "object" &&
      !Array.isArray(data.mcpServers)
    ) {
      addEntries(
        normalizeServerMap(
          data.mcpServers as Record<string, unknown>,
          "claude-user"
        )
      );
    }
  }

  return results;
}

// ============================================================================
// Anthropic MCP Registry
// ============================================================================

/**
 * Raw response shape from the Anthropic MCP registry.
 * Based on verified live API responses from 2026-03-29.
 * Not exported — only used internally.
 */
interface AnthropicRegistryResponse {
  servers?: AnthropicRegistryItem[];
  metadata?: {
    count?: number;
    nextCursor?: string;
  };
}

/**
 * Each item in the registry has a `server` (standard MCP fields) and `_meta` (Anthropic enrichment).
 */
interface AnthropicRegistryItem {
  server?: {
    name?: string; // qualified name e.g. "com.canva.mcp/canva"
    title?: string; // display name e.g. "Canva"
    description?: string;
    packages?: Array<{
      registryType?: string; // "npm", "pip", "docker"
      identifier?: string; // npm package name
      runtimeHint?: string; // "npx", "uvx", etc.
      runtimeArguments?: string[];
      environmentVariables?: Array<{ name?: string; description?: string }>;
    }>;
    remotes?: Array<{
      type?: string; // "streamable-http", "sse"
      url?: string;
    }>;
  };
  _meta?: {
    "com.anthropic.api/mcp-registry"?: {
      uuid?: string;
      displayName?: string;
      oneLiner?: string;
      slug?: string;
      claudeCodeCopyText?: string;
      toolNames?: string[];
      worksWith?: string[];
      isAuthless?: boolean;
      popularityScore?: number;
      trendingScore?: number;
    };
  };
}

const ANTHROPIC_REGISTRY_URL =
  "https://api.anthropic.com/mcp-registry/v0/servers";

/**
 * Fetches MCP servers from the Anthropic public registry.
 * No authentication required.
 *
 * The registry returns results ordered by popularity (descending rank).
 * Server-side sorting is not supported — the `sort` param has no effect.
 *
 * Server-side search is supported via the `search` query parameter.
 * Client-side filtering is still used in the webview for the filter-as-you-type
 * UX, but server-side search could be leveraged for targeted queries.
 *
 * Pagination is cursor-based: pass the `nextCursor` from a previous response
 * to fetch the next page.
 *
 * @param options.limit Maximum results per page (default 100, API max 100)
 * @param options.cursor Cursor from a previous response's `nextCursor`
 * @param options.search Server-side search query (optional)
 */
export async function fetchAnthropicRegistry(
  options: { limit?: number; cursor?: string; search?: string } = {}
): Promise<{ servers: RegistryMcpEntry[]; nextCursor?: string }> {
  const { limit = 100, cursor, search } = options;
  const params = new URLSearchParams({
    version: "latest",
    visibility: "commercial",
    limit: String(limit),
  });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);

  const url = `${ANTHROPIC_REGISTRY_URL}?${params}`;

  // fetch() is available in Node 18+; VS Code extension host runs Node 22.
  const response = await fetch(url, {
    headers: { "User-Agent": "FlightPath-VSCode-Extension/1.0" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Anthropic registry returned ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as AnthropicRegistryResponse;
  const items = data.servers ?? [];

  const entries = items.flatMap((item): RegistryMcpEntry[] => {
    const s = item.server;
    const meta = item._meta?.["com.anthropic.api/mcp-registry"];
    if (!s) return [];

    const id = meta?.uuid ?? s.name ?? "";
    if (!id) return [];

    const name = meta?.displayName ?? s.title ?? s.name ?? id;
    const description = meta?.oneLiner ?? s.description ?? "";

    const entry: RegistryMcpEntry = {
      id,
      name,
      description,
      verified: true, // all Anthropic commercial registry entries are curated
    };

    // Prefer npm package for install command; fall back to other package types
    const npmPkg = s.packages?.find((p) => p.registryType === "npm");
    const anyPkg = s.packages?.[0];
    const pkg = npmPkg ?? anyPkg;

    if (pkg?.identifier) {
      entry.packageName = pkg.identifier;
      const runtimeHint = pkg.runtimeHint ?? "npx";
      // Use registry-provided runtimeArguments when present; otherwise add -y for npm/npx.
      const runtimeArgs =
        pkg.runtimeArguments && pkg.runtimeArguments.length > 0
          ? pkg.runtimeArguments
          : runtimeHint !== "uvx"
            ? ["-y"]
            : [];
      entry.installCommand = [runtimeHint, ...runtimeArgs, pkg.identifier]
        .filter(Boolean)
        .join(" ");
    }

    const envVars = pkg?.environmentVariables;
    if (envVars && envVars.length > 0) {
      entry.envVars = envVars.flatMap((e) =>
        e.name ? [{ name: e.name, description: e.description }] : []
      );
    }

    // Include the claudeCodeCopyText as a reference (not used in import, but useful for display)
    if (meta?.claudeCodeCopyText) {
      entry.claudeCodeCopyText = meta.claudeCodeCopyText;
    }

    if (typeof meta?.popularityScore === "number") {
      entry.popularityScore = meta.popularityScore;
    }
    if (typeof meta?.trendingScore === "number") {
      entry.trendingScore = meta.trendingScore;
    }

    return [entry];
  });

  return { servers: entries, nextCursor: data.metadata?.nextCursor };
}

/**
 * Safely runs MCP discovery and returns an empty result on error.
 * Logs the error without throwing so callers never crash.
 */
export async function safeDiscoverLocalMcpServers(
  workspaceRoot: string
): Promise<{ servers: LocalMcpServerEntry[]; error?: string }> {
  try {
    const servers = await discoverLocalMcpServers(workspaceRoot);
    return { servers };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Log.warn("McpDiscovery: local scan failed:", msg);
    return { servers: [], error: msg };
  }
}

/**
 * Safely fetches the Anthropic registry and returns an empty result on error.
 *
 * Supports cursor-based pagination and server-side search.
 */
export async function safeFetchAnthropicRegistry(
  options: { cursor?: string; search?: string } = {}
): Promise<{
  servers: RegistryMcpEntry[];
  nextCursor?: string;
  error?: string;
}> {
  try {
    const result = await fetchAnthropicRegistry(options);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Log.warn("McpDiscovery: registry fetch failed:", msg);
    return { servers: [], error: msg };
  }
}
