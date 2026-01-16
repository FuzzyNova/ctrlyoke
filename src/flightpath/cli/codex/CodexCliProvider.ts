import { exec } from "child_process";
import { promisify } from "util";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CodexResponseParser } from "./CodexResponseParser";
import { CodexNotificationMonitor } from "./CodexNotificationMonitor";
import { CodexToolPermissionMapper } from "./CodexToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/**
 * Codex CLI Provider
 *
 * Implements all Codex-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - Notify hook configuration for reliable completion detection
 * - JSONL output parsing with event-based streaming
 * - Mode-based permissions (no granular tool patterns)
 * - MCP server configuration with inline TOML format
 *
 * This provider aggregates four specialized components:
 * - CodexResponseParser: Parses JSONL output and statistics
 * - CodexNotificationMonitor: Monitors notify hook notifications
 * - CodexToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration (shared)
 *
 * Codex CLI-specific features:
 * - Uses JSONL output format (multiple {"type": "..."} events)
 * - Notify hook with TOML inline config: notify=['node','path']
 * - OpenAI token format in usage metadata
 * - Completion detection via {"type": "turn.completed"} events
 * - Supports --resume flag for session continuation
 * - Mode-based permissions (--full-auto, --dangerously-bypass-approvals-and-sandbox)
 *
 * Usage:
 * ```typescript
 * const provider = new CodexCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CodexCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "codex",
    displayName: "Codex CLI",
    installHint: "Install via: npm install -g @openai/codex-cli",
    escapeIndicator: "esc to interrupt",
    screenEndPattern: /›\s|\d+%\s+context\s+left/g,
    chromePatterns: [
      // Codex-specific box borders (UI chrome only)
      /^[╭╰]─+[╮╯]$/, // Box top/bottom borders
      />_\s+OpenAI Codex/i, // Header (distinctive marker)
      /^│\s*│$/, // Empty box lines
      /model:.*\/model to change/i, // Model info line (distinctive parts)
      /directory:.*│$/i, // Directory line in box

      // Codex informational messages (UI chrome)
      /^Tip:/i, // Tips (any tip)
      /is deprecated.*Use \[features\]/i, // Deprecation warnings (distinctive parts)
      /^Enable it with/i, // Configuration hints
      /github\.com\/openai\/codex/i, // Documentation links

      // Codex status bar (UI chrome - context percentage and shortcuts)
      /\d+%\s+context\s+left.*\?\s+for shortcuts/i, // Status bar (distinctive parts)
      /^\d+%\s+context\s+left\s*$/i, // Context percentage alone
      /[·•]\s*\?\s*for shortcuts/i, // Status bar fragment (just shortcuts part)

      // Codex prompt indicator when empty (UI chrome)
      /^›\s*$/, // Empty prompt line only

      // Codex approval prompts (UI chrome)
      /Would you like to run the following command\?/i, // Approval question
      /^\s*Reason:/i, // Reason line prefix
      /^›\s+\d+\.\s+Yes, proceed/i, // Option 1 (distinctive part)
      /Yes, and don't ask again for commands that start with/i, // Option 2 (distinctive part)
      /No, and tell Codex what to do differently/i, // Option 3
      /Press enter to confirm or esc to cancel/i, // Confirmation hint

      // Codex separators (UI chrome)
      /^─\s+Worked for \d+s\s+─/i, // Worked for Xs separator

      // Codex spinner/thinking indicator (UI chrome)
      /^•?\s*W(o(r(k(i(n(g)?)?)?)?)?)?\d*\s*$/i, // Working prefixes (W, Wo, Wor, Work, Worki, Workin, Working + numbers)
      /^•?\s*(orking|rking|king|ing|ng|g)\s*$/i, // Working suffixes (fragments from right side)
      /^•?\s*\d+\s*$/i, // Standalone numbers (spinner frame counters)
      /^[•·]\s*$/i, // Standalone bullet points
      /\(.*esc to interr?upt.*\)/i, // Lines with "(esc to interrupt)" or "(Xs • esc to interrupt)" (handles typo "interupt")
      /\d+s\s*[•·]\s*esc to interr?upt/i, // Timer with escape indicator (handles missing opening paren)
    ],
    shouldStreamHeadlessOutput: true,
  };

  readonly responseParser: IResponseParser = new CodexResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CodexNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CodexToolPermissionMapper();

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Codex expects: codex exec [OPTIONS] [PROMPT]
   * The prompt argument must come LAST after all flags/options.
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., ".flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [...baseArgs, `"${promptFileRef}"`];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass as LAST positional argument.
   * Format: codex exec [OPTIONS] "your question here"
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
    return [...baseArgs, `"${promptText}"`];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "--json" && arg !== "exec" && arr[i - 1] !== "--output-format"
    );

    // Quote arguments that contain special characters (brackets, quotes, etc.)
    const quotedArgs = interactiveArgs.map((arg) => {
      // If arg contains special chars like brackets, spaces, or quotes, wrap in double quotes
      // But escape any internal double quotes first
      if (/[\[\]\s"]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    return `${this.config.name} ${quotedArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Codex CLI
   *
   * Codex does NOT support @ symbol file references - it interprets them literally.
   * Returns the file path without the @ prefix.
   *
   * @param relativeFilePath Relative file path
   * @returns File path without @ prefix (e.g., ".flightpath/temp/prompt.md")
   */
  formatFileReference(relativeFilePath: string): string {
    // Codex CLI doesn't support @ prefix - just return the path as-is
    return relativeFilePath;
  }

  /**
   * Generate MCP server configuration arguments for Codex CLI
   *
   * Codex CLI uses -c 'mcp_servers.flightpath={...}' inline TOML format.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with -c flag, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const tomlConfig = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        mcpServerPath,
        workspaceRoot
      );
      return ["-c", tomlConfig];
    } catch (error) {
      Log.error("Failed to generate MCP config for Codex CLI", error);
      return null;
    }
  }

  /**
   * Check if Codex CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("codex --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Codex CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("codex --version");
      // Extract version from output like "codex version 0.1.2"
      const match = stdout.match(/codex version ([\d.]+)/i);
      return match ? match[1] : stdout.trim();
    } catch {
      return undefined;
    }
  }
}
