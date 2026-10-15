import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionMode } from "../types/DashboardConstants";
import {
  HOST_KINDS,
  INTERACTIVE_TERMINAL_MODES,
  RUNNER_IDS,
} from "../types/DashboardConstants";
import { CliAdapter, type ResolvedCliConfig } from "./CliAdapter";
import { NodeFileWatcherFactory } from "./NodeFileWatcher";
import { FileKeyValueStore } from "./FileKeyValueStore";
import { NodeDashboardHostActions } from "./NodeDashboardHostActions";
import { OsCredentialStore } from "./OsCredentialStore";
import { FallbackSecretStore } from "./FallbackSecretStore";
import type { SecretStore } from "./SecretStore";
import { ConsoleUserFeedbackSink } from "./ConsoleUserFeedbackSink";
import { CompositeUserFeedbackSink } from "../core/CompositeUserFeedbackSink";
import { HostedWebSocketUserFeedbackSink } from "../server/HostedWebSocketUserFeedbackSink";
import { resolveServerToken, ServerTokenStore } from "./ServerTokenStore";
import { LicenseService } from "../license/LicenseService";
import { CompletionCore } from "../completions/CompletionCore";
import { RegexSymbolIndex } from "../completions/RegexSymbolIndex";
import { LspSymbolIndex } from "../completions/LspSymbolIndex";
import { FallbackSymbolIndex } from "../completions/FallbackSymbolIndex";
import type { EditorContextSource } from "../completions/EditorContextSource";
import { listCompletionFiles } from "../utils/CompletionFileDiscovery";
import { getGitTrackedFiles } from "../utils/GitUtils";
import { Log } from "../utils/Log";
import { secretRedactionService } from "../utils/SecretRedactionService";
import { configService } from "../config/CtrlYokeConfigService";
import { initializeRunHistoryLocation } from "../utils/RunHistoryStoragePolicy";
import { ProjectStateRegistry } from "../utils/ProjectStateRegistry";
import { getFrozenRunHistoryLocation } from "../utils/RunHistoryStoragePolicy";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import { DashboardApplication } from "../ui/DashboardApplication";
import { TemplateManager } from "../core/TemplateManager";
import { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import {
  createPtyDimensionsPersistence,
  initPtyProcessManager,
} from "../core/harness/PtyProcessManager";
import { CtrlYokeHostedServer } from "../server/CtrlYokeHostedServer";
import { createHostedServerOptions } from "../server/HostedServerOptionsFactory";
import { LanguageIntelligenceHost } from "../server/lsp/LanguageIntelligenceHost";
import { ManagedLanguageServerBackend } from "../server/lsp/ManagedLanguageServerBackend";
import { createLanguageServerSettingsReaders } from "../server/lsp/LanguageServerSettingsAccess";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import { LANGUAGE_SERVER_CATALOG } from "../server/lsp/LanguageServerCatalog";
import { setRuntimeMode } from "../utils/RuntimeMode";
import { initializeModelRegistry } from "../utils/ModelRegistry";

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

export interface NodeHostServices {
  cwd: string;
  hub: DashboardBroadcastHub;
  setDashboardHub(hub: DashboardBroadcastHub): void;
  platform: CliAdapter;
  fileWatcherFactory: NodeFileWatcherFactory;
  workspaceState: FileKeyValueStore;
  userFeedbackSink: CompositeUserFeedbackSink;
  dashboardHostActions: NodeDashboardHostActions;
  secretStore: SecretStore;
  tokenStore: ServerTokenStore;
  licenseService: LicenseService;
  completionCore: CompletionCore;
  regexSymbolIndex: RegexSymbolIndex;
  getCompletionFiles(): Promise<string[]>;
  disposableRegistry: {
    add(disposable: { dispose(): void }): void;
    dispose(): void;
  };
  dispose(): void;
}

/** Construct the Node equivalents of the host-owned services used by the dashboard. */
export async function createNodeHostServices(options: {
  cwd: string;
  mode: ExecutionMode;
}): Promise<NodeHostServices> {
  const cwd = path.resolve(options.cwd);
  if (!isRunHistoryInitialized()) {
    initializeRunHistoryLocation(
      configService.get("storage").runHistoryLocation
    );
  }
  await new ProjectStateRegistry().initialize(cwd);
  const disposables: Array<{ dispose(): void }> = [];
  const disposableRegistry = {
    add: (disposable: { dispose(): void }) => disposables.push(disposable),
    dispose: () => {
      for (const disposable of disposables.splice(0)) disposable.dispose();
    },
  };
  const secretStore = new FallbackSecretStore(
    new OsCredentialStore(),
    new MemorySecretStore(),
    (error) =>
      Log.warn(
        `ctrlyoke: OS credential store unavailable; server secrets will only last for this process: ${error.message}`
      )
  );
  const config: ResolvedCliConfig = {
    cwd,
    verbose: configService.get("diagnostics").verboseLogging,
    quiet: false,
    json: false,
    vars: {},
    cliExecutionMode: options.mode,
    interactiveTerminal: INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY,
  };
  const platform = new CliAdapter(config, secretStore);
  const licenseService = new LicenseService(secretStore);
  disposables.push(licenseService);
  void licenseService.refresh();
  Log.initializeCli(cwd, config.verbose);

  let hub = new DashboardBroadcastHub();
  const userFeedbackSink = new CompositeUserFeedbackSink([
    new ConsoleUserFeedbackSink(),
    new HostedWebSocketUserFeedbackSink((message) => hub.postMessage(message)),
  ]);
  const getCompletionFiles = async (): Promise<string[]> => {
    return listCompletionFiles(cwd, {
      respectGitignore: configService.get("ui").respectGitignoreForCompletions,
    });
  };
  const editorContext: EditorContextSource = {
    getSelections: () => [],
    getVisibleOutputChannels: () => [],
  };
  const regexSymbolIndex = new RegexSymbolIndex(cwd, getCompletionFiles);
  const completionCore = new CompletionCore({
    isMultiRoot: () => false,
    getFiles: getCompletionFiles,
    symbols: regexSymbolIndex,
    editorContext,
  });
  disposables.push({
    dispose: configService.subscribe(() => completionCore.clearCache()),
  });

  return {
    cwd,
    hub,
    setDashboardHub: (nextHub) => {
      hub = nextHub;
    },
    platform,
    fileWatcherFactory: new NodeFileWatcherFactory(),
    workspaceState: new FileKeyValueStore(cwd),
    userFeedbackSink,
    dashboardHostActions: new NodeDashboardHostActions(),
    secretStore,
    tokenStore: new ServerTokenStore(secretStore, cwd),
    licenseService,
    completionCore,
    regexSymbolIndex,
    getCompletionFiles,
    disposableRegistry,
    dispose: () => disposableRegistry.dispose(),
  };
}

function isRunHistoryInitialized(): boolean {
  try {
    getFrozenRunHistoryLocation();
    return true;
  } catch {
    return false;
  }
}

export interface NodeHostedServerRuntime {
  readonly services: NodeHostServices;
  readonly orchestrator: WorkflowOrchestrator;
  readonly dashboardApplication: DashboardApplication;
  readonly server: CtrlYokeHostedServer;
  readonly url: string;
  dispose(): Promise<void>;
}

const SLOW_STARTUP_PHASE_MS = 3_000;

/**
 * Logs how long one startup phase took and returns the next phase's start.
 * Startup is ~1s idle but has taken over 60s under heavy machine load; these
 * lines show which phase absorbed the time.
 */
function logStartupPhase(phase: string, startedAt: number): number {
  const now = Date.now();
  const message = `[NodeHostServices] startup phase "${phase}" took ${now - startedAt}ms`;
  if (now - startedAt >= SLOW_STARTUP_PHASE_MS) {
    Log.warn(message);
  } else {
    Log.debug(message);
  }
  return now;
}

/** Compose and start the complete dashboard server in a plain Node process. */
export async function createNodeHostedServer(options: {
  cwd: string;
  mode: ExecutionMode;
  regenerateToken?: boolean;
  strictPort?: boolean;
}): Promise<NodeHostedServerRuntime> {
  let phaseStartedAt = Date.now();
  const services = await createNodeHostServices(options);
  phaseStartedAt = logStartupPhase("host services", phaseStartedAt);
  const { cwd } = services;
  setRuntimeMode(RUNNER_IDS.SERVER);
  let hub = services.hub;
  let server: CtrlYokeHostedServer | undefined;
  const actions = services.dashboardHostActions;
  const namedRoots = [{ name: path.basename(cwd), fsPath: cwd }];
  const postMessage = (_message: unknown): void => undefined;
  const interactionPostMessage = (message: unknown): void =>
    hub.postMessage(message);
  const templateManager = new TemplateManager(
    services.platform.getExtensionPath(),
    () => cwd,
    services.platform,
    (scope) => configService.getScoped("templates", scope)?.variableDefaults
  );
  const dashboardApplication = new DashboardApplication({
    templateManager,
    postMessage,
    isPanelReady: () => false,
    interactionPostMessage,
    isInteractionClientReady: () => server?.hasConnectedClients() === true,
    resolveImageWebviewUri: () => undefined,
    getServerUrl: () => server?.getServerUrl(),
    getAvailableIps: () => server?.getAvailableIps() ?? [],
    getPortFallback: () => server?.getPortFallbackInfo() ?? undefined,
    getBindAddressFallback: () =>
      server?.getBindAddressFallbackInfo() ?? undefined,
    keyValueStore: services.workspaceState,
    secretStore: services.secretStore,
    getWorkspaceRoot: () => cwd,
    getSecretWorkspaceRoot: () => cwd,
    getNamedRoots: () => namedRoots,
    getTrustedRoots: () => [cwd],
    actions,
    licenseService: services.licenseService,
    hostDependencies: {
      fileWatcherFactory: services.fileWatcherFactory,
      completionCore: services.completionCore,
    },
    onPanelReady: () => false,
    handleClearWorkflow: async () => undefined,
    updateWorkflowName: () => undefined,
    getDevStatus: async () => undefined,
    notifyActiveWorkflowChanged: () => undefined,
  });
  // The server's CliAdapter selects the embedded-PTY terminal mode, so
  // interactive steps need this manager exactly as they do in VS Code.
  const ptyManager = initPtyProcessManager(
    (message) => hub.postMessage(message),
    createPtyDimensionsPersistence(services.workspaceState)
  );
  services.disposableRegistry.add(ptyManager);
  let orchestrator!: WorkflowOrchestrator;
  orchestrator = new WorkflowOrchestrator({
    platform: services.platform,
    dashboardHostActions: actions,
    workspaceFolderPathResolver: () => cwd,
    dashboardProvider: dashboardApplication,
    userFeedbackSink: services.userFeedbackSink,
    runnerHostIdentity: {
      runner: RUNNER_IDS.SERVER,
      hostInstanceId: randomUUID(),
      pid: process.pid,
    },
    fileWatcherFactory: services.fileWatcherFactory,
    disposableRegistry: services.disposableRegistry,
    workspaceState: services.workspaceState,
    isWorkspaceTrusted: () => true,
    userInteractionPort: dashboardApplication.interactionPort,
  });
  hub = orchestrator.getDashboardBroadcastHub();
  services.setDashboardHub(hub);
  orchestrator.routePtyMessagesToDashboard();
  dashboardApplication.setWorkflowOrchestrator(orchestrator);
  dashboardApplication.setHub(hub);
  orchestrator.getDashboardBroadcastHub().addClient(dashboardApplication);
  dashboardApplication.start();
  // Discover the dynamic model lists (Copilot, OpenCode, Qwen, Antigravity)
  // after start() subscribes to onModelsLoaded, so connected tabs get the
  // refreshed dropdowns when discovery finishes.
  initializeModelRegistry().catch((error: unknown) => {
    Log.warn(
      `[NodeHostServices] Model registry initialization failed: ${String(error)}`
    );
  });
  // There is no VS Code panel to send the READY that starts the startup
  // auto-load, and browser tabs only get STARTUP_COMPLETE once it settles.
  // Browser tabs are this host's only dashboard, so it is ready immediately.
  void orchestrator.setDashboardReady();
  void orchestrator.initialize().catch((error: unknown) => {
    Log.error(
      `[NodeHostServices] Orchestrator initialization failed: ${String(error)}`
    );
  });

  phaseStartedAt = logStartupPhase("orchestrator composition", phaseStartedAt);
  const token = await resolveServerToken(
    services.tokenStore,
    process.env.CTRLYOKE_SERVER_TOKEN,
    options.regenerateToken
  );
  phaseStartedAt = logStartupPhase("server token", phaseStartedAt);
  // Exempt the connection token from heuristic redaction while the server is
  // up, as the VS Code host does, so dashboard URLs and QR codes stay intact.
  const unprotectToken = secretRedactionService.protectValue(token);
  const languageServerSettings =
    createLanguageServerSettingsReaders(configService);
  const languageServerBackend = new ManagedLanguageServerBackend({
    workspaceRoot: cwd,
    ...languageServerSettings,
    // Approval hashes are machine/user trust decisions, never workspace data.
    approvalStore: new FileKeyValueStore(ctrlyokeStateHome()),
    interactionPort: dashboardApplication.interactionPort,
    isWorkspaceTrusted: () => orchestrator.isWorkspaceTrusted(),
  });
  const languageIntelligenceHost = new LanguageIntelligenceHost({
    backend: languageServerBackend,
    workspaceRoot: cwd,
    namedWorkspaceRoots: namedRoots,
    isWorkspaceTrusted: () => true,
  });
  const lspSymbolIndex = new LspSymbolIndex(
    cwd,
    services.getCompletionFiles,
    languageIntelligenceHost
  );
  services.completionCore.setSymbolIndex(
    new FallbackSymbolIndex(
      lspSymbolIndex,
      services.regexSymbolIndex,
      (symbol) => lspSymbolIndex.shouldUseRegexFallback(symbol)
    )
  );
  dashboardApplication.setLanguageIntelligenceHost(languageIntelligenceHost);
  server = new CtrlYokeHostedServer(
    createHostedServerOptions({
      hub: orchestrator.getDashboardBroadcastHub(),
      endpoint: dashboardApplication,
      getOrchestrator: () => orchestrator,
      workspaceRoot: cwd,
      namedWorkspaceRoots: namedRoots,
      token,
      licenseService: services.licenseService,
      getUserFeedbackSink: () => orchestrator.getUserFeedbackSink(),
      hostKind: HOST_KINDS.STANDALONE,
      fileWatcherFactory: services.fileWatcherFactory,
      languageIntelligenceHost,
      strictPort: options.strictPort,
    })
  );
  let runningUrl: string;
  try {
    const url = await server.listen();
    logStartupPhase("listen", phaseStartedAt);
    if (!url) throw new Error("The hosted server did not start.");
    runningUrl = url;
    if (configService.get("languageServers").startOnLaunch) {
      const files = await getGitTrackedFiles(cwd).catch(() => []);
      const extensions = new Set(
        files.map((file) => path.extname(file).slice(1).toLowerCase())
      );
      const detectedLanguages = [
        ...new Set(
          LANGUAGE_SERVER_CATALOG.filter((entry) =>
            entry.extensions.some((extension) =>
              extensions.has(extension.toLowerCase())
            )
          ).flatMap((entry) => entry.languages)
        ),
      ];
      void languageIntelligenceHost
        .startLanguages(detectedLanguages)
        .catch((error: unknown) => {
          Log.warn(
            "[NodeHostServices] Could not start detected language servers:",
            error
          );
        });
    }
  } catch (error) {
    unprotectToken();
    server.dispose();
    dashboardApplication.dispose();
    orchestrator.dispose();
    services.dispose();
    throw error;
  }

  return {
    services,
    orchestrator,
    dashboardApplication,
    server,
    url: runningUrl,
    dispose: async () => {
      server?.dispose();
      dashboardApplication.dispose();
      // Concurrent, as in the extension's deactivate(): Ctrl+C every AI CLI
      // session while the workflow instances flush their durable state.
      await Promise.all([
        ptyManager.gracefulShutdownAllAiCliSessions(),
        orchestrator.shutdown(),
      ]);
      await orchestrator.disposeAsync();
      services.dispose();
      unprotectToken();
    },
  };
}
