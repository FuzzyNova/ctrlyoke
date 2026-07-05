import * as vscode from "vscode";
import * as path from "path";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeTrustedWorkspaceRoots,
} from "../platform/VsCodeWorkspaceRoot";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  SESSION_KINDS,
  PANEL_CLIENT_ID,
  QUEUE_POSITION,
  type WebviewLogLevel,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
  getGitChangeCompletions,
  getPromptFileCompletions,
  getPriorContextCompletions,
} from "../completions/CompletionHelpers";
import { getStashList } from "../utils/GitUtils";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { ContextExpander } from "../utils/ContextExpander";
import { encode } from "gpt-tokenizer";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { WebviewSettingsSync, PostMessageFn } from "./WebviewSettingsSync";
import type { WorkflowSerializer } from "./WorkflowSerializer";
import type {
  DeleteMcpFromHarnessMessage,
  DeleteMcpRegistryServerMessage,
  ExportMcpToHarnessMessage,
  InsertWorkflowStepMessage,
  RequestMcpRegistrySearchMessage,
  SaveMcpRegistryServerMessage,
  UndoPromptChangesMessage,
  RedoPromptChangesMessage,
  UndoWorkflowChangesMessage,
  RedoWorkflowChangesMessage,
  DevDashboardAction,
} from "../types/WebviewMessageTypes";
import { UndoRedoCoordinator } from "./UndoRedoCoordinator";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "../core/harness/PtyProcessManager";
import {
  safeDiscoverLocalMcpServers,
  safeFetchMcpRegistry,
} from "../utils/McpDiscoveryUtils";
import { PriorContextPreviewBuilder } from "../utils/PriorContextPreviewBuilder";
import { HarnessFileManager } from "../utils/HarnessFileManager";
import { HarnessMcpExporter } from "../utils/HarnessMcpExporter";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";
import { HistorySearchService } from "../core/orchestration/HistorySearchService";

const execFileAsync = promisify(execFile);
const GIT_VALIDATION_TIMEOUT_MS = 5000;

/**
 * WebviewMessageRouter
 *
 * Dispatch table replacing the giant switch statement in CtrlYokeWebviewProvider.
 * Routes incoming webview messages to the appropriate handler on the provider,
 * WebviewSettingsSync, or WorkflowSerializer.
 *
 * Each handler function is registered in the dispatch table at construction time.
 */
export class WebviewMessageRouter {
  private routeQueue: Promise<void> = Promise.resolve();
  private scopedPostMessage: PostMessageFn;
  private clientId: string;
  private themeVarsCapturedCallback?: (vars: Record<string, string>) => void;

  private readonly handlers: Map<
    string,
    (message: any) => void | Promise<void>
  >;
  private readonly undoRedoCoordinator: UndoRedoCoordinator;

  constructor(
    private readonly defaultPostMessage: PostMessageFn,
    private readonly settingsSync: WebviewSettingsSync,
    private readonly serializer: WorkflowSerializer,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly historySearchService: HistorySearchService,
    private readonly callbacks: WebviewRouterCallbacks
  ) {
    this.scopedPostMessage = defaultPostMessage;
    this.clientId = PANEL_CLIENT_ID;
    this.undoRedoCoordinator = new UndoRedoCoordinator(getOrchestrator);
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
      this.withScopedContext(options?.postMessage, options?.clientTag, () =>
        this.routeSingleMessage(message)
      )
    );

    await this.routeQueue;
  }

  private async withScopedContext(
    postMessage: PostMessageFn | undefined,
    clientTag: string | undefined,
    action: () => Promise<void>
  ): Promise<void> {
    const prevPostMessage = this.scopedPostMessage;
    const prevClientId = this.clientId;
    if (postMessage !== undefined) this.scopedPostMessage = postMessage;
    if (clientTag !== undefined) this.clientId = clientTag;
    try {
      await action();
    } finally {
      this.scopedPostMessage = prevPostMessage;
      this.clientId = prevClientId;
    }
  }

  private getCurrentPostMessage(): PostMessageFn {
    return this.scopedPostMessage ?? this.defaultPostMessage;
  }

  private emitMessage(message: any): void {
    this.getCurrentPostMessage()(message);
  }

  private async completeBrowserReadyAfterStartup(
    orchestrator: WorkflowOrchestrator,
    send: PostMessageFn,
    clientId: string
  ): Promise<void> {
    try {
      const loadedWorkflowId = await orchestrator.awaitStartupAutoLoad();
      const alreadyReplayed = orchestrator.hasViewedWorkflow(clientId);
      if (loadedWorkflowId && !alreadyReplayed) {
        await orchestrator.replayWorkflowStateTo(
          loadedWorkflowId,
          send,
          clientId
        );
      }

      await this.settingsSync.sendWorkflowPropertiesToSettings(send, clientId);
      this.settingsSync.sendStartupComplete(send);
    } catch (error) {
      Log.error(
        `[WebviewMessageRouter] browser READY follow-up failed clientId=${clientId}: ${getErrorMessage(error)}`
      );
    }
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
    table.set(MESSAGE_TYPES.READY, async (message) => {
      if (this.clientId === PANEL_CLIENT_ID) {
        // Cancel RECONNECT retries before any awaited startup work so a valid
        // panel READY immediately stops further nudges from the extension.
        this.callbacks.onPanelReady?.();
      }
      await this.settingsSync.sendInitialState(this.getCurrentPostMessage());
      // Tell the webview its own client identity so it can compute isController
      this.emitMessage({
        type: MESSAGE_TYPES.CLIENT_ID_ASSIGNED,
        clientId: this.clientId,
      });
      const orchestrator = this.getOrchestrator();

      if (orchestrator) {
        // The panel has a dedicated PTY reconnect loop later in this handler
        // that sends TERMINAL_STARTED + reconnect buffers. Skip terminal replay
        // inside handleClientReady for the panel to avoid double-sending and the
        // associated xterm dispose+recreate cycle that caused the
        // "briefly see scrollback then goes blank" bug. Browser clients (which
        // have no separate PTY loop) use the default skipTerminalReplay: false
        // so they receive terminal state on initial connect and reload.
        await orchestrator.handleClientReady(
          this.clientId,
          this.scopedPostMessage,
          {
            skipTerminalReplay: this.clientId === PANEL_CLIENT_ID,
            preferredWorkingFilePath:
              typeof message.preferredWorkingFilePath === "string"
                ? message.preferredWorkingFilePath
                : undefined,
          }
        );
        // For browser clients: SESSION_RESTORED (sent during replay) triggers
        // applyWorkflowChange() which no longer clears workflowProperties, but
        // WORKFLOW_PROPERTIES_UPDATE is still needed to replace any stale values
        // from the previously-viewed workflow with the correct ones.
        if (this.clientId !== PANEL_CLIENT_ID) {
          const send = this.scopedPostMessage;
          const clientId = this.clientId;
          // Do not await the browser startup follow-up while holding the
          // shared routeQueue. Browser READY can arrive before panel READY
          // during extension reloads, and awaitStartupAutoLoad() depends on
          // the panel READY path reaching setDashboardReady(). Running this
          // continuation in the background avoids deadlocking panel startup.
          void this.completeBrowserReadyAfterStartup(
            orchestrator,
            send,
            clientId
          );
        }
      }

      // Panel-only extras:
      if (this.clientId === PANEL_CLIENT_ID) {
        if (orchestrator) {
          // Register the callback before setDashboardReady so it's in place
          // whether the auto-load runs immediately (orchestrator already init'd)
          // or is deferred until initialize() completes.
          orchestrator.setPostAutoLoadCallback(async () => {
            await this.settingsSync.sendWorkflowPropertiesToSettings(
              this.getCurrentPostMessage(),
              this.clientId
            );
          });
          await orchestrator.setDashboardReady(this.scopedPostMessage);
          // setDashboardReady may replay an existing workflow (webview reload).
          // If it did, sendWorkflowPropertiesToSettings is needed here too since
          // the callback only fires from triggerAutoLoad (not from the replay).
          await this.settingsSync.sendWorkflowPropertiesToSettings(
            this.getCurrentPostMessage(),
            this.clientId
          );
          // Fast-path: if auto-load has already settled (webview reload or
          // panel reconnect), triggerAutoLoad won't re-run so the hub broadcast
          // won't fire again. Send STARTUP_COMPLETE directly so the overlay lifts.
          if (orchestrator.isAutoLoadTriggered) {
            this.settingsSync.sendStartupComplete(this.getCurrentPostMessage());
          }
        }
        // Reconnect server running state (handles webview reload while server is up)
        const serverUrl = this.callbacks.getServerUrl?.();
        if (serverUrl) {
          const availableIps = this.callbacks.getAvailableIps?.() ?? [];
          this.emitMessage({
            type: MESSAGE_TYPES.SERVER_STARTED,
            url: serverUrl,
            availableIps,
          });
        }
        // Reconnect active PTY sessions to the fresh webview
        const ptyManager = getPtyProcessManager();
        if (ptyManager) {
          for (const session of ptyManager.getAllSessions()) {
            // Auto-claim controller if the session has no owner.
            // Use assignController (not direct mutation) so workflowRunControllers is
            // updated, then broadcast TERMINAL_CONTROLLER_CHANGED to all clients so
            // no other client keeps thinking it is still the controller.
            if (session.controllerClientId === undefined) {
              ptyManager.assignController(session.id, this.clientId);
              ptyPostMessage({
                type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
                workflowId: session.workflowId,
                sessionId: session.id,
                controllerClientId: this.clientId,
              });
            }
            this.emitMessage({
              type: MESSAGE_TYPES.TERMINAL_STARTED,
              workflowId: session.workflowId,
              sessionId: session.id,
              stepName: session.stepName,
              kind: session.kind,
              promptNumber: session.promptNumber,
              harnessId: session.harnessId,
              shellKind: session.shellKind,
              controllerClientId: session.controllerClientId,
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
      }
    });

    const routeDevAction = (action: DevDashboardAction) => async () => {
      if (!this.callbacks.handleDevAction) {
        this.emitMessage({
          type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
          command: action,
          reason: "Developer actions are unavailable in this build.",
        });
        return;
      }
      await this.callbacks.handleDevAction(
        action,
        this.getCurrentPostMessage()
      );
    };

    table.set(
      MESSAGE_TYPES.DEV_BUILD_EXTENSION,
      routeDevAction("buildExtension")
    );
    table.set(MESSAGE_TYPES.DEV_BUILD_WEBVIEW, routeDevAction("buildWebview"));
    table.set(MESSAGE_TYPES.DEV_BUILD_ALL, routeDevAction("buildAll"));
    table.set(MESSAGE_TYPES.DEV_RELOAD_WINDOW, routeDevAction("reloadWindow"));
    table.set(
      MESSAGE_TYPES.DEV_RESTART_EXTENSION_HOST,
      routeDevAction("restartExtensionHost")
    );
    table.set(
      MESSAGE_TYPES.DEV_BUILD_EXTENSION_AND_RELOAD,
      routeDevAction("buildExtensionAndReload")
    );
    table.set(
      MESSAGE_TYPES.DEV_BUILD_WEBVIEW_AND_RELOAD,
      routeDevAction("buildWebviewAndReload")
    );
    table.set(
      MESSAGE_TYPES.DEV_BUILD_ALL_AND_RELOAD,
      routeDevAction("buildAllAndReload")
    );
    table.set(MESSAGE_TYPES.DEV_RUN_TESTS, routeDevAction("runTests"));
    table.set(
      MESSAGE_TYPES.DEV_SEND_TEST_NOTIFICATION,
      routeDevAction("sendTestNotification")
    );
    table.set(MESSAGE_TYPES.DEV_REQUEST_STATUS, async () => {
      await this.callbacks.handleDevStatusRequest?.(
        this.getCurrentPostMessage()
      );
    });

    // UX Snapshot capture — carries a payload (markdown + optional png), unlike
    // the routeDevAction commands above. Gated the same way: when no write
    // callback is registered (production build) emit DEV_COMMAND_UNAVAILABLE so
    // no file-write path exists. Resolves the workspace root here so the same
    // handler serves both the VS Code panel and phone/browser clients (whose
    // messages arrive via routeExternalMessage on this same router).
    table.set(MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE, async (message) => {
      if (!this.callbacks.handleUxSnapshot) {
        this.emitMessage({
          type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
          command: MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE,
          reason: "Developer actions are unavailable in this build.",
        });
        return;
      }
      await this.callbacks.handleUxSnapshot(
        {
          markdown:
            typeof message.markdown === "string" ? message.markdown : "",
          png: typeof message.png === "string" ? message.png : undefined,
        },
        this.getWorkspaceRoot(),
        this.getCurrentPostMessage()
      );
    });

    // ── Dashboard — Workflow Control ──────────────────────────────────────
    table.set(MESSAGE_TYPES.NEW_PROMPT, () => {
      vscode.commands.executeCommand("ctrlyoke.createDraftPrompt");
    });

    table.set(MESSAGE_TYPES.SELECT_FILE, () => {
      vscode.commands.executeCommand("ctrlyoke.selectPromptFile");
    });

    table.set(MESSAGE_TYPES.APPEND_FILE, async (message) => {
      if (message.filePath) {
        await this.getOrchestrator()?.appendFromFileForClient(
          message.filePath,
          this.clientId,
          QUEUE_POSITION.END
        );
        return;
      }
      vscode.commands.executeCommand("ctrlyoke.appendFromDashboard");
    });

    table.set(MESSAGE_TYPES.EDIT_FILE, () => {
      vscode.commands.executeCommand("ctrlyoke.editCurrentPromptFile");
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW, async (_message) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.createWorkflowForClient(
          this.scopedPostMessage,
          this.clientId
        );
        // A new workflow has no working file, so sendWorkflowPropertiesToSettings
        // returns early without sending anything. Explicitly clear the panel so it
        // shows global defaults instead of the previous workflow's properties.
        this.emitMessage({
          type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
          workflowProperties: {},
        });
        return;
      }
      // Fallback when orchestrator is not yet available
      await this.callbacks.handleClearWorkflow();
    });

    table.set(MESSAGE_TYPES.RUN, () => {
      vscode.commands.executeCommand("ctrlyoke.run");
    });

    table.set(MESSAGE_TYPES.PAUSE, () => {
      vscode.commands.executeCommand("ctrlyoke.pause");
    });

    table.set(MESSAGE_TYPES.RESUME, () => {
      vscode.commands.executeCommand("ctrlyoke.resume");
    });

    table.set(MESSAGE_TYPES.STOP, () => {
      vscode.commands.executeCommand("ctrlyoke.stop");
    });

    table.set(MESSAGE_TYPES.SHOW_OUTPUT, () => {
      vscode.commands.executeCommand("ctrlyoke.showOutputPanel");
    });

    table.set(MESSAGE_TYPES.EXPORT_OUTPUT, async (message) => {
      await this.serializer.handleExportOutput(
        message.content,
        message.fileName
      );
    });

    // ── Dashboard — Prompt Editor ────────────────────────────────────────
    table.set(MESSAGE_TYPES.EXECUTE_PROMPT, (message) => {
      this.handleExecutePrompt(message);
    });

    table.set(MESSAGE_TYPES.UPDATE_PROMPT, (message) => {
      this.handleUpdatePrompt(message);
    });

    table.set(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, async (message) => {
      await this.handleInsertWorkflowStep(message);
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
        message.newPendingOrder as number[],
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.UNDO_REDO_SYNC, async (message) => {
      await this.getOrchestrator()?.syncStepsForUndoRedo(
        message.steps,
        message.finalStep ?? null,
        this.clientId
      );
      if ("workflowProperties" in message) {
        const raw = {
          harness: message.workflowProperties?.harness,
          model: message.workflowProperties?.model,
          agent: message.workflowProperties?.agent,
          skills: message.workflowProperties?.skills,
          resumeSession: message.workflowProperties?.resumeSession,
          sessionId: message.workflowProperties?.sessionId,
          mcpServers: message.workflowProperties?.mcpServers,
          hooks: message.workflowProperties?.hooks,
          endCondition: message.workflowProperties?.endCondition,
          preCondition: message.workflowProperties?.preCondition,
          priorContext: message.workflowProperties?.priorContext,
          additionalArgs: message.workflowProperties?.additionalArgs,
          toolPermissions: message.workflowProperties?.toolPermissions,
        };
        // Strip undefined values: undo restores known state but should not delete
        // properties the undo snapshot predates (e.g. toolPermissions seeded after
        // snapshot capture). Passing undefined would trigger allowDeletes and wipe
        // the live working file value, causing inject-mode mismatches on the next step.
        const workflowProperties = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => v !== undefined)
        );
        if (Object.keys(workflowProperties).length > 0) {
          this.settingsSync.handleUpdateWorkflowProperties(
            workflowProperties,
            this.getCurrentPostMessage(),
            this.clientId
          );
        }
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      if (!workspaceRoot) {
        return;
      }
      await vscode.commands.executeCommand("ctrlyoke.openGitChange", {
        workspaceRoot,
        ref: message.ref,
      });
    });

    table.set(MESSAGE_TYPES.OPEN_PRIOR_CONTEXT, async (message) => {
      await this.handleOpenPriorContext(
        message.ref as string,
        (message.stepCount as number) ?? 0
      );
    });

    table.set(MESSAGE_TYPES.REQUEST_PRIOR_CONTEXT_PREVIEW, async (message) => {
      const content = await this.buildPriorContextContent(
        message.ref as string,
        (message.stepCount as number) ?? 0
      );
      this.emitMessage({
        type: MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT,
        ref: message.ref,
        content,
      });
    });

    table.set(MESSAGE_TYPES.EXPORT_CONTENT_PREVIEW, async (message) => {
      try {
        const doc = await vscode.workspace.openTextDocument({
          content: message.content as string,
          language: message.language as string,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        Log.error("EXPORT_CONTENT_PREVIEW: failed to open document", error);
      }
    });

    table.set(MESSAGE_TYPES.VALIDATE_FILE_REF, async (message) => {
      await this.handleFileRefValidation(message.filePath);
    });

    table.set(MESSAGE_TYPES.VALIDATE_CONTEXT_REFS, async (message) => {
      await this.handleContextRefsValidation(
        message.references ?? [],
        message.seq
      );
    });

    table.set(
      MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      async (message) => {
        await this.handleAttachmentTokenCountRequest(message.references);
      }
    );

    // ── MCP Manager ─────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SERVERS, async () => {
      try {
        await this.emitManagedMcpRegistryServers();
      } catch (error) {
        const message = `Failed to load MCP registry servers: ${getErrorMessage(error)}`;
        Log.error(message);
        void vscode.window.showErrorMessage(message);
      }
    });

    table.set(MESSAGE_TYPES.SAVE_MCP_REGISTRY_SERVER, async (message) => {
      await this.handleSaveMcpRegistryServer(
        message as SaveMcpRegistryServerMessage
      );
    });

    table.set(MESSAGE_TYPES.DELETE_MCP_REGISTRY_SERVER, async (message) => {
      await this.handleDeleteMcpRegistryServer(
        message as DeleteMcpRegistryServerMessage
      );
    });

    table.set(MESSAGE_TYPES.REQUEST_MCP_LOCAL_SCAN, async () => {
      const workspaceRoot = this.getWorkspaceRoot();
      const result = await safeDiscoverLocalMcpServers(workspaceRoot);
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT,
        servers: result.servers,
        ...(result.error ? { error: result.error } : {}),
      });
    });

    table.set(MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SEARCH, async (message) => {
      await this.handleRequestMcpRegistrySearch(
        message as RequestMcpRegistrySearchMessage
      );
    });

    table.set(MESSAGE_TYPES.EXPORT_MCP_TO_HARNESS, async (message) => {
      await this.handleExportMcpToHarness(message as ExportMcpToHarnessMessage);
    });

    table.set(MESSAGE_TYPES.DELETE_MCP_FROM_HARNESS, async (message) => {
      await this.handleDeleteMcpFromHarness(
        message as DeleteMcpFromHarnessMessage
      );
    });

    // ── Harness File Manager ─────────────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_HARNESS_FILES, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      const files = await HarnessFileManager.resolveAllLocations(
        workspaceRoot,
        message.fileType
      );
      const targetDirectories = HarnessFileManager.resolveTargetDirectories(
        workspaceRoot,
        message.fileType
      );
      this.emitMessage({
        type: MESSAGE_TYPES.HARNESS_FILES_RESULT,
        files,
        targetDirectories,
      });
    });

    table.set(MESSAGE_TYPES.EXPORT_TO_HARNESS, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        await HarnessFileManager.exportToHarness(
          message.sourcePath,
          message.harnessId,
          workspaceRoot,
          message.fileType,
          message.overwrite ?? false,
          message.scope ?? "workspace"
        );
        const files = await HarnessFileManager.resolveAllLocations(
          workspaceRoot,
          message.fileType
        );
        const targetDirectories = HarnessFileManager.resolveTargetDirectories(
          workspaceRoot,
          message.fileType
        );
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: true,
          files,
          targetDirectories,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    table.set(MESSAGE_TYPES.IMPORT_TO_CTRLYOKE, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        await HarnessFileManager.importToCtrlYoke(
          message.sourcePath,
          workspaceRoot,
          message.fileType,
          message.overwrite ?? false
        );
        const files = await HarnessFileManager.resolveAllLocations(
          workspaceRoot,
          message.fileType
        );
        const targetDirectories = HarnessFileManager.resolveTargetDirectories(
          workspaceRoot,
          message.fileType
        );
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: true,
          files,
          targetDirectories,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    table.set(MESSAGE_TYPES.DELETE_FROM_HARNESS, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        await HarnessFileManager.deleteFromHarness(
          message.name,
          message.harnessId,
          workspaceRoot,
          message.fileType,
          message.scope ?? "workspace"
        );
        const files = await HarnessFileManager.resolveAllLocations(
          workspaceRoot,
          message.fileType
        );
        const targetDirectories = HarnessFileManager.resolveTargetDirectories(
          workspaceRoot,
          message.fileType
        );
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: true,
          files,
          targetDirectories,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    table.set(MESSAGE_TYPES.SYNC_ALL_TO_HARNESS, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        const sourcePaths: string[] = (message.files ?? []).map(
          (f: { sourcePath: string }) => f.sourcePath
        );
        for (const sourcePath of sourcePaths) {
          await HarnessFileManager.exportToHarness(
            sourcePath,
            message.targetHarnessId,
            workspaceRoot,
            message.fileType,
            true,
            message.scope ?? "workspace"
          );
        }
        const files = await HarnessFileManager.resolveAllLocations(
          workspaceRoot,
          message.fileType
        );
        const targetDirectories = HarnessFileManager.resolveTargetDirectories(
          workspaceRoot,
          message.fileType
        );
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: true,
          files,
          targetDirectories,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    table.set(MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        await HarnessFileManager.deleteAllFromHarness(
          message.harnessId,
          workspaceRoot,
          message.fileType,
          message.scope ?? "workspace"
        );
        const files = await HarnessFileManager.resolveAllLocations(
          workspaceRoot,
          message.fileType
        );
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: true,
          files,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    table.set(MESSAGE_TYPES.OPEN_HARNESS_DIR, async (message) => {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        const dirPath = HarnessFileManager.getTargetDir(
          message.harnessId,
          workspaceRoot,
          message.fileType,
          message.scope ?? "workspace"
        );
        if (!fs.existsSync(dirPath)) {
          throw new Error(
            `The ${message.scope ?? "workspace"} ${message.fileType} folder does not exist yet: ${dirPath}`
          );
        }

        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(dirPath)
        );
        this.emitMessage({
          type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
          success: true,
        });
      } catch (error) {
        this.emitMessage({
          type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
          success: false,
          error: getErrorMessage(error),
        });
      }
    });

    // ── Output History ───────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.LOAD_RUN_HISTORY, async (message) => {
      await this.serializer.handleLoadRunHistory(
        message.runIndex,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.SEARCH_HISTORY, async (message) => {
      const query =
        typeof message.query === "string" ? message.query.trim() : "";
      const limit =
        typeof message.limit === "number" && message.limit > 0
          ? Math.min(message.limit, 100)
          : 50;
      const workspacePath = this.getWorkspaceRoot();
      if (!workspacePath) {
        this.emitMessage({
          type: MESSAGE_TYPES.SEARCH_HISTORY_RESULTS,
          query,
          results: [],
          totalCount: 0,
          hasMore: false,
          indexState: "fallback",
        });
        return;
      }

      const response = await this.historySearchService.search(
        {
          query,
          limit,
          cursor:
            typeof message.cursor === "string" ? message.cursor : undefined,
          filters:
            message.filters && typeof message.filters === "object"
              ? message.filters
              : undefined,
        },
        workspacePath
      );
      this.emitMessage({
        type: MESSAGE_TYPES.SEARCH_HISTORY_RESULTS,
        ...response,
        cursor: typeof message.cursor === "string" ? message.cursor : undefined,
      });
    });

    table.set(MESSAGE_TYPES.CLEAR_RUN_HISTORY, async () => {
      await this.serializer.handleClearRunHistory(
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.DELETE_RUN_HISTORY, async (message) => {
      await this.serializer.handleDeleteRunHistory(
        message.runIndex,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    // ── Dashboard — New Workflow Modal ───────────────────────────────────
    table.set(MESSAGE_TYPES.NEW_WORKFLOW, () => {
      this.serializer.handleNewWorkflow(this.getCurrentPostMessage());
    });

    table.set(MESSAGE_TYPES.TEMPLATE_SELECTED, (message) => {
      this.serializer.handleTemplateSelected(
        message.templateId,
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.SET_DEFAULT_TEMPLATE, (message) => {
      this.serializer.handleSetDefaultTemplate(
        message.templateId,
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.CREATE_WORKFLOW, (message) => {
      if (this.clientId !== PANEL_CLIENT_ID) {
        // External browser client — create file then load without changing panel's viewed workflow
        const send = this.scopedPostMessage;
        const orchestrator = this.getOrchestrator();
        if (orchestrator) {
          this.serializer
            .handleCreateWorkflow(message, send, (fp) =>
              orchestrator.loadWorkflowForClient(fp, send, this.clientId)
            )
            .catch((err) =>
              Log.warn(`CREATE_WORKFLOW per-client load failed: ${err}`)
            );
          return;
        }
      }
      // VS Code sidebar path — global load (updates panel viewer registry)
      this.serializer.handleCreateWorkflow(
        message,
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.CREATE_NEW_TEMPLATE, () => {
      this.serializer.handleCreateNewTemplate();
    });

    table.set(MESSAGE_TYPES.BROWSE_TEMPLATE_FILE, (message) => {
      this.serializer.handleBrowseTemplateFile(
        message.variable,
        message.fileFilter,
        this.getCurrentPostMessage()
      );
    });

    // ── Dashboard — Workflow Status ──────────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_NAME, async (message) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.updateWorkflowName(
          message.workflowName,
          this.clientId
        );
        return;
      }
      this.serializer.handleUpdateWorkflowName(
        message,
        this.callbacks.updateWorkflowName,
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.GET_RECENT_WORKFLOWS, () => {
      this.serializer.handleGetRecentWorkflows(this.getCurrentPostMessage());
    });

    table.set(MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE, async (message) => {
      const { filePath } = message;
      if (filePath) {
        await this.serializer.handleToggleFavorite(filePath);
      }
    });

    table.set(MESSAGE_TYPES.LOAD_WORKFLOW, async (message) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        const filePath: string = message.filePath ?? "";
        await orchestrator.loadWorkflowForClient(
          filePath,
          this.scopedPostMessage,
          this.clientId
        );
        // FILE_SELECTED (emitted during replay) calls applyWorkflowChange() which
        // clears workflowProperties. Repopulate them so the PropertiesPanel reflects
        // the loaded workflow's saved configuration — same pattern as SWITCH_WORKFLOW.
        await this.settingsSync.sendWorkflowPropertiesToSettings(
          this.getCurrentPostMessage(),
          this.clientId
        );
        return;
      }
      // Fallback when orchestrator is not yet available
      this.serializer.handleLoadWorkflow(message);
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY, async () => {
      const currentWorkingFilePath = this.getOrchestrator()?.getQueueState(
        this.clientId
      )?.workingFilePath;
      const deleted = await this.serializer.handleClearWorkflowHistory(
        this.getCurrentPostMessage()
      );
      // Clear the stale working file path if it was deleted by the history clear.
      // Same logic as REMOVE_WORKFLOW_HISTORY — we do NOT call clearWorkflow() to
      // preserve the user's prompts and source file reference.
      if (deleted && currentWorkingFilePath) {
        this.getOrchestrator()?.clearWorkingFilePath(this.clientId);
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

    table.set(MESSAGE_TYPES.OPEN_VSCODE_MCP_BROWSER, () => {
      vscode.commands.executeCommand("workbench.mcp.browseServers");
    });

    table.set(MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST, () => {
      this.settingsSync.handleGlobalSettingsLoadRequest(
        this.getCurrentPostMessage()
      );
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

    table.set(MESSAGE_TYPES.REGENERATE_SERVER_TOKEN, () => {
      this.settingsSync.handleRegenerateServerToken(
        this.getCurrentPostMessage()
      );
    });

    table.set(MESSAGE_TYPES.GENERATE_SERVER_CERT, (message) => {
      void this.settingsSync.handleGenerateServerCert(
        this.getCurrentPostMessage(),
        message.scope
      );
    });

    table.set(MESSAGE_TYPES.THEME_VARS_CAPTURED, (message) => {
      // Only the trusted in-panel VS Code webview may update the shared theme
      // snapshot — it gets spliced into server-rendered HTML served to every
      // hosted-dashboard visitor, so accepting it from external browser
      // clients would let anyone holding a server token plant a stored
      // injection that persists for every future visitor.
      if (this.clientId === PANEL_CLIENT_ID) {
        this.themeVarsCapturedCallback?.(message.vars);
      }
    });

    // ── Settings — Workflow Properties ───────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, (message) => {
      this.settingsSync.handleUpdateWorkflowProperty(
        message.property,
        message.value,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES, (message) => {
      this.settingsSync.handleUpdateWorkflowProperties(
        message.properties,
        this.getCurrentPostMessage(),
        this.clientId
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
      await this.serializer.handleSaveWorkflowRequest(
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.SAVE_WORKFLOW, async (message) => {
      await this.serializer.handleSaveWorkflow(
        message.filePath,
        message.format,
        this.getCurrentPostMessage(),
        this.clientId
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
      // The dropdown fetches this when opened; refresh the global active-terminal
      // set at the same time so the per-row terminal icon is accurate for every
      // workflow, not just the one this client is viewing.
      this.emitMessage({
        type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
        workflows: orchestrator?.getActiveTerminalWorkflowRefs() ?? [],
      });
    });

    table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, async (message) => {
      const workflowId = (message as any).workflowId as string;
      if (!workflowId) return;
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return;
      try {
        // Include terminal replay so clients switching to a workflow with an active
        // PTY session receive TERMINAL_STARTED and enter view-only mode if another
        // client is the controller. The TERMINAL_STARTED handler is idempotent:
        // if the session is already registered it updates controller state only,
        // avoiding the old "briefly see scrollback then blank" flicker.
        await orchestrator.replayWorkflowStateTo(
          workflowId,
          this.scopedPostMessage,
          this.clientId
        );
        // SESSION_RESTORED (sent by the replay) clears workflowProperties via applyWorkflowChange().
        // Repopulate them immediately so the PropertiesPanel shows the correct state.
        await this.settingsSync.sendWorkflowPropertiesToSettings(
          this.getCurrentPostMessage(),
          this.clientId
        );
      } catch (err) {
        Log.warn(`SWITCH_WORKFLOW per-client replay failed: ${err}`);
      }
    });

    // ── Per-workflow targeted controls ────────────────────────────────────
    table.set(MESSAGE_TYPES.RUN_WORKFLOW, (message) => {
      const { workflowId } = message;
      if (workflowId) {
        // Register this client as the controller for the next terminal session spawned
        // for this workflow. The pending controller is consumed in PtyProcessManager.spawnPty().
        getPtyProcessManager()?.setPendingController(
          workflowId as string,
          this.clientId
        );
        // Fire-and-forget: executeWorkflow runs the entire workflow loop and must
        // not be awaited here — awaiting would block the routeQueue for the full
        // duration of the run, preventing stop/pause/switch-workflow/terminal-input
        // messages from ever being processed.
        void this.getOrchestrator()?.executeWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.PAUSE_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        Log.debug(
          `[WebviewMessageRouter] PAUSE_WORKFLOW received: inst:${workflowId.slice(0, 8)}`
        );
        await this.getOrchestrator()?.pauseWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.CANCEL_PAUSE_WORKFLOW, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        Log.debug(
          `[WebviewMessageRouter] CANCEL_PAUSE_WORKFLOW received: inst:${workflowId.slice(0, 8)}`
        );
        await this.getOrchestrator()?.cancelPauseWorkflow(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.RESUME_WORKFLOW, (message) => {
      const { workflowId, workingFilePath } = message;
      if (workflowId) {
        Log.debug(
          `[WebviewMessageRouter] RESUME_WORKFLOW received: inst:${workflowId.slice(0, 8)}`
        );
        // Fire-and-forget: resumeWorkflow can call executeLoadedPromptFile which
        // awaits the entire workflow execution loop. Awaiting here would block
        // routeQueue for the full run duration, preventing stop/pause/switch-workflow
        // messages from being processed — same reason RUN_WORKFLOW uses void.
        void this.getOrchestrator()?.resumeWorkflow(
          workflowId,
          workingFilePath as string | undefined
        );
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
        const currentWorkingFilePath = this.getOrchestrator()?.getQueueState(
          this.clientId
        )?.workingFilePath;
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
          this.getOrchestrator()?.clearWorkingFilePath(this.clientId);
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
      await this.undoRedoCoordinator.handleUndoPromptChanges(
        message as UndoPromptChangesMessage,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.REDO_PROMPT_CHANGES, async (message) => {
      await this.undoRedoCoordinator.handleRedoPromptChanges(
        message as RedoPromptChangesMessage,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES, async (message) => {
      await this.undoRedoCoordinator.handleUndoWorkflowChanges(
        message as UndoWorkflowChangesMessage,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    table.set(MESSAGE_TYPES.REDO_WORKFLOW_CHANGES, async (message) => {
      await this.undoRedoCoordinator.handleRedoWorkflowChanges(
        message as RedoWorkflowChangesMessage,
        this.getCurrentPostMessage(),
        this.clientId
      );
    });

    // ── Terminal I/O ─────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.TERMINAL_INPUT, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.sessionId || !msg.data) return;
      const session = ptyManager.getSession(msg.sessionId as string);
      if (!session) return;
      // Only the designated controller may send input. If no controller is set,
      // any client may send (e.g. during an unowned shell session).
      if (
        session.controllerClientId !== undefined &&
        this.clientId !== session.controllerClientId
      )
        return;
      ptyManager.writeToSession(msg.sessionId as string, msg.data as string);
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESIZE, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.sessionId || !msg.cols || !msg.rows) return;
      const session = ptyManager.getSession(msg.sessionId as string);
      if (!session) return;
      // Only the controller may drive PTY dimensions.
      if (
        session.controllerClientId !== undefined &&
        this.clientId !== session.controllerClientId
      )
        return;
      ptyManager.resizeSession(
        msg.sessionId as string,
        msg.cols as number,
        msg.rows as number
      );
      // Broadcast the new dimensions to all clients so viewers can match the
      // controller's terminal width and avoid line-wrap display artifacts.
      ptyPostMessage({
        type: MESSAGE_TYPES.TERMINAL_SIZE_CHANGED,
        workflowId: session.workflowId,
        sessionId: session.id,
        cols: msg.cols as number,
        rows: msg.rows as number,
      });
    });

    table.set(MESSAGE_TYPES.TERMINAL_SPAWN_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.workflowId) return;
      const workflowId = msg.workflowId as string;
      const cwd = (msg.cwd as string | undefined) ?? process.cwd();
      let session: ReturnType<typeof ptyManager.spawnShell>;
      try {
        session = ptyManager.spawnShell({
          workflowId,
          cwd,
          onData: (s, chunk) => {
            ptyPostMessage({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: s.workflowId,
              sessionId: s.id,
              data: chunk,
            });
          },
          onExit: (s, exitCode) => {
            ptyPostMessage({
              type: MESSAGE_TYPES.TERMINAL_ENDED,
              workflowId: s.workflowId,
              sessionId: s.id,
              kind: s.kind,
              exitCode,
            });
          },
        });
      } catch (error) {
        const message = getErrorMessage(error);
        Log.warn(`Failed to spawn embedded shell: ${message}`);
        void vscode.window.showWarningMessage(message);
        return;
      }
      // Register the spawning client as controller and update workflowRunControllers
      // so that subsequent restarts inherit the same controller via assignController.
      ptyManager.assignController(session.id, this.clientId);
      ptyPostMessage({
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId,
        sessionId: session.id,
        stepName: session.stepName,
        kind: SESSION_KINDS.SHELL,
        shellKind: session.shellKind,
        controllerClientId: session.controllerClientId,
      });
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESTART_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.sessionId || !msg.workflowId) return;
      const workflowId = msg.workflowId as string;
      let newSession: ReturnType<typeof ptyManager.restartShellSession>;
      try {
        newSession = ptyManager.restartShellSession(msg.sessionId as string, {
          onData: (s, chunk) => {
            ptyPostMessage({
              type: MESSAGE_TYPES.TERMINAL_OUTPUT,
              workflowId: s.workflowId,
              sessionId: s.id,
              data: chunk,
            });
          },
          onExit: (s, exitCode) => {
            ptyPostMessage({
              type: MESSAGE_TYPES.TERMINAL_ENDED,
              workflowId: s.workflowId,
              sessionId: s.id,
              kind: s.kind,
              exitCode,
            });
          },
        });
      } catch (error) {
        const message = getErrorMessage(error);
        Log.warn(`Failed to restart embedded shell: ${message}`);
        void vscode.window.showWarningMessage(message);
        return;
      }
      if (newSession) {
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_STARTED,
          workflowId,
          sessionId: newSession.id,
          stepName: newSession.stepName,
          kind: SESSION_KINDS.SHELL,
          shellKind: newSession.shellKind,
          controllerClientId: newSession.controllerClientId,
        });
      }
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (ptyManager && msg.sessionId) {
        ptyManager.killSession(msg.sessionId as string);
      }
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLOSE_AI_CLI, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.sessionId) return;
      await ptyManager.gracefulKillAiCliSession(msg.sessionId as string);
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, async (msg) => {
      const ptyManager = getPtyProcessManager();
      if (!ptyManager || !msg.sessionId || !msg.workflowId) return;
      const session = ptyManager.assignController(
        msg.sessionId as string,
        this.clientId
      );
      if (session) {
        // Broadcast updated controller to all clients so they can update isController
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
          workflowId: session.workflowId,
          sessionId: session.id,
          controllerClientId: session.controllerClientId,
        });
      }
    });

    // ── Workspace initialization ────────────────────────────────────────────
    table.set(MESSAGE_TYPES.INITIALIZE_WORKSPACE, async () => {
      const orchestrator = this.getOrchestrator();
      await orchestrator?.handleInitializeWorkspace();
    });

    table.set(MESSAGE_TYPES.LAYOUT_TIP_DISMISSED, async () => {
      const orchestrator = this.getOrchestrator();
      await orchestrator?.handleLayoutPreference();
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
        forceNewWorkflow,
        this.clientId
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
        clearProperties,
        this.clientId
      );
    } catch (error) {
      Log.error("Failed to update prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to update prompt: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleInsertWorkflowStep(
    message: InsertWorkflowStepMessage
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    try {
      await orchestrator.insertWorkflowStepAfterIndex(
        message.afterIndex,
        message.step,
        this.clientId
      );
    } catch (error) {
      Log.error("Failed to insert workflow step:", error);
      vscode.window.showErrorMessage(
        `Failed to insert workflow step: ${getErrorMessage(error)}`
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
        message.clearProperties,
        this.clientId
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
      await orchestrator.deletePromptFromQueue(index, this.clientId);
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
      await orchestrator.resetWorkflowState(this.clientId);
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
      await orchestrator.setStartPosition(toIndex, this.clientId);
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

      Log.trace(
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
          filterText: item.filterText,
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : "";
      return await getGitChangeCompletions(workspaceRoot, prefix.substring(1)); // Remove ~
    } else if (trigger === "$") {
      return getPriorContextCompletions(prefix.substring(1)); // Remove $
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
   *   3. Relative to .ctrlyoke directory inside workspace root
   */
  private async handleFileRefValidation(filePath: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : null;
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
            PATH_CONSTANTS.CTRLYOKE_DIR,
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

  private async handleContextRefsValidation(
    references: Array<{
      id: string;
      type: "file" | "directory" | "lineRange" | "symbol" | "git";
      path?: string;
      gitRef?: string;
      lineStart?: string;
      lineEnd?: string;
      symbolName?: string;
    }>,
    seq?: number
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : null;

    const results = await Promise.all(
      references.map(async (reference) => {
        const validation = await this.validateContextReference(
          reference,
          workspaceRoot
        );
        return {
          id: reference.id,
          ...validation,
        };
      })
    );

    this.emitMessage({
      type: MESSAGE_TYPES.CONTEXT_REFS_VALIDATION,
      results,
      seq,
    });
  }

  private async validateContextReference(
    reference: {
      type: "file" | "directory" | "lineRange" | "symbol" | "git";
      path?: string;
      gitRef?: string;
      lineStart?: string;
      lineEnd?: string;
      symbolName?: string;
    },
    workspaceRoot: string | null
  ): Promise<{ exists: boolean; message?: string }> {
    if (reference.type === "git") {
      return this.validateGitContextReference(reference.gitRef, workspaceRoot);
    }

    if (!reference.path) {
      return { exists: false, message: "context not found" };
    }

    const pathValidation = await this.resolveContextReferencePath(
      reference.path,
      workspaceRoot
    );

    if (!pathValidation.exists || !pathValidation.resolvedPath) {
      return { exists: false, message: "file not found" };
    }

    if (reference.type === "directory") {
      return pathValidation.isDirectory
        ? { exists: true }
        : { exists: false, message: "directory not found" };
    }

    if (!pathValidation.isFile) {
      return { exists: false, message: "file not found" };
    }

    if (reference.type === "lineRange" || reference.type === "symbol") {
      const startLine = Number.parseInt(reference.lineStart ?? "", 10);
      const endLine = Number.parseInt(reference.lineEnd ?? "", 10);
      const missingSymbolName =
        reference.type === "symbol" && !reference.symbolName;
      if (
        missingSymbolName ||
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
      ) {
        return {
          exists: false,
          message:
            reference.type === "symbol"
              ? "symbol not found"
              : "selection not found",
        };
      }

      try {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(pathValidation.resolvedPath)
        );
        return endLine <= document.lineCount
          ? { exists: true }
          : {
              exists: false,
              message:
                reference.type === "symbol"
                  ? "symbol not found"
                  : "selection not found",
            };
      } catch {
        return {
          exists: false,
          message:
            reference.type === "symbol"
              ? "symbol not found"
              : "selection not found",
        };
      }
    }

    return { exists: true };
  }

  private async resolveContextReferencePath(
    filePath: string,
    workspaceRoot: string | null
  ): Promise<{
    exists: boolean;
    resolvedPath?: string;
    isFile?: boolean;
    isDirectory?: boolean;
  }> {
    const candidates = path.isAbsolute(filePath)
      ? [filePath]
      : workspaceRoot
        ? [
            path.resolve(workspaceRoot, filePath),
            path.resolve(
              workspaceRoot,
              PATH_CONSTANTS.CTRLYOKE_DIR,
              filePath.replace(/^\.\.?\//, "")
            ),
          ]
        : [];

    for (const candidate of candidates) {
      try {
        const stat = await fs.promises.stat(candidate);
        return {
          exists: true,
          resolvedPath: candidate,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
        };
      } catch {
        // try next candidate
      }
    }

    return { exists: false };
  }

  private async validateGitContextReference(
    gitRef: string | undefined,
    workspaceRoot: string | null
  ): Promise<{ exists: boolean; message?: string }> {
    if (!gitRef || !workspaceRoot) {
      return { exists: false, message: "git context not found" };
    }

    try {
      if (gitRef === "diff") {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", workspaceRoot, "status", "--short"],
          { timeout: GIT_VALIDATION_TIMEOUT_MS }
        );
        return stdout.trim()
          ? { exists: true }
          : { exists: false, message: "git diff not found" };
      }

      if (gitRef === "staged") {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", workspaceRoot, "diff", "--cached", "--name-only"],
          { timeout: GIT_VALIDATION_TIMEOUT_MS }
        );
        return stdout.trim()
          ? { exists: true }
          : { exists: false, message: "staged changes not found" };
      }

      const stashMatch = gitRef.match(/^stash:(\d+)$/);
      if (stashMatch) {
        const stashes = await getStashList(workspaceRoot);
        const stashIndex = Number.parseInt(stashMatch[1], 10);
        return stashes.some((stash) => stash.index === stashIndex)
          ? { exists: true }
          : { exists: false, message: "stash not found" };
      }

      if (/^[0-9a-f]{7,40}$/i.test(gitRef)) {
        await execFileAsync(
          "git",
          ["-C", workspaceRoot, "cat-file", "-e", `${gitRef}^{commit}`],
          { timeout: GIT_VALIDATION_TIMEOUT_MS }
        );
        return { exists: true };
      }
    } catch {
      return { exists: false, message: "git context not found" };
    }

    return { exists: false, message: "git context not found" };
  }

  private async handleOpenFile(
    relativePath: string,
    lineStart?: number,
    lineEnd?: number
  ): Promise<void> {
    try {
      if (!vscode.workspace.workspaceFolders?.length) {
        Log.warn("No workspace folder open");
        return;
      }
      const workspaceRoot = getVsCodeWorkspaceRoot();
      const workspaceRootUri = vscode.Uri.file(workspaceRoot);

      const normalizeCodexAbsPath = (rawPath: string): string => {
        const pathWithDrive = rawPath.match(/^\/abs\/path\/([A-Za-z]:)(\/.*)$/);
        if (pathWithDrive) {
          return `${pathWithDrive[1].toUpperCase()}${pathWithDrive[2]}`;
        }

        const slashDrivePath = rawPath.match(/^\/([A-Za-z]:)(\/.*)$/);
        if (slashDrivePath) {
          return `${slashDrivePath[1].toUpperCase()}${slashDrivePath[2]}`;
        }

        return rawPath;
      };

      const isPathInside = (childPath: string, parentPath: string): boolean => {
        const relative = path.relative(
          path.resolve(parentPath),
          path.resolve(childPath)
        );
        return (
          relative === "" ||
          (!relative.startsWith("..") && !path.isAbsolute(relative))
        );
      };

      const normalizedPath = normalizeCodexAbsPath(
        relativePath.replace(/\\/g, "/")
      );
      const isDirectory = normalizedPath.endsWith("/");
      const trimmedPath = isDirectory
        ? normalizedPath.replace(/\/+$/, "")
        : normalizedPath;

      // Detect absolute paths (Windows: C:/... or C:\..., POSIX: /...)
      // and resolve them directly instead of joining with the workspace root.
      const isAbsolute =
        /^[A-Za-z]:\//.test(trimmedPath) || path.isAbsolute(trimmedPath);
      const targetUri = isAbsolute
        ? vscode.Uri.file(trimmedPath)
        : vscode.Uri.joinPath(
            workspaceRootUri,
            ...trimmedPath.split("/").filter(Boolean)
          );

      if (!isPathInside(targetUri.fsPath, workspaceRoot)) {
        Log.warn(
          `Blocked dashboard request to open path outside workspace: ${relativePath}`
        );
        vscode.window.showWarningMessage(
          "ctrlyoke blocked a file link outside the current workspace."
        );
        return;
      }

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

  /** Build the prior-context XML preview without opening it in an editor. */
  private async buildPriorContextContent(
    ref: string,
    stepCount: number
  ): Promise<string> {
    if (!ref) return "";
    const orchestrator = this.getOrchestrator();
    const workingFilePath = orchestrator?.getQueueState(
      this.clientId
    )?.workingFilePath;
    if (workingFilePath && fs.existsSync(workingFilePath)) {
      try {
        const raw = fs.readFileSync(workingFilePath, "utf-8");
        const workingFile = JSON.parse(raw) as { steps?: unknown[] };
        const steps = (workingFile.steps ??
          []) as import("../types/CtrlYokeTypes").WorkflowStep[];
        return PriorContextPreviewBuilder.buildPreview(ref, stepCount, steps);
      } catch {
        return `<!-- Could not read workflow state for $${ref} -->`;
      }
    }
    return `<!-- No active workflow — $${ref} will be resolved at execution time -->`;
  }

  /**
   * Open an untitled XML preview showing the exact <priorContext> block that
   * a $prior-context ref will expand to when the prompt runs.
   * Uses the same buildPriorContextXmlFromItems codepath as live harness injection.
   */
  private async handleOpenPriorContext(
    ref: string,
    stepCount: number
  ): Promise<void> {
    if (!ref) return;
    const content = await this.buildPriorContextContent(ref, stepCount);

    try {
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: "xml",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      Log.error("handleOpenPriorContext: failed to open document", error);
    }
  }

  /**
   * Handle request to count tokens for attachment references.
   */
  private async handleAttachmentTokenCountRequest(
    references: string[]
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    if (!workspaceRoot || !references || references.length === 0) {
      this.emitMessage({
        type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
        counts: {},
      });
      return;
    }

    const counts: Record<string, number> = {};

    const trustedRoots = getVsCodeTrustedWorkspaceRoots();

    await Promise.all(
      references.map(async (rawRef) => {
        try {
          const expander = new ContextExpander(workspaceRoot, trustedRoots);
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
  // Webview Logging
  // ============================================================================

  private handleWebviewLog(level: WebviewLogLevel, message: string): void {
    const tag = this.clientId;
    const prefixed = `[${tag}] ${message}`;
    switch (level) {
      case LOG_LEVELS.DEBUG:
        Log.debug(prefixed);
        break;
      case LOG_LEVELS.INFO:
        Log.info(prefixed);
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

  private getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : "";
  }

  private getMcpRegistryFileManager(): McpRegistryFileManager {
    const workspaceRoot = this.getWorkspaceRoot();
    return new McpRegistryFileManager(workspaceRoot || undefined);
  }

  private getHarnessMcpExporter(): HarnessMcpExporter {
    const workspaceRoot = this.getWorkspaceRoot();
    return new HarnessMcpExporter(workspaceRoot || undefined);
  }

  private async emitManagedMcpRegistryServers(): Promise<void> {
    const servers = await this.getMcpRegistryFileManager().readAll();
    this.emitMessage({
      type: MESSAGE_TYPES.MCP_REGISTRY_SERVERS_UPDATE,
      servers,
    });
  }

  private async handleSaveMcpRegistryServer(
    message: SaveMcpRegistryServerMessage
  ): Promise<void> {
    try {
      const manager = this.getMcpRegistryFileManager();
      if (message.previousId && message.previousId !== message.server.id) {
        await manager.remove(message.previousId, message.scope);
      }
      await manager.addOrUpdate(message.server, message.scope);
      await this.emitManagedMcpRegistryServers();
    } catch (error) {
      const errorMessage = `Failed to save MCP registry server: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  private async handleDeleteMcpRegistryServer(
    message: DeleteMcpRegistryServerMessage
  ): Promise<void> {
    try {
      await this.getMcpRegistryFileManager().remove(message.id, message.scope);
      await this.emitManagedMcpRegistryServers();
    } catch (error) {
      const errorMessage = `Failed to delete MCP registry server: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  private async handleRequestMcpRegistrySearch(
    message: RequestMcpRegistrySearchMessage
  ): Promise<void> {
    const result = await safeFetchMcpRegistry({
      cursor: message.cursor,
      search: message.query || undefined,
      updatedSince: message.updatedSince,
    });
    this.emitMessage({
      type: MESSAGE_TYPES.MCP_REGISTRY_SEARCH_RESULT,
      servers: result.servers,
      nextCursor: result.nextCursor,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  private async handleExportMcpToHarness(
    message: ExportMcpToHarnessMessage
  ): Promise<void> {
    try {
      const result = await this.getHarnessMcpExporter().export(
        message.servers ?? [],
        message.targetId,
        message.scope
      );
      if (result.exportedCount === 0) {
        void vscode.window.showWarningMessage(
          `No stdio MCP servers were exported to ${result.filePath}.`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Exported ${result.exportedCount} MCP server${result.exportedCount === 1 ? "" : "s"} to ${result.filePath}.`
      );
      const localScanResult = await safeDiscoverLocalMcpServers(
        this.getWorkspaceRoot()
      );
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT,
        servers: localScanResult.servers,
        ...(localScanResult.error ? { error: localScanResult.error } : {}),
      });
    } catch (error) {
      const errorMessage = `Failed to export MCP servers: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  private async handleDeleteMcpFromHarness(
    message: DeleteMcpFromHarnessMessage
  ): Promise<void> {
    try {
      const result = await this.getHarnessMcpExporter().remove(
        message.ids ?? [],
        message.targetId,
        message.scope,
        message.filePath
      );
      void vscode.window.showInformationMessage(
        result.removedCount > 0
          ? `Removed ${result.removedCount} MCP server${result.removedCount === 1 ? "" : "s"} from ${result.filePath}.`
          : `No matching MCP servers were found in ${result.filePath}.`
      );
      const localScanResult = await safeDiscoverLocalMcpServers(
        this.getWorkspaceRoot()
      );
      this.emitMessage({
        type: MESSAGE_TYPES.MCP_LOCAL_SCAN_RESULT,
        servers: localScanResult.servers,
        ...(localScanResult.error ? { error: localScanResult.error } : {}),
      });
    } catch (error) {
      const errorMessage = `Failed to delete MCP servers from harness config: ${getErrorMessage(error)}`;
      Log.error(errorMessage);
      void vscode.window.showErrorMessage(errorMessage);
    }
  }
}

/**
 * Callbacks from the router back to the CtrlYokeWebviewProvider.
 * These are methods that remain on the provider because they're part
 * of the public API or touch provider-internal state.
 */
export interface WebviewRouterCallbacks {
  handleClearWorkflow: () => Promise<void>;
  updateWorkflowName: (name: string) => void;
  handleDevAction?: (
    action: DevDashboardAction,
    postMessage: PostMessageFn
  ) => Promise<void>;
  handleDevStatusRequest?: (postMessage: PostMessageFn) => Promise<void>;
  /**
   * Persist a captured UX snapshot (dev builds only). Receives the payload, the
   * resolved workspace root, and a scoped send so the confirmation reply reaches
   * the originating client (panel or phone). Absent in production builds.
   */
  handleUxSnapshot?: (
    payload: { markdown: string; png?: string },
    workspaceRoot: string,
    postMessage: PostMessageFn
  ) => Promise<void>;
  /** Returns the hosted server URL if the server is currently running, undefined otherwise. */
  getServerUrl?: () => string | undefined;
  /** Returns all available LAN IPs (populated when binding to 0.0.0.0). */
  getAvailableIps?: () => string[];
  /**
   * Called synchronously when the VS Code panel sends READY.
   * Used by CtrlYokeWebviewProvider to cancel pending RECONNECT retries
   * so no stale retries fire after the handshake is already complete.
   */
  onPanelReady?: () => void;
}

export interface WebviewRouteOptions {
  postMessage?: PostMessageFn;
  /** Short label identifying the client for log prefixing, e.g. "panel" or "browser:1" */
  clientTag?: string;
}
