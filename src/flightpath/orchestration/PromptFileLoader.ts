import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PromptQueue } from "../PromptQueue";
import { Log } from "../../utils/Log";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { PromptFile, EXECUTION_STATES } from "../../types/FlightPathTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";

const WORKFLOW_PROPERTY_KEYS = [
  "harness",
  "model",
  "agent",
  "skills",
  "resumeSession",
  "sessionId",
  "mcpServers",
  "hooks",
  "toolPermissions",
  "endCondition",
  "preCondition",
  "errorBehavior",
  "priorContext",
  "additionalArgs",
  "vars",
  "finalStep",
] satisfies (keyof PromptFile)[];

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
    private getDashboard: () => IDashboardSink | undefined = () => undefined
  ) {}

  /**
   * Load a prompt file into the queue without executing
   * @param filePath Path to the prompt file
   * @param workspaceFolderPath Path to workspace folder root for working file creation
   * @returns Working file path if created, undefined otherwise
   */
  async loadPromptFile(
    filePath: string,
    workspaceFolderPath?: string
  ): Promise<string | undefined> {
    try {
      Log.debug(`Loading prompt file: ${filePath}`);

      const fileName = path.basename(filePath);

      // Parse prompt file (parser handles all formats including .prompt.md)
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);

      if (!promptFile || !promptFile.steps) {
        vscode.window.showErrorMessage(
          "FlightPath: Failed to parse prompt file"
        );
        return undefined;
      }

      // Validate prompts
      const validation = this.promptFileParser.validateWorkflowSteps(
        promptFile.steps
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
      if (workspaceFolderPath) {
        try {
          workingFilePath = await this.promptQueue.createWorkingFile(
            filePath,
            promptFile.steps,
            workspaceFolderPath,
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
                  Log.debug(
                    `Copied workflow property '${key}' from loaded file to working file: ${JSON.stringify(updates[key])}`
                  );
                }
                Log.debug(
                  "Persisted workflow-level properties from loaded file to working file"
                );
              }
            }

            // Step 2: Populate defaults from VS Code/CLI settings for any properties
            // not explicitly specified in the source file. Apply to both the on-disk
            // working file AND the in-memory promptFile so getWorkflowFile() reflects
            // the full resolved configuration (e.g. toolPermissions from --headless).
            const defaults = PromptFileLoader.populateSettingsDefaults(updates);

            if (Object.keys(defaults).length > 0) {
              await this.promptQueue.updateWorkingFileProperties(defaults);
              Object.assign(promptFile, defaults);
              Log.debug(
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
        dashboard.updateFileSelected(
          fileName,
          promptFile.steps,
          undefined,
          promptFile.finalStep ?? null,
          this.promptQueue.getFinalStepRuntime()
        );
      }

      Log.debug(`Loaded ${promptFile.steps.length} prompt(s) from ${fileName}`);

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
    preventRunningAutoStart: boolean = false
  ): Promise<void> {
    try {
      // Read working file
      const workingFile =
        await this.promptQueue.readWorkingFile(workingFilePath);

      // Validate prompts (only if there are prompts to validate)
      if (workingFile.steps?.length) {
        const validation = this.promptFileParser.validateWorkflowSteps(
          workingFile.steps
        );
        if (!validation.valid) {
          const errorMessage = validation.errors.join(",");
          Log.error("Working file validation failed:", errorMessage);
          throw new Error(`Working file validation failed: ${errorMessage}`);
        }
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
        Log.debug(
          `Restoring session from working file (${workingFile.steps?.length ?? 0} prompts, mode: ${mode}, preventRunningAutoStart: ${preventRunningAutoStart})`
        );
        await this.promptQueue.restoreFromWorkingFile(
          workingFilePath,
          preventRunningAutoStart
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
            restoredState.steps,
            restoredState.results,
            restoredState.status,
            restoredState.currentIndex,
            restoredState.workflowName || undefined,
            workingFile.finalStep ?? null,
            this.promptQueue.getFinalStepRuntime()
          );
        }
      } else {
        // Scenario 2: Queue extended during execution (MCP/append to same file)
        // Merge new prompts preserving state and send STEPS_EXTENDED
        Log.debug(
          `Merging prompts from working file (state: ${queueState.status}, mode: ${mode})`
        );
        const newStepsCount = await this.promptQueue.mergeStepsFromDisk();

        const mergeDashboard = this.getDashboard();
        if (newStepsCount > 0 && mergeDashboard) {
          // Get updated state after merge
          const updatedState = this.promptQueue.getState();
          Log.debug(
            `Queue extended by ${newStepsCount} steps (total: ${updatedState.steps.length}). Sending STEPS_EXTENDED to dashboard.`
          );

          // send STEPS_EXTENDED message with updated step list
          mergeDashboard.updateStepsExtended(
            updatedState.steps,
            this.promptQueue.getWorkflowFile().finalStep ?? null
          );
        } else if (newStepsCount === 0) {
          Log.debug("Working file changed but no new steps detected");
        }
      }

      Log.debug(
        `Reloaded ${workingFile.steps?.length ?? 0} prompts from working file`
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

    for (const key of WORKFLOW_PROPERTY_KEYS) {
      const value = promptFile[key];
      if (value !== undefined) {
        updates[key] = value;
      }
    }

    return updates;
  }

  /**
   * Build an object of default values from VS Code settings for any
   * ExecutionProperties not already provided in `explicitValues`.
   */
  static populateSettingsDefaults(
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
    if (explicitValues.mcpServers === undefined) {
      defaults.mcpServers = ConfigurationUtils.getDefaultMcpServers();
    }
    if (explicitValues.hooks === undefined) {
      defaults.hooks = ConfigurationUtils.getDefaultHooks();
    }
    if (explicitValues.priorContext === undefined) {
      defaults.priorContext = ConfigurationUtils.getPriorContext();
    }
    if (explicitValues.errorBehavior === undefined) {
      defaults.errorBehavior = ConfigurationUtils.getDefaultErrorBehavior();
    }
    if (explicitValues.additionalArgs === undefined) {
      defaults.additionalArgs = ConfigurationUtils.getAdditionalArgsForHarness(
        effectiveHarness as Parameters<
          typeof ConfigurationUtils.getAdditionalArgsForHarness
        >[0]
      );
    }
    // toolPermissions requires sub-field merging: if mode is set but
    // allowedTools/deniedTools are missing, fill in defaults for the missing
    // sub-fields. null means none — don't seed. A fully-specified
    // object means nothing is missing — don't put anything in defaults.
    const explicitTP = explicitValues.toolPermissions as
      | Record<string, unknown>
      | null
      | undefined;
    if (explicitTP !== null) {
      const base =
        typeof explicitTP === "object" && explicitTP ? explicitTP : {};
      const needsMode = base.mode === undefined;
      const needsAllowed = base.allowedTools === undefined;
      const needsDenied = base.deniedTools === undefined;
      if (needsMode || needsAllowed || needsDenied) {
        defaults.toolPermissions = {
          mode: needsMode
            ? ConfigurationUtils.getCliToolPermissions()
            : base.mode,
          allowedTools: needsAllowed
            ? ConfigurationUtils.getCliAllowedTools()
            : base.allowedTools,
          deniedTools: needsDenied
            ? ConfigurationUtils.getCliDeniedTools()
            : base.deniedTools,
        };
      }
    }

    return defaults;
  }
}
