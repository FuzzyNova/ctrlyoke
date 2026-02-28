import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { TemplateManager } from "../flightpath/TemplateManager";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { OutputHistoryManager } from "../flightpath/orchestration/OutputHistoryManager";
import type { PostMessageFn } from "./WebviewSettingsSync";

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
  async handleSaveWorkflowRequest(): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow manager available.",
      });
      return;
    }

    const queueState = manager.getQueueState();
    const workingFilePath = queueState.workingFilePath;

    if (!workingFilePath) {
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow loaded.",
      });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workflowsDir = workspaceFolder
      ? path.join(workspaceFolder.uri.fsPath, ".flightpath", "workflows")
      : ".flightpath/workflows";

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

      this.postMessage({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA,
        defaultPath,
        defaultFormat,
        workflowsDir,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.postMessage({
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
    format: "yaml" | "json"
  ): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow manager available.",
      });
      return;
    }

    const queueState = manager.getQueueState();
    const workingFilePath = queueState.workingFilePath;

    if (!workingFilePath) {
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: "No workflow loaded.",
      });
      return;
    }

    try {
      const rawContent = await fs.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(rawContent);

      // Build clean PromptFile — strip all working-file-only and runtime fields.
      const WORKFLOW_FIELDS = [
        "prompt",
        "prompts",
        "harness",
        "model",
        "agent",
        "resumeSession",
        "allowDynamicExtension",
        "sessionId",
        "endCondition",
      ] as const;

      const PROMPT_FIELDS = [
        "name",
        "prompt",
        "harness",
        "model",
        "agent",
        "resumeSession",
        "allowDynamicExtension",
        "sessionId",
        "endCondition",
      ] as const;

      const clean: Record<string, unknown> = {};

      for (const field of WORKFLOW_FIELDS) {
        if (field in workingFile && field !== "prompts") {
          clean[field] = workingFile[field];
        }
      }

      if (Array.isArray(workingFile.prompts)) {
        clean.prompts = workingFile.prompts.map(
          (p: Record<string, unknown>) => {
            const cleanPrompt: Record<string, unknown> = {};
            for (const field of PROMPT_FIELDS) {
              if (field in p) {
                cleanPrompt[field] = p[field];
              }
            }
            return cleanPrompt;
          }
        );
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

      Log.info(`Saved workflow to: ${absolutePath}`);

      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVED,
        filePath: absolutePath,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      Log.error("Failed to save workflow:", error);
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
        error: msg,
      });
    }
  }

  // ============================================================================
  // Export Output
  // ============================================================================

  async handleExportOutput(content: string, fileName?: string): Promise<void> {
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
      const outputDir = path.join(workspaceRoot, ".flightpath", "output");
      await fs.mkdir(outputDir, { recursive: true });
      defaultUri = vscode.Uri.file(path.join(outputDir, baseName));
    } else {
      defaultUri = vscode.Uri.file(baseName);
    }

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
      vscode.window.showInformationMessage(`Output exported to ${uri.fsPath}`);
    }
  }

  // ============================================================================
  // New Workflow / Template Modal
  // ============================================================================

  async handleNewWorkflow(): Promise<void> {
    try {
      const templates = await this.templateManager.getAvailableTemplates();
      const workflowsDir = ConfigurationUtils.getWorkflowsDirectory();
      const defaultTemplateId = ConfigurationUtils.getDefaultWorkflowTemplate();

      this.postMessage({
        type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          variables: t.variables,
          isBuiltIn: t.isBuiltIn,
          isAction: t.isAction,
        })),
        workflowsDir,
        defaultTemplateId,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to load templates: ${errorMsg}`);
    }
  }

  async handleTemplateSelected(templateId: string): Promise<void> {
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      this.postMessage({
        type: MESSAGE_TYPES.TEMPLATE_INFO,
        template,
      });
    } catch (error) {
      Log.error("Failed to load template:", error);
    }
  }

  async handleSetDefaultTemplate(templateId: string): Promise<void> {
    try {
      await ConfigurationUtils.setDefaultWorkflowTemplate(templateId);

      this.postMessage({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        templateId,
      });
    } catch (error) {
      Log.error("Failed to set default template:", error);
    }
  }

  /**
   * TODO: Implement createWorkflowFromTemplate in WorkflowCommandHandler.
   * Currently a stub — redirects user to the Create Prompt File command.
   */
  async handleCreateWorkflow(_message: any): Promise<void> {
    try {
      vscode.window.showWarningMessage(
        "Creating workflows from templates is not yet implemented. Please use 'FlightPath: Create Prompt File' command."
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to create workflow: ${errorMsg}`);
    }
  }

  handleCreateNewTemplate(): void {
    vscode.commands.executeCommand("flightpath.createPromptFile");
  }

  // ============================================================================
  // Workflow Name
  // ============================================================================

  async handleUpdateWorkflowName(
    message: any,
    updateWorkflowNameFn: (name: string) => void
  ): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { workflowName } = message;
    await manager.updateWorkflowName?.(workflowName);
    updateWorkflowNameFn(workflowName);
  }

  // ============================================================================
  // Recent Workflows
  // ============================================================================

  async handleGetRecentWorkflows(): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");

      try {
        await fs.access(queueDir);
      } catch {
        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const files = await fs.readdir(queueDir);
      const workflowFiles = files.filter((f) => f.endsWith(".flightpath.json"));

      const workflows = await Promise.all(
        workflowFiles.map(async (file) => {
          const filePath = path.join(queueDir, file);

          try {
            const content = await fs.readFile(filePath, "utf8");
            const workingFile = JSON.parse(content);

            const lastModified =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

            return {
              filePath,
              workflowName:
                workingFile.workflowName ||
                file.replace(".flightpath.json", ""),
              executionState: workingFile._runtime?.executionState || "IDLE",
              startedAt: workingFile.startedAt || 0,
              lastModifiedAt: lastModified,
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

      this.postMessage({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: validWorkflows,
      });
    } catch (error) {
      Log.error("Failed to get recent workflows:", error);
      this.postMessage({
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
        `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async handleClearWorkflowHistory(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "Delete all workflow history files from .flightpath/.queue?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return;
    }

    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return;
      }

      const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");
      const historyDir = path.join(workspaceRoot, ".flightpath", ".history");

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

        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
      } catch (error) {
        Log.error("Failed to delete workflow files:", error);
        vscode.window.showErrorMessage(
          `Failed to delete workflow history: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      Log.error("Failed to clear workflow history:", error);
    }
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

      const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");
      const historyBaseDir = path.join(
        workspaceRoot,
        ".flightpath",
        ".history"
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

      Log.info(
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
  async handleLoadRunHistory(runIndex: number): Promise<void> {
    const outputHistoryManager = this.getOutputHistoryManager();
    if (!outputHistoryManager) {
      return;
    }

    try {
      const workingFilePath =
        this.getManager()?.getQueueState().workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      const workflowId =
        outputHistoryManager.extractWorkflowId(workingFilePath);
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

      this.postMessage({
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
  async handleClearRunHistory(): Promise<void> {
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
        this.getManager()?.getQueueState().workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      const workflowId =
        outputHistoryManager.extractWorkflowId(workingFilePath);
      const workflowHistoryDir = path.join(
        outputHistoryManager.historyBaseDir,
        workflowId
      );

      try {
        await fs.rm(workflowHistoryDir, { recursive: true, force: true });
      } catch (error) {
        Log.warn("Failed to delete history directory:", error);
      }

      this.postMessage({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history: null,
        availableRuns: 0,
        currentRunIndex: 0,
      });

      vscode.window.showInformationMessage("Output history cleared.");
    } catch (error) {
      Log.error("Failed to clear run history:", error);
      vscode.window.showErrorMessage(
        `Failed to clear run history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
