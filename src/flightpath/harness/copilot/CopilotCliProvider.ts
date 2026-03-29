import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig, CLI_VERSION_CHECK_TIMEOUT_MS } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CopilotLogParser } from "./CopilotLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import {
  initializeModelRegistry,
  isCliModelSupported,
  isRegistryInitialized,
} from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * Copilot CLI Harness
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - Log file monitoring and sessionEnd hook for completion detection
 * - JSONL output parsing in headless mode (--output-format json), plain text fallback
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
 * - Session ID from result.sessionId in JSON output; log file discovery as fallback
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
  readonly config: HarnessConfig = {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    terminalName: "Copilot",
    installHint: "Install via: npm install -g @github/copilot",
    shouldStreamHeadlessOutput: true,

    // Copilot uses sessionEnd hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,

    // Headless mode uses --output-format json, so output is structured events (not raw text).
    // The parser sets rawTextOutput:true in metadata for interactive/plain-text fallback.
    rawTextOutput: false,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();
  readonly logParser = new CopilotLogParser();

  constructor() {
    // No initialization needed
  }

  /**
   * Build complete CLI arguments array for Copilot CLI execution
   *
   * Handles all Copilot-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Tool permissions (--allow-all-tools, --allow-tool, --deny-tool)
   * - Path permissions (--allow-all-paths)
   * - Logging configuration (--log-dir, --log-level)
   * - Workspace directories (--add-dir)
   * - Model selection (--model)
   * - Session management (--resume)
   * - sessionEnd hook (interactive mode only)
   *
   * Note: --output-format json is added by buildHeadlessArgs(), not here.
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
    _prompt: PromptItem,
    isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    // This ensures workflow-level defaults are respected
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.getMcpConfigArgs(serverPath, wsRoot, workingFile, additionalEnv, userServers)
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
      // Auto-approve FlightPath MCP tools (FlightPath is the orchestrator)
      args.push("--allow-tool", "flightpath");
      Log.debug("🔧 FlightPath MCP tools auto-approved");
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const permissionConfig = {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      };
      const toolPermissionArgs =
        this.toolPermissionMapper.buildArgs(permissionConfig);
      args.push(...toolPermissionArgs);
    } else {
      // Interactive mode: Configure sessionEnd hook for completion detection
      if (workspaceRoot) {
        const hookArgs = this.buildSessionEndHookArgs(
          extensionPath,
          workspaceRoot
        );
        args.push(...hookArgs);
        Log.debug(`🔔 Configured sessionEnd hook for completion detection`);
      }
    }

    // Path permissions
    if (ConfigurationUtils.shouldAllowAllPaths()) {
      args.push("--allow-all-paths");
    }

    // Workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Model selection with validation - use resolved property if available
    const model = await this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
    // No --agent CLI flag needed; this works with all providers (Copilot, Claude, Codex).

    // Session resumption
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );
    if (shouldResume) {
      args.push("--resume", sessionId!);
      Log.debug(`✅ Added resume flag: --resume ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    Log.debug(`🔧 CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Validate model is supported by Copilot CLI, fallback to default if not.
   * Lazily initializes the model registry if needed (e.g. CLI mode where
   * initializeModelRegistry() is never called during extension activation).
   */
  private async validateAndGetModel(requestedModel?: string): Promise<string> {
    const defaultModel = ConfigurationUtils.getCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return "";
    }

    // Lazily initialize the registry if not yet done (CLI mode).
    // queryCopilotCliModels() runs `copilot help config` — no VS Code context needed.
    // queryChatModels() falls back to the static list via the vscode shim.
    if (!isRegistryInitialized()) {
      await initializeModelRegistry();
    }

    // Check if model is supported by CLI (using dynamically discovered models)
    if (isCliModelSupported(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);

    return defaultModel;
  }

  /**
   * Build sessionEnd hook arguments for interactive mode.
   * Returns CLI arguments to configure the hook.
   *
   * @param context Extension context for accessing hook script path
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array
   */
  private buildSessionEndHookArgs(
    extensionPath: string,
    workspaceRoot: string
  ): string[] {
    // Get notification directory from notification monitor
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Get hook script path from extension
    const hookScriptPath = path.join(
      extensionPath,
      "out/scripts/flightpath-copilot-hook.js"
    );

    // Build hook config using notification monitor
    const hookConfig = this.notificationMonitor.buildHookConfig(
      hookScriptPath,
      notifyDir,
      workspaceRoot
    );

    // For Copilot, the hook config is written to .github/hooks/flightpath.json
    // However, we can also pass inline JSON via --hook argument if supported
    // For now, we'll create the hook file and let Copilot discover it automatically

    // Create the hook file
    this.createHookFile(hookConfig, workspaceRoot);

    // No additional CLI args needed - Copilot auto-discovers hooks in .github/hooks/
    return [];
  }

  /**
   * Return additional file paths to delete after workflow cleanup.
   *
   * Copilot writes flightpath.json to .github/hooks/ for interactive mode
   * completion detection. It is auto-generated each run, so clean it up
   * after the workflow finishes (consistent with OpenCode plugin cleanup).
   */
  getAdditionalCleanupFilePaths(workspaceRoot: string): string[] {
    return [path.join(workspaceRoot, ".github", "hooks", "flightpath.json")];
  }

  /**
   * Create the sessionEnd hook file for Copilot
   */
  private async createHookFile(
    hookConfig: any,
    workspaceRoot: string
  ): Promise<void> {
    try {
      const hookDir = path.join(workspaceRoot, ".github", "hooks");

      // Security: Validate that the resolved hook path stays within the workspace root.
      // Defense-in-depth — workspaceRoot comes from VS Code's trusted workspace API,
      // but path.join with crafted segments could theoretically escape the workspace.
      const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
      const resolvedHookDir = path.resolve(hookDir);
      if (!resolvedHookDir.startsWith(normalizedWorkspaceRoot)) {
        Log.error(
          `Security: Hook directory "${resolvedHookDir}" is outside workspace root "${normalizedWorkspaceRoot}"`
        );
        return;
      }

      await fs.mkdir(hookDir, { recursive: true });

      const hookPath = path.join(hookDir, "flightpath.json");
      await fs.writeFile(
        hookPath,
        JSON.stringify(hookConfig.config, null, 2),
        "utf-8"
      );

      Log.debug(`📁 Created hook file: ${hookPath}`);
    } catch (error) {
      Log.warn(`⚠️ Failed to create hook file: ${error}`);
    }
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Copilot requires --prompt flag to specify prompts.
   * Format: copilot --output-format json --prompt "..." [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character.
    // --output-format json enables structured JSONL output for reliable response/session parsing.
    return ["--output-format", "json", "--prompt", `"${prompt}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Copilot interactive mode: copilot -i "prompt text" [args...]
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `${this.config.name} -i "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  /**
   * Generate MCP server configuration arguments for Copilot CLI
   *
   * Copilot CLI uses --additional-mcp-config @<file> format.
   * Config file format: JSON with "type": "local" and "tools" field.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets FLIGHTPATH_WORKING_FILE)
   * @returns CLI arguments array with --additional-mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: import("../../../types/FlightPathTypes").McpServerConfig[]
  ): Promise<string[] | null> {
    try {
      // Generate MCP config JSON using shared utility
      // Copilot CLI requires "type": "local" and "tools" field
      const configJson = userServers && userServers.length > 0
        ? CliMcpConfigGenerator.generateJsonConfigWithUserServers(
            mcpServerPath,
            workspaceRoot,
            userServers,
            { type: "local", tools: ["*"] },
            workingFilePath,
            additionalEnv
          )
        : CliMcpConfigGenerator.generateJsonConfig(
            mcpServerPath,
            workspaceRoot,
            { type: "local", tools: ["*"] },
            workingFilePath,
            additionalEnv
          );

      // Write to temp directory — use unique name per execution to avoid parallel workflow collisions
      const configPath = this.getMcpConfigFilePath(
        workingFilePath,
        workspaceRoot
      )!;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --additional-mcp-config @file argument
      return ["--additional-mcp-config", `@${configPath}`];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Return the path of the MCP config file this provider writes.
   * Used by CliIntegration to delete the file after the workflow finishes.
   */
  getMcpConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string {
    return CliMcpConfigGenerator.getConfigFilePath(
      workingFilePath,
      workspaceRoot,
      "mcp-config"
    );
  }

  /**
   * Check if Copilot CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    const result = await retryWithBackoff(
      async () => {
        try {
          await execAsync("copilot --version", { timeout: CLI_VERSION_CHECK_TIMEOUT_MS });
          return true;
        } catch (error) {
          // Retry Windows file-lock errors; treat other errors as permanent
          if (String(error).includes("being used by another process")) {
            return null; // trigger retry
          }
          throw error;
        }
      },
      { maxAttempts: 4, delays: [200, 500, 1000] }
    );
    return result === true;
  }

  /**
   * Get Copilot CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    const result = await retryWithBackoff(
      async () => {
        try {
          const { stdout } = await execAsync("copilot --version", { timeout: CLI_VERSION_CHECK_TIMEOUT_MS });
          return stdout.trim() || null;
        } catch (error) {
          if (String(error).includes("being used by another process")) {
            return null; // trigger retry
          }
          throw error;
        }
      },
      { maxAttempts: 4, delays: [200, 500, 1000] }
    );
    return result;
  }

  /**
   * Extract session ID from session log files by matching prompt text.
   *
   * Fallback method used when the session ID is not available from hook notifications.
   * With the current Copilot hook format, session IDs are provided via sessionStart
   * notifications, making this a true fallback (e.g., hooks not configured or timed out).
   *
   * Uses prompt-text matching (via discoverSessionLog) to find the correct
   * session log among potentially many concurrent sessions, then extracts
   * the session ID from the session.start event.
   *
   * @param promptText The prompt text that was sent (matched against user.message events)
   * @param startTime When execution started (filters to recently modified logs)
   * @returns Session ID (UUID) if found, undefined otherwise
   *
   * @remarks
   * **Why prompt matching instead of most-recent:**
   * Multiple Copilot CLI sessions may run concurrently. Grabbing the most
   * recently modified log would be a race condition. Instead, we match the
   * actual prompt text in the log's user.message event to find the correct session.
   *
   * **Discovery algorithm (delegated to CopilotLogParser.discoverSessionLog):**
   * 1. Find recently modified entries in `~/.copilot/session-state/`
   * 2. Read first 10 events from each candidate
   * 3. Match user.message content against first 100 chars of promptText
   * 4. Return the matching session's log path
   * 5. Extract session ID from session.start event
   */
  /**
   * Augment JSON-mode headless output with context window data from Copilot log files.
   *
   * Copilot's --output-format json stdout contains output tokens per turn but no input tokens.
   * Two fallback sources are tried in order:
   *
   * 1. **session.truncation events** (`~/.copilot/session-state/{sessionId}/events.jsonl`)
   *    Fires once per model turn with postTruncationTokensInMessages + tokenLimit.
   *    Only emitted on turns 2+ (when there is existing context to measure) — short or
   *    single-turn prompts may not have any.
   *
   * 2. **CompactionProcessor lines** (`~/.copilot/logs/process-*.log`)
   *    Always written every turn: "Utilization X% (used/total tokens)".
   *    Used as the fallback when session.truncation is absent.
   *
   * This is the permanent architecture — session ID is not available until the final
   * `result` event, so real-time log tailing during execution is not feasible.
   */
  async augmentParsedOutput(
    output: UniversalCliOutput
  ): Promise<UniversalCliOutput> {
    // Plain-text mode: token data comes from stderr stats in parseTokenCounts(), not needed here.
    if (output.metadata.rawTextOutput) {
      return output;
    }

    const sessionId = output.metadata.sessionId;
    if (!sessionId) {
      Log.debug(
        `[CopilotCliProvider] augmentParsedOutput: no sessionId in parsed metadata`
      );
      return output;
    }

    // Already have input token data — Copilot may add this to JSON output in a future version.
    if (output.metadata.usage && output.metadata.usage.inputTokens > 0) {
      return output;
    }

    const truncation =
      await CopilotLogParser.extractTruncationDataFromLog(sessionId);
    const outputTokens = output.metadata.usage?.outputTokens ?? 0;

    if (truncation) {
      const { postTruncationTokensInMessages, tokenLimit } = truncation;
      Log.debug(
        `[CopilotCliProvider] Context window from session log: ${postTruncationTokensInMessages}/${tokenLimit} tokens`
      );
      return {
        ...output,
        metadata: {
          ...output.metadata,
          usage: {
            ...output.metadata.usage,
            inputTokens: postTruncationTokensInMessages,
            outputTokens,
            totalTokens: postTruncationTokensInMessages + outputTokens,
            contextWindowUsedTokens: postTruncationTokensInMessages,
            contextWindowSize: tokenLimit,
          },
        },
      };
    }

    // Fallback: session.truncation only fires when there is enough prior context
    // (short/first prompts may not emit it). The process log always contains
    // CompactionProcessor utilization lines which carry the same data.
    const processCtx =
      await this.logParser.extractContextFromProcessLog(sessionId);
    if (!processCtx) {
      Log.debug(
        `[CopilotCliProvider] No context window data available for session ${sessionId}`
      );
      return output;
    }

    Log.debug(
      `[CopilotCliProvider] Context window from process log: ${processCtx.used}/${processCtx.size} tokens`
    );
    return {
      ...output,
      metadata: {
        ...output.metadata,
        usage: {
          ...output.metadata.usage,
          inputTokens: processCtx.used,
          outputTokens,
          totalTokens: processCtx.used + outputTokens,
          contextWindowUsedTokens: processCtx.used,
          contextWindowSize: processCtx.size,
        },
      },
    };
  }

  async extractSessionIdFromLogs(
    promptText: string,
    startTime: Date
  ): Promise<string | undefined> {
    const logPath = await this.logParser.discoverSessionLog(
      promptText,
      startTime
    );
    if (!logPath) {
      Log.debug(
        "[CopilotCliProvider] Could not discover session log for prompt"
      );
      return undefined;
    }

    // Extract session ID from first event (stateless read, safe after monitoring)
    const sessionId = await this.logParser.extractSessionIdFromLogPath(logPath);
    return sessionId ?? undefined;
  }
}
