import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PromptQueue } from "../PromptQueue";
import { Log } from "../../utils/Log";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  PromptFile,
  PromptItem,
  EXECUTION_STATES,
  ExecutionProperties,
} from "../../types/FlightPathTypes";
import { FlightPathWebviewProvider } from "../../ui/FlightPathWebviewProvider";

/**
 * PromptFileLoader
 *
 * RESPONSIBILITY: Prompt File Loading & Validation
 *
 * Handles all prompt file I/O operations including:
 * - Loading and parsing prompt files
 * - Auto-saving dirty files before execution
 * - Reloading from working files (MCP/append scenarios)
 * - Validation and error handling
 */
export class PromptFileLoader {
  constructor(
    private promptFileParser: PromptFileParser,
    private promptQueue: PromptQueue,
    private getDashboard: () => FlightPathWebviewProvider | undefined = () =>
      undefined
  ) {}

  /**
   * Load a prompt file into the queue without executing
   * @param filePath Path to the prompt file
   * @param workspaceFolder Current workspace folder for working file creation
   * @returns Working file path if created, undefined otherwise
   */
  async loadPromptFile(
    filePath: string,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<string | undefined> {
    try {
      Log.info(`Loading prompt file: ${filePath}`);

      const fileName = path.basename(filePath);

      // Parse prompt file (parser handles all formats including .prompt.md)
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);

      if (!promptFile || !promptFile.prompts) {
        vscode.window.showErrorMessage(
          "FlightPath: Failed to parse prompt file"
        );
        return undefined;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        promptFile.prompts
      );
      if (!validation.valid) {
        const errors = validation.errors.join("\n");
        vscode.window.showErrorMessage(
          `FlightPath: Validation failed:\n${errors}`
        );
        return undefined;
      }

      // Create working file in .flightpath/.queue/ directory
      let workingFilePath: string | undefined;
      if (workspaceFolder) {
        try {
          workingFilePath = await this.promptQueue.createWorkingFile(
            filePath,
            promptFile.prompts,
            workspaceFolder,
            filePath // real source file path — stored as originalFile
          );

          // Copy workflow-level properties from loaded file to working file
          // This ensures file properties take precedence over pending/global settings
          if (workingFilePath) {
            const updates = this.extractWorkflowProperties(promptFile);

            if (Object.keys(updates).length > 0) {
              const result =
                await this.promptQueue.updateWorkingFileProperties(updates);

              if (result?.appliedKeys.length) {
                for (const key of result.appliedKeys) {
                  Log.info(
                    `Copied workflow property '${key}' from loaded file to working file: ${JSON.stringify(updates[key])}`
                  );
                }
                Log.info(
                  "Persisted workflow-level properties from loaded file to working file"
                );
              }
            }

            // Step 2: Populate defaults from VS Code settings for any properties
            // not explicitly specified in the source file. This ensures the working
            // file always has explicit values so the SettingsDrawer stays in sync
            // with the actual configuration (no implicit fallback to global settings).
            const defaults = this.populateSettingsDefaults(updates);

            if (Object.keys(defaults).length > 0) {
              await this.promptQueue.updateWorkingFileProperties(defaults);
              Log.info(
                `Populated VS Code defaults for new working file: ${Object.keys(defaults).join(", ")}`
              );
            }
          }
        } catch (error) {
          Log.error("Failed to create working file:", error);
          // Continue without working file (fallback to in-memory queue)
        }
      } else {
        Log.warn("No workspace folder, skipping working file creation");
      }

      // Load prompts into queue with working file path
      this.promptQueue.loadPrompts(promptFile, workingFilePath);

      // Notify dashboard about file selection
      const dashboard = this.getDashboard();
      if (dashboard) {
        // Send full prompt objects with all properties
        dashboard.updateFileSelected(fileName, promptFile.prompts);
      }

      Log.info(
        `Loaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
      );

      return workingFilePath;
    } catch (error) {
      Log.error("Failed to load prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to load file: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Reload queue from working file
   * Handles three scenarios:
   * - 'replace': Loading a different session (resume/auto-load) → Clear queue and restore state
   * - 'merge': Same file changed (MCP/append) → Merge new prompts into existing queue
   * - 'auto': Detect based on queue state (IDLE = restore, otherwise = merge)
   *
   * @param workingFilePath Path to working file
   * @param mode Reload mode: 'replace' | 'merge' | 'auto' (default: 'auto')
   */
  async reloadFromWorkingFile(
    workingFilePath: string,
    mode: "replace" | "merge" | "auto" = "auto",
    isAutoLoad: boolean = false
  ): Promise<void> {
    try {
      // Read working file
      const workingFile =
        await this.promptQueue.readWorkingFile(workingFilePath);

      // Check if prompts exist
      if (!workingFile.prompts || workingFile.prompts.length === 0) {
        Log.error("Working file has no prompts");
        return;
      }

      // Validate prompts
      const validation = this.promptFileParser.validatePromptItems(
        workingFile.prompts
      );
      if (!validation.valid) {
        const errorMessage = validation.errors.join(",");
        Log.error("Working file validation failed:", errorMessage);
        throw new Error(`Working file validation failed: ${errorMessage}`);
      }

      const queueState = this.promptQueue.getState();
      const isIdle = queueState.status === EXECUTION_STATES.IDLE;

      // Determine actual mode based on parameter and queue state
      let actualMode = mode;
      if (mode === "auto") {
        actualMode = isIdle ? "replace" : "merge";
      }

      if (actualMode === "replace") {
        // Scenario 1: Loading a different session (resume/auto-load)
        // Clear queue and restore full state including completed prompts, currentIndex, etc.
        Log.info(
          `Restoring session from working file (${workingFile.prompts.length} prompts, mode: ${mode}, isAutoLoad: ${isAutoLoad})`
        );
        await this.promptQueue.restoreFromWorkingFile(
          workingFilePath,
          isAutoLoad
        );

        const dashboard = this.getDashboard();
        if (dashboard) {
          // Use original file basename when available; fall back to workflow name for ephemeral workflows
          const fileName = workingFile.originalFile
            ? path.basename(workingFile.originalFile)
            : workingFile.workflowName || path.basename(workingFilePath);
          // Get the restored state to send accurate prompt info with runtime state
          const restoredState = this.promptQueue.getState();
          dashboard.updateSessionRestored(
            fileName,
            restoredState.prompts,
            restoredState.results,
            restoredState.status,
            restoredState.currentIndex,
            restoredState.workflowName || undefined
          );

          // Load output history if available (auto-loads most recent run from disk)
          await dashboard.loadOutputHistoryForWorkflow(workingFilePath);
        }
      } else {
        // Scenario 2: Queue extended during execution (MCP/append to same file)
        // Merge new prompts preserving state and send PROMPTS_EXTENDED
        Log.info(
          `Merging prompts from working file (state: ${queueState.status}, mode: ${mode})`
        );
        const newPromptsCount = await this.promptQueue.mergePromptsFromDisk();

        const mergeDashboard = this.getDashboard();
        if (newPromptsCount > 0 && mergeDashboard) {
          // Get updated state after merge
          const updatedState = this.promptQueue.getState();
          Log.info(
            `Queue extended by ${newPromptsCount} prompts (total: ${updatedState.prompts.length}). Sending PROMPTS_EXTENDED to dashboard.`
          );

          // Send PROMPTS_EXTENDED message with updated prompt list
          mergeDashboard.updatePromptsExtended(updatedState.prompts);
        } else if (newPromptsCount === 0) {
          Log.info("Working file changed but no new prompts detected");
        }
      }

      Log.info(
        `Reloaded ${workingFile.prompts.length} prompts from working file`
      );
    } catch (error) {
      Log.error("Failed to reload working file:", error);
      // Re-throw so caller knows the operation failed
      throw error;
    }
  }

  /**
   * Extract workflow-level ExecutionProperties from a parsed prompt file.
   * Type-safe access without `as any` casts — uses the known keys from ExecutionProperties.
   */
  private extractWorkflowProperties(
    promptFile: PromptFile
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {};

    // Type-safe access: PromptFile extends ExecutionProperties,
    // so these keys are statically known on the interface.
    if (promptFile.harness !== undefined) {
      updates.harness = promptFile.harness;
    }
    if (promptFile.model !== undefined) {
      updates.model = promptFile.model;
    }
    if (promptFile.agent !== undefined) {
      updates.agent = promptFile.agent;
    }
    if (promptFile.skills !== undefined) {
      updates.skills = promptFile.skills;
    }
    if (promptFile.resumeSession !== undefined) {
      updates.resumeSession = promptFile.resumeSession;
    }
    if (promptFile.allowDynamicExtension !== undefined) {
      updates.allowDynamicExtension = promptFile.allowDynamicExtension;
    }
    if (promptFile.endCondition !== undefined) {
      updates.endCondition = promptFile.endCondition;
    }

    return updates;
  }

  /**
   * Build an object of default values from VS Code settings for any
   * ExecutionProperties not already provided in `explicitValues`.
   */
  private populateSettingsDefaults(
    explicitValues: Record<string, unknown>
  ): Record<string, unknown> {
    const effectiveHarness =
      (explicitValues.harness as string | undefined) ??
      ConfigurationUtils.getIntegrationMode();

    const defaults: Record<string, unknown> = {};

    if (explicitValues.harness === undefined) {
      defaults.harness = effectiveHarness;
    }
    if (explicitValues.model === undefined) {
      defaults.model = ConfigurationUtils.getModelForHarness(
        effectiveHarness as Parameters<
          typeof ConfigurationUtils.getModelForHarness
        >[0]
      );
    }
    if (explicitValues.agent === undefined) {
      defaults.agent = ConfigurationUtils.getDefaultAgent();
    }
    if (explicitValues.skills === undefined) {
      defaults.skills = ConfigurationUtils.getDefaultSkills();
    }
    if (explicitValues.resumeSession === undefined) {
      defaults.resumeSession = ConfigurationUtils.shouldResumeExistingSession();
    }
    if (explicitValues.allowDynamicExtension === undefined) {
      defaults.allowDynamicExtension =
        ConfigurationUtils.getDynamicQueueConfig().enabled;
    }

    return defaults;
  }
}
