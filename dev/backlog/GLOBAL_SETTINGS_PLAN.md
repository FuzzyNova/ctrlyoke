# Global Settings Plan

> **Status: Backlog — ready to implement.**
>
> Pre-implementation audit completed 2026-04-07:
> - Removed dead `flightpath.qwenCliApprovalMode` setting (was never read; `QwenToolPermissionMapper` derives approval mode from `cliToolPermissions` directly)
> - Removed deprecated `on-failure` value from `flightpath.codexApprovalPolicy` enum
> - Fixed `getModelSettingKeyForHarness()` missing `Harness.QwenCli` case (was silently writing Qwen model to Copilot's setting key)
> - Updated `CodexToolPermissionMapper` comment with correct flag names and values
>
> The settings inventory below reflects the current post-audit state.

Create a first-class **global settings surface** for FlightPath so global configuration is no longer tied to the legacy `WorkflowPropertiesPanel` footer or to VS Code settings alone. This plan introduces a unified config-file architecture that works identically in VS Code and standalone CLI mode.

---

## Background

Today the UI mixes two different concepts:

- `WorkflowPropertiesPanel` (formerly `SettingsDrawer`, already renamed ✅) is a **workflow properties** panel
- its footer still exposes **global settings** and a VS Code-only "Settings..." entrypoint

That split is manageable inside VS Code, but it becomes awkward for the standalone server:

- there is no VS Code settings window to open
- server settings such as port, URL, theme behavior, and future TLS options are global/app-level concerns
- `src/utils/ConfigurationUtils.ts` centralizes dozens of global settings, but its backing store is still `vscode.workspace.getConfiguration("flightpath")`

The CLI mode has an even bigger gap: **zero config file support**. Every setting must be passed as a CLI flag. The `CliAdapter` maps only ~14 of the 60+ settings; the rest always return hardcoded defaults. There is no `~/.flightpath/settings.json` or `.flightpath/settings.json` to read.

The right long-term direction is to:

1. treat workflow properties and global settings as separate UX surfaces,
2. introduce a dedicated FlightPath global settings UI,
3. put header-level global actions (Settings, Start/Stop Server) in a stable place,
4. **abstract the configuration backend so the same settings model works in VS Code and standalone mode**,
5. **introduce a FlightPath-native config file format that both VS Code and CLI can read/write**,
6. **make config files the single source of truth — no VS Code settings dependency (pre-release, clean break)**.

---

## Why this should happen before the server button

The hosted-server button placement question is really a settings-architecture question.

- If the server control lives in the `SettingsDrawer` footer, it stays coupled to a workflow-properties component that is already carrying legacy naming and mixed responsibilities.
- If detailed server configuration will eventually live in a global settings page/modal, the Start/Stop Server control should be designed alongside that surface rather than added to the footer and moved again immediately after.
- The header has room for **two global icons** beside Save / Undo / Redo:
  - **Global Settings**
  - **Server Start/Stop**

That keeps workflow-local actions and app-global actions visually separate while still making both highly discoverable.

---

## Current Settings Inventory (`ConfigurationUtils.ts`)

`src/utils/ConfigurationUtils.ts` is the current source-of-truth inventory for FlightPath global settings. The new settings system must cover these categories:

### 1. General dashboard / editor behavior

- `showCliCommand`
- `showCliOutput`
- `logRawCliOutput`
- `enableDiagnosticLogs`
- `openPromptsInSecondGroup`
- `respectGitignoreForCompletions`
- `confirmDeleteOperations`
- `confirmResetOperations`

### 2. Workflow defaults

- default harness
- default workflow format
- default workflow template
- dynamic queue defaults
- script timeout
- default retry settings
- prior context default
- resume existing session default
- auto-load recent session

### 3. Harness and model defaults

- Copilot CLI model
- Copilot Chat model
- Claude CLI model
- Codex CLI model
- OpenCode CLI model
- Qwen CLI model
- Gemini CLI model
- per-harness additional args

### 4. Execution and permissions

- execution mode
- close terminal on completion
- max prompt execution time
- Copilot/Codex allowed dirs
- allow-all-paths
- CLI tool permission mode
- allowed / denied tools
- Codex sandbox mode
- Codex approval policy

### 5. Chat / agent behavior

- chat window location
- chat inactivity timeout
- treat chat timeout as success
- default agent
- default skills
- force agent mode for chat
- use native attachments
- omit agents/skills on resume

### 6. MCP / hooks / history

- default MCP servers
- default hooks
- save output history
- max history runs

### 7. Missing global settings that this plan should add

- hosted server enabled/disabled state
- hosted server port
- hosted server URL display metadata
- standalone server port
- standalone theme preference / theme mode behavior
- future HTTPS/TLS settings if supported later

---

## Goals

- Replace the legacy "footer settings button opens VS Code settings" path with a real FlightPath settings experience.
- `SettingsDrawer` has already been renamed to `WorkflowPropertiesPanel` ✅ — the code now matches the product language.
- Introduce a dedicated **Global Settings** surface that works in both VS Code and standalone/server contexts.
- Separate **configuration model** from **configuration backend** so the UI does not care whether settings come from a config file or CLI flags.
- Make server controls a natural part of global settings rather than a one-off button placement hack.
- Keep workflow-level overrides and global defaults clearly distinct.
- **Introduce a two-tier config file hierarchy: user global > workspace.**
- **Give the CLI a config-file fallback so users don't need to repeat flags on every invocation.**
- **Make config files the single source of truth — no VS Code settings dependency.**

## Non-Goals

- Rebuilding all workflow-properties UI in the same change
- Eliminating `ConfigurationUtils` immediately in one pass
- Designing multi-user/team-shared config for standalone mode
- Implementing HTTPS/TLS now (only reserve configuration space for it)

---

## Design Decisions

### Decision 1: Config File Format and Location

**FlightPath will use JSON config files at two scopes, with clear precedence:**

```
Precedence (highest wins):
  CLI flags > Workspace config > User global config > Hardcoded defaults
```

| Scope | Location | Purpose |
|-------|----------|---------|
| **User global** | `~/.flightpath/settings.json` | User-wide defaults that apply across all projects |
| **Workspace** | `<workspace>/.flightpath/settings.json` | Project-specific overrides for this workspace |
| **CLI flags** | `--harness`, `--model`, `--timeout`, etc. | Per-invocation overrides |

> **Pre-release clean break:** FlightPath is pre-release with no backward compatibility constraints. VS Code settings (`package.json` contributions) are **not** part of the config resolution chain. The config file system is the single source of truth from day one. VS Code settings remain only as `package.json` schema declarations for IntelliSense in the VS Code settings UI, but the extension reads from config files, not `vscode.workspace.getConfiguration()`.

**User global config (`~/.flightpath/settings.json`):**
```json
{
  "harness": "copilot-cli",
  "models": {
    "copilot-cli": "claude-sonnet-4.5",
    "claude-cli": "sonnet",
    "codex-cli": "gpt-5.2-codex"
  },
  "execution": {
    "mode": "interactive",
    "maxPromptTimeout": 10800,
    "scriptTimeout": 30
  },
  "tools": {
    "permissionMode": "allowAll",
    "allowed": [],
    "denied": []
  },
  "workflow": {
    "defaultFormat": "yaml",
    "defaultTemplate": "blank",
    "defaultAgent": "",
    "defaultSkills": []
  },
  "chat": {
    "windowLocation": "chatPanel",
    "inactivityTimeout": 300,
    "treatTimeoutAsSuccess": true
  },
  "mcp": {
    "defaultServers": []
  },
  "history": {
    "saveOutput": true,
    "maxRuns": -1
  },
  "ui": {
    "showCliOutput": true,
    "showCliCommand": false,
    "confirmDeleteOperations": true
  }
}
```

**Workspace config (`.flightpath/settings.json`):**
```json
{
  "harness": "claude-cli",
  "models": {
    "claude-cli": "opus"
  },
  "tools": {
    "permissionMode": "custom",
    "allowed": ["Write", "Edit"],
    "denied": ["Exec"]
  },
  "execution": {
    "maxPromptTimeout": 3600
  }
}
```

**Why JSON over YAML:** Settings files are machine-edited by the UI and programmatically read/written. JSON avoids YAML parsing edge cases and aligns with how VS Code's `settings.json` already works. YAML remains the default for *workflow/prompt files* (human-authored multi-line prompts), but settings are structured data better suited to JSON.

### Decision 2: VS Code Settings — Clean Break

**FlightPath is pre-release. There is no migration from VS Code settings.** The config file system (`~/.flightpath/settings.json` + `.flightpath/settings.json`) is the single source of truth from day one.

What happens to VS Code settings:
- `package.json` `contributes.configuration.properties` **stays** — it provides IntelliSense and documentation when users open VS Code Settings UI
- `ConfigurationUtils.ts` **stops calling** `vscode.workspace.getConfiguration()` for reading settings — it reads from config files instead
- `ConfigurationUtils.updateSetting()` **writes to config files**, not VS Code settings
- The `flightpath.*` keys in `package.json` become **documentation-only** — they describe what settings exist but are not the runtime backing store

**Single source of truth for settings:** `.flightpath/settings.json` (workspace) and `~/.flightpath/settings.json` (user global). Period. No VS Code fallback, no dual-write, no deprecation period.

### Decision 3: Config Service Architecture

#### Does `ConfigurationUtils` survive?

**Yes — `ConfigurationUtils.ts` keeps its class name and its entire public API.** It is called in dozens of places across the codebase; renaming it would mean a massive churn refactor for no real gain.

What changes is its *implementation*: after this plan is complete, `ConfigurationUtils` delegates to `FlightPathConfigService` instead of calling `vscode.workspace.getConfiguration()`. The callers never know the difference. Think of `FlightPathConfigService` as the new *backend* that `ConfigurationUtils` wraps — not a replacement for the class itself.

```
ConfigurationUtils (name unchanged, same public methods)
  └── internally calls FlightPathConfigService.get(key)
        └── FlightPathConfigService resolves from:
              1. CLI flags overlay
              2. Workspace config file
              3. User global config file
              4. Hardcoded defaults
```

Zero call-site changes needed in the rest of the codebase. The only class that changes internals is `ConfigurationUtils` itself.

```
┌─────────────────────────────────────────────────┐
│              Global Settings UI                 │
│         (webview modal / CLI TUI)               │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│         FlightPathConfigService                 │
│  (platform-agnostic config model)               │
│                                                 │
│  get<T>(key): T                                 │
│  set<T>(key, value): Promise<void>              │
│  getAll(): FlightPathGlobalSettings             │
│  resolve(key): { value, source }                │
│  subscribe(listener): () => void                │
└──────┬──────────────┬───────────────────────────┘
       │              │
       ▼              ▼
┌──────────────┐  ┌───────────┐
│ Config File  │  │ CLI Flags │
│ Backend      │  │ (overlay) │
│              │  │           │
│ ~/.flightpath│  │ --harness │
│ settings.json│  │ --model   │
│ .flightpath/ │  │ --timeout │
│ settings.json│  │           │
└──────────────┘  └───────────┘
```

**Config resolution algorithm:**
```
For any setting key:
  1. CLI flags (if in CLI mode) — highest priority
  2. Workspace config (.flightpath/settings.json)
  3. User global config (~/.flightpath/settings.json)
  4. Hardcoded default — lowest priority
```

### Decision 4: CLI Config File Support

**The CLI will read config files automatically, eliminating the need for repetitive flags.**

Current state:
```bash
# Today: every invocation needs all flags
flightpath run workflow.flightpath.yaml \
  --harness claude-cli \
  --model opus \
  --timeout 7200 \
  --allow-tool Write \
  --add-dir /path/to/project
```

Future state with config files:
```bash
# User global (~/.flightpath/settings.json) has harness/model/timeout defaults
# Workspace (.flightpath/settings.json) has project-specific tool permissions
flightpath run workflow.flightpath.yaml
# → reads config files, applies defaults, only needs per-run overrides
```

CLI flags still work and **always override** config file values:
```bash
flightpath run workflow.flightpath.yaml --harness codex-cli --model gpt-5.2
```

### Decision 5: Settings Schema and Types

**A typed `FlightPathGlobalSettings` interface becomes the single source of truth for setting keys.**

```ts
// src/types/FlightPathSettings.ts
export interface FlightPathGlobalSettings {
  // Core
  harness: HarnessId;
  
  // Models (per-harness)
  models: Record<HarnessId, string>;
  
  // Execution
  execution: {
    mode: "interactive" | "headless";
    maxPromptTimeout: number;  // seconds, -1 = unlimited (→ maxPromptExecutionTime)
    scriptTimeout: number;  // seconds
    closeTerminalOnComplete: boolean;
  };
  
  // Tools
  tools: {
    permissionMode: "dangerouslyAllowAll" | "allowAll" | "custom";
    allowed: string[];
    denied: string[];
    // Copilot CLI-specific
    copilotAllowedDirs: string[];   // → flightpath.copilotCliAllowedDirs
    copilotAllowAllPaths: boolean;  // → flightpath.copilotCliAllowAllPaths
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
    codexAllowedDirs: string[];     // → flightpath.codexAllowedDirs
  };
  
  // Workflow defaults
  workflow: {
    defaultFormat: "yaml" | "json";
    defaultTemplate: string;
    defaultAgent: string;
    defaultSkills: string[];
    resumeExistingSession: boolean;
    priorContext: string;
    autoLoadRecentSession: boolean;
    maxRetries: number;
    retryPrompt: string;
  };
  
  // Chat
  chat: {
    windowLocation: "chatPanel" | "newTab" | "newWindow";
    inactivityTimeout: number;  // seconds
    treatTimeoutAsSuccess: boolean;
    forceAgentMode: boolean;
    useNativeAttachments: boolean;
    omitAgentsSkillsOnResume: boolean;
  };
  
  // MCP & Hooks
  mcp: {
    defaultServers: (string | McpServerConfig)[];
  };
  hooks: UserHookConfig[];
  
  // Queue (all fields come from ConfigurationUtils.getDynamicQueueConfig())
  queue: {
    maxSize: number;
    maxWorkflowExecutionTime: number;  // seconds; -1 = unlimited
    unlimitedMode: boolean;
    notifyOnExtension: boolean;
  };
  
  // History
  history: {
    saveOutput: boolean;
    maxRuns: number;
  };
  
  // UI
  ui: {
    showCliOutput: boolean;
    showCliCommand: boolean;
    logRawCliOutput: boolean;
    openPromptsInSecondGroup: boolean;
    respectGitignoreForCompletions: boolean;
    confirmDeleteOperations: boolean;
    confirmResetOperations: boolean;
  };
  
  // Server (new)
  server: {
    enabled: boolean;
    port: number;
    standalonePort: number;
    theme: "auto" | "light" | "dark";
    // Reserved for future HTTPS/TLS
    tls?: {
      enabled: boolean;
      certPath?: string;
      keyPath?: string;
    };
  };
  
  // Advanced
  additionalArgs: Record<HarnessId, string>;
  enableDiagnosticLogs: boolean;
}
```

**Key design choices:**
- Nested structure (not flat keys) — matches how the settings UI will group settings into sections
- All timeouts in seconds (consistent unit, no ms confusion)
- `models` is a single record instead of 7 separate keys
- `permissionMode` is a typed union instead of arbitrary strings
- Reserved `tls` section for future HTTPS support without schema breaking changes

---

## Architecture Direction

### 1. Split "workflow properties" from "global settings"

Treat these as separate surfaces:

- **Workflow Properties**: per-workflow and per-prompt behavior
- **Global Settings**: app-wide defaults and environment/server settings

This means:

- `SettingsDrawer` has already been renamed to `WorkflowPropertiesPanel` ✅
- global toggles should gradually move out of its footer
- the existing footer should eventually become workflow-only or disappear entirely

### 2. Add a dedicated global settings UI shell

Introduce a new top-level FlightPath settings surface opened from the header.

Recommended UX:

- add a **Global Settings** icon button beside Save / Undo / Redo in `Header.tsx`
- open a large drawer or modal with section/page navigation
- support the same shell in VS Code and standalone mode

Recommended sections:

1. **General** — UI toggles, diagnostic logs
2. **Workflow Defaults** — format, template, agent, skills, session behavior
3. **Harnesses & Models** — per-harness model selection, additional args
4. **Permissions** — tool allow/deny lists, permission mode, sandbox settings
5. **Execution** — timeouts, execution mode, terminal behavior
6. **Chat** — chat window, timeouts, agent mode, attachments
7. **MCP & Hooks** — default servers, default hooks
8. **History & Safety** — output history, delete/reset confirmations
9. **Server** — port, enabled, theme, future TLS options

### 3. Introduce a backend-agnostic config service

Create `FlightPathConfigService` — a platform-agnostic configuration service that resolves settings through the precedence chain.

```ts
// src/config/FlightPathConfigService.ts
interface ConfigBackend {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  getAll(): Partial<FlightPathGlobalSettings>;
}

class FlightPathConfigService {
  private backends: ConfigBackend[] = [];
  private cliOverlay?: Partial<FlightPathGlobalSettings>;
  
  // Register backends in precedence order
  registerBackend(backend: ConfigBackend, priority: number): void;
  
  // Get a setting — walks backends in precedence order
  get<K extends keyof FlightPathGlobalSettings>(
    key: K
  ): FlightPathGlobalSettings[K];
  
  // Set a setting — writes to the appropriate backend based on context
  set<K extends keyof FlightPathGlobalSettings>(
    key: K,
    value: FlightPathGlobalSettings[K],
    scope: "user" | "workspace"
  ): Promise<void>;
  
  // Get all settings merged from all backends
  getAll(): FlightPathGlobalSettings;
  
  // For CLI: overlay flags on top of file-based config
  setCliOverlay(overlay: Partial<FlightPathGlobalSettings>): void;
  
  // Subscribe to config changes
  subscribe(listener: () => void): () => void;
}
```

**Backend implementations:**

| Backend | File | Used By |
|---------|------|---------|
| `FileConfigBackend` | `src/config/FileConfigBackend.ts` | Both VS Code and CLI |
| `CliFlagOverlay` | (built into service) | CLI only |

### 4. Config file I/O

```ts
// src/config/FileConfigBackend.ts
class FileConfigBackend implements ConfigBackend {
  private userConfigPath: string;  // ~/.flightpath/settings.json
  private workspaceConfigPath: string;  // <workspace>/.flightpath/settings.json
  private workspaceRoot: string;
  private cache?: FlightPathGlobalSettings;
  
  async get<T>(key: string): Promise<T | undefined>;
  async set<T>(key: string, value: T, scope: "user" | "workspace"): Promise<void>;
  getAll(): Partial<FlightPathGlobalSettings>;
  
  private loadConfig(path: string): Partial<FlightPathGlobalSettings>;
  private saveConfig(path: string, config: Partial<FlightPathGlobalSettings>): Promise<void>;
  private mergeConfigs(...sources: Partial<FlightPathGlobalSettings>[]): FlightPathGlobalSettings;
}
```

**File creation behavior:**
- Config files are **optional** — if they don't exist, the backend returns empty and falls through to the next backend
- When a user changes a setting via the Global Settings UI in VS Code, **create** `.flightpath/settings.json` if it doesn't exist
- CLI mode creates neither file — it only reads what exists
- User global config (`~/.flightpath/`) is created only when the user explicitly sets a user-level setting

### 5. Make server controls part of the global settings model

The server feature should use two layers:

- **Quick action in header**: Start/Stop Server
- **Detailed configuration in Global Settings > Server**:
  - port
  - open-in-browser / copy URL affordances
  - theme behavior
  - future HTTPS/TLS options

This avoids overloading the header button while still making the feature easy to start.

---

## Proposed UI Decision

### Target state

- `Header.tsx`
  - keep Save / Undo / Redo
  - add **Global Settings** (the `codicon-settings-gear` button already exists — update its behavior)
  - add **Start/Stop Server** beside it
- workflow run controls remain on the right side
- detailed server configuration lives inside Global Settings > Server, not next to workflow properties

### Naming

`SettingsDrawer` has already been renamed to `WorkflowPropertiesPanel` ✅. No further rename work needed.

---

## Implementation Plan

### Phase 1 — Define the shared global settings model

**Deliverables:**
1. `src/types/FlightPathSettings.ts` — typed `FlightPathGlobalSettings` interface (see Decision 5 above)
2. ~~Inventory every setting currently surfaced by `ConfigurationUtils.ts` and map to the new nested structure~~ **✅ Done** — audit completed 2026-04-07; dead settings removed, interface above reflects current state
3. No backward compatibility layer needed — pre-release, clean break
4. Update `schemas/prompt-schema.json` if any new global settings affect workflow file structure
5. Update `package.json` `contributes.configuration.properties` to mark settings as documentation-only (add note to `markdownDescription` pointing to config files). New server settings (`flightpath.serverPort`, `flightpath.serverEnabled`) should also be added here for VS Code settings UI documentation consistency.
6. Add `schemas/settings-schema.json` — a JSON Schema for `.flightpath/settings.json` so users editing config files directly get IntelliSense and validation in VS Code. Register it via a `jsonValidation` contribution in `package.json` (pointing at `*.flightpath/settings.json` and `~/.flightpath/settings.json`).

### Phase 2 — Config file I/O and backend abstraction

**Deliverables:**
1. `src/config/FlightPathConfigService.ts` — platform-agnostic config service
2. `src/config/FileConfigBackend.ts` — reads/writes `~/.flightpath/settings.json` and `.flightpath/settings.json`
3. Unit tests for config merging, precedence, and file I/O
4. `ConfigurationUtils` becomes a **thin wrapper** over the config service — all `vscode.workspace.getConfiguration()` calls replaced. The class name and all public method signatures stay unchanged; only the internals change:
   ```ts
   // Before (direct VS Code access):
   getCliModel(): string {
     return getConfig().get<string>("copilotCliModel", "claude-sonnet-4.5");
   }

   // After (config service):
   getCliModel(): string {
     return configService.get("models")["copilot-cli"] ?? "claude-sonnet-4.5";
   }
   ```
5. `ConfigurationUtils.updateSetting()` writes to config files, not VS Code settings
6. `FileConfigBackend` watches for file changes to both config paths via `chokidar` (already in dependencies) and fires `subscribe` listeners on change — live-reload without restarting the extension or the CLI process.
7. **`additionalArgs` consolidation:** The six separate `*CliAdditionalArgs` VS Code settings (`copilotCliAdditionalArgs`, `claudeCliAdditionalArgs`, etc.) collapse into a single `additionalArgs: Record<HarnessId, string>` key in the new config format. `ConfigurationUtils.getAdditionalArgsForHarness(harness)` reads `configService.get("additionalArgs")[harnessId] ?? ""`. The six old flat keys map to this record during the Phase 7 backend migration.

### Phase 3 — CLI config file support

**Deliverables:**
1. Update `CliAdapter` to use `FlightPathConfigService` instead of its own hardcoded switch statement
2. CLI reads `~/.flightpath/settings.json` and `.flightpath/settings.json` on startup
3. CLI flags become an "overlay" on top of file-based config via `configService.setCliOverlay()`
4. Expand `ResolvedCliConfig` or remove it entirely in favor of config service
5. Update `src/cli.ts` to initialize the config service before running workflows
6. Test: CLI with no flags picks up user/workspace config correctly
7. Test: CLI flags override config file values

### Phase 4 — Build the Global Settings UI

---

#### 4.1 — Shape and Layout

**Shape: full-width bottom-up overlay drawer.**

The drawer slides up from the bottom edge of the viewport, fills the full width, and occupies all vertical space below the header row. The header remains fully visible at all times. This matches the mobile prompts overlay pattern already in use.

```
┌──────────────────────────────────────────────────────┐  ← header (always visible)
│ [New▾] [Save] [↩][↪]  [⚙ highlighted]   [▶][⏸][⏹] │
├──────────────────┬───────────────────────────────────┤
│                  │                              [✕]  │  ← close button, top-right
│  General         │                                   │
│  Workflow        │   Section content                 │
│  Harnesses       │   (vertically scrollable)         │
│  Permissions     │                                   │
│  Execution       │                                   │
│  Chat            │                                   │
│  MCP & Hooks     │                                   │
│  Queue           │                                   │
│  History         │                                   │
│  Server          │                                   │
│                  │                                   │
└──────────────────┴───────────────────────────────────┘
  ↑ vertical tab bar (fixed, non-scrolling)
```

- **Vertical tab bar** — left column, fixed height, non-scrolling. Each tab is a full-width row with an icon and a label. Active tab has a left-border accent (`border-l-2 border-focus-border`), matching the horizontal `DrawerTabBar` style adapted to vertical orientation.
- **Content area** — right column, independently scrollable (`overflow-y-auto`). Contains the controls for the active section.
- **Animation** — slide up from below: `translate-y-full → translate-y-0` with `transition-transform duration-200 ease-out`. Same pattern as `MobilePromptsSidebar` overlay.
- **Z-index** — renders above all panels but below the header. Achieved by positioning the drawer as an absolute overlay within the main content area (below `<header>`), not over the header element.

---

#### 4.2 — Open / Close Mechanics

**Three ways to open/close:**

1. **Header settings-gear button** (`codicon-settings-gear`, left section of `Header.tsx`):
   - Toggles `uiStore.globalSettingsOpen`
   - When open, button gets the active state style: `bg-btn-bg text-btn-fg` (same pattern as `mobilePromptsOpen` button in mobile header center)
   - No message posted to extension for open/close — state is client-side

2. **Close button (✕)** — top-right corner of the drawer, same style as `PropertiesDrawer`'s close button

3. **Escape key** — `useEffect` on `keydown` when drawer is open

**On open:** webview posts `MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST` to extension. Extension responds with `MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED` carrying the full settings payload with source metadata. The drawer renders immediately with cached/default values and updates once the response arrives (no loading spinner needed for fast local reads).

**Naming note:** `uiStore` already has `mobileSettingsOpen` / `toggleMobileSettings` which refers to the *workflow properties* drawer on mobile — not this Global Settings drawer. The new state should be `globalSettingsOpen` / `toggleGlobalSettings` / `closeGlobalSettings` to avoid confusion.

---

#### 4.3 — State Management additions

**`uiStore` additions:**

```ts
// New state
globalSettingsOpen: boolean;
globalSettingsActiveTab: GlobalSettingsTab;

// New actions
toggleGlobalSettings(): void;
closeGlobalSettings(): void;
setGlobalSettingsTab(tab: GlobalSettingsTab): void;
```

**`settingsStore` additions:**

The existing `GlobalSettings` interface in `settingsStore.ts` covers only the subset needed by `WorkflowPropertiesPanel`. A new `FullGlobalSettings` shape (or expanding `GlobalSettings`) needs to cover all settings. This should mirror `FlightPathGlobalSettings` from `src/types/FlightPathSettings.ts` and include source metadata:

```ts
// Each setting value carries its source so the UI can show badges
export type SettingSource = "workspace" | "user" | "default";

export interface GlobalSettingValue<T> {
  value: T;
  source: SettingSource;
}

export interface FullGlobalSettings {
  harness: GlobalSettingValue<HarnessId>;
  models: GlobalSettingValue<Record<HarnessId, string>>;
  additionalArgs: GlobalSettingValue<Record<HarnessId, string>>;
  execution: { ... };   // all fields wrapped in GlobalSettingValue<T>
  tools: { ... };
  workflow: { ... };
  chat: { ... };
  mcp: { ... };
  hooks: { ... };
  queue: { ... };
  history: { ... };
  ui: { ... };
  server: { ... };
}
```

**New store actions:**

```ts
setFullGlobalSettings(settings: FullGlobalSettings): void;
updateGlobalSetting(path: string, value: unknown, scope: "workspace" | "user"): void;
```

---

#### 4.4 — Message Types

Add to `src/types/DashboardConstants.ts`:

```ts
GLOBAL_SETTINGS_LOAD_REQUEST   // webview → extension: "send me current settings"
GLOBAL_SETTINGS_LOADED         // extension → webview: full settings payload + sources
UPDATE_GLOBAL_SETTING          // webview → extension: { path, value, scope }
GLOBAL_SETTING_UPDATED         // extension → webview: { path, value, source } acknowledgment
```

The `UPDATE_GLOBAL_SETTING` path uses dot notation matching the `FlightPathGlobalSettings` nested structure (e.g. `"execution.mode"`, `"tools.permissionMode"`, `"models.claude-cli"`).

---

#### 4.5 — New Component

**`src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx`**

```
GlobalSettingsDrawer
├── VerticalTabBar              (left column, new component)
│   └── GlobalSettingsTab[]     (one row per section)
└── GlobalSettingsContent       (right column, scrollable)
    ├── GeneralSection
    ├── WorkflowDefaultsSection
    ├── HarnessesSection
    ├── PermissionsSection
    ├── ExecutionSection
    ├── ChatSection
    ├── McpHooksSection
    ├── QueueSection
    ├── HistorySection
    └── ServerSection
```

`VerticalTabBar` renders identically to `DrawerTabBar` but oriented vertically — a `flex-col` list of full-width tab buttons, each with `border-l-2` accent when active instead of `border-b-2`. Reuse the same color tokens (`border-focus-border`, `text-foreground`, `text-description-fg`).

Each section component receives:
- `settings: FullGlobalSettings` (full snapshot)
- `onUpdate(path, value, scope): void` (fires `UPDATE_GLOBAL_SETTING`)

Sections are rendered lazily — only the active section is mounted (simple conditional render is fine; no need for `React.lazy` here).

---

#### 4.6 — Source Indicator Design

Each `DrawerRow` already accepts a label and content. Add an optional `source` prop that renders a small pill after the row label:

```tsx
// Rendered as a small muted pill to the right of the label
source === "workspace" → <span class="badge">workspace</span>
source === "user"      → <span class="badge">global</span>
source === "default"   → (nothing shown — default is the baseline)
```

Badge style: `text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-badge-bg text-description-fg` — subtle, non-distracting.

When a value comes from `"workspace"`, a secondary affordance appears below the row: a small `[Reset to global]` link that calls `onUpdate(path, globalDefault, "workspace-delete")`. This removes the workspace override without touching the user-global setting.

---

#### 4.7 — Section Breakdown (Controls per Section)

##### General

| Control | Type | Setting key |
|---|---|---|
| Show CLI output | Toggle | `ui.showCliOutput` |
| Show CLI command | Toggle | `ui.showCliCommand` |
| Log raw CLI output | Toggle | `ui.logRawCliOutput` |
| Enable diagnostic logs | Toggle | `enableDiagnosticLogs` |
| Open prompts in second group | Toggle | `ui.openPromptsInSecondGroup` |
| Respect .gitignore for completions | Toggle | `ui.respectGitignoreForCompletions` |
| Confirm delete operations | Toggle | `ui.confirmDeleteOperations` |
| Confirm reset operations | Toggle | `ui.confirmResetOperations` |

##### Workflow Defaults

| Control | Type | Setting key |
|---|---|---|
| Default harness | `HarnessDropdown` (reuse) | `harness` |
| Default workflow format | `CustomSelect` yaml/json | `workflow.defaultFormat` |
| Default template | `CustomSelect` (template list) | `workflow.defaultTemplate` |
| Default agent | Text input with file picker | `workflow.defaultAgent` |
| Default skills | `SkillsSelect` (reuse) | `workflow.defaultSkills` |
| Default prior context | `PriorContextSelect` (reuse) | `workflow.priorContext` |
| Resume existing session | Toggle | `workflow.resumeExistingSession` |
| Auto-load recent session | Toggle | `workflow.autoLoadRecentSession` |
| Omit agents/skills on resume | Toggle | `workflow.omitAgentsSkillsOnResume` |
| Default max retries | Number input | `workflow.maxRetries` |
| Default retry prompt | Textarea | `workflow.retryPrompt` |

##### Harnesses & Models

Flat two-column grid — one row per harness. Each row: harness icon + name on left; model dropdown + additionalArgs text input on right.

| Harness | Model dropdown namespace | additionalArgs key |
|---|---|---|
| Copilot CLI | `copilot-cli` models | `additionalArgs["copilot-cli"]` |
| Claude CLI | `claude-cli` models | `additionalArgs["claude-cli"]` |
| Codex CLI | `codex-cli` models | `additionalArgs["codex-cli"]` |
| OpenCode CLI | `opencode-cli` models (free-form) | `additionalArgs["opencode-cli"]` |
| Qwen CLI | `qwen-cli` models | `additionalArgs["qwen-cli"]` |
| Gemini CLI | `gemini-cli` models | `additionalArgs["gemini-cli"]` |
| Copilot Chat | `copilot-chat` models | — (no additionalArgs for chat) |

Model dropdowns reuse `modelNamespaceForHarness()` + existing `CustomSelect` with model namespaces. additionalArgs uses a plain `<input type="text">`.

##### Permissions

| Control | Type | Setting key |
|---|---|---|
| Permission mode | `CustomSelect` (reuse `PERMISSION_MODE_OPTIONS`) | `tools.permissionMode` |
| Allowed tools | Tag/multiline input *(shown in custom mode)* | `tools.allowed` |
| Denied tools | Tag/multiline input *(shown in custom mode)* | `tools.denied` |
| **Copilot CLI** | | |
| Allow all paths | Toggle | `tools.copilotAllowAllPaths` |
| Allowed dirs | String[] editor | `tools.copilotAllowedDirs` |
| **Codex CLI** | | |
| Sandbox mode | `CustomSelect` read-only/workspace-write/danger-full-access | `tools.codexSandboxMode` |
| Approval policy | `CustomSelect` untrusted/on-request/never | `tools.codexApprovalPolicy` |
| Allowed dirs | String[] editor | `tools.codexAllowedDirs` |

Copilot-specific and Codex-specific subsections are visually grouped under a sub-header. Codex sandbox/approval rows dim when `permissionMode !== "custom"`.

##### Execution

| Control | Type | Setting key |
|---|---|---|
| Execution mode | `CustomSelect` interactive/headless | `execution.mode` |
| Max prompt timeout | Number input (seconds, -1=unlimited) | `execution.maxPromptTimeout` |
| Script timeout | Number input (seconds) | `execution.scriptTimeout` |
| Close terminal on completion | Toggle | `execution.closeTerminalOnComplete` |

##### Chat

| Control | Type | Setting key |
|---|---|---|
| Chat model | `CustomSelect` (copilot-chat models) | `chat.model` |
| Chat window location | `CustomSelect` chatPanel/newTab/newWindow | `chat.windowLocation` |
| Inactivity timeout | Number input (seconds) | `chat.inactivityTimeout` |
| Treat timeout as success | Toggle | `chat.treatTimeoutAsSuccess` |
| Force agent mode | Toggle | `chat.forceAgentMode` |
| Use native attachments | Toggle | `chat.useNativeAttachments` |
| Omit agents/skills on resume | *(also in Workflow Defaults)* | `chat.omitAgentsSkillsOnResume` |

##### MCP & Hooks

Reuse `McpServersEditor` and `HooksEditor` components directly (they already handle add/edit/remove). These are the default servers/hooks applied to all workflows that don't override them.

| Control | Component | Setting key |
|---|---|---|
| Default MCP servers | `McpServersEditor` (reuse) | `mcp.defaultServers` |
| Default hooks | `HooksEditor` (reuse) | `hooks` |

##### Queue

| Control | Type | Setting key |
|---|---|---|
| Max queue size | Number input | `queue.maxSize` |
| Max workflow execution time | Number input (seconds, -1=unlimited) | `queue.maxWorkflowExecutionTime` |
| Unlimited mode | Toggle | `queue.unlimitedMode` |
| Notify on queue extension | Toggle | `queue.notifyOnExtension` |

##### History & Safety

| Control | Type | Setting key |
|---|---|---|
| Save output history | Toggle | `history.saveOutput` |
| Max history runs | Number input (-1=unlimited) | `history.maxRuns` |

##### Server *(stubbed in Phase 4, fully built in Phase 6)*

Renders a placeholder card: *"Server configuration coming soon."* with the port and enabled fields stubbed as disabled inputs. Full implementation deferred to Phase 6.

---

#### 4.8 — Header Changes

In `Header.tsx`:

1. Replace `handleOpenSettings` (currently posts `MESSAGE_TYPES.OPEN_SETTINGS` to extension) with a direct `uiStore.toggleGlobalSettings()` call — no extension message needed to open/close. The load request fires from the drawer's `useEffect` on mount.

2. Add active state to the settings-gear button:

```tsx
const globalSettingsOpen = useUiStore((s) => s.globalSettingsOpen);
const toggleGlobalSettings = useUiStore((s) => s.toggleGlobalSettings);

// Button className:
`control-button ... ${
  globalSettingsOpen
    ? "bg-btn-bg text-btn-fg"
    : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
}`
```

3. Update button title from `"Open VS Code settings"` to `"Global Settings"`.

---

#### 4.9 — Deliverables Summary

1. `src/types/DashboardConstants.ts` — add `GLOBAL_SETTINGS_LOAD_REQUEST`, `GLOBAL_SETTINGS_LOADED`, `UPDATE_GLOBAL_SETTING`, `GLOBAL_SETTING_UPDATED`
2. `src/ui/webview-react/store/uiStore.ts` — add `globalSettingsOpen`, `globalSettingsActiveTab`, and actions
3. `src/ui/webview-react/store/settingsStore.ts` — add `FullGlobalSettings`, `SettingSource`, `GlobalSettingValue<T>`, and store actions
4. `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` — main drawer shell + animation
5. `src/ui/webview-react/components/layout/GlobalSettingsVerticalTabBar.tsx` — vertical tab nav
6. Section components (`GeneralSection.tsx`, `WorkflowDefaultsSection.tsx`, etc.) in `components/settings/`
7. `DrawerRow` — add optional `source?: SettingSource` prop + reset-to-global affordance
8. `Header.tsx` — wire `toggleGlobalSettings`, active state, title update
9. `App.tsx` — render `<GlobalSettingsDrawer>` as a bottom overlay (sibling to `MobilePromptsSidebar` pattern)
10. `FlightPathWebviewProvider.ts` — handle `GLOBAL_SETTINGS_LOAD_REQUEST` (read all settings, attach source metadata, send `GLOBAL_SETTINGS_LOADED`) and `UPDATE_GLOBAL_SETTING` (write to config file via `FlightPathConfigService`)

### Phase 5 — Detangle the current footer

**Deliverables:**
1. Remove or relocate the global toggles from the workflow-properties footer
2. Decide whether small global quick toggles remain anywhere outside Global Settings
3. Keep the workflow-properties surface focused on workflow-scoped concerns only
4. ~~Rename `SettingsDrawer` to `WorkflowProperties*`~~ — **already done** (`WorkflowPropertiesPanel`) ✅

### Phase 6 — Add the Server section

**Deliverables:**
1. Add server settings to the typed global settings model
2. Add **Server** page/section in Global Settings
3. Put detailed fields there:
   - enabled/running status
   - port
   - displayed URL
   - browser-launch action
   - future HTTPS/TLS placeholders if needed
4. Add the header Start/Stop Server button only after this settings architecture is in place

### Phase 7 — Replace VS Code settings backend

**Deliverables:**
1. Remove all `vscode.workspace.getConfiguration("flightpath")` reads from `ConfigurationUtils.ts`
2. Remove `ConfigurationUtils.updateSetting()` calls to `vscode.ConfigurationTarget`
3. `package.json` settings remain as documentation-only — add markdown description noting that settings are managed via FlightPath Global Settings UI or config files
4. Remove `vscode` import from `ConfigurationUtils.ts` (or keep only for non-settings VS Code API calls if any remain)
5. Verify no other code paths still read/write VS Code settings for FlightPath config
6. Update `WebviewSettingsSync` — it currently reads `vscode.workspace.workspaceFolders` and dispatches workspace/agent/skill discovery data to the webview. Route any settings reads through `FlightPathConfigService`; move workspace-path discovery behind constructor inputs or the platform adapter so it works in standalone mode.
7. Update `PropertyResolver` — its settings tier (lowest priority in the prompt → workflow → settings chain) must call `FlightPathConfigService.get(key)` rather than any `ConfigurationUtils` method that still delegates to VS Code. After Phase 2 this may already be satisfied if `ConfigurationUtils` fully wraps the service, but confirm explicitly.

---

## Relationship to Existing Work

### Unblocks / clarifies

- `STANDALONE_SERVER_PLAN.md`
- hosted server button placement
- standalone server configuration model
- `WebviewSettingsSync` cleanup
- removal of `vscode.workspace.getConfiguration()` from settings-related code
- CLI config file support (currently nonexistent)
- `CliAdapter` cleanup (eliminate hardcoded 14-key switch statement)
- `ConfigurationUtils` refactor (remove VS Code dependency)

### Depends on

- the shared hosted-router foundation that is already in place

### Should happen before

- building a dedicated standalone settings page ad hoc
- any new per-user or per-project configuration features
- adding any new settings to `package.json` without config file support

---

## Recommended Follow-Up Order

1. **Land this global settings architecture plan.**
2. **Implement the typed global settings model** (`FlightPathGlobalSettings` interface).
3. **Build the config service + file backend** (`FlightPathConfigService`, `FileConfigBackend`).
4. **Add CLI config file support** — eliminate the 14-key switch statement in `CliAdapter`.
5. **Build the Global Settings UI shell** in the webview.
6. **Replace `ConfigurationUtils` VS Code reads/writes** with config service calls.
7. **Move server configuration into that surface.**
8. **Add header-level Start/Stop Server** and circle back to the hosted server implementation.
9. **Detangle the `WorkflowPropertiesPanel` footer** — rename already done ✅, move global toggles out.
10. **Remove VS Code settings backend** — strip `vscode.workspace.getConfiguration()` from `ConfigurationUtils`.

---

## CLI Usage Examples (After Implementation)

### Scenario 1: User with global defaults

```bash
# ~/.flightpath/settings.json has:
# { "harness": "claude-cli", "models": { "claude-cli": "opus" } }

flightpath run refactor.flightpath.yaml
# → Uses claude-cli with opus model, no flags needed
```

### Scenario 2: Project-specific overrides

```bash
# .flightpath/settings.json has:
# { "harness": "codex-cli", "tools": { "permissionMode": "custom", "denied": ["Exec"] } }

flightpath run deploy.flightpath.yaml
# → Uses codex-cli, denies Exec tools
```

### Scenario 3: CLI flags override everything

```bash
# Config files say claude-cli, but user wants gpt-5.2-codex for this run
flightpath run deploy.flightpath.yaml --harness codex-cli --model gpt-5.2-codex
```

### Scenario 4: CI/CD headless with config file

```bash
# CI has ~/.flightpath/settings.json with headless defaults
# No flags needed, or override just what's different
flightpath run ci-workflow.flightpath.yaml --headless --json
```

### Scenario 5: Standalone server reads config

```bash
# Server reads .flightpath/settings.json for port, theme, etc.
flightpath-mcp
# → Uses port from config, respects theme, logs to .flightpath/logs/
```

---

## Notes

- **Pre-release clean break:** FlightPath is pre-release with no backward compatibility constraints. Config files are the single source of truth from day one. No migration from VS Code settings is needed or planned.
- `ConfigurationUtils.ts` should be treated as the migration inventory — a list of all settings that need to move to the config file system.
- The current footer settings button is a temporary VS Code convenience, not the long-term product shape.
- Server controls are global application controls, not workflow controls, so they should evolve with the global settings UX rather than with the workflow-properties drawer.
- **Config files are optional** — the system gracefully falls back through available sources (workspace → user global → hardcoded defaults).
- **CLI flags always win** — config files are defaults, flags are per-run overrides.
- **VS Code `package.json` settings are documentation-only** — they describe what settings exist and provide IntelliSense in the VS Code Settings UI, but the extension reads/writes config files, not `vscode.workspace.getConfiguration()`.
- The nested settings structure (`FlightPathGlobalSettings`) matches how the UI will group settings into sections — this is intentional and reduces mapping complexity.
