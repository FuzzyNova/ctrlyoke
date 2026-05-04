import type { IResponseParser } from "./IResponseParser";
import type { INotificationMonitor } from "./INotificationMonitor";
import type {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "./IToolPermissionMapper";
import type { ILogParser } from "./ILogParser";
import type {
  HookEvent,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../../types/FlightPathTypes";
import type { UniversalCliOutput } from "../../../../types/CliOutputTypes";
import type { HarnessId } from "../../../../types/DashboardConstants";

/** Timeout for CLI version-check subprocesses (checkAvailability + getVersion) */
export const CLI_VERSION_CHECK_TIMEOUT_MS = 30_000;

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

  /** Installation hint when CLI not found */
  installHint: string;

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
 *   readonly responseParser = new CopilotResponseParser();
 *   readonly notificationMonitor = new CopilotNotificationMonitor();
 *   readonly toolPermissionMapper = new CopilotToolPermissionMapper();
 *
 *   buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
 *     return [...baseArgs, promptFileRef];
 *   }
 *   // ... implement other methods
 * }
 * ```
 */
export interface ICliProvider {
  /** Static harness configuration */
  readonly config: HarnessConfig;

  /** Response parser component */
  readonly responseParser: IResponseParser;

  /** Notification monitor component */
  readonly notificationMonitor: INotificationMonitor;

  /** Tool permission mapper component */
  readonly toolPermissionMapper: IToolPermissionMapper;

  /** Log parser component (for log file monitoring in interactive mode) */
  readonly logParser?: ILogParser;

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
    }
  ): Promise<string[]>;

  /**
   * Build CLI arguments for headless mode
   * Handles both direct prompts and file references identically
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[];

  /**
   * Build CLI command for interactive TUI mode
   * @param baseArgs Base arguments array
   * @param promptText The prompt text to include in command arguments
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string;

  /**
   * Format a file path reference for this CLI.
   * Default (when not implemented): "@path" — most CLIs accept @ as a file attachment prefix.
   * Override only when the CLI uses a different convention (e.g., Codex uses no prefix).
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path" or "path")
   */
  formatFileReference?(relativeFilePath: string): string;

  /**
   * Generate MCP server configuration arguments (optional)
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets FLIGHTPATH_WORKING_FILE)
   * @returns CLI arguments array, or null if MCP not supported
   */
  getMcpConfigArgs?(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null>;

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
   * for hook registration (e.g., Gemini writes .gemini/settings.json, Qwen writes
   * .qwen/settings.json). Called by CliIntegration.cleanupWorkflowArtifacts()
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
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes.
   * For undefined toolPermissions, falls back to global ConfigurationUtils settings.
   * For null toolPermissions (none mode), returns [] — no permission flags injected.
   * Returns permission args to append to baseArgs after all other args.
   */
  buildPermissionArgs?(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): string[];

  /**
   * Set up FlightPath notification hooks for interactive mode completion detection.
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
   * @returns Session ID if found in logs, undefined otherwise
   */
  extractSessionIdFromLogs?(
    promptText: string,
    startTime: Date
  ): Promise<string | undefined>;

  /**
   * Augment parsed output after the response parser runs (optional).
   *
   * Called by CliIntegration immediately after responseParser.parse() in headless mode.
   * Use for post-parse data enrichment that requires async work the synchronous parser
   * cannot do (e.g., reading session log files to retrieve token usage data).
   *
   * Return the same or a modified UniversalCliOutput. Must not throw.
   *
   * @param output - Output from responseParser.parse()
   * @returns Enriched output (or same object if no changes needed)
   */
  augmentParsedOutput?(output: UniversalCliOutput): Promise<UniversalCliOutput>;
}
