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
}
