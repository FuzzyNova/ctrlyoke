import type * as vscode from "vscode";
import type { IResponseParser } from "./IResponseParser";
import type { INotificationMonitor } from "./INotificationMonitor";
import type { IToolPermissionMapper } from "./IToolPermissionMapper";
import type { ILogParser } from "./ILogParser";
import type { PromptItem } from "../../../../types/FlightPathTypes";

/**
 * Harness configuration (static metadata)
 */
export interface HarnessConfig {
  /** Harness name (e.g., "copilot", "claude", "codex") */
  name: string;

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
    prompt: PromptItem,
    isInteractive: boolean,
    context: vscode.ExtensionContext,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
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
   * Format a file path reference for this CLI
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path" or "path")
   */
  formatFileReference(relativeFilePath: string): string;

  /**
   * Generate MCP server configuration arguments (optional)
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets FLIGHTPATH_WORKING_FILE)
   * @returns CLI arguments array, or null if MCP not supported
   */
  getMcpConfigArgs?(
    mcpServerPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>
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
   * @param promptText The prompt text that was sent (used to match the correct session log)
   * @param startTime When execution started (used to filter recently modified logs)
   * @returns Session ID if found in logs, undefined otherwise
   */
  extractSessionIdFromLogs?(
    promptText: string,
    startTime: Date
  ): Promise<string | undefined>;
}
