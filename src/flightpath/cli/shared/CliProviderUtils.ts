import * as path from "path";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

/**
 * Shared CLI provider utilities
 *
 * Contains common logic used by all CLI providers (Copilot, Claude, Codex)
 * to avoid code duplication across provider implementations.
 *
 * **Single source of truth for:**
 * - Workspace directory resolution (`getWorkspaceDirs`)
 * - MCP configuration injection (`buildMcpConfigBlock`)
 */
export class CliProviderUtils {
  /**
   * Get workspace directories for --add-dir arguments
   *
   * Collects all VS Code workspace folders plus any user-configured
   * additional directories from `flightpath.cliAdditionalDirs` setting.
   *
   * @param workspaceRoot - Primary workspace root for resolving relative paths
   * @returns Array of absolute directory paths
   *
   * @remarks
   * Previously duplicated across CopilotCliProvider, ClaudeCliProvider, and CodexCliProvider.
   * CodexCliProvider was missing the `cliAdditionalDirs` support — now fixed.
   */
  static getWorkspaceDirs(workspaceRoot: string): string[] {
    const workspaceDirs: string[] = [];

    // Add primary workspace folder
    workspaceDirs.push(workspaceRoot);

    // Add configured allowed directories
    const allowedDirs = ConfigurationUtils.getCliAllowedDirs();
    allowedDirs.forEach((dir: string) => {
      const absolutePath = path.isAbsolute(dir)
        ? dir
        : path.join(workspaceRoot, dir);
      if (!workspaceDirs.includes(absolutePath)) {
        workspaceDirs.push(absolutePath);
      }
    });

    return workspaceDirs;
  }

  /**
   * Build MCP configuration block for dynamic queue extension
   *
   * Common logic for checking whether MCP config should be injected and
   * calling the provider's getMcpConfigArgs. Each provider still defines
   * its own getMcpConfigArgs (for format-specific config generation), but
   * the decision logic and PromptIdentity check are shared here.
   *
   * @param prompt - The prompt item
   * @param workflowContext - Workflow context with resolved properties
   * @param workspaceRoot - Workspace root directory
   * @param extensionPath Extension installation directory
   * @param getMcpConfigArgs - Provider-specific MCP config args generator
   * @returns CLI arguments to add, or empty array if MCP not needed
   */
  static async buildMcpConfigBlock(
    prompt: unknown,
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: unknown[];
          filePath?: string;
          resolvedProperties?: ResolvedProperties;
          workingFilePath?: string;
        }
      | undefined,
    workspaceRoot: string | undefined,
    extensionPath: string,
    getMcpConfigArgs: (
      mcpServerPath: string,
      workspaceRoot: string,
      workingFilePath?: string,
      additionalEnv?: Record<string, string>
    ) => Promise<string[] | null>
  ): Promise<string[]> {
    if (!workflowContext || !workspaceRoot) {
      return [];
    }

    const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
    const allowDynamicExtension =
      workflowContext.resolvedProperties?.allowDynamicExtension ??
      dynamicQueueConfig.enabled;

    if (!allowDynamicExtension) {
      return [];
    }

    const {
      shouldInjectExtensionInstructions,
    } = require("../../../utils/PromptIdentity");
    const shouldInject = shouldInjectExtensionInstructions(
      prompt,
      workflowContext.promptIndex,
      workflowContext.allPrompts,
      dynamicQueueConfig.dynamicExtensionOnLastPrompt,
      allowDynamicExtension
    );

    if (!shouldInject) {
      return [];
    }

    const mcpServerPath = path.join(extensionPath, "out/mcp-server.js");

    // Pass queue limits to MCP server via env vars so it enforces the same settings
    const additionalEnv: Record<string, string> = {
      FLIGHTPATH_MAX_QUEUE_SIZE: dynamicQueueConfig.maxQueueSize.toString(),
      FLIGHTPATH_UNLIMITED_MODE: dynamicQueueConfig.unlimitedMode.toString(),
    };

    const mcpArgs = await getMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workflowContext.workingFilePath,
      additionalEnv
    );

    if (mcpArgs) {
      Log.debug("🔧 MCP server config added for dynamic queue extension");
      return mcpArgs;
    }

    return [];
  }
}
