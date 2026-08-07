import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { createHash, randomUUID } from "crypto";
import {
  ICliProvider,
  HarnessConfig,
  type CliExecutionSidecarDeps,
} from "../shared/interfaces/ICliProvider";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { HARNESS_IDS, type HookEvent } from "../../../types/DashboardConstants";
import type {
  McpServerConfig,
  PromptStep,
  UserHookConfig,
  WorkflowStep,
} from "../../../types/CtrlYokeTypes";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { Log } from "../../../utils/Log";
import { parseArgString } from "../../../utils/CliArgParser";
import { withFileLock } from "../../../utils/FileLockUtils";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { AntigravityNotificationMonitor } from "./AntigravityNotificationMonitor";
import { AntigravityToolPermissionMapper } from "./AntigravityToolPermissionMapper";
import { AntigravityLogParser } from "./AntigravityLogParser";
import { AntigravityStatuslineSidecar } from "./AntigravityStatuslineSidecar";
import { AntigravityStreamJsonUsageAccumulator } from "./AntigravityStreamJsonUsage";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
} from "../shared/interfaces/PreparedMutation";

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

  /**
   * Statusline settings are global to the Antigravity installation, unlike
   * MCP settings which are workspace-scoped. Keep a separate tracker so the
   * two leases cannot interfere with each other's files or baselines.
   */
  private static readonly statusLineTracker =
    SettingsJsonMcpTracker.getInstance("antigravity-cli-settings", {
      // Deliberately ignore workspaceRoot: agy reads this file globally.
      projectConfigPath: () =>
        path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
    });

  /** Top-level key ctrlyoke leases in agy's global settings file. */
  private static readonly STATUS_LINE_KEY = "statusLine";

  /**
   * Restore a statusline left installed by a ctrlyoke process that died before
   * releasing its lease.
   *
   * The lease's own register/unregister paths already prune dead owners, so
   * this only makes recovery happen sooner — at host startup rather than at the
   * next Antigravity run. Safe to call when no lease exists.
   */
  static async pruneOrphanedStatusLine(workspaceRoot: string): Promise<void> {
    await AntigravityCliProvider.statusLineTracker.pruneDeadOwners(
      workspaceRoot,
      AntigravityCliProvider.STATUS_LINE_KEY
    );
  }

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
  private readonly streamJsonUsage =
    new AntigravityStreamJsonUsageAccumulator();

  /** Fresh correlation token for the prompt currently being spawned. */
  private statusLineToken: string | undefined;
  /** Snapshot files created by every prompt in this workflow. */
  private readonly statusLineSnapshotPaths = new Set<string>();
  /** Workspace temp directory for the current statusline invocation. */
  private statusLineDirectory: string | undefined;
  /** Whether the current prompt successfully acquired the statusline lease. */
  private statusLineEnabledForPrompt = false;
  /** Baseline user command forwarded by the wrapper, when one existed. */
  private statusLineForwardCommand: string | undefined;
  /** Sidecar for the current prompt, retained for final snapshot consumers. */
  private statusLineSidecar: AntigravityStatuslineSidecar | undefined;

  shouldRetainWorkflowArtifactsForReuse(): boolean {
    // Injected turns do not rebuild CLI arguments or hook registration, and
    // agy re-reads its global hook file when firing completion events.
    return true;
  }

  async buildCliArgs(
    prompt: PromptStep,
    isInteractive: boolean,
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
    const preparation = await this.planCliArgs(
      prompt,
      isInteractive,
      extensionPath,
      workspaceRoot,
      sessionId,
      workflowContext,
      workspaceRoots
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planCliArgs(
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
  ): Promise<CliProviderPreparation> {
    const statusLineToken = randomUUID();

    const args: string[] = [];
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (experimental — see isMcpEnabled). agy auto-discovers
    // .agents/mcp_config.json, so no CLI arg is returned; this just writes the
    // file via the tracker when enabled.
    const mcpPreparation = await CliProviderUtils.planMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.planMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers
        )
    );
    if (
      mcpPreparation.cliArgs.length > 0 ||
      mcpPreparation.mutations.length > 0
    ) {
      args.push(...mcpPreparation.cliArgs);
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

    return {
      cliArgs: args,
      mutations: [
        {
          description: "Prepare Antigravity prompt runtime state",
          apply: async () => {
            this.statusLineToken = statusLineToken;
            this.statusLineDirectory = undefined;
            this.statusLineEnabledForPrompt = false;
            this.statusLineForwardCommand = undefined;
            this.statusLineSidecar = undefined;
            this.streamJsonUsage.reset();
            this.logParser.setStatuslineSnapshot();
            this.logParser.setStreamJsonUsage();
            if (
              workspaceRoot &&
              ConfigurationUtils.shouldTrackAntigravityStatusLine()
            ) {
              await this.registerStatusLine(
                extensionPath,
                workspaceRoot,
                workflowContext?.workingFilePath ?? workspaceRoot
              );
            }
          },
        },
        ...mcpPreparation.mutations,
      ],
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return ["--print", prompt, "--output-format", "stream-json", ...baseArgs];
  }

  /** Extract Antigravity's session ID from the headless JSONL clock stream. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as {
          event?: string;
          conversation_id?: string;
        };
        if (
          event.event === "init" &&
          typeof event.conversation_id === "string" &&
          event.conversation_id.length > 0
        ) {
          return event.conversation_id;
        }
      } catch {
        // Chunks may contain an incomplete JSONL line; the next chunk retries it.
      }
    }
    return undefined;
  }

  /** Observe stream-json usage without adding a second event-mapping path. */
  observeHeadlessStdout(chunk: string): void {
    if (!ConfigurationUtils.shouldTrackAntigravityStatusLine()) {
      this.streamJsonUsage.reset();
      this.logParser.setStreamJsonUsage();
      return;
    }

    this.streamJsonUsage.ingest(chunk);
    this.logParser.setStreamJsonUsage(this.streamJsonUsage.getSnapshot());
  }

  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["--prompt-interactive", promptText, ...baseArgs];
  }

  startExecutionSidecar(
    deps: CliExecutionSidecarDeps
  ): AntigravityStatuslineSidecar | undefined {
    if (
      !this.statusLineEnabledForPrompt ||
      !this.statusLineToken ||
      !this.statusLineDirectory
    ) {
      return undefined;
    }

    this.statusLineSidecar = new AntigravityStatuslineSidecar({
      snapshotPath: path.join(
        this.statusLineDirectory,
        `agy-statusline-${this.statusLineToken}.json`
      ),
      model: deps.model,
      parser: this.logParser,
      onContextWindowUpdate: deps.onContextWindowUpdate,
      onSnapshot: (snapshot) => this.logParser.setStatuslineSnapshot(snapshot),
    });
    return this.statusLineSidecar;
  }

  /** Latest valid statusline payload for the current prompt, if one arrived. */
  getLatestStatuslineSnapshot() {
    return this.statusLineSidecar?.getLatestSnapshot();
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return this.buildStatusLineSpawnEnv();
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      ...this.buildStatusLineSpawnEnv(),
    };
  }

  async augmentParsedOutput(
    output: UniversalCliOutput
  ): Promise<UniversalCliOutput> {
    const snapshot =
      (await this.statusLineSidecar?.readLatestSnapshot()) ??
      this.getLatestStatuslineSnapshot();
    if (!snapshot) {
      return output;
    }

    const snapshotUsage =
      this.logParser.extractTokenUsageFromStatuslineSnapshot(snapshot);
    const totalOutputTokens = this.asFiniteNumber(
      snapshot.context_window?.total_output_tokens
    );
    if (!snapshotUsage || totalOutputTokens === undefined) {
      return output;
    }

    const existingUsage = output.metadata.usage;
    const inputTokens = existingUsage?.inputTokens ?? snapshotUsage.inputTokens;
    const outputTokens = existingUsage?.outputTokens ?? totalOutputTokens;
    const usage = {
      ...existingUsage,
      inputTokens,
      outputTokens,
      totalTokens: existingUsage?.totalTokens ?? inputTokens + outputTokens,
      cachedInputTokens:
        existingUsage?.cachedInputTokens ?? snapshotUsage.cachedInputTokens,
      cacheCreatedTokens:
        existingUsage?.cacheCreatedTokens ?? snapshotUsage.cacheCreatedTokens,
      contextWindowUsedTokens:
        existingUsage?.contextWindowUsedTokens ??
        snapshotUsage.contextWindowUsedTokens,
      contextWindowSize:
        existingUsage?.contextWindowSize ?? snapshotUsage.contextWindowSize,
    };

    Log.debug(
      `[AntigravityCliProvider] Context window from statusline: ${usage.contextWindowUsedTokens}/${usage.contextWindowSize} tokens`
    );
    return {
      ...output,
      metadata: {
        ...output.metadata,
        usage,
      },
    };
  }

  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (toolPermissions === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.prepare(config, context);
  }

  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planNotificationHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
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

    const config = hookConfig.config as Record<string, AntigravityHookGroup>;
    return {
      cliArgs: [],
      mutations: [
        {
          path: this.getGlobalHooksPath(),
          intendedContent: JSON.stringify(config, null, 2),
          description: "Register Antigravity notification hooks",
          apply: async () => {
            await this.writeGlobalHooksConfig(workflowKey, config);
          },
        },
      ],
      diagnostics: [],
    };
  }

  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planHeadlessUserHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    if (
      (userHooks?.length ?? 0) === 0 &&
      enabledNotificationHookEvents.length === 0
    ) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
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

    const config = hookConfig.config as Record<string, AntigravityHookGroup>;
    return {
      cliArgs: [],
      mutations: [
        {
          path: this.getGlobalHooksPath(),
          intendedContent: JSON.stringify(config, null, 2),
          description: "Register Antigravity headless hooks",
          apply: async () => {
            await this.writeGlobalHooksConfig(workflowKey, config);
          },
        },
      ],
      diagnostics: [],
    };
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

    // Release the global statusline value lease. The tracker restores the
    // user's baseline only after the last workflow releases it.
    await AntigravityCliProvider.statusLineTracker.unregisterValueLease(
      workflowKey,
      workspaceRoot,
      AntigravityCliProvider.STATUS_LINE_KEY
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

  getAdditionalCleanupFilePaths(_workspaceRoot: string): string[] {
    return [...this.statusLineSnapshotPaths];
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
    if (this.statusLineEnabledForPrompt) {
      const snapshot = this.getLatestStatuslineSnapshot();
      const conversationId = snapshot?.conversation_id;
      const writtenAt = snapshot?._ctrlyoke?.writtenAt;

      // The token-specific sidecar is invocation-scoped, but its file can
      // survive a crashed process. Require the wrapper's write timestamp to
      // prove that this snapshot was published after this execution began.
      if (
        typeof conversationId === "string" &&
        conversationId.length > 0 &&
        typeof writtenAt === "number" &&
        Number.isFinite(writtenAt) &&
        writtenAt >= startTime.getTime()
      ) {
        return conversationId;
      }
    }

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
    const preparation = await this.planMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.mutations.length > 0 ? preparation.cliArgs : null;
  }

  async planMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<CliProviderPreparation> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
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
      return {
        cliArgs: [],
        mutations: [
          {
            path: path.join(workspaceRoot, ".agents", "mcp_config.json"),
            description: "Register Antigravity MCP servers",
            apply: async () => {
              await AntigravityCliProvider.mcpTracker.registerServers(
                workflowKey,
                workspaceRoot,
                mcpEntries
              );
              Log.debug(
                "🔧 Antigravity MCP servers written to .agents/mcp_config.json"
              );
            },
          },
        ],
        diagnostics: [],
      };
    } catch (error) {
      Log.warn(`Failed to register Antigravity MCP servers: ${error}`);
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }
  }

  getMcpConfigFilePath(): null {
    // MCP config is merged into .agents/mcp_config.json (auto-discovered, not a
    // CLI arg). Cleanup is handled by cleanupWorkspaceArtifacts via the tracker.
    return null;
  }

  private async registerStatusLine(
    extensionPath: string,
    workspaceRoot: string,
    workflowKey: string
  ): Promise<void> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-antigravity-statusline.js"
    );
    // agy's statusline runner uses the same naive, unquoted whitespace split
    // as its hook runner. Passing an empty directory and trimming the result
    // gives the exact `node <script>` command from the wrapper contract.
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      "",
      false
    ).trim();
    const snapshotDirectory = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const snapshotPath = path.join(
      snapshotDirectory,
      `agy-statusline-${this.statusLineToken}.json`
    );
    this.statusLineSnapshotPaths.add(snapshotPath);

    try {
      await AntigravityCliProvider.statusLineTracker.registerValueLease(
        workflowKey,
        workspaceRoot,
        AntigravityCliProvider.STATUS_LINE_KEY,
        { type: "command", command }
      );
      const baseline =
        AntigravityCliProvider.statusLineTracker.getValueLeaseBaseline(
          workspaceRoot,
          AntigravityCliProvider.STATUS_LINE_KEY
        );
      this.statusLineForwardCommand = this.extractStatusLineCommand(baseline);
      this.statusLineDirectory = snapshotDirectory;
      this.statusLineEnabledForPrompt = true;
    } catch (error) {
      // agy treats a broken statusline as non-fatal. Match that behavior so a
      // settings-file problem never prevents the harness itself from running.
      Log.warn(`Failed to register Antigravity statusline: ${error}`);
    }
  }

  private buildStatusLineSpawnEnv(): NodeJS.ProcessEnv {
    if (
      !this.statusLineEnabledForPrompt ||
      !this.statusLineToken ||
      !this.statusLineDirectory
    ) {
      return {};
    }

    const env: NodeJS.ProcessEnv = {
      CTRLYOKE_AGY_STATUSLINE_TOKEN: this.statusLineToken,
      CTRLYOKE_AGY_STATUSLINE_DIR: this.statusLineDirectory,
    };
    if (this.statusLineForwardCommand) {
      env.CTRLYOKE_AGY_STATUSLINE_FORWARD = this.statusLineForwardCommand;
    }
    return env;
  }

  private extractStatusLineCommand(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const command = (value as { command?: unknown }).command;
    return typeof command === "string" && command.length > 0
      ? command
      : undefined;
  }

  private asFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
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
