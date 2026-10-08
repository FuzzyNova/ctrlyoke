import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LanguageServerDefinition } from "../types/CtrlYokeSettings";
import type { LocalLanguageServerEntry } from "../types/WebviewMessageTypes";
import {
  LSP_DISCOVERY_FORMATS,
  LSP_DISCOVERY_SOURCES,
} from "../types/DashboardConstants";
import {
  getCclspConfigPaths,
  getClaudeInstalledPluginsManifestPath,
  getCopilotWorkspaceLspConfigPaths,
  getHomeLspConfigPath,
  getOpenCodeUserLspConfigPath,
  getOpenCodeWorkspaceLspConfigPath,
  getQwenWorkspaceLspConfigPath,
} from "./LspConfigPaths";
import { Log } from "./Log";

type JsonRecord = Record<string, unknown>;
interface Descriptor {
  path: string;
  source: string;
  format: (typeof LSP_DISCOVERY_FORMATS)[keyof typeof LSP_DISCOVERY_FORMATS];
  pluginRoot?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function command(value: unknown, args: unknown): string[] {
  if (Array.isArray(value)) return strings(value);
  return typeof value === "string" ? [value, ...strings(args)] : [];
}
function languagesAndExtensions(value: unknown): {
  languages: string[];
  extensions: string[];
} {
  if (!isRecord(value)) return { languages: [], extensions: [] };
  const extensions = Object.keys(value)
    .map((key) => key.replace(/^\./, ""))
    .filter(Boolean);
  return {
    extensions,
    languages: [
      ...new Set(
        Object.values(value).filter(
          (entry): entry is string => typeof entry === "string"
        )
      ),
    ],
  };
}
function makeDefinition(
  value: unknown,
  format: Descriptor["format"]
): LanguageServerDefinition | undefined {
  if (!isRecord(value)) return undefined;
  let cmd: string[];
  let mapped = { languages: [] as string[], extensions: [] as string[] };
  let extensions = strings(value.extensions).map((ext) =>
    ext.replace(/^\./, "")
  );
  let languages = strings(value.languages);
  if (
    format === LSP_DISCOVERY_FORMATS.OPENCODE ||
    format === LSP_DISCOVERY_FORMATS.CCLSP
  )
    cmd = command(value.command, undefined);
  else cmd = command(value.command, value.args);
  if (
    format === LSP_DISCOVERY_FORMATS.QWEN ||
    format === LSP_DISCOVERY_FORMATS.CLAUDE_PLUGIN
  )
    mapped = languagesAndExtensions(value.extensionToLanguage);
  if (format === LSP_DISCOVERY_FORMATS.COPILOT)
    mapped = languagesAndExtensions(value.fileExtensions);
  if (format === LSP_DISCOVERY_FORMATS.CCLSP && !extensions.length)
    extensions = strings(value.extensions).map((ext) => ext.replace(/^\./, ""));
  extensions = [...new Set([...extensions, ...mapped.extensions])];
  languages = [...new Set([...languages, ...mapped.languages])];
  if (!cmd.length) return undefined;
  const definition: LanguageServerDefinition = {
    command: cmd,
    languages,
    extensions,
    rootMarkers: strings(value.rootMarkers),
  };
  const env = stringMap(value.env);
  if (env) definition.env = env;
  return definition;
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      Log.warn(`[LspDiscovery] Could not read ${filePath}: ${String(error)}`);
    return undefined;
  }
}

async function getClaudePluginDescriptors(): Promise<Descriptor[]> {
  const manifestPath = getClaudeInstalledPluginsManifestPath();
  const manifest = await readJson(manifestPath);
  if (!manifest) return [];
  const directories = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["installPath", "install_path"]) {
      if (typeof value[key] === "string")
        directories.add(path.resolve(value[key] as string));
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(manifest);
  const descriptors: Descriptor[] = [];
  for (const directory of directories) {
    for (const name of [
      ".lsp.json",
      "plugin.json",
      path.join(".claude-plugin", "plugin.json"),
    ]) {
      const filePath = path.join(directory, name);
      try {
        await fs.access(filePath);
        descriptors.push({
          path: filePath,
          source: LSP_DISCOVERY_SOURCES.CLAUDE_CODE_PLUGIN,
          format: LSP_DISCOVERY_FORMATS.CLAUDE_PLUGIN,
          pluginRoot: directory,
        });
      } catch {
        /* absent optional plugin metadata */
      }
    }
  }
  return descriptors;
}

function descriptors(root: string): Descriptor[] {
  return [
    {
      path: getQwenWorkspaceLspConfigPath(root),
      source: LSP_DISCOVERY_SOURCES.QWEN_CODE,
      format: LSP_DISCOVERY_FORMATS.QWEN,
    },
    ...getCopilotWorkspaceLspConfigPaths(root).map((filePath) => ({
      path: filePath,
      source: LSP_DISCOVERY_SOURCES.COPILOT_CLI,
      format: LSP_DISCOVERY_FORMATS.COPILOT,
    })),
    {
      path: getHomeLspConfigPath(),
      source: LSP_DISCOVERY_SOURCES.COPILOT_CLI_USER,
      format: LSP_DISCOVERY_FORMATS.COPILOT,
    },
    {
      path: getOpenCodeWorkspaceLspConfigPath(root),
      source: LSP_DISCOVERY_SOURCES.OPENCODE,
      format: LSP_DISCOVERY_FORMATS.OPENCODE,
    },
    {
      path: getOpenCodeUserLspConfigPath(),
      source: LSP_DISCOVERY_SOURCES.OPENCODE_USER,
      format: LSP_DISCOVERY_FORMATS.OPENCODE,
    },
    ...getCclspConfigPaths(root).map((filePath) => ({
      path: filePath,
      source: LSP_DISCOVERY_SOURCES.CCLSP,
      format: LSP_DISCOVERY_FORMATS.CCLSP,
    })),
  ];
}

function parseEntries(
  data: JsonRecord,
  descriptor: Descriptor
): LocalLanguageServerEntry[] {
  const results: LocalLanguageServerEntry[] = [];
  const add = (id: string, config: unknown): void => {
    const definition = makeDefinition(config, descriptor.format);
    if (definition)
      results.push({
        id,
        definition,
        source: descriptor.source,
        path: descriptor.path,
      });
  };
  if (descriptor.format === LSP_DISCOVERY_FORMATS.COPILOT) {
    const servers = isRecord(data.lspServers) ? data.lspServers : {};
    for (const [id, config] of Object.entries(servers)) add(id, config);
  } else if (descriptor.format === LSP_DISCOVERY_FORMATS.OPENCODE) {
    const servers = isRecord(data.lsp) ? data.lsp : {};
    for (const [id, config] of Object.entries(servers)) {
      if (config === true) continue;
      if (isRecord(config) && config.disabled !== true) add(id, config);
    }
  } else if (descriptor.format === LSP_DISCOVERY_FORMATS.CCLSP) {
    const servers = Array.isArray(data.servers) ? data.servers : [];
    for (const [index, config] of servers.entries())
      add(
        isRecord(config) && typeof config.name === "string"
          ? config.name
          : `cclsp-${index + 1}`,
        config
      );
  } else {
    const isPluginManifest =
      descriptor.format === LSP_DISCOVERY_FORMATS.CLAUDE_PLUGIN &&
      path.basename(descriptor.path) === "plugin.json";
    const servers = isPluginManifest
      ? isRecord(data.lspServers)
        ? data.lspServers
        : {}
      : data;
    for (const [id, config] of Object.entries(servers))
      if (id !== "name") add(id, config);
  }
  return results;
}

export async function safeDiscoverLocalLanguageServers(
  workspaceRoot: string
): Promise<{ servers: LocalLanguageServerEntry[]; error?: string }> {
  try {
    const found = [
      ...descriptors(workspaceRoot),
      ...(await getClaudePluginDescriptors()),
    ];
    const results: LocalLanguageServerEntry[] = [];
    for (const descriptor of found) {
      const parsed = await readJson(descriptor.path);
      if (!parsed) continue;
      if (
        descriptor.format === LSP_DISCOVERY_FORMATS.CLAUDE_PLUGIN &&
        typeof parsed.lspServers === "string" &&
        descriptor.pluginRoot
      ) {
        const referencedPath = path.resolve(
          descriptor.pluginRoot,
          parsed.lspServers
        );
        const referenced = await readJson(referencedPath);
        if (referenced)
          results.push(
            ...parseEntries(referenced, {
              ...descriptor,
              path: referencedPath,
              format: LSP_DISCOVERY_FORMATS.QWEN,
            })
          );
      } else results.push(...parseEntries(parsed, descriptor));
    }
    return { servers: results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Log.warn("[LspDiscovery] Local scan failed:", message);
    return { servers: [], error: message };
  }
}
