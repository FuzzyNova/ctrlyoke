# `mcpServers` Property — Refactor Plan

**Date:** 2026-03-27
**Replaces:** `allowDynamicExtension?: boolean` in `ExecutionProperties`
**Adds:** User-defined MCP server injection per prompt/workflow

---

## 1. Motivation

`allowDynamicExtension` is opaque. Its actual behavior — injecting an MCP server config so the AI can call `flightpath_append_queue` and `flightpath_queue_status` — maps directly to the MCP concept. Renaming to `mcpServers` is more accurate and opens a natural extension point: users can inject their own MCP servers (database, search, custom tools) into individual workflow prompts.

**Current state:**
- `allowDynamicExtension: true` → CLI harnesses get `--mcp-config` flags; copilot-chat does nothing (LM tools are always on)
- `allowDynamicExtension: false` → no MCP config injected
- Chat harness: `allowDynamicExtension` is a **complete no-op today** — LM tools are registered unconditionally at activation and cannot be disabled per-prompt

**Target state:**
- `mcpServers: ["flightpath"]` → same as `allowDynamicExtension: true`
- `mcpServers: null` or `mcpServers: []` → same as `allowDynamicExtension: false`
- `mcpServers: ["flightpath", { id: "my-db", command: "node", args: [...] }]` → FlightPath MCP + user MCP
- Omitted → same smart default as today (equivalent to `["flightpath"]` on the last prompt only)

---

## 2. Schema Design

### TypeScript Type Changes

**`src/types/FlightPathTypes.ts`:**

```typescript
/**
 * Configuration for a user-defined MCP server to inject for this prompt.
 * Used in the mcpServers property of ExecutionProperties.
 */
export interface McpServerConfig {
  /** Unique identifier for this server (used in auto-approval patterns). */
  id: string;
  /** Executable command (e.g., "node", "/usr/bin/python3"). */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Environment variables. */
  env?: Record<string, string>;
  /**
   * Auto-approve all tools from this server, or a list of tool name patterns.
   * true  → approve all tools (harness-specific flags added automatically)
   * string[] → approve only the named tools/patterns
   * omitted → no auto-approval (user prompted at runtime by the harness)
   */
  autoApprove?: boolean | string[];
}

// In ExecutionProperties, replace:
//   allowDynamicExtension?: boolean;
// with:
/**
 * MCP servers to inject for this prompt.
 * - "flightpath" (string shorthand) → built-in FlightPath queue tools
 * - McpServerConfig object → user-defined stdio MCP server
 * - null or [] → no MCP injection
 * - omitted → smart default: ["flightpath"] on the last prompt only
 */
mcpServers?: (string | McpServerConfig)[] | null;
```

### JSON Schema Changes

**`schemas/prompt-schema.json`:**

Remove `allowDynamicExtension` property. Add to `$defs`:

```json
"McpServerConfig": {
  "type": "object",
  "required": ["id", "command"],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "description": "Unique identifier for this server. Used in auto-approval patterns."
    },
    "command": {
      "type": "string",
      "description": "Executable command (e.g., \"node\", \"/usr/bin/python3\")."
    },
    "args": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Command-line arguments."
    },
    "env": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "description": "Environment variables to set for the server process."
    },
    "autoApprove": {
      "oneOf": [
        { "type": "boolean" },
        { "type": "array", "items": { "type": "string" } }
      ],
      "description": "Auto-approve all tools from this server (true), specific tool name patterns (string[]), or require manual approval (omit)."
    }
  }
}
```

The `mcpServers` property on both `PromptFile` and `PromptItem`:

```json
"mcpServers": {
  "oneOf": [
    {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "string",
            "enum": ["flightpath"],
            "description": "Built-in FlightPath queue tools (flightpath_append_queue, flightpath_queue_status). Enables dynamic workflow extension."
          },
          { "$ref": "#/$defs/McpServerConfig" }
        ]
      }
    },
    { "type": "null" }
  ],
  "description": "MCP servers to inject for this prompt. Use \"flightpath\" to enable dynamic queue extension. Add McpServerConfig objects for custom servers. null or [] disables all injection. Omit to use the smart default (\"flightpath\" on the last prompt only)."
}
```

### YAML Workflow Examples

```yaml
# Shorthand — enable FlightPath queue tools only (replaces allowDynamicExtension: true)
mcpServers:
  - flightpath

# User-defined MCP alongside FlightPath
mcpServers:
  - flightpath
  - id: my-database
    command: node
    args: [/path/to/db-mcp-server.js]
    env:
      DB_URL: "postgres://localhost/mydb"
    autoApprove: true

# Disable all MCP injection (replaces allowDynamicExtension: false)
mcpServers: null

# Omit entirely → smart default applies (flightpath on last prompt only)
```

---

## 3. CLI Harness Implementation

The MCP injection pipeline already exists and handles the per-harness differences. The change is to generalize it from a hardcoded single-server path to an array path.

### `CliMcpConfigGenerator.ts`

Add a method for building merged multi-server config:

```typescript
/**
 * Generate a merged JSON config file including the flightpath server
 * plus any user-defined servers.
 *
 * @param userServers Additional McpServerConfig entries from the workflow
 */
async generateJsonConfigWithUserServers(
  userServers: McpServerConfig[]
): Promise<string>
```

The generated file merges all servers under `mcpServers`:

```json
{
  "mcpServers": {
    "flightpath": { "command": "node", "args": [...], "env": {...} },
    "my-database": { "command": "node", "args": [...], "env": {...} }
  }
}
```

### `CliProviderUtils.buildMcpConfigBlock()`

Signature change: accept `mcpServers: (string | McpServerConfig)[] | null` instead of reading `allowDynamicExtension`. Logic:

1. If `mcpServers` is null/empty → return `[]` (no args)
2. Check if `"flightpath"` is in the array → determines whether to write the FlightPath server to the config
3. Extract `McpServerConfig` objects (user-defined) → merge into the generated config file
4. Pass merged config to provider-specific `getMcpConfigArgs()`

### Auto-Approval Flags per Harness

`autoApprove` is a **CLI-only feature**. For the `copilot-chat` harness, VS Code manages server trust interactively — there is no programmatic approval API. `autoApprove` on a user MCP server is silently ignored when the active harness is `copilot-chat`. Document this in the schema description.

When a `McpServerConfig` has `autoApprove: true` and the harness is CLI, each harness needs server-specific approval flags:

| Harness | Format | Example |
|---|---|---|
| Claude CLI | `--allowed-tools mcp__<server-id>` | `--allowed-tools mcp__my-database` |
| Copilot CLI | `--allow-tool <server-id>` | `--allow-tool my-database` |
| Codex CLI | none (auto-approves all MCPs by default) | — |
| OpenCode CLI | config file merge | added to `opencode.json` |
| Qwen CLI | TBD | — |
| Gemini CLI | TBD | — |

When `autoApprove` is a `string[]`, treat each entry as a tool name pattern. For Claude CLI: `--allowed-tools mcp__<server-id>__<tool-pattern>`. For Copilot CLI: `--allow-tool <tool-pattern>`.

---

## 4. Chat Harness Implementation

### Key Finding: `McpServerDefinitionProvider` API

VS Code exposes a **stable public API** for extensions to programmatically register MCP servers without touching any config file:

```typescript
vscode.lm.registerMcpServerDefinitionProvider(providerId, provider)
```

This is superior to writing `.vscode/mcp.json` because:
- No filesystem mutation
- Immediately reversible (clear active servers, fire change event → VS Code stops them)
- No cleanup files to forget on error/crash
- VS Code manages the process lifecycle

### `package.json` Contribution

```json
"contributes": {
  "mcpServerDefinitionProviders": [
    {
      "id": "flightpath.workflowMcpProvider",
      "label": "FlightPath Workflow MCPs"
    }
  ]
}
```

### New Class: `FlightPathMcpServerProvider`

**File:** `src/ui/FlightPathMcpServerProvider.ts`

```typescript
/**
 * Dynamically injects user-defined MCP servers into VS Code's MCP subsystem
 * for the duration of a FlightPath workflow prompt.
 *
 * Only used for the copilot-chat harness. CLI harnesses use CliMcpConfigGenerator
 * to pass --mcp-config flags instead.
 *
 * The "flightpath" built-in server is not managed here — FlightPath's LM tools
 * (flightpath_append_queue, flightpath_queue_status, etc.) are registered
 * unconditionally at activation via registerLanguageModelTools() and are always
 * available to Copilot Chat regardless of mcpServers.
 */
export class FlightPathMcpServerProvider implements vscode.McpServerDefinitionProvider {
  private activeServers: McpServerConfig[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  /**
   * Called by WorkflowExecutor when a chat prompt starts.
   * @param servers User-defined McpServerConfig entries (exclude "flightpath" shorthand)
   */
  setActiveServers(servers: McpServerConfig[]): void {
    this.activeServers = servers;
    this._onDidChange.fire();
  }

  provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
    return this.activeServers.map(
      (s) => new vscode.McpStdioServerDefinition(s.id, s.command, s.args ?? [], s.env ?? {})
    );
  }

  resolveMcpServerDefinition(
    server: vscode.McpStdioServerDefinition
  ): vscode.McpStdioServerDefinition {
    return server;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
```

### Wiring into WorkflowExecutor

`WorkflowExecutor` receives a `FlightPathMcpServerProvider` reference (injected via constructor or via the existing `FlightPathManager` context). Before executing a chat prompt:

```typescript
// In WorkflowExecutor, before executing a chat prompt:
const resolvedMcpServers = resolvedProperties.mcpServers ?? [];
const userServers = resolvedMcpServers.filter(
  (s): s is McpServerConfig => typeof s === "object"
);
if (harness === Harness.CopilotChat) {
  this.mcpProvider.setActiveServers(userServers);
}

// After the prompt completes or errors:
if (harness === Harness.CopilotChat) {
  this.mcpProvider.setActiveServers([]);
}
```

### Chat + `"flightpath"` Built-in

`mcpServers: ["flightpath"]` on a chat prompt is **semantically valid but functionally a no-op** for the chat harness. The four LM tools are registered unconditionally at activation. Document this in the schema description. No special handling needed.

---

## 5. `PropertyResolver` Changes

`resolveAllowDynamicExtension()` → `resolveMcpServers()` with updated return type.

**Current logic** (boolean): prompt-level → workflow-level → `ConfigurationUtils.getDynamicQueueConfig().enabled`

**New logic** (array): prompt-level → workflow-level → `ConfigurationUtils.getDefaultMcpServers()` (the renamed setting, see Section 5a).

The `PropertyResolver` fallback returns the workspace default array as-is — it does not apply "last prompt only" logic. That is `WorkflowExecutor`'s concern.

**`WorkflowExecutor` finalPrompt loop** — remove the flag check entirely:

```typescript
// Before:
const finalPromptAllowsDynamic = PropertyResolver.resolve(...).allowDynamicExtension;
if (!finalPromptAllowsDynamic) { /* wrap up */ }

// After: no flag check — loop is purely behavioral
// (queueSizeAfter > queueSizeBefore is already the outer loop condition)
```

`mcpServers` on the `finalPrompt` controls only whether MCP config is injected into the CLI invocation for that prompt. It has no bearing on whether the executor loops — that is determined solely by whether the queue grew. A workflow with `mcpServers: null` on the `finalPrompt` simply means the AI has no MCP tools during that step; if something else added prompts to the queue, the executor would still loop.

---

## 5a. VS Code Setting Rename: `enableDynamicQueue` → `mcpServers`

The boolean `flightpath.enableDynamicQueue` setting is replaced with an array setting `flightpath.mcpServers` that mirrors the per-prompt property. This completes the rename across all layers.

**`package.json` setting change:**

```json
// Remove:
"flightpath.enableDynamicQueue": {
  "type": "boolean",
  "default": false,
  ...
}

// Add:
"flightpath.mcpServers": {
  "type": "array",
  "default": [],
  "items": {
    "oneOf": [
      { "type": "string", "enum": ["flightpath"] },
      { "$ref": "#/$defs/McpServerConfig" }
    ]
  },
  "description": "Default MCP servers to inject for workflow prompts when no per-prompt or per-workflow mcpServers is specified. Use \"flightpath\" to enable FlightPath queue tools by default. Add McpServerConfig objects for custom MCP servers. Empty array disables default injection."
}
```

**`ConfigurationUtils` changes:**

```typescript
// Replace getDynamicQueueConfig() with:
getDefaultMcpServers(): (string | McpServerConfig)[] {
  return getConfig().get<(string | McpServerConfig)[]>("mcpServers", []);
}

// Replace setEnableDynamicQueue() with:
async setDefaultMcpServers(servers: (string | McpServerConfig)[]): Promise<void> {
  await this.updateSetting("mcpServers", servers);
}
```

The `enabled` field is removed from `DynamicQueueConfig` and its callers switch to `getDefaultMcpServers()`. **`getDynamicQueueConfig()` itself is not removed** — `QueueOperations.ts` still uses it for `maxQueueSize` and `unlimitedMode`, which are unrelated queue-size settings. Remove only the `enabled: boolean` field from `DynamicQueueConfig` and drop it from `getDynamicQueueConfig()`'s return value. Rename `setEnableDynamicQueue()` → `setDefaultMcpServers()` as a separate setter for the new array setting.

**`PropertyResolver` fallback:**

```typescript
private static resolveMcpServers(
  prompt: PromptItem,
  workflow: PromptFile
): (string | McpServerConfig)[] | null {
  if (prompt.mcpServers !== undefined) return prompt.mcpServers;
  if (workflow.mcpServers !== undefined) return workflow.mcpServers;
  return ConfigurationUtils.getDefaultMcpServers(); // new method
}
```

**Migration note:** `enableDynamicQueue: true` in existing user settings silently becomes a no-op after the rename. Users who had it enabled will need to add `"flightpath"` to their `mcpServers` array. This is an intentional breaking change — the setting predates MCP and the new name is unambiguous. Document in changelog.

---

## 6. MCP Discovery — Where Users Find Server Configs

This section covers where users get server configs to put in `mcpServers`. No implementation in this plan — informational for future tooling (autocomplete in the YAML editor, a discovery UI in the FlightPath sidebar).

### Standard Config File Locations to Read From

If FlightPath wants to offer "import from existing config" or autocomplete suggestions:

| Source | Path | Top-level key |
|---|---|---|
| VS Code (workspace) | `.vscode/mcp.json` | `servers` |
| VS Code (user, Windows) | `%APPDATA%\Code\User\mcp.json` | `servers` |
| VS Code (user, macOS/Linux) | `~/.config/Code/User/mcp.json` | `servers` |
| Claude Code (project) | `.mcp.json` at workspace root | `mcpServers` |
| Claude Code (user) | `~/.claude.json` (under project key) | `mcpServers` |
| Copilot CLI (user) | `~/.copilot/mcp-config.json` | `mcpServers` |

Note: VS Code uses `servers` as the top-level key; all other tools use `mcpServers`. The server object structure is equivalent (both support `command`, `args`, `env`).

### Public Registries

Two queryable public registries for discovering available MCP servers:

**Anthropic MCP Registry** (canonical, no auth required):
`GET https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial&limit=100`
Returns `server.packages[].identifier` (npm package name), `server.packages[].environmentVariables`, `_meta["com.anthropic.api/mcp-registry"].claudeCodeCopyText`.
Filter by `worksWith: ["claude-code"]` for Claude-specific servers.

**Smithery** (larger catalog, no auth, undocumented):
`GET https://registry.smithery.ai/servers?q=<search>&pageSize=20`
Returns `servers[].qualifiedName`, `servers[].displayName`, `servers[].description`, `servers[].verified`.

**VS Code Gallery** (`api.github.com/copilot/mcp_registry`): auth-gated (requires GitHub Copilot token). Not suitable for public queries from FlightPath.

---

## 7. Complete File Change List

### Core Types and Schema

| File | Change |
|---|---|
| `src/types/FlightPathTypes.ts` | Add `McpServerConfig` interface; replace `allowDynamicExtension?: boolean` with `mcpServers?: (string \| McpServerConfig)[] \| null` in `ExecutionProperties` |
| `src/types/DashboardConstants.ts` | Rename `ALLOW_DYNAMIC_EXTENSION` → `MCP_SERVERS`; update value to `"mcpServers"` |
| `src/types/WebviewMessageTypes.ts` | Replace `allowDynamicExtension?: boolean` with `mcpServers?: (string \| McpServerConfig)[] \| null` in **three** interfaces: `PromptItemUpdate`, the global settings object in `WebviewInitMessage`, and `WorkflowSettingsUpdate` |
| `schemas/prompt-schema.json` | Remove `allowDynamicExtension`; add `McpServerConfig` def + `mcpServers` array property with `oneOf` string/object items; update `finalPrompt` description |

Run `npm run generate-schema` after schema changes.

### Settings

| File | Change |
|---|---|
| `package.json` | Remove `flightpath.enableDynamicQueue` boolean; add `flightpath.mcpServers` array setting (see Section 5a); add `mcpServerDefinitionProviders` contribution point |
| `src/utils/ConfigurationUtils.ts` | Remove `enabled` from `DynamicQueueConfig` + `getDynamicQueueConfig()`; add `getDefaultMcpServers()` + `setDefaultMcpServers()`; remove `setEnableDynamicQueue()` (see Section 5a) |

### Core Logic

| File | Change |
|---|---|
| `src/flightpath/PropertyResolver.ts` | Rename `resolveAllowDynamicExtension()` → `resolveMcpServers()`; return `(string \| McpServerConfig)[] \| null`; update fallback to call `getDefaultMcpServers()` |
| `src/flightpath/WorkflowExecutor.ts` | Remove `allowDynamicExtension` loop gate entirely (see Section 5); call `mcpProvider.setActiveServers()` around chat prompts |
| `src/flightpath/PromptFileParser.ts` | Copy `mcpServers` from source (replace `allowDynamicExtension` copies at both prompt-level and workflow-level) |
| `src/flightpath/WorkflowInstance.ts` | Replace `allowDynamicExtension` coerce with `mcpServers` array handling |
| `src/flightpath/orchestration/PromptFileLoader.ts` | Replace `allowDynamicExtension` load + defaults logic with `mcpServers`; update fallback to call `getDefaultMcpServers()` |
| `src/flightpath/harness/shared/CliProviderUtils.ts` | `buildMcpConfigBlock()` accepts `mcpServers: (string \| McpServerConfig)[] \| null` instead of boolean; remove `getDynamicQueueConfig()` call |
| `src/flightpath/harness/shared/CliMcpConfigGenerator.ts` | Add `generateJsonConfigWithUserServers(userServers: McpServerConfig[])` merging all servers into one file |

### UI

| File | Change |
|---|---|
| `src/ui/WebviewSettingsSync.ts` | Replace `allowDynamicExtension` refs with `mcpServers`; update global settings sent to webview |
| `src/ui/WorkflowSerializer.ts` | Replace `"allowDynamicExtension"` with `"mcpServers"` in both `PROMPT_ITEM_SERIALIZABLE_KEYS` and workflow-level key arrays |
| `src/ui/webview-react/utils/prompt.ts` | Replace `allowDynamicExtension` in `PromptItemData`, `WorkflowPropertiesData`, `createEmptyPromptItem()`, and all mapping functions |
| `src/ui/webview-react/store/settingsStore.ts` | Replace `allowDynamicExtension: boolean` with `mcpServers: (string \| McpServerConfig)[]` in settings state and initial values |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx` | Replace `allowDynamicExtension` `CustomSelect` with `mcpServers` editor (array of string/object entries) |
| `src/ui/webview-react/components/layout/SettingsDrawer.tsx` | Update global `allowDynamicExtension` toggle to `mcpServers` array control |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx` | Update any `allowDynamicExtension` badge/indicator |

### New Files

| File | Change |
|---|---|
| **NEW** `src/ui/FlightPathMcpServerProvider.ts` | Implements `McpServerDefinitionProvider`; manages runtime MCP injection for chat harness (see Section 4) |

### Extension Entry Point

| File | Change |
|---|---|
| `src/extension.ts` | Register `FlightPathMcpServerProvider` via `vscode.lm.registerMcpServerDefinitionProvider`; pass provider reference to `FlightPathManager` |

### Tests

| File | Change |
|---|---|
| `src/test/unit/PropertyResolver.test.ts` | Replace `resolveAllowDynamicExtension` suite with `resolveMcpServers`; update expected return types |
| `src/test/unit/WorkflowExecutor.test.ts` | Remove `allowDynamicExtension: true` from `finalPrompt` fixtures; verify loop tests still pass on queue growth alone |
| `src/ui/webview-react/test/store/settingsStore.test.ts` | Replace `allowDynamicExtension` in test settings objects |
| `src/ui/webview-react/test/utils/prompt.test.ts` | Replace `allowDynamicExtension` in prompt item fixtures |
| `src/ui/webview-react/test/hooks/useMessageHandler.test.ts` | Replace `allowDynamicExtension` in message handler fixtures |

### Validation

| File | Change |
|---|---|
| `src/utils/ValidationUtils.ts` | Replace `allowDynamicExtension: { type: "boolean" }` with `mcpServers` array definition in the AJV runtime schema |

### Remaining `DynamicQueueConfig` Fields

After removing `enabled`, `DynamicQueueConfig` retains four fields — all unrelated to MCP injection:

| Field | Setting | Notes |
|---|---|---|
| `maxQueueSize` | `flightpath.maxQueueSize` | Max prompts allowed; unchanged |
| `unlimitedMode` | `flightpath.unlimitedMode` | Removes queue size + time limits; unchanged |
| `maxWorkflowExecutionTime` | `flightpath.maxWorkflowExecutionTime` | Max total workflow runtime; unchanged |
| `notifyOnExtension` | `flightpath.notifyOnQueueExtension` | Fires a notification when AI appends prompts; unchanged, still relevant |

Additionally, these four settings currently carry `[Dynamic Queue]` prefix labels in `package.json` descriptions. That label predates MCP and should be updated to `[Queue]` — "dynamic" implied an opt-in mode that no longer exists. Low-priority cosmetic change; include in the docs/templates sweep (step 10).

### Docs and Templates

| File | Change |
|---|---|
| `src/templates/workflows/spec-driven-loop.flightpath.yaml` | Replace `allowDynamicExtension: true` with `mcpServers: [flightpath]` |
| `docs/` | Update `WORKFLOW_PROPERTIES.md`, `QUEUE_APPEND_FEATURE.md`, `SESSION_MANAGEMENT.md` |
| `manual-test/` | Update example workflows using `allowDynamicExtension` → `mcpServers: [flightpath]` |
| `README.md` | Update property table |
| `.github/copilot-instructions.md` | Update schema fields table |
| `.github/instructions/*.instructions.md` | Update any references |

---

## 8. Implementation Order

1. **Types + schema** — `McpServerConfig` interface, `ExecutionProperties` change, JSON schema update. Foundation that unblocks everything else. Run `npm run generate-schema` after.

2. **`package.json` setting rename + `ConfigurationUtils`** — rename `enableDynamicQueue` → `mcpServers` setting; replace `getDynamicQueueConfig()` with `getDefaultMcpServers()`. Compile errors surface all callers.

3. **`PropertyResolver.resolveMcpServers()`** — rename + return type change. All remaining call sites will fail to compile, surfacing the rest of the work.

4. **`PromptFileParser` + `WorkflowInstance` + `PromptFileLoader`** — update parsing and defaults to copy arrays.

5. **`CliMcpConfigGenerator` + `CliProviderUtils`** — generalize for multi-server. The `"flightpath"` built-in path should continue to work exactly as before.

6. **`WorkflowExecutor`** — remove `allowDynamicExtension` loop gate entirely; add `mcpProvider.setActiveServers()` calls around chat prompts.

7. **`FlightPathMcpServerProvider`** — new class + registration in `extension.ts` + `package.json` contribution.

8. **Webview layer** — `DashboardConstants`, `WebviewMessageTypes`, `WebviewSettingsSync`, `WorkflowSerializer`, `webview-react` types/store/components.

9. **Tests** — update `PropertyResolver.test.ts`, `WorkflowExecutor.test.ts`, and all webview fixtures.

10. **Templates + docs** — update `.flightpath.yaml` templates and docs using `allowDynamicExtension`.

---

## 9. Out of Scope for This Plan

- **MCP discovery UI** — autocomplete of existing VS Code/Claude Code MCPs in the YAML editor (future: read `.mcp.json` and `.vscode/mcp.json` for suggestions)
- **HTTP/SSE MCP servers** — only stdio supported in V1 (`McpServerConfig` has `command`/`args`; no `url`). Can extend schema later.
- **Referencing pre-existing VS Code MCPs by name** — e.g., `mcpServers: ["flightpath", "context7"]` where `"context7"` refers to an already-configured VS Code MCP. Would require reading user MCP config at runtime. Deferred.
- **Anthropic/Smithery registry browser in sidebar** — discover and add MCPs from the public registry. Deferred.
