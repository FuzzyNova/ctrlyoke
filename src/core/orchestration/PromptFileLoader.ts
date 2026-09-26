import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { PromptQueue } from "../PromptQueue";
import { Log } from "../../utils/Log";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  PromptFile,
  EXECUTION_STATES,
  type WorkflowValidationWarning,
} from "../../types/CtrlYokeTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import { normalizeAgentSelection } from "../WorkflowStepSanitizer";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import { USER_FEEDBACK_SEVERITY } from "../../types/DashboardConstants";
import {
  FINAL_STEP_PHASES,
  WORKFLOW_PROPERTY_KEYS,
  STATUS_MESSAGE_SEVERITY,
  PROMPT_FILE_RELOAD_MODES,
  STEP_TYPES,
  type PromptFileReloadMode,
} from "../../types/DashboardConstants";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";
import { findMissingWorkflowAssetDirectories } from "../../utils/WorkflowAssetWarnings";
import { StatusMessageReporter } from "./StatusMessageReporter";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

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
  private readonly lineageRepository = new WorkflowLineageRepository();
  private lastCompatibilityDiagnostics: CompatibilityDiagnostic[] = [];
  private lastMissingAssetDirectories: string[] = [];
  private lastSchemaWarnings: WorkflowValidationWarning[] = [];

  constructor(
    private promptFileParser: PromptFileParser,
    private promptQueue: PromptQueue,
    private getDashboard: () => IDashboardSink | undefined = () => undefined,
    private validateCompatibility?: (
      workflow: PromptFile
    ) => Promise<CompatibilityDiagnostic[]>,
    private onCompatibilityDiagnostics?: (
      diagnostics: CompatibilityDiagnostic[]
    ) => void,
    private readonly userFeedbackSink?: UserFeedbackSink,
    private readonly statusMessageReporter: StatusMessageReporter = new StatusMessageReporter(
      () => undefined,
      () => undefined
    )
  ) {}

  getLastCompatibilityDiagnostics(): readonly CompatibilityDiagnostic[] {
    return this.lastCompatibilityDiagnostics;
  }

  getLastMissingAssetDirectories(): readonly string[] {
    return this.lastMissingAssetDirectories;
  }

  getLastSchemaWarnings(): WorkflowValidationWarning[] {
    return [...this.lastSchemaWarnings];
  }

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
      Log.debug(`[PromptFileLoader] Loading prompt file: ${filePath}`);

      // Parse prompt file (parser handles all formats including .prompt.md)
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);

      if (!promptFile || !promptFile.steps) {
        notifyUserFeedback(
          this.userFeedbackSink,
          USER_FEEDBACK_SEVERITY.ERROR,
          "ctrlyoke: Failed to parse prompt file"
        );
        return undefined;
      }

      return await this.loadParsedPromptFile(
        promptFile,
        path.basename(filePath),
        workspaceFolderPath,
        filePath, // real source file path — stored as originalFile
        promptFile.warnings
      );
    } catch (error) {
      Log.error("[PromptFileLoader] Failed to load prompt file:", error);
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Failed to load file: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Load an already-parsed/normalized PromptFile into the queue without executing.
   * Used for workflows created from a template: steps are substituted and
   * normalized in memory (there is no source file on disk), so `originalFile`
   * stays undefined and Save As is the only way to export a durable copy.
   * @param promptFile Normalized PromptFile (steps + any workflow-level properties)
   * @param displayName Display name used to derive the working file's basename
   * @param workspaceFolderPath Path to workspace folder root for working file creation
   * @returns Working file path if created, undefined otherwise
   */
  async loadFromMemory(
    promptFile: PromptFile,
    displayName: string,
    workspaceFolderPath?: string
  ): Promise<string | undefined> {
    try {
      return await this.loadParsedPromptFile(
        promptFile,
        displayName,
        workspaceFolderPath,
        undefined, // no source file — Save As is the only export path
        []
      );
    } catch (error) {
      Log.error(
        "[PromptFileLoader] Failed to load workflow from template:",
        error
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Failed to create workflow: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Shared tail of loadPromptFile/loadFromMemory: validate steps, create the
   * working file, copy/backfill workflow-level properties, load the queue,
   * and notify the dashboard.
   */
  private async loadParsedPromptFile(
    promptFile: PromptFile,
    displayName: string,
    workspaceFolderPath: string | undefined,
    originalFilePath: string | undefined,
    schemaWarnings: WorkflowValidationWarning[]
  ): Promise<string | undefined> {
    this.lastSchemaWarnings = [...schemaWarnings];
    if (!promptFile.steps) {
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        "ctrlyoke: Failed to parse prompt file"
      );
      return undefined;
    }

    // Validate steps. A final-step-only workflow has no queued steps by design —
    // its final step appends them at runtime — so the finalStep is passed through
    // to keep the emptiness check honest.
    const validation = this.promptFileParser.validateWorkflowSteps(
      promptFile.steps,
      {
        finalStep: promptFile.finalStep,
        parallelGroups: promptFile.parallelGroups,
        workflowProperties: promptFile,
      }
    );
    if (!validation.valid) {
      const errors = validation.errors.join("\n");
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.ERROR,
        `ctrlyoke: Validation failed:\n${errors}`
      );
      return undefined;
    }

    await this.validateAndReportCompatibility(promptFile);

    // Create the lineage's draft under run storage/<workflowKey>/draft/.
    let workingFilePath: string | undefined;
    if (workspaceFolderPath) {
      try {
        workingFilePath = await this.promptQueue.createWorkingFile(
          displayName,
          promptFile.steps,
          workspaceFolderPath,
          originalFilePath,
          undefined,
          promptFile.parallelGroups
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
                Log.trace(
                  `[PromptFileLoader] Copied workflow property '${key}' from loaded file to working file: ${JSON.stringify(updates[key])}`
                );
              }
              Log.trace(
                "[PromptFileLoader] Persisted workflow-level properties from loaded file to working file"
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
            Log.trace(
              `[PromptFileLoader] Populated VS Code defaults for new working file: ${Object.keys(defaults).join(", ")}`
            );
          }
        }
      } catch (error) {
        Log.error("[PromptFileLoader] Failed to create working file:", error);
        // Continue without working file (fallback to in-memory queue)
      }
    } else {
      Log.warn(
        "[PromptFileLoader] No workspace folder, skipping working file creation"
      );
    }

    // Load prompts into queue with working file path
    this.promptQueue.loadPrompts(promptFile, workingFilePath);

    // Notify dashboard about file selection
    const dashboard = this.getDashboard();
    if (dashboard) {
      // Send full prompt objects with all properties
      dashboard.updateFileSelected(
        displayName,
        promptFile.steps,
        undefined,
        promptFile.finalStep ?? null,
        this.promptQueue.getFinalStepRuntime(),
        undefined,
        undefined,
        undefined,
        undefined,
        schemaWarnings
      );
    }

    await this.warnAboutMissingWorkflowAssets(
      promptFile,
      workspaceFolderPath,
      originalFilePath
    );

    Log.debug(
      `[PromptFileLoader] Loaded ${promptFile.steps.length} step(s)` +
        `${promptFile.finalStep ? " + final step" : ""} from ${displayName}`
    );

    return workingFilePath;
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
    mode: PromptFileReloadMode = PROMPT_FILE_RELOAD_MODES.AUTO,
    preventRunningAutoStart: boolean = false,
    workspaceFolderPath?: string
  ): Promise<void> {
    try {
      // Read working file
      const workingFile =
        await this.promptQueue.readWorkingFile(workingFilePath);
      const address =
        WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
      const descriptor =
        address && workspaceFolderPath
          ? await this.lineageRepository.tryReadDescriptor(
              workspaceFolderPath,
              address.workflowKey
            )
          : undefined;
      if (descriptor) {
        await this.promptQueue.updateWorkflowName(descriptor.workflowName);
      }
      const originalFilePath = descriptor?.originalFile;

      // Validate prompts (only if there are prompts to validate)
      if (workingFile.steps?.length) {
        const validation = this.promptFileParser.validateWorkflowSteps(
          workingFile.steps,
          {
            parallelGroups: workingFile.parallelGroups,
            workflowProperties: workingFile,
          }
        );
        if (!validation.valid) {
          const errorMessage = validation.errors.join(",");
          Log.error(
            "[PromptFileLoader] Working file validation failed:",
            errorMessage
          );
          throw new Error(`Working file validation failed: ${errorMessage}`);
        }
      }

      await this.validateAndReportCompatibility(workingFile);

      const queueState = this.promptQueue.getState();
      const isIdle = queueState.status === EXECUTION_STATES.IDLE;

      // Determine actual mode based on parameter and queue state
      let actualMode = mode;
      if (mode === PROMPT_FILE_RELOAD_MODES.AUTO) {
        actualMode = isIdle
          ? PROMPT_FILE_RELOAD_MODES.REPLACE
          : PROMPT_FILE_RELOAD_MODES.MERGE;
      }

      if (actualMode === PROMPT_FILE_RELOAD_MODES.REPLACE) {
        this.lastSchemaWarnings = [];
        // Scenario 1: Loading a different session (resume/auto-load)
        // Clear queue and restore full state including completed prompts, currentIndex, etc.
        Log.debug(
          `[PromptFileLoader] Restoring session from working file (${workingFile.steps?.length ?? 0} prompts, mode: ${mode}, preventRunningAutoStart: ${preventRunningAutoStart})`
        );
        await this.promptQueue.restoreFromWorkingFile(
          workingFilePath,
          preventRunningAutoStart
        );
        if (descriptor) {
          await this.promptQueue.updateWorkflowName(descriptor.workflowName);
        }

        const dashboard = this.getDashboard();
        if (dashboard) {
          // Use original file basename when available; fall back to workflow name for ephemeral workflows
          const fileName = originalFilePath
            ? path.basename(originalFilePath)
            : descriptor?.workflowName || path.basename(workingFilePath);
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
          // Deliberately no `definitionRevision`: this branch is a session
          // *replace* (resume/auto-load of a different session), not a replay.
          // The webview treats an untagged SESSION_RESTORED that carries a
          // revision as a replay of the currently displayed workflow — it then
          // preserves the view address and applies the regressive-snapshot
          // guard. Both are wrong here: the address belongs to the workflow
          // being navigated away from, and the revisions being compared come
          // from two unrelated workflows, so loading a lower-revision workflow
          // would be silently discarded. This path already reads its steps
          // straight from disk, so it has no staleness for a guard to catch.
        }
      } else {
        // Scenario 2: Queue extended during execution (MCP/append to same file)
        // Merge new prompts preserving state and send STEPS_EXTENDED
        Log.trace(
          `[PromptFileLoader] Merging prompts from working file (state: ${queueState.status}, mode: ${mode})`
        );
        const newStepsCount = await this.promptQueue.mergeStepsFromDisk();

        const mergeDashboard = this.getDashboard();
        if (newStepsCount > 0 && mergeDashboard) {
          // Get updated state after merge
          const updatedState = this.promptQueue.getState();
          Log.info(
            `[PromptFileLoader] Queue extended by ${newStepsCount} steps (total: ${updatedState.steps.length}). Sending STEPS_EXTENDED to dashboard.`
          );

          // send STEPS_EXTENDED message with updated step list
          mergeDashboard.updateStepsExtended(
            updatedState.steps,
            this.promptQueue.getWorkflowFile().finalStep ?? null,
            undefined,
            updatedState.definitionRevision,
            undefined,
            updatedState.parallelGroups
          );
        } else if (newStepsCount === 0) {
          Log.trace(
            "[PromptFileLoader] Working file changed but no new steps detected"
          );
        }
      }

      await this.warnAboutMissingWorkflowAssets(
        workingFile,
        workspaceFolderPath,
        originalFilePath
      );

      Log.trace(
        `[PromptFileLoader] Reloaded ${workingFile.steps?.length ?? 0} prompts from working file`
      );
    } catch (error) {
      Log.error("[PromptFileLoader] Failed to reload working file:", error);
      // Re-throw so caller knows the operation failed
      throw error;
    }
  }

  private async warnAboutMissingWorkflowAssets(
    workflow: PromptFile,
    workspaceFolderPath?: string,
    sourceDefinitionPath?: string
  ): Promise<void> {
    const promptTexts =
      typeof workflow.prompt === "string" ? [workflow.prompt] : [];
    promptTexts.push(
      ...(workflow.steps ?? [])
        .filter(
          (
            step
          ): step is Exclude<typeof step, { type: typeof STEP_TYPES.SCRIPT }> =>
            typeof step === "object" &&
            step !== null &&
            "prompt" in step &&
            typeof step.prompt === "string"
        )
        .map((step) => step.prompt)
    );

    if (workflow.finalStep && "prompt" in workflow.finalStep) {
      const finalPrompt = workflow.finalStep.prompt;
      if (typeof finalPrompt === "string") {
        promptTexts.push(finalPrompt);
      }
    }

    const missingDirectories = await findMissingWorkflowAssetDirectories(
      promptTexts,
      workspaceFolderPath,
      sourceDefinitionPath
    );
    this.lastMissingAssetDirectories = missingDirectories;
    if (missingDirectories.length === 0) {
      return;
    }

    const message = `Workflow references missing exported assets: ${missingDirectories.join(
      ", "
    )}. Restore the sibling *.assets/ directory or use Save As to create a portable copy.`;
    const dedupeKey = JSON.stringify(missingDirectories);
    this.statusMessageReporter.report(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      message,
      STATUS_MESSAGE_SEVERITY.WARNING,
      {
        liveDedupeKey: dedupeKey,
        persistDedupeKey: dedupeKey,
      }
    );
    Log.warn(`[PromptFileLoader] ctrlyoke: ${message}`);
  }

  private async validateAndReportCompatibility(
    workflow: PromptFile
  ): Promise<void> {
    if (!this.validateCompatibility) {
      this.lastCompatibilityDiagnostics = [];
      this.lastMissingAssetDirectories = [];
      return;
    }
    this.lastCompatibilityDiagnostics =
      await this.validateCompatibility(workflow);
    this.onCompatibilityDiagnostics?.(this.lastCompatibilityDiagnostics);
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

    for (const key of ["vars", "finalStep"] as const) {
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
    if (explicitValues.executionMode === undefined) {
      defaults.executionMode = ConfigurationUtils.getCliExecutionMode();
    }
    if (explicitValues.agent === undefined) {
      defaults.agent = normalizeAgentSelection(
        ConfigurationUtils.getDefaultAgent()
      );
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
    if (explicitValues.endCondition === undefined) {
      defaults.endCondition =
        ConfigurationUtils.getDefaultEndCondition() ?? null;
    }
    if (explicitValues.preCondition === undefined) {
      defaults.preCondition =
        ConfigurationUtils.getDefaultPreCondition() ?? null;
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
      Record<string, unknown> | null | undefined;
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
