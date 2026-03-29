# Per-Workflow Tool Permissions Plan

## Overview

Currently, tool permissions (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) are global-only VS Code settings. This plan proposes adding `toolPermissions` to `executionProperties` in `prompt-schema.json`, enabling per-workflow and per-prompt permission overrides that follow the existing three-tier precedence pattern (prompt > workflow > global settings).

## Motivation

Some workflows need tighter or looser permissions than the global default:

- A read-only analysis workflow should restrict write/shell access for safety
- A deployment workflow may need `git push` allowed temporarily, even if the global deny list blocks it
- A multi-step workflow could tighten permissions for "planning" prompts and loosen them for "implementation" prompts
- Teams committing workflow files to version control can encode appropriate permission scopes directly in the workflow, not just in each user's VS Code settings

## Should This Be Prompt-Level or Workflow-Level?

**Both** — consistent with all other `executionProperties` fields (harness, model, agent, resumeSession, etc.). Per-prompt overrides are useful for multi-step workflows with different trust levels per step.

Security note: this does not introduce escalation risk beyond what the user already controls via global settings — the user's VS Code settings remain the ceiling. A prompt can only request permissions the user has already configured as the global baseline, or explicitly loosened in their own workflow file.

---

## Schema Changes (`schemas/prompt-schema.json`)

Add `toolPermissions` to the `executionProperties` definition:

```json
"toolPermissions": {
  "oneOf": [
    {
      "type": "object",
      "description": "Per-workflow/prompt tool permission overrides. Follows three-tier precedence: prompt > workflow > global VS Code settings. Only applies to CLI harnesses.",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["dangerouslyAllowAll", "allowAll", "custom"],
          "description": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only."
        },
        "allowedTools": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Tool patterns to allow (used in custom mode). Uses Copilot CLI format — auto-converted for Claude/Qwen. Ignored by Codex, OpenCode, and Gemini (mode-only harnesses)."
        },
        "deniedTools": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Tool patterns to deny (takes precedence over allow list). Ignored by Codex, OpenCode, and Gemini (mode-only harnesses)."
        }
      },
      "additionalProperties": false
    },
    { "type": "null" }
  ],
  "description": "Tool permission overrides for this prompt/workflow. Use null to explicitly disable inherited overrides and fall back to global VS Code settings."
}
```

The `null` option follows the same pattern as `endCondition` — explicitly disabling an inherited override.

### Resulting YAML example

```yaml
# Workflow-level: tighter than global defaults
toolPermissions:
  mode: custom
  allowedTools:
    - read
    - glob
    - grep
  deniedTools:
    - shell(rm:*)
    - write

prompts:
  - prompt: Analyze the codebase structure.
    # Inherits workflow-level toolPermissions

  - prompt: Now implement the changes.
    # Override for this prompt — needs write access
    toolPermissions:
      mode: custom
      allowedTools:
        - write
        - shell(git add:*)
        - shell(git commit:*)
      deniedTools:
        - shell(rm:*)
```

---

## Type Changes (`src/types/FlightPathTypes.ts`)

Add `toolPermissions` to the existing `PromptItem` and workflow-level properties:

```typescript
export interface ToolPermissionsOverride {
  mode?: ToolPermissionMode;           // optional — falls back to global if omitted
  allowedTools?: string[];
  deniedTools?: string[];
}

// In ExecutionProperties (or equivalent workflow-level interface):
toolPermissions?: ToolPermissionsOverride | null;
```

Note: `ToolPermissionMode` is already defined in `src/flightpath/harness/shared/interfaces/IToolPermissionMapper.ts` — import from there to stay DRY.

---

## Three-Tier Resolution

Resolution follows the same pattern used by `harness`, `model`, `agent`, `additionalArgs`:

**Priority order:** prompt-level `toolPermissions` → workflow-level `toolPermissions` → global `ConfigurationUtils` settings

A `PropertyResolver` helper (or inline in `WorkflowExecutor`) assembles the final `ToolPermissionConfig` before passing it to the harness:

```typescript
function resolveToolPermissions(
  promptLevel: ToolPermissionsOverride | null | undefined,
  workflowLevel: ToolPermissionsOverride | null | undefined
): ToolPermissionConfig {
  // Determine effective override following priority: prompt > workflow > global.
  // Important: use explicit undefined checks — not `??` — because null carries meaning
  // ("explicitly use global, skip all overrides") and must NOT fall through to the next tier.
  // `null ?? workflowLevel` would incorrectly return workflowLevel.
  let override: ToolPermissionsOverride | null | undefined;
  if (promptLevel !== undefined) {
    override = promptLevel; // prompt-level wins (including null)
  } else {
    override = workflowLevel; // fall back to workflow-level (including null)
  }

  // null = explicit "use global settings"; undefined = nothing configured
  if (override === null || override === undefined) {
    return {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
  }

  // Merge override fields with global fallbacks for any omitted fields
  return {
    mode: override.mode ?? ConfigurationUtils.getCliToolPermissions(),
    allowedTools:
      override.allowedTools ?? ConfigurationUtils.getCliAllowedTools(),
    deniedTools: override.deniedTools ?? ConfigurationUtils.getCliDeniedTools(),
  };
}
```

This function lives in `src/utils/PropertyResolver.ts` as a `private static resolveToolPermissions()` method, consistent with all other property resolvers in that class. The `ResolvedProperties` interface must also gain a `toolPermissions: ToolPermissionConfig` field, and `PropertyResolver.resolve()` must call it alongside the other resolvers.

---

## Harness Provider Changes

The resolved `ToolPermissionConfig` must be passed into the harness at execution time. Currently each provider reads directly from `ConfigurationUtils`:

```typescript
// Current (CopilotCliProvider.ts, ClaudeCliProvider.ts, etc.)
const permissionConfig = {
  mode: ConfigurationUtils.getCliToolPermissions(),
  allowedTools: ConfigurationUtils.getCliAllowedTools(),
  deniedTools: ConfigurationUtils.getCliDeniedTools(),
};
```

**Change:** Pass resolved config through the execution context.

### Option A: Extend `CliExecutionOptions` (preferred)

`CliIntegration` already receives an options object when `runPrompt()` is called. Add `toolPermissions?: ToolPermissionConfig` to this options type. Providers pick it up from options, falling back to `ConfigurationUtils` if not set.

```typescript
// WorkflowExecutor assembles:
const options: CliExecutionOptions = {
  ...existingOptions,
  toolPermissions: resolveToolPermissions(
    prompt.toolPermissions,
    workflow.toolPermissions
  ),
};
```

```typescript
// CopilotCliProvider.buildArgs() becomes:
const permissionConfig = options.toolPermissions ?? {
  mode: ConfigurationUtils.getCliToolPermissions(),
  allowedTools: ConfigurationUtils.getCliAllowedTools(),
  deniedTools: ConfigurationUtils.getCliDeniedTools(),
};
```

### Option B: Runtime property on `HarnessIntegration`

Less clean — avoids param threading but couples harness state to individual prompts.

**Recommendation: Option A.**

---

## Per-Harness Capability Matrix

Not all harnesses support `allowedTools`/`deniedTools` patterns. This affects both runtime behavior and what the UI should show.

| Harness          | Mode support           | `allowedTools` patterns | `deniedTools` patterns | Notes                                                                                                                                                                                |
| ---------------- | ---------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Copilot CLI**  | ✅ All 3               | ✅ Yes                  | ✅ Yes                 | Most reliable; `--allow-tool` / `--deny-tool`                                                                                                                                        |
| **Claude CLI**   | ✅ All 3               | ✅ Yes                  | ✅ Yes                 | `--allowedTools` / `--disallowedTools`; reliable across models                                                                                                                       |
| **Codex CLI**    | ✅ All 3               | ❌ Ignored              | ❌ Ignored             | Mode-only; `dangerouslyAllowAll`→bypass, `allowAll`→`--full-auto`, `custom`→sandbox+approval flags. Has its own `codexSandboxMode`/`codexApprovalPolicy`/`codexAllowedDirs` settings |
| **OpenCode CLI** | ✅ All 3 (mode mapped) | ❌ Ignored              | ❌ Ignored             | Permission model is config-file driven (`.opencode/opencode.json`), not CLI flags. `buildArgs()` returns `[]`                                                                        |
| **Qwen CLI**     | ✅ All 3               | ✅ Yes                  | ✅ Yes                 | `--allowed-tools` / `--exclude-tools` (comma-separated); `shell`→`Bash`, `write`→`Write`, etc.                                                                                       |
| **Gemini CLI**   | ✅ All 3               | ❌ Ignored              | ❌ Ignored             | Approval-mode flags only (`--approval-mode yolo/auto_edit/default`); no granular tool control                                                                                        |
| **Copilot Chat** | ❌ N/A                 | ❌ N/A                  | ❌ N/A                 | Chat harness; `toolPermissions` stored but has no effect at runtime                                                                                                                  |

### Harness groupings for UX purposes

**Full support** (mode + patterns both work): Copilot CLI, Claude CLI, Qwen CLI

**Mode-only** (mode maps cleanly; patterns silently ignored): Codex CLI, OpenCode CLI, Gemini CLI

**Not applicable**: Copilot Chat

### Codex-specific settings are NOT part of `toolPermissions`

`codexSandboxMode`, `codexApprovalPolicy`, and `codexAllowedDirs` remain global-only VS Code settings — they are not included in the `toolPermissions` override object. This keeps the schema simple: in `custom` mode on Codex, the sandbox/approval configuration always comes from VS Code settings. This is acceptable because:

1. These settings are Codex-specific and have no equivalent on other harnesses.
2. Per-workflow Codex sandbox overrides are an advanced use case that can be revisited later (YAGNI).

---

## UX: Permissions Page (Page 6)

The DRAWER_PAGES_UX_PLAN.md is complete. Both drawers use paged tab navigation with 6 pages. The Permissions page is **Page 6** (`DRAWER_PAGES.PERMISSIONS`). Both drawers currently show a "Coming Soon" placeholder — this section replaces it.

The entire page is greyed out (`pointer-events-none opacity-60`) in CLI-managed (watch) mode, consistent with all other pages.

---

### SettingsDrawer — Permissions Page

Follows the same `FormField` + `SetAsDefaultButton` + `DrawerRow` pattern used on the Harness, Context, Validation, and MCP pages.

#### Layout

```
[Permission Mode ▼]                 [Set as Default]
dangerouslyAllowAll / allowAll / custom

-- shown only when mode = "custom" --

  [Allowed Tools]
  <textarea: one pattern per line>

  [Denied Tools]
  <textarea: one pattern per line>
                                     [Set as Default]   ← single button for the whole object
```

#### Behavior

- **Permission Mode** — `CustomSelect` with three options. Tooltip explains each mode.
  - `dangerouslyAllowAll` — bypass all restrictions (YOLO/dangerous)
  - `allowAll` — auto-approve all tools (respects deny list)
  - `custom` — use `allowedTools` + `deniedTools` lists
- **Allowed/Denied Tools textareas** — appear only when `mode === "custom"` (animated `max-h` transition matching the session ID pattern). Full width, stacked vertically (not two-column).
- Each textarea stores newline-separated patterns, parsed to/from `string[]` on change and blur.
- **Set as Default** — a single `SetAsDefaultButton` for the entire `toolPermissions` object (same approach as `mcpServers`). Appears when `isDifferentFromGlobal("toolPermissions")` is true. Clicking it calls `handleSetAsDefault("toolPermissions", workflowProperties.toolPermissions)`.
- When `toolPermissions` is `undefined` on the workflow, the controls show the effective global values (read from `globalSettings.toolPermissions`) and no "Set as Default" button appears.
- There is no dedicated "Reset to global" control — clearing the workflow value back to `undefined` is done by setting mode to the same value as the global and clearing the tool lists, at which point `isDifferentFromGlobal` becomes false.

#### Harness-aware inline warnings

The textareas and mode selector render for all harnesses (the values are stored and travel with the workflow file). However, the UI must surface per-harness caveats inline on the Permissions page. Use a muted notice `<p>` element styled like the `"Use {error} placeholder..."` hint text on the Validation page.

**Copilot Chat — not applicable:**

```
ℹ️ Tool permissions apply to CLI harnesses only and are ignored for Copilot Chat.
```

The entire page body is dimmed (`opacity-60`) when effective harness is `copilot-chat`.

**Codex CLI — mode only:**

```
ℹ️ Codex CLI uses sandbox/approval modes rather than individual tool patterns.
  Allowed Tools and Denied Tools lists are ignored. Configure sandbox mode in
  VS Code settings (codexSandboxMode, codexApprovalPolicy).
```

Show when effective harness is `codex-cli` and `mode === "custom"`. The textareas are still rendered but dimmed (`opacity-50 pointer-events-none`).

**OpenCode CLI — mode only:**

```
ℹ️ OpenCode CLI manages permissions via config file. Tool pattern lists are ignored.
```

Same rendering treatment as Codex.

**Gemini CLI — mode only:**

```
ℹ️ Gemini CLI uses approval modes only. Tool pattern lists are ignored.
```

Same rendering treatment.

**Helper for determining the effective harness on the Permissions page:**

Both drawers already track effective harness:

- `SettingsDrawer`: use `effectiveHarness` (already derived via `getEffectiveHarness()`)
- `PropertiesDrawer`: use `currentHarness` (already derived as `properties.harness ?? globalSettings.harness`)

Create a small helper for classifying warning type:

```typescript
type PermissionHarnessSupport =
  | "full"       // Copilot CLI, Claude CLI, Qwen CLI — mode + patterns both work
  | "mode-only"  // Codex CLI, OpenCode CLI, Gemini CLI — patterns ignored
  | "n/a";       // Copilot Chat

function getPermissionHarnessSupport(
  harnessId: HarnessId
): PermissionHarnessSupport {
  switch (harnessId) {
    case HARNESS_IDS.COPILOT_CLI:
    case HARNESS_IDS.CLAUDE_CLI:
    case HARNESS_IDS.QWEN_CLI:
      return "full";
    case HARNESS_IDS.CODEX_CLI:
    case HARNESS_IDS.OPENCODE_CLI:
    case HARNESS_IDS.GEMINI_CLI:
      return "mode-only";
    case HARNESS_IDS.COPILOT_CHAT:
    default:
      return "n/a";
  }
}
```

This helper lives inline in the drawer (or extracted to a shared util if it grows). The switch drives both the warning text and the `opacity-50 pointer-events-none` dimming on the textareas.

---

### PropertiesDrawer — Permissions Page

The PropertiesDrawer shows per-prompt override controls with `Default (X)` labels resolving through the three-tier chain.

#### Layout

```
[Permission Mode ▼]
Default (allowAll) / dangerouslyAllowAll / allowAll / custom / None (use global)

-- shown only when mode is explicitly "custom" (not Default, not None) --

  [Allowed Tools]
  <textarea: one pattern per line>

  [Denied Tools]
  <textarea: one pattern per line>

-- harness-aware inline warning (same rules as SettingsDrawer above) --
```

#### Default label resolution

Add a `buildPermissionsDefaultLabel(resolved: ToolPermissionsOverride | null | undefined): string` helper (in `src/ui/webview-react/components/shared/` alongside `buildMcpDefaultLabel`), following the same pattern:

```typescript
function buildPermissionsDefaultLabel(
  resolved: ToolPermissionsOverride | null | undefined
): string {
  if (!resolved || resolved.mode === undefined)
    return "Default (global settings)";
  if (resolved.mode === "dangerouslyAllowAll")
    return "Default (dangerouslyAllowAll)";
  if (resolved.mode === "allowAll") return "Default (allowAll)";
  const count =
    (resolved.allowedTools?.length ?? 0) + (resolved.deniedTools?.length ?? 0);
  return `Default (custom, ${count} rule${count !== 1 ? "s" : ""})`;
}
```

The resolved value for the label is: `workflowProperties.toolPermissions ?? globalSettings.toolPermissions`.

#### `null` vs `undefined` semantics for PropertiesDrawer

- `undefined` — inherit from workflow → global (the "Default (X)" option)
- object — per-prompt override
- `null` — explicitly bypass workflow override and fall back directly to global settings

The dropdown includes a **"None (use global settings)"** option that sets `toolPermissions = null`. This lets a prompt skip a workflow-level override without re-specifying the global values.

#### Harness-aware inline warnings

Same logic as SettingsDrawer using `getPermissionHarnessSupport(currentHarness)`. The resolved harness for the PropertiesDrawer is `properties.harness ?? workflowProperties.harness ?? globalSettings.harness` (already tracked as `currentHarness` in the drawer).

---

### Narrow/Wide layout (both drawers)

- Wide (`isNarrow === false`): Mode selector full width with label. Tool list textareas below, full width.
- Narrow: same — this page is naturally single-column since textareas span full width anyway.

The `DrawerRow` component is used only for the mode row if a two-column layout is desired; the textareas always go full width.

---

## Store Changes (`settingsStore.ts` / `WebviewSettingsSync.ts`)

### `WorkflowProperties` (`settingsStore.ts`)

Add `toolPermissions` to both `WorkflowProperties` (workflow-level) and `GlobalSettings`:

```typescript
// WorkflowProperties — per-workflow override
toolPermissions?: {
  mode?: ToolPermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
} | null;

// GlobalSettings — mirrors VS Code settings for "Set as Default" comparison
toolPermissions: {
  mode: ToolPermissionMode;   // from ConfigurationUtils.getCliToolPermissions()
  allowedTools: string[];     // from ConfigurationUtils.getCliAllowedTools()
  deniedTools: string[];      // from ConfigurationUtils.getCliDeniedTools()
};
```

### `isDifferentFromGlobal` special case

Add a case in `SettingsDrawer`'s `isDifferentFromGlobal` callback:

```typescript
if (property === "toolPermissions") {
  if (!workflowValue) return false; // undefined/null = no override
  const globalPerms = globalSettings.toolPermissions;
  // Compare each sub-field; undefined sub-fields in the workflow value
  // fall back to global, so they are never "different"
  const modesDiffer =
    workflowValue.mode !== undefined && workflowValue.mode !== globalPerms.mode;
  const allowedDiffer =
    workflowValue.allowedTools !== undefined &&
    JSON.stringify(workflowValue.allowedTools) !==
      JSON.stringify(globalPerms.allowedTools);
  const deniedDiffer =
    workflowValue.deniedTools !== undefined &&
    JSON.stringify(workflowValue.deniedTools) !==
      JSON.stringify(globalPerms.deniedTools);
  return modesDiffer || allowedDiffer || deniedDiffer;
}
```

### `getEffectiveToolPermissions` (`settingsStore.ts`)

Add a resolver getter following the pattern of `getEffectiveResumeSession`:

```typescript
getEffectiveToolPermissions: () => {
  const { workflowProperties, globalSettings } = get();
  return workflowProperties.toolPermissions ?? globalSettings.toolPermissions;
};
```

### `PropertyValues` (`editorStore.ts`)

Add `toolPermissions` to the `PropertyValues` interface and `PROPERTY_DEFAULTS`:

```typescript
// PropertyValues
toolPermissions: Disableable<ToolPermissionsOverride>; // undefined = inherit, null = reset to global, object = override

// PROPERTY_DEFAULTS
toolPermissions: undefined,
```

Also add the serialization case in `buildPromptItem()`:

```typescript
if (properties.toolPermissions !== undefined) {
  result.toolPermissions = properties.toolPermissions;
}
```

### `WebviewSettingsSync.buildGlobalSettings()` (`WebviewSettingsSync.ts`)

Add tool permission values to the `buildGlobalSettings()` return:

```typescript
toolPermissions: {
  mode: ConfigurationUtils.getCliToolPermissions(),
  allowedTools: ConfigurationUtils.getCliAllowedTools(),
  deniedTools: ConfigurationUtils.getCliDeniedTools(),
},
```

### `initialGlobalSettings` (`settingsStore.ts`)

Add to the initial value:

```typescript
toolPermissions: {
  mode: "allowAll",   // matches VS Code setting default
  allowedTools: [],
  deniedTools: [],
},
```

### Message

Reuses the existing `UPDATE_WORKFLOW_PROPERTY` message with `property: "toolPermissions"`. No new message type needed.

---

## Extension-Side Handling (`WebviewSettingsSync.ts` + `FlightPathWebviewProvider.ts`)

The `UPDATE_WORKFLOW_PROPERTY` handler already routes arbitrary properties through to the working file. No new message type needed. The extension writes the value to the `.flightpath.yaml` working file, which the `PromptFileParser` then picks up on next run.

The `SET_AS_DEFAULT` handler in `WebviewSettingsSync.handleSetAsDefault()` requires a new branch for the compound `toolPermissions` property — it cannot use the generic `ConfigurationUtils.updateSetting(property, value)` fallback because `toolPermissions` maps to **three separate** VS Code settings:

```typescript
// In WebviewSettingsSync.handleSetAsDefault() — add alongside the mcpServers branch:
} else if (property === "toolPermissions") {
  // value is ToolPermissionsOverride — split into 3 individual settings
  await ConfigurationUtils.updateSetting("cliToolPermissions", value?.mode ?? "allowAll");
  await ConfigurationUtils.updateSetting("cliAllowedTools", value?.allowedTools ?? []);
  await ConfigurationUtils.updateSetting("cliDeniedTools", value?.deniedTools ?? []);
}
```

---

## Implementation Steps

1. **Schema** — Add `toolPermissions` to `executionProperties` in `schemas/prompt-schema.json`. Run `npm run compile` (which includes schema generation).

2. **Types (`FlightPathTypes.ts`)** — Add `ToolPermissionsOverride` interface. Import `ToolPermissionMode` from `IToolPermissionMapper.ts` (already defined there). Add `toolPermissions?: ToolPermissionsOverride | null` to `ExecutionProperties` — this automatically makes it available on `PromptItem` (which extends `ExecutionProperties`).

3. **Resolver (`PropertyResolver.ts`)** — Add `private static resolveToolPermissions(prompt, workflow)` to `PropertyResolver.ts` alongside the other resolver methods. Add `toolPermissions: ToolPermissionConfig` to the `ResolvedProperties` interface and call `this.resolveToolPermissions(prompt, workflow)` inside `PropertyResolver.resolve()`. Use explicit `!== undefined` checks (not `??`) to handle the `null` = "use global" semantic correctly. A standalone `ToolPermissionResolver.ts` is NOT needed — follow the existing pattern.

4. **WorkflowExecutor** — No direct `resolveToolPermissions` call needed. The resolved `toolPermissions` is now available on `resolvedProperties` from `PropertyResolver.resolve()`. Pass it as part of the execution options/context into the harness (Option A below).

5. **Harness providers** — Update `CopilotCliProvider`, `ClaudeCliProvider`, `CodexCliProvider`, `OpenCodeCliProvider`, `QwenCliProvider`, `GeminiCliProvider` to accept a resolved `ToolPermissionConfig` from the execution context (Option A: extend the options/context passed into each provider's `buildArgs()`). Keep `ConfigurationUtils` direct call as the fallback for code paths that don't go through `WorkflowExecutor` (e.g., `hasFullPermissions()` pre-flight check in `CliIntegration`).

6. **`GlobalSettings` + `settingsStore`** — Add `toolPermissions` to `GlobalSettings` interface, `initialGlobalSettings`, and `WorkflowProperties`. Add `getEffectiveToolPermissions()` action.

7. **`WebviewSettingsSync.handleSetAsDefault()`** — Add a `toolPermissions` branch that splits the compound object into three `ConfigurationUtils.updateSetting()` calls (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`). See the Extension-Side Handling section above.

8. **`WebviewSettingsSync.buildGlobalSettings()`** — Add `toolPermissions` field populated from `ConfigurationUtils`.

9. **`PropertyValues` + `editorStore`** — Add `toolPermissions` to `PropertyValues` interface, `PROPERTY_DEFAULTS`, and the `buildPromptItem()` serialization path.

10. **`SettingsDrawer`** — Replace the "Coming Soon" block for `DRAWER_PAGES.PERMISSIONS` with the permission mode selector, conditional textareas, and `SetAsDefaultButton`. Add `toolPermissions` case to `isDifferentFromGlobal`. Add `handleToolPermissionsChange` handler.

11. **`PropertiesDrawer`** — Replace the "Coming Soon" block for `DRAWER_PAGES.PERMISSIONS` with the permission mode dropdown (including "Default (X)" and "Reset to global" options) and conditional textareas. Add `buildPermissionsDefaultLabel` helper.

12. **Tests** — Update `ToolPermissionMappers.test.ts` for any mapper changes. Add `PropertyResolver` tests for `resolveToolPermissions` covering: `null` at prompt level bypasses workflow level, `null` at workflow level uses global, undefined at both uses global, per-field merging with global fallbacks. Add settingsStore tests for `getEffectiveToolPermissions` and `isDifferentFromGlobal("toolPermissions")`.

---

## What Does NOT Change

- Global VS Code settings (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) remain the default and fallback — no migration needed.
- `ConfigurationUtils` API is unchanged; the resolver calls it for fallback values.
- **Codex-specific settings** (`codexSandboxMode`, `codexApprovalPolicy`, `codexAllowedDirs`) remain global-only VS Code settings and are **not** part of the `toolPermissions` override object. Per-workflow Codex sandbox configuration is deferred (YAGNI).
- **OpenCode permissions** remain config-file driven. `toolPermissions` mode maps to the same no-op behavior as today; patterns are silently ignored.
- Chat harness (`copilot-chat`) ignores `toolPermissions` at execution time. The UI shows a caveat and dims the page, but values are still stored and travel with the workflow file.
- The existing `hasFullPermissions()` / headless-without-permissions warning continues to read from `ConfigurationUtils` as before, since it's a pre-flight check (not per-prompt).
- `QwenCliProvider` and `GeminiCliProvider` are included in the harness provider changes (they also call `ConfigurationUtils` directly today and need the same update). For Gemini and other mode-only harnesses, the mapper continues to ignore `allowedTools`/`deniedTools` — the resolver simply passes them through and the mapper discards them.
