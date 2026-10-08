import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  HARNESS_INFO,
  LICENSE_UI,
  EXECUTION_STATES,
  DEFAULT_MODELS,
  PERMISSION_MODES,
  MODEL_OPTION_VALUES,
  PANEL_CLIENT_ID,
  PROMPT_PROPERTIES,
  WORKFLOW_PROPERTY_KEYS,
  STATUS_LINE_HARNESS_IDS,
  type HarnessId,
  type HarnessStatusString,
  type SettingWriteScope,
  USER_FEEDBACK_SEVERITY,
  isStatusLineHarnessId,
  type StatusLineHarnessId,
  WORKFLOW_VIEW_ADDRESS_KIND,
  HOSTED_CERT_DOWNLOAD,
  PATH_SELECTION_KINDS,
  TRUST_DECISIONS,
  getEffectiveParallelGroupWidth,
  getDashboardHostCapabilities,
  SERVER_BIND_ADDRESSES,
} from "../types/DashboardConstants";
import type {
  DashboardHostActions,
  HostedServerControl,
  NamedRoot,
} from "../core/HostPorts";
import type {
  CapabilitiesFile,
  CapabilitiesModel,
} from "../types/CapabilitiesTypes";
import {
  ConfigurationUtils,
  CONFIG_KEYS,
  CONFIG_SCOPE,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import {
  ExternalRootsTrustStore,
  externalRootsTrustStore,
  type ExternalRootTrustDecision,
} from "../config/ExternalRootsTrustStore";
import { Log } from "../utils/Log";
import { buildHarnessModelOptions } from "../utils/HarnessModelOptions";
import {
  McpServerConfig,
  ToolPermissionsOverride,
  WorktreeConfig,
} from "../types/CtrlYokeTypes";
import { readJsonFile } from "../utils/FileSystemUtils";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ServerCertificateService } from "../server/ServerCertificateService";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import { AgentDiscovery } from "../utils/AgentDiscovery";
import type { AgentInfo } from "../utils/AgentDiscovery";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import type { SkillInfo } from "../utils/SkillDiscovery";
import { configService } from "../config/CtrlYokeConfigService";
import type {
  DevStatus,
  DisableStatusLineTrackingMessage,
  LicenseAccessState,
  SetStatusLineFormatModeMessage,
  WorkflowDefinitionMutation,
} from "../types/WebviewMessageTypes";
import type { StatusLineHarnessSettings } from "../types/CtrlYokeSettings";
import { isDefaultStatusLineFormat } from "../utils/StatuslineFormat";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import { isLoopbackBindAddress } from "../utils/NetworkUtils";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  StatuslineManager,
  type StatuslineManagerLike,
} from "../core/harness/shared/StatuslineManager";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";
import type { HarnessAvailabilityReport } from "../types/WebviewMessageTypes";
import { toHarnessStatusInfo } from "../core/harness/shared/HarnessDetection";

/**
 * Harness availability status
 */
export interface HarnessStatus {
  available: boolean;
  status: HarnessStatusString;
  message?: string;
  /** Provider-owned CLI install command shown by the dashboard. */
  installHint?: string;
}

/**
 * Callback for posting messages to the webview.
 */
export type PostMessageFn = (message: any) => void;

export interface WorkflowExternalRootIdentity {
  workspaceRoot: string;
  workflowSourcePath: string;
}

type StatuslineManagerFactory = (
  harnessId: StatusLineHarnessId
) => StatuslineManagerLike;

type LicenseAccessFactory = () => Promise<LicenseAccessState>;

export interface WebviewSettingsSyncHost {
  readonly getWorkspaceRoot: () => string | undefined;
  readonly getNamedRoots: () => readonly NamedRoot[];
  readonly selectWorkspacePath?: DashboardHostActions["selectWorkspacePath"];
  readonly serverControl?: HostedServerControl;
  readonly actions?: DashboardHostActions;
}

const REMOTE_TLS_SETTING_KEYS = [
  CONFIG_KEYS.SERVER_TLS_ENABLED,
  CONFIG_KEYS.SERVER_TLS_CERT_PATH,
  CONFIG_KEYS.SERVER_TLS_KEY_PATH,
] as const;

/**
 * WebviewSettingsSync
 *
 * Manages all settings/configuration reading, building, and broadcasting
 * between the VS Code extension and the React webview.
 *
 * Responsibilities:
 * - Building and sending initial state, global settings, model options
 * - Harness status tracking and broadcasting
 * - Agent and skill discovery
 * - Settings change handlers (harness, model, agent, execution mode, etc.)
 * - Workflow property updates (pending and persisted)
 * - Config get/set handlers with security allowlist
 */
export class WebviewSettingsSync {
  // Discovered agents
  private availableAgents: AgentInfo[] = [];

  // Discovered skills
  private availableSkills: SkillInfo[] = [];

  // Harness availability status
  private harnessStatus: Record<string, HarnessStatus> = {
    [HARNESS_IDS.COPILOT_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.CLAUDE_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.CODEX_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.OPENCODE_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.QWEN_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.ANTIGRAVITY_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
  };

  // Validation constants
  private static readonly VALID_HARNESSES = [
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.CODEX_CLI,
    HARNESS_IDS.OPENCODE_CLI,
    HARNESS_IDS.QWEN_CLI,
    HARNESS_IDS.ANTIGRAVITY_CLI,
  ] as const;

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly getDevStatus?: () => Promise<DevStatus | undefined>,
    private readonly getStatuslineManager: StatuslineManagerFactory = (
      harnessId
    ) => StatuslineManager.forHarness(harnessId),
    private readonly getLicenseAccess?: LicenseAccessFactory,
    private readonly host: WebviewSettingsSyncHost = {
      getWorkspaceRoot: () => undefined,
      getNamedRoots: () => [],
    },
    private readonly certificateService = new ServerCertificateService()
  ) {}

  private licenseAccess: LicenseAccessState = {
    isPro: false,
    hasRemoteAccess: false,
    trialEndsAt: null,
  };

  private emitMessage(
    message: any,
    postMessage: PostMessageFn = this.postMessage
  ): void {
    postMessage(message);
  }

  // ============================================================================
  // Public API — Discovery
  // ============================================================================

  /**
   * Discover available agents in the workspace (called during construction).
   */
  async discoverAgents(): Promise<void> {
    try {
      this.availableAgents = await AgentDiscovery.discoverAgents(
        this.host.getWorkspaceRoot()
      );

      this.sendAgentsUpdate();
    } catch (error) {
      Log.warn("[WebviewSettingsSync] Failed to discover agents:", error);
    }
  }

  /**
   * Discover available skills in the workspace (called during construction).
   */
  async discoverSkills(): Promise<void> {
    try {
      this.availableSkills = await SkillDiscovery.discoverSkills(
        this.host.getWorkspaceRoot()
      );

      this.sendSkillsUpdate();
    } catch (error) {
      Log.warn("[WebviewSettingsSync] Failed to discover skills:", error);
    }
  }

  // ============================================================================
  // Public API — State & Broadcasts
  // ============================================================================

  /**
   * Send full initial state to one client (INIT message).
   * Called on READY and during resolveWebviewView().
   *
   * `clientId` must name the client `postMessage` reaches — the workflow half
   * of the payload is that client's own view (see `getCurrentState`).
   */
  async sendInitialState(
    postMessage: PostMessageFn = this.postMessage,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const harnessStatuses = Object.entries(this.harnessStatus)
      .map(([id, s]) => `${id}=${s.status}`)
      .join(", ");
    Log.debug(
      `[WebviewSettingsSync] sendInitialState() clientId=${clientId} — harness: [${harnessStatuses}], agents: ${this.availableAgents.length}`
    );

    const workflowState = this.getCurrentState(clientId);
    const coordinationScope =
      await this.getOrchestrator()?.getCoordinationScopeSnapshot?.(clientId);
    const globalSettings = this.buildGlobalSettings();
    const modelOptions = this.buildModelOptions();
    this.licenseAccess = await this.resolveLicenseAccess();
    const dev = await this.getDevStatus?.();

    this.emitMessage(
      {
        type: MESSAGE_TYPES.INIT,
        data: {
          ...workflowState,
          hostCapabilities: getDashboardHostCapabilities(
            this.host.actions ?? {}
          ),
          globalSettings,
          workflowProperties: {},
          modelOptions,
          harnessStatus: this.harnessStatus,
          availableAgents: this.availableAgents,
          availableSkills: this.availableSkills,
          licenseAccess: this.licenseAccess,
          ...(dev ? { dev } : {}),
          ...(coordinationScope ? { coordinationScope } : {}),
        },
      },
      postMessage
    );
    await this.sendHarnessCapabilitySnapshot(postMessage);
  }

  /**
   * Send only global settings to the webview without workflow data.
   * Used for configuration changes to avoid resetting the output panel.
   */
  sendGlobalSettingsUpdate(
    postMessage: PostMessageFn = this.postMessage
  ): void {
    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED,
        globalSettings: this.buildGlobalSettings(),
        modelOptions: this.buildModelOptions(),
        licenseAccess: this.licenseAccess,
      },
      postMessage
    );
  }

  /** Refresh the extension-owned Pro/trial state for every dashboard client. */
  async sendLicenseAccessUpdate(
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    this.licenseAccess = await this.resolveLicenseAccess();
    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED,
        globalSettings: this.buildGlobalSettings(),
        modelOptions: this.buildModelOptions(),
        licenseAccess: this.licenseAccess,
      },
      postMessage
    );
  }

  /**
   * Send updated model options to the webview (e.g. when ModelRegistry loads).
   */
  sendModelOptionsUpdate(postMessage: PostMessageFn = this.postMessage): void {
    const modelOptions = this.buildModelOptions();
    this.emitMessage(
      {
        type: MESSAGE_TYPES.MODEL_OPTIONS_UPDATE,
        data: { modelOptions },
      },
      postMessage
    );
    this.writeCapabilities(modelOptions).catch((err) =>
      Log.warn("[WebviewSettingsSync] Failed to write capabilities.json:", err)
    );
  }

  /**
   * Send harness status update to the webview.
   */
  sendHarnessStatusUpdate(postMessage: PostMessageFn = this.postMessage): void {
    this.emitMessage(
      {
        type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
        data: { harnessStatus: this.harnessStatus },
      },
      postMessage
    );
    this.writeCapabilities(this.buildModelOptions()).catch((err) =>
      Log.warn("[WebviewSettingsSync] Failed to write capabilities.json:", err)
    );
  }

  /** Publish the shared registry snapshot after a client handshake or status refresh. */
  async sendHarnessCapabilitySnapshot(
    postMessage: PostMessageFn = this.postMessage,
    refreshHarnessId?: HarnessId
  ): Promise<void> {
    const registry = this.getOrchestrator()?.getCompatibilityRegistry();
    if (!registry) {
      return;
    }

    try {
      if (refreshHarnessId) {
        await registry.refresh(refreshHarnessId);
      }
      const snapshot = await registry.getSnapshot();
      this.emitMessage(
        {
          type: MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT,
          data: { snapshot },
        },
        postMessage
      );
    } catch (error) {
      Log.warn(
        "[WebviewSettingsSync] Failed to publish harness capability snapshot:",
        error
      );
    }
  }

  /**
   * Send agents update to the webview.
   */
  sendAgentsUpdate(postMessage: PostMessageFn = this.postMessage): void {
    this.emitMessage(
      {
        type: MESSAGE_TYPES.AGENTS_UPDATE,
        data: { availableAgents: this.availableAgents },
      },
      postMessage
    );
  }

  /**
   * Send skills update to the webview.
   */
  sendSkillsUpdate(postMessage: PostMessageFn = this.postMessage): void {
    this.emitMessage(
      {
        type: MESSAGE_TYPES.SKILLS_UPDATE,
        data: { availableSkills: this.availableSkills },
      },
      postMessage
    );
  }

  /**
   * Read workflow properties from the viewed definition and send them to the
   * settings panel.
   *
   * The file must come from the client's *view address*, not from its bound
   * instance's queue state: `loadRunViewForClient` moves a client's address
   * without rebinding an executor, so after a workflow switch the bound
   * instance still points at the workflow the user just left. Reading that file
   * here republished the previous workflow's values — or, when the client had
   * no instance-owned working file at all, returned early and left the panel
   * showing global defaults for a workflow that has saved properties on disk.
   */
  async sendWorkflowPropertiesToSettings(
    postMessage: PostMessageFn = this.postMessage,
    clientId: string
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      return;
    }

    try {
      // The instance path stays as a fallback for the moments the address is
      // momentarily behind the file on disk — most visibly right after a draft
      // is promoted, when the draft file the address still names is gone.
      const candidates = [
        orchestrator.getViewFilePath(clientId),
        orchestrator.getQueueState(clientId)?.workingFilePath,
      ].filter((path): path is string => Boolean(path));
      if (candidates.length === 0) {
        return;
      }

      let workingFile: Record<string, unknown> | undefined;
      for (const candidate of candidates) {
        try {
          workingFile = await readJsonFile(candidate);
          break;
        } catch {
          // Try the next candidate; the last failure rethrows below.
        }
      }
      if (!workingFile) {
        throw new Error(
          `No readable working file for ${clientId} (tried ${candidates.join(", ")})`
        );
      }

      const workflowProperties = Object.fromEntries(
        WORKFLOW_PROPERTY_KEYS.map((key) => [key, workingFile[key]])
      );

      this.emitMessage(
        {
          type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
          workflowProperties,
        },
        postMessage
      );

      this.emitMessage(
        {
          type: MESSAGE_TYPES.WORKFLOW_LOADED,
        },
        postMessage
      );
    } catch (error) {
      Log.error(
        "[WebviewSettingsSync] Failed to send workflow properties to settings:",
        error
      );
      // Send empty properties so the panel doesn't display stale values from the
      // previous workflow (applyWorkflowChange no longer clears them proactively).
      this.emitMessage(
        {
          type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
          workflowProperties: {},
        },
        postMessage
      );
    }
  }

  /**
   * Send WORKFLOW_UNLOADED to disable settings UI.
   */
  sendWorkflowUnloadedToSettings(
    postMessage: PostMessageFn = this.postMessage
  ): void {
    this.emitMessage(
      {
        type: MESSAGE_TYPES.WORKFLOW_UNLOADED,
      },
      postMessage
    );
  }

  /**
   * Send STARTUP_COMPLETE to a specific client (targeted, not broadcast).
   * Used by the fast path in the READY handler for panel reloads and browser
   * clients that connected after the hub broadcast from triggerAutoLoad fired.
   */
  sendStartupComplete(postMessage: PostMessageFn = this.postMessage): void {
    this.emitMessage({ type: MESSAGE_TYPES.STARTUP_COMPLETE }, postMessage);
  }

  /**
   * Update a single harness availability status and push the change to the UI.
   */
  notifyHarnessAvailability(
    harnessId: HarnessId,
    report: HarnessAvailabilityReport
  ): void {
    this.harnessStatus[harnessId] = toHarnessStatusInfo(report);
    this.sendHarnessStatusUpdate();
    void this.sendHarnessCapabilitySnapshot(this.postMessage, harnessId);
  }

  // ============================================================================
  // Message Handlers — Settings Changes
  // ============================================================================

  async handleHarnessChange(harness: string): Promise<void> {
    if (!WebviewSettingsSync.VALID_HARNESSES.includes(harness as any)) {
      Log.warn(`[WebviewSettingsSync] Invalid harness: ${harness}`);
      return;
    }

    await ConfigurationUtils.setIntegrationMode(harness as HarnessId);
  }

  async handleModelChange(model: string): Promise<void> {
    const harness = ConfigurationUtils.getIntegrationMode();
    await ConfigurationUtils.setModelForHarness(harness, model);
  }

  async handleAgentChange(agent: string): Promise<void> {
    await ConfigurationUtils.setDefaultAgent(agent);
  }

  async handleResumeSessionChange(enabled: boolean): Promise<void> {
    await ConfigurationUtils.setResumeExistingSession(enabled);
  }

  async handleMcpServersChange(
    servers: (string | McpServerConfig)[]
  ): Promise<void> {
    await ConfigurationUtils.setDefaultMcpServers(servers);
  }

  handleOpenSettings(): void {
    // No-op: the Header now opens the Global Settings drawer directly via uiStore.
    // This method is kept for backward compatibility with the OPEN_SETTINGS message handler.
  }

  async handleUpdateWorkflowProperty(
    mutation: WorkflowDefinitionMutation | undefined,
    property: string,
    value: any,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string
  ): Promise<boolean> {
    return this.handleUpdateWorkflowProperties(
      mutation,
      { [property]: value },
      postMessage,
      clientId
    );
  }

  /**
   * Returns true when the write seeded a brand-new ephemeral working file for
   * the client — the one case where the caller still needs a full run-view
   * snapshot so the client learns its new lineage. Ordinary property writes
   * return false and need no snapshot replay.
   */
  async handleUpdateWorkflowProperties(
    mutation: WorkflowDefinitionMutation | undefined,
    properties: Record<string, unknown>,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string
  ): Promise<boolean> {
    if (Object.keys(properties).length === 0) {
      return false;
    }

    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      return false;
    }

    // An addressed run mutation writes straight to that run's file and needs no
    // instance-owned working file. Seeding one here would create a whole extra
    // lineage for a client whose bound instance happens to be blank — while the
    // property itself still lands on the addressed run.
    let createdWorkingFile = false;
    if (mutation?.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
      if (!orchestrator.getQueueState(clientId)?.workingFilePath) {
        await orchestrator.ensureEphemeralWorkingFile(
          { initialProperties: properties },
          clientId
        );
        createdWorkingFile = Boolean(
          orchestrator.getQueueState(clientId)?.workingFilePath
        );
      }

      if (!orchestrator.getQueueState(clientId)?.workingFilePath) {
        Log.warn(
          `[WebviewSettingsSync] handleUpdateWorkflowProperties: no workspace, cannot persist keys [${Object.keys(properties).join(", ")}]`
        );
        return false;
      }
    }

    await orchestrator.updateWorkingFileProperties(
      mutation,
      properties,
      {
        allowDeletes: Object.values(properties).some(
          (propertyValue) => propertyValue === undefined
        ),
      },
      clientId
    );

    const trustedExternalRoots =
      properties[PROMPT_PROPERTIES.TRUSTED_EXTERNAL_ROOTS];
    if (Array.isArray(trustedExternalRoots)) {
      await this.recordInteractiveWorkflowExternalRootDecision(
        clientId,
        trustedExternalRoots
      );
    }

    await this.sendWorkflowPropertiesToSettings(postMessage, clientId);
    return createdWorkingFile;
  }

  async handleSetAsDefault(
    property: string,
    value: any,
    harness?: string
  ): Promise<void> {
    if (property === PROMPT_PROPERTIES.HARNESS) {
      await ConfigurationUtils.setIntegrationMode(value as HarnessId);
    } else if (property === PROMPT_PROPERTIES.MODEL && harness) {
      await ConfigurationUtils.setModelForHarness(harness as HarnessId, value);
    } else if (property === PROMPT_PROPERTIES.ADDITIONAL_ARGS && harness) {
      await ConfigurationUtils.setAdditionalArgsForHarness(
        harness as HarnessId,
        value ?? ""
      );
    } else if (property === PROMPT_PROPERTIES.AGENT) {
      await ConfigurationUtils.setDefaultAgent(value || "");
    } else if (property === PROMPT_PROPERTIES.SKILLS) {
      await ConfigurationUtils.setDefaultSkills(value || []);
    } else if (property === PROMPT_PROPERTIES.SECRETS) {
      await ConfigurationUtils.setDefaultSecrets(value || []);
    } else if (property === PROMPT_PROPERTIES.EXECUTION_MODE) {
      await ConfigurationUtils.setCliExecutionMode(value);
    } else if (property === PROMPT_PROPERTIES.RESUME_SESSION) {
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.DEFAULTS_RESUME_SESSION,
        value
      );
    } else if (property === PROMPT_PROPERTIES.PRIOR_CONTEXT) {
      await ConfigurationUtils.setDefaultPriorContext(value ?? "none");
    } else if (property === PROMPT_PROPERTIES.MCP_SERVERS) {
      // null (None mode) → [] so we never write null to an array-typed setting
      await ConfigurationUtils.setDefaultMcpServers(value ?? []);
    } else if (property === PROMPT_PROPERTIES.HOOKS) {
      await ConfigurationUtils.setDefaultHooks(value ?? []);
    } else if (property === PROMPT_PROPERTIES.END_CONDITION) {
      await ConfigurationUtils.setDefaultEndCondition(value ?? null);
    } else if (property === PROMPT_PROPERTIES.PRE_CONDITION) {
      await ConfigurationUtils.setDefaultPreCondition(value ?? null);
    } else if (property === PROMPT_PROPERTIES.ERROR_BEHAVIOR) {
      await ConfigurationUtils.setDefaultErrorBehavior(value ?? null);
    } else if (property === PROMPT_PROPERTIES.MAX_STEPS) {
      await ConfigurationUtils.setMaxSteps(value as number);
    } else if (property === PROMPT_PROPERTIES.TOOL_PERMISSIONS) {
      const override = value as ToolPermissionsOverride | null;
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.DEFAULTS_TOOL_PERMISSIONS,
        {
          // null means "pass no permission flags", the same as mode none;
          // an object without a mode resolves to allowAll at runtime.
          mode:
            override === null
              ? PERMISSION_MODES.NONE
              : (override?.mode ?? PERMISSION_MODES.ALLOW_ALL),
          allowedTools: override?.allowedTools ?? [],
          deniedTools: override?.deniedTools ?? [],
        }
      );
    } else if (property === PROMPT_PROPERTIES.WORKTREE) {
      const authored = value as WorktreeConfig;
      await ConfigurationUtils.setDefaultWorktree(authored);
    } else {
      await ConfigurationUtils.updateSetting(property, value);
    }
  }

  async handleGetConfig(
    key: string,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (!key.startsWith(CONFIG_KEYS.EXTENSION_NAMESPACE)) {
      Log.warn(
        `[WebviewSettingsSync] Rejected config read for non-ctrlyoke key: ${key}`
      );
      return;
    }

    const relativeKey = key.slice(CONFIG_KEYS.EXTENSION_NAMESPACE.length);
    const value = configService.getNested(relativeKey);

    this.emitMessage(
      {
        type: MESSAGE_TYPES.CONFIG_VALUE,
        key,
        value,
      },
      postMessage
    );
  }

  async handleUpdateConfig(key: string, value: unknown): Promise<void> {
    if (!key.startsWith(CONFIG_KEYS.EXTENSION_NAMESPACE)) {
      Log.warn(
        `[WebviewSettingsSync] Rejected config write for non-ctrlyoke key: ${key}`
      );
      return;
    }

    const relativeKey = key.slice(CONFIG_KEYS.EXTENSION_NAMESPACE.length);
    await configService.set(relativeKey, value, CONFIG_SCOPE.USER);
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  /**
   * Write capabilities.json to the workspace .ctrlyoke/ directory.
   * Read by the MCP server (separate process) for harness/model validation.
   */
  private async writeCapabilities(
    modelOptions: Record<string, CapabilitiesModel[]>
  ): Promise<void> {
    const workspaceRoot = this.host.getWorkspaceRoot();
    if (!workspaceRoot) return;
    const capabilitiesPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.CAPABILITIES_FILE
    );

    const harnessEntries = Object.values(HARNESS_IDS).map((id) => {
      const status = this.harnessStatus[id];
      const options = modelOptions[id] ?? [];
      // Filter out the "none" sentinel value
      const models = options
        .filter((m) => m.value !== MODEL_OPTION_VALUES.NONE)
        .map((m) => ({ value: m.value, label: m.label }));
      return {
        id,
        displayName:
          (HARNESS_INFO as Record<string, { name: string }>)[id]?.name ?? id,
        available: status?.available ?? false,
        models,
      };
    });

    const capabilities: CapabilitiesFile = {
      generatedAt: Date.now(),
      harnesses: harnessEntries,
    };

    await fs.writeFile(
      capabilitiesPath,
      JSON.stringify(capabilities, null, 2),
      "utf8"
    );
  }

  /**
   * Build global settings object from the file-based config service.
   */
  buildGlobalSettings(): Record<string, unknown> {
    const harness = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForHarness(harness);
    const agent = ConfigurationUtils.getDefaultAgent();
    const skills = ConfigurationUtils.getDefaultSkills();
    const secrets = ConfigurationUtils.getDefaultSecrets();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const defaultMcpServers = ConfigurationUtils.getDefaultMcpServers();
    const respectGitignore =
      ConfigurationUtils.shouldRespectGitignoreForCompletions();

    const harnessDefaultModels = {
      [HARNESS_IDS.COPILOT_CLI]: this.getModelForHarness(
        HARNESS_IDS.COPILOT_CLI
      ),
      [HARNESS_IDS.CLAUDE_CLI]: this.getModelForHarness(HARNESS_IDS.CLAUDE_CLI),
      [HARNESS_IDS.CODEX_CLI]: this.getModelForHarness(HARNESS_IDS.CODEX_CLI),
      [HARNESS_IDS.OPENCODE_CLI]: this.getModelForHarness(
        HARNESS_IDS.OPENCODE_CLI
      ),
      [HARNESS_IDS.QWEN_CLI]: this.getModelForHarness(HARNESS_IDS.QWEN_CLI),
      [HARNESS_IDS.ANTIGRAVITY_CLI]: this.getModelForHarness(
        HARNESS_IDS.ANTIGRAVITY_CLI
      ),
    };

    const harnessDefaultAdditionalArgs = {
      [HARNESS_IDS.COPILOT_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        HARNESS_IDS.COPILOT_CLI
      ),
      [HARNESS_IDS.CLAUDE_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        HARNESS_IDS.CLAUDE_CLI
      ),
      [HARNESS_IDS.CODEX_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        HARNESS_IDS.CODEX_CLI
      ),
      [HARNESS_IDS.OPENCODE_CLI]:
        ConfigurationUtils.getAdditionalArgsForHarness(
          HARNESS_IDS.OPENCODE_CLI
        ),
      [HARNESS_IDS.QWEN_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        HARNESS_IDS.QWEN_CLI
      ),
      [HARNESS_IDS.ANTIGRAVITY_CLI]:
        ConfigurationUtils.getAdditionalArgsForHarness(
          HARNESS_IDS.ANTIGRAVITY_CLI
        ),
    };

    const workspaceRoot = this.host.getWorkspaceRoot() ?? "";

    return {
      harness,
      model,
      harnessDefaultModels,
      harnessDefaultAdditionalArgs,
      agent,
      skills,
      secrets,
      executionMode,
      resumeSession: resumeExistingSession,
      mcpServers: defaultMcpServers,
      hooks: ConfigurationUtils.getDefaultHooks(),
      defaultErrorBehavior:
        ConfigurationUtils.getDefaultErrorBehavior() ?? null,
      maxSteps: ConfigurationUtils.getGlobalMaxSteps(),
      autoFocusOutputOnExecution:
        ConfigurationUtils.shouldAutoFocusOutputOnExecution(),
      terminal: ConfigurationUtils.getTerminalSettings(),
      toolPermissions: {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      },
      respectGitignore,
      autoExpandEditorWhenTyping:
        ConfigurationUtils.shouldAutoExpandEditorWhenTyping(),
      atomicContextReferences:
        ConfigurationUtils.shouldTreatReferencesAsAtomic(),
      outputVirtualizationRowThreshold:
        ConfigurationUtils.getOutputVirtualizationRowThreshold(),
      collapsedToolOutputLineCount:
        ConfigurationUtils.getCollapsedToolOutputLineCount(),
      confirmDeleteOperations:
        ConfigurationUtils.shouldConfirmDeleteOperations(),
      confirmResetOperations: ConfigurationUtils.shouldConfirmResetOperations(),
      confirmContinuationDiscardOperations:
        ConfigurationUtils.shouldConfirmContinuationDiscardOperations(),
      hideGitIgnoredFiles: ConfigurationUtils.shouldHideGitIgnoredFiles(),
      showCostEstimates: ConfigurationUtils.shouldShowCostEstimates(),
      stepColorMode: ConfigurationUtils.getStepColorMode(),
      harnessColors: ConfigurationUtils.getHarnessColorSettings(),
      isMultiRoot: this.host.getNamedRoots().length > 1,
      priorContext: ConfigurationUtils.getPriorContext(),
      defaultEndCondition: ConfigurationUtils.getDefaultEndCondition() ?? null,
      defaultPreCondition: ConfigurationUtils.getDefaultPreCondition() ?? null,
      worktree: ConfigurationUtils.getDefaultWorktree(),
      externalFileRootsByScope: this.buildExternalFileRootsByScope(),
      worktrees: {
        root: ConfigurationUtils.getWorktreeRoot() ?? "",
      },
      workspaceRoot,
      // Mirrored so the webview can gate operational toast from panel load
      // onward; `fullGlobalSettings` only arrives once the settings drawer
      // is opened, which would leave the threshold unenforced after a reload.
      toastLevel: configService.getAll().notifications.toastLevel,
      settingSources: configService.getLeafSources(),
      runHistoryPath: this.getResolvedRunHistoryPath(),
      effectiveParallelGroupWidth: getEffectiveParallelGroupWidth(
        ConfigurationUtils.getDynamicQueueConfig().maxParallelSteps
      ),
    };
  }

  /** Return the canonical absolute `.runs` directory shown by the settings UI. */
  private getResolvedRunHistoryPath(): string | null {
    const workspaceRoot = this.host.getWorkspaceRoot();
    if (!workspaceRoot) {
      return null;
    }
    return WorkflowPaths.runsRoot(workspaceRoot);
  }

  /**
   * Get the workflow state a client is viewing (or defaults).
   *
   * Scoped to the client because INIT is a per-client message. A client with no
   * workflow of its own gets the empty state, never a substitute: browser
   * clients lose their view registration on every socket close, so reading the
   * panel's workflow here republished it to a reconnecting browser and silently
   * replaced whatever that browser was viewing. On a flaky mobile link that
   * fired on every reconnect. `handleClientReady` delivers the client's real
   * view moments later, and an empty INIT leaves its existing view untouched.
   */
  getCurrentState(clientId: string = PANEL_CLIENT_ID): any {
    const orchestrator = this.getOrchestrator();
    // The panel is exempt from the binding check: its instance is the lazily
    // created default, so an unbound panel legitimately resolves to it.
    if (
      orchestrator &&
      (clientId === PANEL_CLIENT_ID || orchestrator.hasViewedWorkflow(clientId))
    ) {
      const queueState = orchestrator.getQueueState(clientId);
      const currentFile = orchestrator.getCurrentPromptFile(clientId);
      const workflowName = queueState.workflowName;
      const promptQueue = orchestrator.getActivePromptQueue(clientId);
      const finalStep = promptQueue?.getWorkflowFile().finalStep ?? null;
      const finalStepRuntime = promptQueue?.getFinalStepRuntime();
      return {
        fileName: currentFile?.fileName || "",
        workflowName: workflowName || "",
        steps: queueState.steps || [],
        executionState: queueState.status || EXECUTION_STATES.IDLE,
        currentIndex: queueState.currentIndex || 0,
        results: queueState.results || [],
        finalStep: finalStep,
        finalStepStatus: finalStepRuntime?.status ?? null,
        finalStepLoopCount: finalStepRuntime?.loopCount ?? 0,
        finalStepPhase: finalStepRuntime?.phase ?? null,
      };
    }

    return {
      fileName: "",
      workflowName: "",
      steps: [],
      executionState: EXECUTION_STATES.IDLE,
      currentIndex: 0,
      results: [],
      finalStep: null,
      finalStepStatus: null,
      finalStepLoopCount: 0,
      finalStepPhase: null,
    };
  }

  /**
   * Build model options for all harnesses.
   */
  buildModelOptions(): Record<string, CapabilitiesModel[]> {
    return buildHarnessModelOptions();
  }

  /**
   * Get the configured model for a given harness, with fallbacks.
   */
  getModelForHarness(harness: string): string {
    return (
      ConfigurationUtils.getModelForHarness(harness as HarnessId) ||
      (DEFAULT_MODELS as Record<string, string>)[harness] ||
      DEFAULT_MODELS[HARNESS_IDS.COPILOT_CLI]
    );
  }

  // ============================================================================
  // Global Settings Drawer Handlers
  // ============================================================================

  async handleGlobalSettingsLoadRequest(
    postMessage: PostMessageFn
  ): Promise<void> {
    const allSettings = configService.getAll();
    const sources = configService.getLeafSources();
    this.licenseAccess = await this.resolveLicenseAccess();

    let certMeta: {
      generatedAt: string;
      expiresAt: string;
      sans: string[];
    } | null = null;
    const certPath = allSettings.server?.tls?.certPath;
    if (certPath && allSettings.server?.tls?.enabled) {
      try {
        const { X509Certificate } = await import("crypto");
        const certContent = await fs.readFile(certPath, "utf8");
        const x509 = new X509Certificate(certContent);
        certMeta = {
          generatedAt: new Date(x509.validFrom).toISOString(),
          expiresAt: new Date(x509.validTo).toISOString(),
          sans: x509.subjectAltName
            ? x509.subjectAltName
                .split(", ")
                .map((s) => s.replace(/^(?:DNS:|IP Address:)/, "").trim())
                .filter(Boolean)
            : [],
        };
      } catch {
        // cert file missing or unparseable — silently omit
      }
    }

    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED,
        readOnly: configService.isSettingsReadOnly(),
        settings: {
          settings: allSettings,
          sources,
          externalFileRootsByScope: this.buildExternalFileRootsByScope(),
          runHistoryPath: this.getResolvedRunHistoryPath(),
          isMultiRoot: this.host.getNamedRoots().length > 1,
          licenseAccess: this.licenseAccess,
        },
        commitMessageGeneration: commitMessageGenerationTracker.getLastRecord(),
        certMeta,
      },
      postMessage
    );
  }

  private async resolveLicenseAccess(): Promise<LicenseAccessState> {
    if (!this.getLicenseAccess) {
      // Fail closed to Free, consistent with LicenseService's own fail-open-
      // to-free contract (PRO_LICENSE_PLAN.md §1.4/§1.8): a caller that omits
      // the extension-owned LicenseService must never be granted Pro/remote
      // access by default. Tests that exercise Pro-gated behavior must inject
      // an explicit getLicenseAccess factory.
      return { isPro: false, hasRemoteAccess: false, trialEndsAt: null };
    }
    try {
      return await this.getLicenseAccess();
    } catch {
      return { isPro: false, hasRemoteAccess: false, trialEndsAt: null };
    }
  }

  private reportProUpsell(postMessage: PostMessageFn, message: string): void {
    const feedbackMessage = `ctrlyoke: ${message}`;
    notifyUserFeedback(
      this.getOrchestrator()?.getUserFeedbackSink?.(),
      USER_FEEDBACK_SEVERITY.WARNING,
      feedbackMessage,
      LICENSE_UI.PRICING_URL
    );
    this.emitMessage(
      {
        type: MESSAGE_TYPES.USER_FEEDBACK,
        id: "ctrlyoke-pro-upsell",
        severity: USER_FEEDBACK_SEVERITY.WARNING,
        message: feedbackMessage,
        detail: LICENSE_UI.PRICING_URL,
        dedupeKey: "ctrlyoke-pro-upsell",
      },
      postMessage
    );
  }

  /**
   * Disable a machine-global harness statusline and optionally restore the
   * persisted custom command. The config write happens first so a failed
   * harness-file mutation can be rolled back to the installed/enabled state.
   */
  async handleDisableStatusLineTracking(
    request: DisableStatusLineTrackingMessage,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (
      !isStatusLineHarnessId(request?.harnessId) ||
      typeof request?.restoreCustomCommand !== "boolean"
    ) {
      this.reportStatuslineFailure(
        "Unsupported statusline tracking disable request."
      );
      return;
    }

    const { harnessId, restoreCustomCommand } = request;
    const statuslineProvider = StatuslineManager.providerForHarness(harnessId);
    let manager: StatuslineManagerLike;
    let currentSettings: StatusLineHarnessSettings;
    try {
      manager = this.getStatuslineManager(harnessId);
      currentSettings = manager.getSettings();
    } catch (error) {
      this.reportStatuslineFailure(
        "Could not read statusline tracking settings.",
        error
      );
      return;
    }
    let configDisabled = false;

    try {
      await ConfigurationUtils.setStatusLineHarnessSettings(
        statuslineProvider,
        {
          ...currentSettings,
          enabled: false,
        }
      );
      configDisabled = true;
    } catch (error) {
      this.reportStatuslineFailure(
        "Could not disable statusline tracking.",
        error
      );
      return;
    }

    try {
      const workspaceRoot = this.host.getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace root is available.");
      await manager.uninstall(workspaceRoot, restoreCustomCommand);
    } catch (error) {
      let rollbackError: unknown;
      if (configDisabled) {
        try {
          await ConfigurationUtils.setStatusLineHarnessSettings(
            statuslineProvider,
            currentSettings
          );
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }

      this.reportStatuslineFailure(
        rollbackError
          ? "Could not disable statusline tracking or restore its enabled setting."
          : "Could not update the harness statusline; tracking remains enabled.",
        rollbackError ?? error
      );
      return;
    }

    try {
      await this.handleGlobalSettingsLoadRequest(postMessage);
    } catch (error) {
      this.reportStatuslineFailure(
        "Statusline tracking was disabled, but settings could not be refreshed.",
        error
      );
      return;
    }

    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTING_UPDATED,
        path: `${CONFIG_KEYS.STATUS_LINE}.byHarness.${statuslineProvider}`,
        value: {
          ...currentSettings,
          enabled: false,
        },
        source: CONFIG_SCOPE.USER,
      },
      postMessage
    );
  }

  /** Set shared/per-harness statusline format mode and seed untouched formats when enabling per-harness mode. */
  async handleSetStatusLineFormatMode(
    request: SetStatusLineFormatModeMessage,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (typeof request?.useDifferentFormatPerHarness !== "boolean") {
      this.reportStatuslineFailure(
        "Unsupported statusline format mode request."
      );
      return;
    }

    let wasUsingDifferentFormatPerHarness: boolean;
    try {
      wasUsingDifferentFormatPerHarness =
        ConfigurationUtils.isUseDifferentFormatPerHarness();
    } catch (error) {
      this.reportStatuslineFailure(
        "Could not read statusline format mode.",
        error
      );
      return;
    }

    try {
      await ConfigurationUtils.setUseDifferentFormatPerHarness(
        request.useDifferentFormatPerHarness
      );
    } catch (error) {
      this.reportStatuslineFailure(
        "Could not update statusline format mode.",
        error
      );
      return;
    }

    if (
      request.useDifferentFormatPerHarness &&
      !wasUsingDifferentFormatPerHarness
    ) {
      try {
        const sharedFormat = ConfigurationUtils.getSharedStatusLineFormat();
        for (const provider of Object.values(STATUS_LINE_HARNESS_IDS)) {
          const currentSettings =
            ConfigurationUtils.getStatusLineHarnessSettings(provider);
          if (!isDefaultStatusLineFormat(currentSettings.format)) {
            continue;
          }

          await ConfigurationUtils.setStatusLineHarnessSettings(provider, {
            ...currentSettings,
            format: sharedFormat.map((segment) => ({
              ...segment,
            })),
          });
        }
      } catch (error) {
        this.reportStatuslineFailure(
          "Statusline format mode was enabled, but default formats could not be seeded.",
          error
        );
      }
    }

    try {
      await this.handleGlobalSettingsLoadRequest(postMessage);
    } catch (error) {
      this.reportStatuslineFailure(
        "Statusline format mode was updated, but settings could not be refreshed.",
        error
      );
    }
  }

  private reportStatuslineFailure(message: string, error?: unknown): void {
    const detail = error ? getErrorMessage(error) : undefined;
    const orchestrator = this.getOrchestrator();
    const feedbackSink: UserFeedbackSink | undefined =
      orchestrator?.getUserFeedbackSink?.();
    notifyUserFeedback(
      feedbackSink,
      USER_FEEDBACK_SEVERITY.ERROR,
      message,
      detail
    );
    Log.error(`[WebviewSettingsSync] ${message}`, detail ?? "");
  }

  async handleUpdateGlobalSetting(
    path: string,
    value: unknown,
    scope: SettingWriteScope,
    postMessage: PostMessageFn
  ): Promise<void> {
    const licenseAccess = await this.resolveLicenseAccess();
    const isRemoteAccessSetting = REMOTE_TLS_SETTING_KEYS.includes(
      path as (typeof REMOTE_TLS_SETTING_KEYS)[number]
    );
    const isBindAddressSetting = path === CONFIG_KEYS.SERVER_BIND_ADDRESS;
    const isRemoteAccessWrite =
      isRemoteAccessSetting ||
      (isBindAddressSetting &&
        (typeof value !== "string" || !isLoopbackBindAddress(value)));
    if (
      (isRemoteAccessWrite && !licenseAccess.hasRemoteAccess) ||
      ((path === CONFIG_KEYS.SERVER_ICON_BG_COLOR ||
        path === CONFIG_KEYS.SERVER_ICON_FG_COLOR) &&
        !licenseAccess.isPro)
    ) {
      this.reportProUpsell(
        postMessage,
        isRemoteAccessWrite
          ? LICENSE_UI.REMOTE_ACCESS_UPSELL
          : LICENSE_UI.CUSTOM_ICON_UPSELL
      );
      return;
    }
    const currentWorkspaceRoots =
      path === CONFIG_KEYS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS &&
      scope === CONFIG_SCOPE.WORKSPACE
        ? ConfigurationUtils.getTrustedExternalRootsByScope().workspace
        : [];
    await configService.set(path, value, scope);
    if (
      path === CONFIG_KEYS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS &&
      scope === CONFIG_SCOPE.WORKSPACE &&
      Array.isArray(value)
    ) {
      const currentCanonicalRoots = new Set(
        currentWorkspaceRoots.map((root) =>
          ExternalRootsTrustStore.canonicalizeRoot(root)
        )
      );
      const addedRoots = value.filter(
        (root): root is string =>
          typeof root === "string" &&
          root.trim().length > 0 &&
          !currentCanonicalRoots.has(
            ExternalRootsTrustStore.canonicalizeRoot(root)
          )
      );
      await this.recordInteractiveExternalRootDecision(
        scope,
        addedRoots,
        TRUST_DECISIONS.ALLOW
      );
    }
    await this.handleGlobalSettingsLoadRequest(postMessage);
    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTING_UPDATED,
        path,
        value,
        source: scope,
      },
      postMessage
    );
  }

  async handleUpdateExternalRootDecision(
    scope: SettingWriteScope,
    root: string,
    decision: ExternalRootTrustDecision,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (scope !== CONFIG_SCOPE.WORKSPACE) {
      return;
    }
    if (!root.trim()) {
      throw new Error("External root path cannot be empty.");
    }
    if (
      decision !== TRUST_DECISIONS.ALLOW &&
      decision !== TRUST_DECISIONS.DENY
    ) {
      throw new Error(`Unsupported external root decision: ${decision}`);
    }
    await this.recordInteractiveExternalRootDecision(scope, [root], decision);
    await this.handleGlobalSettingsLoadRequest(postMessage);
  }

  /**
   * Handle BROWSE_AND_ADD_EXTERNAL_ROOT: open a native folder picker and, if
   * the user selects a folder, append it to either
   * `permissions.trustedExternalRoots` or the active workflow's
   * `trustedExternalRoots` (deduping). No-op on cancel. See
   * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
   */
  async handleBrowseAndAddExternalRoot(
    scope: SettingWriteScope,
    postMessage: PostMessageFn = this.postMessage,
    workflowIdentity?: WorkflowExternalRootIdentity,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const newRoot = await this.host.selectWorkspacePath?.({
      kind: PATH_SELECTION_KINDS.FOLDER,
      title: "Select External File Root",
    });
    if (!newRoot) {
      return;
    }
    if (workflowIdentity) {
      const orchestrator = this.getOrchestrator();
      const workflow = orchestrator
        ?.getActivePromptQueue(clientId)
        ?.getWorkflowFile();
      if (!orchestrator || !workflow) {
        throw new Error(
          "Cannot add a trusted external root without an active workflow."
        );
      }

      const currentRoots =
        workflow.trustedExternalRoots === undefined
          ? ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
              ExternalRootsTrustStore.canonicalizeRoot(
                workflowIdentity.workspaceRoot
              )
            )
          : (workflow.trustedExternalRoots ?? []);
      const canonicalNewRoot =
        ExternalRootsTrustStore.canonicalizeRoot(newRoot);
      if (
        currentRoots.some(
          (root) =>
            ExternalRootsTrustStore.canonicalizeRoot(root) === canonicalNewRoot
        )
      ) {
        return;
      }

      const nextRoots = [...currentRoots, newRoot];
      await orchestrator.updateWorkflowTrustedExternalRootsForClient(
        clientId,
        nextRoots
      );
      await externalRootsTrustStore.setDecisions(
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          workflowIdentity.workspaceRoot,
          workflowIdentity.workflowSourcePath
        ),
        [newRoot],
        TRUST_DECISIONS.ALLOW
      );
      await this.sendWorkflowPropertiesToSettings(postMessage, clientId);
      return;
    }

    const { user, workspace } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    const current = scope === CONFIG_SCOPE.WORKSPACE ? workspace : user;
    const canonicalNewRoot = ExternalRootsTrustStore.canonicalizeRoot(newRoot);
    if (
      current.some(
        (root) =>
          ExternalRootsTrustStore.canonicalizeRoot(root) === canonicalNewRoot
      )
    ) {
      return;
    }

    await configService.set(
      CONFIG_KEYS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS,
      [...current, newRoot],
      scope
    );
    await this.recordInteractiveExternalRootDecision(
      scope,
      [newRoot],
      TRUST_DECISIONS.ALLOW
    );
    await this.handleGlobalSettingsLoadRequest(postMessage);
  }

  private async recordInteractiveWorkflowExternalRootDecision(
    clientId: string,
    roots: readonly string[]
  ): Promise<void> {
    if (roots.length === 0) {
      return;
    }
    const workspaceRoot = this.host.getWorkspaceRoot();
    const orchestrator = this.getOrchestrator();
    const workflowSourcePath =
      orchestrator &&
      typeof orchestrator.getViewSourceDefinitionPath === "function"
        ? await orchestrator.getViewSourceDefinitionPath(clientId)
        : undefined;
    if (!workspaceRoot || !workflowSourcePath) {
      Log.debug(
        `[WebviewSettingsSync] Unable to record workflow external-root decisions for ${clientId}: workflow identity unavailable`
      );
      return;
    }
    await externalRootsTrustStore.setDecisions(
      ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
        workspaceRoot,
        workflowSourcePath
      ),
      roots,
      TRUST_DECISIONS.ALLOW
    );
  }

  private async recordInteractiveExternalRootDecision(
    scope: SettingWriteScope,
    roots: readonly string[],
    decision: ExternalRootTrustDecision
  ): Promise<void> {
    if (
      scope !== CONFIG_SCOPE.WORKSPACE ||
      roots.length === 0 ||
      !this.host.getWorkspaceRoot()
    ) {
      return;
    }
    await externalRootsTrustStore.setDecisions(
      ExternalRootsTrustStore.canonicalizeRoot(this.host.getWorkspaceRoot()!),
      roots,
      decision
    );
  }

  private buildExternalFileRootsByScope() {
    const { user, workspace } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    const workspaceRoot = this.host.getWorkspaceRoot();
    const workspaceIdentity = workspaceRoot
      ? ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
      : undefined;

    return {
      user,
      workspace: workspace.map((root) => {
        const decision = workspaceIdentity
          ? externalRootsTrustStore.getDecision(workspaceIdentity, root)
          : undefined;
        return decision ? { path: root, decision } : { path: root };
      }),
    };
  }

  async handleEnableServer(_postMessage: PostMessageFn): Promise<void> {
    await this.host.serverControl?.enable?.();
  }

  async handleDisableServer(_postMessage: PostMessageFn): Promise<void> {
    await this.host.serverControl?.disable?.();
  }

  async handleRegenerateServerToken(
    _postMessage: PostMessageFn
  ): Promise<void> {
    await this.host.serverControl?.regenerateToken?.();
  }

  async handleGenerateServerCert(
    postMessage: PostMessageFn,
    scope: SettingWriteScope,
    homedirFn: () => string = os.homedir
  ): Promise<void> {
    if (!(await this.resolveLicenseAccess()).hasRemoteAccess) {
      this.reportProUpsell(postMessage, LICENSE_UI.REMOTE_ACCESS_UPSELL);
      return;
    }
    const baseDir =
      scope === CONFIG_SCOPE.USER ? homedirFn() : this.host.getWorkspaceRoot();
    if (!baseDir)
      throw new Error(
        "No workspace root is available for certificate generation."
      );
    const certsDir = path.join(
      baseDir,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.CERTS_DIR
    );
    const bindAddress =
      configService.get(CONFIG_KEYS.SERVER)?.bindAddress ?? "127.0.0.1";
    const certificate = await this.certificateService.generate(
      certsDir,
      bindAddress === SERVER_BIND_ADDRESSES.ALL_INTERFACES
    );

    await configService.set(
      CONFIG_KEYS.SERVER_TLS_CERT_PATH,
      certificate.certPath,
      scope
    );
    await configService.set(
      CONFIG_KEYS.SERVER_TLS_KEY_PATH,
      certificate.keyPath,
      scope
    );
    await this.handleGlobalSettingsLoadRequest(postMessage);

    this.emitMessage(
      {
        type: MESSAGE_TYPES.SERVER_CERT_GENERATED,
        generatedAt: certificate.generatedAt.toISOString(),
        expiresAt: certificate.expiresAt.toISOString(),
        sans: certificate.sans,
      },
      postMessage
    );
  }

  /**
   * Save the configured TLS cert to disk via a native VS Code Save dialog.
   * Panel-only: the webview has no way to drive an HTTP download through the
   * VS Code webview host, so the extension reads the cert straight off disk
   * instead of routing through the hosted server's `/cert` endpoint.
   */
  async handleDownloadServerCert(postMessage: PostMessageFn): Promise<void> {
    const certPath = configService.get(CONFIG_KEYS.SERVER)?.tls?.certPath;
    if (!certPath) {
      this.emitMessage(
        {
          type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED,
          saved: false,
          error: "No TLS certificate is configured yet. Generate one first.",
        },
        postMessage
      );
      return;
    }

    try {
      const certBytes = await fs.readFile(certPath);
      const selectedPath = await this.host.selectWorkspacePath?.({
        kind: PATH_SELECTION_KINDS.SAVE,
        defaultPath: HOSTED_CERT_DOWNLOAD.FILENAME,
        filters: {
          "Certificate Files": ["cer", "crt", "pem"],
          "All Files": ["*"],
        },
      });
      // Browser clients download from the hosted server's /cert endpoint.
      if (!this.host.selectWorkspacePath) return;
      if (!selectedPath) {
        this.emitMessage(
          { type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED, saved: false },
          postMessage
        );
        return;
      }

      await fs.writeFile(selectedPath, certBytes);
      this.emitMessage(
        { type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED, saved: true },
        postMessage
      );
    } catch (error) {
      Log.error(
        "[WebviewSettingsSync] Failed to save server certificate:",
        error
      );
      this.emitMessage(
        {
          type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED,
          saved: false,
          error: `Failed to save certificate: ${getErrorMessage(error)}`,
        },
        postMessage
      );
    }
  }
}
