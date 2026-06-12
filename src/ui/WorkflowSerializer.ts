import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  PROMPT_PROPERTIES,
  PANEL_CLIENT_ID,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { readJsonFile } from "../utils/FileSystemUtils";
import { getErrorMessage } from "../utils/ErrorUtils";
import type { TemplateManager } from "../flightpath/TemplateManager";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import { OutputHistoryManager } from "../flightpath/orchestration/OutputHistoryManager";
import type { PostMessageFn } from "./WebviewSettingsSync";
import type { WorkingFile } from "../types/FlightPathTypes";

/**
 * WorkflowSerializer
 *
 * Handles all workflow persistence operations:
 * - Save workflow to disk (YAML/JSON)
 * - Export output as markdown
 * - New workflow creation (template modal)
 * - Workflow history (recent workflows, load, clear, remove)
 * - Run history (load, clear)
 * - Workflow name updates
 */
export class WorkflowSerializer {
  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly templateManager: TemplateManager,
    private readonly getManager: () => WorkflowOrchestrator | undefined,
    private readonly getOutputHistoryManager: () =>
      | OutputHistoryManager
      | undefined
  ) {}

  // ============================================================================
  // Save Workflow
  // ============================================================================

  /**
   * Handle SAVE_WORKFLOW_REQUEST from the webview.
   * Determines the default save path and format from the working file and
   * sends SAVE_WORKFLOW_DIALOG_DATA back so the webview can open the dialog.
   */
  async handleSaveWorkflowRequest(
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) {
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow manager available.",
      });
      return;
    }

    const queueState = manager.getQueueState(clientId);
    const workingFilePath = queueState.workingFilePath;

    if (!workingFilePath) {
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow loaded.",
      });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workflowsDir = workspaceFolder
      ? path.join(
          workspaceFolder.uri.fsPath,
          PATH_CONSTANTS.FLIGHTPATH_DIR,
          PATH_CONSTANTS.WORKFLOWS_DIR
        )
      : path.join(PATH_CONSTANTS.FLIGHTPATH_DIR, PATH_CONSTANTS.WORKFLOWS_DIR);

    try {
      const rawContent = await fs.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(rawContent);

      let defaultPath: string;
      if (workingFile.originalFile) {
        defaultPath = workingFile.originalFile;
      } else {
        const rawName =
          workingFile.workflowName ||
          path
            .basename(workingFilePath)
            .replace(/\.flightpath\.(ya?ml|json)$/i, "");
        const name =
          rawName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "workflow";
        defaultPath = path.join(workflowsDir, `${name}.flightpath.yaml`);
      }

      const defaultFormat: "yaml" | "json" = defaultPath
        .toLowerCase()
        .endsWith(".json")
        ? "json"
        : "yaml";

      pm({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA,
        defaultPath,
        defaultFormat,
        workflowsDir,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: `Failed to read workflow: ${msg}`,
      });
    }
  }

  /**
   * Handle SAVE_WORKFLOW from the webview.
   * Strips runtime metadata from the working file and serializes it to the
   * requested format and path.
   */
  async handleSaveWorkflow(
    filePath: string,
    format: "yaml" | "json",
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) {
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow manager available.",
      });
      return;
    }

    const queueState = manager.getQueueState(clientId);
    const workingFilePath = queueState.workingFilePath;

    if (!workingFilePath) {
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow loaded.",
      });
      return;
    }

    try {
      const workingFile = await readJsonFile(workingFilePath);

      // Build clean PromptFile — strip all working-file-only and runtime fields.
      // WORKFLOW_FIELDS: top-level properties to preserve (excludes originalFile,
      // workflowName, startedAt, _runtime, and other working-file-only fields).
      const WORKFLOW_FIELDS = [
        PROMPT_PROPERTIES.PROMPT,
        PROMPT_PROPERTIES.STEPS,
        PROMPT_PROPERTIES.FINAL_STEP,
        PROMPT_PROPERTIES.VARS,
        PROMPT_PROPERTIES.HARNESS,
        PROMPT_PROPERTIES.MODEL,
        PROMPT_PROPERTIES.AGENT,
        PROMPT_PROPERTIES.SKILLS,
        PROMPT_PROPERTIES.RESUME_SESSION,
        PROMPT_PROPERTIES.MCP_SERVERS,
        PROMPT_PROPERTIES.HOOKS,
        PROMPT_PROPERTIES.SESSION_ID,
        PROMPT_PROPERTIES.END_CONDITION,
        PROMPT_PROPERTIES.PRE_CONDITION,
        PROMPT_PROPERTIES.ERROR_BEHAVIOR,
        PROMPT_PROPERTIES.PRIOR_CONTEXT,
        PROMPT_PROPERTIES.ADDITIONAL_ARGS,
        PROMPT_PROPERTIES.TOOL_PERMISSIONS,
      ] as const;

      // PROMPT_FIELDS: per-step properties to preserve (covers both prompt steps
      // and script steps; fields absent from a step are silently skipped).
      const PROMPT_FIELDS = [
        PROMPT_PROPERTIES.NAME,
        PROMPT_PROPERTIES.ENABLED,
        PROMPT_PROPERTIES.STEP_TYPE,
        PROMPT_PROPERTIES.PROMPT,
        PROMPT_PROPERTIES.SCRIPT,
        PROMPT_PROPERTIES.TIMEOUT,
        PROMPT_PROPERTIES.ON_PASS,
        PROMPT_PROPERTIES.ON_FAIL,
        PROMPT_PROPERTIES.COMPARE_SOURCE,
        PROMPT_PROPERTIES.RETURNS,
        PROMPT_PROPERTIES.HARNESS,
        PROMPT_PROPERTIES.MODEL,
        PROMPT_PROPERTIES.AGENT,
        PROMPT_PROPERTIES.SKILLS,
        PROMPT_PROPERTIES.RESUME_SESSION,
        PROMPT_PROPERTIES.MCP_SERVERS,
        PROMPT_PROPERTIES.HOOKS,
        PROMPT_PROPERTIES.SESSION_ID,
        PROMPT_PROPERTIES.END_CONDITION,
        PROMPT_PROPERTIES.PRE_CONDITION,
        PROMPT_PROPERTIES.ERROR_BEHAVIOR,
        PROMPT_PROPERTIES.PRIOR_CONTEXT,
        PROMPT_PROPERTIES.ADDITIONAL_ARGS,
        PROMPT_PROPERTIES.TOOL_PERMISSIONS,
      ] as const;

      const clean: Record<string, unknown> = {};

      for (const field of WORKFLOW_FIELDS) {
        if (
          field in workingFile &&
          field !== PROMPT_PROPERTIES.STEPS &&
          field !== PROMPT_PROPERTIES.FINAL_STEP
        ) {
          clean[field] = workingFile[field];
        }
      }

      if (workingFile.finalStep && typeof workingFile.finalStep === "object") {
        const cleanFinalStep: Record<string, unknown> = {};
        for (const field of PROMPT_FIELDS) {
          if (field in workingFile.finalStep) {
            cleanFinalStep[field] = workingFile.finalStep[field];
          }
        }
        clean.finalStep = cleanFinalStep;
      }

      if (Array.isArray(workingFile.steps)) {
        clean.steps = workingFile.steps.map((p: Record<string, unknown>) => {
          const cleanPrompt: Record<string, unknown> = {};
          for (const field of PROMPT_FIELDS) {
            if (field in p) {
              cleanPrompt[field] = p[field];
            }
          }
          return cleanPrompt;
        });
      } else if (workingFile.prompt !== undefined) {
        clean.prompt = workingFile.prompt;
      }

      let absolutePath = filePath;
      if (!path.isAbsolute(filePath)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          absolutePath = path.join(workspaceFolder.uri.fsPath, filePath);
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

      let serialized: string;
      if (format === "yaml") {
        serialized = yaml.dump(clean, {
          lineWidth: -1,
          noRefs: true,
          quotingType: '"',
          forceQuotes: false,
        });
      } else {
        serialized = JSON.stringify(clean, null, 2);
      }

      await fs.writeFile(absolutePath, serialized, "utf-8");

      Log.debug(`Saved workflow to: ${absolutePath}`);

      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVED,
        filePath: absolutePath,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("Failed to save workflow:", error);
      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: msg,
      });
    }
  }

  // ============================================================================
  // Export Output
  // ============================================================================

  async handleExportOutput(content: string, fileName?: string): Promise<void> {
    try {
      let baseName = fileName || "flightpath-output";
      baseName = baseName
        .replace(/\.flightpath\.(ya?ml|json)$/i, "")
        .replace(/\.prompt\.md$/i, "");
      if (!baseName.endsWith(".md")) {
        baseName += ".md";
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let defaultUri: vscode.Uri;
      if (workspaceRoot) {
        const outputDir = path.join(
          workspaceRoot,
          PATH_CONSTANTS.FLIGHTPATH_DIR,
          "output"
        );
        await fs.mkdir(outputDir, { recursive: true });
        defaultUri = vscode.Uri.file(path.join(outputDir, baseName));
      } else {
        defaultUri = vscode.Uri.file(baseName);
      }

      Log.debug(
        `handleExportOutput: showing save dialog, defaultUri=${defaultUri.fsPath}, contentLength=${content.length}`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          "Markdown Files": ["md"],
          "Text Files": ["txt"],
          "All Files": ["*"],
        },
      });

      if (uri) {
        await fs.writeFile(uri.fsPath, content, "utf-8");
        vscode.window.showInformationMessage(
          `Output exported to ${uri.fsPath}`
        );
      } else {
        Log.debug("handleExportOutput: save dialog cancelled by user");
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("Failed to export output:", error);
      vscode.window.showErrorMessage(`Failed to export output: ${msg}`);
    }
  }

  // ============================================================================
  // New Workflow / Template Modal
  // ============================================================================

  async handleNewWorkflow(postMessage?: PostMessageFn): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const templates = await this.templateManager.getAvailableTemplates();
      const workflowsDir = path.join(
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.WORKFLOWS_DIR
      );
      const defaultTemplateId = ConfigurationUtils.getDefaultWorkflowTemplate();

      pm({
        type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          variables: t.variables,
          isBuiltIn: t.isBuiltIn,
        })),
        workflowsDir,
        defaultTemplateId,
      });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      vscode.window.showErrorMessage(`Failed to load templates: ${errorMsg}`);
    }
  }

  async handleTemplateSelected(
    templateId: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      pm({
        type: MESSAGE_TYPES.TEMPLATE_INFO,
        template,
      });
    } catch (error) {
      Log.error("Failed to load template:", error);
    }
  }

  async handleSetDefaultTemplate(
    templateId: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      await ConfigurationUtils.setDefaultWorkflowTemplate(templateId);

      pm({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        templateId,
      });
    } catch (error) {
      Log.error("Failed to set default template:", error);
    }
  }

  async handleCreateWorkflow(
    message: any,
    postMessage?: PostMessageFn,
    loadFn?: (filePath: string) => Promise<void>
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const { templateId, variables, filename, workflowsDir, runAfter, format } =
      message;

    try {
      const filePath = await this.templateManager.createWorkflow(
        templateId,
        variables || {},
        filename,
        workflowsDir,
        format === "json" ? "json" : "yaml"
      );

      pm({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        filePath,
      });

      const load =
        loadFn ??
        (async (fp: string) => {
          const manager = this.getManager();
          if (manager) {
            await manager.loadPromptFile(fp);
            if (runAfter) {
              vscode.commands.executeCommand("flightpath.run");
            }
          }
        });
      await load(filePath);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      vscode.window.showErrorMessage(`Failed to create workflow: ${errorMsg}`);
      pm({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        error: errorMsg,
      });
    }
  }

  handleCreateNewTemplate(): void {
    vscode.commands.executeCommand("flightpath.createNewTemplate");
  }

  async handleBrowseTemplateFile(
    variable: string,
    fileFilter?: string[],
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const filters: Record<string, string[]> = {};

    if (fileFilter && fileFilter.length > 0) {
      // Extract extensions from glob patterns like **/*.md → md
      const exts = fileFilter
        .map((p) => p.replace(/^\*\*\/\*\./, ""))
        .filter((e) => !e.includes("*"));
      if (exts.length > 0) {
        filters["Spec / Design Files"] = exts;
      }
    }
    filters["All Files"] = ["*"];

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      defaultUri: workspaceFolder?.uri,
      filters,
      title: `Select file for {${variable}}`,
    });

    if (uris && uris.length > 0) {
      // Return a workspace-relative path when possible so workflows are portable
      let filePath = uris[0].fsPath;
      if (workspaceFolder) {
        const wsPath = workspaceFolder.uri.fsPath;
        if (filePath.startsWith(wsPath)) {
          filePath = filePath.slice(wsPath.length).replace(/^[\\/]/, "");
        }
      }

      // Normalize backslashes to forward slashes so paths work across platforms
      // and are valid in prompt file @path references
      filePath = filePath.replace(/\\/g, "/");

      pm({
        type: MESSAGE_TYPES.TEMPLATE_FILE_SELECTED,
        variable,
        path: filePath,
      });
    }
  }

  // ============================================================================
  // Workflow Name
  // ============================================================================

  async handleUpdateWorkflowName(
    message: any,
    updateWorkflowNameFn: (name: string) => void,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { workflowName } = message;
    await manager.updateWorkflowName(workflowName, clientId);
    updateWorkflowNameFn(workflowName);
  }

  // ============================================================================
  // Recent Workflows
  // ============================================================================

  async handleGetRecentWorkflows(
    replyPostMessage?: PostMessageFn
  ): Promise<void> {
    const pm = replyPostMessage ?? this.postMessage;
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const queueDir = path.join(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );

      try {
        await fs.access(queueDir);
      } catch {
        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const files = await fs.readdir(queueDir);
      const workflowFiles = files.filter((f) => f.endsWith(".flightpath.json"));

      // Build a fast lookup set of working file paths that are currently active
      // in memory. Used below to normalize stale active states from disk.
      const manager = this.getManager();
      const activeWorkingFilePaths = new Set<string>(
        (manager?.getWorkflowSummaries() ?? [])
          .filter(
            (s) =>
              s.executionState === EXECUTION_STATES.RUNNING ||
              s.executionState === EXECUTION_STATES.PAUSING ||
              s.executionState === EXECUTION_STATES.PAUSED
          )
          .map((s) => s.workingFilePath)
          .filter((p): p is string => p !== undefined)
      );

      const workflows = await Promise.all(
        workflowFiles.map(async (file) => {
          const filePath = path.join(queueDir, file);

          try {
            const workingFile = await readJsonFile(filePath);

            const lastModified =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

            let executionState: string =
              workingFile._runtime?.executionState || EXECUTION_STATES.IDLE;

            // Normalize stale active state: if the disk says "running" or
            // "pausing" but no in-memory workflow is actually executing this
            // file, show STOPPED.
            // This guards against race windows before normalizeStaleLocks finishes.
            // HOWEVER: first check whether the lock file says the CLI is actively
            // running it — this bridges the timing gap where the runner.json
            // file-watcher hasn't fired yet (common on Windows due to watcher latency).
            if (
              (executionState === EXECUTION_STATES.RUNNING ||
                executionState === EXECUTION_STATES.PAUSING) &&
              !activeWorkingFilePaths.has(filePath)
            ) {
              const isCli =
                (await manager?.ensureCliWatchSession(filePath)) ?? false;
              if (isCli) {
                Log.debug(
                  `[WorkflowSerializer] getRecentWorkflows: "${file}" has active CLI lock — keeping running state (CliWatchSession registered)`
                );
                // executionState stays "running"; the session is now in cliSessions
                // so the next GET_WORKFLOWS_LIST will move it to the Running section.
              } else {
                Log.debug(
                  `[WorkflowSerializer] getRecentWorkflows: normalizing "${file}" running→stopped (not in activeWorkingFilePaths: [${[...activeWorkingFilePaths].map((p) => path.basename(p)).join(", ") || "none"}])`
                );
                executionState = EXECUTION_STATES.STOPPED;
              }
            }

            return {
              filePath,
              workflowName:
                workingFile.workflowName ||
                file.replace(".flightpath.json", ""),
              executionState,
              startedAt: workingFile.startedAt || 0,
              lastModifiedAt: lastModified,
              isFavorite: workingFile.isFavorite ?? false,
            };
          } catch (error) {
            Log.warn(`Failed to parse workflow file ${file}:`, error);
            return null;
          }
        })
      );

      const validWorkflows = workflows
        .filter((w) => w !== null)
        .sort((a, b) => b!.lastModifiedAt - a!.lastModifiedAt);

      pm({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: validWorkflows,
      });
    } catch (error) {
      Log.error("Failed to get recent workflows:", error);
      pm({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
    }
  }

  async handleLoadWorkflow(message: any): Promise<void> {
    const { filePath } = message;

    try {
      await this.getManager()?.loadWorkingFile(filePath);
    } catch (error) {
      Log.error("Failed to load workflow:", error);
      vscode.window.showErrorMessage(
        `Failed to load workflow: ${getErrorMessage(error)}`
      );
    }
  }

  async handleToggleFavorite(filePath: string): Promise<void> {
    try {
      const workingFile = (await readJsonFile(filePath)) as WorkingFile;
      if (!workingFile || typeof workingFile !== "object") {
        Log.warn(
          `handleToggleFavorite: invalid working file payload for "${filePath}"`
        );
        return;
      }

      workingFile.isFavorite = !(workingFile.isFavorite ?? false);
      await fs.writeFile(
        filePath,
        JSON.stringify(workingFile, null, 2),
        "utf-8"
      );
    } catch (error) {
      Log.error("Failed to toggle workflow favorite:", error);
    }
  }

  async handleClearWorkflowHistory(
    postMessage?: PostMessageFn
  ): Promise<boolean> {
    const pm = postMessage ?? this.postMessage;
    const confirm = await vscode.window.showWarningMessage(
      "Delete all workflow history files from .flightpath/.queue?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return false;
    }

    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return false;
      }

      const queueDir = path.join(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );
      const historyDir = path.join(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.HISTORY_DIR
      );

      try {
        const files = await fs.readdir(queueDir);
        const workflowFiles = files.filter((f) =>
          f.endsWith(".flightpath.json")
        );

        for (const file of workflowFiles) {
          await fs.unlink(path.join(queueDir, file));
        }

        try {
          await fs.rm(historyDir, { recursive: true, force: true });
        } catch (historyError) {
          Log.warn("Failed to delete history directory:", historyError);
        }

        vscode.window.showInformationMessage(
          `Deleted ${workflowFiles.length} workflow history files`
        );

        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return true;
      } catch (error) {
        Log.error("Failed to delete workflow files:", error);
        vscode.window.showErrorMessage(
          `Failed to delete workflow history: ${getErrorMessage(error)}`
        );
      }
    } catch (error) {
      Log.error("Failed to clear workflow history:", error);
    }
    return false;
  }

  /**
   * Handle REMOVE_WORKFLOW_HISTORY: delete the .flightpath.json working file and associated
   * .history/<workflowId>/ directory for a single entry.
   */
  async handleRemoveWorkflowHistory(filePath: string): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return;
      }

      const queueDir = path.join(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.QUEUE_DIR
      );
      const historyBaseDir = path.join(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        PATH_CONSTANTS.HISTORY_DIR
      );

      const stem = path
        .basename(filePath)
        .replace(/\.working\.(yaml|yml|json)$/i, "")
        .replace(/\.flightpath\.(yaml|yml|json)$/i, "")
        .replace(/\.(yaml|yml|json)$/i, "");

      const files = await fs.readdir(queueDir).catch(() => [] as string[]);
      const candidates = files.filter(
        (f) =>
          (f === `${stem}.flightpath.json` || f.startsWith(`${stem}.`)) &&
          f.endsWith(".flightpath.json")
      );

      for (const candidate of candidates) {
        await fs
          .unlink(path.join(queueDir, candidate))
          .catch((err) =>
            Log.warn(
              `handleRemoveWorkflowHistory: failed to delete ${candidate}:`,
              err
            )
          );

        const workflowId = candidate
          .replace(/\.flightpath\.json$/, "")
          .replace(/\.flightpath\.yaml$/, "");
        const historyDir = path.join(historyBaseDir, workflowId);
        await fs
          .rm(historyDir, { recursive: true, force: true })
          .catch((err) =>
            Log.warn(
              `handleRemoveWorkflowHistory: failed to delete history dir ${workflowId}:`,
              err
            )
          );
      }

      Log.debug(
        `handleRemoveWorkflowHistory: removed ${candidates.length} working file(s) and history for "${stem}"`
      );
    } catch (error) {
      Log.error("Failed to remove workflow history entry:", error);
    }
  }

  // ============================================================================
  // Run History
  // ============================================================================

  /**
   * Handle LOAD_RUN_HISTORY: load a specific historical run and send to webview.
   * runIndex 0 = most recent, 1 = second most recent, etc.
   */
  async handleLoadRunHistory(
    runIndex: number,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const outputHistoryManager = this.getOutputHistoryManager();
    if (!outputHistoryManager) {
      return;
    }

    try {
      const workingFilePath =
        this.getManager()?.getQueueState(clientId).workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      const workflowId =
        OutputHistoryManager.extractWorkflowId(workingFilePath);
      const runs = await outputHistoryManager.getRunsForWorkflow(workflowId);
      if (!runs.length) {
        return;
      }

      const fileName = runs[runIndex];
      if (!fileName) {
        Log.warn(`No history file at run index ${runIndex}`);
        return;
      }

      const historyPath = outputHistoryManager.getHistoryFilePath(
        workflowId,
        fileName
      );

      const history = await outputHistoryManager.loadHistory(historyPath);
      const [runTimestamps, runStates] = await Promise.all([
        outputHistoryManager.getRunTimestamps(workflowId),
        outputHistoryManager.getRunStates(workflowId),
      ]);

      pm({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history,
        availableRuns: runs.length,
        currentRunIndex: runIndex,
        runTimestamps,
        runStates,
      });
    } catch (error) {
      Log.error("Failed to load run history:", error);
    }
  }

  /**
   * Handle CLEAR_RUN_HISTORY: delete all history files for the current workflow.
   */
  async handleClearRunHistory(
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const outputHistoryManager = this.getOutputHistoryManager();
    if (!outputHistoryManager) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "Delete all output history for this workflow?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return;
    }

    try {
      const workingFilePath =
        this.getManager()?.getQueueState(clientId).workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      const workflowId =
        OutputHistoryManager.extractWorkflowId(workingFilePath);
      const workflowHistoryDir = path.join(
        outputHistoryManager.historyBaseDir,
        workflowId
      );

      try {
        await fs.rm(workflowHistoryDir, { recursive: true, force: true });
      } catch (error) {
        Log.warn("Failed to delete history directory:", error);
      }

      pm({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history: null,
        availableRuns: 0,
        currentRunIndex: 0,
      });

      vscode.window.showInformationMessage("Output history cleared.");
    } catch (error) {
      Log.error("Failed to clear run history:", error);
      vscode.window.showErrorMessage(
        `Failed to clear run history: ${getErrorMessage(error)}`
      );
    }
  }
}
