# Settings Layout Mirror Plan

## Problem

FlightPath has a three-tier execution property system:

```
prompt-level → workflow-level → global defaults
```

The UI for tiers 1 and 2 both use `DrawerTabBar` with identical tab pages (Harness, Context, Validation, MCP, Hooks, Permissions). The global settings drawer (tier 3) uses a completely different layout — a vertical sidebar with separate sections (`WorkflowDefaultsSection`, `HarnessesSection`, `PermissionsSection`, `McpHooksSection`) — breaking the mental model.

Additionally, the current `settings-schema.json` is poorly organized: file-format and template settings are buried under `workflow`, execution-property defaults are scattered across `workflow`, `tools`, `mcp`, and root-level keys, and the `workflow` key contains settings that have nothing to do with workflow behavior.

## Proposed Solution

1. **Schema**: Introduce a top-level `general` section for truly general settings (format, template, UI behaviors). Move all execution-property defaults into a `defaults` object that mirrors `executionProperties` from the prompt schema. Delete the `workflow` key entirely — every setting it contained moves to either `general` or `defaults`. Delete the `mcp` key — its only field (`defaultServers`) moves to `defaults.mcpServers`. Rename `tools` to `permissions`, keeping only the harness-specific settings that have no per-prompt equivalent.

2. **UI**: Remove five left-nav entries and replace them with a single **"Workflow Defaults"** entry: `workflow`, `harnesses`, `permissions`, `mcp` (entirely — `McpHooksSection` has nothing left after its two settings move), and the defaults content previously split across these. The new entry renders a `DrawerTabBar` — the same six tabs used by the prompt drawer and workflow panel. Rename the remaining `permissions` tab to **"Advanced Permissions"** for the harness-specific settings that stay there.

## Why This Works

- Users learn one tab structure; it applies at all three tiers
- "Set as Default" buttons in the workflow panel map directly to the corresponding global tab
- The schema key names now match the `executionProperties` field names
- `general` in the schema corresponds to the "General" nav tab — no more hunting for format/template settings inside `workflow`

## Compatibility

**Clean break. No backwards compatibility.** Pre-release, single developer. Old setting paths are deleted outright — no deprecated aliases, no migration shims, no fallback reads. Any existing local `settings.json` files must be manually updated to the new layout.

---

## Part 1: Schema Restructuring (`settings-schema.json`)

### Current Structure (fragmented)

```
settings-schema.json:
├── harness                   ← execution default, at root
├── models                    ← execution default, at root
├── additionalArgs            ← execution default, at root
├── workflow/
│   ├── defaultFormat         ← not a workflow setting; belongs in general
│   ├── defaultTemplate       ← not a workflow setting; belongs in general
│   ├── defaultAgent          ← execution default; belongs in defaults
│   ├── defaultSkills         ← execution default; belongs in defaults
│   ├── resumeExistingSession ← execution default; belongs in defaults
│   ├── priorContext          ← execution default; belongs in defaults
│   ├── autoLoadRecentSession ← general behavior; → general
│   ├── omitAgentsSkillsOnResume ← general behavior; → general
│   ├── defaultEndCondition   ← execution default; belongs in defaults
│   └── defaultPreCondition   ← execution default; belongs in defaults
├── tools/                    ← split: common defaults → defaults; advanced → permissions
│   ├── permissionMode        ← execution default; → defaults.toolPermissions.mode
│   ├── allowed               ← execution default; → defaults.toolPermissions.allowedTools
│   ├── denied                ← execution default; → defaults.toolPermissions.deniedTools
│   ├── allowedDirs           ← advanced/harness-specific; stays in permissions
│   ├── copilotAllowAllPaths  ← advanced/harness-specific; stays in permissions
│   ├── codexSandboxMode      ← advanced/harness-specific; stays in permissions
│   └── codexApprovalPolicy   ← advanced/harness-specific; stays in permissions
├── mcp/defaultServers        ← execution default; → defaults.mcpServers
└── hooks/                    ← execution default; → defaults.hooks
```

### Proposed Structure

```
settings-schema.json:
├── general/                  ← NEW: settings that appear on the General nav tab
│   ├── defaultFormat         (was workflow.defaultFormat)
│   └── defaultTemplate       (was workflow.defaultTemplate)
├── defaults/                 ← NEW: mirrors executionProperties 1:1
│   ├── harness               (was root harness)
│   ├── models/               (was root models; per-harness map)
│   ├── additionalArgs/       (was root additionalArgs; per-harness map)
│   ├── agent                 (was workflow.defaultAgent)
│   ├── skills[]              (was workflow.defaultSkills)
│   ├── resumeSession         (was workflow.resumeExistingSession)
│   ├── priorContext          (was workflow.priorContext)
│   ├── mcpServers[]          (was mcp.defaultServers)
│   ├── hooks[]               (was root hooks)
│   ├── toolPermissions/
│   │   ├── mode              (was tools.permissionMode)
│   │   ├── allowedTools[]    (was tools.allowed)
│   │   └── deniedTools[]     (was tools.denied)
│   ├── endCondition          (was workflow.defaultEndCondition)
│   └── preCondition          (was workflow.defaultPreCondition)
│   (workflow key deleted entirely — all settings moved to general or defaults)
├── permissions/              ← RENAMED from tools; advanced/harness-specific only
│   ├── allowedDirs[]
│   ├── copilotAllowAllPaths
│   ├── codexSandboxMode
│   └── codexApprovalPolicy
├── execution/                (unchanged)
├── chat/                     (unchanged)
│   (mcp key deleted entirely — defaultServers moved to defaults.mcpServers)
├── queue/                    (unchanged)
├── history/                  (unchanged)
├── terminal/                 (unchanged)
├── ui/                       (unchanged)
├── server/                   (unchanged)
├── notifications/            (unchanged)
├── commit/                   (unchanged)
└── enableDiagnosticLogs      (unchanged, or move to general if desired)
```

### Complete Rename Table (all deleted, no aliases)

| Old path                            | New path                                |
| ----------------------------------- | --------------------------------------- |
| `harness`                           | `defaults.harness`                      |
| `models.<harnessId>`                | `defaults.models.<harnessId>`           |
| `additionalArgs.<harnessId>`        | `defaults.additionalArgs.<harnessId>`   |
| `workflow.defaultFormat`            | `general.defaultFormat`                 |
| `workflow.defaultTemplate`          | `general.defaultTemplate`               |
| `workflow.autoLoadRecentSession`    | `general.autoLoadRecentSession`         |
| `workflow.omitAgentsSkillsOnResume` | `general.omitAgentsSkillsOnResume`      |
| `workflow.defaultAgent`             | `defaults.agent`                        |
| `workflow.defaultSkills`            | `defaults.skills`                       |
| `workflow.resumeExistingSession`    | `defaults.resumeSession`                |
| `workflow.priorContext`             | `defaults.priorContext`                 |
| `workflow.defaultEndCondition`      | `defaults.endCondition`                 |
| `workflow.defaultPreCondition`      | `defaults.preCondition`                 |
| `tools.permissionMode`              | `defaults.toolPermissions.mode`         |
| `tools.allowed`                     | `defaults.toolPermissions.allowedTools` |
| `tools.denied`                      | `defaults.toolPermissions.deniedTools`  |
| `tools.allowedDirs`                 | `permissions.allowedDirs`               |
| `tools.copilotAllowAllPaths`        | `permissions.copilotAllowAllPaths`      |
| `tools.codexSandboxMode`            | `permissions.codexSandboxMode`          |
| `tools.codexApprovalPolicy`         | `permissions.codexApprovalPolicy`       |
| `mcp.defaultServers`                | `defaults.mcpServers`                   |
| `hooks` (root array)                | `defaults.hooks`                        |

### Files to Update

- `schemas/settings-schema.json` — full rewrite with new structure
- `src/types/FlightPathSettings.ts` — replace old fields with `general`, `defaults`, `permissions` sections; update `FLIGHTPATH_SETTINGS_DEFAULTS` object to match; `PartialFlightPathSettings` mapped type auto-updates
- `src/config/FlightPathConfigService.ts` — read exclusively from new paths; delete all old path handling
- `src/utils/ConfigurationUtils.ts` — update `CONFIG_KEYS` constant (add `GENERAL`, `DEFAULTS`, `PERMISSIONS`; delete `WORKFLOW`, `TOOLS`, `HOOKS`, `MCP`, root `HARNESS`/`MODELS`/`ADDITIONAL_ARGS`, and all `WORKFLOW_*` / `TOOLS_*` / `MCP_*` dot-notation keys); update every accessor/setter method to read from new paths
- `src/ui/WebviewSettingsSync.ts` — update `handleSetAsDefault()` (maps property names like `"agent"` → `"defaults.agent"`, `"resumeSession"` → `"defaults.resumeSession"`, `"toolPermissions"` → now writes `"defaults.toolPermissions"` atomically instead of three separate `tools.*` keys); update `buildGlobalSettingsPayload()` which reads each setting individually to build the `GlobalSettings` object sent to the webview
- `src/types/WebviewMessageTypes.ts` — update `FullGlobalSettings` to reflect new schema shape

---

## Part 2: UI Restructuring

### Global Settings Left Nav Changes

**Remove** from `ALL_TABS` in `GlobalSettingsDrawer.tsx`:

- `harnesses` ("Harnesses & Models") — absorbed into Workflow Defaults → Harness tab
- `mcp` ("MCP & Hooks") — fully absorbed: `McpHooksSection` contained only `mcp.defaultServers` (→ Defaults MCP tab) and `hooks` (→ Defaults Hooks tab); nothing remains

**Rename**:

- `workflow` label stays "Workflow Defaults" — now renders the tabbed component
- `permissions` label changes to **"Advanced Permissions"** — retains only harness-specific settings (`allowedDirs`, `copilotAllowAllPaths`, `codexSandboxMode`, `codexApprovalPolicy`)

**General section** (`GeneralSection.tsx`) gains:

- `general.defaultFormat` (was `workflow.defaultFormat`)
- `general.defaultTemplate` (was `workflow.defaultTemplate`)

**Workflow section** (`WorkflowDefaultsSection.tsx`) becomes the new tabbed component — see below. The `workflow` schema key is **deleted entirely** — every setting it contained has moved to `general` or `defaults`.

**Keep as-is** (not execution-property defaults):

- `general` — now includes format/template (from schema `general.*`) + behavior toggles
- `execution` — mode, injectMode, timeout, closeTerminalOnComplete, autoDeleteTempFiles
- `notifications`
- `terminal`
- `chat`
- `queue`
- `server`
- `agentskillsmanager`
- `commit`
- `developer`

### New `WorkflowDefaultsSection` Layout

Replace the body of `WorkflowDefaultsSection.tsx` with a `DrawerTabBar`-based layout. The `DrawerTabBar` is used with `harnessId` made optional — when omitted, the Harness tab renders `codicon-robot` instead of a `HarnessIcon`. No `harnessId` resolution needed in the global settings context.

```tsx
export function WorkflowDefaultsSection({ settings, onUpdate, onReset, activeScope }) {
  const [activePage, setActivePage] = useState<DrawerPage>(DRAWER_PAGES.HARNESS);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {activePage === DRAWER_PAGES.HARNESS && <DefaultsHarnessPage ... />}
        {activePage === DRAWER_PAGES.CONTEXT && <DefaultsContextPage ... />}
        {activePage === DRAWER_PAGES.VALIDATION && <DefaultsValidationPage ... />}
        {activePage === DRAWER_PAGES.MCP && <DefaultsMcpPage ... />}
        {activePage === DRAWER_PAGES.HOOKS && <DefaultsHooksPage ... />}
        {activePage === DRAWER_PAGES.PERMISSIONS && <DefaultsPermissionsPage ... />}
      </div>
      <DrawerTabBar
        activeTab={activePage}
        onTabChange={setActivePage}
        isNarrow={false}
        {/* harnessId omitted → Harness tab uses codicon-robot */}
      />
    </div>
  );
}
```

`DrawerTabBar` change: make `harnessId` optional. When absent, the Harness tab (which currently has no `codicon` and falls through to `HarnessIcon`) should render `codicon-robot` as the fallback.

### Tab Content Mapping

#### Harness Tab (`DefaultsHarnessPage`)

Absorbs all of current `HarnessesSection` plus agent/skills:

- **Default Harness** selector (`defaults.harness`)
- **Per-Harness Defaults** — grouped-by-harness card layout (from `HarnessesSection`):
  - Model dropdown per harness (`defaults.models.<harnessId>`)
  - Extra args input per harness (`defaults.additionalArgs.<harnessId>`)
- **Default Agent** (`defaults.agent`)
- **Default Skills** — `MultiCheckboxDropdown` (`defaults.skills`)

#### Context Tab (`DefaultsContextPage`)

- **Default Resume Session** — bool toggle (`defaults.resumeSession`)
- **Default Prior Context** — `CustomSelect` (`defaults.priorContext`)

#### Validation Tab (`DefaultsValidationPage`)

- **Default Pre-Condition** — checkbox + `ScriptConditionEditor` (`defaults.preCondition`)
- **Default End Condition** — checkbox + `ScriptConditionEditor` (`defaults.endCondition`)

Same `AnimatedSection` slide-down pattern used in `WorkflowPropertiesPanel`.

#### MCP Tab (`DefaultsMcpPage`)

- **Default MCP Servers** — full `McpServersEditor` (`defaults.mcpServers`)
- Includes "FlightPath" well-known server toggle, local discovery, and registry browser

#### Hooks Tab (`DefaultsHooksPage`)

- **Default Hooks** — `HooksEditor` (`defaults.hooks`)

#### Permissions Tab (`DefaultsPermissionsPage`)

- **Default Permission Mode** (`defaults.toolPermissions.mode`)
- **Default Allowed Tools** — textarea (`defaults.toolPermissions.allowedTools`)
- **Default Denied Tools** — textarea (`defaults.toolPermissions.deniedTools`)

### Advanced Permissions Section (`AdvancedPermissionsSection.tsx`)

Replaces `PermissionsSection.tsx`. Contains only the harness-specific settings that have no per-prompt/workflow equivalent:

- `permissions.allowedDirs` — additional workspace dirs
- `permissions.copilotAllowAllPaths` — Copilot all-paths toggle
- `permissions.codexSandboxMode` — Codex sandbox mode selector
- `permissions.codexApprovalPolicy` — Codex approval policy selector

---

## Part 3: File Touchlist

### New Files

- `src/ui/webview-react/components/settings/defaults/DefaultsHarnessPage.tsx`
- `src/ui/webview-react/components/settings/defaults/DefaultsContextPage.tsx`
- `src/ui/webview-react/components/settings/defaults/DefaultsValidationPage.tsx`
- `src/ui/webview-react/components/settings/defaults/DefaultsMcpPage.tsx`
- `src/ui/webview-react/components/settings/defaults/DefaultsHooksPage.tsx`
- `src/ui/webview-react/components/settings/defaults/DefaultsPermissionsPage.tsx`

### Modified Files

**Schema / Types**

- `schemas/settings-schema.json` — full rewrite
- `src/types/FlightPathSettings.ts` — new `general`, `defaults`, `permissions` sections; old fields deleted
- `src/types/WebviewMessageTypes.ts` — update `FullGlobalSettings`

**Config Layer**

- `src/config/FlightPathConfigService.ts` — new path reads/writes only
- `src/utils/ConfigurationUtils.ts` — new path accessors; delete old ones

**UI — Shared**

- `src/ui/webview-react/components/shared/DrawerTabBar.tsx` — make `harnessId` optional; render `codicon-robot` on Harness tab when omitted

**UI — Settings**

- `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` — remove `harnesses` and `mcp` tabs; rename `permissions` to "Advanced Permissions"
- `src/ui/webview-react/components/settings/WorkflowDefaultsSection.tsx` — replace body with tabbed container; reuse `HarnessesSection` inside `DefaultsHarnessPage`
- `src/ui/webview-react/components/settings/GeneralSection.tsx` — add `general.defaultFormat`, `general.defaultTemplate`, `general.autoLoadRecentSession`, `general.omitAgentsSkillsOnResume`
- `src/ui/webview-react/components/settings/HarnessesSection.tsx` — keep; consumed by `DefaultsHarnessPage`
- `src/ui/webview-react/components/settings/PermissionsSection.tsx` — rename to `AdvancedPermissionsSection.tsx`; update to read from `permissions.*`
- `src/ui/webview-react/components/settings/index.ts` — export new pages; update exports

**Extension Host**

- `src/ui/WebviewSettingsSync.ts` — `handleSetAsDefault()` maps property names to config write paths (all change: `"agent"` → `"defaults.agent"`, `"resumeSession"` → `"defaults.resumeSession"`, `"toolPermissions"` now writes `"defaults.toolPermissions"` atomically instead of three separate `tools.*` keys, etc.); `buildGlobalSettingsPayload()` reads each setting individually via `ConfigurationUtils` to build the payload — all reads change to new paths
- `src/ui/WebviewMessageRouter.ts` — no changes needed; delegates to `WebviewSettingsSync`
- `src/ui/webview-react/store/settingsStore.ts` — `GlobalSettings` interface and `initialGlobalSettings` constant must match the payload shape from `buildGlobalSettingsPayload()`; the flat fields (`agent`, `skills`, `resumeSession`, `priorContext`, `mcpServers`, `hooks`, `toolPermissions`, `defaultEndCondition`, `defaultPreCondition`, `harnessDefaultModels`, `harnessDefaultAdditionalArgs`) stay flat in the webview store but are now sourced from `defaults.*` on the extension side — no webview store restructuring needed, just verify the field names still align
- `src/ui/webview-react/hooks/useMessageHandler.ts` — passes payload through to `setGlobalSettings()`; no changes needed if payload shape is preserved

### Deleted Files

- `src/ui/webview-react/components/settings/McpHooksSection.tsx` — fully absorbed: `mcp.defaultServers` → `DefaultsMcpPage`, `hooks` → `DefaultsHooksPage`; nothing remains in this component
- `src/ui/webview-react/components/settings/PermissionsSection.tsx` (replaced by `AdvancedPermissionsSection.tsx`)

---

## Part 4: executionProperties → defaults Alignment

| `executionProperties` field    | Old settings path                | New `defaults.*` path                   |
| ------------------------------ | -------------------------------- | --------------------------------------- |
| `harness`                      | `harness`                        | `defaults.harness`                      |
| `model`                        | `models.<harnessId>`             | `defaults.models.<harnessId>`           |
| `additionalArgs`               | `additionalArgs.<harnessId>`     | `defaults.additionalArgs.<harnessId>`   |
| `agent`                        | `workflow.defaultAgent`          | `defaults.agent`                        |
| `skills`                       | `workflow.defaultSkills`         | `defaults.skills`                       |
| `resumeSession`                | `workflow.resumeExistingSession` | `defaults.resumeSession`                |
| `priorContext`                 | `workflow.priorContext`          | `defaults.priorContext`                 |
| `mcpServers`                   | `mcp.defaultServers`             | `defaults.mcpServers`                   |
| `hooks`                        | `hooks` (root)                   | `defaults.hooks`                        |
| `toolPermissions.mode`         | `tools.permissionMode`           | `defaults.toolPermissions.mode`         |
| `toolPermissions.allowedTools` | `tools.allowed`                  | `defaults.toolPermissions.allowedTools` |
| `toolPermissions.deniedTools`  | `tools.denied`                   | `defaults.toolPermissions.deniedTools`  |
| `endCondition`                 | `workflow.defaultEndCondition`   | `defaults.endCondition`                 |
| `preCondition`                 | `workflow.defaultPreCondition`   | `defaults.preCondition`                 |

Settings with no `executionProperties` equivalent (stay outside `defaults`):

| Setting                      | Old path                            | New path                           | UI location              |
| ---------------------------- | ----------------------------------- | ---------------------------------- | ------------------------ |
| Default file format          | `workflow.defaultFormat`            | `general.defaultFormat`            | General tab              |
| Default template             | `workflow.defaultTemplate`          | `general.defaultTemplate`          | General tab              |
| Auto-load recent session     | `workflow.autoLoadRecentSession`    | `general.autoLoadRecentSession`    | General tab              |
| Omit agents/skills on resume | `workflow.omitAgentsSkillsOnResume` | `general.omitAgentsSkillsOnResume` | General tab              |
| Allowed dirs                 | `tools.allowedDirs`                 | `permissions.allowedDirs`          | Advanced Permissions tab |
| Copilot all paths            | `tools.copilotAllowAllPaths`        | `permissions.copilotAllowAllPaths` | Advanced Permissions tab |
| Codex sandbox mode           | `tools.codexSandboxMode`            | `permissions.codexSandboxMode`     | Advanced Permissions tab |
| Codex approval policy        | `tools.codexApprovalPolicy`         | `permissions.codexApprovalPolicy`  | Advanced Permissions tab |

---

## Implementation Order

1. **Schema** — rewrite `settings-schema.json` with `general`, `defaults`, `permissions` structure; delete all old paths
2. **Types** — update `FlightPathSettings.ts` and `WebviewMessageTypes.ts` to match
3. **Config layer** — update `FlightPathConfigService` and `ConfigurationUtils` to new paths exclusively; delete old path handling
4. **`DrawerTabBar`** — make `harnessId` optional; add `codicon-robot` fallback for Harness tab
5. **Page components** — build the six `Defaults*Page` components and `AdvancedPermissionsSection`
6. **`WorkflowDefaultsSection`** — replace body with tabbed container
7. **`GeneralSection`** — add `general.defaultFormat` / `general.defaultTemplate` inputs
8. **`GlobalSettingsDrawer`** — remove `harnesses` and `mcp`; rename `permissions` → "Advanced Permissions"
9. **Extension host** — update `WebviewSettingsSync.handleSetAsDefault()` and `buildGlobalSettingsPayload()`; verify `settingsStore.GlobalSettings` interface still aligns with payload shape
10. **Tests** — `src/ui/webview-react/test/store/settingsStore.test.ts` constructs `GlobalSettings` by hand and will need updating. No extension-side tests reference old `workflow.*` / `tools.*` / `mcp.*` config paths directly — `WebviewSettingsSync.test.ts` only uses `CONFIG_KEYS.SERVER*` keys and is unaffected. `DashboardConstants.ts` needs no changes (no schema paths stored there).
