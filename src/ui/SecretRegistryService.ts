import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  PROMPT_PROPERTIES,
  SECRET_REGISTRY_STATES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "../types/DashboardConstants";
import type {
  SecretRegistryEntry,
  SecretRegistryUsage,
} from "../types/WebviewMessageTypes";
import type { SecretStore } from "../platform/SecretStore";
import {
  isValidSecretName,
  userSecretKey,
  userSecretMetadataKey,
  validateSecretName,
  workspaceSecretKeyForRoot,
  workspaceSecretMetadataKeyForRoot,
} from "../platform/SecretKey";
import { collectSecretInterpolationNames } from "../utils/SecretResolver";
import { parseSecretReferences } from "../utils/SecretReferenceParser";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";

export interface SecretRegistryWorkflowReference {
  workflow: string;
  secretNames: readonly string[];
}

export interface SecretRegistryMcpReference {
  server: string;
  secretNames: readonly string[];
}

export interface SecretRegistryServiceOptions {
  secretStore: SecretStore;
  getWorkspaceRoot: () => string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  getWorkflowReferences?: () => Promise<SecretRegistryWorkflowReference[]>;
  getMcpReferences?: (
    scope: SettingWriteScope
  ) => Promise<SecretRegistryMcpReference[]>;
}

interface SecretMetadata {
  description?: string;
  lastUpdated: number;
}

interface ScannedWorkflowReference extends SecretRegistryWorkflowReference {
  mcpServers: SecretRegistryMcpReference[];
}

const WORKFLOW_EXTENSIONS = [
  ".ctrlyoke.json",
  ".ctrlyoke.yaml",
  ".ctrlyoke.yml",
  ".prompt.md",
] as const;

function isWriteScope(value: unknown): value is SettingWriteScope {
  return value === SETTING_SCOPES.USER || value === SETTING_SCOPES.WORKSPACE;
}

function assertWriteScope(value: unknown): asserts value is SettingWriteScope {
  if (!isWriteScope(value)) {
    throw new Error(`Invalid secret scope "${String(value)}".`);
  }
}

function uniqueValidNames(names: Iterable<string>): string[] {
  return [...new Set([...names].filter(isValidSecretName))].sort();
}

function collectInterpolationNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  try {
    return collectSecretInterpolationNames(value as Record<string, string>);
  } catch {
    // Invalid references are handled by workflow preflight. The registry still
    // lists valid names and must never turn a malformed unrelated file into a
    // reason to expose or log a secret value.
    return [];
  }
}

function collectWorkflowNames(
  value: unknown,
  names: Set<string>,
  mcpServers: SecretRegistryMcpReference[]
): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectWorkflowNames(item, names, mcpServers);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "secrets" && Array.isArray(child)) {
      for (const name of child) {
        if (typeof name === "string" && isValidSecretName(name)) {
          names.add(name);
        }
      }
    }

    if (key === PROMPT_PROPERTIES.PROMPT && typeof child === "string") {
      for (const reference of parseSecretReferences(child)) {
        names.add(reference.name);
      }
    }

    if ((key === "env" || key === "headers") && child) {
      for (const name of collectInterpolationNames(child)) names.add(name);
    }

    if (key === "mcpServers" && Array.isArray(child)) {
      for (const server of child) {
        if (!server || typeof server !== "object") continue;
        const record = server as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : undefined;
        const serverNames = uniqueValidNames([
          ...collectInterpolationNames(record.env),
          ...collectInterpolationNames(record.headers),
        ]);
        for (const name of serverNames) names.add(name);
        if (id && serverNames.length > 0) {
          mcpServers.push({ server: id, secretNames: serverNames });
        }
      }
    }

    collectWorkflowNames(child, names, mcpServers);
  }
}

function workflowFileName(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  return relative || path.basename(filePath);
}

function isWorkflowFile(fileName: string): boolean {
  return WORKFLOW_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

async function readWorkflowReference(
  filePath: string,
  workspaceRoot: string
): Promise<ScannedWorkflowReference | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const names = new Set<string>();
    const mcpServers: SecretRegistryMcpReference[] = [];

    if (filePath.endsWith(".prompt.md")) {
      for (const reference of parseSecretReferences(content)) {
        names.add(reference.name);
      }
    } else {
      const parsed = filePath.endsWith(".json")
        ? JSON.parse(content)
        : yaml.load(content, { schema: yaml.CORE_SCHEMA });
      collectWorkflowNames(parsed, names, mcpServers);
    }

    return {
      workflow: workflowFileName(filePath, workspaceRoot),
      secretNames: uniqueValidNames(names),
      mcpServers,
    };
  } catch {
    return undefined;
  }
}

async function discoverWorkflowFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          entry.name === "out" ||
          entry.name === "dist" ||
          entry.name === "coverage" ||
          entry.name === ".runs" ||
          entry.name === "temp" ||
          entry.name === "attachments"
        ) {
          continue;
        }
        await visit(fullPath);
      } else if (isWorkflowFile(entry.name) && !visited.has(fullPath)) {
        visited.add(fullPath);
        files.push(fullPath);
      }
    }
  };

  await visit(root);
  return files;
}

function usageForName(
  name: string,
  workflows: readonly SecretRegistryWorkflowReference[],
  mcpServers: readonly SecretRegistryMcpReference[]
): SecretRegistryUsage {
  return {
    workflows: [
      ...new Set(
        workflows
          .filter((workflow) => workflow.secretNames.includes(name))
          .map((workflow) => workflow.workflow)
      ),
    ].sort(),
    mcpServers: [
      ...new Set(
        mcpServers
          .filter((server) => server.secretNames.includes(name))
          .map((server) => server.server)
      ),
    ].sort(),
  };
}

/** Extension-host registry for safe secret names, metadata, and usage. */
export class SecretRegistryService {
  constructor(private readonly options: SecretRegistryServiceOptions) {}

  /** Return registry names only; secret values never cross this boundary. */
  async getCompletionNames(): Promise<string[]> {
    const entries = await Promise.all([
      this.list(SETTING_SCOPES.USER),
      this.list(SETTING_SCOPES.WORKSPACE),
    ]);
    return uniqueValidNames(entries.flat().map((entry) => entry.name));
  }

  /** Check whether a name can resolve from the environment or managed store. */
  async isResolvable(name: string): Promise<boolean> {
    if (!isValidSecretName(name)) return false;
    if (this.hasEnvironmentValue(name)) return true;

    const [workspaceValue, userValue] = await Promise.all([
      this.options.secretStore.get(
        workspaceSecretKeyForRoot(this.options.getWorkspaceRoot(), name)
      ),
      this.options.secretStore.get(userSecretKey(name)),
    ]);
    return workspaceValue !== undefined || userValue !== undefined;
  }

  async list(
    scope: SettingWriteScope,
    additionalKnownNames: readonly string[] = []
  ): Promise<SecretRegistryEntry[]> {
    assertWriteScope(scope);
    const [managedNames, workflows, mcpServers] = await Promise.all([
      this.getManagedNames(scope),
      this.getWorkflowReferences(),
      this.getMcpReferences(scope),
    ]);
    const names = uniqueValidNames([
      ...managedNames,
      ...additionalKnownNames,
      ...workflows.flatMap((workflow) => workflow.secretNames),
      ...mcpServers.flatMap((server) => server.secretNames),
    ]);
    const entries: SecretRegistryEntry[] = [];

    for (const name of names) {
      const key = this.secretKey(scope, name);
      const managedValue = await this.options.secretStore.get(key);
      const metadata = await this.readMetadata(scope, name);
      const state =
        managedValue !== undefined
          ? SECRET_REGISTRY_STATES.MANAGED_AND_SET
          : this.hasEnvironmentValue(name)
            ? SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED
            : SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND;

      entries.push({
        name,
        scope,
        state,
        ...(metadata?.description ? { description: metadata.description } : {}),
        ...(metadata?.lastUpdated !== undefined
          ? { lastUpdated: metadata.lastUpdated }
          : {}),
        usedBy: usageForName(name, workflows, mcpServers),
      });
    }

    return entries;
  }

  async getUsedBy(
    name: string,
    scope: SettingWriteScope
  ): Promise<SecretRegistryUsage> {
    assertWriteScope(scope);
    if (!isValidSecretName(name)) return { mcpServers: [], workflows: [] };
    const [workflows, mcpServers] = await Promise.all([
      this.getWorkflowReferences(),
      this.getMcpReferences(scope),
    ]);
    return usageForName(name, workflows, mcpServers);
  }

  async set(
    name: string,
    scope: SettingWriteScope,
    value: string,
    description?: string
  ): Promise<void> {
    assertWriteScope(scope);
    validateSecretName(name);
    if (typeof value !== "string") {
      throw new Error("Secret value must be a string.");
    }

    const now = this.options.now?.() ?? Date.now();
    await this.options.secretStore.store(this.secretKey(scope, name), value);
    await this.options.secretStore.store(
      this.metadataKey(scope, name),
      JSON.stringify({
        ...(description?.trim() ? { description: description.trim() } : {}),
        lastUpdated: now,
      } satisfies SecretMetadata)
    );
  }

  async delete(name: string, scope: SettingWriteScope): Promise<void> {
    assertWriteScope(scope);
    validateSecretName(name);
    await this.options.secretStore.delete(this.secretKey(scope, name));
    await this.options.secretStore.delete(this.metadataKey(scope, name));
  }

  private secretKey(scope: SettingWriteScope, name: string): string {
    return scope === SETTING_SCOPES.USER
      ? userSecretKey(name)
      : workspaceSecretKeyForRoot(this.options.getWorkspaceRoot(), name);
  }

  private metadataKey(scope: SettingWriteScope, name: string): string {
    return scope === SETTING_SCOPES.USER
      ? userSecretMetadataKey(name)
      : workspaceSecretMetadataKeyForRoot(
          this.options.getWorkspaceRoot(),
          name
        );
  }

  private async getManagedNames(scope: SettingWriteScope): Promise<string[]> {
    const keys = await this.options.secretStore.keys();
    const names = new Set<string>();
    for (const key of keys) {
      const candidate = key.split(".").at(-1);
      if (
        candidate &&
        isValidSecretName(candidate) &&
        key === this.secretKey(scope, candidate)
      ) {
        names.add(candidate);
      }
    }
    return [...names];
  }

  private async readMetadata(
    scope: SettingWriteScope,
    name: string
  ): Promise<SecretMetadata | undefined> {
    const raw = await this.options.secretStore.get(
      this.metadataKey(scope, name)
    );
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<SecretMetadata>;
      return typeof parsed.lastUpdated === "number" &&
        Number.isFinite(parsed.lastUpdated)
        ? {
            lastUpdated: parsed.lastUpdated,
            ...(typeof parsed.description === "string" &&
            parsed.description.trim()
              ? { description: parsed.description }
              : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private hasEnvironmentValue(name: string): boolean {
    const environment = this.options.environment ?? process.env;
    return (
      Object.prototype.hasOwnProperty.call(environment, name) &&
      environment[name] !== undefined
    );
  }

  private async getWorkflowReferences(): Promise<
    SecretRegistryWorkflowReference[]
  > {
    if (this.options.getWorkflowReferences) {
      return this.options.getWorkflowReferences();
    }
    const root = this.options.getWorkspaceRoot();
    const files = await discoverWorkflowFiles(root);
    const scanned = await Promise.all(
      files.map((filePath) => readWorkflowReference(filePath, root))
    );
    return scanned
      .filter((reference): reference is ScannedWorkflowReference => !!reference)
      .map(({ workflow, secretNames }) => ({ workflow, secretNames }));
  }

  private async getMcpReferences(
    scope: SettingWriteScope
  ): Promise<SecretRegistryMcpReference[]> {
    if (this.options.getMcpReferences) {
      return this.options.getMcpReferences(scope);
    }
    const registry = new McpRegistryFileManager(
      this.options.getWorkspaceRoot()
    );
    const servers = await registry.readScope(scope);
    return servers.map((server) => ({
      server: server.id,
      secretNames: uniqueValidNames([
        ...collectInterpolationNames(server.env),
        ...collectInterpolationNames(server.headers),
      ]),
    }));
  }
}
