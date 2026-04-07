import * as vscode from "vscode";
import * as path from "path";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  FINAL_STEP_PHASES,
  SESSION_KINDS,
  type WebviewLogLevel,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
  getGitChangeCompletions,
  getPromptFileCompletions,
} from "../completions/CompletionHelpers";
import * as fs from "fs";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { ContextExpander } from "../utils/ContextExpander";
import { encode } from "gpt-tokenizer";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { WebviewSettingsSync, PostMessageFn } from "./WebviewSettingsSync";
import type { WorkflowSerializer } from "./WorkflowSerializer";
import type {
  UndoPromptChangesMessage,
  UndoFileInstruction,
  RedoPromptChangesMessage,
  UndoWorkflowChangesMessage,
  RedoWorkflowChangesMessage,
  UndoRecord,
} from "../types/WebviewMessageTypes";
import { WorkspaceSnapshotService } from "../utils/WorkspaceSnapshotService";
import { getPtyProcessManager } from "../flightpath/harness/PtyProcessManager";
import {
  safeDiscoverLocalMcpServers,
  safeFetchMcpRegistry,
} from "../utils/McpDiscoveryUtils";

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
  private routeQueue: Promise<void> = Promise.resolve();
  private scopedPostMessage?: PostMessageFn;
  private themeVarsCapturedCallback?: (vars: Record<string, string>) => void;

  private readonly handlers: Map<
    string,
    (message: any) => void | Promise<void>
  >;

  constructor(
    private readonly defaultPostMessage: PostMessageFn,
    private readonly settingsSync: WebviewSettingsSync,
    private readonly serializer: WorkflowSerializer,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly callbacks: WebviewRouterCallbacks
  ) {
    this.handlers = this.buildDispatchTable();
  }

  setThemeVarsCapturedCallback(
    cb: ((vars: Record<string, string>) => void) | undefined
  ): void {
    this.themeVarsCapturedCallback = cb;
  }

  /**
   * Route a webview message to the appropriate handler.
   */
  async route(message: any, options?: WebviewRouteOptions): Promise<void> {
    this.routeQueue = this.routeQueue.then(() =>
      this.withScopedPostMessage(options?.postMessage, () =>
        this.routeSingleMessage(message)
      )
    );

    await this.routeQueue;
  }

  private async withScopedPostMessage(
    postMessage: PostMessageFn | undefined,
    action: () => Promise<void>
  ): Promise<void> {
    const previous = this.scopedPostMessage;
    this.scopedPostMessage = postMessage;
    try {
      await action();
    } finally {
      this.scopedPostMessage = previous;
    }
  }

  private getCurrentPostMessage(): PostMessageFn {
    return this.scopedPostMessage ?? this.defaultPostMessage;
  }

  private emitMessage(message: any): void {
    this.getCurrentPostMessage()(message);
  }

  private async routeSingleMessage(message: any): Promise<void> {
    try {
      const handler = this.handlers.get(message.type);
      if (handler) {
        await handler(message);
      } else {
        Log.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
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
      this.settingsSync.sendInitialState(this.getCurrentPostMessage());
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.setDashboardReady();
      }
      // Reconnect active PTY sessions to the fresh webview
      const ptyManager = getPtyProcessManager();
      if (ptyManager) {
        for (const session of ptyManager.getAllSessions()) {
          this.emitMessage({
            type: MESSAGE_TYPES.TERMINAL_STARTED,
            workflowId: session.workflowId,
            sessionId: session.id,
            stepName: session.stepName,
            kind: session.kind,
            promptNumber: session.promptNumber,
          });
          // Flush reconnect buffer
          for (const chunk of session.reconnectBuffer) {
            this.emitMessage({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: session.workflowId,
              sessionId: session.id,
              data: chunk,
            });
          }
          session.clearReconnectBuffer();
        }
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

    table.set(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, async (message) => {
      await this.handleUpdateFinalStep(message);
    });

    table.set(MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT, (message) => {
      this.emitMessage({
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

    table.set(MESSAGE_TYPES.SET_START_POSITION, async (message) => {
      await this.handleSetStartPosition(message.toIndex as number);
    });

    table.set(MESSAGE_TYPES.REORDER_PROMPTS, async (message) => {
      await this.getOrchestrator()?.reorderPendingPrompts(
        message.newPendingOrder as number[]
      );
    });

    table.set(MESSAGE_TYPES.UNDO_REDO_SYNC, async (message) => {
      await this.getOrchestrator()?.syncStepsForUndoRedo(
        message.steps,
        message.finalStep ?? null
      );
      if ("workflowProperties" in message) {
        const workflowProperties = {
          harness: message.workflowProperties?.harness,
          model: message.workflowProperties?.model,
          agent: message.workflowProperties?.agent,
          skills: message.workflowProperties?.skills,
          resumeSession: message.workflowProperties?.resumeSession,
          sessionId: message.workflowProperties?.sessionId,
          mcpServers: message.workflowProperties?.mcpServers,
          hooks: message.workflowProperties?.hooks,
          endCondition: message.workflowProperties?.endCondition,
          priorContext: message.workflowProperties?.priorContext,
          additionalArgs: message.workflowProperties?.additionalArgs,
          toolPermissions: message.workflowProperties?.toolPermissions,
        };
        this.settingsSync.handleUpdateWorkflowProperties(
          workflowProperties,
          this.getCurrentPostMessage()
        );
      }
    });

    // ── Dashboard — CodeMirror Editor ────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_COMPLETIONS, async (message) => {
      await this.handleCompletionRequest(
        message.trigger,
        message.prefix,
        message.position,
        message.seq
      );
    });

    table.set(MESSAGE_TYPES.OPEN_FILE, (message) => {
      this.handleOpenFile(message.path, message.lineStart, message.lineEnd);
    });

    table.set(MESSAGE_TYPES.OPEN_GIT_CHANGE, async (message) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return;
      }
      await vscode.commands.executeCommand("flightpath.openGitChange", {
        workspaceRoot,
        ref: message.ref,
      });
    });

    table.set(MESSAGE_TYPES.VALIDATE_FILE_REF, async (message) => {
      await this.handleFileRefValidation(message.filePath);
    });

    table.set(
      MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      async (message) => {
        await this.handleAttachmentTokenCountRequest(message.references);
      }
    );

    // ── MCP Discovery ────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_MCP_LOCAL_SERVERS, async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceRoot =
        workspaceFolders && workspaceFolders.length > 0
          ? workspaceFolders[0].uri.fsPath
          : "";
      const result = await safeDiscoverLocalMcpServers(workspaceRoot);
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_LOCAL_SERVERS_RESULT,
        servers: result.servers,
        ...(result.error ? { error: result.error } : {}),
      });
    });

    table.set(MESSAGE_TYPES.REQUEST_MCP_REGISTRY, async (message) => {
      const result = await safeFetchMcpRegistry({
        cursor: message.cursor,
        search: message.query || undefined,
        updatedSince: message.updatedSince,
      });
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_REGISTRY_RESULT,
        servers: result.servers,
        query: message.query,
        nextCursor: result.nextCursor,
        ...(result.error ? { error: result.error } : {}),
      });
    });

    table.set(MESSAGE_TYPES.REQUEST_MCP_WORKSPACE_SERVERS, async () => {
      const servers = await this.loadMcpWorkspaceServers();
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_WORKSPACE_SERVERS_RESULT,
        servers,
      });
    });

    table.set(MESSAGE_TYPES.SAVE_MCP_WORKSPACE_SERVERS, async (message) => {
      await this.saveMcpWorkspaceServers(message.servers ?? []);
    });

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

    table.set(MESSAGE_TYPES.BROWSE_TEMPLATE_FILE, (message) => {
      this.serializer.handleBrowseTemplateFile(
        message.variable,
        message.fileFilter
      );
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

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY, async () => {
      const currentWorkingFilePath =
        this.getOrchestrator()?.getQueueState()?.workingFilePath;
      const deleted = await this.serializer.handleClearWorkflowHistory();
      // Clear the stale working file path if it was deleted by the history clear.
      // Same logic as REMOVE_WORKFLOW_HISTORY — we do NOT call clearWorkflow() to
      // preserve the user's prompts and source file reference.
      if (deleted && currentWorkingFilePath) {
        this.getOrchestrator()?.clearWorkingFilePath();
      }
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

    table.set(MESSAGE_TYPES.CHANGE_MCP_SERVERS, (message) => {
      this.settingsSync.handleMcpServersChange(message.servers);
    });

    table.set(MESSAGE_TYPES.OPEN_SETTINGS, () => {
      this.settingsSync.handleOpenSettings();
    });

    table.set(MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST, () => {
      this.settingsSync.handleGlobalSettingsLoadRequest(this.getCurrentPostMessage());
    });

    table.set(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, (message) => {
      this.settingsSync.handleUpdateGlobalSetting(
        message.path,
        message.value,
        message.scope,
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.ENABLE_SERVER, () => {
      this.settingsSync.handleEnableServer(this.getCurrentPostMessage());
    });

    table.set(MESSAGE_TYPES.DISABLE_SERVER, () => {
      this.settingsSync.handleDisableServer(this.getCurrentPostMessage());
    });

    table.set(MESSAGE_TYPES.THEME_VARS_CAPTURED, (message) => {
      this.themeVarsCapturedCallback?.(message.vars);
    });

    // ── Settings — Workflow Properties ───────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, (message) => {
      this.settingsSync.handleUpdateWorkflowProperty(
        message.property,
        message.value,
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES, (message) => {
      this.settingsSync.handleUpdateWorkflowProperties(
        message.properties,
        this.getCurrentPostMessage()
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
      this.settingsSync.handleGetConfig(
        message.key,
        this.getCurrentPostMessage()
      );
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
      const orchestrator = this.getOrchestrator();
      const summaries = orchestrator?.getWorkflowSummaries() ?? [];
      Log.trace(
        `[GET_WORKFLOWS_LIST] returning ${summaries.length} summaries: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState})`).join(", ") || "(none)"}`
      );
      this.emitMessage({
        type: MESSAGE_TYPES.WORKFLOWS_LIST,
        workflows: summaries,
      });
    });

    table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, (message) => {
      const { workflowId } = message;
      if (workflowId) {
        this.getOrchestrator()?.setActiveWorkflow(workflowId);
      }
    });

    // ── Per-workflow targeted controls ────────────────────────────────────
    table.set(MESSAGE_TYPES.PAUSE_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getOrchestrator()?.pauseWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.RESUME_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getOrchestrator()?.resumeWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.STOP_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getOrchestrator()?.stopWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.STOP_CLI_RUN, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getOrchestrator()?.stopCliSession(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY, async (message) => {
      const { filePath } = message;
      if (filePath) {
        const currentWorkingFilePath =
          this.getOrchestrator()?.getQueueState()?.workingFilePath;
        await this.serializer.handleRemoveWorkflowHistory(filePath);
        // If the deleted file was the currently viewed working file, clear the stale
        // path reference so ensureEphemeralWorkingFile() creates a fresh one on next
        // write. We do NOT do a full clearWorkflow() to avoid wiping the user's prompts
        // or currentPromptFile (the source .yaml/.prompt.md still exists on disk).
        if (
          currentWorkingFilePath &&
          path.normalize(filePath).toLowerCase() ===
            path.normalize(currentWorkingFilePath).toLowerCase()
        ) {
          this.getOrchestrator()?.clearWorkingFilePath();
        }
      }
    });

    table.set(MESSAGE_TYPES.UPDATE_CONFIRM_DELETE, async (message) => {
      const { value } = message;
      if (typeof value === "boolean") {
        await ConfigurationUtils.setConfirmDeleteOperations(value);
      }
    });

    table.set(MESSAGE_TYPES.UPDATE_CONFIRM_RESET, async (message) => {
      const { value } = message;
      if (typeof value === "boolean") {
        await ConfigurationUtils.setConfirmResetOperations(value);
      }
    });

    // ── Prompt Undo ──────────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.UNDO_PROMPT_CHANGES, async (message) => {
      await this.handleUndoPromptChanges(message as UndoPromptChangesMessage);
    });

    table.set(MESSAGE_TYPES.REDO_PROMPT_CHANGES, async (message) => {
      await this.handleRedoPromptChanges(message as RedoPromptChangesMessage);
    });

    table.set(MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES, async (message) => {
      await this.handleUndoWorkflowChanges(
        message as UndoWorkflowChangesMessage
      );
    });

    table.set(MESSAGE_TYPES.REDO_WORKFLOW_CHANGES, async (message) => {
      await this.handleRedoWorkflowChanges(
        message as RedoWorkflowChangesMessage
      );
    });

    // ── Terminal I/O ─────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.TERMINAL_INPUT, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (ptyManager && msg.sessionId && msg.data) {
        ptyManager.writeToSession(msg.sessionId as string, msg.data as string);
      }
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESIZE, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (ptyManager && msg.sessionId && msg.cols && msg.rows) {
        ptyManager.resizeSession(
          msg.sessionId as string,
          msg.cols as number,
          msg.rows as number
        );
      }
    });

    table.set(MESSAGE_TYPES.TERMINAL_SPAWN_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      const postMsg = this.getCurrentPostMessage();
      if (!ptyManager || !msg.workflowId) return;
      const workflowId = msg.workflowId as string;
      const cwd = (msg.cwd as string | undefined) ?? process.cwd();
      const session = ptyManager.spawnShell({
        workflowId,
        cwd,
        onData: (s, chunk) => {
          postMsg({
            type: MESSAGE_TYPES.TERMINAL_OUTPUT,
            workflowId: s.workflowId,
            sessionId: s.id,
            data: chunk,
          });
        },
        onExit: (s, exitCode) => {
          postMsg({
            type: MESSAGE_TYPES.TERMINAL_ENDED,
            workflowId: s.workflowId,
            sessionId: s.id,
            kind: s.kind,
            exitCode,
          });
        },
      });
      postMsg({
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId,
        sessionId: session.id,
        stepName: session.stepName,
        kind: SESSION_KINDS.SHELL,
      });
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESTART_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      const postMsg = this.getCurrentPostMessage();
      if (!ptyManager || !msg.sessionId || !msg.workflowId) return;
      const workflowId = msg.workflowId as string;
      const newSession = ptyManager.restartShellSession(
        msg.sessionId as string,
        {
          onData: (s, chunk) => {
            postMsg({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: s.workflowId,
              sessionId: s.id,
              data: chunk,
            });
          },
          onExit: (s, exitCode) => {
            postMsg({
              type: MESSAGE_TYPES.TERMINAL_ENDED,
              workflowId: s.workflowId,
              sessionId: s.id,
              kind: s.kind,
              exitCode,
            });
          },
        }
      );
      if (newSession) {
        postMsg({
          type: MESSAGE_TYPES.TERMINAL_STARTED,
          workflowId,
          sessionId: newSession.id,
          stepName: newSession.stepName,
          kind: SESSION_KINDS.SHELL,
        });
      }
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (ptyManager && msg.sessionId) {
        ptyManager.killSession(msg.sessionId as string);
      }
    });

    return table;
  }

  // ============================================================================
  // Dashboard Prompt Handlers
  // ============================================================================

  private async handleExecutePrompt(message: any): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { text, properties, action, promptName, forceNewWorkflow } = message;

    try {
      await orchestrator.executeEphemeralPrompt(
        text,
        properties,
        action,
        promptName,
        forceNewWorkflow
      );
    } catch (error) {
      Log.error("Failed to execute ephemeral prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to execute prompt: ${getErrorMessage(error)}`
      );
      this.emitMessage({
        type: MESSAGE_TYPES.EXECUTE_PROMPT_ERROR,
        text,
      });
    }
  }

  private async handleUpdatePrompt(message: any): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { index, text, properties, clearProperties, promptName } = message;

    try {
      await orchestrator.updatePromptInQueue(
        index,
        text,
        properties,
        promptName,
        clearProperties
      );
    } catch (error) {
      Log.error("Failed to update prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to update prompt: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleUpdateFinalStep(message: any): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await orchestrator.updateFinalStepInQueue(
        message.finalStep ?? null,
        message.clearProperties
      );
    } catch (error) {
      Log.error("Failed to update finalStep:", error);
      vscode.window.showErrorMessage(
        `Failed to update finalStep: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleDeletePrompt(message: any): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    const { index } = message;

    try {
      await orchestrator.deletePromptFromQueue(index);
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to delete prompt: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleResetWorkflowState(): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await orchestrator.resetWorkflowState();
    } catch (error) {
      Log.error("Failed to reset workflow state:", error);
      vscode.window.showErrorMessage(
        `Failed to reset workflow state: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleSetStartPosition(toIndex: number): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await orchestrator.setStartPosition(toIndex);
    } catch (error) {
      Log.error("Failed to set start position:", error);
      vscode.window.showErrorMessage(
        `Failed to set start position: ${getErrorMessage(error)}`
      );
    }
  }

  // ============================================================================
  // CodeMirror Editor Handlers
  // ============================================================================

  private async handleCompletionRequest(
    trigger: string,
    prefix: string,
    position: number,
    seq?: number
  ): Promise<void> {
    try {
      const items = await this.getCompletionItems(trigger, prefix);

      Log.debug(
        `[Dashboard] Completion: trigger="${trigger}", prefix="${prefix}", position=${position} → ${items.length} items`
      );

      this.emitMessage({
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
        seq,
      });
    } catch (error) {
      Log.error("Failed to get completions:", error);
      this.emitMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: [],
        from: position,
        seq,
      });
    }
  }

  /**
   * Get completion items based on trigger (@file, #file, or path)
   */
  private async getCompletionItems(
    trigger: string,
    prefix: string
  ): Promise<any[]> {
    if (trigger === "@") {
      return await getFileCompletions(prefix.substring(1)); // Remove @
    } else if (trigger === "#") {
      return await getHashCompletions(prefix.substring(1)); // Remove #
    } else if (trigger === "~") {
      const workspaceRoot =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      return await getGitChangeCompletions(workspaceRoot, prefix.substring(1)); // Remove ~
    } else if (trigger === "path") {
      return await getPromptFileCompletions(prefix);
    }

    Log.warn(`[Dashboard] Unknown trigger: "${trigger}"`);
    return [];
  }

  /**
   * Validate whether a file-ref path typed in the prompt editor resolves to
   * an actual file.  Resolution order mirrors PromptFileParser:
   *   1. Absolute path
   *   2. Relative to workspace root
   *   3. Relative to .flightpath directory inside workspace root
   */
  private async handleFileRefValidation(filePath: string): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    let exists = false;

    try {
      if (path.isAbsolute(filePath)) {
        await fs.promises.stat(filePath);
        exists = true;
      } else if (workspaceRoot) {
        const candidates = [
          path.resolve(workspaceRoot, filePath),
          path.resolve(
            workspaceRoot,
            PATH_CONSTANTS.FLIGHTPATH_DIR,
            filePath.replace(/^\.\.?\//, "")
          ),
        ];
        for (const candidate of candidates) {
          try {
            await fs.promises.stat(candidate);
            exists = true;
            break;
          } catch {
            // try next candidate
          }
        }
      }
    } catch {
      exists = false;
    }

    this.emitMessage({
      type: MESSAGE_TYPES.FILE_REF_VALIDATION,
      exists,
      filePath,
    });
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
      this.emitMessage({
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

    this.emitMessage({
      type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
      counts,
    });
  }

  // ============================================================================
  // Prompt Undo Handler
  // ============================================================================

  private async handleUndoPromptChanges(
    message: UndoPromptChangesMessage
  ): Promise<void> {
    const { requestId, target, files, workspacePath } = message.data;
    try {
      const snapshotService = new WorkspaceSnapshotService();
      const result = await snapshotService.undoFiles(files, workspacePath);

      this.emitMessage({
        type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
        data: {
          requestId,
          target,
          restoredFiles: result.restoredFiles,
          failedFiles: result.failedFiles,
        },
      });

      if (result.restoredFiles.length > 0) {
        const undoRecord: UndoRecord = {
          appliedAt: Date.now(),
          restoredFiles: result.restoredFiles,
          redoInstructions: result.redoInstructions,
        };
        const historyFilePath = await this.resolveHistoryFilePath();
        if (historyFilePath) {
          const outputHistoryManager =
            this.getOrchestrator()?.getOutputHistoryManager();
          if (outputHistoryManager) {
            await outputHistoryManager.saveUndoRecord(
              historyFilePath,
              target,
              undoRecord
            );
          }
        }
        this.emitMessage({
          type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
          target,
          undoRecord,
        });
      }

      if (result.failedFiles.length === 0) {
        vscode.window.showInformationMessage(
          `Undo complete: restored ${result.restoredFiles.length} file${result.restoredFiles.length !== 1 ? "s" : ""}.`
        );
      } else if (result.restoredFiles.length > 0) {
        vscode.window.showWarningMessage(
          `Undo partially complete: ${result.restoredFiles.length} restored, ${result.failedFiles.length} failed.`
        );
      } else {
        vscode.window.showErrorMessage(
          `Undo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`
        );
      }
    } catch (error) {
      const errMsg = getErrorMessage(error);
      this.emitMessage({
        type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
        data: {
          requestId,
          target,
          restoredFiles: [],
          failedFiles: (files as UndoFileInstruction[]).map((i) => ({
            path: i.path,
            error: errMsg,
          })),
        },
      });
      vscode.window.showErrorMessage(`Undo failed: ${errMsg}`);
    }
  }

  private async handleRedoPromptChanges(
    message: RedoPromptChangesMessage
  ): Promise<void> {
    const { requestId, target, files, workspacePath } = message.data;
    try {
      const snapshotService = new WorkspaceSnapshotService();
      const result = await snapshotService.undoFiles(files, workspacePath);

      this.emitMessage({
        type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
        data: {
          requestId,
          target,
          restoredFiles: result.restoredFiles,
          failedFiles: result.failedFiles,
        },
      });

      if (result.restoredFiles.length > 0) {
        const redoneAt = Date.now();
        const historyFilePath = await this.resolveHistoryFilePath();
        const outputHistoryManager =
          this.getOrchestrator()?.getOutputHistoryManager();
        if (historyFilePath && outputHistoryManager) {
          await outputHistoryManager.markUndoRecordRedone(
            historyFilePath,
            target,
            redoneAt
          );
          // Read the updated record and notify the webview
          const history =
            await outputHistoryManager.loadHistory(historyFilePath);
          const stepOutput = (
            target.kind === FINAL_STEP_PHASES.QUEUE
              ? history.promptOutputs[target.stepIndex]
              : history.finalStepOutputs?.[target.loopIndex]
          ) as
            | { undoRecord?: import("../types/OutputHistoryTypes").UndoRecord }
            | undefined;
          if (stepOutput?.undoRecord) {
            this.emitMessage({
              type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
              target,
              undoRecord: stepOutput.undoRecord,
            });
          }
        }
      }

      if (result.restoredFiles.length > 0) {
        vscode.window.showInformationMessage(
          `Redo complete: re-applied ${result.restoredFiles.length} file change${result.restoredFiles.length !== 1 ? "s" : ""}.`
        );
      } else {
        vscode.window.showErrorMessage(
          `Redo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`
        );
      }
    } catch (error) {
      const errMsg = getErrorMessage(error);
      this.emitMessage({
        type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
        data: {
          requestId,
          target,
          restoredFiles: [],
          failedFiles: (files as UndoFileInstruction[]).map((i) => ({
            path: i.path,
            error: errMsg,
          })),
        },
      });
      vscode.window.showErrorMessage(`Redo failed: ${errMsg}`);
    }
  }

  private async handleUndoWorkflowChanges(
    message: UndoWorkflowChangesMessage
  ): Promise<void> {
    const { requestId, workspacePath, entries } = message.data;
    const snapshotService = new WorkspaceSnapshotService();
    const totalRestored: string[] = [];
    const totalFailed: Array<{ path: string; error: string }> = [];

    for (const entry of entries) {
      if (entry.files.length === 0) continue;
      try {
        const result = await snapshotService.undoFiles(
          entry.files,
          workspacePath
        );
        totalRestored.push(...result.restoredFiles);
        totalFailed.push(...result.failedFiles);

        if (result.restoredFiles.length > 0) {
          const undoRecord: UndoRecord = {
            appliedAt: Date.now(),
            restoredFiles: result.restoredFiles,
            redoInstructions: result.redoInstructions,
          };
          const historyFilePath = await this.resolveHistoryFilePath();
          if (historyFilePath) {
            const outputHistoryManager =
              this.getOrchestrator()?.getOutputHistoryManager();
            if (outputHistoryManager) {
              await outputHistoryManager.saveUndoRecord(
                historyFilePath,
                entry.target,
                undoRecord
              );
              this.emitMessage({
                type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
                target: entry.target,
                undoRecord,
              });
            }
          }
        }
      } catch (error) {
        const errMsg = getErrorMessage(error);
        totalFailed.push(
          ...entry.files.map((f) => ({ path: f.path, error: errMsg }))
        );
      }
    }

    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    this.emitMessage({
      type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
      data: {
        requestId,
        target: firstTarget,
        restoredFiles: totalRestored,
        failedFiles: totalFailed,
      },
    });

    if (totalFailed.length === 0 && totalRestored.length > 0) {
      vscode.window.showInformationMessage(
        `Undo complete: restored ${totalRestored.length} file${totalRestored.length !== 1 ? "s" : ""}.`
      );
    } else if (totalRestored.length > 0) {
      vscode.window.showWarningMessage(
        `Undo partially complete: ${totalRestored.length} restored, ${totalFailed.length} failed.`
      );
    } else if (totalFailed.length > 0) {
      vscode.window.showErrorMessage(
        `Undo failed: ${totalFailed[0]?.error ?? "unknown error"}`
      );
    }
  }

  private async handleRedoWorkflowChanges(
    message: RedoWorkflowChangesMessage
  ): Promise<void> {
    const { requestId, workspacePath, entries } = message.data;
    const snapshotService = new WorkspaceSnapshotService();
    const totalRestored: string[] = [];
    const totalFailed: Array<{ path: string; error: string }> = [];

    for (const entry of entries) {
      if (entry.files.length === 0) continue;
      try {
        const result = await snapshotService.undoFiles(
          entry.files,
          workspacePath
        );
        totalRestored.push(...result.restoredFiles);
        totalFailed.push(...result.failedFiles);

        if (result.restoredFiles.length > 0) {
          const redoneAt = Date.now();
          const historyFilePath = await this.resolveHistoryFilePath();
          const outputHistoryManager =
            this.getOrchestrator()?.getOutputHistoryManager();
          if (historyFilePath && outputHistoryManager) {
            await outputHistoryManager.markUndoRecordRedone(
              historyFilePath,
              entry.target,
              redoneAt
            );
            const history =
              await outputHistoryManager.loadHistory(historyFilePath);
            const stepOutput = (
              entry.target.kind === FINAL_STEP_PHASES.QUEUE
                ? history.promptOutputs[entry.target.stepIndex]
                : history.finalStepOutputs?.[entry.target.loopIndex]
            ) as { undoRecord?: UndoRecord } | undefined;
            if (stepOutput?.undoRecord) {
              this.emitMessage({
                type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
                target: entry.target,
                undoRecord: stepOutput.undoRecord,
              });
            }
          }
        }
      } catch (error) {
        const errMsg = getErrorMessage(error);
        totalFailed.push(
          ...entry.files.map((f) => ({ path: f.path, error: errMsg }))
        );
      }
    }

    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    this.emitMessage({
      type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
      data: {
        requestId,
        target: firstTarget,
        restoredFiles: totalRestored,
        failedFiles: totalFailed,
      },
    });

    if (totalRestored.length > 0) {
      vscode.window.showInformationMessage(
        `Redo complete: re-applied ${totalRestored.length} file change${totalRestored.length !== 1 ? "s" : ""}.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Redo failed: ${totalFailed[0]?.error ?? "unknown error"}`
      );
    }
  }

  /**
   * Resolve the current history file path for the active workflow.
   * Returns empty string if unavailable.
   */
  private async resolveHistoryFilePath(): Promise<string> {
    try {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return "";
      const outputHistoryManager = orchestrator.getOutputHistoryManager();
      const workingFilePath =
        orchestrator.getQueueState().workingFilePath ?? "";
      if (!workingFilePath) return "";
      const workflowId =
        outputHistoryManager.extractWorkflowId(workingFilePath);
      return await outputHistoryManager.getLatestHistoryFilePath(workflowId);
    } catch {
      return "";
    }
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

  private getMcpWorkspaceServersPath(): string | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.MCP_DIR,
      PATH_CONSTANTS.MCP_SERVERS_FILE
    );
  }

  private async loadMcpWorkspaceServers(): Promise<
    import("../types/FlightPathTypes").McpServerConfig[]
  > {
    const filePath = this.getMcpWorkspaceServersPath();
    if (!filePath) return [];
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveMcpWorkspaceServers(
    servers: import("../types/FlightPathTypes").McpServerConfig[]
  ): Promise<void> {
    const filePath = this.getMcpWorkspaceServersPath();
    if (!filePath) return;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(
        filePath,
        JSON.stringify(servers, null, 2),
        "utf-8"
      );
    } catch (err) {
      Log.error(
        `Failed to save workspace MCP servers: ${getErrorMessage(err)}`
      );
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

export interface WebviewRouteOptions {
  postMessage?: PostMessageFn;
}
