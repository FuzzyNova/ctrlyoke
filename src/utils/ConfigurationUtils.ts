import {
  DynamicQueueConfig,
  ErrorBehavior,
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "../types/CtrlYokeTypes";
import type { TerminalSettings } from "../types/CtrlYokeSettings";
import {
  HARNESS_IDS,
  DEFAULT_MODELS,
  type HarnessId,
  type PermissionMode,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import { externalRootsTrustStore } from "../config/ExternalRootsTrustStore";

/** The subset of `ExternalRootsTrustStore` these helpers depend on — narrowed so tests can inject a fake without constructing a real file-backed store. */
interface ExternalRootsTrustStoreLike {
  getApprovedRoots(
    workspaceIdentity: string,
    candidateRoots: readonly string[]
  ): string[];
  getPendingRoots(
    workspaceIdentity: string,
    candidateRoots: readonly string[]
  ): string[];
}

/**
 * Configuration key constants (single source of truth for configService.get/set key strings)
 */
export const CONFIG_KEYS = {
  // Top-level section keys (used with configService.get())
  GENERAL: "general",
  DEFAULTS: "defaults",
  PERMISSIONS: "permissions",
  EXECUTION: "execution",
  QUEUE: "queue",
  HISTORY: "history",
  TERMINAL: "terminal",
  UI: "ui",
  SERVER: "server",
  NOTIFICATIONS: "notifications",
  ENABLE_DIAGNOSTIC_LOGS: "enableDiagnosticLogs",
  COMMIT: "commit",

  // Dot-notation paths (used with configService.set())
  DEFAULTS_HARNESS: "defaults.harness",
  DEFAULTS_MODELS: "defaults.models",
  DEFAULTS_ADDITIONAL_ARGS: "defaults.additionalArgs",
  DEFAULTS_AGENT: "defaults.agent",
  DEFAULTS_SKILLS: "defaults.skills",
  DEFAULTS_RESUME_SESSION: "defaults.resumeSession",
  DEFAULTS_PRIOR_CONTEXT: "defaults.priorContext",
  DEFAULTS_END_CONDITION: "defaults.endCondition",
  DEFAULTS_PRE_CONDITION: "defaults.preCondition",
  DEFAULTS_ERROR_BEHAVIOR: "defaults.errorBehavior",
  DEFAULTS_TOOL_PERMISSIONS: "defaults.toolPermissions",
  DEFAULTS_TOOL_PERMISSIONS_MODE: "defaults.toolPermissions.mode",
  DEFAULTS_TOOL_PERMISSIONS_ALLOWED: "defaults.toolPermissions.allowedTools",
  DEFAULTS_TOOL_PERMISSIONS_DENIED: "defaults.toolPermissions.deniedTools",
  DEFAULTS_MCP_SERVERS: "defaults.mcpServers",
  DEFAULTS_HOOKS: "defaults.hooks",
  GENERAL_DEFAULT_TEMPLATE: "general.defaultTemplate",
  GENERAL_INCLUDE_FULL_DIFFS_IN_PRIOR_CONTEXT:
    "general.includeFullDiffsInPriorContext",
  EXECUTION_MODE: "execution.mode",
  SERVER_ENABLED: "server.enabled",
  SERVER_TLS_CERT_PATH: "server.tls.certPath",
  SERVER_TLS_KEY_PATH: "server.tls.keyPath",
  UI_CONFIRM_DELETE_OPERATIONS: "ui.confirmDeleteOperations",
  UI_CONFIRM_RESET_OPERATIONS: "ui.confirmResetOperations",
  UI_SHOW_HEADLESS_PERMISSION_WARNING: "ui.showHeadlessPermissionWarning",
  UI_AUTO_FOCUS_OUTPUT_ON_EXECUTION: "ui.autoFocusOutputOnExecution",
  UI_OUTPUT_VIRTUALIZATION_ROW_THRESHOLD: "ui.outputVirtualizationRowThreshold",
  PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS: "permissions.allowedExternalFileRoots",
  UI_OFFER_TRUST_FOR_UNTRUSTED_FILE_LINKS: "ui.offerTrustForUntrustedFileLinks",
  EXTENSION_NAMESPACE: "ctrlyoke.",
} as const;

/**
 * Configuration scope constants (single source of truth for configService.set scope strings)
 */
export const CONFIG_SCOPE = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;

/**
 * Path constants (single source of truth for directory names)
 */
export const PATH_CONSTANTS = {
  /** Root ctrlyoke directory name (default: ".ctrlyoke") */
  CTRLYOKE_DIR: ".ctrlyoke",

  /** Working file directory name (subdirectory of CTRLYOKE_DIR) */
  WORKING_DIR: ".working",

  /** Scripts directory name (subdirectory of CTRLYOKE_DIR) */
  SCRIPTS_DIR: "scripts",

  /** Prompts directory name (subdirectory of CTRLYOKE_DIR) */
  PROMPTS_DIR: "prompts",

  /** Templates directory name (subdirectory of CTRLYOKE_DIR) */
  TEMPLATES_DIR: "templates",

  /** Temp directory name (subdirectory of CTRLYOKE_DIR) */
  TEMP_DIR: "temp",

  /**
   * Attachments directory name (subdirectory of CTRLYOKE_DIR).
   * Committed, un-gitignored home for pasted images belonging to saved
   * workflows — deliberately persistent, unlike TEMP_DIR.
   */
  ATTACHMENTS_DIR: "attachments",

  /** Logs directory name (subdirectory of CTRLYOKE_DIR) */
  LOGS_DIR: "logs",

  /**
   * UX snapshots directory name (subdirectory of CTRLYOKE_DIR).
   * Kept separate from LOGS_DIR so log rotation never deletes captured snapshots.
   */
  SNAPSHOTS_DIR: "snapshots",

  /** History directory name (subdirectory of CTRLYOKE_DIR) */
  HISTORY_DIR: ".history",

  /** Persistent search index directory name (subdirectory of CTRLYOKE_DIR) */
  SEARCH_INDEX_DIR: ".search-index",

  /** Agents directory name (subdirectory of CTRLYOKE_DIR) */
  AGENTS_DIR: "agents",

  /** Skills directory name (subdirectory of CTRLYOKE_DIR) */
  SKILLS_DIR: "skills",

  /** Certs directory name (subdirectory of CTRLYOKE_DIR) — gitignored */
  CERTS_DIR: "certs",

  /** Notifications directory name (subdirectory of CTRLYOKE_DIR) */
  NOTIFICATIONS_DIR: "notifications",

  /** Capabilities file name (written by extension, read by MCP server) */
  CAPABILITIES_FILE: "capabilities.json",

  /** Persisted push subscription registry file (inside NOTIFICATIONS_DIR) */
  PUSH_SUBSCRIPTIONS_FILE: "push-subscriptions.json",

  /** Persisted VAPID key pair file (inside NOTIFICATIONS_DIR) */
  VAPID_KEYS_FILE: "vapid-keys.json",

  /** MCP directory name (subdirectory of CTRLYOKE_DIR) */
  MCP_DIR: "mcp",

  /** Workspace MCP server registry file name (inside MCP_DIR) */
  MCP_SERVERS_FILE: "servers.json",
} as const;

/**
 * Configuration utility functions for ctrlyoke settings.
 * Centralizes all settings access for consistency and testability.
 */
export const ConfigurationUtils = {
  /**
   * Check if CLI command should be shown in dashboard output
   */
  shouldShowCliCommand(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCliCommand;
  },

  /**
   * Check if CLI output should be shown in output panel
   */
  shouldShowCliOutput(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCliOutput;
  },

  /**
   * Check if raw CLI output should be logged for debugging
   */
  shouldLogRawCliOutput(): boolean {
    return configService.get(CONFIG_KEYS.UI).logRawCliOutput;
  },

  /**
   * Check if the headless limited-permissions warning should be shown.
   */
  shouldShowHeadlessPermissionWarning(): boolean {
    return configService.get(CONFIG_KEYS.UI).showHeadlessPermissionWarning;
  },

  /**
   * Check if prompt execution should automatically reveal the output section
   * and switch to the relevant output view (output vs terminal).
   */
  shouldAutoFocusOutputOnExecution(): boolean {
    return configService.get(CONFIG_KEYS.UI).autoFocusOutputOnExecution;
  },

  /**
   * Check if diagnostic file logging is enabled.
   * When true, ctrlyoke writes log files to .ctrlyoke/logs/ in production builds.
   * Dev builds always write log files regardless of this setting.
   */
  isDiagnosticLogsEnabled(): boolean {
    return configService.get(CONFIG_KEYS.ENABLE_DIAGNOSTIC_LOGS);
  },

  /**
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return configService.get(CONFIG_KEYS.UI).openPromptsInSecondGroup;
  },

  /**
   * Get the default harness from settings
   */
  getIntegrationMode(): HarnessId {
    const mode = configService.get(CONFIG_KEYS.DEFAULTS).harness as HarnessId;
    const validIds = Object.values(HARNESS_IDS) as HarnessId[];
    return validIds.includes(mode) ? mode : HARNESS_IDS.COPILOT_CLI;
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const queue = configService.get(CONFIG_KEYS.QUEUE);
    return {
      maxQueueSize: queue.maxSize,
      maxWorkflowExecutionTime: queue.maxWorkflowExecutionTime,
      unlimitedMode: queue.unlimitedMode,
      notifyOnExtension: queue.notifyOnExtension,
    };
  },

  /**
   * Get embedded terminal settings.
   */
  getTerminalSettings(): TerminalSettings {
    return configService.get(CONFIG_KEYS.TERMINAL);
  },

  /**
   * Get the script timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getScriptTimeoutMs(): number {
    return configService.get(CONFIG_KEYS.EXECUTION).scriptTimeout * 1000;
  },

  /**
   * Get the default end condition for new workflows (null/undefined = disabled)
   */
  getDefaultEndCondition(): EndCondition | null | undefined {
    return configService.get(CONFIG_KEYS.DEFAULTS).endCondition;
  },

  /**
   * Get the default pre-condition for new workflows (null/undefined = disabled)
   */
  getDefaultPreCondition(): PreCondition | null | undefined {
    return configService.get(CONFIG_KEYS.DEFAULTS).preCondition;
  },

  /**
   * Get the default harness/session error behavior for new workflows.
   */
  getDefaultErrorBehavior(): ErrorBehavior | null | undefined {
    return configService.get(CONFIG_KEYS.DEFAULTS).errorBehavior;
  },

  /**
   * Get default max retries for end conditions (reads from endCondition)
   */
  getDefaultMaxRetries(): number {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).endCondition?.maxRetries ?? 0
    );
  },

  /**
   * Get default retry prompt template (reads from endCondition)
   */
  getDefaultRetryPrompt(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).endCondition?.retryPrompt ?? ""
    );
  },

  /**
   * Set the default end condition in settings
   */
  async setDefaultEndCondition(value: EndCondition | null): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_END_CONDITION,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default pre-condition in settings
   */
  async setDefaultPreCondition(value: PreCondition | null): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_PRE_CONDITION,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default harness/session error behavior in settings.
   */
  async setDefaultErrorBehavior(value: ErrorBehavior | null): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_ERROR_BEHAVIOR,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get default workflow format (yaml or json)
   */
  getDefaultWorkflowFormat(): "yaml" | "json" {
    return configService.get(CONFIG_KEYS.GENERAL).defaultFormat;
  },

  /**
   * Check if .gitignore should be respected for completions
   */
  shouldRespectGitignoreForCompletions(): boolean {
    return configService.get(CONFIG_KEYS.UI).respectGitignoreForCompletions;
  },

  shouldAutoExpandEditorWhenTyping(): boolean {
    return configService.get(CONFIG_KEYS.UI).autoExpandEditorWhenTyping;
  },

  /**
   * Raw `ui.useAbsolutePathReferences` setting value only — NOT the
   * multi-root-forced effective value. Callers that need the effective
   * (rendered) value must combine this with `resolveEffectiveAbsoluteReferences`
   * so the decision stays testable and CLI-safe.
   */
  shouldUseAbsolutePathReferences(): boolean {
    return configService.get(CONFIG_KEYS.UI).useAbsolutePathReferences;
  },

  getOutputVirtualizationRowThreshold(): number {
    return configService.get(CONFIG_KEYS.UI).outputVirtualizationRowThreshold;
  },

  /**
   * Get the default CLI model (Copilot CLI)
   */
  getCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[HARNESS_IDS.COPILOT_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.COPILOT_CLI]
    );
  },

  /**
   * Get model for a specific harness
   * Maps harness enum to the appropriate model setting
   */
  getModelForHarness(harness: HarnessId): string {
    switch (harness) {
      case HARNESS_IDS.COPILOT_CLI:
        return ConfigurationUtils.getCliModel();
      case HARNESS_IDS.CLAUDE_CLI:
        return ConfigurationUtils.getClaudeCliModel();
      case HARNESS_IDS.CODEX_CLI:
        return ConfigurationUtils.getCodexCliModel();
      case HARNESS_IDS.OPENCODE_CLI:
        return ConfigurationUtils.getOpenCodeCliModel();
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return ConfigurationUtils.getAntigravityCliModel();
      case HARNESS_IDS.QWEN_CLI:
        return ConfigurationUtils.getQwenCliModel();
      default:
        // Fallback to Copilot CLI model
        return ConfigurationUtils.getCliModel();
    }
  },

  // ============================================================
  // ALLOWED EXTERNAL FILE ROOTS
  // See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md
  // ============================================================

  /**
   * Get `permissions.allowedExternalFileRoots` split by scope. A dedicated
   * union (not the ordinary deep-merge, which replaces arrays wholesale) is
   * required because both user and workspace scope can independently
   * contribute roots.
   */
  getAllowedExternalFileRootsByScope(): {
    user: string[];
    workspace: string[];
  } {
    // `getScoped` returns a single-backend PartialCtrlYokeSettings slice, where
    // TS's mapped Partial<> treats array leaves as sparse (elements typed
    // `string | undefined`) — filter defensively rather than casting blindly.
    const toStringArray = (
      value: readonly (string | undefined)[] | undefined
    ): string[] =>
      (value ?? []).filter((v): v is string => typeof v === "string");

    return {
      user: toStringArray(
        configService.getScoped(CONFIG_KEYS.PERMISSIONS, CONFIG_SCOPE.USER)
          ?.allowedExternalFileRoots
      ),
      workspace: toStringArray(
        configService.getScoped(
          CONFIG_KEYS.PERMISSIONS,
          CONFIG_SCOPE.WORKSPACE
        )?.allowedExternalFileRoots
      ),
    };
  },

  /**
   * Get the flat union of configured external file roots across both
   * scopes, regardless of whether workspace-scope entries have been
   * approved yet. Use this only for display/configuration purposes (e.g.
   * Settings UI, the CLI trust command) — for actual read/open decisions use
   * {@link getEffectiveApprovedExternalFileRoots}.
   */
  getAllowedExternalFileRoots(): string[] {
    const { user, workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    return Array.from(new Set([...user, ...workspace]));
  },

  /**
   * Get the external roots actually authorized to be read/opened right now:
   * every user-scope root (trusted immediately — the user already made that
   * decision on their own machine) plus every workspace-scope root with a
   * recorded `"allow"` decision in `ExternalRootsTrustStore` for this
   * workspace identity. Workspace-scope roots with no decision yet, or a
   * `"deny"` decision, are excluded.
   *
   * @param workspaceIdentity Canonical identity of the current workspace
   *   (e.g. `ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)`).
   * @param trustStore Override for testing; defaults to the real singleton.
   */
  getEffectiveApprovedExternalFileRoots(
    workspaceIdentity: string,
    trustStore: ExternalRootsTrustStoreLike = externalRootsTrustStore
  ): string[] {
    const { user, workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    const approvedWorkspaceRoots = trustStore.getApprovedRoots(
      workspaceIdentity,
      workspace
    );
    return Array.from(new Set([...user, ...approvedWorkspaceRoots]));
  },

  /**
   * Get workspace-scope external roots that have never been decided (allow
   * or deny) for this workspace identity — the set that should trigger a
   * batch approval prompt (VS Code) or gate `ctrlyoke run` (CLI).
   *
   * @param trustStore Override for testing; defaults to the real singleton.
   */
  getPendingWorkspaceExternalFileRoots(
    workspaceIdentity: string,
    trustStore: ExternalRootsTrustStoreLike = externalRootsTrustStore
  ): string[] {
    const { workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    return trustStore.getPendingRoots(workspaceIdentity, workspace);
  },

  /**
   * Add a directory to the user-scope `allowedExternalFileRoots` list (no
   * workspace-approval gate — this is the "Trust Parent Folder" action).
   * No-op if the directory is already present.
   */
  async addUserAllowedExternalFileRoot(root: string): Promise<void> {
    const { user: current } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    if (current.includes(root)) {
      return;
    }
    await configService.set(
      CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS,
      [...current, root],
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Check whether an AI-generated file link outside trusted roots may offer
   * a "Trust Parent Folder" action. When false, untrusted links are still
   * blocked outright — trusted roots always open regardless of this value.
   */
  shouldOfferTrustForUntrustedFileLinks(): boolean {
    return configService.get(CONFIG_KEYS.UI).offerTrustForUntrustedFileLinks;
  },

  /**
   * Get CLI tool permissions mode (shared between Copilot and Claude)
   */
  getCliToolPermissions(): Exclude<PermissionMode, "none"> {
    return configService.get(CONFIG_KEYS.DEFAULTS).toolPermissions
      .mode as Exclude<PermissionMode, "none">;
  },

  // ============================================================
  // CLI EXECUTION SETTINGS
  // ============================================================

  /**
   * Get CLI execution mode (interactive terminal or headless)
   */
  getCliExecutionMode(): string {
    return configService.get(CONFIG_KEYS.EXECUTION).mode;
  },

  /**
   * Returns true when inject mode is enabled.
   * Keeps the TUI alive and writes follow-up prompts directly into the PTY,
   * avoiding terminal restart latency and the Claude Code resume cache bug.
   *
   * closeTerminalOnComplete takes precedence: if terminals are closed on
   * completion, injection is impossible regardless of the injectMode setting.
   */
  isInjectModeEnabled(): boolean {
    const exec = configService.get(CONFIG_KEYS.EXECUTION);
    if (exec.closeTerminalOnComplete) {
      return false;
    }
    return exec.injectMode;
  },

  /**
   * Check if terminal should be closed when each interactive prompt completes
   */
  shouldCloseTerminalWhenPromptCompletes(): boolean {
    return configService.get(CONFIG_KEYS.EXECUTION).closeTerminalOnComplete;
  },

  /**
   * Check if categorized temp prompt files should be deleted after execution.
   * Returns false when the user wants to inspect files in .ctrlyoke/temp/ for debugging.
   */
  shouldAutoDeleteTempFiles(): boolean {
    return configService.get(CONFIG_KEYS.EXECUTION).autoDeleteTempFiles;
  },

  /**
   * Get maximum prompt execution timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   * Returns undefined if set to -1 (unlimited)
   */
  getMaxPromptExecutionTimeMs(): number | undefined {
    const timeoutSeconds = configService.get(
      CONFIG_KEYS.EXECUTION
    ).maxPromptTimeout;
    return timeoutSeconds === -1 ? undefined : timeoutSeconds * 1000;
  },

  /**
   * Idle-based backstop (ms) for a Layer-2 signal-gated completion hold
   * (see `CliLogMonitor`'s background-work hold and
   * `dev/backlog/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`). A hold releases early
   * whenever the harness confirms genuine idle; this bound only protects
   * against a background task that never reports completion (an abandoned
   * task, a long-lived dev server). Fixed default for now, not a user
   * setting — the hold is rare enough in practice that surfacing it in
   * settings would be premature.
   */
  getBackgroundWorkIdleBackstopMs(): number {
    return 10 * 60 * 1000; // 10 minutes
  },

  // ============================================================
  // CLAUDE CLI SETTINGS
  // ============================================================

  /**
   * Get Claude CLI model
   */
  getClaudeCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[HARNESS_IDS.CLAUDE_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.CLAUDE_CLI]
    );
  },

  // ============================================================
  // OPENCODE CLI SETTINGS
  // ============================================================

  /**
   * Get OpenCode CLI model (user-configured, free-form provider/model format)
   */
  getOpenCodeCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[
        HARNESS_IDS.OPENCODE_CLI
      ] ?? DEFAULT_MODELS[HARNESS_IDS.OPENCODE_CLI]
    );
  },

  // ============================================================
  // QWEN CLI SETTINGS
  // ============================================================

  /**
   * Get Qwen CLI model
   */
  getQwenCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[HARNESS_IDS.QWEN_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.QWEN_CLI]
    );
  },

  // ============================================================
  // ANTIGRAVITY CLI SETTINGS
  // ============================================================

  getAntigravityCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[
        HARNESS_IDS.ANTIGRAVITY_CLI
      ] ?? DEFAULT_MODELS[HARNESS_IDS.ANTIGRAVITY_CLI]
    );
  },

  // ============================================================
  // CODEX CLI SETTINGS
  // ============================================================

  /**
   * Get Codex CLI model
   */
  getCodexCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).models[HARNESS_IDS.CODEX_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.CODEX_CLI]
    );
  },

  /**
   * Get Codex CLI sandbox mode
   * Options: read-only, workspace-write, danger-full-access
   */
  getCodexSandboxMode(): string {
    return configService.get(CONFIG_KEYS.PERMISSIONS).codexSandboxMode;
  },

  /**
   * Get Codex CLI approval policy
   * Options: untrusted, on-request, never
   */
  getCodexApprovalPolicy(): string {
    return configService.get(CONFIG_KEYS.PERMISSIONS).codexApprovalPolicy;
  },

  // ============================================================
  // SHARED CLI TOOL SETTINGS
  // ============================================================

  /**
   * Get extra CLI flags to append for a specific harness (global fallback).
   * Prompt-level and workflow-level additionalArgs take precedence via PropertyResolver.
   */
  getAdditionalArgsForHarness(harness: HarnessId): string {
    return configService.get(CONFIG_KEYS.DEFAULTS).additionalArgs[harness] ?? "";
  },

  /**
   * Get allowed tools for CLI operations (shared between Copilot and Claude)
   */
  getCliAllowedTools(): string[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).toolPermissions.allowedTools;
  },

  /**
   * Get denied tools for CLI operations (shared between Copilot and Claude)
   */
  getCliDeniedTools(): string[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).toolPermissions.deniedTools;
  },

  // ============================================================
  // SESSION & WORKFLOW SETTINGS
  // ============================================================

  /**
   * Get the default prior context injection mode for workflow prompts.
   */
  getPriorContext(): string {
    return configService.get(CONFIG_KEYS.DEFAULTS).priorContext;
  },

  /**
   * Check if an existing session should be resumed per prompt
   */
  shouldResumeExistingSession(): boolean {
    return configService.get(CONFIG_KEYS.DEFAULTS).resumeSession;
  },

  /**
   * Determine if an existing session should be resumed for a specific prompt
   * Checks prompt's explicit setting first, then falls back to global setting
   * @param promptResumeSession The prompt's resumeSession property (may be undefined)
   * @returns true if session should be resumed, false to start new session
   */
  shouldResumeSessionForPrompt(
    promptResumeSession: boolean | undefined
  ): boolean {
    if (promptResumeSession !== undefined) {
      return promptResumeSession;
    }
    return ConfigurationUtils.shouldResumeExistingSession();
  },

  /**
   * Get default workflow template ID
   */
  getDefaultWorkflowTemplate(): string {
    return configService.get(CONFIG_KEYS.GENERAL).defaultTemplate;
  },

  /**
   * Check if recent session should be auto-loaded on startup
   */
  shouldAutoLoadRecentSession(): boolean {
    return configService.get(CONFIG_KEYS.GENERAL).autoLoadRecentSession;
  },

  /**
   * Get the default agent name for new workflows
   * Returns empty string if no default agent is selected
   */
  getDefaultAgent(): string {
    return configService.get(CONFIG_KEYS.DEFAULTS).agent;
  },

  /**
   * Get the default skills for new workflows
   * Returns empty array if no default skills are selected
   */
  getDefaultSkills(): string[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).skills ?? [];
  },

  /**
   * Check if agent and skill instructions should be omitted when resuming a session.
   * When true (default), agent/skill blocks are skipped for prompts that resume an existing
   * session — preventing duplicate instructions since the harness already received them
   * in the first message of that session.
   */
  shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume(): boolean {
    return configService.get(CONFIG_KEYS.GENERAL)
      .omitPreviouslyAttachedAgentsSkillsOnResume;
  },

  // ============================================================
  // COMMIT MESSAGE SETTINGS
  // ============================================================

  getCommitHarness(): HarnessId | "" {
    return configService.get(CONFIG_KEYS.COMMIT).harness as HarnessId | "";
  },

  getCommitModel(): string {
    return configService.get(CONFIG_KEYS.COMMIT).model;
  },

  getCommitPrompt(): string {
    return configService.get(CONFIG_KEYS.COMMIT).prompt;
  },

  // ============================================================
  // SETTINGS UPDATE HELPERS
  // ============================================================

  /**
   * Get a ctrlyoke configuration value by dot-notation path
   * @param key The setting path (dot-notation, e.g. "execution.mode")
   * @param defaultValue The default value if setting is not defined
   * @returns The configuration value
   */
  getConfigValue<T>(key: string, defaultValue?: T): T | undefined {
    const value = configService.getNested(key) as T | undefined;
    if (value !== undefined) {
      return value;
    }
    return defaultValue;
  },

  /**
   * Update a ctrlyoke configuration setting
   * @param key The setting path (dot-notation, e.g. "execution.mode")
   * @param value The new value
   * @param _target Ignored — always writes to user scope via config service
   */
  async updateSetting<T>(
    key: string,
    value: T,
    _target?: unknown
  ): Promise<void> {
    await configService.set(key, value, CONFIG_SCOPE.USER);
  },

  // ============================================================
  // SETTINGS UPDATE METHODS
  // ============================================================

  /**
   * Set the default harness integration mode
   */
  async setIntegrationMode(harness: HarnessId): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_HARNESS,
      harness,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the model for a specific harness
   */
  async setModelForHarness(harness: HarnessId, model: string): Promise<void> {
    await configService.set(
      `${CONFIG_KEYS.DEFAULTS_MODELS}.${harness}`,
      model,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default additional args for a specific harness
   */
  async setAdditionalArgsForHarness(
    harness: HarnessId,
    args: string
  ): Promise<void> {
    // Pass undefined to remove the setting entirely when args is empty —
    // avoids leaving a "" entry in settings.json.
    await configService.set(
      `${CONFIG_KEYS.DEFAULTS_ADDITIONAL_ARGS}.${harness}`,
      args || undefined,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default agent for new workflows
   */
  async setDefaultAgent(agent: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_AGENT,
      agent,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default skills for new workflows
   */
  async setDefaultSkills(skills: string[]): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_SKILLS,
      skills,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set CLI execution mode
   */
  async setCliExecutionMode(mode: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.EXECUTION_MODE,
      mode,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set whether to resume existing session
   */
  async setResumeExistingSession(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_RESUME_SESSION,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default prior context for new workflows
   */
  async setDefaultPriorContext(priorContext: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_PRIOR_CONTEXT,
      priorContext,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get the default MCP servers from settings
   */
  getDefaultMcpServers(): (string | McpServerConfig)[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).mcpServers;
  },

  /**
   * Set the default MCP servers in settings
   */
  async setDefaultMcpServers(
    servers: (string | McpServerConfig)[]
  ): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_MCP_SERVERS,
      servers,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get the default hooks from settings
   */
  getDefaultHooks(): UserHookConfig[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).hooks;
  },

  /**
   * Set the default hooks in settings
   */
  async setDefaultHooks(hooks: UserHookConfig[]): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_HOOKS,
      hooks,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default workflow template
   */
  async setDefaultWorkflowTemplate(templateId: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
      templateId,
      CONFIG_SCOPE.USER
    );
  },

  /** Whether captured responses should retain full file diffs for prior context. */
  shouldIncludeFullDiffsInPriorContext(): boolean {
    return configService.get(CONFIG_KEYS.GENERAL)
      .includeFullDiffsInPriorContext;
  },

  // ============================================================
  // OUTPUT HISTORY SETTINGS
  // ============================================================

  /**
   * Check if output history saving is enabled
   */
  isSaveOutputHistoryEnabled(): boolean {
    return configService.get(CONFIG_KEYS.HISTORY).saveOutput;
  },

  /**
   * Get the maximum number of history runs to retain per workflow
   */
  getMaxHistoryRuns(): number {
    return configService.get(CONFIG_KEYS.HISTORY).maxRuns;
  },

  /**
   * Check if delete confirmation dialogs should be shown
   * When true (default), shows a modal before destructive delete operations.
   */
  shouldConfirmDeleteOperations(): boolean {
    return configService.get(CONFIG_KEYS.UI).confirmDeleteOperations;
  },

  /**
   * Set whether to show confirmation dialogs before delete operations
   */
  async setConfirmDeleteOperations(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_DELETE_OPERATIONS,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  shouldConfirmResetOperations(): boolean {
    return configService.get(CONFIG_KEYS.UI).confirmResetOperations;
  },

  shouldHideGitIgnoredFiles(): boolean {
    return configService.get(CONFIG_KEYS.UI).hideGitIgnoredFiles;
  },

  async setConfirmResetOperations(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_RESET_OPERATIONS,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  async setShowHeadlessPermissionWarning(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_SHOW_HEADLESS_PERMISSION_WARNING,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  async setAutoFocusOutputOnExecution(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_AUTO_FOCUS_OUTPUT_ON_EXECUTION,
      enabled,
      CONFIG_SCOPE.USER
    );
  },
};
