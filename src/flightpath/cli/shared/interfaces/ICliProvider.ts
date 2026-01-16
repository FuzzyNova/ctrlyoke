import type { IResponseParser } from "./IResponseParser";
import type { INotificationMonitor } from "./INotificationMonitor";
import type { IToolPermissionMapper } from "./IToolPermissionMapper";

/**
 * Provider configuration (static metadata)
 */
export interface ProviderConfig {
  /** Provider name (e.g., "copilot", "claude", "codex") */
  name: string;

  /** Display name for status messages */
  displayName: string;

  /** Installation hint when CLI not found */
  installHint: string;

  /** Escape indicator for TUI completion detection */
  escapeIndicator: string;

  /** Screen end pattern for TUI parsing */
  screenEndPattern: RegExp;

  /** TUI chrome patterns for filtering */
  chromePatterns: RegExp[];

  /** Whether to stream headless output in real-time */
  shouldStreamHeadlessOutput: boolean;

  /**
   * Whether this provider uses notification-based completion detection in interactive mode.
   * When true, CliIntegration will use dual monitoring (TUI + notification file).
   * When false or undefined, only TUI-based completion detection is used.
   *
   * - Claude: true (uses Stop hook for reliable completion)
   * - Copilot: true (uses sessionEnd hook for reliable completion)
   * - Codex: true (uses notify hook for reliable completion)
   */
  usesInteractiveNotificationMonitor?: boolean;
}

/**
 * Main provider interface - each CLI provider must implement this
 *
 * This is the core contract for CLI integration. All provider-specific logic
 * is encapsulated in implementations of this interface.
 *
 * @example
 * ```typescript
 * class CopilotCliProvider implements ICliProvider {
 *   readonly config: ProviderConfig = { ... };
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
  /** Static provider configuration */
  readonly config: ProviderConfig;

  /** Response parser component */
  readonly responseParser: IResponseParser;

  /** Notification monitor component */
  readonly notificationMonitor: INotificationMonitor;

  /** Tool permission mapper component */
  readonly toolPermissionMapper: IToolPermissionMapper;

  /**
   * Build complete CLI arguments array for execution
   *
   * This is the main method for constructing CLI-specific arguments including:
   * - Model selection
   * - Tool permissions
   * - Session management
   * - Workspace directories
   * - Provider-specific flags (e.g., -p, --output-format for Claude)
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
    prompt: any,
    isInteractive: boolean,
    context: any,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: any[];
      filePath?: string;
    }
  ): Promise<string[]>;

  /**
   * Build CLI arguments for headless mode with file reference
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[];

  /**
   * Build CLI arguments for headless mode with direct prompt
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[];

  /**
   * Build CLI command for interactive TUI mode
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string;

  /**
   * Format a file path reference for this CLI
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path" or "path")
   */
  formatFileReference(relativeFilePath: string): string;

  /**
   * Generate MCP server configuration arguments (optional)
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array, or null if MCP not supported
   */
  getMcpConfigArgs?(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null>;

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
   * @returns Session ID if found in logs, undefined otherwise
   */
  extractSessionIdFromLogs?(): Promise<string | undefined>;
}
