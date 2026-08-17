import * as vscode from "vscode";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
} from "../platform/VsCodeWorkspaceRoot";
import { resolveNamedRelativePath } from "../platform/WorkspaceRootResolver";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  PANEL_CLIENT_ID,
  QUEUE_POSITION,
  USER_FEEDBACK_SEVERITY,
  type UserFeedbackSeverity,
  type WebviewLogLevel,
  VSCODE_COMMANDS,
  WORKTREE_MANAGEMENT_ACTIONS,
  type WorktreeManagementAction,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { WebviewSettingsSync, PostMessageFn } from "./WebviewSettingsSync";
import type { WorkflowSerializer } from "./WorkflowSerializer";
import type {
  DeleteMcpFromHarnessMessage,
  DeleteMcpRegistryServerMessage,
  ExportMcpToHarnessMessage,
  ExecuteDraftMessage,
  SeedNewRunMessage,
  StartNewRunInsteadMessage,
  ContinueRunMessage,
  AppendAndContinueRunMessage,
  RunExecutionControlMessage,
  SetStartPositionMessage,
  DiscardContinuationMessage,
  RequestMcpConfigPreviewMessage,
  RequestMcpRegistrySearchMessage,
  SaveMcpRegistryServerMessage,
  UndoPromptChangesMessage,
  RedoPromptChangesMessage,
  UndoWorkflowChangesMessage,
  RedoWorkflowChangesMessage,
  DevDashboardAction,
  RequestHarnessFilesMessage,
  ExportToHarnessMessage,
  ImportToCtrlYokeMessage,
  DeleteFromHarnessMessage,
  SyncAllToHarnessMessage,
  DeleteAllFromHarnessMessage,
  OpenHarnessDirMessage,
  ShowNativeFeedbackMessage,
} from "../types/WebviewMessageTypes";
import type {
  WorkflowVariantCreatedMessage,
  WorkflowVariantFailedMessage,
} from "../types/WebviewMessageTypes";
import { UndoRedoCoordinator } from "./UndoRedoCoordinator";
import { WorkflowMutationCoordinator } from "./WorkflowMutationCoordinator";
import { PromptEditorSupportService } from "./PromptEditorSupportService";
import { HarnessFileMessageService } from "./HarnessFileMessageService";
import { McpManagerService } from "./McpManagerService";
import { TerminalMessageHandlers } from "./TerminalMessageHandlers";
import { WorkflowStepHandlers } from "./WorkflowStepHandlers";
import {
  createWebviewClientContext,
  type WebviewClientContext,
} from "./WebviewClientContext";
import { HistorySearchService } from "../core/orchestration/HistorySearchService";
import { WorkflowVariantService } from "../core/orchestration/WorkflowVariantService";
import { redactExecutionPreview } from "../types/PreviewRedactor";

/**
 * A dispatch-table entry. Every handler receives the originating client's scope
 * explicitly; none of them may read it off the router.
 */
type WebviewMessageHandler = (
  message: any,
  ctx: WebviewClientContext
) => void | Promise<void>;

type DispatchTable = Map<string, WebviewMessageHandler>;

type WorkflowVariantReply =
  | WorkflowVariantCreatedMessage
  | WorkflowVariantFailedMessage;

interface WorkflowVariantRequestCacheEntry {
  reply: Promise<WorkflowVariantReply>;
  completedAt?: number;
}

const WORKFLOW_VARIANT_REQUEST_CACHE_TTL_MS = 10 * 60 * 1000;
const WORKFLOW_VARIANT_REQUEST_CACHE_MAX_ENTRIES = 256;

function isUserFeedbackSeverity(value: unknown): value is UserFeedbackSeverity {
  return (
    value === USER_FEEDBACK_SEVERITY.INFO ||
    value === USER_FEEDBACK_SEVERITY.SUCCESS ||
    value === USER_FEEDBACK_SEVERITY.WARNING ||
    value === USER_FEEDBACK_SEVERITY.ERROR
  );
}

function describeWorktreeActionSuccess(
  action: WorktreeManagementAction,
  target: string
): string {
  switch (action) {
    case WORKTREE_MANAGEMENT_ACTIONS.REMOVE:
      return `Worktree removed: "${target}".`;
    case WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE:
      return `Worktree force-removed: "${target}".`;
    case WORKTREE_MANAGEMENT_ACTIONS.PRUNE:
      return "Stale Git worktree entries pruned.";
    case WORKTREE_MANAGEMENT_ACTIONS.REPAIR:
      return `Worktree entry repaired: "${target}".`;
    case WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH:
      return `Branch deleted: "${target}".`;
    default:
      return `Worktree action "${action}" completed.`;
  }
}

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
  private themeVarsCapturedCallback?: (vars: Record<string, string>) => void;

  private readonly handlers: DispatchTable;
  private readonly undoRedoCoordinator: UndoRedoCoordinator;
  private readonly mutationCoordinator: WorkflowMutationCoordinator;
  private readonly promptEditorSupport: PromptEditorSupportService;
  private readonly harnessFiles: HarnessFileMessageService;
  private readonly mcpManager: McpManagerService;
  private readonly terminalHandlers: TerminalMessageHandlers;
  private readonly workflowStepHandlers: WorkflowStepHandlers;
  private readonly workflowVariantRequests = new Map<
    string,
    WorkflowVariantRequestCacheEntry
  >();

  constructor(
    private readonly defaultPostMessage: PostMessageFn,
    private readonly settingsSync: WebviewSettingsSync,
    private readonly serializer: WorkflowSerializer,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly historySearchService: HistorySearchService,
    private readonly callbacks: WebviewRouterCallbacks
  ) {
    this.undoRedoCoordinator = new UndoRedoCoordinator(getOrchestrator);
    this.mutationCoordinator = new WorkflowMutationCoordinator(getOrchestrator);
    this.promptEditorSupport = new PromptEditorSupportService(
      () => this.getWorkspaceRoot(),
      getOrchestrator,
      (absolutePath) => this.callbacks.resolveImageWebviewUri?.(absolutePath)
    );
    this.harnessFiles = new HarnessFileMessageService(() =>
      this.getWorkspaceRoot()
    );
    this.mcpManager = new McpManagerService(() => this.getWorkspaceRoot());
    this.terminalHandlers = new TerminalMessageHandlers(() =>
      this.getOrchestrator()?.getUserFeedbackSink()
    );
    this.workflowStepHandlers = new WorkflowStepHandlers(
      getOrchestrator,
      settingsSync,
      this.mutationCoordinator
    );
    this.handlers = this.buildDispatchTable();
  }

  setThemeVarsCapturedCallback(
    cb: ((vars: Record<string, string>) => void) | undefined
  ): void {
    this.themeVarsCapturedCallback = cb;
  }

  /**
   * Route a webview message to the appropriate handler.
   *
   * The sending client's scope is resolved once, here, and then passed by value
   * to the handler. Handlers must not reach back to the router for it — see
   * {@link WebviewClientContext} for why holding it as router state was unsafe.
   */
  async route(message: any, options?: WebviewRouteOptions): Promise<void> {
    const ctx = createWebviewClientContext(
      options?.clientTag ?? PANEL_CLIENT_ID,
      options?.postMessage ?? this.defaultPostMessage
    );
    this.routeQueue = this.routeQueue.then(() =>
      this.routeSingleMessage(message, ctx)
    );

    await this.routeQueue;
  }

  private async completeBrowserReadyAfterStartup(
    ctx: WebviewClientContext,
    orchestrator: WorkflowOrchestrator
  ): Promise<void> {
    try {
      const loadedWorkflowId = await orchestrator.awaitStartupAutoLoad();
      const alreadyReplayed = orchestrator.hasViewedWorkflow(ctx.clientId);
      if (loadedWorkflowId && !alreadyReplayed) {
        await orchestrator.replayWorkflowStateTo(
          loadedWorkflowId,
          ctx.postMessage,
          ctx.clientId
        );
      }

      await this.settingsSync.sendWorkflowPropertiesToSettings(
        ctx.postMessage,
        ctx.clientId
      );
      this.settingsSync.sendStartupComplete(ctx.postMessage);
    } catch (error) {
      Log.error(
        `[WebviewMessageRouter] browser READY follow-up failed clientId=${ctx.clientId}: ${getErrorMessage(error)}`
      );
    }
  }

  private async routeSingleMessage(
    message: any,
    ctx: WebviewClientContext
  ): Promise<void> {
    try {
      const handler = this.handlers.get(message.type);
      if (handler) {
        await handler(message, ctx);
      } else {
        Log.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      Log.error(`Error handling webview message (${message.type}):`, errorMsg);
      // An addressed mutation that throws here never reached its success path,
      // so the client was never handed the revisions its next mutation needs.
      // Left alone, one rejection wedges every later edit on that address.
      if (
        message?.mutation ||
        message?.expectedDefinitionRevision !== undefined
      ) {
        await this.mutationCoordinator.reportActionFailure(
          ctx,
          message.type,
          error
        );
      }
    }
  }

  // ============================================================================
  // Dispatch Table
  // ============================================================================

  private buildDispatchTable(): DispatchTable {
    const table: DispatchTable = new Map();
    this.registerLifecycle(table);
    this.registerUserFeedback(table);
    this.registerDevActions(table);
    this.registerWorkflowControl(table);
    this.registerPromptEditor(table);
    this.registerEditorSupport(table);
    this.registerMcpManager(table);
    this.registerHarnessFiles(table);
    this.registerOutputHistory(table);
    this.registerWorkflowVariants(table);
    this.registerWorkflowModal(table);
    this.registerWorkflowStatus(table);
    this.registerSettings(table);
    this.registerSaveWorkflow(table);
    this.registerMultiWorkflow(table);
    this.registerRunLifecycle(table);
    this.registerUndoRedo(table);
    this.registerTerminal(table);
    this.registerWorkspaceInit(table);
    return table;
  }

  private registerUserFeedback(table: DispatchTable): void {
    table.set(MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK, (message) => {
      if (!this.callbacks.handleNativeFeedback) {
        return;
      }

      if (
        !isUserFeedbackSeverity(message.severity) ||
        typeof message.message !== "string"
      ) {
        return;
      }

      this.callbacks.handleNativeFeedback({
        severity: message.severity,
        message: message.message,
        detail: typeof message.detail === "string" ? message.detail : undefined,
      });
    });
  }

  private registerLifecycle(table: DispatchTable): void {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.READY, async (message, ctx) => {
      if (ctx.clientId === PANEL_CLIENT_ID) {
        // Cancel RECONNECT retries before any awaited startup work so a valid
        // panel READY immediately stops further nudges from the extension.
        const shouldHandleReady = this.callbacks.onPanelReady?.();
        if (shouldHandleReady === false) {
          Log.debug(
            "[WebviewMessageRouter] Ignoring duplicate panel READY for the current webview"
          );
          return;
        }
      }
      await this.settingsSync.sendInitialState(ctx.postMessage, ctx.clientId);
      // Tell the webview its own client identity so it can compute isController
      ctx.emit({
        type: MESSAGE_TYPES.CLIENT_ID_ASSIGNED,
        clientId: ctx.clientId,
      });
      const orchestrator = this.getOrchestrator();

      if (orchestrator) {
        await orchestrator.handleClientReady(ctx.clientId, ctx.postMessage, {
          skipTerminalReplay:
            this.terminalHandlers.shouldSkipClientReadyReplay(ctx),
          preferredViewAddress:
            message.preferredViewAddress &&
            typeof message.preferredViewAddress.workflowKey === "string" &&
            (message.preferredViewAddress.kind === "draft" ||
              (message.preferredViewAddress.kind === "run" &&
                typeof message.preferredViewAddress.runRef === "string"))
              ? message.preferredViewAddress
              : undefined,
        });
        // For browser clients: SESSION_RESTORED (sent during replay) triggers
        // applyWorkflowChange() which no longer clears workflowProperties, but
        // WORKFLOW_PROPERTIES_UPDATE is still needed to replace any stale values
        // from the previously-viewed workflow with the correct ones.
        if (ctx.clientId !== PANEL_CLIENT_ID) {
          // Do not await the browser startup follow-up while holding the
          // shared routeQueue. Browser READY can arrive before panel READY
          // during extension reloads, and awaitStartupAutoLoad() depends on
          // the panel READY path reaching setDashboardReady(). Running this
          // continuation in the background avoids deadlocking panel startup.
          // `ctx` is safe to hand to a detached continuation: it is a captured
          // value, not the router's live scope.
          void this.completeBrowserReadyAfterStartup(ctx, orchestrator);
        }
      }

      // Panel-only extras:
      if (ctx.clientId === PANEL_CLIENT_ID) {
        if (orchestrator) {
          // Register the callback before setDashboardReady so it's in place
          // whether the auto-load runs immediately (orchestrator already init'd)
          // or is deferred until initialize() completes.
          orchestrator.setPostAutoLoadCallback(async () => {
            await this.settingsSync.sendWorkflowPropertiesToSettings(
              ctx.postMessage,
              ctx.clientId
            );
          });
          await orchestrator.setDashboardReady(ctx.postMessage);
          // Both follow-ups are gated on startup having already settled, and for
          // the same reason: on a cold start the panel READY arrives long before
          // initialize() finishes, so anything sent here lands mid-startup. The
          // replay that makes the properties send necessary only happens inside
          // setDashboardReady when _autoLoadHasSettled, and WORKFLOW_LOADED
          // (emitted by sendWorkflowPropertiesToSettings) enables editing UI — it
          // must not appear until the deferred auto-load has run, or an edit made
          // against it gets overwritten when the auto-load lands. For the still-
          // starting case, triggerAutoLoad's finally block fires the same callback
          // and the hub broadcasts STARTUP_COMPLETE.
          if (orchestrator.isAutoLoadTriggered) {
            await this.settingsSync.sendWorkflowPropertiesToSettings(
              ctx.postMessage,
              ctx.clientId
            );
            // triggerAutoLoad won't re-run (webview reload or panel reconnect), so
            // the hub broadcast won't fire again — send STARTUP_COMPLETE directly.
            this.settingsSync.sendStartupComplete(ctx.postMessage);
          }
        }
        // Reconnect server running state (handles webview reload while server is up)
        const serverUrl = this.callbacks.getServerUrl?.();
        if (serverUrl) {
          const availableIps = this.callbacks.getAvailableIps?.() ?? [];
          ctx.emit({
            type: MESSAGE_TYPES.SERVER_STARTED,
            url: serverUrl,
            availableIps,
          });
        }
        this.terminalHandlers.reconnectPanel(ctx);
      }
    });
  }

  private registerDevActions(table: DispatchTable): void {
    // ── Developer Actions ──────────────────────────────────────────────────
    const routeDevAction =
      (action: DevDashboardAction): WebviewMessageHandler =>
      async (_message, ctx) => {
        if (!this.callbacks.handleDevAction) {
          ctx.emit({
            type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
            command: action,
            reason: "Developer actions are unavailable in this build.",
          });
          return;
        }
        await this.callbacks.handleDevAction(action, ctx.postMessage);
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
    table.set(MESSAGE_TYPES.DEV_REQUEST_STATUS, async (_message, ctx) => {
      await this.callbacks.handleDevStatusRequest?.(ctx.postMessage);
    });

    // UX Snapshot capture — carries a payload (markdown + optional png), unlike
    // the routeDevAction commands above. Gated the same way: when no write
    // callback is registered (production build) emit DEV_COMMAND_UNAVAILABLE so
    // no file-write path exists. Resolves the workspace root here so the same
    // handler serves both the VS Code panel and phone/browser clients (whose
    // messages arrive via routeExternalMessage on this same router).
    table.set(MESSAGE_TYPES.UX_SNAPSHOT_CAPTURE, async (message, ctx) => {
      if (!this.callbacks.handleUxSnapshot) {
        ctx.emit({
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
        ctx.postMessage
      );
    });
  }

  /**
   * Resolve a workflow file path supplied by a dashboard client.
   *
   * Client-supplied paths are not guaranteed absolute: `WorkflowFilePickerModal`
   * documents its manual field as workspace-relative (`path/to/workflow.ctrlyoke.yaml`),
   * and nothing downstream resolves one — `PromptFileParser.parsePromptFile`
   * does a bare `fs.readFile`, so a relative path would silently resolve
   * against the extension host's cwd and fail (or worse, hit an unrelated
   * file). Both file-addressed actions — LOAD_WORKFLOW and APPEND_FILE —
   * therefore resolve here, at the transport edge, so they cannot drift apart.
   * Folder-name-prefixed multi-root paths (`otherFolder/flows/x.yaml`, the form
   * workflow discovery reports) go through the same resolver as `@`-references.
   */
  private resolveClientWorkflowFilePath(filePath: string): string {
    return resolveNamedRelativePath(
      filePath,
      getVsCodeWorkspaceRoot(),
      getVsCodeNamedWorkspaceRoots()
    );
  }

  private registerWorkflowControl(table: DispatchTable): void {
    // ── Dashboard — Workflow Control ──────────────────────────────────────
    table.set(MESSAGE_TYPES.SELECT_FILE, () => {
      vscode.commands.executeCommand("ctrlyoke.selectPromptFile");
    });

    table.set(MESSAGE_TYPES.APPEND_FILE, async (message, ctx) => {
      if (message.filePath) {
        const mutation =
          this.mutationCoordinator.asWorkflowDefinitionMutation(message);
        const isRunAddressed = mutation?.address.kind === "run";
        try {
          await this.getOrchestrator()?.appendFromFileForClient(
            mutation,
            this.resolveClientWorkflowFilePath(message.filePath),
            ctx.clientId,
            QUEUE_POSITION.END
          );
        } catch (error) {
          if (!isRunAddressed) throw error;
          this.mutationCoordinator.showRunActionFailure(
            ctx,
            "append and continue from file",
            error
          );
        }
        return;
      }
      vscode.commands.executeCommand("ctrlyoke.appendFromDashboard");
    });

    table.set(MESSAGE_TYPES.EDIT_FILE, () => {
      vscode.commands.executeCommand("ctrlyoke.editCurrentPromptFile");
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW, async (_message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.createWorkflowForClient(
          ctx.postMessage,
          ctx.clientId
        );
        // A new workflow has no working file, so sendWorkflowPropertiesToSettings
        // returns early without sending anything. Explicitly clear the panel so it
        // shows global defaults instead of the previous workflow's properties.
        ctx.emit({
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

    table.set(MESSAGE_TYPES.EXPORT_OUTPUT, async (message, ctx) => {
      await this.serializer.handleExportOutput(
        message.content,
        message.fileName,
        ctx.postMessage
      );
    });
  }

  private registerPromptEditor(table: DispatchTable): void {
    // ── Dashboard — Prompt Editor ────────────────────────────────────────
    table.set(MESSAGE_TYPES.EXECUTE_PROMPT, (message, ctx) => {
      void this.workflowStepHandlers.handleExecutePrompt(ctx, message);
    });

    table.set(MESSAGE_TYPES.UPDATE_PROMPT, (message, ctx) => {
      void this.workflowStepHandlers.handleUpdatePrompt(ctx, message);
    });

    table.set(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, async (message, ctx) => {
      await this.workflowStepHandlers.handleInsertWorkflowStep(ctx, message);
    });

    table.set(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, async (message, ctx) => {
      await this.workflowStepHandlers.handleUpdateFinalStep(ctx, message);
    });

    table.set(MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT, (message, ctx) => {
      ctx.emit({
        type: MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT,
        index: message.index,
      });
    });

    table.set(MESSAGE_TYPES.DELETE_PROMPT, async (message, ctx) => {
      await this.workflowStepHandlers.handleDeletePrompt(ctx, message);
    });

    table.set(MESSAGE_TYPES.SET_START_POSITION, async (message, ctx) => {
      await this.workflowStepHandlers.handleSetStartPosition(
        ctx,
        message as SetStartPositionMessage
      );
    });

    table.set(MESSAGE_TYPES.DISCARD_CONTINUATION, async (message, ctx) => {
      await this.workflowStepHandlers.handleDiscardContinuation(
        ctx,
        message as DiscardContinuationMessage
      );
    });

    table.set(MESSAGE_TYPES.REORDER_PROMPTS, async (message, ctx) => {
      await this.mutationCoordinator.prepareDefinitionMutation(ctx, message);
      await this.getOrchestrator()?.reorderPendingPrompts(
        this.mutationCoordinator.asWorkflowDefinitionMutation(message),
        message.newPendingOrder as number[],
        ctx.clientId
      );
      // Identity-only — see the comment in WorkflowStepHandlers.handleUpdatePrompt.
      // The reordering client already holds the post-reorder steps via its own
      // REORDER_PROMPTS_CONFIRMED broadcast.
      await this.mutationCoordinator.publishViewIdentity(ctx);
    });

    table.set(MESSAGE_TYPES.UNDO_REDO_SYNC, async (message, ctx) => {
      await this.workflowStepHandlers.handleUndoRedoSync(ctx, message);
    });
  }

  private registerEditorSupport(table: DispatchTable): void {
    // ── Dashboard — CodeMirror Editor ────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_COMPLETIONS, async (message, ctx) => {
      await this.promptEditorSupport.handleCompletionRequest(
        ctx,
        message.trigger,
        message.prefix,
        message.position,
        message.seq
      );
    });

    table.set(MESSAGE_TYPES.OPEN_FILE, (message, ctx) => {
      this.promptEditorSupport.handleOpenFile(
        ctx,
        message.path,
        message.lineStart,
        message.lineEnd
      );
    });

    table.set(MESSAGE_TYPES.OPEN_SKILL, (message, ctx) => {
      this.promptEditorSupport.handleOpenSkill(ctx, message.skillName);
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

    table.set(MESSAGE_TYPES.OPEN_WORKTREE, async (message) => {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.OPEN_WORKTREE, {
        worktreePath: message.worktreePath,
      });
    });

    table.set(MESSAGE_TYPES.VIEW_WORKTREE_DIFF, async (message) => {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.VIEW_WORKTREE_DIFF, {
        sourceCheckoutRoot: message.sourceCheckoutRoot,
        baseCommit: message.baseCommit,
        branchName: message.branchName,
      });
    });

    table.set(MESSAGE_TYPES.MERGE_WORKTREE, async (message) => {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.MERGE_WORKTREE, {
        address: message.address,
      });
    });

    table.set(MESSAGE_TYPES.OPEN_PRIOR_CONTEXT, async (message, ctx) => {
      await this.promptEditorSupport.handleOpenPriorContext(
        ctx,
        message.ref as string,
        (message.stepCount as number) ?? 0
      );
    });

    table.set(
      MESSAGE_TYPES.REQUEST_PRIOR_CONTEXT_PREVIEW,
      async (message, ctx) => {
        const content = await this.promptEditorSupport.buildPriorContextContent(
          ctx,
          message.ref as string,
          (message.stepCount as number) ?? 0
        );
        ctx.emit({
          type: MESSAGE_TYPES.PRIOR_CONTEXT_PREVIEW_RESULT,
          ref: message.ref,
          content,
        });
      }
    );

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

    table.set(MESSAGE_TYPES.VALIDATE_FILE_REF, async (message, ctx) => {
      await this.promptEditorSupport.handleFileRefValidation(
        ctx,
        message.filePath,
        message.seq,
        message.address
      );
    });

    table.set(MESSAGE_TYPES.CONVERT_PROMPT_TO_FILE, async (message, ctx) => {
      await this.promptEditorSupport.handleConvertPromptToFile(ctx, message);
    });

    table.set(MESSAGE_TYPES.OPEN_PROMPT_FILE, async (message, ctx) => {
      await this.promptEditorSupport.handleOpenPromptFile(ctx, message.path);
    });

    table.set(MESSAGE_TYPES.VALIDATE_CONTEXT_REFS, async (message, ctx) => {
      await this.promptEditorSupport.handleContextRefsValidation(
        ctx,
        message.references ?? [],
        message.seq
      );
    });

    table.set(MESSAGE_TYPES.SAVE_PASTED_IMAGE, async (message, ctx) => {
      await this.promptEditorSupport.handleSavePastedImage(ctx, message);
    });

    table.set(MESSAGE_TYPES.REQUEST_FILE_PREVIEW_URI, async (message, ctx) => {
      await this.promptEditorSupport.handleFilePreviewUriRequest(ctx, message);
    });

    table.set(
      MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      async (message, ctx) => {
        await this.promptEditorSupport.handleAttachmentTokenCountRequest(
          ctx,
          message.references
        );
      }
    );
  }

  private registerMcpManager(table: DispatchTable): void {
    // ── MCP Manager ─────────────────────────────────────────────────────
    table.set(
      MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SERVERS,
      async (_message, ctx) => {
        await this.mcpManager.handleRequestRegistryServers(ctx);
      }
    );

    table.set(MESSAGE_TYPES.SAVE_MCP_REGISTRY_SERVER, async (message, ctx) => {
      await this.mcpManager.handleSaveRegistryServer(
        ctx,
        message as SaveMcpRegistryServerMessage
      );
    });

    table.set(
      MESSAGE_TYPES.DELETE_MCP_REGISTRY_SERVER,
      async (message, ctx) => {
        await this.mcpManager.handleDeleteRegistryServer(
          ctx,
          message as DeleteMcpRegistryServerMessage
        );
      }
    );

    table.set(MESSAGE_TYPES.REQUEST_MCP_LOCAL_SCAN, async (_message, ctx) => {
      await this.mcpManager.handleRequestLocalScan(ctx);
    });

    table.set(
      MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SEARCH,
      async (message, ctx) => {
        await this.mcpManager.handleRequestRegistrySearch(
          ctx,
          message as RequestMcpRegistrySearchMessage
        );
      }
    );

    table.set(MESSAGE_TYPES.EXPORT_MCP_TO_HARNESS, async (message, ctx) => {
      await this.mcpManager.handleExportToHarness(
        ctx,
        message as ExportMcpToHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.DELETE_MCP_FROM_HARNESS, async (message, ctx) => {
      await this.mcpManager.handleDeleteFromHarness(
        ctx,
        message as DeleteMcpFromHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW, async (message, ctx) => {
      await this.mcpManager.handleRequestMcpConfigPreview(
        ctx,
        message as RequestMcpConfigPreviewMessage
      );
    });
  }

  private registerHarnessFiles(table: DispatchTable): void {
    // ── Harness File Manager ─────────────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_HARNESS_FILES, async (message, ctx) => {
      await this.harnessFiles.handleRequestHarnessFiles(
        ctx,
        message as RequestHarnessFilesMessage
      );
    });

    table.set(MESSAGE_TYPES.EXPORT_TO_HARNESS, async (message, ctx) => {
      await this.harnessFiles.handleExportToHarness(
        ctx,
        message as ExportToHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.IMPORT_TO_CTRLYOKE, async (message, ctx) => {
      await this.harnessFiles.handleImportToCtrlYoke(
        ctx,
        message as ImportToCtrlYokeMessage
      );
    });

    table.set(MESSAGE_TYPES.DELETE_FROM_HARNESS, async (message, ctx) => {
      await this.harnessFiles.handleDeleteFromHarness(
        ctx,
        message as DeleteFromHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.SYNC_ALL_TO_HARNESS, async (message, ctx) => {
      await this.harnessFiles.handleSyncAllToHarness(
        ctx,
        message as SyncAllToHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS, async (message, ctx) => {
      await this.harnessFiles.handleDeleteAllFromHarness(
        ctx,
        message as DeleteAllFromHarnessMessage
      );
    });

    table.set(MESSAGE_TYPES.OPEN_HARNESS_DIR, async (message, ctx) => {
      await this.harnessFiles.handleOpenHarnessDir(
        ctx,
        message as OpenHarnessDirMessage
      );
    });
  }

  private registerOutputHistory(table: DispatchTable): void {
    // ── Output History ───────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) {
        throw new Error(
          "ctrlyoke is still starting up — try again in a moment"
        );
      }
      const result = await orchestrator.buildExecutionPreviewForClient(
        ctx.clientId,
        message.scope,
        message.editorSnapshot
      );
      // Keep redaction at the final webview transport boundary as well as in
      // ExecutionPreviewService. Hosted browser messages use this same route.
      ctx.emit({
        type: MESSAGE_TYPES.EXECUTION_PREVIEW_RESULT,
        requestToken: message.requestToken,
        scope: message.scope,
        address: result.address,
        displayedDefinitionRevision: result.displayedDefinitionRevision,
        preview: redactExecutionPreview(result.preview),
      });
    });

    table.set(MESSAGE_TYPES.LOAD_RUN_VIEW, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) {
        // Returning silently leaves the client's request outstanding forever,
        // which suppresses every requestless run-view push it would otherwise
        // apply (see the catch below). Answer it instead.
        await this.mutationCoordinator.reportActionFailure(
          ctx,
          "load run",
          new Error("ctrlyoke is still starting up — try again in a moment"),
          message.requestId
        );
        return;
      }
      try {
        await orchestrator.loadRunViewForClient(
          message.address,
          ctx.postMessage,
          ctx.clientId,
          message.requestId
        );
      } catch (error) {
        // The requestId must come back: the client suppresses run-view
        // snapshots and view-identity updates while its own request is in
        // flight, so a silent failure would freeze its revisions permanently.
        await this.mutationCoordinator.reportActionFailure(
          ctx,
          "load run",
          error,
          message.requestId
        );
      }
    });

    table.set(MESSAGE_TYPES.LOAD_RUN_SUMMARIES, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return;
      try {
        await orchestrator.loadRunSummariesForClient(
          message.workflowKey,
          ctx.postMessage,
          message.requestId
        );
      } catch (error) {
        await this.mutationCoordinator.reportActionFailure(
          ctx,
          "load run summaries",
          error,
          message.requestId
        );
      }
    });

    table.set(MESSAGE_TYPES.SEARCH_HISTORY, async (message, ctx) => {
      const query =
        typeof message.query === "string" ? message.query.trim() : "";
      const limit =
        typeof message.limit === "number" && message.limit > 0
          ? Math.min(message.limit, 100)
          : 50;
      const workspacePath = this.getWorkspaceRoot();
      if (!workspacePath) {
        ctx.emit({
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
      ctx.emit({
        type: MESSAGE_TYPES.SEARCH_HISTORY_RESULTS,
        ...response,
        cursor: typeof message.cursor === "string" ? message.cursor : undefined,
      });
    });

    table.set(MESSAGE_TYPES.DELETE_RUN_HISTORY, async (message, ctx) => {
      // Phase 2 requires stable refs. Index deletion is intentionally not
      // accepted here; old clients must refresh to the run-address contract.
      if (!message.address || message.address.kind !== "run") return;
      await this.serializer.handleDeleteRunByAddress(
        message.address,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(
      MESSAGE_TYPES.DELETE_ALL_RUNS_FOR_LINEAGE,
      async (message, ctx) => {
        if (!message.workflowKey) return;
        try {
          await this.serializer.handleDeleteAllRunsForLineage(
            message.workflowKey,
            ctx.postMessage,
            ctx.clientId
          );
        } catch (error) {
          await this.mutationCoordinator.reportActionFailure(
            ctx,
            "delete all runs",
            error
          );
        }
      }
    );
  }

  private registerWorkflowVariants(table: DispatchTable): void {
    table.set(MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT, async (message, ctx) => {
      this.pruneWorkflowVariantRequests();
      const cacheKey = `${ctx.clientId}\u0000${message.requestId}`;
      let entry = this.workflowVariantRequests.get(cacheKey);
      if (!entry) {
        const reply = this.createWorkflowVariantReply(message);
        entry = { reply };
        this.workflowVariantRequests.set(cacheKey, entry);
        reply.then(() => {
          const current = this.workflowVariantRequests.get(cacheKey);
          if (current?.reply === reply) {
            current.completedAt = Date.now();
            this.pruneWorkflowVariantRequests();
          }
        });
      }

      // Always reply through the context captured for this inbound message.
      // Retries from a hosted client must not broadcast or follow another
      // client's transport.
      ctx.postMessage(await entry.reply);
    });

    // These are extension → webview replies. They are registered so the
    // dispatch table remains complete if a transport feeds a reply back into
    // the router; the originating handler above is the only producer.
    table.set(MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED, () => undefined);
    table.set(MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED, () => undefined);
  }

  private async createWorkflowVariantReply(
    message: any
  ): Promise<WorkflowVariantReply> {
    try {
      const address = await new WorkflowVariantService(
        this.getWorkspaceRoot()
      ).createWorkflowVariant({
        source: message.source,
        workflowName: message.workflowName,
        overrides: message.overrides,
      });
      return {
        type: MESSAGE_TYPES.WORKFLOW_VARIANT_CREATED,
        requestId: message.requestId,
        address,
      };
    } catch (error) {
      return {
        type: MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED,
        requestId: message.requestId,
        error: getErrorMessage(error),
      };
    }
  }

  private pruneWorkflowVariantRequests(): void {
    const now = Date.now();
    for (const [key, entry] of this.workflowVariantRequests) {
      if (
        entry.completedAt !== undefined &&
        now - entry.completedAt >= WORKFLOW_VARIANT_REQUEST_CACHE_TTL_MS
      ) {
        this.workflowVariantRequests.delete(key);
      }
    }

    const completed = [...this.workflowVariantRequests.entries()]
      .filter(([, entry]) => entry.completedAt !== undefined)
      .sort(([, left], [, right]) => left.completedAt! - right.completedAt!);
    for (const [key] of completed) {
      if (
        this.workflowVariantRequests.size <=
        WORKFLOW_VARIANT_REQUEST_CACHE_MAX_ENTRIES
      ) {
        break;
      }
      this.workflowVariantRequests.delete(key);
    }
  }

  private registerWorkflowModal(table: DispatchTable): void {
    // ── Dashboard — New Workflow Modal ───────────────────────────────────
    table.set(MESSAGE_TYPES.NEW_WORKFLOW, (_message, ctx) => {
      this.serializer.handleNewWorkflow(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.TEMPLATE_SELECTED, (message, ctx) => {
      this.serializer.handleTemplateSelected(
        message.templateId,
        ctx.postMessage
      );
    });

    table.set(MESSAGE_TYPES.SET_DEFAULT_TEMPLATE, (message, ctx) => {
      this.serializer.handleSetDefaultTemplate(
        message.templateId,
        ctx.postMessage
      );
    });

    table.set(MESSAGE_TYPES.CREATE_WORKFLOW, async (message, ctx) => {
      // createWorkflowFromTemplateForClient scopes the new instance to clientId,
      // so panel and browser clients share this path without touching each
      // other's viewed workflow.
      const created = await this.serializer.handleCreateWorkflow(
        message,
        ctx.clientId,
        ctx.postMessage
      );

      if (created) {
        // The template path replays workflow state, which clears or retains the
        // previous workflow properties in the webview. Send the newly-created
        // working file's seeded defaults so the properties panel reflects it.
        await this.settingsSync.sendWorkflowPropertiesToSettings(
          ctx.postMessage,
          ctx.clientId
        );
      }
    });

    table.set(MESSAGE_TYPES.CREATE_CUSTOM_TEMPLATE, (message, ctx) => {
      this.serializer
        .handleCreateCustomTemplate(
          message.name,
          message.scope,
          message.format,
          message.baseTemplateId,
          ctx.postMessage
        )
        .catch((err) => Log.warn(`CREATE_CUSTOM_TEMPLATE failed: ${err}`));
    });

    table.set(MESSAGE_TYPES.BROWSE_TEMPLATE_FILE, (message, ctx) => {
      this.serializer.handleBrowseTemplateFile(
        message.variable,
        message.fileFilter,
        ctx.postMessage,
        message.selectFolder
      );
    });

    table.set(MESSAGE_TYPES.BROWSE_SAVE_LOCATION, (message, ctx) => {
      this.serializer.handleBrowseSaveLocation(
        ctx.postMessage,
        message.defaultDir
      );
    });
  }

  private registerWorkflowStatus(table: DispatchTable): void {
    // ── Dashboard — Workflow Status ──────────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_NAME, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.updateWorkflowName(
          this.mutationCoordinator.asWorkflowDefinitionMutation(message),
          message.workflowName,
          ctx.clientId
        );
        // Renaming a brand-new workflow is what materializes its lineage/draft,
        // so this is often the client's first chance to learn its own address.
        await this.mutationCoordinator.publishViewIdentity(ctx);
        return;
      }
      this.serializer.handleUpdateWorkflowName(
        message,
        this.callbacks.updateWorkflowName,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.GET_RECENT_WORKFLOWS, (_message, ctx) => {
      this.serializer.handleGetRecentWorkflows(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE, async (message) => {
      if (message.address) {
        await this.serializer.handleToggleFavorite(message.address);
      }
    });

    table.set(MESSAGE_TYPES.LOAD_WORKFLOW, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        // Two payload shapes reach here and both must be honored: an execution
        // `address` (an existing lineage/run) and a workspace `filePath` (a
        // source workflow file — the standalone "Load from File" picker and the
        // workspace-editor context menu). Dropping the filePath branch made
        // both of those silently no-op with nothing logged.
        if (message.address) {
          await orchestrator.loadRunViewForClient(
            message.address,
            ctx.postMessage,
            ctx.clientId
          );
        } else if (message.filePath) {
          await orchestrator.loadPromptFileForClient(
            this.resolveClientWorkflowFilePath(message.filePath),
            ctx.postMessage,
            ctx.clientId
          );
        } else {
          return;
        }
        // FILE_SELECTED (emitted during replay) calls applyWorkflowChange() which
        // clears workflowProperties. Repopulate them so the PropertiesPanel reflects
        // the loaded workflow's saved configuration — same pattern as SWITCH_WORKFLOW.
        await this.settingsSync.sendWorkflowPropertiesToSettings(
          ctx.postMessage,
          ctx.clientId
        );
        return;
      }
      // Fallback when orchestrator is not yet available
      this.serializer.handleLoadWorkflow(message, ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY, async (_message, ctx) => {
      const currentWorkingFilePath = this.getOrchestrator()?.getQueueState(
        ctx.clientId
      )?.workingFilePath;
      const deleted = await this.serializer.handleClearWorkflowHistory(
        ctx.postMessage
      );
      // Clear the stale working file path if it was deleted by the history clear.
      // Same logic as REMOVE_WORKFLOW_HISTORY — we do NOT call clearWorkflow() to
      // preserve the user's prompts and source file reference.
      if (deleted && currentWorkingFilePath) {
        this.getOrchestrator()?.clearWorkingFilePath(ctx.clientId);
      }
    });
  }

  private registerSettings(table: DispatchTable): void {
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

    table.set(MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST, (_message, ctx) => {
      this.settingsSync.handleGlobalSettingsLoadRequest(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.RELOAD_WINDOW, async () => {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.RELOAD_WINDOW);
    });

    table.set(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, (message, ctx) => {
      this.settingsSync.handleUpdateGlobalSetting(
        message.path,
        message.value,
        message.scope,
        ctx.postMessage
      );
    });

    const sendWorktreeManagementState = async (
      refresh: boolean,
      ctx: WebviewClientContext,
      requestId?: string
    ): Promise<void> => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return;
      const state = refresh
        ? await orchestrator.refreshWorktreeManagementState()
        : await orchestrator.getWorktreeManagementState();
      ctx.emit({
        type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_STATE,
        state,
        ...(requestId ? { requestId } : {}),
      });
    };

    table.set(
      MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE,
      (message, ctx) => {
        if (message.refresh === true) {
          Log.info("[WorktreeManagement] refresh requested");
        }
        return sendWorktreeManagementState(
          message.refresh === true,
          ctx,
          message.requestId
        );
      }
    );
    table.set(MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return;
      const target = message.worktreePath ?? message.branchName ?? "";
      Log.info(
        `[WorktreeManagement] ${message.action} requested for "${target}"`
      );
      let success = true;
      let resultMessage: string;
      try {
        await orchestrator.applyWorktreeManagementAction({
          action: message.action,
          worktreePath: message.worktreePath,
          branchName: message.branchName,
          confirmed: message.confirmed,
        });
        resultMessage = describeWorktreeActionSuccess(message.action, target);
        Log.info(`[WorktreeManagement] ${message.action} succeeded: ${resultMessage}`);
        void vscode.window.showInformationMessage(resultMessage);
      } catch (error) {
        // Without this, a rejected destructive action (e.g. a stale admin
        // entry that still needs `git worktree repair`) vanished into the
        // log with no feedback in the panel — the button looked like a no-op.
        success = false;
        resultMessage = `Worktree action failed: ${getErrorMessage(error)}`;
        Log.error(
          `[WorktreeManagement] ${message.action} failed for "${target}": ${getErrorMessage(error)}`
        );
        void vscode.window.showErrorMessage(resultMessage);
      }
      if (message.requestId) {
        ctx.emit({
          type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION_RESULT,
          requestId: message.requestId,
          success,
          message: resultMessage,
        });
      }
      await sendWorktreeManagementState(true, ctx);
    });
    table.set(MESSAGE_TYPES.SYNC_NAMED_WORKTREE, async (message, ctx) => {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return;
      Log.info(
        `[WorktreeManagement] sync requested for "${message.worktreePath}"`
      );
      let success = true;
      let resultMessage: string;
      try {
        const result = await orchestrator.syncNamedWorktree(
          message.worktreePath
        );
        const succeeded = (direction: typeof result.intoSource) =>
          direction.mergeOutcome === "fast-forward" ||
          direction.mergeOutcome === "merge-commit";
        const describe = (
          label: string,
          direction: typeof result.intoSource
        ): string =>
          succeeded(direction)
            ? `${label} up to date`
            : `${label} ${direction.message ?? direction.mergeOutcome}`;
        const summary = [
          describe(`"${result.sourceBranch}":`, result.intoSource),
          describe(`"${result.worktreeBranch}":`, result.intoWorktree),
        ].join(" — ");
        success = succeeded(result.intoSource) && succeeded(result.intoWorktree);
        resultMessage = success
          ? `Worktree synced. ${summary}`
          : `Worktree sync finished with issues. ${summary}`;
        if (success) {
          Log.info(`[WorktreeManagement] sync succeeded: ${summary}`);
          void vscode.window.showInformationMessage(resultMessage);
        } else {
          Log.warn(`[WorktreeManagement] sync finished with issues: ${summary}`);
          void vscode.window.showWarningMessage(resultMessage);
        }
      } catch (error) {
        success = false;
        resultMessage = `Worktree sync failed: ${getErrorMessage(error)}`;
        Log.error(
          `[WorktreeManagement] sync failed for "${message.worktreePath}": ${getErrorMessage(error)}`
        );
        void vscode.window.showErrorMessage(resultMessage);
      }
      if (message.requestId) {
        ctx.emit({
          type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION_RESULT,
          requestId: message.requestId,
          success,
          message: resultMessage,
        });
      }
      await sendWorktreeManagementState(true, ctx);
    });
    table.set(MESSAGE_TYPES.OPEN_WORKTREE_OWNER, async (message) => {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.OPEN_WORKTREE_OWNER, {
        stateRoot: message.stateRoot,
      });
    });

    table.set(MESSAGE_TYPES.REQUEST_HARNESS_USAGE, (_message, ctx) => {
      const service = this.getOrchestrator()?.getHarnessUsageService();
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_USAGE_UPDATED,
        snapshots: service?.getHarnessUsageSnapshots() ?? [],
      });
      // The launch path is cache-only. Provider and observed refreshes happen
      // after the cached response has reached the client.
      void service?.refreshAllHarnessUsage();
    });

    table.set(MESSAGE_TYPES.REFRESH_HARNESS_USAGE, async (_message, ctx) => {
      const service = this.getOrchestrator()?.getHarnessUsageService();
      if (!service) {
        ctx.emit({ type: MESSAGE_TYPES.HARNESS_USAGE_UPDATED, snapshots: [] });
        return;
      }
      const snapshots = await service.refreshAllHarnessUsage();
      ctx.emit({ type: MESSAGE_TYPES.HARNESS_USAGE_UPDATED, snapshots });
    });

    table.set(MESSAGE_TYPES.REQUEST_WORKSPACE_STATS, async (_message, ctx) => {
      const orchestrator = this.getOrchestrator();
      const service = orchestrator?.getWorkspaceStatsService();
      const snapshot = await service?.getSnapshot();
      ctx.emit({ type: MESSAGE_TYPES.WORKSPACE_STATS_UPDATED, snapshot });
      // The launch path returns the persisted rollup first. The full backfill
      // then runs in the background and broadcasts its completed snapshot.
      void orchestrator?.refreshWorkspaceStats();
    });

    table.set(MESSAGE_TYPES.REFRESH_WORKSPACE_STATS, async (_message, ctx) => {
      const snapshot = await this.getOrchestrator()?.refreshWorkspaceStats();
      ctx.emit({ type: MESSAGE_TYPES.WORKSPACE_STATS_UPDATED, snapshot });
    });

    table.set(MESSAGE_TYPES.ENABLE_SERVER, (_message, ctx) => {
      this.settingsSync.handleEnableServer(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.DISABLE_SERVER, (_message, ctx) => {
      this.settingsSync.handleDisableServer(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.REGENERATE_SERVER_TOKEN, (_message, ctx) => {
      this.settingsSync.handleRegenerateServerToken(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.GENERATE_SERVER_CERT, (message, ctx) => {
      void this.settingsSync.handleGenerateServerCert(
        ctx.postMessage,
        message.scope
      );
    });

    table.set(MESSAGE_TYPES.DOWNLOAD_SERVER_CERT, (_message, ctx) => {
      void this.settingsSync.handleDownloadServerCert(ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.THEME_VARS_CAPTURED, (message, ctx) => {
      // Only the trusted in-panel VS Code webview may update the shared theme
      // snapshot — it gets spliced into server-rendered HTML served to every
      // hosted-dashboard visitor, so accepting it from external browser
      // clients would let anyone holding a server token plant a stored
      // injection that persists for every future visitor.
      if (ctx.clientId === PANEL_CLIENT_ID) {
        this.themeVarsCapturedCallback?.(message.vars);
      }
    });

    // ── Settings — Workflow Properties ───────────────────────────────────
    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, (message, ctx) => {
      return this.workflowStepHandlers.handleUpdateWorkflowProperty(
        ctx,
        message
      );
    });

    table.set(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES, (message, ctx) => {
      return this.workflowStepHandlers.handleUpdateWorkflowProperties(
        ctx,
        message
      );
    });

    table.set(MESSAGE_TYPES.SET_AS_DEFAULT, (message) => {
      this.settingsSync.handleSetAsDefault(
        message.property,
        message.value,
        message.harness
      );
    });

    table.set(MESSAGE_TYPES.GET_CONFIG, (message, ctx) => {
      this.settingsSync.handleGetConfig(message.key, ctx.postMessage);
    });

    table.set(MESSAGE_TYPES.UPDATE_CONFIG, (message) => {
      this.settingsSync.handleUpdateConfig(message.key, message.value);
    });

    table.set(MESSAGE_TYPES.BROWSE_AND_ADD_EXTERNAL_ROOT, (message, ctx) => {
      this.settingsSync.handleBrowseAndAddExternalRoot(
        message.scope,
        ctx.postMessage
      );
    });

    table.set(MESSAGE_TYPES.LOG_MESSAGE, (message, ctx) => {
      this.handleWebviewLog(ctx, message.level, message.message);
    });
  }

  private registerSaveWorkflow(table: DispatchTable): void {
    // ── Save Workflow ────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST, async (message, ctx) => {
      await this.serializer.handleSaveWorkflowRequest(
        message.requestId,
        message.address,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.CHECK_SAVE_PATH, async (message, ctx) => {
      await this.serializer.handleCheckSavePath(
        message.requestId,
        message.path,
        message.address,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.SAVE_WORKFLOW, async (message, ctx) => {
      await this.serializer.handleSaveWorkflow(
        message.requestId,
        message.address,
        message.filePath,
        message.format,
        ctx.postMessage,
        ctx.clientId,
        message.planFingerprint,
        message.pathCheckRequestId
      );
    });

    table.set(MESSAGE_TYPES.SAVE_WORKFLOW_AS_TEMPLATE, async (message, ctx) => {
      await this.serializer.handleSaveWorkflowAsTemplate(
        message.requestId,
        message.address,
        message.name,
        message.scope,
        message.format,
        ctx.postMessage,
        ctx.clientId
      );
    });
  }

  private registerMultiWorkflow(table: DispatchTable): void {
    // ── Multi-workflow coordination ──────────────────────────────────────
    table.set(MESSAGE_TYPES.GET_WORKFLOWS_LIST, (_message, ctx) => {
      const orchestrator = this.getOrchestrator();
      const summaries = orchestrator?.getWorkflowSummaries() ?? [];
      Log.trace(
        `[GET_WORKFLOWS_LIST] returning ${summaries.length} summaries: ${summaries.map((s) => `inst:${s.id.slice(0, 8)}(${s.executionState})`).join(", ") || "(none)"}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.WORKFLOWS_LIST,
        workflows: summaries,
      });
      // The dropdown fetches this when opened; refresh the global active-terminal
      // set at the same time so the per-row terminal icon is accurate for every
      // workflow, not just the one this client is viewing.
      ctx.emit({
        type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
        workflows: orchestrator?.getActiveTerminalWorkflowRefs() ?? [],
      });
    });

    table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, async (message, ctx) => {
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
          ctx.postMessage,
          ctx.clientId
        );
        // SESSION_RESTORED (sent by the replay) clears workflowProperties via applyWorkflowChange().
        // Repopulate them immediately so the PropertiesPanel shows the correct state.
        await this.settingsSync.sendWorkflowPropertiesToSettings(
          ctx.postMessage,
          ctx.clientId
        );
      } catch (err) {
        Log.warn(`SWITCH_WORKFLOW per-client replay failed: ${err}`);
      }
    });
  }

  private registerRunLifecycle(table: DispatchTable): void {
    // ── Stable-address run lifecycle controls ──────────────────────────────
    table.set(MESSAGE_TYPES.EXECUTE_DRAFT, (message, ctx) => {
      void this.workflowStepHandlers.handleExecuteDraft(
        ctx,
        message as ExecuteDraftMessage
      );
    });
    table.set(MESSAGE_TYPES.SEED_NEW_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleSeedNewRun(
        ctx,
        message as SeedNewRunMessage
      );
    });
    table.set(MESSAGE_TYPES.START_NEW_RUN_INSTEAD, (message, ctx) => {
      void this.workflowStepHandlers.handleStartNewRunInstead(
        ctx,
        message as StartNewRunInsteadMessage
      );
    });
    table.set(MESSAGE_TYPES.CONTINUE_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleContinueRun(
        ctx,
        message as ContinueRunMessage
      );
    });
    table.set(MESSAGE_TYPES.APPEND_AND_CONTINUE_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleAppendAndContinue(
        ctx,
        message as AppendAndContinueRunMessage
      );
    });
    table.set(MESSAGE_TYPES.PAUSE_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleRunExecutionControl(
        ctx,
        message as RunExecutionControlMessage
      );
    });
    table.set(MESSAGE_TYPES.CANCEL_PAUSE_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleRunExecutionControl(
        ctx,
        message as RunExecutionControlMessage
      );
    });
    table.set(MESSAGE_TYPES.RESUME_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleRunExecutionControl(
        ctx,
        message as RunExecutionControlMessage
      );
    });
    table.set(MESSAGE_TYPES.STOP_RUN, (message, ctx) => {
      void this.workflowStepHandlers.handleRunExecutionControl(
        ctx,
        message as RunExecutionControlMessage
      );
    });

    table.set(MESSAGE_TYPES.STOP_CLI_RUN, async (message) => {
      const { workflowId } = message;
      if (workflowId) {
        await this.getOrchestrator()?.stopCliSession(workflowId);
      }
    });

    table.set(MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY, async (message, ctx) => {
      if (message.address) {
        await this.serializer.handleRemoveWorkflowHistory(message.address);
        // Only the instance whose own file was just deleted may be reset. Keying
        // this off the view address instead would clear an unrelated live
        // workflow's path, and its next write would then fork a duplicate
        // lineage while the queue still held the original steps.
        if (
          this.getOrchestrator()?.getQueueState(ctx.clientId)?.workflowKey ===
          message.address.workflowKey
        ) {
          this.getOrchestrator()?.clearWorkingFilePath(ctx.clientId);
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

    table.set(
      MESSAGE_TYPES.UPDATE_CONFIRM_CONTINUATION_DISCARD,
      async (message) => {
        const { value } = message;
        if (typeof value === "boolean") {
          await ConfigurationUtils.setConfirmContinuationDiscardOperations(
            value
          );
        }
      }
    );
  }

  private registerUndoRedo(table: DispatchTable): void {
    // ── Prompt Undo ──────────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.UNDO_PROMPT_CHANGES, async (message, ctx) => {
      await this.undoRedoCoordinator.handleUndoPromptChanges(
        message as UndoPromptChangesMessage,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.REDO_PROMPT_CHANGES, async (message, ctx) => {
      await this.undoRedoCoordinator.handleRedoPromptChanges(
        message as RedoPromptChangesMessage,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES, async (message, ctx) => {
      await this.undoRedoCoordinator.handleUndoWorkflowChanges(
        message as UndoWorkflowChangesMessage,
        ctx.postMessage,
        ctx.clientId
      );
    });

    table.set(MESSAGE_TYPES.REDO_WORKFLOW_CHANGES, async (message, ctx) => {
      await this.undoRedoCoordinator.handleRedoWorkflowChanges(
        message as RedoWorkflowChangesMessage,
        ctx.postMessage,
        ctx.clientId
      );
    });
  }

  private registerTerminal(table: DispatchTable): void {
    // ── Terminal I/O ─────────────────────────────────────────────────────
    table.set(MESSAGE_TYPES.TERMINAL_INPUT, (message, ctx) => {
      this.terminalHandlers.handleInput(ctx, message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESIZE, (message, ctx) => {
      this.terminalHandlers.handleResize(ctx, message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_VIEWPORT_HINT, (message, ctx) => {
      this.terminalHandlers.handleViewportHint(ctx, message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_SPAWN_SHELL, (message, ctx) => {
      this.terminalHandlers.handleSpawnShell(ctx, message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_RESTART_SHELL, (message) => {
      this.terminalHandlers.handleRestartShell(message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, (message) => {
      this.terminalHandlers.handleCloseShell(message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLOSE_AI_CLI, async (message) => {
      await this.terminalHandlers.handleCloseAiCli(message);
    });

    table.set(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, (message, ctx) => {
      this.terminalHandlers.handleClaimControl(ctx, message);
    });
  }

  private registerWorkspaceInit(table: DispatchTable): void {
    // ── Workspace initialization ────────────────────────────────────────────
    table.set(MESSAGE_TYPES.INITIALIZE_WORKSPACE, async () => {
      const orchestrator = this.getOrchestrator();
      await orchestrator?.handleInitializeWorkspace();
    });

    table.set(MESSAGE_TYPES.LAYOUT_TIP_DISMISSED, async () => {
      const orchestrator = this.getOrchestrator();
      await orchestrator?.handleLayoutPreference();
    });
  }

  // ============================================================================
  // Webview Logging
  // ============================================================================

  private handleWebviewLog(
    ctx: WebviewClientContext,
    level: WebviewLogLevel,
    message: string
  ): void {
    const tag = ctx.clientId;
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
  handleNativeFeedback?: (
    feedback: Omit<ShowNativeFeedbackMessage, "type">
  ) => void;
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
  /**
   * Resolve an absolute, workspace-contained image path to a URI the webview can
   * load in an `<img src>` (VS Code panel: `webview.asWebviewUri`). Absent for
   * transports without a webview URI scheme (e.g. the hosted browser dashboard),
   * in which case inline thumbnails fall back to a plain file-ref.
   */
  resolveImageWebviewUri?: (absolutePath: string) => string | undefined;
  /** Returns the hosted server URL if the server is currently running, undefined otherwise. */
  getServerUrl?: () => string | undefined;
  /** Returns all available LAN IPs (populated when binding to 0.0.0.0). */
  getAvailableIps?: () => string[];
  /**
   * Called synchronously when the VS Code panel sends READY.
   * Used by CtrlYokeWebviewProvider to cancel pending RECONNECT retries
   * so no stale retries fire after the handshake is already complete. Returns
   * false when this webview has already begun its READY handshake, allowing the
   * router to discard duplicate READY messages queued during panel bootstrap.
   */
  onPanelReady?: () => boolean;
}

export interface WebviewRouteOptions {
  postMessage?: PostMessageFn;
  /** Short label identifying the client for log prefixing, e.g. "panel" or "browser:1" */
  clientTag?: string;
}
