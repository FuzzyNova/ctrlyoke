import * as path from "path";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { installHintFor } from "../shared/HarnessInstallHint";
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
import { CODEX_STDOUT_EVENT_TYPES } from "./CodexProtocolConstants";
import { CodexNotificationMonitor } from "./CodexNotificationMonitor";
import { CodexToolPermissionMapper } from "./CodexToolPermissionMapper";
import { CodexLogParser } from "./CodexLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { quoteTomlBasicString } from "../shared/InlineToml";
import { createCodexCommandHookGroup } from "../shared/CodexHookUtils";
import {
  buildCodexInlineHooks,
  type CodexInlineHooksArgs,
} from "./CodexInlineHooksBuilder";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CODEX_CLI_MODELS, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  HOOK_EVENT_NAMES,
  MCP_SERVER_IDS,
  MCP_TRANSPORTS,
} from "../../../types/DashboardConstants";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  HookEvent,
  PromptFile,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";
import type { HarnessCapabilityFacts } from "../../../types/CompatibilityTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
} from "../shared/interfaces/PreparedMutation";

const CODEX_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: {
    kind: "manual",
    reference:
      "dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation",
    basis: "cli-version",
    verifiedVersions: [">=0.146.0"],
  },
} as const;

const CODEX_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: {
    kind: "manual",
    reference: "https://developers.openai.com/codex/cli/reference/",
    basis: "cli-version",
    verifiedVersions: [">=0.146.0"],
  },
} as const;

const CODEX_HOOK_ARGS = ["--enable", "hooks"] as const;
const CODEX_NOTIFICATION_SCRIPT_NAME = "ctrlyoke-codex-notify.js";
// Without this override, interactive Codex sessions hang waiting for an update
// confirmation prompt on startup. Headless is unaffected but the flag is harmless there.
const CODEX_SKIP_UPDATE_CHECK_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

const CODEX_SECRET_REFERENCE_PATTERN = /^\$\{secret:([A-Z][A-Z0-9_]*)\}$/u;

function splitCodexEnvironment(env: Record<string, string> | undefined): {
  staticValues: Record<string, string>;
  envVars: string[];
} {
  const staticValues: Record<string, string> = {};
  const envVars: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const reference = CODEX_SECRET_REFERENCE_PATTERN.exec(value);
    if (reference) {
      envVars.push(reference[1]);
    } else if (value.includes("${secret:")) {
      throw new Error(
        `Codex cannot represent a composite secret interpolation for MCP env "${key}"`
      );
    } else {
      staticValues[key] = value;
    }
  }
  return { staticValues, envVars };
}

function splitCodexHeaders(headers: Record<string, string> | undefined): {
  staticValues: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  bearerTokenEnvVar?: string;
} {
  const staticValues: Record<string, string> = {};
  const envHttpHeaders: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;
  for (const [key, value] of Object.entries(headers ?? {})) {
    const bearerReference = /^Bearer \$\{secret:([A-Z][A-Z0-9_]*)\}$/u.exec(
      value
    );
    const reference = CODEX_SECRET_REFERENCE_PATTERN.exec(value);
    if (bearerReference && key.toLowerCase() === "authorization") {
      bearerTokenEnvVar = bearerReference[1];
    } else if (reference) {
      envHttpHeaders[key] = reference[1];
    } else if (value.includes("${secret:")) {
      throw new Error(
        `Codex cannot represent a composite secret interpolation for MCP header "${key}"`
      );
    } else {
      staticValues[key] = value;
    }
  }
  return { staticValues, envHttpHeaders, bearerTokenEnvVar };
}

/**
 * Codex CLI Harness
 *
 * Implements all Codex-specific logic using composition pattern:
 * - hook monitoring and hooks system for completion detection
 * - Session-log event parsing with event-based streaming
 * - Mode-based permissions (no granular tool patterns)
 * - MCP server configuration with inline TOML format
 *
 * This provider aggregates three specialized components:
 * - CodexNotificationMonitor: Monitors hook notifications
 * - CodexToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration (shared)
 *
 * Codex CLI-specific features:
 * - Uses JSONL output format (multiple {"type": "..."} events)
 * - Hook-based completion via --enable hooks + inline config overrides
 * - OpenAI token format in usage metadata
 * - Completion detection via {"type": "turn.completed"} events
 * - Supports --resume flag for session continuation
 * - Mode-based permissions (Auto preset flags, --dangerously-bypass-approvals-and-sandbox)
 *
 * Usage:
 * ```typescript
 * const provider = new CodexCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CodexCliProvider implements ICliProvider {
  private static readonly CLI_COMMAND = "codex";
  static readonly CLI_VERSION_COMMAND = `${CodexCliProvider.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${CodexCliProvider.CLI_COMMAND} --help`;

  readonly logParser: CodexLogParser;

  constructor(onProviderUsageUpdate?: (quota: HarnessQuotaSnapshot) => void) {
    this.logParser = new CodexLogParser(onProviderUsageUpdate);
  }

  private buildToolApprovalOverrideArgs(server: McpServerConfig): string[] {
    if (!Array.isArray(server.autoApprove) || server.autoApprove.length === 0) {
      return [];
    }

    return server.autoApprove.flatMap((toolName) => [
      "-c",
      `mcp_servers.${server.id}.tools.${toolName}.approval_mode='approve'`,
    ]);
  }

  readonly config: HarnessConfig = {
    name: "codex",
    harnessId: HARNESS_IDS.CODEX_CLI,
    displayName: "Codex CLI",
    terminalName: "Codex",
    installHint: installHintFor({
      posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      windows:
        'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    }),
    npmPackage: "@openai/codex",
    versionPolicy: {
      minimum: "0.119.0",
      recommended: "0.157.0",
      updateCommand: "codex update",
    },
    shouldStreamHeadlessOutput: true,

    // Codex uses hooks system for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly notificationMonitor: INotificationMonitor =
    new CodexNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CodexToolPermissionMapper();
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      hooks: CodexNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: CODEX_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: CODEX_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly headlessSource = HEADLESS_SOURCE_MODES.LOG;

  /**
   * Extract Codex's session ID from a complete headless JSONL record.
   * HeadlessLogTail accumulates transport chunks and only calls this hook with
   * complete records, plus one flush of an unterminated tail at process exit,
   * so this hook stays pure and stateless.
   */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const event = CliParseUtils.parseJsonLines(chunk).find(
      (candidate) =>
        candidate.type === CODEX_STDOUT_EVENT_TYPES.THREAD_STARTED &&
        typeof candidate.thread_id === "string" &&
        candidate.thread_id.length > 0
    );
    return event?.thread_id as string | undefined;
  }

  /**
   * Build complete CLI arguments array for Codex CLI execution
   *
   * Handles all Codex-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Exec mode and output format (--json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (resume subcommand with session ID)
   * - Tool permissions (sandbox mode, approval policy, Auto preset flags)
   * - Hook settings (interactive mode only: --enable hooks + inline overrides)
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param context Extension context for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
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
  ): Promise<CliProviderPreparation> {
    const args: string[] = [];

    args.push(...CODEX_SKIP_UPDATE_CHECK_ARGS);

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // No provider-specific agent flags needed.
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
        "[CodexCliProvider] MCP server config added for dynamic queue extension"
      );
    }

    // Headless mode: add exec command and --json flag
    if (!isInteractive) {
      args.push("exec");
      args.push("--json");
      args.push("--skip-git-repo-check"); // Allow headless/CI use outside git repos
    }

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots,
        approvedExternalRoots,
        workflowContext
      );
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(
        `[CodexCliProvider] Extra CLI args applied (${appendTokens.length} tokens)`
      );
    }

    // Hook setup (interactive notification hooks) is dispatched by
    // CliIntegration.runExecutionSession() via buildNotificationHookArgs() — not here.
    // buildNotificationHookArgs() returns ["--enable", "hooks"] for interactive mode.

    // Session management
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (resolvedResumeSession && !sessionId) {
      Log.warn(
        "[CodexCliProvider] Resume requested but no session ID available"
      );
    } else if (!shouldResume) {
      Log.info("[CodexCliProvider] Starting new session");
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods (buildHeadlessArgs, etc.).
    // Note: "resume <session-id>" is NOT added here — it must appear AFTER all global
    // flags (hooks, permissions). See buildCliSuffix().

    return {
      cliArgs: args,
      mutations: mcpPreparation.mutations,
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  /**
   * Append "resume <session-id>" after all global args in the assembled command.
   *
   * Codex's "resume" is a CLI subcommand (not a flag), so it must come AFTER all global
   * flags such as "--enable hooks" and "-c hooks.state=...". buildInteractiveArgs()
   * then moves the prompt after the session ID so Codex receives:
   * codex [global flags] resume <session-id> <prompt>.
   */
  buildCliSuffix(
    sessionId: string | undefined,
    workflowContext?: {
      resolvedProperties?: { resumeSession?: boolean };
    }
  ): string[] {
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      Log.info(`[CodexCliProvider] Resuming session: ${sessionId}`);
      return ["resume", sessionId!];
    }
    return [];
  }

  /**
   * Set up ctrlyoke notification hooks (SessionStart + Stop + user hooks) for interactive mode.
   * Enables the Codex hook system and supplies hooks plus trusted hashes inline.
   *
   * @returns Hook activation args plus trust config overrides.
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planNotificationHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      _workingFilePath,
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
  ): Promise<CliProviderPreparation> {
    const hookEvents = [
      ...new Set<HookEvent>([
        "sessionStart",
        "stop",
        ...enabledNotificationHookEvents,
      ]),
    ];
    const { hookArgs, trustArgs } = this.writeCodexHooks(
      extensionPath,
      workspaceRoot,
      userHooks,
      hookEvents
    );
    Log.debug(
      `[CodexCliProvider] Configured SessionStart + Stop hooks for Codex completion detection`
    );
    return {
      cliArgs: [...CODEX_HOOK_ARGS, ...hookArgs, ...trustArgs],
      mutations: [],
      diagnostics: [],
    };
  }

  /**
   * Set up user-only hooks for headless execution.
   * No ctrlyoke notification hooks are included since headless uses process-exit for completion.
   * Returns hook activation args plus trust config overrides so Codex activates
   * its hook system without prompting during automation.
   */
  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planHeadlessUserHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      _workingFilePath,
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
  ): Promise<CliProviderPreparation> {
    const { hookArgs, trustArgs } = this.writeCodexHooks(
      extensionPath,
      workspaceRoot,
      userHooks,
      enabledNotificationHookEvents
    );
    Log.debug(
      `[CodexCliProvider] Configured user hooks for Codex headless mode`
    );
    return {
      cliArgs: [...CODEX_HOOK_ARGS, ...hookArgs, ...trustArgs],
      mutations: [],
      diagnostics: [],
    };
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   * Uses Codex-specific permission mapper with sandbox/approval settings.
   *
   * Note: --ask-for-approval / -a is only valid in interactive mode (not `codex exec`).
   * isInteractive is forwarded to the mapper so it can omit unsupported flags.
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    if (config === null) {
      // none mode — skip permission flags entirely
      return { cliArgs: [], diagnostics: [] };
    }
    const sandboxMode = ConfigurationUtils.getCodexSandboxMode();
    const approvalPolicy = ConfigurationUtils.getCodexApprovalPolicy();
    return this.toolPermissionMapper.prepare(config, {
      ...context,
      sandboxMode,
      approvalPolicy,
    });
  }

  /**
   * Build ctrlyoke and user hooks as inline Codex config overrides.
   * Shared implementation for interactive and headless hook setup.
   */
  private writeCodexHooks(
    extensionPath: string,
    workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): CodexInlineHooksArgs {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      CODEX_NOTIFICATION_SCRIPT_NAME
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Build hooks section via the notification monitor (single source of truth).
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot,
      userHooks,
      ctrlyokeEvents
    );
    if (hookConfig.type !== HOOK_CONFIG_TYPES.JSON) {
      throw new Error("Unexpected hook config type for Codex CLI");
    }

    const ctrlyokeHooksSection = (hookConfig.config as Record<string, unknown>)[
      "hooks"
    ] as Record<string, unknown[]>;

    const workflowUserHooks = this.buildUserHooksSection(
      userHooks,
      ctrlyokeEvents
    );

    const hooks: Record<string, unknown[]> = { ...ctrlyokeHooksSection };
    for (const [event, groups] of Object.entries(workflowUserHooks)) {
      hooks[event] = [...(hooks[event] ?? []), ...groups];
    }

    return buildCodexInlineHooks(hooks);
  }

  /**
   * Convert ctrlyoke user hooks to the Codex inline hooks section format.
   * Codex uses matcher-based entries: { matcher: "", hooks: [{type, command}] }
   */
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
      const nativeEvent = CodexNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!section[nativeEvent]) section[nativeEvent] = [];
      section[nativeEvent].push(
        createCodexCommandHookGroup(nativeEvent, uh.command)
      );
    }
    return section;
  }

  /**
   * Validate model is supported by Codex CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getCodexCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return undefined;
    }

    // Check if model is in the supported list
    if (CODEX_CLI_MODELS.includes(requestedModel as any)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Codex CLI. Using default: ${defaultModel}`;
    Log.warn(`[CodexCliProvider] ${message}`);

    return defaultModel;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Codex expects: codex exec [OPTIONS] [PROMPT]
   * The prompt argument must come LAST after all flags/options.
   *
   * Handles both direct prompts and file references (e.g., ".ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return [...baseArgs, prompt];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Codex interactive mode:
   * - New session: codex [OPTIONS] [PROMPT]
   * - Resumed session: codex [OPTIONS] resume <SESSION_ID> [PROMPT]
   *
   * Global flags must precede the resume subcommand. In particular, hook trust
   * overrides (`-c hooks.state=...`) must be parsed before resume starts or Codex
   * will prompt for hook approval during resumed sessions.
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    const resumeIndex = baseArgs.lastIndexOf("resume");
    if (resumeIndex >= 0 && resumeIndex === baseArgs.length - 2) {
      return [
        ...baseArgs.slice(0, resumeIndex),
        "resume",
        baseArgs[resumeIndex + 1],
        promptText,
      ];
    }

    return [...baseArgs, promptText];
  }

  /**
   * Format a file path reference for Codex CLI
   *
   * Codex does NOT support @ symbol file references - it interprets them literally.
   * Returns the file path without the @ prefix.
   *
   * @param relativeFilePath Relative file path
   * @returns File path without @ prefix (e.g., ".ctrlyoke/temp/prompt.md")
   */
  formatFileReference(relativeFilePath: string): string {
    // Codex CLI doesn't support @ prefix - just return the path as-is
    return relativeFilePath;
  }

  buildImageAttachmentArgs(imageFilePaths: readonly string[]): string[] {
    return imageFilePaths.flatMap((filePath) => ["--image", filePath]);
  }

  /**
   * Generate MCP server configuration arguments for Codex CLI
   *
   * Codex CLI uses repeated -c/--config overrides in inline TOML format.
   * Supports the built-in ctrlyoke server and user-defined stdio servers.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets CTRLYOKE_WORKING_FILE)
   * @returns CLI arguments array with -c flag, or null if MCP not supported
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
    _secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<CliProviderPreparation> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }

    try {
      const configArgs: string[] = [];

      if (mcpServerPath) {
        configArgs.push(
          "-c",
          CliMcpConfigGenerator.generateInlineTomlConfig(
            MCP_SERVER_IDS.CTRLYOKE,
            mcpServerPath,
            workspaceRoot,
            workingFilePath,
            additionalEnv,
            stateRoot
          )
        );

        configArgs.push(
          "-c",
          `mcp_servers.${MCP_SERVER_IDS.CTRLYOKE}.default_tools_approval_mode=${quoteTomlBasicString("approve")}`
        );
      }

      for (const server of userServers ?? []) {
        if (server.url && server.transport === MCP_TRANSPORTS.SSE) {
          Log.warn(
            `[CodexCliProvider] Codex CLI does not support SSE MCP server "${server.id}". Skipping.`
          );
          continue;
        }

        if (!server.url && !server.command) {
          Log.warn(
            `[CodexCliProvider] Codex CLI MCP server "${server.id}" is missing a command or URL. Skipping.`
          );
          continue;
        }

        if (server.url) {
          const headers = splitCodexHeaders(server.headers);
          configArgs.push(
            "-c",
            CliMcpConfigGenerator.generateInlineTomlRemoteServerConfig(
              server.id,
              server.url,
              headers.staticValues,
              {
                defaultToolsApprovalMode:
                  server.autoApprove === true ? "approve" : undefined,
                disabledTools: server.deniedTools,
                envHttpHeaders: headers.envHttpHeaders,
                bearerTokenEnvVar: headers.bearerTokenEnvVar,
              }
            )
          );
        } else {
          const codexEnvironment = splitCodexEnvironment(server.env);

          configArgs.push(
            "-c",
            CliMcpConfigGenerator.generateInlineTomlStdioServerConfig(
              server.id,
              server.command!,
              server.args,
              codexEnvironment.staticValues,
              {
                defaultToolsApprovalMode:
                  server.autoApprove === true ? "approve" : undefined,
                disabledTools: server.deniedTools,
                envVars: codexEnvironment.envVars,
              }
            )
          );
        }

        configArgs.push(...this.buildToolApprovalOverrideArgs(server));
      }

      if (configArgs.length > 0) {
        Log.debug(
          `[CodexCliProvider] Codex MCP config overrides added for ${configArgs.length / 2} server(s)`
        );
      }

      return {
        cliArgs: configArgs,
        mutations: [],
        diagnostics: [],
      };
    } catch (error) {
      Log.error(
        "[CodexCliProvider] Failed to generate MCP config for Codex CLI",
        error
      );
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }
  }

  /**
   * Check if Codex CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability(
      CodexCliProvider.CLI_VERSION_COMMAND
    );
  }

  /**
   * Get Codex CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion(
      CodexCliProvider.CLI_VERSION_COMMAND,
      {
        parseVersion: (stdout) => {
          // Extract version from output like "codex version 0.1.2"
          const match = stdout.match(/codex version ([\d.]+)/i);
          return match ? match[1] : stdout;
        },
      }
    );
  }
}
