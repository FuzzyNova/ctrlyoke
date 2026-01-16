import { exec } from "child_process";
import { promisify } from "util";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";

const execAsync = promisify(exec);

/**
 * Copilot CLI Provider
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - sessionEnd hook configuration for reliable completion detection
 * - Plain text output parsing with stderr statistics
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
 *
 * This provider aggregates four specialized components:
 * - CopilotResponseParser: Parses plain text output and statistics
 * - CopilotNotificationMonitor: Monitors sessionEnd hook notifications
 * - CopilotToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration files (shared)
 *
 * Usage:
 * ```typescript
 * const provider = new CopilotCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CopilotCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    installHint: "Install via: npm install -g @github/copilot",
    escapeIndicator: "Esc to cancel",
    screenEndPattern: /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi,
    chromePatterns: [
      // Copilot-specific box drawing and separators (UI chrome only)
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{50,}$/, // Very long horizontal separators (50+ = UI chrome)
      /^│\s*│$/, // Empty box sides

      // Copilot welcome and version info (UI chrome)
      /^Welcome to GitHub Copilot CLI/i, // Welcome header
      /Version.*·.*Commit/i, // Version line (distinctive parts)
      /check for mistakes/i, // Description line (distinctive ending)

      // Copilot status bullets (UI chrome, very specific text)
      /^●\s+Logged in as user:/i, // Login status
      /^●\s+Connected to.*MCP Server/i, // Connection status
      /^●\s+Model changed to:/i, // Model change notification

      // Copilot spinner/thinking indicator (UI chrome - just the spinner character alone)
      /^\s*[·∙◉◎●]\s*$/, // Spinner alone (U+00B7 middle dot, U+2219 bullet operator, or filled circles)

      // Copilot spinner with status text and cancel hint (UI chrome)
      // Allow optional leading whitespace (left after zero-width char stripping)
      // Note: Only filters lines that are JUST chrome (no content before the spinner)
      /^\s*[·∙◉◎●]\s+.*\(Esc to cancel/i, // Pure chrome: "∙ Thinking (Esc to cancel)"

      // Copilot status bar (UI chrome - path + branch + model display)
      /\[⎇\s+\w+\*?\].*gpt-.*\(\d+x\)/i, // Look for distinctive parts: branch indicator, model, and multiplier

      // Copilot bottom navigation bar (already in screenEndPattern, but keep for safety)
      /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand/i, // Bottom status bar

      // Copilot prompt hints (UI chrome)
      /Enter @ to mention files/i, // Prompt hint (distinctive part)
      /^>\s*$/, // Empty prompt line

      // Copilot approval prompts (UI chrome)
      /^Do you want to run this command\?/i, // Approval question
      /Confirm with number keys.*Cancel with Esc/i, // Confirmation hint
      /^❯\s*\d+\./, // Selected option indicator (any option)
      /No, and tell Copilot what to do differently/i, // Option text
    ],
    shouldStreamHeadlessOutput: true,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Copilot requires --prompt flag to specify file references.
   * Format: copilot --prompt "@path/to/file" [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return ["--prompt", `"${promptFileRef}"`, ...baseArgs];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass directly with --prompt flag.
   * Format: copilot --prompt "your question here" [other args]
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
    return ["--prompt", `"${promptText}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `${this.config.name} ${baseArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Copilot CLI
   *
   * Copilot uses @ prefix for file references.
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path/to/file.ts")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments for Copilot CLI
   *
   * Copilot CLI uses --additional-mcp-config @<file> format.
   * Config file format: JSON with "type": "local" and "tools" field.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with --additional-mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const fs = require("fs/promises");
      const path = require("path");

      // Generate MCP config JSON using shared utility
      // Copilot CLI requires "type": "local" and "tools" field
      const configJson = CliMcpConfigGenerator.generateJsonConfig(
        mcpServerPath,
        workspaceRoot,
        { type: "local", tools: ["*"] }
      );

      // Write to temp directory
      const tempDir = path.join(workspaceRoot, ".flightpath", "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const configPath = path.join(tempDir, "mcp-config.json");
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --additional-mcp-config @file argument
      return ["--additional-mcp-config", `@${configPath}`];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Check if Copilot CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("copilot --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Copilot CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("copilot --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
