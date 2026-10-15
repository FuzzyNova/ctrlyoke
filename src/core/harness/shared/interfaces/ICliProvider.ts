import type { INotificationMonitor } from "./INotificationMonitor";
import type {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "./IToolPermissionMapper";
import type { CliProviderPreparation } from "./PreparedMutation";
export type {
  CliProviderPreparation,
  PreparedMutation,
} from "./PreparedMutation";
import type { BaseCliEvent, ILogParser } from "./ILogParser";
import type { HarnessVersionPolicy } from "../../../../utils/HarnessVersion";
import type {
  HookEvent,
  PromptFile,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../../utils/PropertyResolver";
import type { UniversalCliOutput } from "../../../../types/CliOutputTypes";
import type {
  HarnessId,
  HeadlessSourceMode,
} from "../../../../types/DashboardConstants";
import type { HarnessCapabilityFacts } from "../../../../types/CompatibilityTypes";
import type { CliEvent } from "../../../../types/CliOutputTypes";
import type { HarnessQuotaSnapshot } from "../../../../types/UsageTypes";
import type { StatuslineInstallResult } from "../StatuslineManager";

/** Timeout for CLI version/help-check subprocesses. */
export const CLI_VERSION_CHECK_TIMEOUT_MS = 30_000;

/** Disposable sidecar that runs for the lifetime of one CLI execution. */
export interface CliExecutionSidecar {
  stop(): void;
}

/** Host callbacks and execution metadata supplied to a provider sidecar. */
export interface CliExecutionSidecarDeps {
  workspaceRoot: string;
  model: string;
  onStreamingEvents: (events: CliEvent[]) => void;
  onContextWindowUpdate: (used: number, size: number) => void;
  /** Optional injected port for provider-live usage signals. */
  onProviderUsageUpdate?: (quota: HarnessQuotaSnapshot) => void;
}

/**
 * Harness configuration (static metadata)
 */
export interface HarnessConfig {
  /** Harness name (e.g., "copilot", "claude", "codex") */
  name: string;

  /** Canonical harness ID from HARNESS_IDS (e.g., HARNESS_IDS.CLAUDE_CLI) */
  harnessId: HarnessId;

  /** Display name for status messages */
  displayName: string;

  /** Short name for VS Code terminal tab (e.g., "Claude", "Copilot", "Codex") */
  terminalName: string;

  /** Installation hint when CLI not found, for this host OS (`installHintFor`) */
  installHint: string;

  /**
   * npm package that publishes this CLI, when there is one. It is not the
   * recommended install (see `installHint`); `scripts/harness-version-floors.mjs`
   * reads its publish dates to suggest a support-window minimum.
   */
  npmPackage?: string;

  /**
   * Supported CLI version window, enforced once at detection by
   * `CliIntegration.initialize()`. Below `minimum` the harness is unavailable.
   */
  versionPolicy: HarnessVersionPolicy;

  /** Whether to stream headless output in real-time */
  shouldStreamHeadlessOutput: boolean;

  /**
   * Whether this provider uses notification-based completion detection in interactive mode.
   * When true, CliIntegration will use log file monitoring for completion detection.
   * When false or undefined, only fallback completion detection is used.
   *
   * - Claude: true (monitors JSONL log files for completion events)
   * - Copilot: true (monitors process log files for sessionEnd events)
   * - Codex: true (monitors JSONL log files for turn.completed events)
   */
  usesInteractiveNotificationMonitor?: boolean;

  /**
   * When true, the harness emits pre-formatted plain text rather than markdown.
   * The UI must skip the markdown rendering pipeline to avoid double-rendering
   * artifacts (e.g., garbled table syntax, double-escaped symbols).
   *
   * Set to true for harnesses with no --json/structured-output mode that
   * pre-render headings, tables, and chrome themselves (currently: copilot-cli).
   */
  rawTextOutput?: boolean;
}

/**
 * Main CLI harness provider - each CLI harness must implement this
 *
 * This is the core contract for CLI integration. All harness-specific logic
 * is encapsulated in implementations of this interface.
 *
 * @example
 * ```typescript
 * class CopilotCliProvider implements ICliProvider {
 *   readonly config: HarnessConfig = { ... };
 *   readonly notificationMonitor = new CopilotNotificationMonitor();
 *   readonly toolPermissionMapper = new CopilotToolPermissionMapper();
 *
 *   buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
 *     return [...baseArgs, promptFileRef];
 *   }
 *   buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
 *     return ["--prompt", promptText, ...baseArgs];
 *   }
 *   // ... implement other methods
 * }
 * ```
 */
export interface ICliProvider {
  /** Static harness configuration */
  readonly config: HarnessConfig;

  /** Harness-owned compatibility facts exposed to the shared registry. */
  readonly capabilities: HarnessCapabilityFacts;

  /** Notification monitor component */
  readonly notificationMonitor: INotificationMonitor;

  /** Tool permission mapper component */
  readonly toolPermissionMapper: IToolPermissionMapper;

  /** Log parser component (for log file monitoring in interactive mode) */
  readonly logParser?: ILogParser;

  /**
   * Select the event source for headless execution.
   *
   * An explicit value wins over inference from the hooks below, so a provider
   * that can parse its own stdout may still pin itself to the richer session
   * log. Resolved in one place by `resolveHeadlessSourceMode()`.
   */
  readonly headlessSource?: HeadlessSourceMode;

  /**
   * Convert one complete headless stdout record into the event vocabulary
   * understood by this provider's log parser. CliTransportCoordinator buffers
   * raw transport chunks, so this pure hook is never given a partial record.
   *
   * A provider implementing this method is stdout-sourced: the returned
   * events are passed through the log parser's response mapping. This method
   * must not return CliEvent[] directly or introduce a second event mapping.
   */
  parseHeadlessStdout?(stdout: string): BaseCliEvent[];

  /**
   * Extract a session ID from complete headless stdout records. HeadlessLogTail
   * owns transport-chunk accumulation and flushes one unterminated tail at
   * process exit before calling this hook.
   *
   * This is a narrow session-ID lookup, not a response parser. A provider
   * implementing only this method is log-sourced: stdout supplies the
   * session-ID carrier while the session log supplies the events. Providers
   * implementing parseHeadlessStdout() may also implement this method when
   * their stdout carries the session ID.
   */
  extractSessionIdFromStdout?(chunk: string): string | undefined;

  /**
   * Observe raw headless stdout for narrow provider-specific enrichment.
   * This must not become a second event-mapping path; headless events still
   * come from the provider's selected stdout or session-log source.
   */
  observeHeadlessStdout?(chunk: string): void;

  /**
   * Headless stdout has ended. Providers implementing
   * observeHeadlessStdout() use this to flush an unterminated final record
   * before the post-exit log read produces final output.
   */
  finishHeadlessStdout?(): void;

  /** Input accepted by provider-specific invalid-session classifiers. */
  isRecoverableSessionError?(
    input: string | Error | { stderr?: string }
  ): boolean;

  /**
   * Build complete CLI arguments array for execution
   *
   * This is the main method for constructing CLI-specific arguments including:
   * - Model selection
   * - Tool permissions
   * - Session management
   * - Workspace directories
   * - Harness-specific flags (e.g., -p, --output-format for Claude)
   * - Hooks/notifications for interactive mode
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param context Extension context for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
   * @param workspaceRoots Every open workspace-folder root. This is distinct
   *   from workspaceRoot, which remains the primary root for cwd and
   *   workspace-scoped artifacts. Providers that support --add-dir must add
   *   every supplied root.
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
  buildCliArgs(
    prompt: PromptStep,
    isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      stateRoot?: string;
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<string[]>;

  /**
   * Assemble provider arguments and deferred provider-owned mutations without
   * touching the workspace or process state.
   */
  planCliArgs?(
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
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<CliProviderPreparation>;

  /**
   * Build CLI arguments for headless mode
   * Handles both direct prompts and file references identically
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference (e.g., "@.ctrlyoke/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[];

  /**
   * Build CLI arguments for interactive TUI mode
   * @param baseArgs Base arguments array
   * @param promptText The prompt text to include in command arguments
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[];

  /**
   * Start a provider-specific sidecar for one execution.
   *
   * The sidecar is started for both interactive and headless executions at
   * their shared integration boundary and is always stopped when that
   * execution branch completes.
   */
  startExecutionSidecar?(
    deps: CliExecutionSidecarDeps
  ): CliExecutionSidecar | undefined;

  /** Consume the result of the statusline install mutation for host feedback. */
  consumeStatuslineInstallResult?(): StatuslineInstallResult | undefined;

  /**
   * Format a file path reference for this CLI.
   * Default (when not implemented): "@path" — most CLIs accept @ as a file attachment prefix.
   * Override only when the CLI uses a different convention (e.g., Codex uses no prefix).
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path" or "path")
   */
  formatFileReference?(relativeFilePath: string): string;

  /**
   * Build native CLI arguments for resolved image attachments. Providers that
   * do not expose a verified native image-input mechanism leave this unset.
   */
  buildImageAttachmentArgs?(
    imageFilePaths: readonly string[],
    isInteractive: boolean
  ): string[];

  /**
   * Generate MCP server configuration arguments (optional)
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets CTRLYOKE_WORKING_FILE)
   * @returns CLI arguments array, or null if MCP not supported
   */
  getMcpConfigArgs?(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<string[] | null>;

  /** Plan MCP arguments and deferred mutations without touching the filesystem. */
  planMcpConfigArgs?(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<CliProviderPreparation>;

  /**
   * Return the path of the MCP config file this provider writes (optional).
   *
   * Used by CliIntegration to delete the file after the workflow finishes.
   * Only providers that write a file-based config need to implement this
   * (Copilot, Claude). Providers that embed config inline (Codex) do not.
   *
   * Must use CliMcpConfigGenerator.getConfigFilePath() so the path always
   * matches what getMcpConfigArgs() wrote.
   *
   * @param workingFilePath Active working file path used when the config was created
   * @param workspaceRoot Workspace root directory
   * @returns Absolute path to the config file, or null if no file is used
   */
  getMcpConfigFilePath?(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string | null;

  /**
   * Return additional file paths to delete after workflow cleanup.
   *
   * Used by providers that write interactive-mode setup files that are
   * not covered by getMcpConfigFilePath() (e.g., OpenCode plugin file).
   * CliIntegration.cleanupWorkflowArtifacts() deletes all returned paths.
   *
   * @param workspaceRoot Workspace root directory
   * @returns Array of absolute file paths to delete (empty array = nothing to clean up)
   */
  getAdditionalCleanupFilePaths?(workspaceRoot: string): string[];

  /**
   * Restore workspace files modified during interactive hook setup.
   *
   * Used by providers that write (and must restore) workspace-level config files
   * for hook registration (e.g., Qwen writes .qwen/settings.json). Called by
   * CliIntegration.cleanupWorkflowArtifacts()
   * after the workflow completes.
   *
   * Providers that only delete temp files should use getAdditionalCleanupFilePaths()
   * instead — this method is specifically for backup-and-restore patterns.
   *
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath The working file path for this workflow run (unique key)
   */
  cleanupWorkspaceArtifacts?(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void>;

  /**
   * Whether workspace artifacts must remain registered while a reusable CLI
   * process is retained between executions. Most CLIs load hooks at process
   * startup and should use the default eager cleanup. Providers whose injected
   * turns re-read hook/config files opt into deferred cleanup.
   */
  shouldRetainWorkflowArtifactsForReuse?(): boolean;

  /**
   * Delete hook artifacts written for the previous prompt before building hooks for the next.
   * Called by CliIntegration at the start of each prompt's hook setup phase.
   *
   * Providers that write per-prompt hook files (Copilot: .github/hooks/*.json,
   * Claude: .ctrlyoke/temp/claude-hook-settings-*.json) implement this to prevent
   * files from previous prompts accumulating and firing unintended hooks.
   *
   * Providers that use ref-counted settings.json (Codex, Qwen) do not need
   * this — registerWorkflow() replaces the workflow's entry on each call.
   */
  cleanupPreviousPromptHooks?(workspaceRoot: string): Promise<void>;

  /**
   * Prepare permission arguments, workspace mutations, and compatibility
   * diagnostics before the harness process starts.
   *
   * Providers may add harness-specific preparation around their mapper (for
   * example OpenCode's process-local inline configuration), but all permission
   * outputs must be returned through this application contract.
   */
  prepareToolPermissions?(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;

  /** Pure permission preparation for shared execution-plan assembly. */
  planToolPermissions?(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;

  /**
   * Set up ctrlyoke notification hooks for interactive mode completion detection.
   * Called only in interactive mode (when workspaceRoot is defined).
   * Returns additional CLI args to append to baseArgs (e.g. ["--settings", path]).
   * Replaces the interactive-mode hook block that was previously inside buildCliArgs().
   */
  buildNotificationHookArgs?(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]>;

  /** Plan notification-hook arguments and deferred mutations without side effects. */
  planNotificationHookArgs?(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation>;

  /**
   * Set up user-defined hooks for headless execution.
   * Called only in headless mode when userHooks are defined and workspaceRoot is set.
   * Returns additional CLI args to prepend to baseArgs (empty if hooks are file-based).
   * Replaces the headless user-hook block that was previously inside buildCliArgs().
   */
  buildHeadlessUserHookArgs?(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]>;

  /** Plan headless hook arguments and deferred mutations without side effects. */
  planHeadlessUserHookArgs?(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation>;

  /**
   * Check if CLI is available on the system
   * @returns True if CLI executable found
   */
  checkAvailability(): Promise<boolean>;

  /**
   * Get CLI version string
   * @returns Version string if available
   */
  getVersion?(): Promise<string | undefined>;

  /**
   * Return environment variable overrides for interactive spawning.
   * Use this to unset variables that conflict with the child process
   * (e.g., CLAUDECODE blocks nested Claude CLI sessions).
   * If not defined, CliIntegration defaults to CliProviderUtils.buildProcessEnv().
   */
  getInteractiveSpawnEnv?(): NodeJS.ProcessEnv;

  /**
   * Return headless-only environment overrides.
   * Use this when a harness must see specific variables on the parent process
   * at spawn time as well as on the spawned child.
   */
  getHeadlessSpawnEnv?(): NodeJS.ProcessEnv;

  /**
   * Extract session ID from log files (optional)
   *
   * For CLIs that don't include session ID in their output (like Copilot),
   * this method provides an alternative way to extract session IDs from
   * log files written by the CLI.
   *
   * Called by CliIntegration after execution if:
   * - parsed.sessionId is undefined (no session ID in output)
   * - This method is implemented by the provider
   *
   * @param promptText The prompt text that was sent (used to match the correct session log)
   * @param startTime When execution started (used to filter recently modified logs)
   * @param workspaceRoot The workspace root the CLI was run against (used by providers whose
   *   session-log cache is keyed by workspace path, e.g. Antigravity's `last_conversations.json`)
   * @returns Session ID if found in logs, undefined otherwise
   */
  extractSessionIdFromLogs?(
    promptText: string,
    startTime: Date,
    workspaceRoot?: string
  ): Promise<string | undefined>;

  /**
   * Augment headless output after event mapping (optional).
   *
   * Use for post-parse data enrichment that requires async work the event mapper
   * cannot do (e.g., reading Copilot's OTel export for context-window data).
   *
   * Return the same or a modified UniversalCliOutput. Must not throw.
   *
   * @param output - Output from the provider's log parser
   * @returns Enriched output (or same object if no changes needed)
   */
  augmentParsedOutput?(output: UniversalCliOutput): Promise<UniversalCliOutput>;

  /**
   * Build CLI arguments that must appear AFTER all other args (hooks, permissions, etc.).
   *
   * Use this for CLI subcommands that must be the last positional token in the assembled
   * command — specifically Codex's `resume <session-id>`, which is a subcommand rather
   * than a flag. Placing it before global flags (`--enable hooks`, `-c hooks.state=...`)
   * causes those flags to be parsed as subcommand args instead of global config, breaking
   * hook trust-state injection.
   *
   * Called by CliIntegration after hook args and permission args are pushed onto baseArgs.
   * Other providers leave this unimplemented (returns undefined → treated as []).
   *
   * @param sessionId Resolved session ID for resumption (if any)
   * @param workflowContext Optional workflow context (resolvedProperties.resumeSession used)
   * @returns Args to append last, or undefined (treated as empty)
   */
  buildCliSuffix?(
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      resolvedProperties?: { resumeSession?: boolean };
      workingFilePath?: string;
    }
  ): string[];
}
