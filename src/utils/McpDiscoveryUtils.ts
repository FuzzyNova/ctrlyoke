/**
 * MCP server discovery utilities.
 *
 * Reads local MCP server configurations from well-known config file locations
 * and fetches servers from the Anthropic MCP registry.
 *
 * All I/O runs in the extension host (Node.js) — never in the webview.
 */

import * as fs from "fs/promises";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "../types/WebviewMessageTypes";
import { Log } from "./Log";
import {
  getClaudeUserConfigPath,
  getClaudeWorkspaceMcpConfigPath,
  getVscodeUserMcpConfigPath,
  getVscodeWorkspaceMcpConfigPath,
} from "./McpConfigPaths";

// ============================================================================
// Local config file discovery
// ============================================================================

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
async function discoverLocalMcpServers(
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
  const vscodeMcpPath = getVscodeWorkspaceMcpConfigPath(workspaceRoot);
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
  const claudeMcpPath = getClaudeWorkspaceMcpConfigPath(workspaceRoot);
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
// MCP Registry (registry.modelcontextprotocol.io)
// ============================================================================

/**
 * Raw response shape from the MCP registry.
 * Based on verified live API responses from 2026-03-31.
 * Not exported — only used internally.
 */
interface McpIoRegistryResponse {
  servers?: McpIoRegistryItem[];
  metadata?: {
    count?: number;
    nextCursor?: string;
  };
}

/**
 * Each item in the registry has a `server` (standard MCP fields) and `_meta` (registry enrichment).
 */
interface McpIoRegistryItem {
  server?: {
    name?: string; // qualified name e.g. "agency.lona/trading"
    title?: string; // display name e.g. "Canva"
    description?: string;
    version?: string;
    websiteUrl?: string;
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
      headers?: Array<{
        name?: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      isLatest?: boolean;
      publishedAt?: string;
      updatedAt?: string;
      statusChangedAt?: string;
    };
  };
}

const MCP_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers";

/**
 * Fetches MCP servers from the official MCP registry (registry.modelcontextprotocol.io).
 * No authentication required.
 *
 * The registry returns results in alphabetical order by default.
 * Pagination is cursor-based: pass the `nextCursor` from a previous response
 * to fetch the next page.
 *
 * Only entries with `isLatest: true` are included to avoid showing stale
 * duplicate entries for servers that have multiple published versions.
 *
 * @param options.limit    Results per page (default 50, max 100)
 * @param options.cursor   Pagination cursor from a previous response's `nextCursor`
 * @param options.search   Server-side substring search on server name
 * @param options.updatedSince  Filter to servers updated since this ISO 8601 timestamp
 */
async function fetchMcpRegistry(
  options: {
    limit?: number;
    cursor?: string;
    search?: string;
    updatedSince?: string;
  } = {}
): Promise<{ servers: RegistryMcpEntry[]; nextCursor?: string }> {
  const { limit = 50, cursor, search, updatedSince } = options;
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  if (updatedSince) params.set("updated_since", updatedSince);

  const url = `${MCP_REGISTRY_URL}?${params}`;

  // fetch() is available in Node 18+; VS Code extension host runs Node 22.
  const response = await fetch(url, {
    headers: { "User-Agent": "FlightPath-VSCode-Extension/1.0" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `MCP registry returned ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as McpIoRegistryResponse;
  const items = data.servers ?? [];

  const entries = items.flatMap((item): RegistryMcpEntry[] => {
    const s = item.server;
    const meta = item._meta?.["io.modelcontextprotocol.registry/official"];
    if (!s) return [];

    // Skip stale versions — only show the latest for each server name
    if (meta?.isLatest === false) return [];

    const id = s.name ?? "";
    if (!id) return [];

    const name = s.title ?? s.name ?? id;
    const description = s.description ?? "";

    const entry: RegistryMcpEntry = {
      id,
      name,
      description,
      verified: true, // all entries in the official registry are curated
    };

    if (meta?.updatedAt) {
      entry.updatedAt = meta.updatedAt;
    }

    // ── Remote transport (streamable-http / SSE) ─────────────────────────────
    // When a server only exposes a hosted endpoint (no stdio package), extract
    // the URL, transport type, and any required auth headers.
    const firstRemote = s.remotes?.[0];
    if (firstRemote?.url) {
      entry.remoteUrl = firstRemote.url;
      entry.remoteTransport =
        firstRemote.type === "sse" ? "sse" : "streamable-http";
      const headerDefs = (firstRemote.headers ?? []).filter((h) => h.name);
      if (headerDefs.length > 0) {
        entry.remoteHeaders = headerDefs.map((h) => ({
          name: h.name!,
          description: h.description,
          isRequired: h.isRequired,
          isSecret: h.isSecret,
        }));
      }
    }

    // ── stdio transport (local package / npm / pip) ──────────────────────────
    // Only populate installCommand / envVars when the server has a package
    // definition (i.e. it can be run as a local process).
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

      const envVars = pkg.environmentVariables;
      if (envVars && envVars.length > 0) {
        entry.envVars = envVars.flatMap((e) =>
          e.name ? [{ name: e.name, description: e.description }] : []
        );
      }
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
 * Safely fetches the MCP registry and returns an empty result on error.
 * Supports cursor-based pagination, server-side search, and updated_since filtering.
 */
export async function safeFetchMcpRegistry(
  options: { cursor?: string; search?: string; updatedSince?: string } = {}
): Promise<{
  servers: RegistryMcpEntry[];
  nextCursor?: string;
  error?: string;
}> {
  try {
    const result = await fetchMcpRegistry({
      cursor: options.cursor,
      search: options.search,
      updatedSince: options.updatedSince,
    });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Log.warn("McpDiscovery: registry fetch failed:", msg);
    return { servers: [], error: msg };
  }
}
