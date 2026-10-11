import type { TemplateManager } from "../core/TemplateManager";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import type { LicenseService } from "../license/LicenseService";
import type {
  KeyValueStore,
  DashboardHostActions,
  NamedRoot,
  HostedServerControl,
} from "../core/HostPorts";
import type { SecretStore } from "../platform/SecretStore";
import type {
  WorkflowSummary,
  CoordinationScopeSnapshot,
  ParallelGroupDefinition,
} from "../types/CtrlYokeTypes";
import type {
  CliOutput,
  HarnessAvailabilityReport,
} from "../types/WebviewMessageTypes";
import type { HarnessId } from "../types/DashboardConstants";
import { MESSAGE_TYPES, PANEL_CLIENT_ID } from "../types/DashboardConstants";
import type { DashboardClientEndpoint } from "./DashboardClientEndpoint";
import type { IDashboardProvider } from "./IDashboardProvider";
import { PostMessageDashboardSink } from "./PostMessageDashboardSink";
import { WebviewSettingsSync, type PostMessageFn } from "./WebviewSettingsSync";
import { WorkflowSerializer } from "./WorkflowSerializer";
import {
  WebviewMessageRouter,
  type WebviewRouterHostDependencies,
} from "./WebviewMessageRouter";
import { HistorySearchService } from "../core/orchestration/HistorySearchService";
import { SecretRegistryService } from "./SecretRegistryService";
import { WebviewUserInteractionPort } from "./WebviewUserInteractionPort";
import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "../core/harness/PtyProcessManager";
import { onModelsLoaded } from "../utils/ModelRegistry";
import { configService } from "../config/CtrlYokeConfigService";
import { harnessAvailability } from "../utils/HarnessAvailability";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import type { DashboardBroadcastHub } from "./DashboardBroadcastHub";
import type { LanguageIntelligenceHost } from "../server/lsp/LanguageIntelligenceHost";

/** Host services and view callbacks needed to compose the shared dashboard. */
export interface DashboardApplicationOptions {
  templateManager: TemplateManager;
  postMessage: PostMessageFn;
  isPanelReady(): boolean;
  interactionPostMessage?: PostMessageFn;
  isInteractionClientReady?(): boolean;
  resolveImageWebviewUri(absolutePath: string): string | undefined;
  getServerUrl(): string | undefined;
  getAvailableIps(): string[];
  getPortFallback():
    import("../types/WebviewMessageTypes").ServerPortFallbackInfo | undefined;
  getBindAddressFallback():
    import("../types/WebviewMessageTypes").BindAddressFallbackInfo | undefined;
  keyValueStore: KeyValueStore;
  secretStore: SecretStore;
  getWorkspaceRoot(): string | undefined;
  getSecretWorkspaceRoot(): string;
  getNamedRoots(): NamedRoot[];
  getTrustedRoots(): string[];
  actions: DashboardHostActions;
  serverControl?: HostedServerControl;
  nativeFeedbackSink?: UserFeedbackSink;
  licenseService?: LicenseService;
  hostDependencies?: Omit<
    WebviewRouterHostDependencies,
    | "actions"
    | "getWorkspaceRoot"
    | "getNamedRoots"
    | "getTrustedRoots"
    | "serverControl"
  >;
  onPanelReady(pageLoadId: string | undefined): boolean;
  handleClearWorkflow(): Promise<void>;
  updateWorkflowName(name: string): void;
  handleDevAction?(action: any, postMessage: PostMessageFn): Promise<void>;
  sendDevStatus?(postMessage: PostMessageFn): Promise<void>;
  handleUxSnapshot?(
    payload: any,
    workspaceRoot: string,
    postMessage: PostMessageFn
  ): Promise<void>;
  getDevStatus(): Promise<
    import("../types/WebviewMessageTypes").DevStatus | undefined
  >;
  notifyActiveWorkflowChanged(workflowId: string): void;
}

/** Shared dashboard services and protocol application, independent of a view transport. */
export class DashboardApplication
  extends PostMessageDashboardSink
  implements DashboardClientEndpoint, IDashboardProvider
{
  readonly settingsSync: WebviewSettingsSync;
  readonly serializer: WorkflowSerializer;
  readonly router: WebviewMessageRouter;
  readonly secretRegistry: SecretRegistryService;
  readonly interactionPort: WebviewUserInteractionPort;
  private readonly historySearchService = new HistorySearchService();
  private workflowOrchestrator?: WorkflowOrchestrator;
  private outputHistoryManager?: OutputHistoryManager;
  private hub?: DashboardBroadcastHub;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: DashboardApplicationOptions) {
    super(options.postMessage);
    const { postMessage, licenseService } = options;
    const getOrchestrator = () => this.workflowOrchestrator;
    this.secretRegistry = new SecretRegistryService({
      secretStore: options.secretStore,
      getWorkspaceRoot: options.getSecretWorkspaceRoot,
    });
    this.interactionPort = new WebviewUserInteractionPort(
      options.interactionPostMessage ?? postMessage,
      options.isInteractionClientReady ?? options.isPanelReady
    );
    this.settingsSync = new WebviewSettingsSync(
      postMessage,
      getOrchestrator,
      options.getDevStatus,
      undefined,
      licenseService
        ? async () => {
            const entitlement = await licenseService.getEntitlement();
            return {
              isPro: await licenseService.isPro(),
              hasRemoteAccess: await licenseService.canUseRemoteAccess(),
              trialEndsAt: await licenseService.getRemoteAccessTrialEndsAt(),
              source: entitlement.source ?? null,
              expiresAt: entitlement.expiresAt,
              isEnterprise: entitlement.isEnterprise ?? false,
            };
          }
        : undefined,
      {
        getWorkspaceRoot: options.getWorkspaceRoot,
        getNamedRoots: options.getNamedRoots,
        selectWorkspacePath: options.actions.selectWorkspacePath?.bind(
          options.actions
        ),
        actions: options.actions,
        serverControl: options.serverControl,
      }
    );
    this.serializer = new WorkflowSerializer(
      postMessage,
      options.templateManager,
      getOrchestrator,
      () => this.outputHistoryManager,
      options.keyValueStore,
      {
        actions: options.actions,
        getWorkspaceRoot: options.getWorkspaceRoot,
        getNamedRoots: options.getNamedRoots,
        getTrustedRoots: options.getTrustedRoots,
      }
    );
    this.router = new WebviewMessageRouter(
      postMessage,
      this.settingsSync,
      this.serializer,
      getOrchestrator,
      this.historySearchService,
      {
        handleClearWorkflow: options.handleClearWorkflow,
        updateWorkflowName: options.updateWorkflowName,
        handleDevAction: async (action, scopedPostMessage) =>
          options.handleDevAction?.(action, scopedPostMessage),
        handleDevStatusRequest: async (scopedPostMessage) =>
          options.sendDevStatus?.(scopedPostMessage),
        handleNativeFeedback: (feedback) =>
          options.nativeFeedbackSink?.notify(feedback),
        handleUxSnapshot: async (payload, workspaceRoot, scopedPostMessage) =>
          options.handleUxSnapshot?.(payload, workspaceRoot, scopedPostMessage),
        resolveImageWebviewUri: options.resolveImageWebviewUri,
        getServerUrl: options.getServerUrl,
        getAvailableIps: options.getAvailableIps,
        getPortFallback: options.getPortFallback,
        getBindAddressFallback: options.getBindAddressFallback,
        onPanelReady: options.onPanelReady,
        handleBatchApprovalResponse: (id, result) =>
          this.interactionPort.handleResponse(id, result ?? undefined),
        handleChoiceResponse: (id, value) =>
          this.interactionPort.handleChoiceResponse(id, value),
      },
      this.secretRegistry,
      licenseService,
      {
        ...options.hostDependencies,
        actions: options.actions,
        getWorkspaceRoot: options.getWorkspaceRoot,
        getNamedRoots: options.getNamedRoots,
        getTrustedRoots: options.getTrustedRoots,
        serverControl: options.serverControl,
      }
    );
  }

  start(): void {
    this.settingsSync.discoverAgents();
    this.settingsSync.discoverSkills();
    this.disposables.push(
      onModelsLoaded(() => {
        const broadcast = this.getSettingsBroadcast();
        if (broadcast) this.settingsSync.sendModelOptionsUpdate(broadcast);
      }),
      this.options.licenseService?.onDidChangeEntitlement(() => {
        void this.settingsSync.sendLicenseAccessUpdate(
          this.hub ? (message) => this.hub!.postMessage(message) : undefined
        );
      }) ?? { dispose: () => undefined }
    );
    const sendGlobalSettingsUpdate = (): void => {
      const broadcast = this.getSettingsBroadcast();
      if (broadcast) this.settingsSync.sendGlobalSettingsUpdate(broadcast);
    };
    this.unsubscribers.push(
      configService.subscribe(sendGlobalSettingsUpdate),
      harnessAvailability.onFirstAvailableChange(sendGlobalSettingsUpdate),
      commitMessageGenerationTracker.subscribe((record) => {
        this.postMessage({
          type: MESSAGE_TYPES.COMMIT_MESSAGE_GENERATION_UPDATED,
          record,
        });
      })
    );
  }

  setHub(hub: DashboardBroadcastHub): void {
    this.hub = hub;
  }

  /**
   * Where to send a host-initiated settings refresh, or undefined when no
   * dashboard can receive it yet (INIT will carry the state instead).
   *
   * Prefers the hub so browser tabs get the refresh too — the standalone
   * server has no panel at all, and a VS Code-hosted server's tabs may be
   * connected while the panel is closed.
   */
  private getSettingsBroadcast(): PostMessageFn | undefined {
    if (this.hub) return (message) => this.hub!.postMessage(message);
    return this.options.isPanelReady() ? this.options.postMessage : undefined;
  }

  postMessage(message: unknown): void {
    this.options.postMessage(message);
  }

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId });
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });
  }

  notifyActiveWorkflowChanged(workflowId: string): void {
    this.options.notifyActiveWorkflowChanged(workflowId);
  }

  notifyCoordinationScopeUpdated(scope: CoordinationScopeSnapshot): void {
    this.postMessage({ type: MESSAGE_TYPES.COORDINATION_SCOPE_UPDATED, scope });
  }

  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
      workflowId,
      stepIndex,
      output,
    });
  }

  notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      workflowId,
      steps,
      ...(definitionRevision !== undefined ? { definitionRevision } : {}),
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
    });
  }

  notifyHarnessAvailability(
    harnessId: HarnessId,
    report: HarnessAvailabilityReport
  ): void {
    this.settingsSync.notifyHarnessAvailability(harnessId, report);
  }

  setWorkflowOrchestrator(orchestrator: WorkflowOrchestrator): void {
    this.workflowOrchestrator = orchestrator;
  }

  setOutputHistoryManager(manager: OutputHistoryManager): void {
    this.outputHistoryManager = manager;
  }

  setLanguageIntelligenceHost(host: LanguageIntelligenceHost): void {
    this.router.languageServerManager.bindHost(host);
  }

  async routeClientMessage(
    message: unknown,
    postMessage: PostMessageFn,
    clientTag?: string
  ): Promise<void> {
    await this.router.route(message, { postMessage, clientTag });
  }

  disconnectClient(clientId: string): void {
    this.router.disposeClient(clientId);
    this.workflowOrchestrator?.unregisterClient(clientId);
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) return;
    for (const session of ptyManager.releaseControllerForClient(clientId)) {
      ptyPostMessage({
        type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
        workflowId: session.workflowId,
        sessionId: session.id,
        controllerClientId: undefined,
      });
    }
  }

  requestThemeCapture(): void {
    this.options.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
  }

  disposePanelClient(): void {
    this.router.disposeClient(PANEL_CLIENT_ID);
    this.interactionPort.disposeAllPending();
  }

  dispose(): void {
    this.disposePanelClient();
    for (const disposable of this.disposables) disposable.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.router.languageServerManager.dispose();
  }
}
