# Global Settings Plan

Create a first-class **global settings surface** for FlightPath so global configuration is no longer tied to the legacy `SettingsDrawer` footer or to VS Code settings alone. This plan introduces a unified config-file architecture that works identically in VS Code and standalone CLI mode.

---

## Background

Today the UI mixes two different concepts:

- `SettingsDrawer` is effectively a **workflow properties** panel
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
- Rename the mental model: `SettingsDrawer` should become **WorkflowProperties** over time.
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
    maxPromptTimeout: number;  // seconds, -1 = unlimited
    maxWorkflowExecutionTime: number;  // seconds, -1 = unlimited
    scriptTimeout: number;  // seconds
    closeTerminalOnComplete: boolean;
  };
  
  // Tools
  tools: {
    permissionMode: "dangerouslyAllowAll" | "allowAll" | "custom";
    allowed: string[];
    denied: string[];
    additionalDirs: string[];
    allowAllPaths: boolean;
    codexSandboxMode: string;
    codexApprovalPolicy: string;
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
  
  // Queue
  queue: {
    maxSize: number;
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

- the current `SettingsDrawer` should be conceptually renamed to `WorkflowProperties`
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

### Short-term decision

Do **not** finalize the hosted-server button in the `SettingsDrawer` footer.

### Target state

- `Header.tsx`
  - keep Save / Undo / Redo
  - add **Global Settings**
  - add **Start/Stop Server**
- workflow run controls remain on the right side
- detailed server configuration lives inside Global Settings, not next to workflow properties

### Naming cleanup

As follow-up work, rename the legacy settings UI so the code matches the product language:

- `SettingsDrawer` -> `WorkflowPropertiesDrawer` (or similar)
- visible UI label: **Workflow Properties**

This rename does not need to block the new global settings UI, but the plan should assume it will happen.

---

## Implementation Plan

### Phase 1 — Define the shared global settings model

**Deliverables:**
1. `src/types/FlightPathSettings.ts` — typed `FlightPathGlobalSettings` interface (see Decision 5 above)
2. Inventory every setting currently surfaced by `ConfigurationUtils.ts` and map to the new nested structure
3. No backward compatibility layer needed — pre-release, clean break
4. Update `schemas/prompt-schema.json` if any new global settings affect workflow file structure
5. Update `package.json` `contributes.configuration.properties` to mark settings as documentation-only (add note pointing to config files)

### Phase 2 — Config file I/O and backend abstraction

**Deliverables:**
1. `src/config/FlightPathConfigService.ts` — platform-agnostic config service
2. `src/config/FileConfigBackend.ts` — reads/writes `~/.flightpath/settings.json` and `.flightpath/settings.json`
3. Unit tests for config merging, precedence, and file I/O
4. `ConfigurationUtils` becomes a **thin wrapper** over the config service — all `vscode.workspace.getConfiguration()` calls replaced:
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

**Deliverables:**
1. Add a new header button to open Global Settings
2. Create a dedicated large settings drawer/modal/page shell
3. Build sections from the typed settings model (General, Workflow Defaults, Harnesses & Models, etc.)
4. Reuse existing controls where possible (`CustomSelect`, toggles, editors, MCP/hook editors)
5. Show clearly which values are user global defaults vs workspace overrides
6. Indicate the **source** of each setting value (config file, CLI flag, default)
7. All writes go to config files — no VS Code settings interaction

### Phase 5 — Detangle the current footer

**Deliverables:**
1. Remove or relocate the global toggles from the workflow-properties footer
2. Decide whether small global quick toggles remain anywhere outside Global Settings
3. Keep the workflow-properties surface focused on workflow-scoped concerns only
4. Rename the component/files from `SettingsDrawer` to `WorkflowProperties*`

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

- finalizing server button placement in the footer
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
9. **Detangle the SettingsDrawer footer** and rename to WorkflowProperties.
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
