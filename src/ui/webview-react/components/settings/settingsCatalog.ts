import {
  GLOBAL_SETTINGS_TABS,
  HARNESS_IDS,
  HARNESS_INFO,
  STATUS_LINE_HARNESS_IDS,
  HOOK_EVENT_NAMES,
  HOOK_EVENT_METADATA,
  type HarnessId,
  type StatusLineHarnessId,
  type HookEvent,
} from "@root/types/DashboardConstants";
import { HOOK_EVENT_OPTIONS_META } from "@root/types/SchemaUiMetadata";
import type { GlobalSettingsTab } from "./settingsTabs";
import type { DrawerPage } from "@/types/drawerPages";

export interface SettingsCatalogEntry {
  id: string;
  path?: string;
  tab: GlobalSettingsTab;
  page?: DrawerPage;
  label: string;
  description?: string;
  context?: string;
  keywords?: readonly string[];
  revealedBy?: string;
  devOnly?: boolean;
}

const STATIC_SETTINGS_CATALOG = {
  "general.defaultFormat": {
    id: "general.defaultFormat",
    path: "general.defaultFormat",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Default format",
    description: "Default file format used when creating new workflows.",
  },
  "general.defaultTemplate": {
    id: "general.defaultTemplate",
    path: "general.defaultTemplate",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Default template",
    description:
      "Template ID used when creating new workflows. Use 'blank' for a minimal starter.",
  },
  "general.autoLoadRecentSession": {
    id: "general.autoLoadRecentSession",
    path: "general.autoLoadRecentSession",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Auto-load recent session",
    description:
      "Automatically load the most recently used workflow when the extension starts.",
  },
  "general.omitPreviouslyAttachedAgentsSkillsOnResume": {
    id: "general.omitPreviouslyAttachedAgentsSkillsOnResume",
    path: "general.omitPreviouslyAttachedAgentsSkillsOnResume",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Omit already attached agents & skills on resume",
    description:
      "When resuming a session, only attach agents and skills that are not already present in that session's context.",
  },
  "ui.showCliCommand": {
    id: "ui.showCliCommand",
    path: "ui.showCliCommand",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Show CLI command",
    description: "Show the CLI command used to start the AI harness.",
  },
  "ui.stepColorMode": {
    id: "ui.stepColorMode",
    path: "ui.stepColorMode",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Step identity colors",
    description:
      "Choose how workflow step identity colors are rendered across the dashboard.",
  },
  "ui.harnessColors.script": {
    id: "ui.harnessColors.script",
    path: "ui.harnessColors.script",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Script step color",
    description: "Identity color used for script steps in harness mode.",
  },
  "ui.showCostEstimates": {
    id: "ui.showCostEstimates",
    path: "ui.showCostEstimates",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Show token cost estimates",
    description:
      "Show source-labelled token cost estimates. These are not incremental subscription spend.",
  },
  "ui.showHeadlessPermissionWarning": {
    id: "ui.showHeadlessPermissionWarning",
    path: "ui.showHeadlessPermissionWarning",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Headless permission warning",
    description: "Warn when headless execution uses limited tool permissions.",
  },
  "ui.autoFocusOutputOnExecution": {
    id: "ui.autoFocusOutputOnExecution",
    path: "ui.autoFocusOutputOnExecution",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Auto-focus output on execution",
    description:
      "Automatically expand the output section when a prompt starts. Headless runs show Output; interactive and inject-mode runs show Terminal.",
  },
  "ui.openPromptsInSecondGroup": {
    id: "ui.openPromptsInSecondGroup",
    path: "ui.openPromptsInSecondGroup",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Open prompts in second group",
    description: "Open prompt files in the second editor group.",
  },
  "ui.respectGitignoreForCompletions": {
    id: "ui.respectGitignoreForCompletions",
    path: "ui.respectGitignoreForCompletions",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Respect .gitignore for completions",
    description: "Filter file completions using .gitignore rules.",
  },
  "ui.autoExpandEditorWhenTyping": {
    id: "ui.autoExpandEditorWhenTyping",
    path: "ui.autoExpandEditorWhenTyping",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Auto-expand editor when typing",
    description:
      "Automatically grow the editor panel as you type past its current height, up to 60% of the available area. Shrinks back when text is deleted or the prompt is submitted.",
  },
  "ui.atomicContextReferences": {
    id: "ui.atomicContextReferences",
    path: "ui.atomicContextReferences",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Atomic context references",
    description:
      "In the prompt editor, treat @file, #symbol, ~git, and $context references as single units: arrow keys skip over them and Backspace/Delete removes the whole reference at once. In output, format clickable local references as compact chips. Clicking or long-pressing a reference still opens it; when off, editor references edit character by character and output uses ordinary text links.",
  },
  "ui.useAbsolutePathReferences": {
    id: "ui.useAbsolutePathReferences",
    path: "ui.useAbsolutePathReferences",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Use absolute file paths",
  },
  "ui.collapsedToolOutputLineCount": {
    id: "ui.collapsedToolOutputLineCount",
    path: "ui.collapsedToolOutputLineCount",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Collapsed tool output lines",
    description:
      "Approximate number of wrapped lines shown for Bash and generic tool results before they collapse.",
  },
  "ui.outputVirtualizationRowThreshold": {
    id: "ui.outputVirtualizationRowThreshold",
    path: "ui.outputVirtualizationRowThreshold",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Output virtualization row threshold",
    description:
      "Minimum output rows before virtualization is enabled. Use 0 to always virtualize, or choose Never to disable virtualization.",
  },
  "ui.confirmDeleteOperations": {
    id: "ui.confirmDeleteOperations",
    path: "ui.confirmDeleteOperations",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Confirm delete operations",
    description:
      "Show a confirmation dialog before delete operations like removing prompts, deleting workflow history, or discarding untracked files.",
  },
  "ui.confirmResetOperations": {
    id: "ui.confirmResetOperations",
    path: "ui.confirmResetOperations",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Confirm reset operations",
    description: "Show a confirmation dialog before resetting the workflow.",
  },
  "ui.confirmContinuationDiscardOperations": {
    id: "ui.confirmContinuationDiscardOperations",
    path: "ui.confirmContinuationDiscardOperations",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Confirm continuation discard operations",
    description:
      "Show a confirmation dialog before discarding a continuation's edited suffix (Discard Continuation, Start New Run Instead).",
  },
  "ui.hideGitIgnoredFiles": {
    id: "ui.hideGitIgnoredFiles",
    path: "ui.hideGitIgnoredFiles",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Hide git-ignored files",
    description:
      "Hide files and directories ignored by .gitignore in the workspace file explorer and workflow file picker.",
  },
  "general.includeFullDiffsInPriorContext": {
    id: "general.includeFullDiffsInPriorContext",
    path: "general.includeFullDiffsInPriorContext",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Include full file diffs",
    description:
      "Include actual file changes in captured responses used by later prior-context attachments. Disable for smaller response-only context.",
  },
  "execution.autoDeleteTempFiles": {
    id: "execution.autoDeleteTempFiles",
    path: "execution.autoDeleteTempFiles",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Auto-delete temp files",
    description:
      "Automatically delete prompt temp files after execution. Disable to retain files in .ctrlyoke/temp/ for debugging.",
  },
  "runs.maxRuns": {
    id: "runs.maxRuns",
    path: "runs.maxRuns",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Max runs to keep",
    description: "Deletes entire runs—definition and output—oldest first.",
  },
  "runs.historySearchCacheMb": {
    id: "runs.historySearchCacheMb",
    path: "runs.historySearchCacheMb",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "History search cache (MB, 0 = disabled)",
    description:
      "Approximate working-set budget for caching parsed history-search documents from the most recently run workflows, evicted oldest-first once exceeded. Bounds real process memory, not a literal byte count — raising it does not scale memory use 1:1.",
  },
  "execution.ctrlyokeMcpMode": {
    id: "execution.ctrlyokeMcpMode",
    path: "execution.ctrlyokeMcpMode",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "MCP mode",
    description:
      "Controls only ctrlyoke's own MCP server (queue/coordination/commit tools) — never any other MCP servers a workflow configures. Native attaches ctrlyoke's real MCP server. Skill replaces it with the built-in MCP-tools skill instead, for environments where MCP configuration itself is unavailable (e.g. blocked by policy).",
  },
  "diagnostics.verboseLogging": {
    id: "diagnostics.verboseLogging",
    path: "diagnostics.verboseLogging",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Enable diagnostic logs",
    description: "Write detailed diagnostic logs to help troubleshoot issues.",
  },
  "diagnostics.logRawCliOutput": {
    id: "diagnostics.logRawCliOutput",
    path: "diagnostics.logRawCliOutput",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Log raw CLI output",
  },
  "storage.runHistoryLocation": {
    id: "storage.runHistoryLocation",
    path: "storage.runHistoryLocation",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Run history location",
    description:
      "Choose where ctrlyoke keeps run history. Workspace mode keeps it beside the repo, still ignores .runs/, and does not make runs shareable.",
  },
  "queue.maxSteps": {
    id: "queue.maxSteps",
    path: "queue.maxSteps",
    tab: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Max steps",
  },
  "queue.maxParallelSteps": {
    id: "queue.maxParallelSteps",
    path: "queue.maxParallelSteps",
    tab: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Max parallel steps",
  },
  "queue.maxWorkflowExecutionTimeSec": {
    id: "queue.maxWorkflowExecutionTimeSec",
    path: "queue.maxWorkflowExecutionTimeSec",
    tab: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Max workflow execution time (seconds)",
  },
  "queue.notifyOnExtension": {
    id: "queue.notifyOnExtension",
    path: "queue.notifyOnExtension",
    tab: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Notify on queue extension",
    description:
      "Currently has no effect; queue extension notifications are not implemented.",
  },
  "execution.contextResolutionFailure": {
    id: "execution.contextResolutionFailure",
    path: "execution.contextResolutionFailure",
    tab: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Context resolution failures",
    description:
      "How to handle a declared reference that fails to resolve: a missing/invalid secret (!NAME), an unknown skill (/skill:) or MCP server (/mcp:), an unresolved @file/#selection/#sym reference, or an unresolved ~diff/~staged/~stash/~<hash> git reference. 'warn' (default) reports a diagnostic and lets the step run anyway. 'fail' stops the step before the harness spawns, naming the unresolved reference.",
  },
  "execution.maxPromptTimeoutSec": {
    id: "execution.maxPromptTimeoutSec",
    path: "execution.maxPromptTimeoutSec",
    tab: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Max prompt timeout (seconds)",
  },
  "execution.scriptTimeoutSec": {
    id: "execution.scriptTimeoutSec",
    path: "execution.scriptTimeoutSec",
    tab: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Script timeout (seconds)",
  },
  "execution.closeTerminalOnComplete": {
    id: "execution.closeTerminalOnComplete",
    path: "execution.closeTerminalOnComplete",
    tab: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Close terminal on completion",
    description: "Automatically close the terminal when a workflow completes.",
  },
  "execution.injectMode": {
    id: "execution.injectMode",
    path: "execution.injectMode",
    tab: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Inject mode (interactive)",
  },
  "commit.harness": {
    id: "commit.harness",
    path: "commit.harness",
    tab: GLOBAL_SETTINGS_TABS.COMMIT,
    label: "Harness",
    description:
      "AI harness for commit message generation. Leave empty to use the active global harness.",
  },
  "commit.model": {
    id: "commit.model",
    path: "commit.model",
    tab: GLOBAL_SETTINGS_TABS.COMMIT,
    label: "Model",
    description:
      "Model override for commit message generation. Leave empty to use the harness default.",
  },
  "commit.systemPrompt": {
    id: "commit.systemPrompt",
    path: "commit.systemPrompt",
    tab: GLOBAL_SETTINGS_TABS.COMMIT,
    label: "System prompt",
    description:
      "Prompt sent to the AI along with the git diff. The AI should return only the commit message text.",
  },
  "coordination.readNotesPageSize": {
    id: "coordination.readNotesPageSize",
    path: "coordination.readNotesPageSize",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Read notes page size",
    description:
      "Maximum entries returned by one read_notes call. Reads are always paged.",
  },
  "coordination.maxNoteLength": {
    id: "coordination.maxNoteLength",
    path: "coordination.maxNoteLength",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Maximum note length",
    description:
      "Notes longer than this are rejected instead of being silently truncated.",
  },
  "coordination.maxEntries": {
    id: "coordination.maxEntries",
    path: "coordination.maxEntries",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Maximum board entries",
    description:
      "Target entry count after compaction. Held claims are protected.",
  },
  "coordination.maxBoardBytes": {
    id: "coordination.maxBoardBytes",
    path: "coordination.maxBoardBytes",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Maximum board size (bytes)",
    description: "Hygiene ceiling for the persisted board.",
  },
  "coordination.maxEntryAgeDays": {
    id: "coordination.maxEntryAgeDays",
    path: "coordination.maxEntryAgeDays",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Note retention (days)",
    description: "Notes older than this are removed during compaction.",
  },
  "coordination.cliParticipantTtlMinutes": {
    id: "coordination.cliParticipantTtlMinutes",
    path: "coordination.cliParticipantTtlMinutes",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "CLI participant TTL (minutes)",
    description: "Lease lifetime for CLI and built-in skill participants.",
  },
  "coordination.allowExternalParticipants": {
    id: "coordination.allowExternalParticipants",
    path: "coordination.allowExternalParticipants",
    tab: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Allow external participants",
    description:
      "Allow agents not launched by ctrlyoke to join this execution-root board.",
  },
  "worktrees.root": {
    id: "worktrees.root",
    path: "worktrees.root",
    tab: GLOBAL_SETTINGS_TABS.WORKTREES,
    label: "Worktree root",
    description:
      "Absolute or ~-prefixed directory where named worktrees are placed.",
  },
  "terminal.fontSize": {
    id: "terminal.fontSize",
    path: "terminal.fontSize",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Font size",
  },
  "terminal.cursorStyle": {
    id: "terminal.cursorStyle",
    path: "terminal.cursorStyle",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Cursor style",
  },
  "terminal.cursorBlink": {
    id: "terminal.cursorBlink",
    path: "terminal.cursorBlink",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Cursor blink",
    description: "Blink the terminal cursor.",
  },
  "terminal.macOptionIsMeta": {
    id: "terminal.macOptionIsMeta",
    path: "terminal.macOptionIsMeta",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "macOS: Option key as Meta",
    description: "Treat Option as Meta for Emacs and Vim alt-key shortcuts.",
  },
  "terminal.wordSeparators": {
    id: "terminal.wordSeparators",
    path: "terminal.wordSeparators",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Double-click word separators",
  },
  "terminal.shellExecutable.windows": {
    id: "terminal.shellExecutable.windows",
    path: "terminal.shellExecutable",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Shell executable",
  },
  "terminal.shellExecutable.custom": {
    id: "terminal.shellExecutable.custom",
    path: "terminal.shellExecutable",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Custom shell path",
  },
  "terminal.shellExecutable.other": {
    id: "terminal.shellExecutable.other",
    path: "terminal.shellExecutable",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Shell executable override",
  },
  "terminal.mobileControlBar": {
    id: "terminal.mobileControlBar",
    path: "terminal.mobileControlBar",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Mobile control bar",
  },
  "terminal.mobileCustomShortcuts": {
    id: "terminal.mobileCustomShortcuts",
    path: "terminal.mobileCustomShortcuts",
    tab: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Custom shortcuts",
  },
  "notifications.vscode.enabled": {
    id: "notifications.vscode.enabled",
    path: "notifications.vscode.enabled",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "VS Code notifications",
    description:
      "Show notification popups in the VS Code window when workflows complete.",
  },
  "notifications.browser.mode": {
    id: "notifications.browser.mode",
    path: "notifications.browser.mode",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Browser notifications",
  },
  "notifications.events.workflowComplete": {
    id: "notifications.events.workflowComplete",
    path: "notifications.events.workflowComplete",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Workflow complete",
  },
  "notifications.events.promptComplete": {
    id: "notifications.events.promptComplete",
    path: "notifications.events.promptComplete",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Prompt complete",
  },
  "notifications.includeWorkflowName": {
    id: "notifications.includeWorkflowName",
    path: "notifications.includeWorkflowName",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Include workflow name",
  },
  "notifications.includePromptName": {
    id: "notifications.includePromptName",
    path: "notifications.includePromptName",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Include prompt name",
  },
  "notifications.toastLevel": {
    id: "notifications.toastLevel",
    path: "notifications.toastLevel",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Toast notifications",
  },
  "notifications.onlyWhenWindowUnfocused": {
    id: "notifications.onlyWhenWindowUnfocused",
    path: "notifications.onlyWhenWindowUnfocused",
    tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Only notify when ctrlyoke is not focused",
    description:
      "Suppress notifications while the VS Code window or hosted dashboard is focused.",
  },
  "developer.showUXSnapshotButton": {
    id: "developer.showUXSnapshotButton",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Show UX snapshot button",
    description: "Dev-only floating button that saves a UX snapshot on tap.",
    devOnly: true,
  },
  "developer.enablePerformanceProfiling": {
    id: "developer.enablePerformanceProfiling",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Enable performance profiling",
    devOnly: true,
  },
  "developer.logLongFrames": {
    id: "developer.logLongFrames",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Log long frames",
    description:
      "Captures requestAnimationFrame gaps and browser long-task entries across the entire webview — use to find render hotspots anywhere in the UI.",
    devOnly: true,
  },
  "developer.logRowMeasurements": {
    id: "developer.logRowMeasurements",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Log row measurements",
    description:
      "Includes mounted row measurement cost and measured-vs-estimated height deltas.",
    devOnly: true,
  },
  "developer.logVirtualRanges": {
    id: "developer.logVirtualRanges",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Log virtual ranges",
    description: "Logs TanStack Virtual window changes while scrolling.",
    devOnly: true,
  },
  "developer.logEveryScrollFrame": {
    id: "developer.logEveryScrollFrame",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Log every scroll frame",
    description: "Verbose; use only for short reproductions.",
    devOnly: true,
  },
  "developer.logEveryScrollAttributionEvent": {
    id: "developer.logEveryScrollAttributionEvent",
    tab: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Log every scroll attribution event",
    description:
      "Verbose; logs the routine 'user-scroll' verdict for every scroll event. Settle-window verdicts (suppressed/programmatic/echo) always log while profiling is on.",
    devOnly: true,
  },
} as const;

type DefaultsModelKey = `defaults.models.${HarnessId}`;
type DefaultsArgsKey = `defaults.additionalArgs.${HarnessId}`;
type HarnessColorKey = `ui.harnessColors.byHarness.${HarnessId}`;
type StatusLineProperty =
  "enabled" | "customCommand" | "useCtrlyokeStyle" | "format";
type StatusLineKey =
  `statusLine.byHarness.${StatusLineHarnessId}.${StatusLineProperty}`;

function buildHarnessEntries<K extends string>(
  harnessIds: readonly string[],
  keyFor: (harnessId: string) => K,
  entryFor: (harnessId: string, key: K) => SettingsCatalogEntry
): Record<K, SettingsCatalogEntry> {
  return Object.fromEntries(
    harnessIds.map((harnessId) => {
      const key = keyFor(harnessId);
      return [key, entryFor(harnessId, key)];
    })
  ) as Record<K, SettingsCatalogEntry>;
}

const defaultsModelEntries = buildHarnessEntries(
  Object.values(HARNESS_IDS),
  (harnessId) => `defaults.models.${harnessId}` as DefaultsModelKey,
  (harnessId, id) => ({
    id,
    path: id,
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Model",
    context: HARNESS_INFO[harnessId as HarnessId].name,
  })
);
const defaultsArgsEntries = buildHarnessEntries(
  Object.values(HARNESS_IDS),
  (harnessId) => `defaults.additionalArgs.${harnessId}` as DefaultsArgsKey,
  (harnessId, id) => ({
    id,
    path: id,
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Additional CLI arguments",
    context: HARNESS_INFO[harnessId as HarnessId].name,
    keywords: ["extra args", "command line"],
  })
);
const harnessColorEntries = buildHarnessEntries(
  Object.values(HARNESS_IDS),
  (harnessId) => `ui.harnessColors.byHarness.${harnessId}` as HarnessColorKey,
  (harnessId, id) => ({
    id,
    path: id,
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Harness step color",
    context: HARNESS_INFO[harnessId as HarnessId].name,
  })
);
const statusLineProperties = [
  "enabled",
  "customCommand",
  "useCtrlyokeStyle",
  "format",
] as const satisfies readonly StatusLineProperty[];
const statusLineEntries = Object.fromEntries(
  Object.values(STATUS_LINE_HARNESS_IDS).flatMap((harnessId) =>
    statusLineProperties.map((property) => {
      const id =
        `statusLine.byHarness.${harnessId}.${property}` as StatusLineKey;
      const labels: Record<StatusLineProperty, string> = {
        enabled: "Statusline tracking",
        customCommand: "Custom statusline command",
        useCtrlyokeStyle: "Use ctrlyoke-style statusline",
        format: "Statusline format",
      };
      return [
        id,
        {
          id,
          path: id,
          tab: GLOBAL_SETTINGS_TABS.STATUS_LINE,
          label: labels[property],
          context: HARNESS_INFO[harnessId as HarnessId].name,
        },
      ];
    })
  )
) as Record<StatusLineKey, SettingsCatalogEntry>;

type HookEventSettingKey = `notifications.events.hookEvents.${HookEvent}`;
function buildHookEventEntries(): Record<
  HookEventSettingKey,
  SettingsCatalogEntry
> {
  return Object.fromEntries(
    Object.values(HOOK_EVENT_NAMES).map((event) => {
      const meta = HOOK_EVENT_OPTIONS_META[event];
      const eventMetadata = HOOK_EVENT_METADATA.find(
        (item) => item.event === event
      );
      const id =
        `notifications.events.hookEvents.${event}` as HookEventSettingKey;
      return [
        id,
        {
          id,
          path: id,
          tab: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
          label: meta.label,
          description: eventMetadata?.description,
        },
      ];
    })
  ) as Record<HookEventSettingKey, SettingsCatalogEntry>;
}

export const SETTINGS_CATALOG = {
  ...STATIC_SETTINGS_CATALOG,
  ...defaultsModelEntries,
  ...defaultsArgsEntries,
  ...harnessColorEntries,
  ...statusLineEntries,
  ...buildHookEventEntries(),
} as const satisfies Record<string, SettingsCatalogEntry>;
export type SettingsCatalogKey = keyof typeof SETTINGS_CATALOG;
export const SETTINGS_CATALOG_ENTRIES: readonly SettingsCatalogEntry[] =
  Object.values(SETTINGS_CATALOG);
export function settingLabel(key: SettingsCatalogKey): string {
  return SETTINGS_CATALOG[key].label;
}
