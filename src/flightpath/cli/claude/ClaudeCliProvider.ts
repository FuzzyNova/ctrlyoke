import { exec } from "child_process";
import { promisify } from "util";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { ClaudeResponseParser } from "./ClaudeResponseParser";
import { ClaudeNotificationMonitor } from "./ClaudeNotificationMonitor";
import { ClaudeToolPermissionMapper } from "./ClaudeToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";

const execAsync = promisify(exec);

/**
 * Claude CLI Provider
 *
 * Implements all Claude-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - Stop hook configuration for reliable completion detection
 * - Stream-json output parsing with real-time content extraction
 * - Tool permission conversion with Anthropic tool name format (Bash, Write)
 * - MCP server configuration with "type": "stdio"
 *
 * This provider aggregates four specialized components:
 * - ClaudeResponseParser: Parses stream-json output and tool calls
 * - ClaudeNotificationMonitor: Monitors Stop hook notifications
 * - ClaudeToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration files (shared)
 *
 * Usage:
 * ```typescript
 * const provider = new ClaudeCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class ClaudeCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "claude",
    displayName: "Claude Code CLI",
    installHint: "Install via: npm install -g @anthropic-ai/claude-code",
    escapeIndicator: "esc to interrupt",
    screenEndPattern: /─{20,}\r?\n\s*(?:⏵⏵|⏸|[>❯])\s*/g,
    chromePatterns: [
      // Claude-specific box drawing and separators
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{20,}$/, // Long horizontal separators
      /Claude Code v[\d.]+/i, // Header with version

      // Claude ASCII logo (distinctive characters)
      /▐▛███▜▌/, // Logo line 1
      /▝▜█████▛▘/, // Logo line 2

      // Claude welcome and info sections (UI chrome)
      /^Welcome back/i, // Welcome message
      /^Recent activity/i, // Activity header
      /^No recent activity/i, // Empty activity
      /^What's new/i, // Release notes header
      /\/release-notes for more/i, // Navigation hint
      /^Added .* support for/i, // Feature announcements
      /^Added .* tool for/i, // Tool announcements
      /Claude Pro ·.*Organization/i, // Status line with model and account

      // Claude spinner/thinking indicator (UI chrome)
      /^[✻✽✢✶·*]\s*$/, // Spinner alone (any Claude spinner character including *)
      /^[✻✽✢✶·*]\s+.*\((esc to interrupt|ctrl\+c to interrupt).*\)/, // Spinner + text + interrupt hint

      // Claude approval prompts (UI chrome)
      /^Do you want to proceed\?/i, // Approval question
      /^Esc to cancel$/i, // Cancel hint (exact match - distinctive)
      /^❯\s*\d+\./, // Selected option indicator
      /^\s*\d+\.\s+Yes, and don't ask again/i, // Option 2
      /^\s*\d+\.\s+Type here to tell Claude/i, // Option 3

      // Claude UI hints and mode indicators
      /ctrl\+b to run in background/i, // Background hint
      /^[>❯]\s*$/, // Empty prompt line (> or ❯)
      /^\s*⏵⏵\s*$/, // Mode indicator alone (wraps on narrow terminals)
      /^\s*⏸\s*$/, // Pause indicator alone
      /⏵⏵.*\(shift\+tab to cycle\)/, // Mode indicator with full text (accept edits, etc.)
      /⏸.*\(shift\+tab to cycle\)/, // Pause/plan mode indicator with full text
      /^accept edits on \(shift\+tab to cycle\)/i, // Mode text continuation (when wrapped)
      /^\s*\?\s+for shortcuts/i, // Shortcuts hint
    ],
    shouldStreamHeadlessOutput: true,
  };

  readonly responseParser: IResponseParser = new ClaudeResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new ClaudeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new ClaudeToolPermissionMapper();

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Claude CLI expects the prompt as the FIRST positional argument (right after command name).
   * This is critical because variadic flags like --disallowedTools will consume any args after them.
   *
   * Format: claude "@path/to/file" -p [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [`"${promptFileRef}"`, ...baseArgs];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass as FIRST positional argument.
   * Format: claude "your question here" -p [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Note: Quotes handle spaces and special chars
    return [`"${promptText}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Filters out headless-only flags for interactive mode.
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "-p" &&
        arg !== "--output-format" &&
        arr[i - 1] !== "--output-format"
    );
    return `${this.config.name} ${interactiveArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Claude CLI
   *
   * Claude uses @ prefix for file references (same as Copilot).
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path/to/file.ts")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments for Claude CLI
   *
   * Claude CLI uses --mcp-config <file> format.
   * Config file format: JSON with "type": "stdio".
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with --mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const fs = require("fs/promises");
      const path = require("path");

      // Generate MCP config JSON using shared utility
      // Claude CLI requires "type": "stdio"
      const configJson = CliMcpConfigGenerator.generateJsonConfig(
        mcpServerPath,
        workspaceRoot,
        { type: "stdio" }
      );

      // Write to temp directory
      const tempDir = path.join(workspaceRoot, ".flightpath", "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const configPath = path.join(tempDir, "mcp-config-claude.json");
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --mcp-config <file> argument
      return ["--mcp-config", configPath];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Check if Claude CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("claude --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Claude CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("claude --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
