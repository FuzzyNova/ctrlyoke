import {
  GLOBAL_SETTINGS_TABS,
  type GlobalSettingsTab,
} from "@root/types/DashboardConstants";

export interface SettingsTab {
  id: GlobalSettingsTab;
  label: string;
  icon: string;
  devOnly?: boolean;
}

export const ALL_TABS = [
  // Core
  {
    id: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "General",
    icon: "codicon-settings",
  },
  {
    id: GLOBAL_SETTINGS_TABS.WORKFLOW,
    label: "Workflow Defaults",
    icon: "codicon-globe",
  },
  // Execution
  {
    id: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Execution",
    icon: "codicon-play",
  },
  {
    id: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Queue",
    icon: "codicon-list-ordered",
  },
  {
    id: GLOBAL_SETTINGS_TABS.WORKTREES,
    label: "Worktrees",
    icon: "codicon-worktree-compact",
  },
  {
    id: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Coordination",
    icon: "codicon-organization",
  },
  // Output
  {
    id: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Terminal",
    icon: "codicon-terminal",
  },
  {
    id: GLOBAL_SETTINGS_TABS.STATUS_LINE,
    label: "Status Line",
    icon: "codicon-list-flat",
  },
  {
    id: GLOBAL_SETTINGS_TABS.COMMIT,
    label: "Commit Message",
    icon: "codicon-git-commit",
  },
  // Security
  {
    id: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Advanced Permissions",
    icon: "codicon-shield",
  },
  { id: GLOBAL_SETTINGS_TABS.SECRETS, label: "Secrets", icon: "codicon-lock" },
  // Integrations
  { id: GLOBAL_SETTINGS_TABS.SERVER, label: "Server", icon: "codicon-server" },
  {
    id: GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER,
    label: "Agent & Skills Manager",
    icon: "codicon-agent",
  },
  {
    id: GLOBAL_SETTINGS_TABS.MCP_MANAGER,
    label: "MCP Manager",
    icon: "codicon-mcp",
  },
  {
    id: GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS,
    label: "Language Servers",
    icon: "codicon-symbol-class",
  },
  // Insights
  {
    id: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Notifications",
    icon: "codicon-bell",
  },
  {
    id: GLOBAL_SETTINGS_TABS.STATS,
    label: "Stats & Usage",
    icon: "codicon-graph",
  },
  // Account
  { id: GLOBAL_SETTINGS_TABS.LICENSE, label: "License", icon: "codicon-key" },
  // Developer (dev builds only)
  {
    id: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Developer",
    icon: "codicon-tools",
    devOnly: true,
  },
] as const satisfies readonly SettingsTab[];

export type { GlobalSettingsTab };
