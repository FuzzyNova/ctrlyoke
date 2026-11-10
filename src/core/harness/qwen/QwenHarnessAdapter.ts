import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import {
  UnsupportedSandboxMapper,
  unsupportedSandboxCapabilities,
} from "../shared/SandboxCapabilities";
import {
  QWEN_EVENT_TYPES,
  QWEN_MODEL_FLAGS,
  QWEN_SANDBOX_ENV,
} from "./QwenProtocolConstants";
import {
  describeUnconfiguredQwenModel,
  readConfiguredQwenModelIds,
} from "./QwenModelProviders";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  IHarnessAdapter,
  HarnessConfig,
} from "../shared/interfaces/IHarnessAdapter";
import { installCommandFor } from "../shared/HarnessInstallCommand";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  HOOK_EVENT_NAMES,
  STATUS_LINE_HARNESS_IDS,
  TEMP_FILE_CATEGORIES,
  type TempFileCategory,
} from "../../../types/DashboardConstants";
import {
  INotificationMonitor,
  buildHookTimeoutOptions,
  HOOK_TIMEOUT_UNITS,
} from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { QwenNotificationMonitor } from "./QwenNotificationMonitor";
import {
  buildQwenSystemSettings,
  defaultQwenSystemDefaultsPath,
  defaultQwenSystemSettingsPath,
  QWEN_SYSTEM_DEFAULTS_PATH_ENV,
  QWEN_SYSTEM_SETTINGS_PATH_ENV,
  removeOrphanedProjectHooks,
} from "./QwenSystemSettings";
import { QwenToolPermissionMapper } from "./QwenToolPermissionMapper";
import { QwenLogParser } from "./QwenLogParser";
import { resolveCliModelFlag } from "../shared/CliModelSelection";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { HarnessAdapterUtils } from "../shared/HarnessAdapterUtils";
import { redactMcpConfigArgs } from "../shared/CliLauncherResolver";
import {
  StatuslineManager,
  type StatuslineInstallResult,
} from "../shared/StatuslineManager";
import { ProviderStatuslineRegistration } from "../shared/ProviderStatuslineRegistration";
import { parseArgString } from "../../../utils/CliArgParser";
import { CliParseUtils } from "../shared/CliParseUtils";
import type {
  HookEvent,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/SettingsPropertyResolver";
import {
  capabilitySuiteVerification,
  type HarnessCapabilityFacts,
} from "../../../types/CompatibilityTypes";
import {
  applyPreparedMutations,
  type HarnessAdapterPreparation,
  type PreparedMutation,
} from "../shared/interfaces/PreparedMutation";
import { type SessionProbeResult } from "../../../types/DashboardConstants";

/**
 * The model a Qwen argv requests: the value of its last `--model`/`-m` (or
 * `--model=<id>`), since `additionalArgs` come after ctrlyoke's own flag and
 * the last one wins. Undefined when the argv lets Qwen choose.
 */
export function getRequestedQwenModel(
  args: readonly string[]
): string | undefined {
  let model: string | undefined;
  args.forEach((arg, index) => {
    if (QWEN_MODEL_FLAGS.has(arg)) {
      model = args[index + 1];
      return;
    }
    const separator = arg.indexOf("=");
    if (separator > 0 && QWEN_MODEL_FLAGS.has(arg.slice(0, separator))) {
      model = arg.slice(separator + 1);
    }
  });
  return model?.trim() || undefined;
}

/**
 * Fail the launch when `model` is missing from every `modelProviders` list in
 * Qwen's settings: Qwen 0.27+ would run its default model instead, with no
 * error. Nothing is checked when no `--model` is passed or the settings list
 * no models at all; the parser then warns after the turn if Qwen still swapped
 * the model.
 */
async function assertQwenModelConfigured(
  model: string | undefined,
  workspaceRoot: string | undefined
): Promise<void> {
  if (!model) return;
  const configured = await readConfiguredQwenModelIds(workspaceRoot);
  if (configured && !configured.has(model)) {
    throw new Error(describeUnconfiguredQwenModel(model));
  }
}

const QWEN_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "behavioral-test",
    reference: "src/test/harness/inline-config.harness.test.ts",
    basis: "cli-version",
    verifiedVersions: [">=0.15.5"],
  },
} as const;

const QWEN_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: capabilitySuiteVerification([">=0.15.5"]),
} as const;

/**
 * Qwen Code CLI Harness
 *
 * Implements all Qwen Code-specific logic using composition pattern:
 * - Process exit detection (headless) + log file monitoring (interactive) for completion
 * - Stream-json stdout used as a session-ID carrier and activity clock
 * - Mode-based tool permission conversion (plan, default, auto-edit, yolo)
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - QwenNotificationMonitor: Monitors process exit and log files
 * - QwenToolPermissionMapper: Converts permissions to CLI arguments
 * - QwenLogParser: Parses log files for sessions and completion
 *
 * Qwen Code CLI features:
 * - Uses stream-json output format (NDJSON - one JSON object per line)
 * - Session ID from system init or result event
 * - Mode-based permissions (--approval-mode, -y for YOLO)
 * - Supports --resume flag for session continuation
 * - Log files in ~/.qwen/projects/<workspace>/chats/<session-id>.jsonl
 *
 * Usage:
 * ```typescript
 * const provider = new QwenHarnessAdapter();
 * const integration = new CliIntegration(provider, platform, registerWithContext);
 * ```
 */
export class QwenHarnessAdapter implements IHarnessAdapter {
  probeResumableSession(sessionId: string): SessionProbeResult {
    return this.logParser.probeSessionId(sessionId);
  }
  private static readonly CLI_COMMAND = "qwen";
  static readonly CLI_VERSION_COMMAND = `${QwenHarnessAdapter.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${QwenHarnessAdapter.CLI_COMMAND} --help`;

  private static readonly statuslineManager =
    StatuslineManager.forStatusLineHarness(STATUS_LINE_HARNESS_IDS.QWEN);

  /** The real system settings each launch's hook settings file copies. */
  private readonly systemSettingsBasePath: string;

  /** System settings file for the next launch; see QwenSystemSettings.ts. */
  private hookSettingsPath: string | undefined;
  private readonly hookSettingsPaths = new Set<string>();

  private readonly statuslineRegistration = new ProviderStatuslineRegistration({
    manager: QwenHarnessAdapter.statuslineManager,
    logPrefix: "QwenHarnessAdapter",
    harnessLabel: "Qwen",
    snapshotPrefix: "qwen",
    tokenEnvironmentVariable: "CTRLYOKE_QWEN_STATUSLINE_TOKEN",
    directoryEnvironmentVariable: "CTRLYOKE_QWEN_STATUSLINE_DIR",
  });

  consumeStatuslineInstallResult(): StatuslineInstallResult | undefined {
    return this.statuslineRegistration.consumeInstallResult();
  }

  /**
   * @param systemSettingsBasePath The system settings Qwen would read without
   *   ctrlyoke; injectable for tests.
   */
  constructor(systemSettingsBasePath = defaultQwenSystemSettingsPath()) {
    this.systemSettingsBasePath = systemSettingsBasePath;
  }

  readonly config: HarnessConfig = {
    name: "qwen",
    harnessId: HARNESS_IDS.QWEN_CLI,
    displayName: "Qwen Code CLI",
    terminalName: "Qwen Code",
    installCommand: installCommandFor({
      posix:
        "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      windows:
        "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    }),
    npmPackage: "@qwen-code/qwen-code",
    versionPolicy: {
      // 0.15.5 added `--mcp-config`, which every MCP-using step passes; hooks
      // have been on by default since 0.14.0.
      minimum: "0.15.5",
      testedWith: "0.26.9",
      updateCommand: "npm install -g @qwen-code/qwen-code@latest",
    },
    shouldStreamHeadlessOutput: true,

    // Qwen uses log file monitoring for completion detection in interactive mode
    // Process exit is primary for headless mode
    usesInteractiveNotificationMonitor: true,
  };

  /** Qwen's session log is richer than its Claude-shaped headless stdout. */
  readonly headlessSource = HEADLESS_SOURCE_MODES.LOG;
  readonly notificationMonitor: INotificationMonitor =
    new QwenNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new QwenToolPermissionMapper();
  readonly sandboxMapper = new UnsupportedSandboxMapper(
    HARNESS_IDS.QWEN_CLI,
    unsupportedSandboxCapabilities(SANDBOX_CAVEAT_CODE.QWEN_UNUSABLE),
    {
      // QWEN_SANDBOX outranks the flag, and the flag outranks tools.sandbox.
      cliArgs: ["--sandbox=false"],
      env: { [QWEN_SANDBOX_ENV]: "false" },
      detail: "Qwen --sandbox=false",
    }
  );
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      sandbox: this.sandboxMapper.capabilities,
      hooks: QwenNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: QWEN_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: QWEN_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly logParser = new QwenLogParser();

  /**
   * qwen3.5-flash resolved a relative `.ctrlyoke/temp/...` reference against a
   * garbled working directory (`…/gn/T/…` read as `…gn-T-…`), so it never
   * found the step's prompt. An absolute path leaves nothing to resolve, as for
   * OpenCode and Antigravity.
   */
  readonly requiresAbsoluteFileReferences = true;

  /** Extract Qwen's session ID from any complete JSON object in stdout. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const { objects } = CliParseUtils.extractJsonObjectsFromStream(chunk);
    const sessionEvent = objects.find(
      (event) => typeof event.session_id === "string"
    );
    return sessionEvent?.session_id as string | undefined;
  }

  /** Extract Qwen's in-band API error from its Claude-shaped headless stream. */
  extractErrorFromStdout(stdout: string): string | undefined {
    const { objects } = CliParseUtils.extractJsonObjectsFromStream(stdout);
    const resultEvent = objects.find(
      (event) =>
        event.type === QWEN_EVENT_TYPES.RESULT && event.is_error === true
    );
    if (!resultEvent) {
      return undefined;
    }

    const error = resultEvent.error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
    return typeof resultEvent.result === "string" && resultEvent.result.trim()
      ? resultEvent.result
      : "Qwen reported an error while executing the request";
  }

  /**
   * Build complete CLI arguments array for Qwen Code CLI execution
   *
   * Handles all Qwen-specific arguments including:
   * - Output format (--output-format stream-json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (--resume for resumption)
   * - Tool permissions (--approval-mode, -y, --allowed-tools, --exclude-tools)
   * - Extra CLI flags from additionalArgs
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension installation directory
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for resolved properties
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
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
      stateRoot?: string;
      secretEnvironment?: Readonly<Record<string, string>>;
    },
    _workspaceRoots?: readonly string[],
    _approvedExternalRoots?: readonly string[]
  ): Promise<HarnessAdapterPreparation> {
    const statusLineToken = randomUUID();
    const args: string[] = [];

    // Use resolved properties if available (from SettingsPropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension or user MCP servers are enabled)
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
      Log.debug(
        "[QwenHarnessAdapter] ctrlyoke MCP config added inline for Qwen"
      );
    }

    // Note: Headless-specific flags (--output-format) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.

    // Session management: Resume with explicit session ID
    const shouldResume = HarnessAdapterUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("--resume", sessionId!);
      Log.info(`[QwenHarnessAdapter] Resuming session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.warn(
        "[QwenHarnessAdapter] Resume requested but no session ID available"
      );
    } else {
      Log.info("[QwenHarnessAdapter] Starting new session");
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(
        `[QwenHarnessAdapter] Extra CLI args applied (${appendTokens.length} tokens)`
      );
    }

    // Hook setup (interactive notification hooks + headless user hooks) is dispatched
    // by CliIntegration.runExecutionSession() via buildNotificationHookArgs() /
    // buildHeadlessUserHookArgs() — not here in buildCliArgs().
    // Qwen hooks are registered in workspace .qwen/settings.json and enabled by default since 0.14.0.
    // buildHeadlessUserHookArgs() applies hook setup and returns no CLI args.
    // Permission preparation is similarly dispatched by CliIntegration — not here.

    Log.trace(
      `[QwenHarnessAdapter] Qwen CLI arguments: ${JSON.stringify(redactMcpConfigArgs(args))}`
    );

    const launchModel = getRequestedQwenModel(args);
    return {
      cliArgs: args,
      mutations: [
        {
          description: "Check and record the model Qwen is launched with",
          apply: async () => {
            await assertQwenModelConfigured(launchModel, workspaceRoot);
            this.logParser.setLaunchModel(launchModel);
          },
        },
        {
          description: "Prepare Qwen statusline tracking",
          apply: async () => {
            this.statuslineRegistration.reset(statusLineToken);
            if (
              workspaceRoot &&
              ConfigurationUtils.getStatusLineHarnessSettings(
                STATUS_LINE_HARNESS_IDS.QWEN
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

  /** Sandbox Off's QWEN_SANDBOX override for the next launch; see setSandboxSpawnEnv. */
  private sandboxSpawnEnv: Readonly<Record<string, string>> = {};

  setSandboxSpawnEnv(env: Readonly<Record<string, string>>): void {
    this.sandboxSpawnEnv = { ...env };
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...HarnessAdapterUtils.buildProcessEnv(),
      ...this.statuslineRegistration.buildSpawnEnv(),
      ...this.buildHookSettingsSpawnEnv(),
      ...this.sandboxSpawnEnv,
    };
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...this.statuslineRegistration.buildSpawnEnv(),
      ...this.buildHookSettingsSpawnEnv(),
      ...this.sandboxSpawnEnv,
    };
  }

  private buildHookSettingsSpawnEnv(): NodeJS.ProcessEnv {
    // Qwen finds system-defaults.json beside the system settings file unless
    // told otherwise, so moving that file to .ctrlyoke/temp/ would drop the
    // real defaults. Point Qwen back at them.
    return this.hookSettingsPath
      ? {
          [QWEN_SYSTEM_SETTINGS_PATH_ENV]: this.hookSettingsPath,
          [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: defaultQwenSystemDefaultsPath(),
        }
      : {};
  }

  /**
   * Set up ctrlyoke notification hooks (Stop hook + user hooks) for interactive mode.
   * Merges hooks into .qwen/settings.json and pre-trusts them in the global
   * Qwen trust tracker.
   * Hooks are enabled by default in Qwen — no CLI flag needed.
   */
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
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<HarnessAdapterPreparation> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-qwen-hook.js"
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
          "userPromptSubmit",
          "stop",
          ...enabledNotificationHookEvents,
        ]),
      ]
    );
    const ctrlyokeHooksSection = (
      hookConfig as { type: string; config: { hooks: Record<string, unknown> } }
    ).config.hooks as Record<string, unknown[]>;
    const wrappedCtrlYokeEvents = [
      ...new Set<HookEvent>([
        "sessionStart",
        "userPromptSubmit",
        "stop",
        ...enabledNotificationHookEvents,
      ]),
    ];
    return this.planHookSettings(
      workspaceRoot,
      ctrlyokeHooksSection,
      this.buildUserHooksSection(userHooks, wrappedCtrlYokeEvents),
      "Write Qwen notification hook settings"
    );
  }

  /**
   * Set up user-only hooks for headless execution.
   * No ctrlyoke notification hooks are included since headless uses process-exit for completion.
   * Hooks are enabled by default in Qwen — no CLI flag needed.
   */
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
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<HarnessAdapterPreparation> {
    const ctrlyokeHooksSection =
      enabledNotificationHookEvents.length > 0
        ? (
            this.notificationMonitor.buildHookConfig(
              path.join(
                extensionPath,
                "out",
                "scripts",
                "ctrlyoke-qwen-hook.js"
              ),
              this.notificationMonitor.getNotificationDirectory(workspaceRoot),
              workspaceRoot,
              userHooks,
              enabledNotificationHookEvents
            ) as {
              type: string;
              config: { hooks: Record<string, unknown[]> };
            }
          ).config.hooks
        : {};
    return this.planHookSettings(
      workspaceRoot,
      ctrlyokeHooksSection,
      this.buildUserHooksSection(userHooks, enabledNotificationHookEvents),
      "Write Qwen headless hook settings"
    );
  }

  /**
   * One launch's hooks go in their own system settings file, passed through
   * QWEN_CODE_SYSTEM_SETTINGS_PATH: Qwen 0.26.9 holds project hooks back for
   * an approval a step can't give (see QwenSystemSettings.ts). A per-launch
   * file also keeps parallel workflows' hooks out of each other's processes.
   */
  private async planHookSettings(
    workspaceRoot: string,
    ctrlyokeHooks: Record<string, unknown[]>,
    userHooks: Record<string, unknown[]>,
    description: string
  ): Promise<HarnessAdapterPreparation> {
    const orphanCleanup: PreparedMutation = {
      path: path.join(workspaceRoot, ".qwen", "settings.json"),
      ownedKeys: ["hooks"],
      description:
        "Remove hooks left in .qwen/settings.json by an interrupted ctrlyoke 0.4 run",
      apply: () => removeOrphanedProjectHooks(workspaceRoot),
    };
    const hooks: Record<string, unknown[]> = { ...ctrlyokeHooks };
    for (const [event, groups] of Object.entries(userHooks)) {
      hooks[event] = [...(hooks[event] ?? []), ...groups];
    }
    if (Object.keys(hooks).length === 0) {
      this.hookSettingsPath = undefined;
      return { cliArgs: [], mutations: [orphanCleanup], diagnostics: [] };
    }

    const settingsPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      `qwen-system-settings-${randomUUID()}.json`
    );
    const content = await buildQwenSystemSettings(
      hooks,
      this.systemSettingsBasePath
    );
    this.hookSettingsPath = settingsPath;
    return {
      cliArgs: [],
      mutations: [
        orphanCleanup,
        {
          path: settingsPath,
          intendedContent: content,
          description,
          apply: async () => {
            await fs.mkdir(path.dirname(settingsPath), { recursive: true });
            await fs.writeFile(settingsPath, content, "utf-8");
            this.hookSettingsPaths.add(settingsPath);
            Log.debug(`[QwenHarnessAdapter] ${description}: ${settingsPath}`);
          },
          restore: async () => {
            await fs.unlink(settingsPath).catch(() => undefined);
          },
        },
      ],
      diagnostics: [],
    };
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    if (config === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    return this.toolPermissionMapper.prepare(config, context);
  }

  private buildUserHooksSection(
    userHooks?: UserHookConfig[],
    wrappedCtrlYokeEvents: HookEvent[] = []
  ): Record<string, unknown[]> {
    const section: Record<string, unknown[]> = {};
    for (const uh of userHooks ?? []) {
      if (
        uh.event === HOOK_EVENT_NAMES.PERMISSION_REQUEST &&
        wrappedCtrlYokeEvents.includes(HOOK_EVENT_NAMES.PERMISSION_REQUEST)
      ) {
        continue;
      }
      const nativeEvent = QwenNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!section[nativeEvent]) {
        section[nativeEvent] = [];
      }
      section[nativeEvent].push({
        hooks: [
          {
            type: "command",
            command: uh.command,
            ...buildHookTimeoutOptions(
              uh.timeoutSec,
              HOOK_TIMEOUT_UNITS.MILLISECONDS
            ),
          },
        ],
      });
    }
    return section;
  }

  /** Delete this workflow's per-launch hook settings files. */
  async cleanupWorkspaceArtifacts(
    _workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
    for (const settingsPath of this.hookSettingsPaths) {
      await fs.unlink(settingsPath).catch(() => undefined);
    }
    this.hookSettingsPaths.clear();
    this.hookSettingsPath = undefined;
  }

  getAdditionalCleanupFilePaths(_workspaceRoot: string): string[] {
    return [
      ...this.hookSettingsPaths,
      ...this.statuslineRegistration.snapshotPaths,
    ];
  }

  /**
   * The `--model` value for a step, or `undefined` for no flag. Any model id
   * is passed through: Qwen resolves it against its own `modelProviders`. A
   * `none` model or default means no flag, never a literal `--model none`.
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    return resolveCliModelFlag(requestedModel, {
      logLabel: "QwenHarnessAdapter",
      defaultModel: ConfigurationUtils.getQwenCliModel(),
      recognize: (model) => model,
    });
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Qwen CLI expects the prompt as a positional argument.
   * Format: qwen "prompt" --output-format stream-json --input-format stream-json [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    this.logParser.setSubagentUsageEnabled(false);
    // --output-format stream-json enables structured JSON output for reliable parsing.
    // --input-format stream-json is required alongside it (Qwen rejects the combination
    // otherwise) and exempts this run from Qwen's non-interactive auto-deny gate, which
    // resolves --allowed-tools entries against a narrower, stale alias table than the
    // one used everywhere else and silently force-denies tools it doesn't recognize
    // (e.g. write_file) even when explicitly allowed. Qwen auto-wraps this positional
    // prompt into the initial stream-json user message internally — no stdin writing
    // needed — and ctrlyoke's headless spawn already runs with stdin ignored, so the
    // session's stdin read loop EOFs immediately and drains the in-flight turn before
    // exiting, matching the existing process-exit completion signal.
    return [
      prompt,
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      ...baseArgs,
    ];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Qwen interactive mode: qwen "prompt text" [args...] (no --output-format = interactive)
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    this.logParser.setSubagentUsageEnabled(true);
    return ["-i", promptText, ...baseArgs];
  }

  /**
   * Format a file path reference for Qwen Code CLI
   *
   * Qwen accepts @path format, but spaces must be escaped on POSIX. The shared
   * formatter supplies quote-wrapped paths containing spaces; Qwen converts
   * those according to its platform parser behavior.
   *
   * @param quotedFilePath Path supplied by the shared formatter
   * @returns Formatted file reference (e.g., "@path")
   */
  formatFileReference(
    quotedFilePath: string,
    options?: { tempFileCategory?: TempFileCategory }
  ): string {
    if (quotedFilePath.includes(" ") && process.platform === "win32") {
      if (
        options?.tempFileCategory === TEMP_FILE_CATEGORIES.PROMPT ||
        options?.tempFileCategory === TEMP_FILE_CATEGORIES.AGENT ||
        options?.tempFileCategory === TEMP_FILE_CATEGORIES.SKILLS
      ) {
        return `Read the file at ${quotedFilePath} and follow its instructions.`;
      }
      return quotedFilePath;
    }

    if (quotedFilePath.includes(" ")) {
      const unquotedPath = quotedFilePath.replace(/^"(.*)"$/u, "$1");
      return `@${unquotedPath.replace(/ /gu, "\\ ")}`;
    }

    return `@${quotedFilePath}`;
  }

  /**
   * Generate MCP server configuration for Qwen Code CLI.
   *
   * Qwen CLI accepts a per-invocation inline JSON object through `--mcp-config`.
   * The shared settings-entry builder keeps this schema aligned with Qwen's
   * native settings format without writing a workspace settings file.
   *
   * @returns Two tokens (`--mcp-config` and its JSON value), or null without MCP
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<string[] | null> {
    const preparation = await this.planMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers,
      stateRoot,
      secretEnvironment
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs.length > 0 ? preparation.cliArgs : null;
  }

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

    const mcpEntries = HarnessAdapterUtils.buildSettingsJsonMcpEntries(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers,
      {
        remoteUrlKeyMap: {
          "streamable-http": "httpUrl",
          sse: "url",
        },
        includeRemoteType: false,
      },
      stateRoot,
      HarnessAdapterUtils.createMcpSecretConfigOptions(
        undefined,
        secretEnvironment
      )
    );

    return {
      cliArgs: ["--mcp-config", JSON.stringify({ mcpServers: mcpEntries })],
      mutations: [],
      diagnostics: [],
    };
  }

  /**
   * Return null — inline MCP config does not have a file path to clean up.
   */
  getMcpConfigFilePath(
    _workingFilePath: string | undefined,
    _workspaceRoot: string
  ): null {
    return null;
  }

  /**
   * Check if Qwen Code CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return HarnessAdapterUtils.checkCliAvailability(
      QwenHarnessAdapter.CLI_VERSION_COMMAND
    );
  }

  /**
   * Get Qwen Code CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    return HarnessAdapterUtils.getCliVersion(
      QwenHarnessAdapter.CLI_VERSION_COMMAND
    );
  }

  /**
   * Check whether CLI output or an error describes a rejected Qwen session.
   *
   * This classifies a process result so the runner can retry without
   * the resume flag; it is intentionally a provider concern, not output
   * parsing.
   */
  isRecoverableSessionError(
    input: string | Error | { stdout?: string; stderr?: string }
  ): boolean {
    const message =
      typeof input === "string"
        ? input
        : input instanceof Error
          ? getErrorMessage(input)
          : `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
    return (
      message.includes("invalid session") ||
      message.includes("session not found") ||
      message.includes("--resume requires a valid session") ||
      /No saved session found with (?:ID|title)\s+["']?[^\s"']+/i.test(message)
    );
  }
}
