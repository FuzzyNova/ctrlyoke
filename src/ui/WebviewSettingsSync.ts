import * as vscode from "vscode";
import * as fs from "fs/promises";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  EXECUTION_STATES,
  DEFAULT_MODELS,
  type HarnessStatusString,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
  getOpenCodeModelIdsSync,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import { Harness } from "../types/FlightPathTypes";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import { AgentDiscovery } from "../utils/AgentDiscovery";
import type { AgentInfo } from "../utils/AgentDiscovery";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import type { SkillInfo } from "../utils/SkillDiscovery";

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
  };

  // Validation constants
  private static readonly VALID_HARNESSES = [
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.COPILOT_CHAT,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.CODEX_CLI,
    HARNESS_IDS.OPENCODE_CLI,
  ] as const;

  private static readonly VALID_EXECUTION_MODES = [
    "interactive",
    "headless",
  ] as const;

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined
  ) {}

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
  sendInitialState(): void {
    const harnessStatuses = Object.entries(this.harnessStatus)
      .map(([id, s]) => `${id}=${s.status}`)
      .join(", ");
    Log.debug(
      `sendInitialState() — harness: [${harnessStatuses}], agents: ${this.availableAgents.length}`
    );

    const workflowState = this.getCurrentState();
    const globalSettings = this.buildGlobalSettings();
    const modelOptions = this.buildModelOptions();

    this.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: {
        ...workflowState,
        globalSettings,
        workflowProperties: {},
        modelOptions,
        harnessStatus: this.harnessStatus,
        availableAgents: this.availableAgents,
        availableSkills: this.availableSkills,
      },
    });
  }

  /**
   * Send only global settings to the webview without workflow data.
   * Used for configuration changes to avoid resetting the output panel.
   */
  sendGlobalSettingsUpdate(): void {
    this.postMessage({
      type: MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED,
      globalSettings: this.buildGlobalSettings(),
      modelOptions: this.buildModelOptions(),
    });
  }

  /**
   * Send updated model options to the webview (e.g. when ModelRegistry loads).
   */
  sendModelOptionsUpdate(): void {
    const modelOptions = this.buildModelOptions();
    this.postMessage({
      type: MESSAGE_TYPES.MODEL_OPTIONS_UPDATE,
      data: { modelOptions },
    });
  }

  /**
   * Send harness status update to the webview.
   */
  sendHarnessStatusUpdate(): void {
    this.postMessage({
      type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
      data: { harnessStatus: this.harnessStatus },
    });
  }

  /**
   * Send agents update to the webview.
   */
  sendAgentsUpdate(): void {
    this.postMessage({
      type: MESSAGE_TYPES.AGENTS_UPDATE,
      data: { availableAgents: this.availableAgents },
    });
  }

  /**
   * Send skills update to the webview.
   */
  sendSkillsUpdate(): void {
    this.postMessage({
      type: MESSAGE_TYPES.SKILLS_UPDATE,
      data: { availableSkills: this.availableSkills },
    });
  }

  /**
   * Read workflow properties from the working file and send to the settings panel.
   */
  async sendWorkflowPropertiesToSettings(): Promise<void> {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      return;
    }

    try {
      const workingFilePath = orchestrator.getQueueState()?.workingFilePath;
      if (!workingFilePath) {
        return;
      }

      const workingFileContent = await fs.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(workingFileContent);

      const workflowProperties = {
        harness: workingFile.harness,
        model: workingFile.model,
        agent: workingFile.agent,
        skills: workingFile.skills,
        resumeSession: workingFile.resumeSession,
        sessionId: workingFile.sessionId,
        allowDynamicExtension: workingFile.allowDynamicExtension,
        endCondition: workingFile.endCondition,
        priorContext: workingFile.priorContext,
        additionalArgs: workingFile.additionalArgs,
      };

      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
        workflowProperties,
      });

      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_LOADED,
      });
    } catch (error) {
      Log.error("Failed to send workflow properties to settings:", error);
    }
  }

  /**
   * Send WORKFLOW_UNLOADED to disable settings UI.
   */
  sendWorkflowUnloadedToSettings(): void {
    this.postMessage({
      type: MESSAGE_TYPES.WORKFLOW_UNLOADED,
    });
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

    await ConfigurationUtils.setIntegrationMode(harness as Harness);
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

  async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    await ConfigurationUtils.setEnableDynamicQueue(enabled);
  }

  handleOpenSettings(): void {
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:flightpath"
    );
  }

  async handleUpdateWorkflowProperty(
    property: string,
    value: any
  ): Promise<void> {
    await this.handleUpdateWorkflowProperties({ [property]: value });
  }

  async handleUpdateWorkflowProperties(
    properties: Record<string, unknown>
  ): Promise<void> {
    if (Object.keys(properties).length === 0) {
      return;
    }

    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      return;
    }

    if (!orchestrator.getQueueState()?.workingFilePath) {
      await orchestrator.ensureEphemeralWorkingFile({
        initialProperties: properties,
      });
    }

    if (!orchestrator.getQueueState()?.workingFilePath) {
      Log.warn(
        `handleUpdateWorkflowProperties: no workspace, cannot persist keys [${Object.keys(properties).join(", ")}]`
      );
      return;
    }

    await orchestrator.updateWorkingFileProperties(properties, {
      allowDeletes: Object.values(properties).some(
        (propertyValue) => propertyValue === undefined
      ),
    });

    await this.sendWorkflowPropertiesToSettings();
  }

  async handleSetAsDefault(
    property: string,
    value: any,
    harness?: string
  ): Promise<void> {
    if (property === "model" && harness) {
      await ConfigurationUtils.setModelForHarness(harness as Harness, value);
    } else if (property === "additionalArgs" && harness) {
      await ConfigurationUtils.setAdditionalArgsForHarness(
        harness as Harness,
        value ?? ""
      );
    } else if (property === "agent") {
      await ConfigurationUtils.setDefaultAgent(value || "");
    } else if (property === "skills") {
      await ConfigurationUtils.setDefaultSkills(value || []);
    } else {
      await ConfigurationUtils.updateSetting(property, value);
    }
  }

  async handleGetConfig(key: string): Promise<void> {
    if (!key.startsWith("flightpath.")) {
      Log.warn(`Rejected config read for non-flightpath key: ${key}`);
      return;
    }

    const value = ConfigurationUtils.getConfigValue(key);

    this.postMessage({
      type: MESSAGE_TYPES.CONFIG_VALUE,
      key,
      value,
    });
  }

  async handleUpdateConfig(key: string, value: unknown): Promise<void> {
    if (!key.startsWith("flightpath.")) {
      Log.warn(`Rejected config write for non-flightpath key: ${key}`);
      return;
    }

    // Strip the "flightpath." prefix — ConfigurationUtils.updateSetting uses a
    // scoped getConfiguration("flightpath"), so it expects a relative key.
    const relativeKey = key.slice("flightpath.".length);
    await ConfigurationUtils.updateSetting(relativeKey, value);
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  /**
   * Build global settings object from current VS Code configuration.
   */
  buildGlobalSettings(): Record<string, unknown> {
    const harness = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForHarness(harness);
    const agent = ConfigurationUtils.getDefaultAgent();
    const skills = ConfigurationUtils.getDefaultSkills();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;
    const respectGitignore =
      ConfigurationUtils.shouldRespectGitignoreForCompletions();

    const harnessDefaultModels = {
      [HARNESS_IDS.COPILOT_CLI]: this.getModelForHarness(Harness.CopilotCli),
      [HARNESS_IDS.COPILOT_CHAT]: this.getModelForHarness(Harness.CopilotChat),
      [HARNESS_IDS.CLAUDE_CLI]: this.getModelForHarness(Harness.ClaudeCli),
      [HARNESS_IDS.CODEX_CLI]: this.getModelForHarness(Harness.CodexCli),
      [HARNESS_IDS.OPENCODE_CLI]: this.getModelForHarness(Harness.OpenCodeCli),
    };

    const harnessDefaultAdditionalArgs = {
      [HARNESS_IDS.COPILOT_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        Harness.CopilotCli
      ),
      [HARNESS_IDS.COPILOT_CHAT]: "",
      [HARNESS_IDS.CLAUDE_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        Harness.ClaudeCli
      ),
      [HARNESS_IDS.CODEX_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(
        Harness.CodexCli
      ),
      [HARNESS_IDS.OPENCODE_CLI]:
        ConfigurationUtils.getAdditionalArgsForHarness(Harness.OpenCodeCli),
    };

    return {
      harness,
      model,
      harnessDefaultModels,
      harnessDefaultAdditionalArgs,
      agent,
      skills,
      executionMode,
      resumeSession: resumeExistingSession,
      allowDynamicExtension: dynamicQueueEnabled,
      respectGitignore,
      confirmDeleteOperations:
        ConfigurationUtils.shouldConfirmDeleteOperations(),
      confirmResetOperations: ConfigurationUtils.shouldConfirmResetOperations(),
      priorContext: ConfigurationUtils.getPriorContext(),
    };
  }

  /**
   * Get the current workflow state from WorkflowOrchestrator (or defaults).
   */
  getCurrentState(): any {
    const orchestrator = this.getOrchestrator();
    if (orchestrator) {
      const queueState = orchestrator.getQueueState();
      const currentFile = orchestrator.getCurrentPromptFile();
      const workflowName = queueState.workflowName;
      const promptQueue = orchestrator.getActivePromptQueue();
      const finalPrompt = promptQueue?.getWorkflowFile().finalPrompt ?? null;
      const finalPromptRuntime = promptQueue?.getFinalPromptRuntime();
      return {
        fileName: currentFile || "",
        workflowName: workflowName || "",
        prompts: queueState.prompts || [],
        executionState: queueState.status || EXECUTION_STATES.IDLE,
        currentIndex: queueState.currentIndex || 0,
        results: queueState.results || [],
        finalPrompt,
        finalPromptStatus: finalPromptRuntime?.status ?? null,
        finalPromptLoopCount: finalPromptRuntime?.loopCount ?? 0,
        finalPromptPhase: finalPromptRuntime?.phase ?? null,
      };
    }

    return {
      fileName: "",
      workflowName: "",
      prompts: [],
      executionState: EXECUTION_STATES.IDLE,
      currentIndex: 0,
      results: [],
      finalPrompt: null,
      finalPromptStatus: null,
      finalPromptLoopCount: 0,
      finalPromptPhase: null,
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

    const noneOption = { value: "none", label: "None (skip --model flag)" };

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

    return {
      [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
      [HARNESS_IDS.COPILOT_CHAT]: copilotChatOptions,
      [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
      [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
      [HARNESS_IDS.OPENCODE_CLI]: openCodeCliOptions,
    };
  }

  /**
   * Get the configured model for a given harness, with fallbacks.
   */
  getModelForHarness(harness: string): string {
    return (
      ConfigurationUtils.getModelForHarness(harness as Harness) ||
      (DEFAULT_MODELS as Record<string, string>)[harness] ||
      DEFAULT_MODELS[HARNESS_IDS.COPILOT_CLI]
    );
  }
}
