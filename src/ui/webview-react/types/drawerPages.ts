export const DRAWER_PAGES = {
  HARNESS: "harness",
  CONTEXT: "context",
  VALIDATION: "validation",
  MCP: "mcp",
  HOOKS: "hooks",
  PERMISSIONS: "permissions",
} as const;

export type DrawerPage = (typeof DRAWER_PAGES)[keyof typeof DRAWER_PAGES];

/**
 * A persisted drawer page from another build may name a page that no longer
 * exists; fall back to the Harness page in that case.
 */
export function knownDrawerPageOrDefault(value: string): DrawerPage {
  return (Object.values(DRAWER_PAGES) as readonly string[]).includes(value)
    ? (value as DrawerPage)
    : DRAWER_PAGES.HARNESS;
}

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

/**
 * The title shown at the top of each drawer page. It differs from the tab
 * label where the page's first control already carries the tab's name (the
 * Harness dropdown), or where the title stands in for that control's label
 * (MCP Servers).
 */
const DRAWER_PAGE_TITLES: Record<DrawerPage, string> = {
  harness: "Harness Setup",
  context: "Context",
  validation: "Validation",
  mcp: "MCP Servers",
  hooks: "Hooks",
  permissions: "Permissions",
};

export function drawerPageTitle(page: DrawerPage): string {
  return DRAWER_PAGE_TITLES[page];
}

/** The same page's title in Settings → Workflow Defaults. */
export function drawerPageDefaultsTitle(page: DrawerPage): string {
  return `${DRAWER_PAGE_TITLES[page]} Defaults`;
}

/** Pages of Settings → Templates, switched by the page bar at its foot. */
export const TEMPLATES_PAGES = {
  DEFAULTS: "defaults",
  DISCOVER: "discover",
} as const;

export type TemplatesPage =
  (typeof TEMPLATES_PAGES)[keyof typeof TEMPLATES_PAGES];

export const TEMPLATES_TABS: readonly {
  id: TemplatesPage;
  label: string;
  codicon: string;
}[] = [
  { id: TEMPLATES_PAGES.DEFAULTS, label: "Defaults", codicon: "settings" },
  { id: TEMPLATES_PAGES.DISCOVER, label: "Discover", codicon: "globe" },
];
