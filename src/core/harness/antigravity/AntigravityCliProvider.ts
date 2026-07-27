import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { createHash } from "crypto";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { HARNESS_IDS, type HookEvent } from "../../../types/DashboardConstants";
import type {
  McpServerConfig,
  PromptStep,
  UserHookConfig,
  WorkflowStep,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { Log } from "../../../utils/Log";
import { parseArgString } from "../../../utils/CliArgParser";
import { withFileLock } from "../../../utils/FileLockUtils";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { AntigravityNotificationMonitor } from "./AntigravityNotificationMonitor";
import { AntigravityToolPermissionMapper } from "./AntigravityToolPermissionMapper";
import { AntigravityLogParser } from "./AntigravityLogParser";

const ANTIGRAVITY_MIN_VERSION = "1.0.15";

type AntigravityHookGroup = Record<
  "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop",
  unknown[] | null
>;

export class AntigravityCliProvider implements ICliProvider {
  /**
   * Shared singleton tracker for parallel-safe MCP management. Unlike Qwen
   * (which uses `.{tool}/settings.json`), agy auto-discovers MCP from the
   * workspace `.agents/mcp_config.json` (a bare `{ mcpServers }`
   * object), with `~/.gemini/config/mcp_config.json` as the user-level file.
   */
  private static readonly mcpTracker = SettingsJsonMcpTracker.getInstance(
    "antigravity",
    {
      projectConfigPath: (workspaceRoot: string) =>
        path.join(workspaceRoot, ".agents", "mcp_config.json"),
      userConfigPath: () =>
        path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
    }
  );

  readonly config: HarnessConfig = {
    name: "agy",
    harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
    displayName: "Antigravity CLI",
    terminalName: "Antigravity",
    installHint: "Install via: npm install -g @google/antigravity-cli",
    shouldStreamHeadlessOutput: true,
    usesInteractiveNotificationMonitor: true,
  };

  readonly notificationMonitor: INotificationMonitor =
    new AntigravityNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new AntigravityToolPermissionMapper();
  readonly logParser = new AntigravityLogParser();
  readonly headlessSource = "log" as const;

  shouldRetainWorkflowArtifactsForReuse(): boolean {
    // Injected turns do not rebuild CLI arguments or hook registration, and
    // agy re-reads its global hook file when firing completion events.
    return true;
  }

  async buildCliArgs(
    _prompt: PromptStep,
    _isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
    },
    workspaceRoots?: readonly string[]
  ): Promise<string[]> {
    const args: string[] = [];
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (experimental — see isMcpEnabled). agy auto-discovers
    // .agents/mcp_config.json, so no CLI arg is returned; this just writes the
    // file via the tracker when enabled.
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.getMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers
        )
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
    }

    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    if (
      CliProviderUtils.shouldResumeSession(resolvedResumeSession, sessionId)
    ) {
      args.push("--conversation", sessionId!);
    }

    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots
      );
      workspaceDirs.forEach((dir) => args.push("--add-dir", dir));
    }

    const additionalArgs = workflowContext?.resolvedProperties?.additionalArgs;
    if (additionalArgs) {
      args.push(...parseArgString(additionalArgs));
    }

    return args;
  }

  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return ["--print", prompt, ...baseArgs];
  }

  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["--prompt-interactive", promptText, ...baseArgs];
  }

  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  buildPermissionArgs(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): string[] {
    if (toolPermissions === null) {
      return [];
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.buildArgs(config);
  }

  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-antigravity-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot,
      userHooks,
      [
        ...new Set<HookEvent>([
          "sessionStart",
          "stop",
          ...enabledNotificationHookEvents,
        ]),
      ]
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected Antigravity hook config type");
    }

    await this.writeGlobalHooksConfig(
      workflowKey,
      hookConfig.config as Record<string, AntigravityHookGroup>
    );
    return [];
  }

  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    if (
      (userHooks?.length ?? 0) === 0 &&
      enabledNotificationHookEvents.length === 0
    ) {
      return [];
    }

    const hookConfig = this.notificationMonitor.buildHookConfig(
      path.join(
        extensionPath,
        "out",
        "scripts",
        "ctrlyoke-antigravity-hook.js"
      ),
      this.notificationMonitor.getNotificationDirectory(workspaceRoot),
      workspaceRoot,
      userHooks,
      enabledNotificationHookEvents
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected Antigravity hook config type");
    }

    await this.writeGlobalHooksConfig(
      workflowKey,
      hookConfig.config as Record<string, AntigravityHookGroup>
    );
    return [];
  }

  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void> {
    const workflowKey = workingFilePath ?? workspaceRoot;

    // Remove this workflow's MCP servers from .agents/mcp_config.json
    // (ref-counted — only removed when no other workflow needs them). Uses the
    // same workflow key as getMcpConfigArgs. Safe to call even when MCP was
    // never registered.
    await AntigravityCliProvider.mcpTracker.unregisterWorkflow(
      workflowKey,
      workspaceRoot
    );

    // Remove this workflow's hook group from the global hooks.json.
    const groupName = this.getHookGroupName(workflowKey);
    const hooksPath = this.getGlobalHooksPath();

    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      if (!(groupName in current)) {
        return;
      }
      delete current[groupName];
      await this.writeHooksFile(current);
    });
  }

  async checkAvailability(): Promise<boolean> {
    const version = await this.getVersion();
    return version
      ? this.compareVersions(version, ANTIGRAVITY_MIN_VERSION) >= 0
      : false;
  }

  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("agy --version", {
      parseVersion: (stdout) => {
        const match = stdout.match(/(\d+\.\d+\.\d+)/);
        return match?.[1];
      },
    });
  }

  async extractSessionIdFromLogs(
    promptText: string,
    startTime: Date,
    workspaceRoot?: string
  ): Promise<string | undefined> {
    if (workspaceRoot) {
      const cachedSessionId =
        await this.logParser.readSessionIdFromLastConversations(workspaceRoot);
      if (cachedSessionId) {
        return cachedSessionId;
      }
    }

    // Fallback: the cache can miss under parallel workflows or if it hasn't
    // flushed yet, so scrape the CLI log agy just wrote for this run.
    const logPath = await this.logParser.discoverSessionLog(
      promptText,
      startTime
    );
    if (!logPath) {
      return undefined;
    }
    return await this.logParser.extractSessionIdFromLogPath(logPath);
  }

  /**
   * Register MCP servers by writing `.agents/mcp_config.json` (via the shared
   * tracker for parallel-safe ref-counting). agy auto-discovers this file, so
   * no CLI arg is needed — returns `[]` on success.
   *
   * agy has no `--allowed-mcp-server-names` flag, so no per-prompt server
   * scoping is applied — parallel workflows in one workspace share the file's
   * servers.
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return null;
    }

    try {
      const mcpEntries = CliProviderUtils.buildSettingsJsonMcpEntries(
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        userServers,
        // agy's mcp_config.json uses serverUrl for remote servers and does not
        // recognize the type/trust fields.
        {
          remoteUrlKey: "serverUrl",
          includeRemoteType: false,
          includeTrust: false,
        }
      );

      const workflowKey = workingFilePath ?? workspaceRoot;
      await AntigravityCliProvider.mcpTracker.registerServers(
        workflowKey,
        workspaceRoot,
        mcpEntries
      );
      Log.debug(
        "🔧 Antigravity MCP servers written to .agents/mcp_config.json"
      );
      return [];
    } catch (error) {
      Log.warn(`Failed to register Antigravity MCP servers: ${error}`);
      return null;
    }
  }

  getMcpConfigFilePath(): null {
    // MCP config is merged into .agents/mcp_config.json (auto-discovered, not a
    // CLI arg). Cleanup is handled by cleanupWorkspaceArtifacts via the tracker.
    return null;
  }

  private validateAndGetModel(requestedModel?: string): string | undefined {
    if (!requestedModel || requestedModel === MODEL_NONE) {
      return undefined;
    }
    return requestedModel;
  }

  private getGlobalHooksPath(): string {
    return path.join(os.homedir(), ".gemini", "config", "hooks.json");
  }

  private getHookGroupName(workflowKey: string): string {
    const hash = createHash("sha1")
      .update(workflowKey)
      .digest("hex")
      .slice(0, 12);
    return `ctrlyoke-${hash}`;
  }

  private async writeGlobalHooksConfig(
    workflowKey: string,
    config: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    const groupSpec = Object.values(config)[0];
    if (!groupSpec) {
      return;
    }
    const groupName = this.getHookGroupName(workflowKey);

    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      current[groupName] = groupSpec;
      await this.writeHooksFile(current);
    });
  }

  private async readHooksFile(): Promise<Record<string, AntigravityHookGroup>> {
    const hooksPath = this.getGlobalHooksPath();
    try {
      const content = await fs.readFile(hooksPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, AntigravityHookGroup>;
      }
    } catch {
      // Ignore missing/invalid files and recreate a minimal object.
    }
    return {};
  }

  private async writeHooksFile(
    hooks: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2), "utf8");
  }

  private compareVersions(a: string, b: string): number {
    const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < length; i += 1) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }
}
