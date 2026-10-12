import {
  GLOBAL_SETTINGS_TABS,
  HARNESS_IDS,
  HARNESS_INFO,
  STATUS_LINE_HARNESS_IDS,
  HOOK_EVENT_NAMES,
  HOOK_EVENT_METADATA,
  WORKTREE_KEEP_HELP_TEXT,
  type HarnessId,
  type StatusLineHarnessId,
  type HookEvent,
} from "@root/types/DashboardConstants";
import { HOOK_EVENT_OPTIONS_META } from "@root/types/SchemaUiMetadata";
import { SCHEMA_DESCRIPTIONS } from "@root/types/generated/SchemaDescriptions";
import type { GlobalSettingsTab } from "./settingsTabs";
import { DRAWER_PAGES, type DrawerPage } from "@/types/drawerPages";

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
  "landmark:templates.tab": {
    id: "landmark:templates.tab",
    tab: GLOBAL_SETTINGS_TABS.TEMPLATES,
    label: "Templates",
    description: "Browse templates and manage saved variable values.",
    keywords: ["template", "saved value", "default"],
  },
  "landmark:templates.savedValues": {
    id: "landmark:templates.savedValues",
    tab: GLOBAL_SETTINGS_TABS.TEMPLATES,
    label: "Saved variable values",
    description:
      "Values pre-filled when you create a workflow from a template.",
    keywords: ["template", "saved value", "defaults"],
  },
  "general.defaultTemplate": {
    id: "general.defaultTemplate",
    path: "general.defaultTemplate",
    tab: GLOBAL_SETTINGS_TABS.TEMPLATES,
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
  "ui.outputFontSize": {
    id: "ui.outputFontSize",
    path: "ui.outputFontSize",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Output font size",
    keywords: ["text size", "zoom"],
  },
  "ui.editorFontSize": {
    id: "ui.editorFontSize",
    path: "ui.editorFontSize",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Editor font size",
    keywords: ["text size", "zoom", "prompt editor", "retry prompt"],
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
  "ui.wordWrap": {
    id: "ui.wordWrap",
    path: "ui.wordWrap",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Wrap long lines in code views",
  },
  "ui.atomicContextReferences": {
    id: "ui.atomicContextReferences",
    path: "ui.atomicContextReferences",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Atomic context references",
    description:
      "In the prompt editor, treat @file, #symbol, ~git, and $context references as single units: arrow keys skip over them and Backspace/Delete removes the whole reference at once. In output, format clickable local references as compact chips. Clicking or tapping a chip opens it, and right-clicking or long-pressing it offers Go to Reference, Copy Reference, and Send as Plain Text; when off, editor references edit character by character and output uses ordinary text links.",
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
    description:
      "Per workflow. Starting a new run permanently deletes that workflow's oldest runs, definition and output together.",
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
  "history.recentlyDeleted": {
    id: "history.recentlyDeleted",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Recently deleted",
    description:
      "Deleted runs and workflows, which you can restore until they expire.",
    keywords: ["trash", "restore", "undo delete", "deleted runs"],
  },
  "storage.trashRetentionDays": {
    id: "storage.trashRetentionDays",
    path: "storage.trashRetentionDays",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Keep deleted items (days)",
    keywords: ["trash", "recently deleted", "retention", "undo delete"],
  },
  "history.clearAll": {
    id: "history.clearAll",
    tab: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "Clear all history",
    description:
      "Moves every workflow and run in this project to Recently deleted. Running workflows are kept.",
    keywords: ["clear history", "delete all", "wipe", "remove history"],
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
    description:
      "Automatically close the terminal when a workflow completes. Turns off inject mode.",
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
      "Show notification popups in the VS Code window when workflows and steps complete, and for hook events.",
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
  "permissions.trustedExternalRoots": {
    id: "permissions.trustedExternalRoots",
    path: "permissions.trustedExternalRoots",
    tab: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Trusted external roots",
  },
  "ui.offerTrustForUntrustedFileLinks": {
    id: "ui.offerTrustForUntrustedFileLinks",
    path: "ui.offerTrustForUntrustedFileLinks",
    tab: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Offer trust for untrusted file links",
    description:
      "Allow an AI-generated file link outside trusted roots to offer a Trust Parent Folder action. When off, untrusted links are still blocked outright — this only controls whether the offer appears.",
  },
  "permissions.codexSandboxMode": {
    id: "permissions.codexSandboxMode",
    path: "permissions.codexSandboxMode",
    tab: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Sandbox mode",
    context: "Codex",
  },
  "permissions.codexApprovalPolicy": {
    id: "permissions.codexApprovalPolicy",
    path: "permissions.codexApprovalPolicy",
    tab: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Approval policy",
    context: "Codex",
  },
  "server.autoStart": {
    id: "server.autoStart",
    path: "server.autoStart",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Auto Start",
    description:
      "Automatically start the hosted dashboard server when the VS Code extension activates.",
  },
  "server.displayAddress": {
    id: "server.displayAddress",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Connect via",
    keywords: ["server IP", "connection address"],
  },
  "server.port": {
    id: "server.port",
    path: "server.port",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Server port",
  },
  "server.fallbackPorts": {
    id: "server.fallbackPorts",
    path: "server.fallbackPorts",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Fallback ports",
    description:
      "If the server port above is already taken, ctrlyoke tries these ports in order before falling back to a random one. Useful for a stable, bookmarkable URL when the server port is often taken by another ctrlyoke window.",
  },
  "server.bindAddress": {
    id: "server.bindAddress",
    path: "server.bindAddress",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Bind address",
  },
  "server.iconBgColor": {
    id: "server.iconBgColor",
    path: "server.iconBgColor",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Background",
  },
  "server.iconFgColor": {
    id: "server.iconFgColor",
    path: "server.iconFgColor",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Foreground",
  },
  "server.tls.enabled": {
    id: "server.tls.enabled",
    path: "server.tls.enabled",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Enable HTTPS",
  },
  "server.tls.certPath": {
    id: "server.tls.certPath",
    path: "server.tls.certPath",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Certificate file (.pem)",
    revealedBy: "server.tls.enabled",
  },
  "server.tls.keyPath": {
    id: "server.tls.keyPath",
    path: "server.tls.keyPath",
    tab: GLOBAL_SETTINGS_TABS.SERVER,
    label: "Private key file (.pem)",
    revealedBy: "server.tls.enabled",
  },
  "permissions.heuristicSecretRedactionEnabled": {
    id: "permissions.heuristicSecretRedactionEnabled",
    path: "permissions.heuristicSecretRedactionEnabled",
    tab: GLOBAL_SETTINGS_TABS.SECRETS,
    label: "Heuristic secret redaction",
    description:
      "The exact values of the secrets listed above are always redacted from logs, transports, exports, and history — this cannot be turned off. This setting adds broader pattern-based redaction (e.g. token=..., Bearer ..., private-key blocks) that also catches credentials ctrlyoke was never told about. Turn it off if those patterns are over-matching and corrupting legitimate output, such as code samples or public identifiers that merely look like credentials.",
  },
  "statusLine.useDifferentFormatPerHarness": {
    id: "statusLine.useDifferentFormatPerHarness",
    path: "statusLine.useDifferentFormatPerHarness",
    tab: GLOBAL_SETTINGS_TABS.STATUS_LINE,
    label: "Use a different status line format per harness",
  },
  "usageTracking.enabled": {
    id: "usageTracking.enabled",
    path: "usageTracking.enabled",
    tab: GLOBAL_SETTINGS_TABS.STATS,
    label: "Track harness usage",
    description:
      "Watch ctrlyoke-started harness sessions and record their token, cost, and quota usage. Applies machine-wide, across all your workspaces.",
  },
  "usageTracking.providerRefreshEnabled": {
    id: "usageTracking.providerRefreshEnabled",
    path: "usageTracking.providerRefreshEnabled",
    tab: GLOBAL_SETTINGS_TABS.STATS,
    label: "Refresh quota from provider",
    description:
      "Actively check each harness's CLI for your current quota and rate-limit usage, so the numbers on this page stay up to date.",
    revealedBy: "usageTracking.enabled",
  },
  "usageTracking.persistObservedUsage": {
    id: "usageTracking.persistObservedUsage",
    path: "usageTracking.persistObservedUsage",
    tab: GLOBAL_SETTINGS_TABS.STATS,
    label: "Save usage history",
    description:
      "Keep a running record of usage with this project's run history so totals and stats survive restarts. Off keeps usage in memory for this session only.",
    revealedBy: "usageTracking.enabled",
  },
  "landmark:stats:model-pricing": {
    id: "landmark:stats:model-pricing",
    tab: GLOBAL_SETTINGS_TABS.STATS,
    label: "Model pricing overrides",
    keywords: ["token rates", "cost", "spend"],
  },
  modelPricing: {
    id: "modelPricing",
    path: "modelPricing",
    tab: GLOBAL_SETTINGS_TABS.STATS,
    label: "Rates",
  },
  "defaults.harness": {
    id: "defaults.harness",
    path: "defaults.harness",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Default harness",
  },
  "defaults.executionMode": {
    id: "defaults.executionMode",
    path: "defaults.executionMode",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Execution mode",
    description:
      "Where steps run by default. Interactive spawns a live terminal you can steer; headless runs in the background. Workflows and steps can override this. Pre/end-condition scripts always run headless.",
  },
  "defaults.worktree": {
    id: "defaults.worktree",
    path: "defaults.worktree",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Worktree mode",
    description: SCHEMA_DESCRIPTIONS["defaults.worktree"],
  },
  "defaults.worktree.branch": {
    id: "defaults.worktree.branch",
    path: "defaults.worktree.branch",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Branch",
    description: "Required local Git branch for the named default.",
  },
  "defaults.worktree.base": {
    id: "defaults.worktree.base",
    path: "defaults.worktree.base",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Base",
    description:
      "Optional Git ref used as the starting point for a new branch.",
    revealedBy: "defaults.worktree",
  },
  "defaults.worktree.setup": {
    id: "defaults.worktree.setup",
    path: "defaults.worktree.setup",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Setup",
    description:
      "Optional command run after creating a named worktree. Setup is outside step errorBehavior; a failure blocks the worktree and the next Run retries it.",
    revealedBy: "defaults.worktree",
  },
  "defaults.worktree.keep": {
    id: "defaults.worktree.keep",
    path: "defaults.worktree.keep",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Keep directory",
    description: WORKTREE_KEEP_HELP_TEXT,
  },
  "defaults.worktree.merge": {
    id: "defaults.worktree.merge",
    path: "defaults.worktree.merge",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Merge",
    description:
      "Merge is the only worktree option that writes to your live working checkout: it merges the managed branch into the working checkout after every run. The engine requires the captured target branch and a clean checkout, takes an exclusive lease, and aborts cleanly on conflict.",
    revealedBy: "defaults.worktree",
  },
  "defaults.agent": {
    id: "defaults.agent",
    path: "defaults.agent",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Default agent",
    description: "Agent to use when none is specified in the workflow.",
  },
  "defaults.skills": {
    id: "defaults.skills",
    path: "defaults.skills",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Default skills",
    description: "Skills to include in new workflows by default.",
  },
  "defaults.secrets": {
    id: "defaults.secrets",
    path: "defaults.secrets",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Default secrets",
    description:
      "Secret environment-variable names granted to new workflows by default.",
  },
  "defaults.resumeSession": {
    id: "defaults.resumeSession",
    path: "defaults.resumeSession",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "context",
    label: "Resume existing session",
    description: "Attempt to resume the most recent AI session.",
  },
  "defaults.priorContext": {
    id: "defaults.priorContext",
    path: "defaults.priorContext",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "context",
    label: "Prior Context",
    description: "How to handle prior context between prompts.",
  },
  "defaults.mcpServers": {
    id: "defaults.mcpServers",
    path: "defaults.mcpServers",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "mcp",
    label: "Default MCP servers",
    description:
      "MCP servers added here are available to all workflows by default.",
  },
  "defaults.hooks": {
    id: "defaults.hooks",
    path: "defaults.hooks",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "hooks",
    label: "Default hooks",
    description: "Hooks defined here run for all workflows by default.",
  },
  "defaults.toolPermissions.mode": {
    id: "defaults.toolPermissions.mode",
    path: "defaults.toolPermissions.mode",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "permissions",
    label: "Permission mode",
  },
  "defaults.toolPermissions.allowedTools": {
    id: "defaults.toolPermissions.allowedTools",
    path: "defaults.toolPermissions.allowedTools",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "permissions",
    label: "Allowed tools (one per line)",
  },
  "defaults.toolPermissions.deniedTools": {
    id: "defaults.toolPermissions.deniedTools",
    path: "defaults.toolPermissions.deniedTools",
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "permissions",
    label: "Denied tools (one per line)",
  },
  "landmark:mcp-manager:servers": {
    id: "landmark:mcp-manager:servers",
    tab: GLOBAL_SETTINGS_TABS.MCP_MANAGER,
    label: "MCP server",
    keywords: ["stdio", "http transport", "server catalog"],
  },
  "landmark:language-servers:servers": {
    id: "landmark:language-servers:servers",
    tab: GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS,
    label: "Language servers",
    keywords: [
      "LSP",
      "language intelligence",
      "completion",
      "catalog",
      "install",
    ],
  },
  "landmark:agent-skills:manager": {
    id: "landmark:agent-skills:manager",
    tab: GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER,
    label: "Agent & Skills Manager",
    keywords: ["agent", "skill", "subagent"],
  },
  "landmark:license:account": {
    id: "landmark:license:account",
    tab: GLOBAL_SETTINGS_TABS.LICENSE,
    label: "License",
    keywords: ["license key", "activation", "pro", "subscription"],
  },
  "landmark:secrets:grants": {
    id: "landmark:secrets:grants",
    tab: GLOBAL_SETTINGS_TABS.SECRETS,
    label: "Secrets",
    keywords: ["secret", "API key", "environment variable grant"],
  },
  "landmark:statusline:format": {
    id: "landmark:statusline:format",
    tab: GLOBAL_SETTINGS_TABS.STATUS_LINE,
    label: "Status line format",
    keywords: ["segment", "statusline format"],
  },
} as const;

type DefaultsModelKey = `defaults.models.${HarnessId}`;
type DefaultsArgsKey = `defaults.additionalArgs.${HarnessId}`;
type HarnessColorKey = `ui.harnessColors.byHarness.${HarnessId}`;
const STATUS_LINE_PROPERTY = {
  ENABLED: "enabled",
  CUSTOM_COMMAND: "customCommand",
  USE_CTRLYOKE_STYLE: "useCtrlyokeStyle",
  FORMAT: "format",
} as const;
type StatusLineProperty =
  (typeof STATUS_LINE_PROPERTY)[keyof typeof STATUS_LINE_PROPERTY];
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
    tab: GLOBAL_SETTINGS_TABS.WORKFLOW,
    page: "harness",
    label: "Harness step color",
    context: HARNESS_INFO[harnessId as HarnessId].name,
  })
);
const statusLineProperties = Object.values(STATUS_LINE_PROPERTY);
const statusLineEntries = Object.fromEntries(
  Object.values(STATUS_LINE_HARNESS_IDS).flatMap((harnessId) =>
    statusLineProperties.map((property) => {
      const id =
        `statusLine.byHarness.${harnessId}.${property}` as StatusLineKey;
      const labels: Record<StatusLineProperty, string> = {
        [STATUS_LINE_PROPERTY.ENABLED]: "Statusline tracking",
        [STATUS_LINE_PROPERTY.CUSTOM_COMMAND]: "Custom statusline command",
        [STATUS_LINE_PROPERTY.USE_CTRLYOKE_STYLE]:
          "Use ctrlyoke-style statusline",
        [STATUS_LINE_PROPERTY.FORMAT]: "Statusline format",
      };
      return [
        id,
        {
          id,
          path: id,
          tab: GLOBAL_SETTINGS_TABS.STATUS_LINE,
          label:
            property === STATUS_LINE_PROPERTY.ENABLED
              ? `Enable ${HARNESS_INFO[harnessId as HarnessId].name} statusline tracking`
              : labels[property],
          context: HARNESS_INFO[harnessId as HarnessId].name,
          ...(property === STATUS_LINE_PROPERTY.ENABLED
            ? {
                description: {
                  [HARNESS_IDS.CLAUDE_CLI]:
                    "Disabling Claude statusline tracking loses token/quota data.",
                  [HARNESS_IDS.ANTIGRAVITY_CLI]:
                    "Disabling Antigravity statusline tracking loses token/quota and context-window data.",
                  [HARNESS_IDS.COPILOT_CLI]:
                    "Disabling Copilot statusline tracking loses token and context-window data.",
                  [HARNESS_IDS.QWEN_CLI]:
                    "Disabling Qwen statusline tracking loses token and context-window data.",
                }[harnessId],
              }
            : {}),
          ...(property === STATUS_LINE_PROPERTY.CUSTOM_COMMAND
            ? {
                description:
                  "Command to run for statusline output. Leave empty to use ctrlyoke's statusline only.",
              }
            : {}),
          ...(property === STATUS_LINE_PROPERTY.USE_CTRLYOKE_STYLE
            ? {
                description:
                  "Show ctrlyoke's branded statusline. Turn off to show your custom command's output instead — or leave the statusline blank when no custom command is set. Usage tracking keeps collecting data either way.",
              }
            : {}),
          ...(property === STATUS_LINE_PROPERTY.CUSTOM_COMMAND ||
          property === STATUS_LINE_PROPERTY.USE_CTRLYOKE_STYLE
            ? { revealedBy: `statusLine.byHarness.${harnessId}.enabled` }
            : {}),
          ...(property === STATUS_LINE_PROPERTY.FORMAT
            ? { revealedBy: "statusLine.useDifferentFormatPerHarness" }
            : {}),
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
const workflowHarnessOrder = [
  "defaults.harness",
  ...Object.values(HARNESS_IDS).flatMap((harnessId) => [
    `defaults.models.${harnessId}`,
    `defaults.additionalArgs.${harnessId}`,
    `ui.harnessColors.byHarness.${harnessId}`,
  ]),
  "defaults.executionMode",
  "defaults.worktree",
  "defaults.worktree.branch",
  "defaults.worktree.base",
  "defaults.worktree.setup",
  "defaults.worktree.keep",
  "defaults.worktree.merge",
  "defaults.agent",
  "defaults.skills",
  "defaults.secrets",
];
const workflowHarnessRank = new Map(
  workflowHarnessOrder.map((id, index) => [id, index])
);
const allCatalogEntries = Object.values(SETTINGS_CATALOG);
const hookEventCatalogIds = Object.values(HOOK_EVENT_NAMES).map(
  (event) => `notifications.events.hookEvents.${event}`
);
const notificationOrder = [
  "notifications.vscode.enabled",
  "notifications.browser.mode",
  "notifications.events.workflowComplete",
  "notifications.events.promptComplete",
  ...hookEventCatalogIds,
  "notifications.includeWorkflowName",
  "notifications.includePromptName",
  "notifications.toastLevel",
  "notifications.onlyWhenWindowUnfocused",
];
const notificationIds = new Set(notificationOrder);
const notificationEntries = allCatalogEntries.filter((entry) =>
  notificationIds.has(entry.id)
);
const workflowHarnessEntries = allCatalogEntries.filter(
  (entry) =>
    entry.tab === GLOBAL_SETTINGS_TABS.WORKFLOW &&
    entry.page === DRAWER_PAGES.HARNESS
);
export const SETTINGS_CATALOG_ENTRIES: readonly SettingsCatalogEntry[] = [
  ...allCatalogEntries.filter(
    (entry) =>
      (entry.tab !== GLOBAL_SETTINGS_TABS.WORKFLOW ||
        entry.page !== DRAWER_PAGES.HARNESS) &&
      !notificationIds.has(entry.id)
  ),
  ...notificationOrder.flatMap((id) => {
    const entry = SETTINGS_CATALOG[id as keyof typeof SETTINGS_CATALOG];
    return entry ? [entry] : [];
  }),
  ...notificationEntries.filter((entry) => !notificationIds.has(entry.id)),
  ...workflowHarnessOrder.flatMap((id) => {
    const entry = SETTINGS_CATALOG[id as keyof typeof SETTINGS_CATALOG];
    return entry ? [entry] : [];
  }),
  ...workflowHarnessEntries.filter(
    (entry) => !workflowHarnessRank.has(entry.id)
  ),
];
export function settingLabel(key: SettingsCatalogKey): string {
  return SETTINGS_CATALOG[key].label;
}

const WORKTREE_MODE_DESCRIPTIONS = {
  named: {
    base: "Optional Git ref used as the starting point for a new branch.",
    setup:
      "Optional command run after creating a named worktree. Setup is outside step errorBehavior; a failure blocks the worktree and the next Run retries it.",
  },
  managed: {
    base: "Optional Git ref used as the starting point for a new managed worktree.",
    setup:
      "Optional command run after creating a managed worktree. Setup is outside step errorBehavior; a failure blocks the worktree and the next Run retries it.",
  },
} as const;

export function worktreeSettingDescription(
  mode: keyof typeof WORKTREE_MODE_DESCRIPTIONS,
  field: keyof (typeof WORKTREE_MODE_DESCRIPTIONS)["named"]
): string {
  return WORKTREE_MODE_DESCRIPTIONS[mode][field];
}
