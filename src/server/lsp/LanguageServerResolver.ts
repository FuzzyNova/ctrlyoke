import * as fs from "fs";
import * as path from "path";
import type { CliResolvedCommand } from "../../core/harness/shared/CliLauncherResolver";
import { resolveCliCommand } from "../../core/harness/shared/CliLauncherResolver";
import type {
  CtrlYokeGlobalSettings,
  LanguageServerDefinition,
} from "../../types/CtrlYokeSettings";
import {
  LANGUAGE_SERVER_CATALOG,
  type LanguageServerCatalogEntry,
} from "./LanguageServerCatalog";
import { Log } from "../../utils/Log";

export type LanguageServerDefinitionSource = "user" | "workspace" | "built-in";

export interface ResolvedLanguageServer {
  id: string;
  source: LanguageServerDefinitionSource;
  command: CliResolvedCommand;
  languages: string[];
  extensions: string[];
  rootMarkers: string[];
  settings: Record<string, unknown>;
  env?: Record<string, string>;
  catalogEntry?: LanguageServerCatalogEntry;
}

export interface LanguageServerResolutionOptions {
  languageId: string;
  userSettings: Pick<CtrlYokeGlobalSettings, "languageServers">;
  workspaceSettings: Pick<CtrlYokeGlobalSettings, "languageServers">;
  approvedWorkspaceDefinitionIds: ReadonlySet<string>;
  pathEntries: readonly string[];
  toolBinDirectory: string;
  workspaceRoot: string;
  platform: NodeJS.Platform;
  catalog?: readonly LanguageServerCatalogEntry[];
}

export interface LanguageServerResolverDependencies {
  fileExists(filePath: string): Promise<boolean>;
  resolveCommand(command: string, args: string[]): Promise<CliResolvedCommand>;
}

/** Workspace definitions not yet approved for execution on this machine. */
export function getPendingWorkspaceLanguageServerDefinitions(
  workspaceDefinitions: Record<string, LanguageServerDefinition>,
  approvedDefinitionIds: ReadonlySet<string>
): Array<{ id: string; definition: LanguageServerDefinition }> {
  return Object.entries(workspaceDefinitions)
    .filter(([id]) => !approvedDefinitionIds.has(id))
    .map(([id, definition]) => ({ id, definition }));
}

/** Node adapter used by the managed backend; the selection policy stays injectable. */
export function createNodeLanguageServerResolverDependencies(): LanguageServerResolverDependencies {
  return {
    async fileExists(filePath) {
      try {
        return (await fs.promises.stat(filePath)).isFile();
      } catch {
        return false;
      }
    },
    resolveCommand: resolveCliCommand,
  };
}

/**
 * Resolves the selected language server without starting it. All machine
 * inputs and filesystem/process adapters are explicit so the same selection
 * policy can be used by the managed backend and tested without the host PATH.
 */
export async function resolveLanguageServer(
  options: LanguageServerResolutionOptions,
  dependencies: LanguageServerResolverDependencies
): Promise<ResolvedLanguageServer | undefined> {
  const catalog = options.catalog ?? LANGUAGE_SERVER_CATALOG;
  const language = options.languageId;
  const workspaceSelection = options.workspaceSettings.languageServers.use;
  const userSelection = options.userSettings.languageServers.use;
  const hasWorkspaceSelection = Object.prototype.hasOwnProperty.call(
    workspaceSelection,
    language
  );
  const hasUserSelection = Object.prototype.hasOwnProperty.call(
    userSelection,
    language
  );
  const selected = hasWorkspaceSelection
    ? workspaceSelection[language]
    : hasUserSelection
      ? userSelection[language]
      : undefined;

  if (selected === false) return undefined;

  if (typeof selected === "string") {
    const selectedResolution = await resolveById(
      selected,
      options,
      catalog,
      dependencies
    );
    if (selectedResolution) return selectedResolution;
  }

  for (const entry of catalog) {
    if (!entry.languages.includes(language) || entry.id === selected) continue;
    const resolved = await resolveEntry(entry, options, dependencies);
    if (resolved) return resolved;
  }

  return undefined;
}

async function resolveById(
  id: string,
  options: LanguageServerResolutionOptions,
  catalog: readonly LanguageServerCatalogEntry[],
  dependencies: LanguageServerResolverDependencies
): Promise<ResolvedLanguageServer | undefined> {
  const userDefinition = options.userSettings.languageServers.definitions[id];
  if (userDefinition) {
    const resolved = await resolveDefinition(
      id,
      userDefinition,
      "user",
      options,
      dependencies
    );
    if (resolved) return resolved;
  }

  const workspaceDefinition = options.approvedWorkspaceDefinitionIds.has(id)
    ? options.workspaceSettings.languageServers.definitions[id]
    : undefined;
  if (workspaceDefinition) {
    const resolved = await resolveDefinition(
      id,
      workspaceDefinition,
      "workspace",
      options,
      dependencies
    );
    if (resolved) return resolved;
  }

  const entry = catalog.find((candidate) => candidate.id === id);
  return entry ? resolveEntry(entry, options, dependencies) : undefined;
}

async function resolveEntry(
  entry: LanguageServerCatalogEntry,
  options: LanguageServerResolutionOptions,
  dependencies: LanguageServerResolverDependencies
): Promise<ResolvedLanguageServer | undefined> {
  const userDefinition =
    options.userSettings.languageServers.definitions[entry.id];
  if (userDefinition) {
    const resolved = await resolveDefinition(
      entry.id,
      userDefinition,
      "user",
      options,
      dependencies,
      entry
    );
    if (resolved) return resolved;
  }

  const workspaceDefinition = options.approvedWorkspaceDefinitionIds.has(
    entry.id
  )
    ? options.workspaceSettings.languageServers.definitions[entry.id]
    : undefined;
  if (workspaceDefinition) {
    const resolved = await resolveDefinition(
      entry.id,
      workspaceDefinition,
      "workspace",
      options,
      dependencies,
      entry
    );
    if (resolved) return resolved;
  }

  return resolveDefinition(
    entry.id,
    entry,
    "built-in",
    options,
    dependencies,
    entry
  );
}

async function resolveDefinition(
  id: string,
  definition: LanguageServerDefinition | LanguageServerCatalogEntry,
  source: LanguageServerDefinitionSource,
  options: LanguageServerResolutionOptions,
  dependencies: LanguageServerResolverDependencies,
  catalogEntry?: LanguageServerCatalogEntry
): Promise<ResolvedLanguageServer | undefined> {
  const [executable, ...args] = definition.command;
  if (!executable) return undefined;

  const foundPath = await findExecutable(executable, options, dependencies);
  if (!foundPath) return undefined;

  const workspaceSettings = options.approvedWorkspaceDefinitionIds.has(id)
    ? (options.workspaceSettings.languageServers.settings[id] ?? {})
    : stripUnapprovedWorkspaceOptions(
        id,
        options.workspaceSettings.languageServers.settings[id] ?? {}
      );

  return {
    id,
    source,
    command: await dependencies.resolveCommand(foundPath, args),
    languages: [...definition.languages],
    extensions: [...definition.extensions],
    rootMarkers: [...definition.rootMarkers],
    settings: {
      ...options.userSettings.languageServers.settings[id],
      ...workspaceSettings,
    },
    ...("env" in definition && definition.env
      ? { env: { ...definition.env } }
      : {}),
    ...(catalogEntry ? { catalogEntry } : {}),
  };
}

const warnedWorkspaceOptionKeys = new Set<string>();
const WORKSPACE_EXECUTION_OPTION_KEY_PATTERN =
  /path|tsdk|plugin|command|env|exec|executable|binary/i;

/** Values in these settings can select or execute workspace-controlled code. */
export function getWorkspaceExecutionOptionEntries(
  settings: Record<string, unknown>,
  prefix = ""
): string[] {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (WORKSPACE_EXECUTION_OPTION_KEY_PATTERN.test(key)) {
      entries.push(`${fullKey}:${JSON.stringify(value)}`);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push(
        ...getWorkspaceExecutionOptionEntries(
          value as Record<string, unknown>,
          fullKey
        )
      );
    }
  }
  return entries.sort();
}

/** Path and plugin options can execute workspace-controlled code or load code. */
function isWorkspaceExecutionOptionKey(key: string): boolean {
  return WORKSPACE_EXECUTION_OPTION_KEY_PATTERN.test(key);
}

function stripUnapprovedWorkspaceOptions(
  id: string,
  settings: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isWorkspaceExecutionOptionKey(key)) {
      const warningKey = `${id}:${fullKey}`;
      if (!warnedWorkspaceOptionKeys.has(warningKey)) {
        warnedWorkspaceOptionKeys.add(warningKey);
        Log.warn(
          `[LanguageServerResolver] Ignoring unapproved workspace language-server option ${id}.${fullKey}.`
        );
      }
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripUnapprovedWorkspaceOptions(
        id,
        value as Record<string, unknown>,
        fullKey
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function findExecutable(
  executable: string,
  options: LanguageServerResolutionOptions,
  dependencies: LanguageServerResolverDependencies
): Promise<string | undefined> {
  const isPath = path.isAbsolute(executable) || /[\\/]/.test(executable);
  const candidates = isPath
    ? [
        path.isAbsolute(executable)
          ? executable
          : path.resolve(options.workspaceRoot, executable),
      ]
    : [
        ...options.pathEntries.map((directory) =>
          path.join(directory, executable)
        ),
        path.join(options.toolBinDirectory, executable),
        path.join(options.workspaceRoot, "node_modules", ".bin", executable),
      ];

  const extensions = executableHasExtension(executable)
    ? [""]
    : options.platform === "win32"
      ? [".exe", ".cmd", ".bat", ".ps1", ""]
      : [""];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const candidatePath = `${candidate}${extension}`;
      if (await dependencies.fileExists(candidatePath)) return candidatePath;
    }
  }
  return undefined;
}

function executableHasExtension(executable: string): boolean {
  return path.extname(executable).length > 0;
}
