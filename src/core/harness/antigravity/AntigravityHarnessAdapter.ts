import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import {
  UnsupportedSandboxMapper,
  unsupportedSandboxCapabilities,
} from "../shared/SandboxCapabilities";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { createHash, randomUUID } from "crypto";
import {
  IHarnessAdapter,
  HarnessConfig,
  type CliExecutionSidecarDeps,
} from "../shared/interfaces/IHarnessAdapter";
import { installCommandFor } from "../shared/HarnessInstallCommand";
import {
  HOOK_CONFIG_TYPES,
  INotificationMonitor,
} from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { CliParseUtils } from "../shared/CliParseUtils";
import {
  ANTIGRAVITY_STREAM_JSON_EVENTS,
  ANTIGRAVITY_STREAM_JSON_RESULT_STATUSES,
} from "./AntigravityProtocolConstants";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  STATUS_LINE_HARNESS_IDS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  type HookEvent,
  NODE_ERROR_CODES,
} from "../../../types/DashboardConstants";
import type {
  McpServerConfig,
  PromptFile,
  PromptStep,
  UserHookConfig,
  WorkflowStep,
} from "../../../types/CtrlYokeTypes";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  capabilitySuiteVerification,
  getCompatibilityDiagnosticMessage,
  getCompatibilityDiagnosticRemediation,
  type CompatibilityDiagnostic,
  type HarnessCapabilityFacts,
} from "../../../types/CompatibilityTypes";
import { normalizeAntigravityMcpServerId } from "../../../utils/ToolPermissionUtils";
import type { ResolvedProperties } from "../../../utils/SettingsPropertyResolver";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { HarnessAdapterUtils } from "../shared/HarnessAdapterUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import { HarnessSettingsJsonStore } from "../shared/HarnessSettingsJsonStore";
import {
  StatuslineManager,
  type StatuslineInstallResult,
} from "../shared/StatuslineManager";
import { ProviderStatuslineRegistration } from "../shared/ProviderStatuslineRegistration";
import { Log } from "../../../utils/Log";
import { parseArgString } from "../../../utils/CliArgParser";
import { withFileLock } from "../../../utils/FileLockUtils";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { writeFileAtomic } from "../../../utils/AtomicFileUtils";
import {
  generateOwnerToken,
  isProcessAlive,
} from "../../../utils/LockSafetyPrimitives";
import { AntigravityNotificationMonitor } from "./AntigravityNotificationMonitor";
import {
  AntigravityToolPermissionMapper,
  getAntigravityUserSettingsPath,
  parseAntigravityUserPermissionRules,
  type AntigravityUserPermissionRules,
} from "./AntigravityToolPermissionMapper";
import { AntigravityLogParser } from "./AntigravityLogParser";
import { AntigravityStatuslineSidecar } from "./AntigravityStatuslineSidecar";
import { AntigravityStreamJsonUsageAccumulator } from "./AntigravityStreamJsonUsage";
import {
  applyPreparedMutations,
  type HarnessAdapterPreparation,
} from "../shared/interfaces/PreparedMutation";
import { type SessionProbeResult } from "../../../types/DashboardConstants";
import { getErrorMessage, hasErrnoCode } from "../../../utils/ErrorUtils";

const ANTIGRAVITY_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "manual",
    reference:
      "dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md#translating-patterns",
    basis: "cli-version",
    verifiedVersions: [">=1.4.10"],
  },
} as const;

const ANTIGRAVITY_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: capabilitySuiteVerification([">=1.4.4"]),
} as const;

type AntigravityHookGroup = Record<
  "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop",
  unknown[] | null
>;

interface AntigravityHookOwner {
  pid: number;
  ownerToken: string;
  workspaceRoot: string;
  writtenAt: number;
}

type AntigravityHookOwners = Record<string, AntigravityHookOwner>;

export class AntigravityHarnessAdapter implements IHarnessAdapter {
  private readonly hookOwnerToken = generateOwnerToken();
  private static readonly CLI_COMMAND = "agy";
  static readonly CLI_VERSION_COMMAND = `${AntigravityHarnessAdapter.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${AntigravityHarnessAdapter.CLI_COMMAND} --help`;

  /**
   * Shared singleton tracker for parallel-safe MCP management. Unlike Qwen
   * (which uses `.{tool}/settings.json`), agy auto-discovers MCP from the
   * workspace `.agents/mcp_config.json` (a bare `{ mcpServers }`
   * object), with `~/.gemini/config/mcp_config.json` as the user-level file.
   */
  private static readonly mcpTracker = HarnessSettingsJsonStore.getInstance(
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
  private static readonly statuslineManager =
    StatuslineManager.forStatusLineHarness(STATUS_LINE_HARNESS_IDS.ANTIGRAVITY);

  /** Best-effort startup recovery for groups left by killed processes. */
  static async sweepOrphanedGlobalHooks(): Promise<void> {
    try {
      await new AntigravityHarnessAdapter().sweepGlobalHooks();
    } catch (error) {
      Log.warn(
        `[AntigravityHarnessAdapter] Failed to sweep orphaned global hooks: ${error}`
      );
    }
  }

  readonly config: HarnessConfig = {
    name: "agy",
    harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
    displayName: "Antigravity CLI",
    terminalName: "Antigravity",
    installCommand: installCommandFor({
      posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      windows: "irm https://antigravity.google/cli/install.ps1 | iex",
    }),
    versionPolicy: {
      // agy is not on npm; `agy changelog` and the google-antigravity/
      // antigravity-cli GitHub releases give its history. 1.4.10 added
      // `--settings`, which delivers per-run permission rules; 1.2.6 removed
      // the 5-minute default `--print` timeout (ctrlyoke passes none, so longer
      // headless steps were cut short); 1.1.20 stopped benign tool errors
      // failing `-p` runs; 1.1.10 made `Stop` hooks and `--model` work.
      minimum: "1.4.10",
      testedWith: "1.5.7",
      updateCommand: "agy update",
    },
    shouldStreamHeadlessOutput: true,
    usesInteractiveNotificationMonitor: true,
  };

  readonly notificationMonitor: INotificationMonitor =
    new AntigravityNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new AntigravityToolPermissionMapper();
  readonly sandboxMapper = new UnsupportedSandboxMapper(
    HARNESS_IDS.ANTIGRAVITY_CLI,
    unsupportedSandboxCapabilities(SANDBOX_CAVEAT_CODE.ANTIGRAVITY_UNUSABLE)
  );
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      sandbox: this.sandboxMapper.capabilities,
      hooks: AntigravityNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: ANTIGRAVITY_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: ANTIGRAVITY_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly logParser = new AntigravityLogParser();

  /**
   * Some agy models resolve a relative `.ctrlyoke/temp/...` reference against
   * the wrong folder (gpt-oss-120b dropped the working directory's last path
   * segment), then search the disk for the file and never reach the prompt.
   * An absolute path leaves nothing to resolve, as for OpenCode.
   */
  readonly requiresAbsoluteFileReferences = true;

  probeResumableSession(
    sessionId: string,
    _workspaceRoot: string
  ): SessionProbeResult {
    return this.logParser.probeSessionId(sessionId);
  }
  readonly headlessSource = HEADLESS_SOURCE_MODES.LOG;
  private readonly streamJsonUsage =
    new AntigravityStreamJsonUsageAccumulator();

  private readonly statuslineRegistration = new ProviderStatuslineRegistration({
    manager: AntigravityHarnessAdapter.statuslineManager,
    logPrefix: "AntigravityHarnessAdapter",
    harnessLabel: "Antigravity",
    snapshotPrefix: "agy",
    tokenEnvironmentVariable: "CTRLYOKE_AGY_STATUSLINE_TOKEN",
    directoryEnvironmentVariable: "CTRLYOKE_AGY_STATUSLINE_DIR",
    quoteNodeCommand: CliNotificationMonitor.shouldQuoteNodeCommand(
      HARNESS_IDS.ANTIGRAVITY_CLI
    ),
  });
  /** Permission settings stay alive until their agy process or PTY exits. */
  private readonly permissionSettingsPaths = new Set<string>();
  /** Sidecar for the current prompt, retained for final snapshot consumers. */
  private statusLineSidecar: AntigravityStatuslineSidecar | undefined;

  consumeStatuslineInstallResult(): StatuslineInstallResult | undefined {
    return this.statuslineRegistration.consumeInstallResult();
  }

  shouldRetainWorkflowArtifactsForReuse(): boolean {
    // Turns sent to a running terminal do not rebuild CLI arguments or hook registration, and
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
      stateRoot?: string;
      secretEnvironment?: Readonly<Record<string, string>>;
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<string[]> {
    const preparation = await this.planCliArgs(
      prompt,
      isInteractive,
      extensionPath,
      workspaceRoot,
      sessionId,
      workflowContext,
      workspaceRoots,
      approvedExternalRoots
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
      stateRoot?: string;
      secretEnvironment?: Readonly<Record<string, string>>;
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<HarnessAdapterPreparation> {
    const statusLineToken = randomUUID();

    const args: string[] = [];
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (experimental — see isMcpEnabled). agy auto-discovers
    // .agents/mcp_config.json, so no CLI arg is returned; this just writes the
    // file via the tracker when enabled.
    const mcpPreparation = await HarnessAdapterUtils.planMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.planMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers,
          workflowContext?.stateRoot,
          workflowContext?.secretEnvironment
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

    const shouldResume = HarnessAdapterUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("--conversation", sessionId!);
      Log.info(`[AntigravityHarnessAdapter] Resuming session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.warn(
        "[AntigravityHarnessAdapter] Resume requested but no session ID available"
      );
    } else {
      Log.info("[AntigravityHarnessAdapter] Starting new session");
    }

    if (workspaceRoot) {
      const workspaceDirs = HarnessAdapterUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots,
        approvedExternalRoots,
        workflowContext
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
            this.statuslineRegistration.reset(statusLineToken);
            this.statusLineSidecar = undefined;
            this.streamJsonUsage.reset();
            this.logParser.setStatuslineSnapshot();
            this.logParser.setStreamJsonUsage();
            if (
              workspaceRoot &&
              ConfigurationUtils.getStatusLineHarnessSettings(
                STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
              ).enabled
            ) {
              await this.statuslineRegistration.register(
                extensionPath,
                workspaceRoot
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

  /**
   * Extract Antigravity's session ID from a complete headless JSONL record.
   * HeadlessLogTail accumulates transport chunks and only calls this hook with
   * complete records, plus one flush of an unterminated tail at process exit,
   * so this hook stays pure and stateless.
   */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const event = CliParseUtils.parseJsonLines(chunk).find(
      (candidate) =>
        candidate.event === ANTIGRAVITY_STREAM_JSON_EVENTS.INIT &&
        typeof candidate.conversation_id === "string" &&
        candidate.conversation_id.length > 0
    );
    return event?.conversation_id as string | undefined;
  }

  /**
   * agy reports a failed API turn only in the terminal stream-json `result`
   * (`status: "ERROR"` with the text in `error`, then exit 3); it writes no
   * transcript error entry for it (agy 1.5.3 capture in
   * src/test/fixtures/harness-errors/antigravity/).
   */
  extractErrorFromStdout(stdout: string): string | undefined {
    const result = CliParseUtils.parseJsonLines(stdout)
      .reverse()
      .find((event) => event.event === ANTIGRAVITY_STREAM_JSON_EVENTS.RESULT)
      ?.result as { status?: unknown; error?: unknown } | undefined;
    if (
      result?.status !== ANTIGRAVITY_STREAM_JSON_RESULT_STATUSES.ERROR ||
      typeof result.error !== "string"
    ) {
      return undefined;
    }
    return result.error.trim() || undefined;
  }

  /** Observe stream-json usage without adding a second event-mapping path. */
  observeHeadlessStdout(chunk: string): void {
    if (
      !ConfigurationUtils.getStatusLineHarnessSettings(
        STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
      ).enabled
    ) {
      this.streamJsonUsage.reset();
      this.logParser.setStreamJsonUsage();
      return;
    }

    this.streamJsonUsage.ingest(chunk);
    this.logParser.setStreamJsonUsage(this.streamJsonUsage.getSnapshot());
  }

  /** Parse a terminal stream-json record that arrived without a newline. */
  finishHeadlessStdout(): void {
    this.streamJsonUsage.flush();
    this.logParser.setStreamJsonUsage(this.streamJsonUsage.getSnapshot());
  }

  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["--prompt-interactive", promptText, ...baseArgs];
  }

  startExecutionSidecar(
    deps: CliExecutionSidecarDeps
  ): AntigravityStatuslineSidecar | undefined {
    const snapshotPath = this.statuslineRegistration.snapshotPath;
    if (!snapshotPath) {
      return undefined;
    }

    this.statusLineSidecar = new AntigravityStatuslineSidecar({
      snapshotPath,
      model: deps.model,
      parser: this.logParser,
      onContextWindowUpdate: deps.onContextWindowUpdate,
      onProviderUsageUpdate: deps.onProviderUsageUpdate,
      onSnapshot: (snapshot) => this.logParser.setStatuslineSnapshot(snapshot),
    });
    return this.statusLineSidecar;
  }

  /** Latest valid statusline payload for the current prompt, if one arrived. */
  getLatestStatuslineSnapshot() {
    return this.statusLineSidecar?.getLatestSnapshot();
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return this.statuslineRegistration.buildSpawnEnv();
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...HarnessAdapterUtils.buildProcessEnv(),
      ...this.statuslineRegistration.buildSpawnEnv(),
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

    Log.trace(
      `[AntigravityHarnessAdapter] Context window from statusline: ${usage.contextWindowUsedTokens}/${usage.contextWindowSize} tokens`
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
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    if (config === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    // The mapper picks version-specific settings keys (agy 1.5.7's agentMode).
    const application = await this.toolPermissionMapper.prepare(config, {
      ...context,
      cliVersion: context.cliVersion ?? (await this.getVersion()),
    });
    for (const mutation of application.mutations ?? []) {
      if (mutation.path) this.permissionSettingsPaths.add(mutation.path);
    }
    return application;
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
  ): Promise<HarnessAdapterPreparation> {
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
    if (hookConfig.type !== HOOK_CONFIG_TYPES.JSON) {
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
            await this.writeGlobalHooksConfig(
              workflowKey,
              workspaceRoot,
              config
            );
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
  ): Promise<HarnessAdapterPreparation> {
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
    if (hookConfig.type !== HOOK_CONFIG_TYPES.JSON) {
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
            await this.writeGlobalHooksConfig(
              workflowKey,
              workspaceRoot,
              config
            );
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
    // same workflow key as planMcpConfigArgs. Safe to call even when MCP was
    // never registered.
    await AntigravityHarnessAdapter.mcpTracker.unregisterWorkflow(
      workflowKey,
      workspaceRoot
    );

    // Remove this workflow's hook group from the global hooks.json.
    const groupName = this.getHookGroupName(workflowKey);
    const hooksPath = this.getGlobalHooksPath();

    try {
      await withFileLock(hooksPath, async () => {
        const current = await this.readHooksFile();
        const owners = await this.readHookOwners();
        let changed = false;
        if (groupName in current) {
          delete current[groupName];
          changed = true;
        }
        if (groupName in owners) {
          delete owners[groupName];
          await this.writeHookOwners(owners);
        }
        if (!changed) return;
        await this.writeHooksFile(current);
      });
    } catch (error) {
      Log.warn(
        `[AntigravityHarnessAdapter] Failed to clean up Antigravity hooks in ${hooksPath}: ${error}`
      );
    }
  }

  getAdditionalCleanupFilePaths(_workspaceRoot: string): string[] {
    return [
      ...this.statuslineRegistration.snapshotPaths,
      ...this.permissionSettingsPaths,
    ];
  }

  getLiveProcessFilePaths(): string[] {
    return [...this.permissionSettingsPaths];
  }

  getExternalPermissionIdentity(): string {
    let rules: AntigravityUserPermissionRules = { allow: [], deny: [] };
    try {
      rules = parseAntigravityUserPermissionRules(
        fsSync.readFileSync(getAntigravityUserSettingsPath(), "utf-8")
      );
    } catch {
      // A missing file means no user rules, exactly as the mapper treats it.
    }
    return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
  }

  /**
   * `agy` is available when it reports a version. The version floor itself is
   * enforced by the shared `config.versionPolicy` check in CliIntegration.
   */
  async checkAvailability(): Promise<boolean> {
    return (await this.getVersion()) !== undefined;
  }

  async getVersion(): Promise<string | undefined> {
    return HarnessAdapterUtils.getCliVersion(
      AntigravityHarnessAdapter.CLI_VERSION_COMMAND,
      {
        parseVersion: (stdout) => {
          const match = stdout.match(/(\d+\.\d+\.\d+)/);
          return match?.[1];
        },
      }
    );
  }

  async extractSessionIdFromLogs(
    promptText: string,
    startTime: Date,
    workspaceRoot?: string
  ): Promise<string | undefined> {
    if (this.statuslineRegistration.enabled) {
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
   * no CLI arg is needed.
   *
   * agy has no `--allowed-mcp-server-names` flag, so no per-prompt server
   * scoping is applied — parallel workflows in one workspace share the file's
   * servers.
   */
  async planMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<HarnessAdapterPreparation> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }

    try {
      const diagnostics = this.createMcpServerIdDiagnostics(
        userServers ?? [],
        Boolean(mcpServerPath)
      );
      const normalizedUserServers = (userServers ?? []).map((server) => ({
        ...server,
        id: normalizeAntigravityMcpServerId(server.id),
      }));
      const mcpEntries = HarnessAdapterUtils.buildSettingsJsonMcpEntries(
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        normalizedUserServers,
        // agy's mcp_config.json uses serverUrl for remote servers and does not
        // recognize the type/trust fields.
        {
          remoteUrlKey: "serverUrl",
          includeRemoteType: false,
          includeTrust: false,
        },
        stateRoot,
        HarnessAdapterUtils.createMcpSecretConfigOptions(
          undefined,
          secretEnvironment
        )
      );

      const hasSecretMcpValues = (userServers ?? []).some((server) =>
        Object.values({
          ...(server.env ?? {}),
          ...(server.headers ?? {}),
        }).some((value) => /\$\{secret:[^}]+\}/u.test(value))
      );

      const workflowKey = workingFilePath ?? workspaceRoot;
      return {
        cliArgs: [],
        mutations: [
          {
            path: path.join(workspaceRoot, ".agents", "mcp_config.json"),
            description: "Register Antigravity MCP servers",
            apply: async () => {
              await AntigravityHarnessAdapter.mcpTracker.registerServers(
                workflowKey,
                workspaceRoot,
                mcpEntries,
                hasSecretMcpValues ? { fileMode: 0o600 } : undefined
              );
              Log.debug(
                "[AntigravityHarnessAdapter] Antigravity MCP servers written to .agents/mcp_config.json"
              );
            },
          },
        ],
        diagnostics,
      };
    } catch (error) {
      Log.warn(
        `[AntigravityHarnessAdapter] Failed to register Antigravity MCP servers: ${error}`
      );
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }
  }

  private createMcpServerIdDiagnostics(
    userServers: readonly McpServerConfig[],
    includesCtrlyoke: boolean
  ): CompatibilityDiagnostic[] {
    const diagnostics: CompatibilityDiagnostic[] = [];
    const serverIds = [
      ...(includesCtrlyoke ? ["ctrlyoke"] : []),
      ...userServers.map((server) => server.id),
    ];
    const normalizedIds = new Map<string, string[]>();
    for (const id of serverIds) {
      const normalizedId = normalizeAntigravityMcpServerId(id);
      normalizedIds.set(normalizedId, [
        ...(normalizedIds.get(normalizedId) ?? []),
        id,
      ]);
      if (normalizedId !== id) {
        diagnostics.push(
          this.createMcpDiagnostic(
            COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_SANITIZED,
            COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO
          )
        );
      }
    }
    for (const ids of normalizedIds.values()) {
      if (ids.length > 1) {
        diagnostics.push(
          this.createMcpDiagnostic(
            COMPATIBILITY_DIAGNOSTIC_CODES.MCP_SERVER_ID_COLLISION,
            COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
          )
        );
      }
    }
    for (const server of userServers) {
      const normalizedId = normalizeAntigravityMcpServerId(server.id);
      const serverToolLists = server as McpServerConfig & {
        allowedTools?: string[];
      };
      const listedToolNames = [
        ...(serverToolLists.allowedTools ?? []),
        ...(server.deniedTools ?? []),
      ];
      if (
        listedToolNames.some(
          (toolName) =>
            !/^[A-Za-z0-9_-]+$/u.test(toolName) ||
            `mcp_${normalizedId}_${toolName}`.length > 64
        )
      ) {
        diagnostics.push(
          this.createMcpDiagnostic(
            COMPATIBILITY_DIAGNOSTIC_CODES.MCP_TOOL_NAME_INVALID,
            COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
          )
        );
      }
    }
    return diagnostics;
  }

  private createMcpDiagnostic(
    code: string,
    severity: CompatibilityDiagnostic["severity"]
  ): CompatibilityDiagnostic {
    return {
      code,
      severity,
      harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
      capability: "mcpServers",
      state: {
        fidelity: CAPABILITY_FIDELITIES.PARTIAL,
        mechanism: CAPABILITY_MECHANISMS.TRANSLATED_CLI,
        verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
      },
      message: getCompatibilityDiagnosticMessage(code, {
        harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
        capability: "mcpServers",
      }),
      remediation: getCompatibilityDiagnosticRemediation(code),
    };
  }

  getMcpConfigFilePath(): null {
    // MCP config is merged into .agents/mcp_config.json (auto-discovered, not a
    // CLI arg). Cleanup is handled by cleanupWorkspaceArtifacts via the tracker.
    return null;
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

  private getGlobalHookOwnersPath(): string {
    return path.join(
      path.dirname(this.getGlobalHooksPath()),
      "ctrlyoke-hooks-owners.json"
    );
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
    workspaceRoot: string,
    config: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    const groupSpec = Object.values(config)[0];
    if (!groupSpec) {
      return;
    }
    const groupName = this.getHookGroupName(workflowKey);

    // The lock file sits beside hooks.json, so its directory has to exist
    // before the lock is taken (a fresh Antigravity install has no config/).
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      const owners = await this.readHookOwners();
      this.removeOrphanedHookGroups(current, owners);
      current[groupName] = groupSpec;
      owners[groupName] = {
        pid: process.pid,
        ownerToken: this.hookOwnerToken,
        workspaceRoot,
        writtenAt: Date.now(),
      };
      await this.writeHookOwners(owners);
      await this.writeHooksFile(current);
    });
  }

  private async sweepGlobalHooks(): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      const owners = await this.readHookOwners();
      const changed = this.removeOrphanedHookGroups(current, owners);
      if (!changed) return;
      await this.writeHookOwners(owners);
      await this.writeHooksFile(current);
    });
  }

  private removeOrphanedHookGroups(
    hooks: Record<string, AntigravityHookGroup>,
    owners: AntigravityHookOwners
  ): boolean {
    let changed = false;
    for (const groupName of Object.keys(hooks)) {
      if (!groupName.startsWith("ctrlyoke-")) continue;
      const owner = owners[groupName];
      if (owner && isProcessAlive(owner.pid)) continue;
      delete hooks[groupName];
      delete owners[groupName];
      changed = true;
    }
    // Discard stale sidecar entries too, including records whose hook group
    // was removed manually by the user.
    for (const groupName of Object.keys(owners)) {
      if (!(groupName in hooks)) {
        delete owners[groupName];
        changed = true;
      }
    }
    return changed;
  }

  private async readHookOwners(): Promise<AntigravityHookOwners> {
    const ownersPath = this.getGlobalHookOwnersPath();
    let content: string;
    try {
      content = await fs.readFile(ownersPath, "utf8");
    } catch (error) {
      if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) return {};
      throw new Error(
        `Cannot safely update ${ownersPath}: ${getErrorMessage(error)}`
      );
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AntigravityHookOwners;
      }
      throw new Error("Expected a JSON object");
    } catch (error) {
      throw new Error(
        `Cannot safely update ${ownersPath}: ${getErrorMessage(error)}`
      );
    }
  }

  private async writeHookOwners(owners: AntigravityHookOwners): Promise<void> {
    const ownersPath = this.getGlobalHookOwnersPath();
    await fs.mkdir(path.dirname(ownersPath), { recursive: true });
    await writeFileAtomic(ownersPath, JSON.stringify(owners, null, 2));
  }

  private async readHooksFile(): Promise<Record<string, AntigravityHookGroup>> {
    const hooksPath = this.getGlobalHooksPath();
    let content: string;
    try {
      content = await fs.readFile(hooksPath, "utf8");
    } catch (error) {
      if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
        return {};
      }
      throw new Error(
        `Cannot safely update ${hooksPath}: ${getErrorMessage(error)}`
      );
    }

    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, AntigravityHookGroup>;
      }
      throw new Error("Expected a JSON object");
    } catch (error) {
      throw new Error(
        `Cannot safely update ${hooksPath}: ${getErrorMessage(error)}`
      );
    }
  }

  private async writeHooksFile(
    hooks: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await writeFileAtomic(hooksPath, JSON.stringify(hooks, null, 2));
  }
}
