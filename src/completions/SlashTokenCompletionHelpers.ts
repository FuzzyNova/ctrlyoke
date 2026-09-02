import * as vscode from "vscode";
import type { PlainCompletionItem } from "./CompletionHelpers";
import {
  CTRLYOKE_BUILTIN_MCP_SERVER_INFO,
  McpRegistryFileManager,
} from "../utils/McpRegistryFileManager";
import { SkillDiscovery, type SkillInfo } from "../utils/SkillDiscovery";
import type { ManagedMcpServer } from "../types/WebviewMessageTypes";
import {
  CTRLYOKE_SLASH_TOKEN_KINDS,
  type CtrlYokeSlashTokenKind,
} from "../types/DashboardConstants";

/** Prefix that introduces a namespaced ctrlyoke reference, e.g. `/skill:`. */
const tokenPrefix = (kind: CtrlYokeSlashTokenKind): string => `/${kind}:`;

export interface SkillTokenCompletionItem extends PlainCompletionItem {
  commandType: "ctrlyokeSkill";
  skillName: string;
}

export interface McpTokenCompletionItem extends PlainCompletionItem {
  commandType: "ctrlyokeMcpServer";
  mcpServerName: string;
}

export type SlashTokenCompletionItem =
  | SkillTokenCompletionItem
  | McpTokenCompletionItem;

const MERGED_COMPLETION_KIND = "merged";

type SlashTokenCompletionKind =
  | CtrlYokeSlashTokenKind
  | typeof MERGED_COMPLETION_KIND;

interface SlashTokenCompletionContext {
  kind: SlashTokenCompletionKind;
  namePrefix: string;
}

interface SlashTokenDiscoveryCache {
  workspaceRoot: string | undefined;
  skills: SkillInfo[];
  managedServers: ManagedMcpServer[];
  timestamp: number;
}

const SLASH_TOKEN_CACHE_DURATION_MS = 5000;
let discoveryCache: SlashTokenDiscoveryCache | undefined;

/** Clear the short-lived discovery cache used by slash-token completions. */
export function clearSlashTokenCompletionCache(): void {
  discoveryCache = undefined;
}

/**
 * Get ctrlyoke-only slash-token completions for `/`, `/skill:`, or `/mcp:`.
 *
 * The prefix is the complete token currently being edited, such as `/`,
 * `/skill:c`, or `/mcp:p`. Native harness commands are intentionally never
 * queried or included.
 */
export async function getCtrlYokeSlashCompletions(
  workspaceRoot: string | undefined,
  prefix: string
): Promise<SlashTokenCompletionItem[]> {
  const context = parseSlashTokenCompletionContext(prefix);
  if (!context) {
    return [];
  }

  const { skills, managedServers } =
    await getDiscoveredSlashTokenSources(workspaceRoot);

  const skillItems =
    context.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP
      ? []
      : createSkillTokenCompletions(skills, context.namePrefix);
  const mcpItems =
    context.kind === CTRLYOKE_SLASH_TOKEN_KINDS.SKILL
      ? []
      : createMcpTokenCompletions(managedServers, context.namePrefix);

  return [...skillItems, ...mcpItems].sort(compareCompletionItems);
}

/** Get discovered ctrlyoke skill completions for a typed skill-name prefix. */
export async function getSkillTokenCompletions(
  workspaceRoot: string | undefined,
  namePrefix = ""
): Promise<SkillTokenCompletionItem[]> {
  const { skills } = await getDiscoveredSlashTokenSources(workspaceRoot);
  return createSkillTokenCompletions(skills, namePrefix).sort(
    compareCompletionItems
  );
}

/** Get registry-backed ctrlyoke MCP completions for a typed server-name prefix. */
export async function getMcpTokenCompletions(
  workspaceRoot: string | undefined,
  namePrefix = ""
): Promise<McpTokenCompletionItem[]> {
  const { managedServers } =
    await getDiscoveredSlashTokenSources(workspaceRoot);
  return createMcpTokenCompletions(managedServers, namePrefix).sort(
    compareCompletionItems
  );
}

function parseSlashTokenCompletionContext(
  prefix: string
): SlashTokenCompletionContext | undefined {
  if (!prefix.startsWith("/")) {
    return undefined;
  }
  for (const kind of Object.values(CTRLYOKE_SLASH_TOKEN_KINDS)) {
    const namespace = tokenPrefix(kind);
    if (prefix.startsWith(namespace)) {
      return { kind, namePrefix: prefix.slice(namespace.length) };
    }
  }
  // Any other `/<string>` (including the bare `/`) filters across both
  // skills and MCP servers by substring — only an explicit `/skill:` or
  // `/mcp:` namespace narrows to a single kind.
  return { kind: MERGED_COMPLETION_KIND, namePrefix: prefix.slice(1) };
}

async function getDiscoveredSlashTokenSources(
  workspaceRoot: string | undefined
): Promise<Pick<SlashTokenDiscoveryCache, "skills" | "managedServers">> {
  const now = Date.now();
  if (
    discoveryCache &&
    discoveryCache.workspaceRoot === workspaceRoot &&
    now - discoveryCache.timestamp < SLASH_TOKEN_CACHE_DURATION_MS
  ) {
    return discoveryCache;
  }

  const [skills, managedServers] = await Promise.all([
    SkillDiscovery.discoverSkills(workspaceRoot),
    new McpRegistryFileManager(workspaceRoot).readAll(),
  ]);

  discoveryCache = {
    workspaceRoot,
    skills,
    managedServers,
    timestamp: now,
  };
  return discoveryCache;
}

function createSkillTokenCompletions(
  skills: readonly SkillInfo[],
  namePrefix: string
): SkillTokenCompletionItem[] {
  const seenNames = new Set<string>();
  const lowerPrefix = namePrefix.toLowerCase();
  const items: SkillTokenCompletionItem[] = [];

  for (const skill of skills) {
    if (
      seenNames.has(skill.name) ||
      !skill.name.toLowerCase().includes(lowerPrefix)
    ) {
      continue;
    }
    seenNames.add(skill.name);

    const description = skill.description.trim();
    const source = skill.source;
    items.push({
      commandType: "ctrlyokeSkill",
      skillName: skill.name,
      label: skill.name,
      kind: vscode.CompletionItemKind.Keyword,
      insertText: `${tokenPrefix(CTRLYOKE_SLASH_TOKEN_KINDS.SKILL)}${skill.name}`,
      detail: description
        ? `ctrlyoke skill · ${source} · ${description}`
        : `ctrlyoke skill · ${source}`,
      documentation: description || undefined,
      filterText: skill.name,
      // Matches describeSlashTokenChip's /skill: icon.
      icon: "tools",
    });
  }

  return items;
}

function createMcpTokenCompletions(
  managedServers: readonly ManagedMcpServer[],
  namePrefix: string
): McpTokenCompletionItem[] {
  const lowerPrefix = namePrefix.toLowerCase();
  const items: McpTokenCompletionItem[] = [];

  // The built-in "ctrlyoke" MCP server is a reserved sentinel, never a
  // registry entry (see CTRLYOKE_BUILTIN_MCP_SERVER_INFO), so it has to be
  // injected here rather than discovered from `managedServers`.
  if (
    CTRLYOKE_BUILTIN_MCP_SERVER_INFO.id
      .toLowerCase()
      .includes(lowerPrefix)
  ) {
    items.push(createBuiltinCtrlYokeMcpCompletion());
  }

  for (const server of managedServers) {
    if (
      server.id === CTRLYOKE_BUILTIN_MCP_SERVER_INFO.id ||
      !server.id.toLowerCase().includes(lowerPrefix)
    ) {
      continue;
    }
    items.push({
      commandType: "ctrlyokeMcpServer",
      mcpServerName: server.id,
      label: server.id,
      kind: vscode.CompletionItemKind.Module,
      insertText: `${tokenPrefix(CTRLYOKE_SLASH_TOKEN_KINDS.MCP)}${server.id}`,
      detail: formatMcpDetail(server),
      filterText: server.id,
      // Matches describeSlashTokenChip's /mcp: icon.
      icon: "mcp",
    });
  }

  return items;
}

function createBuiltinCtrlYokeMcpCompletion(): McpTokenCompletionItem {
  const id = CTRLYOKE_BUILTIN_MCP_SERVER_INFO.id;
  return {
    commandType: "ctrlyokeMcpServer",
    mcpServerName: id,
    label: id,
    kind: vscode.CompletionItemKind.Module,
    insertText: `${tokenPrefix(CTRLYOKE_SLASH_TOKEN_KINDS.MCP)}${id}`,
    detail: `ctrlyoke MCP server (built-in) · ${CTRLYOKE_BUILTIN_MCP_SERVER_INFO.description}`,
    documentation: CTRLYOKE_BUILTIN_MCP_SERVER_INFO.description,
    filterText: id,
    icon: "mcp",
  };
}

function formatMcpDetail(server: ManagedMcpServer): string {
  const config = server.config;
  const summary = config.command
    ? [config.command, ...(config.args ?? [])].join(" ")
    : config.url;
  return summary ? `ctrlyoke MCP server · ${summary}` : "ctrlyoke MCP server";
}

function compareCompletionItems(
  left: SlashTokenCompletionItem,
  right: SlashTokenCompletionItem
): number {
  return left.label.localeCompare(right.label, undefined, {
    sensitivity: "base",
  });
}
