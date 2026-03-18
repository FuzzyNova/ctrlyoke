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
          "description": "Tool patterns to allow (used in custom mode). Uses Copilot CLI format — auto-converted for Claude/Codex."
        },
        "deniedTools": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Tool patterns to deny (takes precedence over allow list)."
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
  // null = explicit "use global" (override cleared)
  const override = promptLevel ?? workflowLevel;  // null short-circuits to global

  if (!override || override === null) {
    // Fall back to global VS Code settings
    return {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
  }

  return {
    mode: override.mode ?? ConfigurationUtils.getCliToolPermissions(),
    allowedTools: override.allowedTools ?? ConfigurationUtils.getCliAllowedTools(),
    deniedTools: override.deniedTools ?? ConfigurationUtils.getCliDeniedTools(),
  };
}
```

This function lives in a shared utility (e.g., `src/utils/ToolPermissionResolver.ts`) to keep harness providers DRY.

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
  toolPermissions: resolveToolPermissions(prompt.toolPermissions, workflow.toolPermissions),
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

## UX: SettingsDrawer Changes

### New Section: Tool Permissions

Add a collapsible section below the existing rows in `SettingsDrawer.tsx`, following the same `FormField` + `SetAsDefaultButton` pattern.

#### Layout

```
[ Tool Permissions ] (collapsible header, disabled in CLI managed mode)

Row:
  [Permission Mode ▼]              [Set as Default]
  dangerouslyAllowAll / allowAll / custom

-- shown only when mode = "custom" --

  [Allowed Tools]                  [Set as Default]
  <textarea: one pattern per line>

  [Denied Tools]                   [Set as Default]
  <textarea: one pattern per line>
```

#### Behavior

- **Permission Mode** — `CustomSelect` with the three options. Tooltip explains each.
- **Allowed/Denied Tools textareas** — only visible when `mode === "custom"` (animated `max-h` transition matching the existing session ID pattern).
- Each textarea stores newline-separated patterns, parsed to/from `string[]` on change.
- **Set as Default** buttons follow the existing `isDifferentFromGlobal` pattern — appear when the workflow value differs from the global VS Code setting.
- The entire section is greyed out (`pointer-events-none opacity-60`) in CLI-managed (watch) mode, matching existing behavior.

#### Narrow/Wide layout

Follows the existing `Row narrow={isBodyNarrow}` pattern:
- Wide: Mode selector in left column, a short "Docs" link or summary in right column
- Narrow: stacked vertically

#### Empty state

When `toolPermissions` is `undefined` on the workflow, the controls display the effective global value (same as harness/model do), and no "Set as Default" button appears.

---

## Store Changes (`settingsStore.ts` / `WebviewMessageTypes.ts`)

`WorkflowProperties` in the store gains:

```typescript
toolPermissions?: {
  mode?: ToolPermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
} | null;
```

The `isDifferentFromGlobal("toolPermissions")` comparison uses JSON stringify (same as `skills` and `priorContext`).

Message: reuses the existing `UPDATE_WORKFLOW_PROPERTY` message with `property: "toolPermissions"`.

---

## Extension-Side Handling (`FlightPathWebviewProvider.ts`)

The `UPDATE_WORKFLOW_PROPERTY` handler already routes arbitrary properties through to the working file. No new message type needed. The extension writes the value to the `.flightpath.yaml` working file, which the `PromptFileParser` then picks up on next run.

---

## Implementation Steps

1. **Schema** — Add `toolPermissions` to `executionProperties` in `schemas/prompt-schema.json`. Run `npm run generate-schema`.

2. **Types** — Add `ToolPermissionsOverride` to `FlightPathTypes.ts`. Add `toolPermissions` to `PromptItem` and workflow-level type.

3. **Resolver** — Create `src/utils/ToolPermissionResolver.ts` with `resolveToolPermissions(prompt, workflow)` returning a `ToolPermissionConfig`.

4. **Execution context** — Add `toolPermissions?: ToolPermissionConfig` to `CliExecutionOptions` (or equivalent type passed to `runPrompt()`).

5. **WorkflowExecutor** — Call `resolveToolPermissions()` per prompt and pass into harness options.

6. **Harness providers** — Update `CopilotCliProvider`, `ClaudeCliProvider`, `CodexCliProvider`, `OpenCodeCliProvider` to use `options.toolPermissions` instead of calling `ConfigurationUtils` directly. Keep `ConfigurationUtils` fallback for callers that don't pass options (e.g., `hasFullPermissions()` in `CliIntegration`).

7. **SettingsDrawer** — Add Permission Mode + Allowed/Denied tool rows as described above.

8. **settingsStore** — Add `toolPermissions` to `WorkflowProperties`.

9. **Tests** — Update `ToolPermissionMappers.test.ts` and add resolver tests.

---

## What Does NOT Change

- Global VS Code settings (`cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools`) remain the default and fallback — no migration needed.
- `ConfigurationUtils` API is unchanged; the resolver calls it for fallback values.
- Chat harness (`copilot-chat`) is unaffected — `toolPermissions` in schema applies to CLI harnesses only (same as `additionalArgs`).
- The existing `hasFullPermissions()` / headless-without-permissions warning continues to read from `ConfigurationUtils` as before, since it's a pre-flight check (not per-prompt).
