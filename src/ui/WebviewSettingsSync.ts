import * as vscode from "vscode";
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
  VSCODE_COMMANDS,
  PROMPT_PROPERTIES,
  WORKFLOW_PROPERTY_KEYS,
  WORKTREE_MODES,
  STATUS_LINE_TRACKING_PROVIDERS,
  type HarnessId,
  type HarnessStatusString,
  type SettingWriteScope,
  USER_FEEDBACK_SEVERITY,
  isStatusLineTrackingHarnessId,
  type StatusLineTrackingHarnessId,
  WORKFLOW_VIEW_ADDRESS_KIND,
  NETWORK_INTERFACE_FAMILIES,
  TRUST_DECISIONS,
} from "../types/DashboardConstants";
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
import {
  getCliSupportedModelIdsSync,
  getOpenCodeModelIdsSync,
  getQwenModelIdsSync,
  getAntigravityModelIdsSync,
  getAntigravityModelLabelSync,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
  ANTIGRAVITY_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import {
  McpServerConfig,
  ToolPermissionsOverride,
  WorktreeConfig,
  WorktreeDefaultConfig,
} from "../types/CtrlYokeTypes";
import { readJsonFile } from "../utils/FileSystemUtils";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeWorkspaceFolder,
  isMultiRootWorkspace,
} from "../platform/VsCodeWorkspaceRoot";
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
import type { StatusLineTrackingSettings } from "../types/CtrlYokeSettings";
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

type StatuslineManagerFactory = (
  harnessId: StatusLineTrackingHarnessId
) => StatuslineManagerLike;

type LicenseAccessFactory = () => Promise<LicenseAccessState>;

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
    private readonly getLicenseAccess?: LicenseAccessFactory
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
        getVsCodeWorkspaceFolder()?.uri.fsPath
      );

      this.sendAgentsUpdate();
    } catch (error) {
      Log.warn("Failed to discover agents:", error);
    }
  }

  /**
   * Discover available skills in the workspace (called during construction).
   */
  async discoverSkills(): Promise<void> {
    try {
      this.availableSkills = await SkillDiscovery.discoverSkills(
        getVsCodeWorkspaceFolder()?.uri.fsPath
      );

      this.sendSkillsUpdate();
    } catch (error) {
      Log.warn("Failed to discover skills:", error);
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
      `sendInitialState() clientId=${clientId} — harness: [${harnessStatuses}], agents: ${this.availableAgents.length}`
    );

    const workflowState = this.getCurrentState(clientId);
    const globalSettings = this.buildGlobalSettings();
    const modelOptions = this.buildModelOptions();
    this.licenseAccess = await this.resolveLicenseAccess();
    const dev = await this.getDevStatus?.();

    this.emitMessage(
      {
        type: MESSAGE_TYPES.INIT,
        data: {
          ...workflowState,
          globalSettings,
          workflowProperties: {},
          modelOptions,
          harnessStatus: this.harnessStatus,
          availableAgents: this.availableAgents,
          availableSkills: this.availableSkills,
          licenseAccess: this.licenseAccess,
          ...(dev ? { dev } : {}),
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
      Log.warn("Failed to write capabilities.json:", err)
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
      Log.warn("Failed to write capabilities.json:", err)
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
      Log.warn("Failed to publish harness capability snapshot:", error);
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
      Log.error("Failed to send workflow properties to settings:", error);
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
   * Return the current harness status map (for in-process callers).
   */
  getHarnessStatus(): Record<string, HarnessStatus> {
    return this.harnessStatus;
  }

  /**
   * Update a single harness availability status and push the change to the UI.
   */
  notifyHarnessAvailability(
    harnessId: HarnessId,
    available: boolean,
    installHint: string
  ): void {
    this.harnessStatus[harnessId] = {
      available,
      status: available
        ? HARNESS_STATUS_STRINGS.AVAILABLE
        : HARNESS_STATUS_STRINGS.UNAVAILABLE,
      installHint,
    };
    this.sendHarnessStatusUpdate();
    void this.sendHarnessCapabilitySnapshot(this.postMessage, harnessId);
  }

  // ============================================================================
  // Message Handlers — Settings Changes
  // ============================================================================

  async handleHarnessChange(harness: string): Promise<void> {
    if (!WebviewSettingsSync.VALID_HARNESSES.includes(harness as any)) {
      Log.warn(`Invalid harness: ${harness}`);
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
          `handleUpdateWorkflowProperties: no workspace, cannot persist keys [${Object.keys(properties).join(", ")}]`
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
    } else if (property === PROMPT_PROPERTIES.TOOL_PERMISSIONS) {
      const override = value as ToolPermissionsOverride | null;
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.DEFAULTS_TOOL_PERMISSIONS,
        {
          mode:
            override?.mode && override.mode !== PERMISSION_MODES.NONE
              ? override.mode
              : PERMISSION_MODES.ALLOW_ALL,
          allowedTools: override?.allowedTools ?? [],
          deniedTools: override?.deniedTools ?? [],
        }
      );
    } else if (property === PROMPT_PROPERTIES.WORKTREE) {
      const authored = value as WorktreeConfig;
      const defaultValue: WorktreeDefaultConfig =
        authored === false
          ? { mode: WORKTREE_MODES.NONE }
          : authored === true
            ? { mode: WORKTREE_MODES.MANAGED }
            : typeof authored === "string"
              ? { mode: WORKTREE_MODES.NAMED, branch: authored }
              : authored;
      await ConfigurationUtils.setDefaultWorktree(defaultValue);
    } else {
      await ConfigurationUtils.updateSetting(property, value);
    }
  }

  async handleGetConfig(
    key: string,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (!key.startsWith(CONFIG_KEYS.EXTENSION_NAMESPACE)) {
      Log.warn(`Rejected config read for non-ctrlyoke key: ${key}`);
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
      Log.warn(`Rejected config write for non-ctrlyoke key: ${key}`);
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
    modelOptions: Record<string, Array<{ value: string; label: string }>>
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const workspaceRoot = getVsCodeWorkspaceRoot();
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

    const capabilities = {
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : "";

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
      hideCost: ConfigurationUtils.shouldHideCost(),
      isMultiRoot: isMultiRootWorkspace(),
      priorContext: ConfigurationUtils.getPriorContext(),
      defaultEndCondition: ConfigurationUtils.getDefaultEndCondition() ?? null,
      defaultPreCondition: ConfigurationUtils.getDefaultPreCondition() ?? null,
      worktree: ConfigurationUtils.getDefaultWorktree(),
      worktrees: {
        root: ConfigurationUtils.getWorktreeRoot() ?? "",
      },
      workspaceRoot,
      settingSources: configService.getLeafSources(),
      runHistoryPath: this.getResolvedRunHistoryPath(),
    };
  }

  /** Return the canonical absolute `.runs` directory shown by the settings UI. */
  private getResolvedRunHistoryPath(): string | null {
    if (!vscode.workspace.workspaceFolders?.length) {
      return null;
    }
    return WorkflowPaths.runsRoot(getVsCodeWorkspaceRoot());
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
  buildModelOptions(): Record<string, Array<{ value: string; label: string }>> {
    const cliModelIds = getCliSupportedModelIdsSync();
    const hiddenModels = new Set(["copilot-fast"]);

    const noneOption = { value: MODEL_OPTION_VALUES.NONE, label: "None" };

    const copilotCliOptions = [
      noneOption,
      ...cliModelIds
        .filter((id) => !hiddenModels.has(id))
        .map((id) => ({
          value: id,
          label: getModelDisplayName(id),
        })),
    ];

    const claudeCliOptions = [
      noneOption,
      ...Object.entries(CLAUDE_CLI_MODEL_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    ];

    const codexCliOptions = [
      noneOption,
      ...Object.entries(CODEX_CLI_MODEL_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    ];

    const openCodeCliOptions = [
      noneOption,
      ...getOpenCodeModelIdsSync().map((id) => ({
        value: id,
        label: id,
      })),
    ];

    const qwenCliOptions = [
      noneOption,
      ...getQwenModelIdsSync().map((id) => ({
        value: id,
        label: id,
      })),
    ];

    const antigravityCliOptions = [
      noneOption,
      ...getAntigravityModelIdsSync().map((id) => ({
        value: id,
        label:
          getAntigravityModelLabelSync(id) ??
          ANTIGRAVITY_CLI_MODEL_LABELS[id] ??
          id,
      })),
    ];

    return {
      [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
      [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
      [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
      [HARNESS_IDS.OPENCODE_CLI]: openCodeCliOptions,
      [HARNESS_IDS.QWEN_CLI]: qwenCliOptions,
      [HARNESS_IDS.ANTIGRAVITY_CLI]: antigravityCliOptions,
    };
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
        settings: {
          settings: allSettings,
          sources,
          externalFileRootsByScope: this.buildExternalFileRootsByScope(),
          runHistoryPath: this.getResolvedRunHistoryPath(),
          isMultiRoot: isMultiRootWorkspace(),
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
      !isStatusLineTrackingHarnessId(request?.harnessId) ||
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
    let currentSettings: StatusLineTrackingSettings;
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
      await ConfigurationUtils.setStatusLineTrackingSettings(
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
      await manager.uninstall(getVsCodeWorkspaceRoot(), restoreCustomCommand);
    } catch (error) {
      let rollbackError: unknown;
      if (configDisabled) {
        try {
          await ConfigurationUtils.setStatusLineTrackingSettings(
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
        path: `${CONFIG_KEYS.PERMISSIONS_STATUS_LINE_TRACKING}.${statuslineProvider}`,
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
        for (const provider of Object.values(STATUS_LINE_TRACKING_PROVIDERS)) {
          const currentSettings =
            ConfigurationUtils.getStatusLineTrackingSettings(provider);
          if (!isDefaultStatusLineFormat(currentSettings.format)) {
            continue;
          }

          await ConfigurationUtils.setStatusLineTrackingSettings(provider, {
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
    Log.error(message, detail ?? "");
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
      path === CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS &&
      scope === CONFIG_SCOPE.WORKSPACE
        ? ConfigurationUtils.getAllowedExternalFileRootsByScope().workspace
        : [];
    await configService.set(path, value, scope);
    if (
      path === CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS &&
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
   * the user selects a folder, append it to `permissions.allowedExternalFileRoots`
   * for the given scope (deduping). No-op on cancel. See
   * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
   */
  async handleBrowseAndAddExternalRoot(
    scope: SettingWriteScope,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: true,
      canSelectFiles: false,
      title: "Select External File Root",
    });
    if (!uris || uris.length === 0) {
      return;
    }

    const newRoot = uris[0].fsPath;
    const { user, workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
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
      CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS,
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

  private async recordInteractiveExternalRootDecision(
    scope: SettingWriteScope,
    roots: readonly string[],
    decision: ExternalRootTrustDecision
  ): Promise<void> {
    if (
      scope !== CONFIG_SCOPE.WORKSPACE ||
      roots.length === 0 ||
      !vscode.workspace.workspaceFolders?.length
    ) {
      return;
    }
    await externalRootsTrustStore.setDecisions(
      ExternalRootsTrustStore.canonicalizeRoot(getVsCodeWorkspaceRoot()),
      roots,
      decision
    );
  }

  private buildExternalFileRootsByScope() {
    const { user, workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    const workspaceIdentity = vscode.workspace.workspaceFolders?.length
      ? ExternalRootsTrustStore.canonicalizeRoot(getVsCodeWorkspaceRoot())
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
    await vscode.commands.executeCommand(VSCODE_COMMANDS.ENABLE_SERVER);
  }

  async handleDisableServer(_postMessage: PostMessageFn): Promise<void> {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.DISABLE_SERVER);
  }

  async handleRegenerateServerToken(
    _postMessage: PostMessageFn
  ): Promise<void> {
    await vscode.commands.executeCommand(
      VSCODE_COMMANDS.REGENERATE_SERVER_TOKEN
    );
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
      scope === CONFIG_SCOPE.USER ? homedirFn() : getVsCodeWorkspaceRoot();
    const certsDir = path.join(
      baseDir,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.CERTS_DIR
    );
    await fs.mkdir(certsDir, { recursive: true });

    const bindAddress =
      configService.get(CONFIG_KEYS.SERVER)?.bindAddress ?? "127.0.0.1";
    const lanIps: string[] =
      bindAddress === "0.0.0.0"
        ? Object.values(os.networkInterfaces())
            .flat()
            .filter(
              (iface): iface is os.NetworkInterfaceInfo =>
                !!iface &&
                iface.family === NETWORK_INTERFACE_FAMILIES.IPV4 &&
                !iface.internal
            )
            .map((iface) => iface.address)
        : [];

    const { generate } = await import("selfsigned");
    const notBeforeDate = new Date();
    const notAfterDate = new Date(notBeforeDate);
    notAfterDate.setDate(notAfterDate.getDate() + 365);

    const pems = await generate(
      [{ name: "commonName", value: "ctrlyoke Local CA" }],
      {
        notBeforeDate,
        notAfterDate,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          // Must be CA:TRUE for iOS to show this cert under
          // Settings > General > About > Certificate Trust Settings.
          // Without this extension iOS treats it as a leaf cert and
          // never offers the "Enable Full Trust" toggle.
          { name: "basicConstraints", cA: true, critical: true },
          {
            name: "keyUsage",
            keyCertSign: true,
            digitalSignature: true,
            nonRepudiation: true,
            keyEncipherment: true,
            dataEncipherment: true,
            critical: true,
          },
          { name: "extKeyUsage", serverAuth: true },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
              ...lanIps.map((ip) => ({ type: 7 as const, ip })),
            ],
          },
        ],
      }
    );

    const certPath = path.join(certsDir, "cert.pem");
    const keyPath = path.join(certsDir, "key.pem");
    await fs.writeFile(certPath, pems.cert, "utf8");
    await fs.writeFile(keyPath, pems.private, "utf8");

    await configService.set(CONFIG_KEYS.SERVER_TLS_CERT_PATH, certPath, scope);
    await configService.set(CONFIG_KEYS.SERVER_TLS_KEY_PATH, keyPath, scope);
    await this.handleGlobalSettingsLoadRequest(postMessage);

    this.emitMessage(
      {
        type: MESSAGE_TYPES.SERVER_CERT_GENERATED,
        generatedAt: notBeforeDate.toISOString(),
        expiresAt: notAfterDate.toISOString(),
        sans: ["localhost", "127.0.0.1", ...lanIps],
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
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("ctrlyoke.cer"),
        filters: {
          "Certificate Files": ["cer", "crt", "pem"],
          "All Files": ["*"],
        },
      });
      if (!uri) {
        this.emitMessage(
          { type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED, saved: false },
          postMessage
        );
        return;
      }

      await fs.writeFile(uri.fsPath, certBytes);
      this.emitMessage(
        { type: MESSAGE_TYPES.SERVER_CERT_DOWNLOADED, saved: true },
        postMessage
      );
    } catch (error) {
      Log.error("Failed to save server certificate:", error);
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
