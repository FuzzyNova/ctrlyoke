import * as path from "path";
import * as fs from "fs";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
} from "../../../types/DashboardConstants";
import type {
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { OpenCodeNotificationMonitor } from "./OpenCodeNotificationMonitor";
import { OpenCodeToolPermissionMapper } from "./OpenCodeToolPermissionMapper";
import { OpenCodeLogParser } from "./OpenCodeLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getOpenCodeContextWindowSize } from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { CliParseUtils } from "../shared/CliParseUtils";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import type { HarnessCapabilityFacts } from "../../../types/CompatibilityTypes";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
  HookEvent,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
} from "../shared/interfaces/PreparedMutation";
import {
  buildOpenCodeMcpEntries,
  OPENCODE_INLINE_CONFIG_MAX_BYTES,
  resolveOpenCodePermissionCollisionContext,
  type OpenCodeInlineConfig,
  type OpenCodeInlineConfigBuildOptions,
} from "./OpenCodeInlineConfig";
import {
  OPENCODE_CLI_FLAGS,
  OPENCODE_RESUME_PROMPT_ENV,
  OPENCODE_RESUMED_PROMPT_DELIVERIES,
  type OpenCodeResumedPromptDelivery,
} from "./OpenCodeProtocolConstants";

/**
 * How a resumed interactive step delivers its prompt.
 *
 * OpenCode's TUI ignores `--prompt` when `--session` is also given: it opens
 * the session and waits for input, so the step never starts
 * (anomalyco/opencode#21829, closed "not planned"; fix proposed in
 * anomalyco/opencode#46307). Until a release honours the pair, the ctrlyoke
 * plugin submits the prompt through OpenCode's server instead. Switch this to
 * `ARGUMENT` to go back to `--session … --prompt …` once the fix ships.
 *
 * Only relaunches are affected: inject mode types follow-up prompts into the
 * running TUI and never resumes by argument.
 */
const OPENCODE_RESUMED_PROMPT_DELIVERY: OpenCodeResumedPromptDelivery =
  OPENCODE_RESUMED_PROMPT_DELIVERIES.PLUGIN;

/** A resumed interactive prompt the plugin submits after OpenCode starts. */
interface OpenCodeResumePrompt {
  sessionId: string;
  model: string | undefined;
  text: string;
}

/** Value that follows `flag` in `args`, if the flag is present. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const OPENCODE_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "behavioral-test",
    reference: "src/test/harness/inline-config.harness.test.ts",
    basis: "cli-version",
    verifiedVersions: [">=1.18.10"],
  },
} as const;

const OPENCODE_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: {
    kind: "manual",
    reference: "https://dev.opencode.ai/docs/cli/",
    basis: "cli-version",
    verifiedVersions: [">=1.18.10"],
  },
} as const;

/**
 * OpenCode CLI Harness
 *
 * Implements all OpenCode-specific logic using the composition pattern:
 * - Plugin-based completion detection (session.status idle events)
 * - JSONL response parsing (--format json)
 * - Inline-config-driven tool permissions (OPENCODE_CONFIG_CONTENT)
 * - Multi-provider model support (provider/model format)
 *
 * This provider aggregates three specialized components:
 * - OpenCodeNotificationMonitor: Manages plugin-based completion detection
 * - OpenCodeToolPermissionMapper: Returns [] (permissions are config-file driven)
 * - OpenCodeLogParser: Maps OpenCode events for both headless and interactive modes
 *
 * Headless execution:
 *   opencode run "prompt" --format json -m provider/model [-s sessionId]
 *
 * Interactive execution (with plugin for completion detection):
 *   opencode --prompt "prompt text" -m provider/model
 *   opencode -m provider/model -s sessionId   (prompt submitted by the plugin;
 *                                               see OPENCODE_RESUMED_PROMPT_DELIVERY)
 *   (plugin loaded from the extension installation through inline config)
 *
 * Session management:
 *   -s <sessionId> — resume existing session (both modes)
 *   NOT -c — that's a global "continue last" which is not project-scoped
 *
 * Usage:
 * ```typescript
 * const provider = new OpenCodeCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class OpenCodeCliProvider implements ICliProvider {
  private static readonly CLI_COMMAND = "opencode";
  static readonly CLI_VERSION_COMMAND = `${OpenCodeCliProvider.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${OpenCodeCliProvider.CLI_COMMAND} --help`;

  readonly config: HarnessConfig = {
    name: "opencode",
    harnessId: HARNESS_IDS.OPENCODE_CLI,
    displayName: "OpenCode CLI",
    terminalName: "OpenCode",
    installHint: "Install via: npm install -g opencode-ai",
    versionPolicy: {
      minimum: "1.3.16",
      recommended: "1.18.34",
      updateCommand: "opencode upgrade",
    },
    shouldStreamHeadlessOutput: true,

    // OpenCode uses a TypeScript plugin system for interactive completion detection
    usesInteractiveNotificationMonitor: true,
  };

  /** The fully-qualified model ID used for the most-recently started execution (e.g. "anthropic/claude-sonnet-4-6"). */
  private resolvedCurrentModel: string = "anthropic/claude-sonnet-4-6";

  readonly notificationMonitor = new OpenCodeNotificationMonitor();
  readonly toolPermissionMapper = new OpenCodeToolPermissionMapper();
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      hooks: OpenCodeNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: OPENCODE_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: OPENCODE_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly headlessSource = HEADLESS_SOURCE_MODES.STDOUT;
  readonly logParser = new OpenCodeLogParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );
  /** MCP server ids prepared for the current execution. */
  private attachedMcpServerIds: ReadonlySet<string> = new Set();

  getAttachedMcpServerIds(): ReadonlySet<string> {
    return this.attachedMcpServerIds;
  }

  private setAttachedMcpServerIds(serverIds: Iterable<string>): void {
    this.attachedMcpServerIds = new Set(serverIds);
    this.logParser.setAttachedMcpServerIds(this.attachedMcpServerIds);
  }

  /** Inline config accumulated while preparing the current prompt. */
  private pendingInlineConfig: OpenCodeInlineConfig = { plugin: [] };
  /** User hooks serialized for the plugin's process-local environment. */
  private pendingUserHooksEnv: string | undefined;
  /** Artifacts created only by the documented fallback path. */
  private fallbackPluginArtifactPaths: string[] = [];
  /**
   * Prompt for the plugin to submit to a resumed session. Set by
   * buildInteractiveArgs() and read by getInteractiveSpawnEnv(), which every
   * interactive launch calls in that order.
   */
  private pendingResumePrompt: OpenCodeResumePrompt | undefined;

  /**
   * Build the ctrlyoke-owned OpenCode config without performing any I/O.
   *
   * This builder is also used by prompt preparation to keep the inline shape
   * in one place.
   */
  buildInlineConfig(
    options: OpenCodeInlineConfigBuildOptions
  ): OpenCodeInlineConfig {
    const permission = options.toolPermissions
      ? this.toolPermissionMapper.buildPermissionPolicy(
          options.toolPermissions,
          options.permissionCollisionContext
        )
      : undefined;
    const mcpEntries = buildOpenCodeMcpEntries(
      options.mcpServerPath,
      options.workspaceRoot,
      options.workingFilePath,
      options.additionalEnv,
      options.userServers,
      options.stateRoot,
      options.secretOptions
    );
    const pluginPath = path.resolve(
      options.extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );

    return {
      ...(permission ? { permission } : {}),
      ...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
      // OpenCode converts absolute paths to file:// URLs itself. Keeping the
      // path here also avoids having to escape Windows drive letters/spaces.
      plugin: [pluginPath],
    };
  }

  /** Convert OpenCode's JSONL stdout into the event vocabulary of OpenCodeLogParser. */
  parseHeadlessStdout(stdout: string): BaseCliEvent[] {
    return CliParseUtils.parseJsonLines(stdout) as BaseCliEvent[];
  }

  /** Extract the session ID carried by any OpenCode stdout event. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const event = CliParseUtils.parseJsonLines(chunk).find(
      (candidate) => typeof candidate.sessionID === "string"
    );
    return event?.sessionID as string | undefined;
  }

  /**
   * Build complete CLI arguments array for OpenCode CLI execution
   *
   * Handles all OpenCode-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Format flag (headless: run --format json)
   * - Model selection (provider/model format, e.g. anthropic/claude-sonnet-4-6)
   * - Session management (-s resume with explicit session ID only)
   * - Interactive plugin file deployment (when isInteractive === true)
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension path for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
   * @returns Complete CLI arguments array (without prompt — that's handled separately)
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
    },
    _workspaceRoots?: readonly string[],
    _approvedExternalRoots?: readonly string[]
  ): Promise<CliProviderPreparation> {
    // The integration is reused across prompts in one workflow. Reset before
    // optional MCP or permission preparation so a later prompt cannot inherit
    // either slice when its workspace or policy is absent.
    const inlinePlugin = this.buildInlineConfig({
      extensionPath,
    }).plugin;

    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
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
        "[OpenCodeCliProvider] ctrlyoke MCP config prepared for OpenCode inline delivery"
      );
    }

    // Headless mode: add "run" subcommand and "--format json"
    // These must come BEFORE -m and -s
    if (!isInteractive) {
      args.push("run");
      args.push("--format", "json");
    }

    // Model selection — use resolved property if available
    const model = this.getModel(resolvedModel);
    if (model) {
      args.push(OPENCODE_CLI_FLAGS.MODEL, model);
    }

    // Session management — resume with explicit session ID only
    // NOTE: We do NOT use -c (continue last session) because:
    // 1. It's global across all projects, not workspace-specific
    // 2. Could accidentally resume a session from a different project
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push(OPENCODE_CLI_FLAGS.SESSION, sessionId!);
      Log.info(`[OpenCodeCliProvider] Resuming session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.warn(
        "[OpenCodeCliProvider] Resume requested but no session ID available"
      );
    } else {
      Log.info("[OpenCodeCliProvider] Starting new session");
    }

    const userHooks = workflowContext?.resolvedProperties?.hooks ?? undefined;
    if (workspaceRoot) {
      // Plugin verification and the compatibility fallback are deferred until
      // the execution plan is applied immediately before process start.
    }

    // Extra CLI flags from additionalArgs (appended before prompt positional arg)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(
        `[OpenCodeCliProvider] Extra CLI args applied (${appendTokens.length} tokens)`
      );
    }

    return {
      cliArgs: args,
      mutations: [
        {
          description: "Prepare OpenCode inline execution state",
          apply: async () => {
            this.pendingInlineConfig = { plugin: inlinePlugin };
            this.setAttachedMcpServerIds([]);
            this.pendingUserHooksEnv = this.serializeUserHooks(userHooks);
            if (model) {
              this.resolvedCurrentModel = model;
            }
          },
        },
        ...(workspaceRoot
          ? [
              {
                description: "Verify OpenCode completion plugin",
                apply: async () =>
                  this.ensureExternalPluginIsLoadable(
                    workspaceRoot,
                    extensionPath,
                    userHooks
                  ),
              },
            ]
          : []),
        ...mcpPreparation.mutations,
      ],
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  /**
   * Build CLI arguments for headless mode.
   *
   * opencode run "prompt" --format json -m model [-s sessionId]
   *
   * The prompt is passed as a positional argument at the end.
   *
   * @param baseArgs Base arguments array (already includes "run", "--format", "json", "-m", model)
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array with prompt appended
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return [...baseArgs, prompt];
  }

  /**
   * Build CLI arguments for interactive TUI mode.
   *
   * opencode --prompt "prompt text" -m model
   *
   * A resumed session (`-s`) omits `--prompt` while
   * OPENCODE_RESUMED_PROMPT_DELIVERY is `PLUGIN`, and hands the prompt to the
   * plugin through getInteractiveSpawnEnv() instead.
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    const sessionId = flagValue(baseArgs, OPENCODE_CLI_FLAGS.SESSION);
    this.pendingResumePrompt =
      sessionId &&
      promptText &&
      OPENCODE_RESUMED_PROMPT_DELIVERY ===
        OPENCODE_RESUMED_PROMPT_DELIVERIES.PLUGIN
        ? {
            sessionId,
            model: flagValue(baseArgs, OPENCODE_CLI_FLAGS.MODEL),
            text: promptText,
          }
        : undefined;
    if (this.pendingResumePrompt) {
      Log.info(
        `[OpenCodeCliProvider] Resumed session ${sessionId}: the plugin will submit the prompt (OpenCode ignores --prompt with --session)`
      );
      return [...baseArgs];
    }
    return [OPENCODE_CLI_FLAGS.PROMPT, promptText, ...baseArgs];
  }

  /**
   * Format a file path for OpenCode file references.
   *
   * OpenCode's TUI treats a leading `@` as an agent-mention trigger: in inject
   * mode we write text straight into the running TUI, so an `@path` prefix gets
   * intercepted and rewritten to an agent invocation (e.g. `@explore`) before it
   * ever reaches the model. OpenCode does not auto-read `@`-prefixed paths anyway
   * — it decides to read referenced files on its own from the plain path — so we
   * drop the `@` entirely, mirroring Codex. This applies uniformly to simple,
   * injected, and categorized prompts because every ref routes through here.
   *
   * @param relativeFilePath Relative or absolute file path
   * @returns File path without an `@` prefix
   */
  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  buildImageAttachmentArgs(imageFilePaths: readonly string[]): string[] {
    return imageFilePaths.flatMap((filePath) => ["--file", filePath]);
  }

  /**
   * Generate MCP server configuration for OpenCode CLI.
   *
   * OpenCode has no --mcp-config CLI flag. MCP entries are delivered through
   * OPENCODE_CONFIG_CONTENT at process startup.
   * Supports ctrlyoke server, user-defined MCP servers, or both.
   * Config format (opencode uses "mcp" key with "type": "local"):
   * {
   *   "$schema": "https://opencode.ai/config.json",
   *   "mcp": {
   *     "ctrlyoke": {
   *       "type": "local",
   *       "command": ["node", "/path/to/mcp-server.js"],
   *       "environment": { ... }
   *     },
   *     "my-server": {
   *       "type": "local",
   *       "command": ["node", "/path/to/server.js"],
   *       "environment": { ... }
   *     }
   *   }
   * }
   *
   * @param mcpServerPath Absolute path to MCP server executable (undefined when ctrlyoke server not requested)
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @param additionalEnv Extra environment variables for the ctrlyoke MCP server
   * @param userServers User-defined MCP server configurations
   * @returns Empty array (inline config is delivered through the spawn env)
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
    const hasMcp =
      !!mcpServerPath || (userServers !== undefined && userServers.length > 0);
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
    return hasMcp ? preparation.cliArgs : null;
  }

  async planMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    _stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<CliProviderPreparation> {
    const hasUserServers = userServers && userServers.length > 0;
    if (!mcpServerPath && !hasUserServers) {
      return {
        cliArgs: [],
        mutations: [
          {
            description: "Clear OpenCode inline MCP configuration",
            apply: async () => {
              delete this.pendingInlineConfig.mcp;
              this.setAttachedMcpServerIds([]);
            },
          },
        ],
        diagnostics: [],
      };
    }
    const mcpEntries = buildOpenCodeMcpEntries(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers,
      _stateRoot,
      CliProviderUtils.createMcpSecretConfigOptions(
        (name) => `{env:${name}}`,
        secretEnvironment
      )
    );
    return {
      cliArgs: [],
      mutations: [
        {
          description: "Set OpenCode inline MCP configuration",
          apply: async () => {
            this.pendingInlineConfig.mcp = mcpEntries;
            this.setAttachedMcpServerIds(Object.keys(mcpEntries));
          },
        },
      ],
      diagnostics: [],
    };
  }

  /**
   * Accumulate OpenCode's permission policy before process launch.
   * `none` and `dangerouslyAllowAll` intentionally emit no permission slice.
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const application = await this.planToolPermissions(
      toolPermissions,
      context
    );
    await applyPreparedMutations(application.mutations ?? []);
    return application;
  }

  async planToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (toolPermissions === null || toolPermissions === undefined) {
      return {
        cliArgs: [],
        mutations: [
          {
            description: "Clear OpenCode inline permission configuration",
            apply: async () => {
              delete this.pendingInlineConfig.permission;
            },
          },
        ],
        diagnostics: [],
      };
    }
    const collisionContext =
      context.permissionCollisionContext ??
      (await resolveOpenCodePermissionCollisionContext(
        context.workspaceRoot,
        context.environment
      ));
    const policy = toolPermissions
      ? this.toolPermissionMapper.buildPermissionPolicy(
          toolPermissions,
          collisionContext
        )
      : undefined;
    const application = await this.toolPermissionMapper.prepare(
      toolPermissions,
      context
    );
    return {
      ...application,
      mutations: [
        ...(application.mutations ?? []),
        {
          description: "Set OpenCode inline permission configuration",
          apply: async () => {
            if (policy) {
              this.pendingInlineConfig.permission = policy;
            } else {
              delete this.pendingInlineConfig.permission;
            }
          },
        },
      ],
    };
  }

  async cleanupWorkspaceArtifacts(
    _workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
    for (const artifactPath of this.fallbackPluginArtifactPaths) {
      await fs.promises.unlink(artifactPath).catch(() => {});
    }
    this.fallbackPluginArtifactPaths = [];
  }

  async buildNotificationHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planNotificationHookArgs(
      _extensionPath,
      _workspaceRoot,
      _promptIndex,
      _workingFilePath,
      userHooks,
      _enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planNotificationHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const serializedHooks = this.serializeUserHooks(userHooks);
    return {
      cliArgs: [],
      mutations: [
        {
          description: "Set OpenCode process-local notification hooks",
          apply: async () => {
            this.pendingUserHooksEnv = serializedHooks;
          },
        },
      ],
      diagnostics: [],
    };
  }

  async buildHeadlessUserHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planHeadlessUserHookArgs(
      _extensionPath,
      _workspaceRoot,
      _promptIndex,
      _workingFilePath,
      userHooks,
      _enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planHeadlessUserHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const serializedHooks = this.serializeUserHooks(userHooks);
    return {
      cliArgs: [],
      mutations: [
        {
          description: "Set OpenCode process-local headless hooks",
          apply: async () => {
            this.pendingUserHooksEnv = serializedHooks;
          },
        },
      ],
      diagnostics: [],
    };
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
      ...(this.pendingUserHooksEnv
        ? { CTRLYOKE_OPENCODE_HOOKS: this.pendingUserHooksEnv }
        : {}),
    };
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
      ...(this.pendingUserHooksEnv
        ? { CTRLYOKE_OPENCODE_HOOKS: this.pendingUserHooksEnv }
        : {}),
      ...this.getResumePromptEnv(),
    };
  }

  private getResumePromptEnv(): Record<string, string> {
    const resume = this.pendingResumePrompt;
    if (!resume) {
      return {};
    }
    return {
      [OPENCODE_RESUME_PROMPT_ENV.PROMPT]: resume.text,
      [OPENCODE_RESUME_PROMPT_ENV.SESSION]: resume.sessionId,
      ...(resume.model
        ? { [OPENCODE_RESUME_PROMPT_ENV.MODEL]: resume.model }
        : {}),
    };
  }

  private getInlineConfigContent(): string {
    const content = JSON.stringify(this.pendingInlineConfig);
    const size = Buffer.byteLength(content, "utf8");
    if (size > OPENCODE_INLINE_CONFIG_MAX_BYTES) {
      Log.warn(
        `[OpenCodeCliProvider] OpenCode inline config is ${size} bytes; refusing to launch above the ${OPENCODE_INLINE_CONFIG_MAX_BYTES}-byte defensive limit`
      );
      throw new Error(
        `OpenCode inline config exceeds the ${OPENCODE_INLINE_CONFIG_MAX_BYTES}-byte defensive limit`
      );
    }
    return content;
  }

  /**
   * Check if OpenCode CLI is available on the system
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability(
      OpenCodeCliProvider.CLI_VERSION_COMMAND
    );
  }

  /**
   * Get OpenCode CLI version string
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion(
      OpenCodeCliProvider.CLI_VERSION_COMMAND,
      {
        timeoutMs: 5000,
      }
    );
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Get the model to use, validating format and applying fallback.
   * OpenCode models use provider/model format (e.g., anthropic/claude-sonnet-4-6).
   */
  private getModel(resolvedModel?: string): string | undefined {
    if (resolvedModel === MODEL_NONE) {
      return undefined;
    }

    // If we have a resolved model in the correct format, use it
    if (resolvedModel?.includes("/")) {
      return resolvedModel;
    }

    // If resolved model is set but wrong format, warn and fall back to configured default
    if (resolvedModel) {
      Log.warn(
        `[OpenCodeCliProvider] OpenCode: model "${resolvedModel}" does not use provider/model format. ` +
          `Expected format: provider/model (e.g., anthropic/claude-sonnet-4-6). Using configured default.`
      );
    }

    // Fall back to user-configured default
    const configuredDefault = ConfigurationUtils.getOpenCodeCliModel();
    if (configuredDefault?.includes("/")) {
      return configuredDefault;
    }

    return "anthropic/claude-sonnet-4-6";
  }

  private serializeUserHooks(userHooks?: UserHookConfig[]): string | undefined {
    if (!userHooks || userHooks.length === 0) {
      return undefined;
    }
    const supportedHooks = userHooks.filter(
      (hook) => OpenCodeNotificationMonitor.EVENT_MAP[hook.event] !== undefined
    );
    if (supportedHooks.length === 0) {
      return undefined;
    }
    return JSON.stringify(
      supportedHooks.map((hook) => ({
        event: hook.event,
        command: hook.command,
      }))
    );
  }

  /**
   * Verify the external plugin before launch. Path-spec plugins are verified in
   * OpenCode 1.18.10 but undocumented, so retain a small, warning-backed
   * workspace deployment fallback if the installed plugin cannot be loaded.
   */
  private async ensureExternalPluginIsLoadable(
    workspaceRoot: string,
    extensionPath: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    const sourcePath = path.resolve(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );
    try {
      await fs.promises.access(sourcePath, fs.constants.R_OK);
    } catch {
      // A missing extension artifact is an installation/build problem, not an
      // OpenCode path-spec regression; leave the workspace untouched here.
      return;
    }
    try {
      await this.pluginPathIsReadable(sourcePath);
    } catch (error) {
      Log.warn(
        `[OpenCodeCliProvider] OpenCode external plugin could not be loaded from ${sourcePath}; ` +
          `falling back to .opencode/plugin/: ${error}`
      );
      try {
        await this.deployCompletionPluginFallback(
          workspaceRoot,
          sourcePath,
          userHooks
        );
      } catch (fallbackError) {
        Log.warn(
          `[OpenCodeCliProvider] OpenCode plugin fallback was unavailable: ${fallbackError}`
        );
      }
    }
  }

  private async pluginPathIsReadable(sourcePath: string): Promise<void> {
    await fs.promises.access(sourcePath, fs.constants.R_OK);
  }

  /** Minimal compatibility fallback for a future OpenCode regression. */
  private async deployCompletionPluginFallback(
    workspaceRoot: string,
    sourcePath: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    // A missing extension artifact cannot be recovered by copying it into the
    // workspace. This keeps installation failures file-free and distinct from
    // a genuine regression in OpenCode's external path loading.
    await fs.promises.access(sourcePath, fs.constants.R_OK);
    const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
    const pluginPath = path.join(pluginDir, "ctrlyoke-completion-hook.ts");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.copyFile(sourcePath, pluginPath);
    this.fallbackPluginArtifactPaths.push(pluginPath);

    const serializedUserHooks = this.serializeUserHooks(userHooks);
    if (serializedUserHooks !== undefined) {
      const sidecarPath = path.join(pluginDir, "ctrlyoke-hooks.json");
      await fs.promises.writeFile(sidecarPath, serializedUserHooks, "utf8");
      this.fallbackPluginArtifactPaths.push(sidecarPath);
    }

    // An auto-scanned fallback plugin must not remain in the inline list.
    this.pendingInlineConfig.plugin = [];
    Log.warn(
      "[OpenCodeCliProvider] OpenCode plugin fallback deployed under .opencode/plugin/; " +
        "this compatibility path writes workspace files"
    );
  }
}
