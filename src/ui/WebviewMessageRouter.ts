import * as vscode from "vscode";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  type WebviewLogLevel,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
} from "../completions/CompletionHelpers";
import { ContextExpander } from "../utils/ContextExpander";
import { encode } from "gpt-tokenizer";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { WebviewSettingsSync, PostMessageFn } from "./WebviewSettingsSync";
import type { WorkflowSerializer } from "./WorkflowSerializer";

/**
 * WebviewMessageRouter
 *
 * Dispatch table replacing the giant switch statement in FlightPathWebviewProvider.
 * Routes incoming webview messages to the appropriate handler on the provider,
 * WebviewSettingsSync, or WorkflowSerializer.
 *
 * Each handler function is registered in the dispatch table at construction time.
 */
export class WebviewMessageRouter {
  private readonly handlers: Map<
    string,
    (message: any) => void | Promise<void>
  >;

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly settingsSync: WebviewSettingsSync,
    private readonly serializer: WorkflowSerializer,
    private readonly getManager: () => WorkflowOrchestrator | undefined,
    private readonly callbacks: WebviewRouterCallbacks
  ) {
    this.handlers = this.buildDispatchTable();
  }

  /**
   * Route a webview message to the appropriate handler.
   */
  async route(message: any): Promise<void> {
    try {
      const handler = this.handlers.get(message.type);
      if (handler) {
        await handler(message);
      } else {
        Log.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Log.error(`Error handling webview message (${message.type}):`, errorMsg);
    }
  }

  // ============================================================================
  // Dispatch Table
  // ============================================================================

  private buildDispatchTable(): Map<
    string,
    (message: any) => void | Promise<void>
  > {
    const table = new Map<string, (message: any) => void | Promise<void>>();

    // ── Lifecycle ──────────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.READY, async () => {
      Log.debug("Received READY from React — sending INIT");
      this.settingsSync.sendInitialState();
      const manager = this.getManager();
      if (manager) {
        await manager.setDashboardReady();
      }
    });

    // ── Dashboard — Workflow Control ──────────────────────────────────────
    table.set(MESSAGE_TYPES.NEW_PROMPT, () => {
      vscode.commands.executeCommand("flightpath.createDraftPrompt");
    });

    table.set(MESSAGE_TYPES.SELECT_FILE, () => {
      vscode.commands.executeCommand("flightpath.selectPromptFile");
    });

    table.set(MESSAGE_TYPES.APPEND_FILE, () => {
      vscode.commands.executeCommand("flightpath.appendFromDashboard");
    });

    table.set(MESSAGE_TYPES.EDIT_FILE, () => {
      vscode.commands.executeCommand("flightpath.editCurrentPromptFile");
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW, async () => {
      await this.callbacks.handleClearWorkflow();
    });

    table.set(MESSAGE_TYPES.RUN, () => {
      vscode.commands.executeCommand("flightpath.run");
    });

    table.set(MESSAGE_TYPES.PAUSE, () => {
      vscode.commands.executeCommand("flightpath.pause");
    });

    table.set(MESSAGE_TYPES.RESUME, () => {
      vscode.commands.executeCommand("flightpath.resume");
    });

    table.set(MESSAGE_TYPES.STOP, () => {
      vscode.commands.executeCommand("flightpath.stop");
    });

    table.set(MESSAGE_TYPES.SHOW_OUTPUT, () => {
      vscode.commands.executeCommand("flightpath.showOutputPanel");
    });

    table.set(MESSAGE_TYPES.EXPORT_OUTPUT, (message) => {
      this.serializer.handleExportOutput(message.content, message.fileName);
    });

    // ── Dashboard — Prompt Editor ────────────────────────────────────────
    table.set(MESSAGE_TYPES.EXECUTE_PROMPT, (message) => {
      this.handleExecutePrompt(message);
    });

    table.set(MESSAGE_TYPES.UPDATE_PROMPT, (message) => {
      this.handleUpdatePrompt(message);
    });

    table.set(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, (message) => {
      this.handleUpdateFinalPrompt(message);
    });

    table.set(MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT, (message) => {
      this.postMessage({
        type: MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT,
        index: message.index,
      });
    });

    table.set(MESSAGE_TYPES.DELETE_PROMPT, async (message) => {
      await this.handleDeletePrompt(message);
    });

    table.set(MESSAGE_TYPES.RESET_WORKFLOW_STATE, async () => {
      await this.handleResetWorkflowState();
    });

    // ── Dashboard — CodeMirror Editor ────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_COMPLETIONS, async (message) => {
      await this.handleCompletionRequest(
        message.trigger,
        message.prefix,
        message.position
      );
    });

    table.set(MESSAGE_TYPES.OPEN_FILE, (message) => {
      this.handleOpenFile(message.path, message.lineStart, message.lineEnd);
    });

    table.set(
      MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      async (message) => {
        await this.handleAttachmentTokenCountRequest(message.references);
      }
    );

    // ── Output History ───────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.LOAD_RUN_HISTORY, async (message) => {
      await this.serializer.handleLoadRunHistory(message.runIndex);
    });

    table.set(MESSAGE_TYPES.CLEAR_RUN_HISTORY, async () => {
      await this.serializer.handleClearRunHistory();
    });

    // ── Dashboard — New Workflow Modal ───────────────────────────────────
    table.set(MESSAGE_TYPES.NEW_WORKFLOW, () => {
      this.serializer.handleNewWorkflow();
    });

    table.set(MESSAGE_TYPES.TEMPLATE_SELECTED, (message) => {
      this.serializer.handleTemplateSelected(message.templateId);
    });

    table.set(MESSAGE_TYPES.SET_DEFAULT_TEMPLATE, (message) => {
      this.serializer.handleSetDefaultTemplate(message.templateId);
    });

    table.set(MESSAGE_TYPES.CREATE_WORKFLOW, (message) => {
      this.serializer.handleCreateWorkflow(message);
    });

    table.set(MESSAGE_TYPES.CREATE_NEW_TEMPLATE, () => {
      this.serializer.handleCreateNewTemplate();
    });

    // ── Dashboard — Workflow Status ──────────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_NAME, (message) => {
      this.serializer.handleUpdateWorkflowName(
        message,
        this.callbacks.updateWorkflowName
      );
    });

    table.set(MESSAGE_TYPES.GET_RECENT_WORKFLOWS, () => {
      this.serializer.handleGetRecentWorkflows();
    });

    table.set(MESSAGE_TYPES.LOAD_WORKFLOW, (message) => {
      this.serializer.handleLoadWorkflow(message);
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY, () => {
      this.serializer.handleClearWorkflowHistory();
    });

    // ── Settings — Harness & Model Selection ─────────────────────────────
    table.set(MESSAGE_TYPES.CHANGE_HARNESS, (message) => {
      this.settingsSync.handleHarnessChange(message.harness);
    });

    table.set(MESSAGE_TYPES.CHANGE_MODEL, (message) => {
      this.settingsSync.handleModelChange(message.model);
    });

    table.set(MESSAGE_TYPES.CHANGE_AGENT, (message) => {
      this.settingsSync.handleAgentChange(message.agent);
    });

    table.set(MESSAGE_TYPES.CHANGE_EXECUTION_MODE, (message) => {
      this.settingsSync.handleExecutionModeChange(message.executionMode);
    });

    table.set(MESSAGE_TYPES.CHANGE_RESUME_SESSION, (message) => {
      this.settingsSync.handleResumeSessionChange(message.enabled);
    });

    table.set(MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE, (message) => {
      this.settingsSync.handleDynamicQueueChange(message.enabled);
    });

    table.set(MESSAGE_TYPES.OPEN_SETTINGS, () => {
      this.settingsSync.handleOpenSettings();
    });

    // ── Settings — Workflow Properties ───────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, (message) => {
      this.settingsSync.handleUpdateWorkflowProperty(
        message.property,
        message.value
      );
    });

    table.set(MESSAGE_TYPES.SET_AS_DEFAULT, (message) => {
      this.settingsSync.handleSetAsDefault(
        message.property,
        message.value,
        message.harness
      );
    });

    table.set(MESSAGE_TYPES.GET_CONFIG, (message) => {
      this.settingsSync.handleGetConfig(message.key);
    });

    table.set(MESSAGE_TYPES.UPDATE_CONFIG, (message) => {
      this.settingsSync.handleUpdateConfig(message.key, message.value);
    });

    table.set(MESSAGE_TYPES.LOG_MESSAGE, (message) => {
      this.handleWebviewLog(message.level, message.message);
    });

    // ── Save Workflow ────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST, async () => {
      await this.serializer.handleSaveWorkflowRequest();
    });

    table.set(MESSAGE_TYPES.SAVE_WORKFLOW, async (message) => {
      await this.serializer.handleSaveWorkflow(
        message.filePath,
        message.format
      );
    });

    // ── Multi-workflow coordination ──────────────────────────────────────
    table.set(MESSAGE_TYPES.GET_WORKFLOWS_LIST, () => {
      const manager = this.getManager();
      const summaries = manager?.getWorkflowSummaries() ?? [];
      Log.trace(
        `[GET_WORKFLOWS_LIST] returning ${summaries.length} summaries: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState})`).join(", ") || "(none)"}`
      );
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOWS_LIST,
        workflows: summaries,
      });
    });

    table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, (message) => {
      const { workflowId } = message;
      if (workflowId) {
        this.getManager()?.setActiveWorkflow(workflowId);
      }
    });

    // ── Per-workflow targeted controls ────────────────────────────────────
    table.set(MESSAGE_TYPES.PAUSE_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getManager()?.pauseWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.RESUME_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getManager()?.resumeWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.STOP_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getManager()?.stopWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.STOP_CLI_RUN, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getManager()?.stopCliSession(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY, async (message) => {
      const { filePath } = message;
      if (filePath) {
        await this.serializer.handleRemoveWorkflowHistory(filePath);
      }
    });

    table.set(MESSAGE_TYPES.UPDATE_CONFIRM_DELETE, async (message) => {
      const { value } = message;
      if (typeof value === "boolean") {
        await ConfigurationUtils.setConfirmDeleteOperations(value);
      }
    });

    return table;
  }

  // ============================================================================
  // Dashboard Prompt Handlers
  // ============================================================================

  private async handleExecutePrompt(message: any): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { text, properties, action, promptName, forceNewWorkflow } = message;

    try {
      await manager.executeEphemeralPrompt(
        text,
        properties,
        action,
        promptName,
        forceNewWorkflow
      );
    } catch (error) {
      Log.error("Failed to execute ephemeral prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to execute prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleUpdatePrompt(message: any): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { index, text, properties } = message;

    try {
      await manager.updatePromptInQueue(index, text, properties);
    } catch (error) {
      Log.error("Failed to update prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to update prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleUpdateFinalPrompt(message: any): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    try {
      await manager.updateFinalPromptInQueue(message.finalPrompt ?? null);
    } catch (error) {
      Log.error("Failed to update finalPrompt:", error);
      vscode.window.showErrorMessage(
        `Failed to update finalPrompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleDeletePrompt(message: any): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { index } = message;

    try {
      await manager.deletePromptFromQueue(index);
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to delete prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleResetWorkflowState(): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    try {
      await manager.resetWorkflowState();
    } catch (error) {
      Log.error("Failed to reset workflow state:", error);
      vscode.window.showErrorMessage(
        `Failed to reset workflow state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================================================
  // CodeMirror Editor Handlers
  // ============================================================================

  private async handleCompletionRequest(
    trigger: string,
    prefix: string,
    position: number
  ): Promise<void> {
    try {
      const items = await this.getCompletionItems(trigger, prefix);

      Log.debug(
        `[Dashboard] Completion: trigger="${trigger}", prefix="${prefix}", position=${position} → ${items.length} items`
      );

      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: items.map((item) => ({
          label: item.label,
          kind: item.kind,
          insertText: item.insertText,
          detail: item.detail,
          documentation: item.documentation,
          sortText: item.sortText,
        })),
        from: position,
      });
    } catch (error) {
      Log.error("Failed to get completions:", error);
      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: [],
        from: position,
      });
    }
  }

  /**
   * Get completion items based on trigger (@file or #file)
   */
  private async getCompletionItems(
    trigger: string,
    prefix: string
  ): Promise<any[]> {
    const filterText = prefix.substring(1); // Remove @ or #

    if (trigger === "@") {
      return await getFileCompletions(filterText);
    } else if (trigger === "#") {
      return await getHashCompletions(filterText);
    }

    Log.warn(`[Dashboard] Unknown trigger: "${trigger}"`);
    return [];
  }

  private async handleOpenFile(
    relativePath: string,
    lineStart?: number,
    lineEnd?: number
  ): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        Log.warn("No workspace folder open");
        return;
      }

      const normalizedPath = relativePath.replace(/\\/g, "/");
      const isDirectory = normalizedPath.endsWith("/");
      const trimmedPath = isDirectory
        ? normalizedPath.replace(/\/+$/, "")
        : normalizedPath;

      // Detect absolute paths (Windows: C:/... or C:\..., POSIX: /...)
      // and resolve them directly instead of joining with the workspace root.
      const isAbsolute =
        /^[A-Za-z]:\//.test(trimmedPath) || trimmedPath.startsWith("/");
      const targetUri = isAbsolute
        ? vscode.Uri.file(trimmedPath.replace(/\//g, "\\"))
        : vscode.Uri.joinPath(
            workspaceFolder.uri,
            ...trimmedPath.split("/").filter(Boolean)
          );

      if (isDirectory) {
        try {
          await vscode.commands.executeCommand("revealInExplorer", targetUri);
        } catch {
          await vscode.commands.executeCommand("revealFileInOS", targetUri);
        }
        return;
      }

      const options: vscode.TextDocumentShowOptions = {
        preview: false,
      };

      if (lineStart) {
        const start = new vscode.Position(lineStart - 1, 0);
        const end = lineEnd
          ? new vscode.Position(lineEnd - 1, Number.MAX_SAFE_INTEGER)
          : start;
        options.selection = new vscode.Range(start, end);
      }

      await vscode.window.showTextDocument(targetUri, options);
    } catch (error) {
      Log.error("Error opening file:", error);
      vscode.window.showErrorMessage(`Failed to open: ${relativePath}`);
    }
  }

  /**
   * Handle request to count tokens for attachment references.
   */
  private async handleAttachmentTokenCountRequest(
    references: string[]
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot || !references || references.length === 0) {
      this.postMessage({
        type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
        counts: {},
      });
      return;
    }

    const counts: Record<string, number> = {};

    await Promise.all(
      references.map(async (rawRef) => {
        try {
          const expander = new ContextExpander(workspaceRoot);
          const expanded = await expander.expandContext(rawRef);

          if (expanded === rawRef) {
            counts[rawRef] = 0;
            return;
          }

          const attachmentContent = expanded.slice(
            0,
            expanded.lastIndexOf(`\n\n${rawRef}`)
          );
          counts[rawRef] = encode(attachmentContent).length;
        } catch (error) {
          Log.warn(`Failed to count tokens for reference "${rawRef}":`, error);
          counts[rawRef] = 0;
        }
      })
    );

    this.postMessage({
      type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
      counts,
    });
  }

  // ============================================================================
  // Webview Logging
  // ============================================================================

  private handleWebviewLog(level: WebviewLogLevel, message: string): void {
    const prefixed = `[Webview] ${message}`;
    switch (level) {
      case LOG_LEVELS.DEBUG:
        Log.debug(prefixed);
        break;
      case LOG_LEVELS.WARN:
        Log.warn(prefixed);
        break;
      case LOG_LEVELS.ERROR:
        Log.error(prefixed);
        break;
      default:
        Log.debug(prefixed);
        break;
    }
  }
}

/**
 * Callbacks from the router back to the FlightPathWebviewProvider.
 * These are methods that remain on the provider because they're part
 * of the public API or touch provider-internal state.
 */
export interface WebviewRouterCallbacks {
  handleClearWorkflow: () => Promise<void>;
  updateWorkflowName: (name: string) => void;
}
