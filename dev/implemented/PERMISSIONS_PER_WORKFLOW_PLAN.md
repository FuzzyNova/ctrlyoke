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
          "enum": ["dangerouslyAllowAll", "allowAll", "custom", "passthrough"],
          "description": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'passthrough' omits all FlightPath permission flags — the harness uses whatever permissions the user has configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config)."
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
  "description": "Tool permission overrides for this prompt/workflow. Use null to explicitly disable inherited overrides and fall back to global VS Code settings. Set mode to 'passthrough' to omit all FlightPath permission flags and rely entirely on the harness's own local configuration."
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

  - prompt: Run the test suite however you usually would.
    # Let the harness use its own configured defaults — no FlightPath flags injected
    toolPermissions:
      mode: passthrough

  - prompt: Generate a report.
    # Explicitly bypass workflow-level override — fall back to global VS Code settings
    toolPermissions: null
```

**`passthrough` vs `null` at a glance:**

| `toolPermissions` value   | Resolver behavior                         | Flags injected?                        |
| ------------------------- | ----------------------------------------- | -------------------------------------- |
| `undefined`               | Inherit from next tier                    | Depends on tier                        |
| `null`                    | Stop falling; use global VS Code settings | Yes (global mode)                      |
| `{ mode: "passthrough" }` | Stop falling; inject nothing              | No — harness uses its own local config |

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

Note: `ToolPermissionMode` is already defined in `src/flightpath/harness/shared/interfaces/IToolPermissionMapper.ts` — import from there to stay DRY. Add `"passthrough"` to that union type; update all harness `buildArgs()` implementations to return `[]` when `mode === "passthrough"` and `hasFullPermissions()` to return `false`.

---

## Two-Tier Resolution

`toolPermissions` follows the same **seeded-at-creation, two-tier-at-runtime** pattern as `harness`, `model`, `agent`, etc. — not the `endCondition`/`sessionId` pattern.

**How this works:** When a working file is created from a `.flightpath.yaml`, `PromptFileLoader.populateSettingsDefaults()` reads VS Code settings and writes explicit values into the working file for any property not specified in the source file. `toolPermissions` is included in this seeding — when a new workflow is created, it inherits the user's `cliToolPermissions`, `cliAllowedTools`, and `cliDeniedTools` VS Code settings as its starting point. By the time `PropertyResolver` runs at execution time, the working file already has explicit values and the VS Code fallback is never hit in normal usage.

This is the right behavior because permissions are a user preference that applies consistently across workflows — unlike `endCondition` or `sessionId` which are inherently workflow-specific and have no meaningful global default.

**`PropertyResolver` is still two-tier at runtime:** No `ConfigurationUtils` calls inside `resolveToolPermissions`. If both prompt and workflow are `undefined` (edge case: no workspace folder, or manual file without seeding), the resolver returns `null` (passthrough).

**Priority order:** prompt-level `toolPermissions` → workflow-level `toolPermissions` → no flags (passthrough)

`null`, `undefined`, and `{ mode: "passthrough" }` all resolve the same way at runtime: inject no permission flags and let the harness use whatever it has configured locally.

```typescript
function resolveToolPermissions(
  promptLevel: ToolPermissionsOverride | null | undefined,
  workflowLevel: ToolPermissionsOverride | null | undefined
): ToolPermissionConfig | null {
  // Prompt takes precedence; use explicit undefined check — null is meaningful ("no flags")
  const effective = promptLevel !== undefined ? promptLevel : workflowLevel;

  // null, undefined, or { mode: "passthrough" } → inject no flags
  if (
    effective === null ||
    effective === undefined ||
    effective.mode === "passthrough"
  ) {
    return null; // providers: if (config === null) return [];
  }

  return {
    mode: effective.mode ?? "allowAll", // within-object fallback only
    allowedTools: effective.allowedTools ?? [],
    deniedTools: effective.deniedTools ?? [],
  };
}
```

**No `ConfigurationUtils` calls inside `resolveToolPermissions`.** The resolver is self-contained; there is no third tier.

This function lives in `src/utils/PropertyResolver.ts` as a `private static resolveToolPermissions()` method. The `ResolvedProperties` interface gains a `toolPermissions: ToolPermissionConfig | null` field (`null` = passthrough). `PropertyResolver.resolve()` calls it alongside the other resolvers.

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
const permissionConfig = options.toolPermissions; // null = passthrough
if (permissionConfig === null) {
  return []; // No flags — harness uses its own local config
}
// ... build flags from permissionConfig as before
```

The `options.toolPermissions` fallback when `WorkflowExecutor` doesn't supply it (e.g., pre-flight `hasFullPermissions()` checks in `CliIntegration`) continues to read directly from `ConfigurationUtils` — those code paths are not per-prompt and don't go through `resolveToolPermissions`.

### Option B: Runtime property on `HarnessIntegration`

Less clean — avoids param threading but couples harness state to individual prompts.

**Recommendation: Option A.**

---

## Per-Harness Capability Matrix

Not all harnesses support `allowedTools`/`deniedTools` patterns. This affects both runtime behavior and what the UI should show.

| Harness          | Mode support                 | `allowedTools` patterns | `deniedTools` patterns | Notes                                                                                                                                                                                |
| ---------------- | ---------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Copilot CLI**  | ✅ All 4 (incl. passthrough) | ✅ Yes                  | ✅ Yes                 | Most reliable; `--allow-tool` / `--deny-tool`                                                                                                                                        |
| **Claude CLI**   | ✅ All 4 (incl. passthrough) | ✅ Yes                  | ✅ Yes                 | `--allowedTools` / `--disallowedTools`; passthrough falls back to `~/.claude/settings.json`                                                                                          |
| **Codex CLI**    | ✅ All 4 (incl. passthrough) | ❌ Ignored              | ❌ Ignored             | Mode-only; `dangerouslyAllowAll`→bypass, `allowAll`→`--full-auto`, `custom`→sandbox+approval flags. Has its own `codexSandboxMode`/`codexApprovalPolicy`/`codexAllowedDirs` settings |
| **OpenCode CLI** | ✅ All 4 (incl. passthrough) | ❌ Ignored              | ❌ Ignored             | Permission model is config-file driven (`.opencode/opencode.json`), not CLI flags. `buildArgs()` returns `[]`                                                                        |
| **Qwen CLI**     | ✅ All 4 (incl. passthrough) | ✅ Yes                  | ✅ Yes                 | `--allowed-tools` / `--exclude-tools` (comma-separated); `shell`→`Bash`, `write`→`Write`, etc.                                                                                       |
| **Gemini CLI**   | ✅ All 4 (incl. passthrough) | ❌ Ignored (Phase 1)    | ❌ Ignored (Phase 1)   | Phase 1: approval-mode flags only (`--approval-mode yolo/auto_edit/default`). Phase 2 (future): policy engine TOML — see Gemini Policy Engine section below.                         |
| **Copilot Chat** | ❌ N/A                       | ❌ N/A                  | ❌ N/A                 | Chat harness; `toolPermissions` stored but has no effect at runtime                                                                                                                  |

### `passthrough` mode behavior (all harnesses)

When `mode === "passthrough"`, every harness's `buildArgs()` returns `[]` immediately — no permission flags are appended to the CLI invocation. The harness process starts with whatever permission configuration the user has set up outside of FlightPath (e.g., `~/.claude/settings.json` for Claude, the user's Copilot CLI defaults, etc.).

`hasFullPermissions()` returns `false` for passthrough since FlightPath cannot know what the harness's local config allows. This means the pre-flight headless-without-permissions warning is suppressed (the user is explicitly opting in to harness-managed permissions).

### Harness groupings for UX purposes

**Full support** (mode + patterns both work): Copilot CLI, Claude CLI, Qwen CLI

**Mode-only** (mode maps cleanly; patterns silently ignored): Codex CLI, OpenCode CLI, Gemini CLI (Phase 1)

**Not applicable**: Copilot Chat

> `passthrough` is available on all harnesses and is always treated as "full support" since it produces no flags.

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

- **Permission Mode** — `CustomSelect` with four options. Tooltip explains each mode.
  - `dangerouslyAllowAll` — bypass all restrictions (YOLO/dangerous)
  - `allowAll` — auto-approve all tools (respects deny list)
  - `custom` — use `allowedTools` + `deniedTools` lists
  - `passthrough` — omit all permission flags; use harness local settings (e.g. `~/.claude/settings.json`)
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
  | "full" // Copilot CLI, Claude CLI, Qwen CLI — mode + patterns both work
  | "mode-only" // Codex CLI, OpenCode CLI, Gemini CLI — patterns ignored
  | "n/a"; // Copilot Chat

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
Default (allowAll) / dangerouslyAllowAll / allowAll / custom / passthrough / None (use global)

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
  workflowValue: ToolPermissionsOverride | null | undefined
): string {
  // null, undefined, or passthrough mode all mean "no flags"
  if (
    workflowValue === null ||
    workflowValue === undefined ||
    workflowValue.mode === "passthrough"
  ) {
    return "Default (none / passthrough)";
  }
  if (workflowValue.mode === "dangerouslyAllowAll")
    return "Default (dangerouslyAllowAll)";
  if (workflowValue.mode === "allowAll") return "Default (allowAll)";
  const count =
    (workflowValue.allowedTools?.length ?? 0) +
    (workflowValue.deniedTools?.length ?? 0);
  return `Default (custom, ${count} rule${count !== 1 ? "s" : ""})`;
}
```

The input to this helper is `workflowProperties.toolPermissions` only — no global fallback. If the workflow hasn't configured permissions, the label reads "Default (none / passthrough)".

#### `null` vs `undefined` semantics for PropertiesDrawer

- `undefined` — inherit from workflow (the "Default (X)" option)
- object — per-prompt override (including `{ mode: "passthrough" }`)
- `null` — passthrough: inject no permission flags for this prompt, regardless of what the workflow specifies

The dropdown includes a **"None (passthrough)"** option that sets `toolPermissions = null`. This lets a prompt explicitly opt out of the workflow's permission config — the harness runs that prompt with its own local defaults. `null` and `{ mode: "passthrough" }` are runtime-equivalent; `null` is the idiomatic way to express it at the prompt level.

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

Add `toolPermissions` to `WorkflowProperties` only — **not** to `GlobalSettings`. VS Code settings are not a runtime fallback; they only feed the initial workflow creation:

```typescript
// WorkflowProperties — workflow-level source of truth
toolPermissions?: {
  mode?: ToolPermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
} | null; // null = passthrough (no flags)
```

`GlobalSettings` does **not** get a `toolPermissions` field. The VS Code settings (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) are read directly from `ConfigurationUtils` only when creating a new workflow (to pre-populate the SettingsDrawer fields) and when the user clicks "Set as Default".

### `isDifferentFromGlobal` special case

The "Set as Default" button in SettingsDrawer should appear when the workflow's `toolPermissions` differs from the current VS Code defaults. Since `GlobalSettings` no longer carries `toolPermissions`, read VS Code settings directly for this comparison:

```typescript
if (property === "toolPermissions") {
  const vs = {
    mode: ConfigurationUtils.getCliToolPermissions(),
    allowedTools: ConfigurationUtils.getCliAllowedTools(),
    deniedTools: ConfigurationUtils.getCliDeniedTools(),
  };
  // null/undefined workflow value means "passthrough"; compare passthrough against VS Code default
  if (!workflowValue || workflowValue.mode === "passthrough") {
    return vs.mode !== "passthrough"; // different if VS Code default is not also passthrough
  }
  return (
    (workflowValue.mode !== undefined && workflowValue.mode !== vs.mode) ||
    (workflowValue.allowedTools !== undefined &&
      JSON.stringify(workflowValue.allowedTools) !==
        JSON.stringify(vs.allowedTools)) ||
    (workflowValue.deniedTools !== undefined &&
      JSON.stringify(workflowValue.deniedTools) !==
        JSON.stringify(vs.deniedTools))
  );
}
```

### `getEffectiveToolPermissions` (`settingsStore.ts`)

Returns the workflow value as-is (no global fallback). Used by the PropertiesDrawer to build the "Default (X)" label:

```typescript
getEffectiveToolPermissions: () => {
  const { workflowProperties } = get();
  return workflowProperties.toolPermissions; // null or undefined = passthrough/no flags
};
```

### `PropertyValues` (`editorStore.ts`)

Add `toolPermissions` to the `PropertyValues` interface and `PROPERTY_DEFAULTS`:

```typescript
// PropertyValues
toolPermissions: Disableable<ToolPermissionsOverride>; // undefined = inherit workflow, null = passthrough, object = override

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

No `toolPermissions` field is added to `buildGlobalSettings()`. The VS Code defaults are read lazily via `ConfigurationUtils` only when needed (new workflow creation seeding and `isDifferentFromGlobal` comparison).

### Message

Reuses the existing `UPDATE_WORKFLOW_PROPERTY` message with `property: "toolPermissions"`. No new message type needed.

---

## Extension-Side Handling (`WebviewSettingsSync.ts` + `FlightPathWebviewProvider.ts`)

The `UPDATE_WORKFLOW_PROPERTY` handler already routes arbitrary properties through to the working file. No new message type needed. The extension writes the value to the `.flightpath.yaml` working file, which the `PromptFileParser` then picks up on next run.

The `SET_AS_DEFAULT` handler in `WebviewSettingsSync.handleSetAsDefault()` requires a new branch for the compound `toolPermissions` property — it cannot use the generic `ConfigurationUtils.updateSetting(property, value)` fallback because `toolPermissions` maps to **three separate** VS Code settings. "Set as Default" here means: update VS Code settings so that new workflows are pre-populated with these permission values:

```typescript
// In WebviewSettingsSync.handleSetAsDefault() — add alongside the mcpServers branch:
} else if (property === "toolPermissions") {
  // value is ToolPermissionsOverride | null — split into 3 individual VS Code settings
  // null/passthrough → reset VS Code settings to their default (allowAll, [], [])
  const override = value as ToolPermissionsOverride | null;
  await ConfigurationUtils.updateSetting(
    "cliToolPermissions",
    override?.mode && override.mode !== "passthrough" ? override.mode : "allowAll"
  );
  await ConfigurationUtils.updateSetting("cliAllowedTools", override?.allowedTools ?? []);
  await ConfigurationUtils.updateSetting("cliDeniedTools", override?.deniedTools ?? []);
}
```

---

## Gemini Policy Engine (Phase 2 — Future)

Gemini CLI has a policy engine (documented at `https://geminicli.com/docs/reference/policy-engine/`) that supports fine-grained tool control through a TOML configuration file — typically `~/.gemini/settings.toml` or a workspace-local equivalent. This is the **only way to achieve per-tool granular permission control with Gemini CLI through FlightPath**.

### Why this is deferred

Supporting Gemini policy-engine permissions at the per-workflow level would require FlightPath to:

1. **Parse** the user's existing Gemini TOML policy file (or create one if absent)
2. **Merge** the workflow's `allowedTools`/`deniedTools` into the TOML structure — this requires understanding Gemini's tool-naming format and policy schema, which may differ from FlightPath's Copilot-format tool patterns
3. **Write** a modified policy file before launching Gemini
4. **Restore** the original policy file after execution (or clean up a temp file)

The merge step is the main complexity: Gemini uses its own tool identifiers (not the `shell(git:*)` Copilot format), so a translation layer is required. Conflicting with an existing user policy is also possible, and the restore/cleanup must be robust against crashes and cancellations.

### Phase 1 behavior (current plan)

In Phase 1, Gemini treats `toolPermissions` as mode-only:

- `dangerouslyAllowAll` → `--approval-mode yolo`
- `allowAll` → `--approval-mode auto_edit`
- `custom` → `--approval-mode default` (patterns ignored; mode falls back to `default`)
- `passthrough` → no flags (Gemini uses its own local policy/settings)

The UI shows the "mode-only" warning when the effective harness is Gemini and `mode === "custom"`, identical to Codex and OpenCode.

### Phase 2 approach (when implemented)

When Phase 2 is implemented, the recommended approach is:

1. Add a `GeminiPolicyWriter` class in `src/flightpath/harness/gemini/` responsible for TOML merge-write-restore
2. Call `GeminiPolicyWriter.applyWorkflowPermissions(config)` in `WorkflowExecutor` before invoking Gemini, and `GeminiPolicyWriter.restore()` in the finally block
3. Update the UI to remove the "patterns ignored" warning for Gemini and show a note about policy file modification

The policy file path and merge strategy should be researched against the Gemini CLI docs when Phase 2 is scoped. **Do not attempt to implement Phase 2 as part of the initial permissions feature.**

---

## Implementation Steps

1. **Schema** — Add `toolPermissions` to `executionProperties` in `schemas/prompt-schema.json`. Run `npm run compile` (which includes schema generation).

2. **Types (`FlightPathTypes.ts` + `IToolPermissionMapper.ts`)** — Add `"passthrough"` to the `ToolPermissionMode` union in `IToolPermissionMapper.ts`. Add `ToolPermissionsOverride` interface to `FlightPathTypes.ts` and import `ToolPermissionMode` from `IToolPermissionMapper.ts`. Add `toolPermissions?: ToolPermissionsOverride | null` to `ExecutionProperties`.

3. **Resolver (`PropertyResolver.ts`)** — Add `private static resolveToolPermissions(prompt, workflow)` as a **two-tier resolver** (no `ConfigurationUtils` calls — no VS Code fallback at runtime). Add `toolPermissions: ToolPermissionConfig | null` to `ResolvedProperties` (`null` = passthrough). Call it in `PropertyResolver.resolve()`. Logic: prompt wins if defined (including `null`), else workflow; `null`/`undefined`/`{ mode: "passthrough" }` all return `null`.

4. **WorkflowExecutor** — The resolved `toolPermissions` is available on `resolvedProperties`. Pass it as part of execution options/context into the harness.

5. **Harness providers** — Update `CopilotCliProvider`, `ClaudeCliProvider`, `CodexCliProvider`, `OpenCodeCliProvider`, `QwenCliProvider`, `GeminiCliProvider` to accept `ToolPermissionConfig | null` from execution context. Guard: `if (config === null) return [];` at the top of every provider's `buildArgs()`. For `hasFullPermissions()`, return `false` when `config === null`. Keep `ConfigurationUtils` direct-read as fallback only for code paths that don't go through `WorkflowExecutor` (pre-flight checks).

6. **`settingsStore`** — Add `toolPermissions` to `WorkflowProperties` only (NOT `GlobalSettings`). Add `getEffectiveToolPermissions()` action that returns `workflowProperties.toolPermissions` with no global fallback.

7. **`WebviewSettingsSync.handleSetAsDefault()`** — Add a `toolPermissions` branch that writes the workflow value back to the three separate VS Code settings (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) so new workflows are pre-populated with these values. See the Extension-Side Handling section above.

8. **`WebviewSettingsSync.buildGlobalSettings()`** — No `toolPermissions` field added. VS Code permission settings are read lazily via `ConfigurationUtils` only for `isDifferentFromGlobal` and new-workflow seeding.

9. **`PropertyValues` + `editorStore`** — Add `toolPermissions` to `PropertyValues` interface, `PROPERTY_DEFAULTS`, and the `buildPromptItem()` serialization path.

10. **`PromptFileLoader`** — Add `toolPermissions` to `populateSettingsDefaults()`. When a new working file is created without an explicit `toolPermissions` in the source file, seed it from `ConfigurationUtils.getCliToolPermissions()`, `getCliAllowedTools()`, and `getCliDeniedTools()`. This is the same pattern as `harness`, `model`, and `resumeSession`.

11. **`SettingsDrawer`** — Replace the "Coming Soon" block for `DRAWER_PAGES.PERMISSIONS` with the permission mode selector, conditional textareas, and `SetAsDefaultButton`. Add `toolPermissions` case to `isDifferentFromGlobal` (compare against `ConfigurationUtils` directly, not `globalSettings`). Add `handleToolPermissionsChange` handler.

12. **`PropertiesDrawer`** — Replace the "Coming Soon" block for `DRAWER_PAGES.PERMISSIONS` with the permission mode dropdown (including "Default (X)" and "None (passthrough)" options) and conditional textareas. Add `buildPermissionsDefaultLabel` helper (uses `workflowProperties.toolPermissions` only — no global fallback needed since working file is always seeded).

13. **Tests** — Update `ToolPermissionMappers.test.ts` for `passthrough` guard in `buildArgs()`. Add `PropertyResolver` tests for `resolveToolPermissions` covering: `null` at prompt = passthrough (ignores workflow), `null` at workflow = passthrough, `undefined` at both = passthrough, `{ mode: "passthrough" }` = passthrough, explicit config at prompt overrides workflow. Add `PromptFileLoader.populateSettingsDefaults` test confirming `toolPermissions` IS included in the seeded defaults. Add settingsStore tests for `getEffectiveToolPermissions` and `isDifferentFromGlobal("toolPermissions")`.

---

## What Does NOT Change

- Global VS Code settings (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) continue to be the user's default permission preferences. They are seeded into new working files (via `populateSettingsDefaults`) just like `harness` and `model`, and are the target of "Set as Default". They are NOT consulted at runtime by `PropertyResolver` — the seeded working file values are.
- `ConfigurationUtils` API is unchanged; it is called from `populateSettingsDefaults`, `isDifferentFromGlobal`, and `handleSetAsDefault` — never directly from `resolveToolPermissions`.
- **Codex-specific settings** (`codexSandboxMode`, `codexApprovalPolicy`, `codexAllowedDirs`) remain global-only VS Code settings and are **not** part of the `toolPermissions` override object. Per-workflow Codex sandbox configuration is deferred (YAGNI).
- **OpenCode permissions** remain config-file driven. `toolPermissions` mode maps to the same no-op behavior as today; patterns are silently ignored.
- **Gemini granular tool control** (Phase 2 — policy engine TOML) is deferred. Phase 1 supports mode-only approval flags. See the Gemini Policy Engine section above.
- Chat harness (`copilot-chat`) ignores `toolPermissions` at execution time. The UI shows a caveat and dims the page, but values are still stored and travel with the workflow file.
- The existing `hasFullPermissions()` / headless-without-permissions pre-flight check in `CliIntegration` continues to read from `ConfigurationUtils` as before (it is not per-prompt). When the resolved `toolPermissions` is `null` (passthrough), providers return `false` from `hasFullPermissions()` — the warning is suppressed because the user has explicitly opted in to harness-managed permissions.
- `QwenCliProvider` and `GeminiCliProvider` are included in the harness provider changes (they also call `ConfigurationUtils` directly today and need the same update). For Gemini and other mode-only harnesses, the mapper continues to ignore `allowedTools`/`deniedTools` — the resolver simply passes them through and the mapper discards them.
