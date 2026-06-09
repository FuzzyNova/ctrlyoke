# MCP Manager Page Plan

## Problem Statement

MCP server management is currently split across two places:

- **McpServersEditor** (in `PropertiesDrawer` + `WorkflowPropertiesPanel`) handles discovery, registry browsing, workspace registry, and per-workflow enable/disable all in one component. It's ~1700 lines and does too much.
- **McpDiscoveryUtils** has solid discovery logic but it's only wired to the properties panel flow, making setup cumbersome per-context rather than once per workspace.

The goal is a dedicated **MCP Manager** settings tab — a central location for installing, discovering, and exporting MCP servers — so property panels can shrink to what they should be: a simple enable/disable list against the installed registry.

---

## Recommendation: Single-Source the Manager

Move discovery + registry browsing + harness export to the new `McpManagerSection` settings tab. Strip those concerns out of `McpServersEditor`. Four reasons:

1. **Property panels are context-scoped.** They answer "what servers are active for this prompt/workflow?" — not "where do I find or install new servers?"
2. **Discovery and installation are one-time setup actions.** You scan local configs and browse the registry when setting up a workspace, not every time you edit a prompt.
3. **The installed registry is the right shared abstraction.** Once a server is in the FlightPath registry (user or workspace scope), any prompt/workflow can enable it with a single checkbox.
4. **McpServersEditor is already too large.** Removing discovery cuts it to ~400 lines.

---

## Registry Model — Two Scopes, Two Files

FlightPath maintains its own MCP server registry in JSON files, parallel to how agents and skills work:

| Scope         | File                             | Availability               |
| ------------- | -------------------------------- | -------------------------- |
| **Workspace** | `.flightpath/mcp/servers.json`   | Current project only       |
| **User**      | `~/.flightpath/mcp/servers.json` | All projects for this user |

These files store `McpServerConfig[]` — the same type already used throughout the codebase. The registry is the **library of known servers**. It is entirely separate from which servers are **enabled by default** on new workflows.

### Registry vs. Global Default — The Distinction

| Concept                      | Storage                                            | Meaning                                            |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| **Installed**                | `.flightpath/mcp/servers.json` (workspace or user) | "I know about this server and can enable it"       |
| **Enabled by default**       | `flightpath.mcpServers` VS Code setting            | "New workflows start with these servers active"    |
| **Prompt/workflow override** | `mcpServers` in the YAML/working file              | "This specific context uses exactly these servers" |

The MCP Manager manages the **installed registry**. The **global default** (`flightpath.mcpServers`) is already editable in `WorkflowDefaultsSection` via the stripped `McpServersEditor`. The MCP Manager tab shows installed servers and lets you toggle "enabled by default" as a convenience.

---

## Architecture Overview

```
McpManagerSection (new settings tab: "MCP Manager")
├── Installed Servers Panel
│   ├── Scope switcher: Workspace | User (mirrors AgentSkillsManagerSection)
│   ├── Server list with:
│   │     — expand chevron (read-only detail view)
│   │     — "default" badge if in globalSettings.mcpServers
│   │     — edit button → inline edit form
│   │     — remove button (from this scope's registry file)
│   ├── "Add Server" dashed button → inline add form
│   └── Bulk actions bar: "Export All to harness…" flyout
│
├── Discover & Import Panel (tabbed)
│   ├── "Local configs" tab
│   │     — auto-scan on first open, re-scan button
│   │     — results grouped by source (vscode-workspace, claude-workspace,
│   │       vscode-user, claude-user)
│   │     — Import button per entry → adds to selected scope registry file
│   └── "Browse registry" tab
│         — search input (debounced 500ms, server-side)
│         — sort: A–Z | Z–A | Recently Updated
│         — paginated result list
│         — Add button per entry → adds to selected scope registry file
│
└── Export to Harness Panel
    — FlyoutActionDropdown (two-level: Workspace / User scopes, available harnesses)
    — Writes installed servers to target harness config file
    — Shows resolved destination path in item description

McpServersEditor (stripped — property panels only)
├── Mode selector: Default | Custom (prompt level; omitted at workflow level)
├── FlightPath built-in toggle + per-tool checkboxes
└── Installed Servers checklist (merged workspace + user registry)
    — checkbox = server is included in this prompt/workflow's mcpServers value
    — read-only detail expand, no edit (edit lives in the Manager)
    — hint: "Install servers in Settings → MCP Manager"
    — NO discovery tabs, NO registry browser, NO local scan
```

---

## Data Flow

```
Extension host (Node.js)
  McpRegistryFileManager (new)  — reads/writes .flightpath/mcp/servers.json files
  McpDiscoveryUtils (existing)  — local config scan + registry fetch, no changes
  HarnessMcpExporter (new)      — writes McpServerConfig[] to harness config files

Webview → Extension messages (new)
  REQUEST_MCP_REGISTRY_SERVERS  — load both workspace + user registry files
  SAVE_MCP_REGISTRY_SERVER      — add/update a server in workspace or user file
  DELETE_MCP_REGISTRY_SERVER    — remove a server from workspace or user file
  REQUEST_MCP_LOCAL_SCAN        — trigger discovery scan
  REQUEST_MCP_REGISTRY_SEARCH   — fetch a page from registry.modelcontextprotocol.io
  EXPORT_MCP_TO_HARNESS         — write servers to harness config file

Extension → Webview messages (new)
  MCP_REGISTRY_SERVERS_UPDATE   — ManagedMcpServer[] (merged + annotated list)
  MCP_LOCAL_SCAN_RESULT         — LocalMcpServerEntry[] + optional error
  MCP_REGISTRY_SEARCH_RESULT    — RegistryMcpEntry[], nextCursor, optional error
```

---

## New Types

### ManagedMcpServer (analogous to ManagedFile in HarnessFileManager)

```typescript
interface ManagedMcpServer {
  /** Unique server id — the McpServerConfig.id field */
  id: string;
  /** Display name (id for custom servers, entry.name for registry imports) */
  displayName: string;
  /** The server config — taken from first found location (workspace preferred) */
  config: McpServerConfig;
  /** Which registry scopes this server appears in */
  locations: Array<{
    scope: "workspace" | "user";
    path: string; // resolved file path for display
  }>;
}
```

`McpRegistryFileManager` reads both files, merges by id (workspace wins on conflict), and returns `ManagedMcpServer[]`.

---

## Phase 1 — Backend: McpRegistryFileManager + HarnessMcpExporter + Messages

### McpConfigPaths.ts (new, extracted from McpDiscoveryUtils)

Extract `getVscodeUserMcpConfigPath()` and `getClaudeUserConfigPath()` into a shared utility so both `McpDiscoveryUtils` and `HarnessMcpExporter` import from the same source.

Add FlightPath-specific paths:

```typescript
function getFlightpathWorkspaceMcpRegistryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".flightpath", "mcp", "servers.json");
}

function getFlightpathUserMcpRegistryPath(): string {
  return path.join(os.homedir(), ".flightpath", "mcp", "servers.json");
}
```

### McpRegistryFileManager.ts (new)

```typescript
export class McpRegistryFileManager {
  constructor(private workspaceRoot: string) {}

  async readAll(): Promise<ManagedMcpServer[]>;
  async addOrUpdate(
    server: McpServerConfig,
    scope: "workspace" | "user"
  ): Promise<void>;
  async remove(id: string, scope: "workspace" | "user"): Promise<void>;
  async readScope(scope: "workspace" | "user"): Promise<McpServerConfig[]>;
}
```

Uses atomic JSON write (read → merge → write) to avoid clobbering concurrent edits. Creates the directory (`mkdir -p`) if it doesn't exist. On `readAll()` merges workspace + user, workspace wins on id collision, annotates each entry with its `locations`.

### HarnessMcpExporter.ts (new)

Writes servers to harness-specific config files. Export targets parallel `McpDiscoveryUtils`'s discovery sources:

| Target ID            | File                   | Top-level key | Entry format                              |
| -------------------- | ---------------------- | ------------- | ----------------------------------------- |
| `claude` / workspace | `.mcp.json`            | `mcpServers`  | `{ command, args?, env? }`                |
| `claude` / user      | `~/.claude.json`       | `mcpServers`  | same                                      |
| `vscode` / workspace | `.vscode/mcp.json`     | `servers`     | `{ type: "stdio", command, args?, env? }` |
| `vscode` / user      | platform user mcp.json | `servers`     | same                                      |

Remote (http/sse) servers are skipped for all targets (log a warning). The export merges into the existing file rather than overwriting: existing entries with the same id are updated, new entries are appended. Creates parent directories if absent.

### New message type constants in DashboardConstants.ts

```
REQUEST_MCP_REGISTRY_SERVERS
SAVE_MCP_REGISTRY_SERVER
DELETE_MCP_REGISTRY_SERVER
REQUEST_MCP_LOCAL_SCAN
REQUEST_MCP_REGISTRY_SEARCH
EXPORT_MCP_TO_HARNESS
MCP_REGISTRY_SERVERS_UPDATE
MCP_LOCAL_SCAN_RESULT
MCP_REGISTRY_SEARCH_RESULT
```

### New payload types in WebviewMessageTypes.ts

```typescript
// webview → extension
SaveMcpRegistryServerMessage:   { server: McpServerConfig; scope: "workspace" | "user" }
DeleteMcpRegistryServerMessage: { id: string; scope: "workspace" | "user" }
RequestMcpRegistrySearchMessage: { query: string; cursor?: string; updatedSince?: string }
ExportMcpToHarnessMessage:      { servers: McpServerConfig[]; targetId: AnyTargetId; scope: SettingWriteScope }

// extension → webview
McpRegistryServersUpdateMessage: { servers: ManagedMcpServer[] }
McpLocalScanResultMessage:       { servers: LocalMcpServerEntry[]; error?: string }
McpRegistrySearchResultMessage:  { servers: RegistryMcpEntry[]; nextCursor?: string; error?: string }
```

### FlightPathWebviewProvider.ts

Add message handlers:

- `REQUEST_MCP_REGISTRY_SERVERS` → `McpRegistryFileManager.readAll()` → broadcast `MCP_REGISTRY_SERVERS_UPDATE`
- `SAVE_MCP_REGISTRY_SERVER` → `McpRegistryFileManager.addOrUpdate()` → re-broadcast updated list
- `DELETE_MCP_REGISTRY_SERVER` → `McpRegistryFileManager.remove()` → re-broadcast
- `REQUEST_MCP_LOCAL_SCAN` → `safeDiscoverLocalMcpServers()` → broadcast `MCP_LOCAL_SCAN_RESULT`
- `REQUEST_MCP_REGISTRY_SEARCH` → `safeFetchMcpRegistry()` → broadcast `MCP_REGISTRY_SEARCH_RESULT`
- `EXPORT_MCP_TO_HARNESS` → `HarnessMcpExporter.export()` → no response (errors shown via toast)

---

## Phase 2 — Webview Store: useMcpManagerStore

**New file**: `src/ui/webview-react/store/useMcpManagerStore.ts`

```typescript
interface McpManagerState {
  // Installed registry (merged workspace + user)
  managedServers: ManagedMcpServer[] | undefined;
  isLoadingRegistry: boolean;

  // Active scope for add/import operations
  activeScope: "workspace" | "user";

  // Local discovery
  localServers: LocalMcpServerEntry[];
  isLoadingLocal: boolean;
  localError: string | undefined;

  // Remote registry browser
  remoteServers: RegistryMcpEntry[] | undefined;
  isLoadingRemote: boolean;
  remoteError: string | undefined;
  remoteNextCursor: string | undefined;
  remotePageCursors: (string | undefined)[];
  remoteQuery: string;
  remoteSort: "a-z" | "z-a" | "recently-updated";

  // Active discovery tab
  discoveryTab: "local" | "registry";
}
```

Actions: `requestServers()`, `addOrUpdateServer(server, scope)`, `deleteServer(id, scope)`, `setActiveScope(scope)`, `requestLocalScan()`, `searchRemoteRegistry(query, cursor?, updatedSince?)`, `goNextPage()`, `goPrevPage()`, `resetPages()`, `exportToHarness(servers, targetId, scope)`.

**Also**: Remove from `uiStore`: `mcpDiscoveryTab`, `mcpLocalServers`, `mcpRegistryServers`, `mcpRegistryQuery`, `mcpRegistryNextCursor`, `mcpRegistryPageCursors`, `mcpWorkspaceServers` — all now owned by `useMcpManagerStore`. Do this cleanup in Phase 4 alongside stripping `McpServersEditor`, not in Phase 2, to avoid breaking the property panel flow mid-implementation.

---

## Phase 3 — McpManagerSection component

**New file**: `src/ui/webview-react/components/settings/McpManagerSection.tsx`

Modeled after `AgentSkillsManagerSection` in structure and styling conventions. No props — reads from `useMcpManagerStore` and `useSettingsStore` (for `globalSettings.mcpServers`), dispatches via `sendMessage`.

### Scope switcher

```
[Workspace]  [User]    ← fp-mode-switch, same as AgentSkillsManagerSection's type switcher
```

The active scope drives where new servers are saved and which registry file is shown (though both scopes' servers always appear in the merged list, differentiated by scope badge).

### Server list item

Each `ManagedMcpServer` row shows:

- Scope badge(s) — `workspace` or `user` or both, styled like `HarnessBadge`
- "default" badge — if the server id appears in `globalSettings.mcpServers`
- Expand chevron → read-only detail panel (command/url, args, env keys, transport)
- Edit button → inline edit form (same `McpServerForm` component)
- Remove button → remove from its scope(s); if in both, show scope picker

### "Default" toggle

Clicking the "default" badge toggles whether the server appears in `globalSettings.mcpServers`. Posts `UPDATE_GLOBAL_SETTING` for path `mcpServers`. This is the same message `WorkflowDefaultsSection` uses — no new plumbing required.

### Add Server form

Uses the extracted `McpServerForm` shared component. The scope selector in the add form defaults to `activeScope`.

### Export to Harness

```
[Export All to Harness ▾]   ← FlyoutActionDropdown, two groups: Workspace / User
```

Items show the target's resolved file path as the description (same UX as AgentSkillsManagerSection's Save flyout). Only shows harnesses where the path is resolvable. Confirmation step: after selection, show a small confirmation row with the destination path before committing.

For the `flightpath` scope targets (workspace and user registry files), Export is a no-op description here — those _are_ the registry files. Only external harness targets (claude, vscode) appear in the flyout.

### Discover & Import panel

Tab bar: "Local configs" | "Browse registry"

**Local configs tab**: auto-scans on first open (sends `REQUEST_MCP_LOCAL_SCAN` if `localServers` is empty and not loading). Re-scan button. Results grouped by source label. Import button → `addOrUpdateServer(server, activeScope)`. Disabled if id already in registry.

**Browse registry tab**: search input (debounced 500ms), sort controls, paginated list with verified badges, Add button → `addOrUpdateServer(server, activeScope)`. Disabled if id already in registry. All behavior matches current `McpServersEditor` registry tab — just relocated.

### McpServerForm.tsx (new shared component)

Extract the add/edit form (~150 lines of JSX) from `McpServersEditor` into `src/ui/webview-react/components/shared/McpServerForm.tsx`. Props:

```typescript
interface McpServerFormProps {
  value: AddServerForm;
  onChange: (updated: AddServerForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: "Add" | "Save";
}
```

Both `McpManagerSection` and the stripped `McpServersEditor` import this.

---

## Phase 4 — Strip McpServersEditor

**Remove from McpServersEditor:**

- All discovery props (`onRequestLocalServers`, `onSearchRegistry`, `localServers`, `isLoadingLocal`, `localServersError`, `registryServers`, `isLoadingRegistry`, `registryError`, `fillHeight`)
- All workspace registry props (`onRequestWorkspaceServers`, `onWorkspaceServersChange`, `workspaceServers`, `isLoadingWorkspaceServers`)
- The entire Discovery section JSX (~350 lines): tabs, local results panel, registry results panel, pagination
- Internal state: `discoveryTab`, `registryQuery`, `registrySort`, `searchDebounceRef`, `discoveryPanelRef`, `shouldFill`, `registryPageNumber`, etc.

**McpServersEditor now reads from `useMcpManagerStore`** for the server checklist instead of taking `workspaceServers` as a prop. It shows the merged `managedServers` list — same data the MCP Manager shows, just as checkboxes not an editable list.

**What stays in McpServersEditor (~400 lines):**

- Mode selector buttons (Default / Custom) when `showDefault=true`
- Default mode: grayed read-only view of inherited value
- Custom mode:
  - FlightPath built-in toggle + per-tool checkboxes
  - Installed Servers checklist (from `useMcpManagerStore.managedServers`)
  - Scope badges on each item
  - Read-only expand (no edit button — edit is in Manager)
  - Empty state: "No servers installed. Add servers in Settings → MCP Manager."

**Call sites to update:**

- `WorkflowPropertiesPanel.tsx` — remove all discovery prop passing
- `PropertiesDrawer.tsx` — remove all discovery prop passing
- (`McpHooksSection` no longer exists — no action needed)

**Remove from `uiStore`:** `mcpDiscoveryTab`, `mcpLocalServers`, `mcpRegistryServers`, `mcpRegistryQuery`, `mcpRegistryNextCursor`, `mcpRegistryPageCursors`, `mcpRegistryGoNextPage`, `mcpRegistryGoPrevPage`, `resetMcpRegistryPages`, `mcpWorkspaceServers`.

---

## Phase 5 — GlobalSettingsDrawer wiring

Add tab to `ALL_TABS` in `GlobalSettingsDrawer.tsx`, **after** `agentskillsmanager` and **before** `commit`:

```typescript
{ id: "mcpmanager", label: "MCP Manager", icon: "codicon-plug" },
```

Add the render branch in the drawer body (same pattern as `agentskillsmanager` — no `fullSettings` required):

```tsx
{
  effectiveActiveTab === "mcpmanager" && <McpManagerSection />;
}
```

Update the `!fullSettings` loading guard to also exclude `"mcpmanager"` (alongside `"agentskillsmanager"` and `"developer"`).

Add `McpManagerSection` to the barrel export in `components/settings/index.ts`.

---

## File Changelist

### New files

| File                                                             | Purpose                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/utils/McpConfigPaths.ts`                                    | Shared path helpers extracted from McpDiscoveryUtils         |
| `src/utils/McpRegistryFileManager.ts`                            | Read/write `.flightpath/mcp/servers.json` (workspace + user) |
| `src/utils/HarnessMcpExporter.ts`                                | Merge-write McpServerConfig[] into harness config files      |
| `src/ui/webview-react/store/useMcpManagerStore.ts`               | Zustand store for all MCP Manager state                      |
| `src/ui/webview-react/components/shared/McpServerForm.tsx`       | Extracted add/edit server form (stdio + remote tabs)         |
| `src/ui/webview-react/components/settings/McpManagerSection.tsx` | Main MCP Manager settings tab                                |

### Modified files

| File                                                                 | Change                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                    | Add 9 new MCP\_\* message type constants                        |
| `src/types/WebviewMessageTypes.ts`                                   | Add `ManagedMcpServer` type + 7 new payload interfaces          |
| `src/utils/McpDiscoveryUtils.ts`                                     | Import path helpers from McpConfigPaths.ts (DRY cleanup)        |
| `src/ui/FlightPathWebviewProvider.ts`                                | Wire 6 new message handlers; instantiate McpRegistryFileManager |
| `src/ui/webview-react/store/uiStore.ts`                              | Remove mcp\* fields (moved to useMcpManagerStore)               |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                    | Add handlers for 3 new extension→webview messages               |
| `src/ui/webview-react/components/shared/McpServersEditor.tsx`        | Remove discovery; read registry from useMcpManagerStore         |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Remove discovery prop wiring                                    |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`        | Remove discovery prop wiring                                    |
| `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx`    | Add mcpmanager tab + render branch                              |
| `src/ui/webview-react/components/settings/index.ts`                  | Export McpManagerSection                                        |

---

## Implementation Order

1. **Phase 1** — `McpConfigPaths.ts` → `McpRegistryFileManager.ts` → `HarnessMcpExporter.ts` → message types → `WebviewProvider` handlers. Backend only, zero UI changes.
2. **Phase 2** — `useMcpManagerStore.ts` + message handler additions. No UI yet; `McpServersEditor` still uses its own props.
3. **Phase 3** — `McpServerForm.tsx` + `McpManagerSection.tsx` + settings tab wiring. End-to-end testable.
4. **Phase 4** — Strip `McpServersEditor`, remove `uiStore` fields, update `WorkflowPropertiesPanel` and `PropertiesDrawer` call sites. Verify property panels work.
5. **Phase 5** — Polish: export confirmation, empty-state copy, scope-badge display, edge case handling (conflicting ids across scopes, remote-server export skipping).

---

## What the Property Panels Look Like After

**PropertiesDrawer MCP tab** and **WorkflowPropertiesPanel**:

- FlightPath built-in toggle + per-tool checkboxes
- Merged installed server checklist (workspace + user, with scope badges)
- "Install servers in Settings → MCP Manager" hint when list is empty
- No search, no browser, no import buttons

This makes the MCP tab a ~20-line wrapper around the stripped `McpServersEditor`.

---

## Open Questions

1. **Conflicting ids across scopes** — If the same server id exists in both workspace and user registry files, workspace wins on config. Show both scope badges on the row, and the Remove action prompts "Remove from Workspace / User / Both."

2. **Export merge vs. replace** — `HarnessMcpExporter` merges into existing files (update same-id entries, append new ones) rather than replacing. This is safer but may leave stale entries the user removed from the FlightPath registry. Consider a "replace" mode behind a secondary action.

3. **Harness-specific MCP quirks** — Phase 1 targets claude (`.mcp.json`) and vscode (`.vscode/mcp.json`) only — the formats McpDiscoveryUtils already understands. gemini-cli, opencode-cli, codex-cli can be added in follow-up work once their config formats are confirmed.

4. **`.flightpath/mcp/` gitignore** — Workspace registry (`servers.json`) should generally be committed alongside workflow files. User registry (`~/.flightpath/mcp/`) is never in the repo. No gitignore changes needed.
