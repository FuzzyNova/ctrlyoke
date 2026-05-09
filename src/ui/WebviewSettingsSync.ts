import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  HARNESS_INFO,
  EXECUTION_STATES,
  EXECUTION_MODES,
  DEFAULT_MODELS,
  PERMISSION_MODES,
  MODEL_OPTION_VALUES,
  PANEL_CLIENT_ID,
  VSCODE_COMMANDS,
  PROMPT_PROPERTIES,
  type HarnessId,
  type HarnessStatusString,
  type SettingWriteScope,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  CONFIG_KEYS,
  CONFIG_SCOPE,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
  getOpenCodeModelIdsSync,
  getQwenModelIdsSync,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
  GEMINI_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import {
  McpServerConfig,
  ToolPermissionsOverride,
} from "../types/FlightPathTypes";
import { readJsonFile } from "../utils/FileSystemUtils";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import { AgentDiscovery } from "../utils/AgentDiscovery";
import type { AgentInfo } from "../utils/AgentDiscovery";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import type { SkillInfo } from "../utils/SkillDiscovery";
import { configService } from "../config/FlightPathConfigService";
import type { DevStatus } from "../types/WebviewMessageTypes";

/**
 * Harness availability status
 */
export interface HarnessStatus {
  available: boolean;
  status: HarnessStatusString;
  message?: string;
}

/**
 * Callback for posting messages to the webview.
 */
export type PostMessageFn = (message: any) => void;

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
    [HARNESS_IDS.COPILOT_CHAT]: {
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
    [HARNESS_IDS.GEMINI_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
  };

  // Validation constants
  private static readonly VALID_HARNESSES = [
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.COPILOT_CHAT,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.CODEX_CLI,
    HARNESS_IDS.OPENCODE_CLI,
    HARNESS_IDS.QWEN_CLI,
    HARNESS_IDS.GEMINI_CLI,
  ] as const;

  private static readonly VALID_EXECUTION_MODES = [
    EXECUTION_MODES.INTERACTIVE,
    EXECUTION_MODES.HEADLESS,
  ] as const;

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly getDevStatus?: () => Promise<DevStatus | undefined>
  ) {}

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
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
      }

      this.availableAgents = await AgentDiscovery.discoverAgents(
        workspaceFolders[0]
      );

      this.sendAgentsUpdate();
    } catch (error) {
      Log.error("Failed to discover agents:", error);
    }
  }

  /**
   * Discover available skills in the workspace (called during construction).
   */
  async discoverSkills(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceFolder =
        workspaceFolders && workspaceFolders.length > 0
          ? workspaceFolders[0]
          : undefined;

      this.availableSkills =
        await SkillDiscovery.discoverSkills(workspaceFolder);

      this.sendSkillsUpdate();
    } catch (error) {
      Log.error("Failed to discover skills:", error);
    }
  }

  // ============================================================================
  // Public API — State & Broadcasts
  // ============================================================================

  /**
   * Send full initial state to the webview (INIT message).
   * Called on READY and during resolveWebviewView().
   */
  async sendInitialState(
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    const harnessStatuses = Object.entries(this.harnessStatus)
      .map(([id, s]) => `${id}=${s.status}`)
      .join(", ");
    Log.debug(
      `sendInitialState() — harness: [${harnessStatuses}], agents: ${this.availableAgents.length}`
    );

    const workflowState = this.getCurrentState();
    const globalSettings = this.buildGlobalSettings();
    const modelOptions = this.buildModelOptions();
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
          ...(dev ? { dev } : {}),
        },
      },
      postMessage
    );
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
   * Read workflow properties from the working file and send to the settings panel.
   * Pass clientId to read from the correct client's working file (browser vs panel).
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
      const workingFilePath =
        orchestrator.getQueueState(clientId)?.workingFilePath;
      if (!workingFilePath) {
        return;
      }

      const workingFile = await readJsonFile(workingFilePath);

      const workflowProperties = {
        harness: workingFile.harness,
        model: workingFile.model,
        agent: workingFile.agent,
        skills: workingFile.skills,
        resumeSession: workingFile.resumeSession,
        sessionId: workingFile.sessionId,
        mcpServers: workingFile.mcpServers,
        hooks: workingFile.hooks,
        endCondition: workingFile.endCondition,
        preCondition: workingFile.preCondition,
        priorContext: workingFile.priorContext,
        additionalArgs: workingFile.additionalArgs,
        toolPermissions: workingFile.toolPermissions,
      };

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
  notifyHarnessAvailability(harnessId: string, available: boolean): void {
    this.harnessStatus[harnessId] = {
      available,
      status: available
        ? HARNESS_STATUS_STRINGS.AVAILABLE
        : HARNESS_STATUS_STRINGS.UNAVAILABLE,
    };
    this.sendHarnessStatusUpdate();
  }

  // ============================================================================
  // Message Handlers — Settings Changes
  // ============================================================================

  async handleHarnessChange(harness: string): Promise<void> {
    if (!WebviewSettingsSync.VALID_HARNESSES.includes(harness as any)) {
      Log.error(`Invalid harness: ${harness}`);
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

  async handleExecutionModeChange(mode: string): Promise<void> {
    if (!WebviewSettingsSync.VALID_EXECUTION_MODES.includes(mode as any)) {
      Log.error(`Invalid execution mode: ${mode}`);
      return;
    }

    await ConfigurationUtils.setCliExecutionMode(mode);
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
    property: string,
    value: any,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string
  ): Promise<void> {
    await this.handleUpdateWorkflowProperties(
      { [property]: value },
      postMessage,
      clientId
    );
  }

  async handleUpdateWorkflowProperties(
    properties: Record<string, unknown>,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string
  ): Promise<void> {
    if (Object.keys(properties).length === 0) {
      return;
    }

    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      return;
    }

    if (!orchestrator.getQueueState(clientId)?.workingFilePath) {
      await orchestrator.ensureEphemeralWorkingFile(
        { initialProperties: properties },
        clientId
      );
    }

    if (!orchestrator.getQueueState(clientId)?.workingFilePath) {
      Log.warn(
        `handleUpdateWorkflowProperties: no workspace, cannot persist keys [${Object.keys(properties).join(", ")}]`
      );
      return;
    }

    await orchestrator.updateWorkingFileProperties(
      properties,
      {
        allowDeletes: Object.values(properties).some(
          (propertyValue) => propertyValue === undefined
        ),
      },
      clientId
    );

    await this.sendWorkflowPropertiesToSettings(postMessage, clientId);
  }

  async handleSetAsDefault(
    property: string,
    value: any,
    harness?: string
  ): Promise<void> {
    if (property === PROMPT_PROPERTIES.MODEL && harness) {
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
    } else if (property === PROMPT_PROPERTIES.RESUME_SESSION) {
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.WORKFLOW_RESUME_EXISTING_SESSION,
        value
      );
    } else if (property === PROMPT_PROPERTIES.MCP_SERVERS) {
      // null (None mode) → [] so we never write null to an array-typed setting
      await ConfigurationUtils.setDefaultMcpServers(value ?? []);
    } else if (property === PROMPT_PROPERTIES.HOOKS) {
      await ConfigurationUtils.setDefaultHooks(value ?? []);
    } else if (property === PROMPT_PROPERTIES.END_CONDITION) {
      await ConfigurationUtils.setDefaultEndCondition(value ?? null);
    } else if (property === PROMPT_PROPERTIES.PRE_CONDITION) {
      await ConfigurationUtils.setDefaultPreCondition(value ?? null);
    } else if (property === PROMPT_PROPERTIES.TOOL_PERMISSIONS) {
      const override = value as ToolPermissionsOverride | null;
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.TOOLS_PERMISSION_MODE,
        override?.mode && override.mode !== PERMISSION_MODES.NONE
          ? override.mode
          : PERMISSION_MODES.ALLOW_ALL
      );
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.TOOLS_ALLOWED,
        override?.allowedTools ?? []
      );
      await ConfigurationUtils.updateSetting(
        CONFIG_KEYS.TOOLS_DENIED,
        override?.deniedTools ?? []
      );
    } else {
      await ConfigurationUtils.updateSetting(property, value);
    }
  }

  async handleGetConfig(
    key: string,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    if (!key.startsWith(CONFIG_KEYS.EXTENSION_NAMESPACE)) {
      Log.warn(`Rejected config read for non-flightpath key: ${key}`);
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
      Log.warn(`Rejected config write for non-flightpath key: ${key}`);
      return;
    }

    const relativeKey = key.slice(CONFIG_KEYS.EXTENSION_NAMESPACE.length);
    await configService.set(relativeKey, value, CONFIG_SCOPE.USER);
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  /**
   * Write capabilities.json to the workspace .flightpath/ directory.
   * Read by the MCP server (separate process) for harness/model validation.
   */
  private async writeCapabilities(
    modelOptions: Record<string, Array<{ value: string; label: string }>>
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const capabilitiesPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
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
      [HARNESS_IDS.COPILOT_CHAT]: this.getModelForHarness(
        HARNESS_IDS.COPILOT_CHAT
      ),
      [HARNESS_IDS.CLAUDE_CLI]: this.getModelForHarness(HARNESS_IDS.CLAUDE_CLI),
      [HARNESS_IDS.CODEX_CLI]: this.getModelForHarness(HARNESS_IDS.CODEX_CLI),
      [HARNESS_IDS.OPENCODE_CLI]: this.getModelForHarness(
        HARNESS_IDS.OPENCODE_CLI
      ),
      [HARNESS_IDS.QWEN_CLI]: this.getModelForHarness(HARNESS_IDS.QWEN_CLI),
      [HARNESS_IDS.GEMINI_CLI]: this.getModelForHarness(HARNESS_IDS.GEMINI_CLI),
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
      [HARNESS_IDS.GEMINI_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        HARNESS_IDS.GEMINI_CLI
      ),
    };

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot =
      workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : "";

    return {
      harness,
      model,
      harnessDefaultModels,
      harnessDefaultAdditionalArgs,
      agent,
      skills,
      executionMode,
      resumeSession: resumeExistingSession,
      mcpServers: defaultMcpServers,
      hooks: ConfigurationUtils.getDefaultHooks(),
      autoFocusOutputOnExecution:
        ConfigurationUtils.shouldAutoFocusOutputOnExecution(),
      terminal: ConfigurationUtils.getTerminalSettings(),
      toolPermissions: {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      },
      respectGitignore,
      confirmDeleteOperations:
        ConfigurationUtils.shouldConfirmDeleteOperations(),
      confirmResetOperations: ConfigurationUtils.shouldConfirmResetOperations(),
      showHiddenFiles: ConfigurationUtils.shouldShowHiddenFiles(),
      priorContext: ConfigurationUtils.getPriorContext(),
      defaultEndCondition: ConfigurationUtils.getDefaultEndCondition() ?? null,
      defaultPreCondition: ConfigurationUtils.getDefaultPreCondition() ?? null,
      workspaceRoot,
      settingSources: configService.getLeafSources(),
    };
  }

  /**
   * Get the current workflow state from WorkflowOrchestrator (or defaults).
   */
  getCurrentState(): any {
    const orchestrator = this.getOrchestrator();
    if (orchestrator) {
      const queueState = orchestrator.getQueueState(PANEL_CLIENT_ID);
      const currentFile = orchestrator.getCurrentPromptFile();
      const workflowName = queueState.workflowName;
      const promptQueue = orchestrator.getActivePromptQueue();
      const finalStep = promptQueue?.getWorkflowFile().finalStep ?? null;
      const finalStepRuntime = promptQueue?.getFinalStepRuntime();
      return {
        fileName: currentFile || "",
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
    const chatModels = getAvailableModelsSync();
    const cliModelIds = getCliSupportedModelIdsSync();
    const hiddenModels = new Set(["copilot-fast"]);

    const copilotChatOptions = chatModels
      .filter((m) => !hiddenModels.has(m.id))
      .map((m) => ({
        value: m.id,
        label: getModelDisplayName(m.id),
      }));

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

    const geminiCliOptions = [
      noneOption,
      ...Object.entries(GEMINI_CLI_MODEL_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    ];

    return {
      [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
      [HARNESS_IDS.COPILOT_CHAT]: copilotChatOptions,
      [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
      [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
      [HARNESS_IDS.OPENCODE_CLI]: openCodeCliOptions,
      [HARNESS_IDS.QWEN_CLI]: qwenCliOptions,
      [HARNESS_IDS.GEMINI_CLI]: geminiCliOptions,
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
    this.emitMessage(
      {
        type: MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED,
        settings: { settings: allSettings, sources },
      },
      postMessage
    );
  }

  async handleUpdateGlobalSetting(
    path: string,
    value: unknown,
    scope: SettingWriteScope,
    postMessage: PostMessageFn
  ): Promise<void> {
    await configService.set(path, value, scope);
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
    const baseDir =
      scope === CONFIG_SCOPE.USER
        ? homedirFn()
        : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    const certsDir = path.join(
      baseDir,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
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
                !!iface && iface.family === "IPv4" && !iface.internal
            )
            .map((iface) => iface.address)
        : [];

    const { generate } = await import("selfsigned");
    const pems = generate(
      [{ name: "commonName", value: "FlightPath Local CA" }],
      {
        days: 365,
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
          { name: "subjectKeyIdentifier" },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
              ...lanIps.map((ip) => ({ type: 7, ip })),
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
      { type: MESSAGE_TYPES.SERVER_CERT_GENERATED },
      postMessage
    );
  }
}
