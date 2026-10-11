import {
  DynamicQueueConfig,
  ErrorBehavior,
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
  WorktreeDefaultConfig,
} from "../types/CtrlYokeTypes";
import type {
  CtrlYokeGlobalSettings,
  HarnessColorSettings,
  ModelPricingOverride,
  RunHistoryLocation,
  StatusLineHarnessSettings,
  TerminalSettings,
} from "../types/CtrlYokeSettings";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";
import type { PriorContext } from "../types/CtrlYokeTypes";
import type { ToolPermissionConfig } from "../types/ExecutionPropertyTypes";
import type { StatusLineSegment } from "./StatuslineFormat";
import {
  HARNESS_IDS,
  DEFAULT_MODELS,
  DEFAULT_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  CTRLYOKE_DIR,
  LOGS_DIR,
  CAPABILITIES_FILE,
  SETTING_PATHS,
  PERMISSION_MODES,
  HARNESS_DISPLAY_ORDER,
  isHarnessId,
  type StatusLineHarnessId,
  type HarnessId,
  type ContextResolutionFailureMode,
  type PermissionMode,
  type CtrlYokeMcpMode,
  type StepColorMode,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import { isUnlimited } from "./LimitUtils";
import { harnessAvailability } from "./HarnessAvailability";
import {
  ExternalRootsTrustStore,
  externalRootsTrustStore,
} from "../config/ExternalRootsTrustStore";

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

function getDefaultCliToolPermissionConfig(): ToolPermissionConfig | null {
  return normalizeToolPermissionConfig(
    configService.get(CONFIG_KEYS.DEFAULTS).toolPermissions
  );
}

function normalizeToolPermissionConfig(
  config: ToolPermissionConfig | null
): ToolPermissionConfig | null {
  return config === null
    ? null
    : {
        ...config,
        allowedTools: config.allowedTools ?? [],
        deniedTools: config.deniedTools ?? [],
      };
}

/** Convert an authored seconds value to milliseconds, preserving omission. */
export function secondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

function dedupeExternalRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
    if (seen.has(canonicalRoot)) {
      return false;
    }
    seen.add(canonicalRoot);
    return true;
  });
}

/**
 * Configuration key constants (single source of truth for configService.get/set key strings)
 */
export const CONFIG_KEYS = {
  // Top-level section keys (used with configService.get())
  GENERAL: "general",
  DEFAULTS: "defaults",
  WORKTREES: SETTING_PATHS.WORKTREES,
  COORDINATION: SETTING_PATHS.COORDINATION,
  STORAGE: SETTING_PATHS.STORAGE,
  PERMISSIONS: "permissions",
  STATUS_LINE: SETTING_PATHS.STATUS_LINE,
  EXECUTION: "execution",
  QUEUE: "queue",
  RUNS: "runs",
  TERMINAL: "terminal",
  UI: "ui",
  SERVER: "server",
  NOTIFICATIONS: "notifications",
  DIAGNOSTICS: "diagnostics",
  COMMIT: "commit",

  // Dot-notation paths (used with configService.set())
  DEFAULTS_HARNESS: "defaults.harness",
  DEFAULTS_MODELS: "defaults.models",
  DEFAULTS_ADDITIONAL_ARGS: "defaults.additionalArgs",
  DEFAULTS_AGENT: "defaults.agent",
  DEFAULTS_SKILLS: "defaults.skills",
  DEFAULTS_SECRETS: "defaults.secrets",
  DEFAULTS_RESUME_SESSION: "defaults.resumeSession",
  DEFAULTS_PRIOR_CONTEXT: "defaults.priorContext",
  DEFAULTS_END_CONDITION: "defaults.endCondition",
  DEFAULTS_PRE_CONDITION: "defaults.preCondition",
  DEFAULTS_WORKTREE: "defaults.worktree",
  WORKTREES_ROOT: "worktrees.root",
  COORDINATION_READ_NOTES_PAGE_SIZE: "coordination.readNotesPageSize",
  COORDINATION_MAX_NOTE_LENGTH: "coordination.maxNoteLength",
  COORDINATION_MAX_ENTRIES: "coordination.maxEntries",
  COORDINATION_MAX_BOARD_BYTES: "coordination.maxBoardBytes",
  COORDINATION_MAX_ENTRY_AGE_DAYS: "coordination.maxEntryAgeDays",
  COORDINATION_CLI_PARTICIPANT_TTL_MINUTES:
    "coordination.cliParticipantTtlMinutes",
  COORDINATION_ALLOW_EXTERNAL_PARTICIPANTS:
    "coordination.allowExternalParticipants",
  STORAGE_RUN_HISTORY_LOCATION: SETTING_PATHS.STORAGE_RUN_HISTORY_LOCATION,
  DEFAULTS_ERROR_BEHAVIOR: "defaults.errorBehavior",
  DEFAULTS_TOOL_PERMISSIONS: "defaults.toolPermissions",
  DEFAULTS_TOOL_PERMISSIONS_MODE: "defaults.toolPermissions.mode",
  DEFAULTS_TOOL_PERMISSIONS_ALLOWED: "defaults.toolPermissions.allowedTools",
  DEFAULTS_TOOL_PERMISSIONS_DENIED: "defaults.toolPermissions.deniedTools",
  QUEUE_MAX_STEPS: "queue.maxSteps",
  DEFAULTS_MCP_SERVERS: "defaults.mcpServers",
  DEFAULTS_HOOKS: "defaults.hooks",
  GENERAL_DEFAULT_TEMPLATE: "general.defaultTemplate",
  GENERAL_INCLUDE_FULL_DIFFS_IN_PRIOR_CONTEXT:
    "general.includeFullDiffsInPriorContext",
  EXECUTION_MODE: "defaults.executionMode",
  SERVER_AUTO_START: SETTING_PATHS.SERVER_AUTO_START,
  SERVER_BIND_ADDRESS: "server.bindAddress",
  SERVER_TLS_ENABLED: "server.tls.enabled",
  SERVER_TLS_CERT_PATH: "server.tls.certPath",
  SERVER_TLS_KEY_PATH: "server.tls.keyPath",
  SERVER_ICON_BG_COLOR: "server.iconBgColor",
  SERVER_ICON_FG_COLOR: "server.iconFgColor",
  UI_CONFIRM_DELETE_OPERATIONS: "ui.confirmDeleteOperations",
  UI_CONFIRM_RESET_OPERATIONS: "ui.confirmResetOperations",
  UI_CONFIRM_CONTINUATION_DISCARD_OPERATIONS:
    "ui.confirmContinuationDiscardOperations",
  UI_SHOW_HEADLESS_PERMISSION_WARNING: "ui.showHeadlessPermissionWarning",
  UI_AUTO_FOCUS_OUTPUT_ON_EXECUTION: "ui.autoFocusOutputOnExecution",
  UI_OUTPUT_VIRTUALIZATION_ROW_THRESHOLD: "ui.outputVirtualizationRowThreshold",
  UI_COLLAPSED_TOOL_OUTPUT_LINE_COUNT: "ui.collapsedToolOutputLineCount",
  UI_SHOW_COST_ESTIMATES: SETTING_PATHS.UI_SHOW_COST_ESTIMATES,
  PERMISSIONS_TRUSTED_EXTERNAL_ROOTS:
    SETTING_PATHS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS,
  USAGE_TRACKING: "usageTracking",
  USAGE_TRACKING_ENABLED: SETTING_PATHS.USAGE_TRACKING_ENABLED,
  USAGE_TRACKING_PROVIDER_REFRESH_ENABLED:
    "usageTracking.providerRefreshEnabled",
  USAGE_TRACKING_PERSIST_OBSERVED_USAGE: "usageTracking.persistObservedUsage",
  USAGE_TRACKING_WARNING_PERCENT_USED: "usageTracking.warningPercentUsed",
  MODEL_PRICING: "modelPricing",
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
  CTRLYOKE_DIR,

  /**
   * Run storage root (subdirectory of CTRLYOKE_DIR). Holds one directory per workflow
   * lineage (`<workflowKey>/`), each containing its descriptor, optional draft, and
   * promoted `run-<timestamp>/` directories. See `WorkflowPaths.ts`, the sole authority
   * for every deeper path under this root.
   */
  RUNS_DIR: ".runs",

  /**
   * Recently deleted run history, a sibling of RUNS_DIR under the same project
   * state root so moving a lineage in or out is a same-volume rename. Kept
   * outside `.runs` so nothing that scans run storage has to skip it.
   */
  TRASH_DIR: ".trash",

  /** Scripts directory name (subdirectory of CTRLYOKE_DIR) */
  SCRIPTS_DIR: "scripts",

  /**
   * Prompts directory name (subdirectory of CTRLYOKE_DIR).
   * Generated store for prompt bodies composed in the dashboard, **gitignored**
   * for the same reason as ATTACHMENTS_DIR — see that comment.
   */
  PROMPTS_DIR: "prompts",

  /** Templates directory name (subdirectory of CTRLYOKE_DIR) */
  TEMPLATES_DIR: "templates",

  /** Compiled extension output directory name. */
  OUT_DIR: "out",

  /** Temp directory name (subdirectory of CTRLYOKE_DIR) */
  TEMP_DIR: "temp",

  /** Workspace-local observed/provider usage directory name (subdirectory of CTRLYOKE_DIR) */
  USAGE_DIR: ".usage",

  /**
   * Attachments directory name (subdirectory of CTRLYOKE_DIR).
   * Content-addressed store for pasted images. Persistent, unlike TEMP_DIR, but
   * **gitignored**: it holds assets belonging to ephemeral run work, and no
   * single ignore rule can serve both those and assets of a durable, committed
   * workflow. The split is made by lifecycle instead — Save As copies the assets
   * a workflow actually references into a tracked sibling `<workflow>.assets/`
   * and rewrites the references, so an exported workflow is self-contained and
   * this store never needs to be committed. Do not un-ignore it; that trades a
   * complete export for a directory of unrelated debug screenshots.
   *
   * It must also stay **inside the workspace**, independently of the tracking
   * question: these files are `@`-referenced into prompts and therefore read by
   * the harness, and harnesses sandbox to the workspace. A user-scoped store
   * would need per-harness escapes (Claude's `--add-dir`, and an equivalent for
   * each of the others) to read a pasted screenshot.
   * See `ui.instructions.md` ("Save As owns bundle portability").
   */
  ATTACHMENTS_DIR: "attachments",

  /** Logs directory name (subdirectory of CTRLYOKE_DIR) */
  LOGS_DIR,

  /**
   * UX snapshots directory name (subdirectory of CTRLYOKE_DIR).
   * Kept separate from LOGS_DIR so log rotation never deletes captured snapshots.
   */
  SNAPSHOTS_DIR: "snapshots",

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
  CAPABILITIES_FILE,

  /** Persisted push subscription registry file (inside NOTIFICATIONS_DIR) */
  PUSH_SUBSCRIPTIONS_FILE: "push-subscriptions.json",

  /** Persisted VAPID key pair file (inside NOTIFICATIONS_DIR) */
  VAPID_KEYS_FILE: "vapid-keys.json",

  /** MCP directory name (subdirectory of CTRLYOKE_DIR) */
  MCP_DIR: "mcp",

  /** Workspace MCP server registry file name (inside MCP_DIR) */
  MCP_SERVERS_FILE: "servers.json",

  /** Dev-only tooling directory name (subdirectory of CTRLYOKE_DIR) — gitignored */
  DEV_DIR: "dev",

  /**
   * Dev-only file (inside DEV_DIR) holding the currently running hosted
   * server's URL (including access token). Written by `CtrlYokeHostedServer`
   * only in dev builds so external tooling (e.g. an agent driving Playwright)
   * can discover the live URL without it being pasted into chat each session.
   */
  SERVER_URL_FILE: "server-url.txt",
} as const;

/**
 * Configuration utility functions for ctrlyoke settings.
 * Centralizes all settings access for consistency and testability.
 */
export const ConfigurationUtils = {
  secondsToMs,

  /**
   * Check if CLI command should be shown in dashboard output
   */
  shouldShowCliCommand(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCliCommand;
  },

  /** Get the dashboard-only per-harness identity color settings. */
  getHarnessColorSettings(): HarnessColorSettings {
    return configService.get(CONFIG_KEYS.UI).harnessColors;
  },

  /** Get the dashboard step identity color mode. */
  getStepColorMode(): StepColorMode {
    return configService.get(CONFIG_KEYS.UI).stepColorMode;
  },

  /**
   * Check if raw CLI output should be logged for debugging
   */
  shouldLogRawCliOutput(): boolean {
    return configService.get(CONFIG_KEYS.DIAGNOSTICS).logRawCliOutput;
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
    return configService.get(CONFIG_KEYS.DIAGNOSTICS).verboseLogging;
  },

  /**
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return configService.get(CONFIG_KEYS.UI).openPromptsInSecondGroup;
  },

  /**
   * Get the effective default harness: the `defaults.harness` setting, or when
   * it is empty (auto-detect), the first installed harness in display order.
   * Before any harness has been found installed this is the first harness in
   * display order, which cannot run either; the dashboard's preflight panel
   * and the CLI's availability errors explain what to install.
   */
  getIntegrationMode(): HarnessId {
    const configured = configService.get(CONFIG_KEYS.DEFAULTS).harness;
    if (isHarnessId(configured)) {
      return configured;
    }
    return harnessAvailability.getFirstAvailable() ?? HARNESS_DISPLAY_ORDER[0];
  },

  /** Whether `defaults.harness` is empty, so the default harness is auto-detected. */
  isDefaultHarnessAutoDetected(): boolean {
    return !isHarnessId(configService.get(CONFIG_KEYS.DEFAULTS).harness);
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const queue = configService.get(CONFIG_KEYS.QUEUE);
    return {
      maxSteps: queue.maxSteps,
      maxParallelSteps: queue.maxParallelSteps,
      maxWorkflowExecutionTime: queue.maxWorkflowExecutionTimeSec,
    };
  },

  /** Get the global maximum number of workflow steps, or -1 for unlimited. */
  getGlobalMaxSteps(): number {
    return configService.get(CONFIG_KEYS.QUEUE).maxSteps;
  },

  /** Set the raw global workflow step cap, preserving -1 for unlimited. */
  async setMaxSteps(value: number): Promise<void> {
    await configService.set(
      CONFIG_KEYS.QUEUE_MAX_STEPS,
      value,
      CONFIG_SCOPE.USER
    );
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
    return secondsToMs(ConfigurationUtils.getScriptTimeoutSeconds())!;
  },

  /**
   * Get the effective script timeout in seconds. The setting is deliberately
   * finite: any non-positive or non-finite value falls back to the default.
   */
  getScriptTimeoutSeconds(): number {
    const timeoutSec = configService.get(
      CONFIG_KEYS.EXECUTION
    ).scriptTimeoutSec;
    return Number.isFinite(timeoutSec) && timeoutSec > 0
      ? timeoutSec
      : CTRLYOKE_SETTINGS_DEFAULTS.execution.scriptTimeoutSec;
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
   * Get default pass-retry prompt template (reads from endCondition)
   */
  getDefaultPassRetryPrompt(): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).endCondition?.passRetryPrompt ??
      ""
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

  shouldShowCostEstimates(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCostEstimates;
  },

  getModelPricingOverride(
    harnessId: HarnessId,
    modelId: string
  ): ModelPricingOverride | undefined {
    return configService.get(CONFIG_KEYS.MODEL_PRICING)[harnessId]?.[modelId];
  },

  shouldTreatReferencesAsAtomic(): boolean {
    return configService.get(CONFIG_KEYS.UI).atomicContextReferences;
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

  getCollapsedToolOutputLineCount(): number {
    return configService.get(CONFIG_KEYS.UI).collapsedToolOutputLineCount;
  },

  /**
   * Get the default Copilot CLI model
   */
  getCopilotCliModel(): string {
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
        return ConfigurationUtils.getCopilotCliModel();
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
    }
  },

  // ============================================================
  // ALLOWED EXTERNAL FILE ROOTS
  // See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md
  // ============================================================

  /**
   * Get `permissions.trustedExternalRoots` split by scope. A dedicated
   * union (not the ordinary deep-merge, which replaces arrays wholesale) is
   * required because both user and workspace scope can independently
   * contribute roots.
   */
  getTrustedExternalRootsByScope(): {
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
      user: dedupeExternalRoots(
        toStringArray(
          configService.getScoped(CONFIG_KEYS.PERMISSIONS, CONFIG_SCOPE.USER)
            ?.trustedExternalRoots
        )
      ),
      workspace: dedupeExternalRoots(
        toStringArray(
          configService.getScoped(
            CONFIG_KEYS.PERMISSIONS,
            CONFIG_SCOPE.WORKSPACE
          )?.trustedExternalRoots
        )
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
  getTrustedExternalRoots(): string[] {
    const { user, workspace } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    return dedupeExternalRoots([...user, ...workspace]);
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
    workflow?: {
      identity: string;
      declaredRoots: string[] | null | undefined;
    },
    trustStore: ExternalRootsTrustStoreLike = externalRootsTrustStore
  ): string[] {
    const { user, workspace } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    const approvedWorkspaceRoots = trustStore.getApprovedRoots(
      workspaceIdentity,
      workspace
    );
    const baseRoots = dedupeExternalRoots([...user, ...approvedWorkspaceRoots]);

    if (!workflow || workflow.declaredRoots === undefined) {
      return baseRoots;
    }
    if (workflow.declaredRoots === null) {
      return [];
    }

    const approvedWorkflowRoots = trustStore.getApprovedRoots(
      workflow.identity,
      workflow.declaredRoots
    );
    const approvedRoots = new Set(
      baseRoots.map((root) => ExternalRootsTrustStore.canonicalizeRoot(root))
    );
    for (const root of approvedWorkflowRoots) {
      approvedRoots.add(ExternalRootsTrustStore.canonicalizeRoot(root));
    }
    return dedupeExternalRoots(
      workflow.declaredRoots.filter((root) =>
        approvedRoots.has(ExternalRootsTrustStore.canonicalizeRoot(root))
      )
    );
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
    const { workspace } = ConfigurationUtils.getTrustedExternalRootsByScope();
    return trustStore.getPendingRoots(workspaceIdentity, workspace);
  },

  /**
   * Get workflow-scope roots that have never been decided and are not already
   * approved at user or workspace scope.
   */
  getPendingWorkflowExternalFileRoots(
    workspaceIdentity: string,
    workflowIdentity: string,
    requestedRoots: readonly string[],
    trustStore: ExternalRootsTrustStoreLike = externalRootsTrustStore
  ): string[] {
    const approvedBaseRoots = new Set(
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        workspaceIdentity,
        undefined,
        trustStore
      ).map((root) => ExternalRootsTrustStore.canonicalizeRoot(root))
    );
    const candidates = dedupeExternalRoots(
      requestedRoots.filter(
        (root) =>
          !approvedBaseRoots.has(ExternalRootsTrustStore.canonicalizeRoot(root))
      )
    );
    return trustStore.getPendingRoots(workflowIdentity, candidates);
  },

  /**
   * Add a directory to the user-scope `trustedExternalRoots` list (no
   * workspace-approval gate — this is the "Trust Parent Folder" action).
   * No-op if the directory is already present.
   */
  async addUserAllowedExternalFileRoot(root: string): Promise<void> {
    const { user: current } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    if (current.includes(root)) {
      return;
    }
    await configService.set(
      CONFIG_KEYS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS,
      [...current, root],
      CONFIG_SCOPE.USER
    );
  },

  async addWorkspaceAllowedExternalFileRoot(root: string): Promise<void> {
    const { workspace: current } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    if (current.includes(root)) {
      return;
    }
    await configService.set(
      CONFIG_KEYS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS,
      [...current, root],
      CONFIG_SCOPE.WORKSPACE
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
   * Get the `defaults.toolPermissions.mode` setting. `none` means ctrlyoke
   * passes no permission flags and the harness uses its own configuration.
   */
  getCliToolPermissions(): PermissionMode {
    return getDefaultCliToolPermissionConfig()?.mode ?? PERMISSION_MODES.NONE;
  },

  /**
   * The tool permissions a harness spawn should apply. `undefined` (no
   * resolved workflow value) falls back to the `defaults.toolPermissions`
   * setting. Returns null — pass no permission flags — for an explicit null
   * and for mode `none`, so permission mappers never receive `none`.
   */
  resolveSpawnToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): ToolPermissionConfig | null {
    const config =
      toolPermissions === undefined
        ? getDefaultCliToolPermissionConfig()
        : normalizeToolPermissionConfig(toolPermissions);
    return config === null || config.mode === PERMISSION_MODES.NONE
      ? null
      : config;
  },

  // ============================================================
  // CLI EXECUTION SETTINGS
  // ============================================================

  /**
   * Get CLI execution mode (interactive terminal or headless)
   */
  getCliExecutionMode(): string {
    return configService.get(CONFIG_KEYS.DEFAULTS).executionMode;
  },

  /** Get the workflow worktree default without applying workflow overrides. */
  getDefaultWorktree(): CtrlYokeGlobalSettings["defaults"]["worktree"] {
    return configService.get(CONFIG_KEYS.DEFAULTS).worktree;
  },

  /** Get the user-only checkout placement root, or undefined when unset. */
  getWorktreeRoot(): string | undefined {
    return configService.getConfiguredWorktreeRoot();
  },

  /** Get the user-only location selected for persisted workflow run history. */
  getRunHistoryLocation(): RunHistoryLocation {
    return configService.get(CONFIG_KEYS.STORAGE).runHistoryLocation;
  },

  /** Days a deleted run stays in Recently deleted, clamped to the minimum. */
  getTrashRetentionDays(): number {
    const days = configService.get(CONFIG_KEYS.STORAGE).trashRetentionDays;
    return typeof days === "number" && Number.isFinite(days)
      ? Math.max(MIN_TRASH_RETENTION_DAYS, Math.floor(days))
      : DEFAULT_TRASH_RETENTION_DAYS;
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
    ).maxPromptTimeoutSec;
    return isUnlimited(timeoutSeconds)
      ? undefined
      : secondsToMs(timeoutSeconds);
  },

  /** Get the configured prompt timeout in seconds, preserving -1 as unlimited. */
  getPromptTimeoutSeconds(): number {
    return configService.get(CONFIG_KEYS.EXECUTION).maxPromptTimeoutSec;
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

  /** Get the settings for a provider that installs a global statusline command. */
  getStatusLineHarnessSettings(
    provider: StatusLineHarnessId
  ): StatusLineHarnessSettings {
    return configService.get(CONFIG_KEYS.STATUS_LINE).byHarness[provider];
  },

  /** Get the shared statusline format used when per-harness formats are disabled. */
  getSharedStatusLineFormat(): StatusLineSegment[] {
    return configService.get(CONFIG_KEYS.STATUS_LINE).sharedFormat;
  },

  /** Whether statusline formats are configured independently per harness. */
  isUseDifferentFormatPerHarness(): boolean {
    return configService.get(CONFIG_KEYS.STATUS_LINE)
      .useDifferentFormatPerHarness;
  },

  /** Persist one complete machine-scoped statusline provider object. */
  async setStatusLineHarnessSettings(
    provider: StatusLineHarnessId,
    settings: StatusLineHarnessSettings
  ): Promise<void> {
    await configService.set(
      `${SETTING_PATHS.STATUS_LINE}.byHarness.${provider}`,
      settings,
      CONFIG_SCOPE.USER
    );
  },

  /** Persist whether statusline formats are configured independently per harness. */
  async setUseDifferentFormatPerHarness(value: boolean): Promise<void> {
    await configService.set(
      SETTING_PATHS.STATUS_LINE_USE_DIFFERENT_FORMAT_PER_HARNESS,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Whether pattern-based heuristics (e.g. `token=...`, `Bearer ...`) apply
   * during secret redaction, in addition to exact matches of resolved
   * managed/env secret values, which always redact regardless of this
   * setting.
   */
  isHeuristicSecretRedactionEnabled(): boolean {
    return configService.get(CONFIG_KEYS.PERMISSIONS)
      .heuristicSecretRedactionEnabled;
  },

  /** Get how declared context references that fail to resolve should be handled. */
  getContextResolutionFailureMode(): ContextResolutionFailureMode {
    return (
      configService.get(CONFIG_KEYS.EXECUTION).contextResolutionFailure ??
      "warn"
    );
  },

  /** Whether provider quota and observed usage collection is enabled. */
  shouldTrackHarnessUsage(): boolean {
    return configService.get(CONFIG_KEYS.USAGE_TRACKING).enabled;
  },

  /** Get the complete usage tracking configuration used by selection assist. */
  getHarnessUsageSettings(): CtrlYokeGlobalSettings["usageTracking"] {
    return configService.get(CONFIG_KEYS.USAGE_TRACKING);
  },

  /** Whether the explicit provider refresh command may invoke collectors. */
  shouldRefreshHarnessUsage(): boolean {
    const settings = configService.get(CONFIG_KEYS.USAGE_TRACKING);
    return settings.enabled && settings.providerRefreshEnabled;
  },

  /** Whether normalized observed totals may be written to workspace storage. */
  shouldPersistObservedHarnessUsage(): boolean {
    const settings = configService.get(CONFIG_KEYS.USAGE_TRACKING);
    return settings.enabled && settings.persistObservedUsage;
  },

  // ============================================================
  // SHARED CLI TOOL SETTINGS
  // ============================================================

  /**
   * Get extra CLI flags to append for a specific harness (global fallback).
   * Prompt-level and workflow-level additionalArgs take precedence via PropertyResolver.
   */
  getAdditionalArgsForHarness(harness: HarnessId): string {
    return (
      configService.get(CONFIG_KEYS.DEFAULTS).additionalArgs[harness] ?? ""
    );
  },

  /**
   * Get allowed tools for CLI operations (shared between Copilot and Claude)
   */
  getCliAllowedTools(): string[] {
    return getDefaultCliToolPermissionConfig()?.allowedTools ?? [];
  },

  /**
   * Get denied tools for CLI operations (shared between Copilot and Claude)
   */
  getCliDeniedTools(): string[] {
    return getDefaultCliToolPermissionConfig()?.deniedTools ?? [];
  },

  // ============================================================
  // SESSION & WORKFLOW SETTINGS
  // ============================================================

  /**
   * Get the default prior context injection mode for workflow prompts.
   */
  getPriorContext(): PriorContext {
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

  /** Get the default secret grants for new workflows. */
  getDefaultSecrets(): string[] {
    return configService.get(CONFIG_KEYS.DEFAULTS).secrets ?? [];
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

  getCommitSystemPrompt(): string {
    return configService.get(CONFIG_KEYS.COMMIT).systemPrompt;
  },

  // ============================================================
  // SETTINGS UPDATE HELPERS
  // ============================================================

  /**
   * Get a ctrlyoke configuration value by dot-notation path
   * @param key The setting path (dot-notation, e.g. "defaults.executionMode")
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
   * @param key The setting path (dot-notation, e.g. "defaults.executionMode")
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

  /** Set the default secret grants for new workflows. */
  async setDefaultSecrets(secrets: string[]): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_SECRETS,
      secrets,
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
  async setDefaultPriorContext(priorContext: PriorContext): Promise<void> {
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

  /** Get ctrlyoke's own MCP server attachment mode (native server vs. built-in skill). */
  getCtrlYokeMcpMode(): CtrlYokeMcpMode {
    return configService.get(CONFIG_KEYS.EXECUTION).ctrlyokeMcpMode;
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

  /** Set the settings-tier worktree default. */
  async setDefaultWorktree(worktree: WorktreeDefaultConfig): Promise<void> {
    await configService.set(
      CONFIG_KEYS.DEFAULTS_WORKTREE,
      worktree,
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
  // RUNS RETENTION SETTINGS
  // ============================================================

  /**
   * Get the maximum number of runs to retain per workflow lineage.
   * -1 (default) keeps all runs; a finite value prunes complete runs oldest-first.
   */
  getMaxRuns(): number {
    return configService.get(CONFIG_KEYS.RUNS).maxRuns;
  },

  /**
   * Heap budget, in bytes, for `HistorySearchDocumentCache`'s bounded cache
   * of parsed history-search documents from the most recent runs. 0 (from a
   * 0 MB setting) disables the cache.
   */
  getHistorySearchCacheBudgetBytes(): number {
    return (
      configService.get(CONFIG_KEYS.RUNS).historySearchCacheMb * 1024 * 1024
    );
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

  shouldWrapCodeLines(): boolean {
    return configService.get(CONFIG_KEYS.UI).wordWrap;
  },

  async setConfirmResetOperations(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_RESET_OPERATIONS,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Check if a confirmation dialog should be shown before discarding a
   * continuation's edited suffix (Discard Continuation, Start New Run Instead).
   */
  shouldConfirmContinuationDiscardOperations(): boolean {
    return configService.get(CONFIG_KEYS.UI)
      .confirmContinuationDiscardOperations;
  },

  async setConfirmContinuationDiscardOperations(
    enabled: boolean
  ): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_CONTINUATION_DISCARD_OPERATIONS,
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
