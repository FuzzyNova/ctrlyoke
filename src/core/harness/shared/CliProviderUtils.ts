import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import type {
  McpServerConfig,
  PromptFile,
} from "../../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../../../config/ExternalRootsTrustStore";
import { Log } from "../../../utils/Log";
import {
  getFrozenRunHistoryLocation,
  isRunHistoryLocationInitialized,
} from "../../../utils/RunHistoryStoragePolicy";
import { ctrlyokeStateHome } from "../../../utils/ProjectStatePaths";
import { canonicalizeDriveLetter } from "../../../utils/PathCasing";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import { resolveCliCommand } from "./CliLauncherResolver";
import { CLI_VERSION_CHECK_TIMEOUT_MS } from "./interfaces/ICliProvider";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
} from "./interfaces/PreparedMutation";
import type { McpSecretConfigOptions } from "./CliMcpConfigGenerator";
import { transformMcpSecretMap } from "./CliMcpConfigGenerator";
import {
  MCP_AVAILABILITY_MODES,
  MCP_SERVER_IDS,
  MCP_TRANSPORTS,
  MCP_SECRET_CONFIG_MODES,
} from "../../../types/DashboardConstants";

const execFileAsync = promisify(execFile);

const WINDOWS_FILE_LOCK_ERROR = "being used by another process";

interface CliCommandOptions {
  timeoutMs?: number;
  retryWindowsFileLockErrors?: boolean;
}

interface GetCliVersionOptions extends CliCommandOptions {
  parseVersion?: (stdout: string) => string | undefined;
}

export interface CliProviderWorkflowContext {
  filePath?: string;
  stateRoot?: string;
  workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
}

/** Pure effective-property check shared by execution planning and group preflight. */
export function hasCtrlYokeServer(
  properties: Pick<ResolvedProperties, "mcpAvailability" | "mcpServers">
): boolean {
  if (properties.mcpAvailability === MCP_AVAILABILITY_MODES.DISABLED) {
    return false;
  }
  return (properties.mcpServers ?? []).some(
    (server) =>
      server === MCP_SERVER_IDS.CTRLYOKE ||
      (typeof server === "object" &&
        server !== null &&
        server.id === MCP_SERVER_IDS.CTRLYOKE)
  );
}

export interface WorkflowExternalRootsContext {
  workspaceIdentity: string;
  identity: string;
  declaredRoots: string[] | null | undefined;
}

/**
 * Shares a successful asynchronous lookup while allowing failures to be retried.
 *
 * CLI installation/version checks are called by both detector integrations and
 * capability consumers. Keeping a rejected promise would make a newly installed
 * CLI appear unavailable for the rest of the extension-host session, so only
 * successful results are retained.
 */
export class RetryableAsyncCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  async getOrRun(key: string, operation: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      return cached;
    }

    const result = operation();
    this.entries.set(key, result);

    try {
      return await result;
    } catch (error) {
      if (this.entries.get(key) === result) {
        this.entries.delete(key);
      }
      throw error;
    }
  }
}

/**
 * Per-harness formatting knobs for {@link CliProviderUtils.buildSettingsJsonMcpEntries}.
 *
 * Defaults reproduce Qwen output (`url` + `type` for remote servers,
 * `trust: true` for auto-approved servers). Antigravity's `mcp_config.json`
 * schema uses `serverUrl` and recognizes neither `type` nor `trust`.
 */
export interface SettingsJsonMcpEntryOptions {
  /** Key used for a remote server's URL. Default `"url"`; Antigravity uses `"serverUrl"`. */
  remoteUrlKey?: "url" | "serverUrl";
  /** Whether to emit a `type` field for remote servers. Default `true`. */
  includeRemoteType?: boolean;
  /** Whether to emit a `trust` field for auto-approved/orchestrator servers. Default `true`. */
  includeTrust?: boolean;
}

/**
 * Shared CLI provider utilities
 *
 * Contains common logic used by all CLI providers (Copilot, Claude, Codex)
 * to avoid code duplication across provider implementations.
 *
 * **Single source of truth for:**
 * - Workspace directory resolution (`getWorkspaceDirs`)
 * - MCP configuration injection (`buildMcpConfigBlock`)
 * - Session resume decision (`shouldResumeSession`)
 * - Process environment construction (`buildProcessEnv`)
 * - Shell-aware CLI version checks (`checkCliAvailability`, `getCliVersion`)
 */
export class CliProviderUtils {
  /** Build the per-provider MCP secret strategy at the shared config seam. */
  static createMcpSecretConfigOptions(
    referenceToken: ((name: string) => string) | undefined,
    resolvedValues?: Readonly<Record<string, string>>
  ): McpSecretConfigOptions | undefined {
    if (referenceToken) {
      return {
        mode: MCP_SECRET_CONFIG_MODES.REFERENCE,
        referenceToken,
      };
    }
    if (resolvedValues) {
      return {
        mode: "substitute",
        resolvedValues,
        restrictivePermissions: true,
      };
    }
    return undefined;
  }

  /**
   * One extension-host session needs only one successful `--version` probe per
   * command. The cache also coalesces simultaneous detector and capability
   * checks while their process is still running.
   */
  private static readonly versionCommandCache =
    new RetryableAsyncCache<string>();

  /**
   * Keeps help-output lookups independent from version probes. A CLI can
   * change or become available during the extension-host session without
   * invalidating the other lookup's result.
   */
  private static readonly helpCommandCache = new RetryableAsyncCache<string>();

  /**
   * Shared implementation behind {@link runVersionCommand} and
   * {@link runHelpCommand}: resolve the launcher, spawn with a timeout, cache
   * the successful result, and optionally retry past transient Windows file
   * locks. The two callers differ only in which cache and log/error label to
   * use, so this is the single place that owns process-spawn behavior.
   */
  private static async runCachedCliCommand(
    command: string,
    cache: RetryableAsyncCache<string>,
    logLabel: string,
    options: CliCommandOptions
  ): Promise<string> {
    const execute = async (): Promise<string> => {
      const [commandName, ...commandArgs] = parseArgString(command);
      if (!commandName) {
        throw new Error(`${logLabel} command is empty`);
      }

      const resolved = await resolveCliCommand(commandName, commandArgs);
      const timeoutMs = options.timeoutMs ?? CLI_VERSION_CHECK_TIMEOUT_MS;
      Log.debug(
        `[${logLabel}] spawning: ${resolved.displayCommand} (kind=${resolved.launcherKind}, timeout=${timeoutMs}ms)`
      );
      const { stdout } = await execFileAsync(resolved.command, resolved.args, {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsVerbatimArguments: resolved.requiresShellVerbatimArgs,
      });
      return typeof stdout === "string" ? stdout.trim() : String(stdout).trim();
    };

    return cache.getOrRun(command, async () => {
      if (!options.retryWindowsFileLockErrors) {
        return execute();
      }

      const result = await retryWithBackoff(
        async () => {
          try {
            return await execute();
          } catch (error) {
            if (String(error).includes(WINDOWS_FILE_LOCK_ERROR)) {
              return null;
            }
            throw error;
          }
        },
        { maxAttempts: 4, delays: [200, 500, 1000] }
      );

      if (result === undefined) {
        throw new Error(`${logLabel} command failed: ${command}`);
      }
      return result;
    });
  }

  /**
   * Execute a CLI version command through the same launcher resolution path used
   * for runtime prompt execution.
   */
  static async runVersionCommand(
    versionCommand: string,
    options: CliCommandOptions = {}
  ): Promise<string> {
    return CliProviderUtils.runCachedCliCommand(
      versionCommand,
      CliProviderUtils.versionCommandCache,
      "Version",
      options
    );
  }

  /**
   * Execute a CLI help command through the same launcher and retry paths used
   * for version checks.
   */
  static async runHelpCommand(
    helpCommand: string,
    options: CliCommandOptions = {}
  ): Promise<string> {
    return CliProviderUtils.runCachedCliCommand(
      helpCommand,
      CliProviderUtils.helpCommandCache,
      "Help",
      options
    );
  }

  /**
   * Check whether a CLI is available by running its version command.
   */
  static async checkCliAvailability(
    versionCommand: string,
    options: CliCommandOptions = {}
  ): Promise<boolean> {
    try {
      await CliProviderUtils.runVersionCommand(versionCommand, options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a CLI version string, with optional provider-specific parsing.
   */
  static async getCliVersion(
    versionCommand: string,
    options: GetCliVersionOptions = {}
  ): Promise<string | undefined> {
    try {
      const stdout = await CliProviderUtils.runVersionCommand(
        versionCommand,
        options
      );
      const parsed = options.parseVersion?.(stdout) ?? stdout;
      return parsed || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Determine whether to resume a session for this prompt execution.
   *
   * Single source of truth for the resume decision across all CLI providers.
   * A session is resumed only when:
   * 1. The `resumeSession` property is explicitly true for this prompt, AND
   * 2. A session ID from a prior turn is available to resume.
   *
   * This prevents accidentally resuming a session when `resumeSession` is
   * false (or unset) just because a stale session ID is present in state.
   *
   * @param resolvedResumeSession - Resolved value of the `resumeSession` property
   * @param sessionId - Session ID from a prior turn, if any
   * @returns true only when both conditions are satisfied
   */
  static shouldResumeSession(
    resolvedResumeSession: boolean | undefined,
    sessionId: string | undefined
  ): boolean {
    return (resolvedResumeSession ?? false) && !!sessionId;
  }

  /**
   * Get workspace directories for --add-dir arguments
   *
   * Collects every workspace-folder root plus every external root currently
   * authorized via `permissions.allowedExternalFileRoots` (see
   * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md) — the sole mechanism for
   * granting a harness sandbox access to a directory outside the workspace.
   * Workspace roots stay distinct from external roots so external-root
   * policy can decide explicitly which roots a harness may receive.
   *
   * Single source of truth for `--add-dir` assembly — used identically by
   * Claude, Codex, Copilot, and Antigravity. Qwen and OpenCode don't call
   * this (no `--add-dir` equivalent); they pass external file references
   * directly and rely on their own trust mechanisms.
   *
   * @param workspaceRoot - Primary workspace root for resolving relative paths
   * @param workspaceRoots - Every open workspace-folder root
   * @returns Array of absolute directory paths
   */
  static getWorkspaceDirs(
    workspaceRoot: string,
    workspaceRoots: readonly string[] = [],
    approvedExternalRoots?: readonly string[],
    workflowContext?: CliProviderWorkflowContext
  ): string[] {
    const workspaceDirs: string[] = [];
    const directoryKeys = new Set<string>();
    const isWindows = process.platform === "win32";
    const addDirectory = (directory: string): void => {
      const absolutePath = canonicalizeDriveLetter(path.resolve(directory));
      const key = isWindows ? absolutePath.toLowerCase() : absolutePath;
      if (!directoryKeys.has(key)) {
        directoryKeys.add(key);
        workspaceDirs.push(absolutePath);
      }
    };

    // Keep the primary root first for deterministic behavior, then include
    // every other workspace folder for multi-root windows.
    addDirectory(workspaceRoot);
    workspaceRoots.forEach(addDirectory);

    // An explicit workflow declaration replaces the inherited roots. When no
    // workflow context is available, retain the execution workspace snapshot
    // supplied by callers.
    const workflowRoots = workflowContext
      ? CliProviderUtils.getWorkflowExternalRootsContext(
          workspaceRoot,
          workflowContext
        )
      : undefined;
    const effectiveExternalRoots = workflowRoots
      ? ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          workflowRoots.workspaceIdentity,
          {
            identity: workflowRoots.identity,
            declaredRoots: workflowRoots.declaredRoots,
          }
        )
      : (approvedExternalRoots ??
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
        ));
    effectiveExternalRoots.forEach(addDirectory);

    return workspaceDirs;
  }

  static getWorkflowExternalRootsContext(
    workspaceRoot: string,
    workflowContext: CliProviderWorkflowContext
  ): WorkflowExternalRootsContext | undefined {
    const workflowSourcePath = workflowContext.filePath;
    if (
      !workflowSourcePath ||
      workflowSourcePath.startsWith("<") ||
      !workflowContext.workflowFile
    ) {
      return undefined;
    }

    const trustWorkspaceRoot = workflowContext.stateRoot ?? workspaceRoot;
    return {
      workspaceIdentity:
        ExternalRootsTrustStore.canonicalizeRoot(trustWorkspaceRoot),
      identity: ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
        trustWorkspaceRoot,
        workflowSourcePath
      ),
      declaredRoots: workflowContext.workflowFile.trustedExternalRoots,
    };
  }

  /**
   * Build MCP configuration block for dynamic queue extension
   *
   * Common logic for checking whether MCP config should be injected and
   * calling the provider's getMcpConfigArgs. Each provider still defines
   * its own getMcpConfigArgs (for format-specific config generation), but
   * the decision logic and PromptIdentity check are shared here.
   *
   * @param workflowContext - Workflow context with resolved properties
   * @param workspaceRoot - Workspace root directory
   * @param extensionPath Extension installation directory
   * @param getMcpConfigArgs - Provider-specific MCP config args generator
   * @returns CLI arguments to add, or empty array if MCP not needed
   */
  static async buildMcpConfigBlock(
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: unknown[];
          filePath?: string;
          resolvedProperties?: ResolvedProperties;
          workingFilePath?: string;
          stateRoot?: string;
          secretEnvironment?: Readonly<Record<string, string>>;
        }
      | undefined,
    workspaceRoot: string | undefined,
    extensionPath: string,
    getMcpConfigArgs: (
      mcpServerPath: string | undefined,
      workspaceRoot: string,
      workingFilePath?: string,
      additionalEnv?: Record<string, string>,
      userServers?: McpServerConfig[],
      stateRoot?: string,
      secretEnvironment?: Readonly<Record<string, string>>
    ) => Promise<string[] | null>
  ): Promise<string[]> {
    const preparation = await CliProviderUtils.planMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      async (
        mcpServerPath,
        resolvedWorkspaceRoot,
        workingFilePath,
        additionalEnv,
        userServers,
        stateRoot,
        secretEnvironment
      ) => ({
        cliArgs:
          (await getMcpConfigArgs(
            mcpServerPath,
            resolvedWorkspaceRoot,
            workingFilePath,
            additionalEnv,
            userServers,
            stateRoot,
            secretEnvironment
          )) ?? [],
        mutations: [],
        diagnostics: [],
      })
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  /**
   * Resolve the shared MCP decision without applying the provider's deferred
   * mutation.  Execution-plan assembly uses this method so preview and launch
   * consume the same provider preparation result.
   */
  static async planMcpConfigBlock(
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: unknown[];
          filePath?: string;
          resolvedProperties?: ResolvedProperties;
          workingFilePath?: string;
          stateRoot?: string;
          secretEnvironment?: Readonly<Record<string, string>>;
        }
      | undefined,
    workspaceRoot: string | undefined,
    extensionPath: string,
    planMcpConfigArgs: (
      mcpServerPath: string | undefined,
      workspaceRoot: string,
      workingFilePath?: string,
      additionalEnv?: Record<string, string>,
      userServers?: McpServerConfig[],
      stateRoot?: string,
      secretEnvironment?: Readonly<Record<string, string>>
    ) => Promise<CliProviderPreparation>
  ): Promise<CliProviderPreparation> {
    if (!workflowContext || !workspaceRoot) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }

    const mcpServers = workflowContext.resolvedProperties?.mcpServers;
    const includesCtrlYokeServer = workflowContext.resolvedProperties
      ? hasCtrlYokeServer(workflowContext.resolvedProperties)
      : false;
    const userServers = (mcpServers ?? []).filter(
      (server): server is McpServerConfig =>
        typeof server === "object" &&
        server !== null &&
        server.id !== MCP_SERVER_IDS.CTRLYOKE
    );

    if (!includesCtrlYokeServer && userServers.length === 0) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }

    const mcpServerPath = includesCtrlYokeServer
      ? path.join(extensionPath, "out/mcp-server.js")
      : undefined;
    const additionalEnv: Record<string, string> | undefined =
      includesCtrlYokeServer
      ? (() => {
          const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
          const env = {
            CTRLYOKE_MAX_QUEUE_SIZE: dynamicQueueConfig.maxQueueSize.toString(),
            CTRLYOKE_UNLIMITED_MODE:
              dynamicQueueConfig.unlimitedMode.toString(),
            CTRLYOKE_DIAGNOSTIC_LOGS:
              ConfigurationUtils.isDiagnosticLogsEnabled().toString(),
          };
          if (isRunHistoryLocationInitialized()) {
            Object.assign(env, {
              CTRLYOKE_HOME: ctrlyokeStateHome(),
              CTRLYOKE_RUN_HISTORY_LOCATION: getFrozenRunHistoryLocation(),
            });
          }
          return env;
        })()
      : undefined;

    return planMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workflowContext.workingFilePath,
      additionalEnv,
      userServers.length > 0 ? userServers : undefined,
      workflowContext.stateRoot,
      workflowContext.secretEnvironment
    );
  }

  /**
   * Build a process environment object for spawning CLI harness processes.
   *
   * Single source of truth for env construction: spreads `process.env` and
   * conditionally injects `CTRLYOKE_DIAGNOSTIC_LOGS` when diagnostic
   * logging is enabled. Providers may modify the returned object before use
   * (e.g. Claude deletes `CLAUDECODE`).
   */
  static buildProcessEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
      env.CTRLYOKE_DIAGNOSTIC_LOGS = "true";
    }
    return env;
  }

  // ============================================================
  // SETTINGS.JSON MCP HELPERS (Qwen Code CLI / Antigravity CLI)
  // ============================================================

  /**
   * Build MCP server entries for settings.json-style MCP config files.
   *
   * Both CLIs auto-discover MCP from `.{tool}/settings.json` using the `mcpServers` key.
   * Config per server: { command: string, args?: string[], env?: Record<string, string>, trust?: boolean }
   *
   * @param mcpServerPath ctrlyoke MCP server path (undefined if ctrlyoke server not requested)
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @param additionalEnv Extra environment variables for the ctrlyoke MCP server
   * @param userServers User-defined MCP server configurations
   * @returns Object of server entries keyed by server name
   */
  static buildSettingsJsonMcpEntries(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    options?: SettingsJsonMcpEntryOptions,
    stateRoot?: string,
    secretOptions?: McpSecretConfigOptions
  ): Record<string, unknown> {
    // Defaults reproduce Qwen semantics; Antigravity overrides the
    // remote-URL key (serverUrl) and drops the type/trust fields its schema
    // doesn't recognize.
    const remoteUrlKey = options?.remoteUrlKey ?? "url";
    const includeRemoteType = options?.includeRemoteType ?? true;
    const includeTrust = options?.includeTrust ?? true;

    const mcpServers: Record<string, unknown> = {};

    // ctrlyoke server (when included in mcpServers list)
    if (mcpServerPath) {
      const normalizedServerPath = mcpServerPath.replace(/\\/g, "/");
      const normalizedWorkspace = (stateRoot ?? workspaceRoot).replace(
        /\\/g,
        "/"
      );

      const env: Record<string, string> = {
        CTRLYOKE_WORKSPACE: normalizedWorkspace,
      };
      if (workingFilePath) {
        env["CTRLYOKE_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
      }
      if (additionalEnv) {
        Object.assign(env, additionalEnv);
      }

      const ctrlyokeEntry: Record<string, unknown> = {
        command: "node",
        args: [normalizedServerPath],
        env,
      };
      if (includeTrust) {
        // ctrlyoke is the orchestrator — auto-approve its tools
        ctrlyokeEntry.trust = true;
      }
      mcpServers[MCP_SERVER_IDS.CTRLYOKE] = ctrlyokeEntry;
    }

    // User-defined MCP servers
    if (userServers) {
      for (const server of userServers) {
        const entry: Record<string, unknown> = {};
        if (server.url) {
          entry[remoteUrlKey] = server.url;
          if (includeRemoteType) {
            entry.type = server.transport ?? MCP_TRANSPORTS.STREAMABLE_HTTP;
          }
          if (server.headers) {
            entry.headers = transformMcpSecretMap(
              server.headers,
              secretOptions
            );
          }
        } else {
          entry.command = server.command;
          if (server.args) entry.args = server.args;
          if (server.env) {
            entry.env = transformMcpSecretMap(server.env, secretOptions);
          }
        }
        if (includeTrust && server.autoApprove === true) {
          entry.trust = true;
        }
        mcpServers[server.id] = entry;
      }
    }

    return mcpServers;
  }
}
