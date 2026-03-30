export const DRAWER_PAGES = {
  HARNESS: "harness",
  CONTEXT: "context",
  VALIDATION: "validation",
  MCP: "mcp",
  HOOKS: "hooks",
  PERMISSIONS: "permissions",
} as const;

export type DrawerPage = (typeof DRAWER_PAGES)[keyof typeof DRAWER_PAGES];

export interface DrawerTab {
  id: DrawerPage;
  label: string;
  /** codicon name (e.g. "book", "coverage", "mcp"). Omit for the Harness tab which uses HarnessIcon. */
  codicon?: string;
  /** Tab is visible but shows "Coming Soon" placeholder content */
  placeholder?: boolean;
}

export const DRAWER_TABS: DrawerTab[] = [
  { id: "harness", label: "Harness" },
  { id: "context", label: "Context", codicon: "book" },
  { id: "validation", label: "Validation", codicon: "coverage" },
  { id: "mcp", label: "MCP", codicon: "mcp" },
  { id: "hooks", label: "Hooks", codicon: "symbol-event" },
  {
    id: "permissions",
    label: "Permissions",
    codicon: "workspace-trusted",
  },
];
