import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import {
  UnsupportedSandboxMapper,
  unsupportedSandboxCapabilities,
} from "../shared/SandboxCapabilities";
import * as path from "path";
import * as fs from "fs";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { installCommandFor } from "../shared/HarnessInstallCommand";
import {
  DEFAULT_MODELS,
  HARNESS_IDS,
  HEADLESS_PROMPT_DELIVERIES,
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
import {
  capabilitySuiteVerification,
  type HarnessCapabilityFacts,
} from "../../../types/CompatibilityTypes";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
  OpenCodeUserHookConfig,
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
  type OpenCodeInlinePluginSlice,
} from "./OpenCodeInlineConfig";
import {
  OPENCODE_CLI_FLAGS,
  OPENCODE_PLUGIN_PATHS,
  OPENCODE_RESUME_PROMPT_ENV,
  OPENCODE_RESUMED_PROMPT_DELIVERIES,
  type OpenCodeResumedPromptDelivery,
} from "./OpenCodeProtocolConstants";
import { detectOpenCodeV2, OPENCODE_VERSION_COMMAND } from "./OpenCodeVersion";
import { type SessionProbeResult } from "../../../types/DashboardConstants";
import { HARNESS_SHELL_ESCAPE_PREFIX } from "../../../utils/HarnessShellEscape";

/**
 * How a resumed interactive step delivers its prompt on OpenCode 1.
 *
 * OpenCode 1's TUI ignores `--prompt` when `--session` is also given: it opens
 * the session and waits for input, so the step never starts
 * (anomalyco/opencode#21829, closed "not planned"). The ctrlyoke plugin submits
 * the prompt through OpenCode's server instead. The rewritten OpenCode 2 TUI
 * opens the session with the startup prompt and submits it, and its plugin API
 * has no `client.session.promptAsync`, so OpenCode 2 always uses `ARGUMENT`
 * (see resumedPromptDelivery()).
 *
 * Only relaunches are affected: terminal reuse types follow-up prompts into the
 * running TUI and never resumes by argument.
 */
const OPENCODE_V1_RESUMED_PROMPT_DELIVERY: OpenCodeResumedPromptDelivery =
  OPENCODE_RESUMED_PROMPT_DELIVERIES.PLUGIN;

/**
 * Resumed-prompt delivery for a launch. planCliArgs() adds --standalone to
 * every OpenCode 2 launch except one where the user chose --server; neither
 * flag exists in OpenCode 1, so either marks an OpenCode 2 launch.
 */
function resumedPromptDelivery(
  baseArgs: readonly string[]
): OpenCodeResumedPromptDelivery {
  return baseArgs.includes(OPENCODE_CLI_FLAGS.STANDALONE) ||
    baseArgs.includes(OPENCODE_V2_SERVER_FLAG)
    ? OPENCODE_RESUMED_PROMPT_DELIVERIES.ARGUMENT
    : OPENCODE_V1_RESUMED_PROMPT_DELIVERY;
}

/** A resumed interactive prompt the plugin submits after OpenCode starts. */
interface OpenCodeResumePrompt {
  sessionId: string;
  model: string | undefined;
  text: string;
}

/** OpenCode 2's flag for an explicit server; it cannot combine with --standalone. */
const OPENCODE_V2_SERVER_FLAG = "--server";

/** Value that follows `flag` in `args`, if the flag is present. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// The capability suite finds denied tools still callable:
// dev/bugs/backlog/opencode-mcp-tool-deny-rules-never-match.md.
const OPENCODE_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "manual",
    reference: "src/core/harness/opencode/OpenCodeToolPermissionMapper.ts",
    basis: "cli-version",
    verifiedVersions: [">=1.3.16"],
  },
} as const;

const OPENCODE_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: capabilitySuiteVerification([">=1.3.16"]),
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
 * Headless execution (prompt on stdin):
 *   opencode run --format json -m provider/model [-s sessionId]               (OpenCode 1)
 *   opencode run --standalone --format json -m provider/model [-s sessionId]  (OpenCode 2)
 *
 * Interactive execution (with plugin for completion detection):
 *   opencode --prompt "prompt text" -m provider/model                        (OpenCode 1)
 *   opencode -m provider/model -s sessionId   (OpenCode 1; prompt submitted by the plugin;
 *                                               see OPENCODE_V1_RESUMED_PROMPT_DELIVERY)
 *   opencode --prompt "prompt text" --standalone [-s sessionId]              (OpenCode 2;
 *                                               model in the inline config)
 *   (plugin loaded from the extension installation through inline config:
 *    `plugin: [file]` on OpenCode 1, `plugins: [directory]` on OpenCode 2)
 *
 * OpenCode 2 is detected from `--version` (OpenCodeVersion.ts) because these
 * launch differences cannot be read from output. Output parsing tells the two
 * generations apart by shape.
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
  canSendPromptToRunningTerminal(promptText: string): boolean {
    return !promptText.includes(HARNESS_SHELL_ESCAPE_PREFIX);
  }

  wrapTerminalPromptForPaste(promptText: string): string {
    return `\x1b[200~${promptText}\x1b[201~`;
  }

  /**
   * The plugin writes subagent records to `<notifyDir>/<runId>-subagents.jsonl`
   * in both modes, so the parser must know where on every launch, not only
   * when interactive hooks are planned.
   */
  setRunId(runId: string, notifyDir: string | undefined): void {
    this.logParser.setSubagentSidecar(notifyDir, runId);
  }
  private static readonly CLI_COMMAND = "opencode";
  static readonly CLI_VERSION_COMMAND = OPENCODE_VERSION_COMMAND;
  static readonly CLI_HELP_COMMAND = `${OpenCodeCliProvider.CLI_COMMAND} --help`;

  readonly config: HarnessConfig = {
    name: "opencode",
    harnessId: HARNESS_IDS.OPENCODE_CLI,
    displayName: "OpenCode CLI",
    terminalName: "OpenCode",
    // Fresh installs get OpenCode 2. `opencode.ai/install` and the
    // `opencode-ai` npm package only ever install OpenCode 1 (the script
    // refuses 2.x); OpenCode 2 has its own script and `@opencode/cli`.
    installCommand: installCommandFor({
      posix: "curl -fsSL https://opencode.ai/v2/install | bash",
      // OpenCode has no native Windows installer script, and npm needs no
      // extra package manager.
      windows: "npm install -g @opencode/cli",
    }),
    // Stays on the OpenCode 1 package: `versionPolicy.minimum` is a 1.x
    // release, and the version-floor and minimum-version scripts look up
    // and install that release from here.
    npmPackage: "opencode-ai",
    versionPolicy: {
      minimum: "1.3.16",
      testedWith: "2.2.6",
      updateCommand: "opencode upgrade",
    },
    shouldStreamHeadlessOutput: true,
    // `opencode run` wraps every positional message argument containing a
    // space in literal quotes (escaping any inner `"`) before sending it to
    // the model, but uses piped stdin verbatim when no message is given.
    headlessPromptDelivery: HEADLESS_PROMPT_DELIVERIES.STDIN,

    // OpenCode uses a TypeScript plugin system for interactive completion detection
    usesInteractiveNotificationMonitor: true,
  };

  /** The fully-qualified model ID used for the most-recently started execution (e.g. "anthropic/claude-sonnet-4-6"). */
  private resolvedCurrentModel: string =
    DEFAULT_MODELS[HARNESS_IDS.OPENCODE_CLI];

  readonly notificationMonitor = new OpenCodeNotificationMonitor();
  readonly toolPermissionMapper = new OpenCodeToolPermissionMapper();
  readonly sandboxMapper = new UnsupportedSandboxMapper(
    HARNESS_IDS.OPENCODE_CLI,
    unsupportedSandboxCapabilities(SANDBOX_CAVEAT_CODE.OPENCODE_UNUSABLE)
  );
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      sandbox: this.sandboxMapper.capabilities,
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

  probeResumableSession(
    sessionId: string,
    workspaceRoot: string
  ): Promise<SessionProbeResult> {
    return this.logParser.probeSessionId(sessionId, workspaceRoot);
  }

  isRecoverableSessionError(
    input: string | Error | { stdout?: string; stderr?: string }
  ): boolean {
    const message =
      typeof input === "string"
        ? input
        : input instanceof Error
          ? input.message
          : `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
    return message.includes("Session not found");
  }

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
    const permission = this.toolPermissionMapper.buildPermissionPolicy(
      options.toolPermissions ?? undefined,
      options.permissionCollisionContext,
      options.externalDirectories
    );
    const mcpEntries = buildOpenCodeMcpEntries(
      options.mcpServerPath,
      options.workspaceRoot,
      options.workingFilePath,
      options.additionalEnv,
      options.userServers,
      options.stateRoot,
      options.secretOptions,
      options.openCodeV2 === true
    );
    return {
      ...(permission ? { permission } : {}),
      ...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
      ...OpenCodeCliProvider.buildPluginSlice(
        options.extensionPath,
        options.openCodeV2 === true
      ),
    };
  }

  /** Installed path of the ctrlyoke plugin entry for one CLI generation. */
  static pluginEntryPath(extensionPath: string, openCodeV2: boolean): string {
    return path.resolve(
      extensionPath,
      "out",
      "scripts",
      openCodeV2
        ? OPENCODE_PLUGIN_PATHS.V2_DIRECTORY
        : OPENCODE_PLUGIN_PATHS.V1_FILE
    );
  }

  /**
   * OpenCode converts absolute paths to file:// URLs itself. Keeping the path
   * here also avoids having to escape Windows drive letters/spaces.
   */
  private static buildPluginSlice(
    extensionPath: string,
    openCodeV2: boolean
  ): OpenCodeInlinePluginSlice {
    const entry = OpenCodeCliProvider.pluginEntryPath(
      extensionPath,
      openCodeV2
    );
    return openCodeV2 ? { plugins: [entry] } : { plugin: [entry] };
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
    const openCodeV2 = await detectOpenCodeV2();
    // The integration is reused across prompts in one workflow. Reset before
    // optional MCP or permission preparation so a later prompt cannot inherit
    // either slice when its workspace or policy is absent.
    const inlinePluginSlice = OpenCodeCliProvider.buildPluginSlice(
      extensionPath,
      openCodeV2
    );

    const args: string[] = [];

    // Extra CLI flags from additionalArgs (appended before prompt positional arg)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    // OpenCode 2 rejects --standalone together with a user's --server; an
    // explicit server is the user's choice, and its config is then theirs too.
    const standalone =
      openCodeV2 && !appendTokens.includes(OPENCODE_V2_SERVER_FLAG);

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
    }
    if (standalone) {
      args.push(OPENCODE_CLI_FLAGS.STANDALONE);
    }
    if (!isInteractive) {
      args.push("--format", "json");
    }

    // Model selection — use resolved property if available. The OpenCode 2
    // TUI has no -m flag, so an interactive V2 launch carries it as config.
    const model = this.getModel(resolvedModel);
    const modelAsConfig = openCodeV2 && isInteractive;
    if (model && !modelAsConfig) {
      args.push(OPENCODE_CLI_FLAGS.MODEL, model);
    }
    const inlineModel = model && modelAsConfig ? model : undefined;

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
            this.pendingInlineConfig = {
              ...inlinePluginSlice,
              ...(inlineModel ? { model: inlineModel } : {}),
            };
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
                    openCodeV2,
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
   * opencode run --format json -m model [-s sessionId] [--file ...]
   *
   * The prompt is not an argument: `config.headlessPromptDelivery` is
   * `STDIN`, so the transport pipes it in. With no positional message there
   * is nothing for OpenCode's greedy `--file` array to swallow.
   *
   * @param baseArgs Base arguments array (already includes "run", "--format", "json", "-m", model)
   * @returns The arguments unchanged
   */
  buildHeadlessArgs(baseArgs: string[], _prompt: string): string[] {
    return [...baseArgs];
  }

  /**
   * Build CLI arguments for interactive TUI mode.
   *
   * opencode --prompt "prompt text" -m model          (OpenCode 1)
   * opencode --prompt "prompt text" --standalone      (OpenCode 2; model in config)
   *
   * On OpenCode 1 a resumed session (`-s`) omits `--prompt` and hands the
   * prompt to the plugin through getInteractiveSpawnEnv() instead; see
   * OPENCODE_V1_RESUMED_PROMPT_DELIVERY.
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
      resumedPromptDelivery(baseArgs) ===
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
   * OpenCode's TUI treats a leading `@` as an agent-mention trigger: with terminal
   * reuse we write text straight into the running TUI, so an `@path` prefix gets
   * intercepted and rewritten to an agent invocation (e.g. `@explore`) before it
   * ever reaches the model. OpenCode does not auto-read `@`-prefixed paths anyway
   * — it decides to read referenced files on its own from the plain path — so we
   * drop the `@` entirely, mirroring Codex. This applies uniformly to simple,
   * sent-to-terminal, and categorized prompts because every ref routes through here.
   *
   * @param relativeFilePath Relative or absolute file path
   * @returns File path without an `@` prefix
   */
  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  /**
   * Since nothing reads these plain paths for the model, it often does not
   * resolve a relative one against its working directory and searches other
   * folders for it (e.g. globbing the home directory, which headless
   * permissions deny). An absolute path leaves nothing to resolve.
   */
  readonly requiresAbsoluteFileReferences = true;

  /**
   * Headless `run` attaches images with `--file`. The TUI has no attachment
   * flag; the image path stays in the prompt and OpenCode's `read` tool loads
   * it as an image.
   */
  buildImageAttachmentArgs(
    imageFilePaths: readonly string[],
    isInteractive: boolean
  ): string[] {
    return isInteractive
      ? []
      : imageFilePaths.flatMap((filePath) => ["--file", filePath]);
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
      ),
      await detectOpenCodeV2()
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
   * `none` and `dangerouslyAllowAll` emit only the `external_directory`
   * grants for trusted roots, leaving every other rule to OpenCode.
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
    const externalDirectories = context.externalDirectories ?? [];
    if (
      (toolPermissions === null || toolPermissions === undefined) &&
      externalDirectories.length === 0
    ) {
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
    // OpenCode 1 deep-merges each config layer's `permission` map, so a key the
    // user also wrote would replace ours, and colliding keys are renamed to
    // novel globs (`bash` → `bash*`). OpenCode 2 instead appends every layer's
    // rules to one ordered list evaluated last-match-wins, with the inline
    // config loaded after project files, so ours already win. It also migrates
    // only the exact V1 keys (`bash` → `shell`), so a renamed `bash*` would
    // never match `shell` and the rule would silently do nothing.
    const collisionContext = (await detectOpenCodeV2())
      ? undefined
      : (context.permissionCollisionContext ??
        (await resolveOpenCodePermissionCollisionContext(
          context.workspaceRoot,
          context.environment
        )));
    // Trusted roots are granted in every mode, as `--add-dir` is elsewhere.
    const policy = this.toolPermissionMapper.buildPermissionPolicy(
      toolPermissions ?? undefined,
      collisionContext,
      externalDirectories
    );
    const application = toolPermissions
      ? await this.toolPermissionMapper.prepare(toolPermissions, context)
      : { cliArgs: [], diagnostics: [] };
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
    await this.logParser.cleanupSubagentSidecar();
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

    // Fall back to user-configured default. None means OpenCode should use its
    // own configuration, and an unset default should not invent a model.
    const configuredDefault = ConfigurationUtils.getOpenCodeCliModel();
    if (configuredDefault?.includes("/")) {
      if (resolvedModel) {
        Log.warn(
          `[OpenCodeCliProvider] OpenCode: model "${resolvedModel}" does not use provider/model format. ` +
            `Expected format: provider/model (e.g., anthropic/claude-sonnet-4-6). Using configured default "${configuredDefault}".`
        );
      }
      return configuredDefault;
    }

    if (resolvedModel) {
      Log.warn(
        `[OpenCodeCliProvider] OpenCode: model "${resolvedModel}" does not use provider/model format. ` +
          `Expected format: provider/model (e.g., anthropic/claude-sonnet-4-6). ` +
          (configuredDefault === MODEL_NONE
            ? "No model flag will be passed; OpenCode will use its configured model."
            : configuredDefault
              ? "Using the built-in default model."
              : "No model flag will be passed.")
      );
    }

    if (configuredDefault === MODEL_NONE) return undefined;
    return configuredDefault
      ? DEFAULT_MODELS[HARNESS_IDS.OPENCODE_CLI]
      : undefined;
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
      supportedHooks.map((hook) => {
        const scopedHook: OpenCodeUserHookConfig = hook;
        return {
          event: hook.event,
          command: hook.command,
          ...(hook.timeoutSec !== undefined
            ? { timeoutSec: hook.timeoutSec }
            : {}),
          ...(scopedHook.envFile ? { envFile: scopedHook.envFile } : {}),
          ...(scopedHook.envId ? { envId: scopedHook.envId } : {}),
        };
      })
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
    openCodeV2: boolean,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    if (openCodeV2) {
      // The V2 entry is a directory whose index.ts imports the V1 file beside
      // it. The workspace fallback below copies a single V1 file, which OpenCode
      // 2 would not load as a plugin, so there is nothing to fall back to.
      const entry = path.join(
        OpenCodeCliProvider.pluginEntryPath(extensionPath, true),
        "index.ts"
      );
      await fs.promises
        .access(entry, fs.constants.R_OK)
        .catch((error) =>
          Log.warn(
            `[OpenCodeCliProvider] OpenCode 2 plugin entry is not readable at ${entry}; completion will not be detected: ${error}`
          )
        );
      return;
    }
    const sourcePath = OpenCodeCliProvider.pluginEntryPath(
      extensionPath,
      false
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
