import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { GeminiResponseParser } from "./GeminiResponseParser";
import { GeminiNotificationMonitor } from "./GeminiNotificationMonitor";
import { GeminiToolPermissionMapper } from "./GeminiToolPermissionMapper";
import { GeminiLogParser } from "./GeminiLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils, PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import { getGeminiModelName, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * Gemini CLI Harness
 *
 * Implements Gemini-specific logic:
 * - Process-exit completion detection (headless)
 * - Stream-json output parsing
 * - Tool permission mapping (mode-based)
 * - Session ID extraction from init events
 */
export class GeminiCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "gemini",
    displayName: "Gemini CLI",
    terminalName: "Gemini",
    installHint: "Install via: npm install -g @google/gemini-cli",
    shouldStreamHeadlessOutput: true,
    // Gemini uses AfterAgent hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new GeminiResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new GeminiNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new GeminiToolPermissionMapper();
  readonly logParser = new GeminiLogParser();

  async buildCliArgs(
    prompt: PromptItem,
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

    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      prompt,
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv) =>
        this.getMcpConfigArgs(serverPath, wsRoot, workingFile, additionalEnv)
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
    }

    // Model selection
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Session management
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("--session-id", sessionId!);
    }

    // Extra CLI flags
    const additionalArgs = workflowContext?.resolvedProperties?.additionalArgs;
    if (additionalArgs) {
      const tokens = parseArgString(additionalArgs);
      args.push(...tokens);
    }

    // Tool permissions (headless only) / interactive hook setup
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
      // Interactive mode: write AfterAgent hook to .gemini/settings.json
      if (workspaceRoot) {
        await this.buildInteractiveHookSettings(extensionPath, workspaceRoot);
        Log.debug(`🔔 Configured AfterAgent hook for Gemini completion detection`);
      }
    }

    return args;
  }

  /**
   * Merge FlightPath hooks into .gemini/settings.json and pre-trust them in
   * ~/.gemini/trusted_hooks.json so Gemini doesn't prompt the user for approval.
   *
   * Backs up the original settings file to .flightpath/temp/gemini-settings-backup.json
   * so cleanupWorkspaceArtifacts() can restore it after the workflow completes.
   * If the backup already exists (multi-prompt workflow), skips the backup step.
   */
  private async buildInteractiveHookSettings(
    extensionPath: string,
    workspaceRoot: string
  ): Promise<void> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-gemini-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Gemini CLI");
    }

    const geminiDir = path.join(workspaceRoot, ".gemini");
    const settingsPath = path.join(geminiDir, "settings.json");
    const tempDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const backupPath = path.join(tempDir, "gemini-settings-backup.json");

    // Read existing settings (if any)
    let existingSettings: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Back up the original only once (skip if backup already exists for this workflow run)
    try {
      await fs.access(backupPath);
      // Backup exists — already set up by a prior prompt in this workflow
    } catch {
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(
        backupPath,
        JSON.stringify(existingSettings, null, 2),
        "utf-8"
      );
    }

    // Merge FlightPath hooks section into the settings (overwrite hooks key only)
    const mergedSettings = {
      ...existingSettings,
      hooks: (hookConfig.config as Record<string, unknown>)["hooks"],
    };
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(mergedSettings, null, 2),
      "utf-8"
    );

    // Pre-trust the hook commands in ~/.gemini/trusted_hooks.json
    // Key format: "${name}:${command}" where name defaults to ""
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const hookCommand = `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`;
    const hookKey = `:${hookCommand}`;

    const globalGeminiDir = path.join(os.homedir(), ".gemini");
    const trustedHooksPath = path.join(globalGeminiDir, "trusted_hooks.json");

    let trustedHooks: Record<string, string[]> = {};
    try {
      const content = await fs.readFile(trustedHooksPath, "utf-8");
      trustedHooks = JSON.parse(content);
    } catch {
      // File doesn't exist — start fresh
    }

    if (!trustedHooks[workspaceRoot]) {
      trustedHooks[workspaceRoot] = [];
    }
    if (!trustedHooks[workspaceRoot].includes(hookKey)) {
      trustedHooks[workspaceRoot].push(hookKey);
    }

    await fs.mkdir(globalGeminiDir, { recursive: true });
    await fs.writeFile(
      trustedHooksPath,
      JSON.stringify(trustedHooks, null, 2),
      "utf-8"
    );
  }

  /**
   * Restore .gemini/settings.json from the backup created by buildInteractiveHookSettings().
   * Called by CliIntegration.cleanupWorkflowArtifacts() after workflow completion.
   */
  async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
    const backupPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "gemini-settings-backup.json"
    );
    const settingsPath = path.join(workspaceRoot, ".gemini", "settings.json");

    try {
      const backup = await fs.readFile(backupPath, "utf-8");
      const backupSettings = JSON.parse(backup);

      if (Object.keys(backupSettings).length === 0) {
        // Original settings file didn't exist — remove the one we created
        await fs.unlink(settingsPath).catch(() => {});
      } else {
        await fs.writeFile(settingsPath, backup, "utf-8");
      }
      await fs.unlink(backupPath).catch(() => {});
    } catch {
      // Backup doesn't exist (headless run or no interactive session started)
    }
  }

  private validateAndGetModel(requestedModel?: string): string | undefined {
    if (requestedModel === MODEL_NONE) {
      return undefined;
    }
    return getGeminiModelName(requestedModel || "gemini-2.5-pro");
  }

  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote spaces/special chars
    const quotedPrompt = `"${prompt.replace(/"/g, '\\"')}"`;
    return [
      "--prompt", quotedPrompt,
      "--output-format", "stream-json",
      ...baseArgs,
    ];
  }

  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `gemini --prompt "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>
  ): Promise<string[] | null> {
    // Gemini CLI uses standard MCP config format
    const configJson = CliMcpConfigGenerator.generateJsonConfig(
      mcpServerPath,
      workspaceRoot,
      { type: "stdio" },
      workingFilePath,
      additionalEnv
    );

    const configPath = this.getMcpConfigFilePath(workingFilePath, workspaceRoot);
    const fs = require("fs/promises");
    await fs.mkdir(require("path").dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, configJson, "utf-8");

    return ["--mcp-config", configPath];
  }

  getMcpConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string {
    return CliMcpConfigGenerator.getConfigFilePath(
      workingFilePath,
      workspaceRoot,
      "mcp-config-gemini"
    );
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("gemini --version");
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("gemini --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
