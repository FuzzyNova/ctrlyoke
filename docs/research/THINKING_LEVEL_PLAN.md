# `thinkingLevel` Feature — Implementation Plan

**Date:** March 6, 2026  
**Status:** Planning  
**Scope:** All five harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, copilot-chat)

---

## 1. Overview

`thinkingLevel` is a new per-prompt (and workflow-level) property that controls the "reasoning effort" or "thinking budget" an AI model applies when generating a response. Higher effort levels cause the model to spend more tokens on internal reasoning, which improves quality on complex tasks at the cost of latency and token usage.

### Why It's Valuable

| Use case                                          | Recommended level  |
| ------------------------------------------------- | ------------------ |
| Quick code edits, formatting, renaming            | `low`              |
| Standard feature implementation, Q&A              | `medium` (default) |
| Architecture design, debugging, complex refactors | `high`             |
| Extended multi-step reasoning, research tasks     | `extra-high`       |

Because FlightPath runs multi-step workflows, some prompts within the same workflow benefit from different effort levels. The `thinkingLevel` property enables this per-prompt tuning using the same three-tier precedence system already used by `model`, `harness`, and `agent`.

---

## 2. CLI Research Results

All CLI commands were executed directly in the terminal on March 6, 2026.

### 2.1 Claude CLI (`claude`)

**Command run:** `claude --help`

**Finding:** Claude Code CLI supports `--effort` with three accepted values:

```
--effort <level>    Effort level for the current session (low, medium, high)
```

- **Flag:** `--effort`
- **Values:** `low`, `medium`, `high`
- **Notes:** Flag is top-level (applies to both interactive and `--print` headless mode). Confirmed working. Claude also exposes `--max-budget-usd` for controlling spend in headless mode — separate concern.

### 2.2 Codex CLI (`codex`)

**Commands run:** `codex --help`, `codex exec --help`

**Finding:** Codex CLI has **no effort/thinking flag** in any subcommand. The CLI exposes:

- `-m, --model` — Model selection only
- `-s, --sandbox` — Sandbox policy (not thinking effort)
- `-c, --config <key=value>` — TOML config override

The `-c` flag can override arbitrary config keys. The Codex config schema may include a `reasoning_effort` key (for models like `o3` and `o4-mini`), but this is not documented in the CLI help output and is considered unsupported for this feature implementation until confirmed.

**Verdict:** Codex CLI does **not support** thinking level via CLI flags.

### 2.3 GitHub Copilot CLI (`copilot`)

**Command run:** `copilot --help` (full output inspected)

**Finding:** The full help output has no `--effort`, `--thinking`, `--reasoning`, or `--budget` flags. Available flags are limited to:

- `--model` — Model selection
- `--allow-all-tools`, `--deny-tool` — Permissions
- `--resume` — Session management
- Various logging, path, and MCP flags

**Verdict:** Copilot CLI does **not support** thinking level via CLI flags. (GitHub has not yet exposed reasoning effort controls in their Copilot CLI, as of this writing.)

### 2.4 GitHub Copilot CLI (`gh copilot`)

**Command run:** `gh copilot suggest --help`, `gh copilot explain --help`

**Finding:** `gh` CLI is not installed in this environment. Based on known documentation, `gh copilot suggest` and `gh copilot explain` subcommands do not expose thinking/effort flags.

**Verdict:** Not supported.

### 2.5 OpenCode CLI (`opencode`)

**Commands run:** `opencode --help`, `opencode run --help`

**Finding:** The `opencode run` subcommand supports two relevant flags:

```
--variant     model variant (provider-specific reasoning effort, e.g., high, max, minimal)
              [string]
--thinking    show thinking blocks
              [boolean] [default: false]
```

- **`--variant`:** Controls reasoning effort. Values are **provider-specific strings** (not standardized). Examples from help: `high`, `max`, `minimal`. The meaning depends on which provider/model is active:
  - For Anthropic models: maps to thinking budget level
  - For OpenAI models: maps to `reasoning_effort` API parameter
  - Other providers: varies
- **`--thinking`:** A boolean display flag — toggles whether thinking content is included in the output. Should be set to `true` whenever `--variant` is used to ensure thinking blocks are captured.

**Important:** `--variant` is **only available on `opencode run`** (headless mode), not on the interactive TUI. The global `opencode` entry point does not accept these flags.

**Verdict:** OpenCode CLI supports thinking level via `--variant` (headless only). The OpenCode integration is already headless-only in FlightPath's implementation.

### 2.6 Copilot Chat (VS Code LM API)

**Research method:** VS Code Language Model API documentation.

**Finding:** The VS Code `LanguageModelChatRequestOptions` supports a `modelOptions` dictionary for passing model-specific parameters:

```typescript
interface LanguageModelChatRequestOptions {
  modelOptions?: { [name: string]: unknown };
  // ... other options
}
```

For models that support extended thinking (e.g., Claude `claude-3-7-sonnet` and newer), the thinking budget is controlled via:

```typescript
{
  modelOptions: {
    thinkingBudget: N;
  }
} // N = token budget (integer)
```

This is the same parameter format the Copilot Chat VS Code API surface exposes. Higher token budgets correspond to more thinking.

**Verdict:** Copilot Chat supports thinking level via `modelOptions.thinkingBudget` (integer token count).

---

## 3. Harness Support Matrix

| Harness        | CLI Flag                      | Accepted Values           | Supported? | Notes                                                                            |
| -------------- | ----------------------------- | ------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `claude-cli`   | `--effort`                    | `low`, `medium`, `high`   | ✅ Yes     | Top-level flag, both interactive and headless                                    |
| `codex-cli`    | _(none)_                      | N/A                       | ❌ No      | No CLI-exposed flag; `-c reasoning_effort=X` is undocumented and not recommended |
| `copilot-cli`  | _(none)_                      | N/A                       | ❌ No      | Not exposed in CLI                                                               |
| `opencode-cli` | `--variant`                   | Provider-specific strings | ⚠️ Partial | Headless only; values are provider-specific, not standardized                    |
| `copilot-chat` | `modelOptions.thinkingBudget` | Integer (token count)     | ✅ Yes     | Via VS Code LM API only                                                          |

---

## 4. Level Mapping

FlightPath uses four standard levels that map to harness-specific values. For unsupported harnesses, the flag is simply omitted (graceful degradation).

### 4.1 Mapping Table

| FlightPath Level | `claude-cli` `--effort`                             | `codex-cli`          | `copilot-cli`        | `opencode-cli` `--variant` | `copilot-chat` `thinkingBudget` |
| ---------------- | --------------------------------------------------- | -------------------- | -------------------- | -------------------------- | ------------------------------- |
| `low`            | `low`                                               | _(silently ignored)_ | _(silently ignored)_ | `low`                      | `1024`                          |
| `medium`         | `medium`                                            | _(silently ignored)_ | _(silently ignored)_ | `medium`                   | `5000`                          |
| `high`           | `high`                                              | _(silently ignored)_ | _(silently ignored)_ | `high`                     | `10000`                         |
| `extra-high`     | _(not supported — emit warning, send without flag)_ | _(silently ignored)_ | _(silently ignored)_ | `max`                      | `32000`                         |

### 4.2 Behavior Rules

1. **Unsupported harness + any level:** Omit the flag silently. Log a debug message. No error.
2. **`extra-high` on `claude-cli`:** Claude's `--effort` only supports `low/medium/high`. Emit a `Log.warn()` and fall back to `high`. Do not error.
3. **`null`/`undefined` thinkingLevel:** Use harness default (omit all thinking flags).
4. **`opencode-cli` + any level:** Always also pass `--thinking true` to surface thinking blocks in the output.
5. **`copilot-chat`:** Translate level to token count using the table above and pass via `modelOptions.thinkingBudget`.

### 4.3 OpenCode Variant Caveat

OpenCode's `--variant` values are provider-specific. The mapping above (`low`, `medium`, `high`, `max`) is a best-effort approximation based on the help text examples. If a user is using a provider that doesn't recognize those strings, behavior is provider-defined. Document this limitation.

---

## 5. Schema Changes

### 5.1 TypeScript: `FlightPathTypes.ts`

Add a `ThinkingLevel` type and add `thinkingLevel` to `ExecutionProperties`:

```typescript
/**
 * Thinking/reasoning effort level for AI model responses.
 * Controls how much compute the model applies to internal reasoning.
 * Harness support varies — see THINKING_LEVEL_PLAN.md for the full matrix.
 */
export type ThinkingLevel = "low" | "medium" | "high" | "extra-high";

export interface ExecutionProperties {
  // ... existing properties ...

  /**
   * Thinking/reasoning effort level for AI model responses.
   * Controls how much compute the model applies to internal reasoning.
   *
   * Harness support:
   * - claude-cli: --effort low|medium|high (extra-high → high with warning)
   * - opencode-cli: --variant low|medium|high|max (headless only)
   * - copilot-chat: modelOptions.thinkingBudget (token count)
   * - codex-cli: not supported (silently ignored)
   * - copilot-cli: not supported (silently ignored)
   *
   * When omitted, the harness uses its default behavior.
   */
  thinkingLevel?: ThinkingLevel;
}
```

### 5.2 TypeScript: `PropertyResolver.ts`

Add `thinkingLevel` to `ResolvedProperties` and add resolution logic:

```typescript
export interface ResolvedProperties {
  // ... existing properties ...

  /** Thinking/reasoning effort level — undefined if not specified at any level */
  thinkingLevel?: ThinkingLevel;
}

// In PropertyResolver.resolve():
return {
  // ... existing resolved properties ...
  thinkingLevel: this.resolveThinkingLevel(prompt, workflow),
};

// Resolution method (same pattern as agent/skills):
private static resolveThinkingLevel(
  prompt: PromptItem,
  workflow: PromptFile
): ThinkingLevel | undefined {
  if (prompt.thinkingLevel !== undefined) return prompt.thinkingLevel;
  if (workflow.thinkingLevel !== undefined) return workflow.thinkingLevel;
  return ConfigurationUtils.getThinkingLevel(); // returns undefined if not set
}
```

### 5.3 JSON Schema: `schemas/prompt-schema.json`

Add to `executionProperties.properties`:

```json
"thinkingLevel": {
  "type": "string",
  "enum": ["low", "medium", "high", "extra-high"],
  "description": "Thinking/reasoning effort level for the AI model. Controls how much compute the model applies to internal reasoning before responding. Higher levels improve quality on complex tasks at the cost of latency and token usage.\n\nHarness support:\n• claude-cli: --effort low|medium|high (extra-high falls back to high with a warning)\n• opencode-cli: --variant low|medium|high|max (headless mode only)\n• copilot-chat: modelOptions.thinkingBudget (low=1024, medium=5000, high=10000, extra-high=32000 tokens)\n• codex-cli: not supported (silently ignored)\n• copilot-cli: not supported (silently ignored)\n\nWhen omitted, the harness uses its default behavior (typically no explicit effort override)."
}
```

`extra-high` is included in the schema because it maps to `max` in OpenCode and large token budgets in Copilot Chat, even though Claude only supports up to `high`. This preserves forward compatibility.

---

## 6. YAML Examples

### 6.1 Workflow-Level Default

```yaml
harness: claude-cli
model: claude-sonnet-4.5
thinkingLevel: medium # applied to all prompts unless overridden

prompts:
  - prompt: Analyze the overall architecture and produce a summary.

  - prompt: |
      Based on the summary, design a refactoring plan.
    thinkingLevel: high # override for this specific prompt

  - prompt: Implement the refactoring plan.
    thinkingLevel: low # just execution, less reasoning needed
```

### 6.2 Per-Prompt Override

```yaml
harness: opencode-cli
model: anthropic/claude-sonnet-4-6

prompts:
  - name: Deep Analysis
    prompt: Research and analyze potential security vulnerabilities in this codebase.
    thinkingLevel: extra-high # maps to --variant max for opencode

  - name: Quick Fix
    prompt: Apply the identified fixes.
    thinkingLevel: low
```

### 6.3 No Default (Inherit from VS Code Setting)

```yaml
harness: claude-cli
model: claude-sonnet-4.5
# thinkingLevel not set at workflow level — uses flightpath.thinkingLevel setting or harness default

prompts:
  - prompt: Standard implementation task.
  - prompt: Complex reasoning task.
    thinkingLevel: high # only this prompt gets elevated effort
```

### 6.4 Copilot Chat

```yaml
harness: copilot-chat
model: claude-sonnet-4.5
thinkingLevel: high # maps to thinkingBudget: 10000

prompts:
  - prompt: Debug this complex async race condition.
```

---

## 7. Implementation Architecture

### 7.1 Data Flow

```
YAML file
  └─ thinkingLevel: "high"                     (added to executionProperties in schema)
       │
       ▼
PromptFileParser.parse()
  └─ PromptItem.thinkingLevel = "high"          (ThinkingLevel type added to ExecutionProperties)
       │
       ▼
PropertyResolver.resolve(prompt, workflow)
  └─ ResolvedProperties.thinkingLevel = "high"  (resolution via 3-tier precedence)
       │
       ▼
WorkflowExecutor → CliIntegration.executePrompt()
  └─ workflowContext.resolvedProperties.thinkingLevel = "high"
       │
       ▼
provider.buildCliArgs(..., workflowContext)       (each provider reads thinkingLevel here)
  │
  ├─ ClaudeCliProvider   → args.push("--effort", "high")
  ├─ CodexCliProvider    → (no-op, log debug)
  ├─ CopilotCliProvider  → (no-op, log debug)
  ├─ OpenCodeCliProvider → args.push("--variant", "high", "--thinking", "true")
  └─ CopilotChatInteg.   → modelOptions.thinkingBudget = 10000
```

### 7.2 Key Touch Points

| File                                                     | Change                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/types/FlightPathTypes.ts`                           | Add `ThinkingLevel` type, add `thinkingLevel?` to `ExecutionProperties`    |
| `src/utils/PropertyResolver.ts`                          | Add `thinkingLevel?` to `ResolvedProperties`, add `resolveThinkingLevel()` |
| `src/utils/ConfigurationUtils.ts`                        | Add `getThinkingLevel(): ThinkingLevel \| undefined`                       |
| `schemas/prompt-schema.json`                             | Add `thinkingLevel` to `executionProperties` definition                    |
| `src/flightpath/harness/claude/ClaudeCliProvider.ts`     | Read `resolvedProperties.thinkingLevel`, build `--effort` arg              |
| `src/flightpath/harness/codex/CodexCliProvider.ts`       | Read and silently ignore (with debug log)                                  |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts`   | Read and silently ignore (with debug log)                                  |
| `src/flightpath/harness/opencode/OpenCodeCliProvider.ts` | Read, build `--variant` arg + `--thinking true`                            |
| `src/flightpath/harness/chat/CopilotChatIntegration.ts`  | Translate level to token count, pass via `modelOptions`                    |
| `package.json`                                           | Add `flightpath.thinkingLevel` setting                                     |

---

## 8. Per-Provider Implementation

### 8.1 `ClaudeCliProvider.ts`

Add after model selection in `buildCliArgs`:

```typescript
// Thinking level (--effort)
const thinkingLevel = workflowContext?.resolvedProperties?.thinkingLevel;
if (thinkingLevel) {
  const effortLevel = thinkingLevel === "extra-high" ? "high" : thinkingLevel;
  if (thinkingLevel === "extra-high") {
    Log.warn(
      `⚠️ Claude CLI does not support 'extra-high' thinkingLevel — falling back to 'high'`
    );
  }
  args.push("--effort", effortLevel);
  Log.debug(`🧠 Effort level set: --effort ${effortLevel}`);
}
```

**Placement:** After model selection, before session management (to avoid being consumed by variadic `--disallowedTools`).

### 8.2 `CodexCliProvider.ts`

Add to `buildCliArgs`:

```typescript
// Thinking level — not supported by Codex CLI
const thinkingLevel = workflowContext?.resolvedProperties?.thinkingLevel;
if (thinkingLevel) {
  Log.debug(
    `🧠 thinkingLevel '${thinkingLevel}' requested but Codex CLI does not support effort flags — ignoring`
  );
}
```

### 8.3 `CopilotCliProvider.ts`

Add to `buildCliArgs`:

```typescript
// Thinking level — not supported by Copilot CLI
const thinkingLevel = workflowContext?.resolvedProperties?.thinkingLevel;
if (thinkingLevel) {
  Log.debug(
    `🧠 thinkingLevel '${thinkingLevel}' requested but Copilot CLI does not support effort flags — ignoring`
  );
}
```

### 8.4 `OpenCodeCliProvider.ts`

Add in `buildCliArgs`, after model selection and within the headless block:

```typescript
// Thinking level via --variant (headless only — opencode run supports --variant)
const thinkingLevel = workflowContext?.resolvedProperties?.thinkingLevel;
if (thinkingLevel && !isInteractive) {
  const variantMap: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    "extra-high": "max",
  };
  const variant = variantMap[thinkingLevel];
  args.push("--variant", variant);
  args.push("--thinking", "true"); // surface thinking blocks in output
  Log.debug(`🧠 Variant set: --variant ${variant} --thinking true`);
} else if (thinkingLevel && isInteractive) {
  Log.debug(
    `🧠 thinkingLevel '${thinkingLevel}' requested but --variant is only supported in headless mode for OpenCode — ignoring`
  );
}
```

**Placement:** After `--format json` is added but before session management.

### 8.5 `CopilotChatIntegration.ts`

Find where `LanguageModelChatRequestOptions` is constructed and add:

```typescript
// Thinking level → thinkingBudget for Copilot Chat
const thinkingLevel = resolvedProperties?.thinkingLevel;
if (thinkingLevel) {
  const budgetMap: Record<string, number> = {
    low: 1024,
    medium: 5000,
    high: 10000,
    "extra-high": 32000,
  };
  const budget = budgetMap[thinkingLevel];
  requestOptions.modelOptions = {
    ...requestOptions.modelOptions,
    thinkingBudget: budget,
  };
  Log.debug(`🧠 Thinking budget set: ${budget} tokens`);
}
```

**Note:** Not all models support `thinkingBudget`. If the VS Code API returns an error for unsupported models, catch it gracefully and retry without the `modelOptions`. Log a warning.

---

## 9. VS Code Settings

### 9.1 New Setting: `flightpath.thinkingLevel`

Add to `package.json` under `contributes.configuration.properties`:

```json
"flightpath.thinkingLevel": {
  "type": "string",
  "enum": ["low", "medium", "high", "extra-high"],
  "enumDescriptions": [
    "Low effort — minimal reasoning, fastest response, lowest token cost",
    "Medium effort — balanced reasoning (harness default when this setting is not set)",
    "High effort — extended reasoning for complex tasks",
    "Extra-high effort — maximum reasoning budget (opencode-cli: max variant; copilot-chat: 32k token budget; claude-cli: falls back to high with warning)"
  ],
  "description": "Default thinking/reasoning effort level for all workflows. Can be overridden per-workflow or per-prompt using the thinkingLevel property. When not set, each harness uses its own default behavior (typically no explicit effort flag).",
  "default": null
}
```

**Note:** `null` default means "use harness default". The VS Code `enum` type doesn't natively support `null` as a value; use `"type": ["string", "null"]` if needed, or represent no-setting as the absence of a value via a conditional check in `ConfigurationUtils`.

### 9.2 `ConfigurationUtils.ts` Addition

```typescript
/**
 * Get the global default thinking level.
 * Returns undefined if not configured (harness will use its own default).
 */
static getThinkingLevel(): ThinkingLevel | undefined {
  const level = ConfigurationUtils.get<string | null>("thinkingLevel", null);
  return level ?? undefined;
}
```

---

## 10. Edge Cases

### 10.1 `extra-high` on `claude-cli`

Claude's `--effort` only accepts `low`, `medium`, `high`. If `thinkingLevel: extra-high` is specified with `harness: claude-cli`:

- **Behavior:** Log a warning and substitute `high`.
- **Message:** `"⚠️ Claude CLI does not support 'extra-high' thinkingLevel — falling back to 'high'"`
- **No workflow error:** Execution continues normally.

### 10.2 Any Level on `codex-cli` or `copilot-cli`

Both harnesses silently ignore `thinkingLevel`. No warning to the user since this is a graceful capability gap, not a bug. Only a debug-level log entry is written.

### 10.3 `opencode-cli` Interactive Mode + `thinkingLevel`

`--variant` is only available when using `opencode run` (headless subcommand). In interactive mode, `--variant` is not accepted by the top-level `opencode` TUI entry point. If the user configures `thinkingLevel` with `opencode-cli` in interactive mode, it is silently ignored with a debug log.

> This is an OpenCode limitation. If OpenCode adds `--variant` support to interactive mode in a future release, the guard (`&& !isInteractive`) can be removed.

### 10.4 Model Doesn't Support Thinking (Copilot Chat)

If `thinkingBudget` is passed but the selected model doesn't support extended thinking, the VS Code LM API may return an error or silently ignore the option. Implement try/catch around the API call or check the model capabilities before setting the budget.

### 10.5 `thinkingLevel` and Session Resumption

When resuming a session (`resumeSession: true`), the effort level applies to the resumed call — it is a per-request parameter, not a session-level setting. No special handling needed.

### 10.6 Schema Validation

The JSON Schema validator (AJV) will validate that `thinkingLevel` is one of the four enum values. Any other string will produce a schema validation error before execution begins, giving the user immediate feedback.

### 10.7 Copilot Chat: `thinkingBudget` + `modelOptions` Merging

If a workflow already sets custom `modelOptions` in a future feature, the `thinkingLevel` implementation must spread existing `modelOptions` before adding `thinkingBudget` to avoid overwriting other options. The implementation above already handles this via `...requestOptions.modelOptions`.

---

## 11. Implementation Steps

### Phase 1: Core Types and Schema (No Behavior Change)

- [ ] **1.1** Add `ThinkingLevel` type to `src/types/FlightPathTypes.ts`
- [ ] **1.2** Add `thinkingLevel?: ThinkingLevel` to `ExecutionProperties` interface
- [ ] **1.3** Add `thinkingLevel` to `schemas/prompt-schema.json` → `executionProperties.properties`
- [ ] **1.4** Run `npm run generate-schema` to regenerate YAML schema from JSON
- [ ] **1.5** Verify AJV validates a test YAML with `thinkingLevel: high` without errors

### Phase 2: Property Resolution

- [ ] **2.1** Add `thinkingLevel?: ThinkingLevel` to `ResolvedProperties` in `src/utils/PropertyResolver.ts`
- [ ] **2.2** Add `resolveThinkingLevel(prompt, workflow)` private method to `PropertyResolver`
- [ ] **2.3** Call `resolveThinkingLevel` in `PropertyResolver.resolve()` and include in return object
- [ ] **2.4** Add `getThinkingLevel(): ThinkingLevel | undefined` to `src/utils/ConfigurationUtils.ts`
- [ ] **2.5** Add `flightpath.thinkingLevel` to `package.json` → `contributes.configuration.properties`

### Phase 3: CLI Provider Implementations

- [ ] **3.1** `ClaudeCliProvider.ts` — add `--effort` flag with `extra-high` fallback
- [ ] **3.2** `CodexCliProvider.ts` — add debug-only no-op
- [ ] **3.3** `CopilotCliProvider.ts` — add debug-only no-op
- [ ] **3.4** `OpenCodeCliProvider.ts` — add `--variant` + `--thinking true` for headless mode

### Phase 4: Copilot Chat Integration

- [ ] **4.1** Locate `LanguageModelChatRequestOptions` construction in `CopilotChatIntegration.ts`
- [ ] **4.2** Implement `thinkingBudget` injection from `resolvedProperties.thinkingLevel`
- [ ] **4.3** Add error handling for models that don't support `thinkingBudget`

### Phase 5: Tests

- [ ] **5.1** Add `thinkingLevel` to `ExecutionProperties` test fixtures
- [ ] **5.2** Add `PropertyResolver` tests: prompt-level, workflow-level, setting fallback, undefined behavior
- [ ] **5.3** Add `ClaudeCliProvider` tests: `--effort low`, `--effort high`, `extra-high` → `high` fallback
- [ ] **5.4** Add `OpenCodeCliProvider` tests: `--variant max` for `extra-high`, headless vs interactive no-op
- [ ] **5.5** Add schema validation tests for all four enum values and invalid value rejection

### Phase 6: Dashboard UI (Optional/Future)

- [ ] **6.1** Add `thinkingLevel` to the prompt editor in the FlightPath dashboard (dropdown or radio)
- [ ] **6.2** Display current thinking level in the step status row
- [ ] **6.3** Include thinking level in the workflow settings panel

---

## Appendix: Key File Locations

| File                                                                                                                   | Role                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [src/types/FlightPathTypes.ts](../../src/types/FlightPathTypes.ts)                                                     | Add `ThinkingLevel` type + `thinkingLevel` to `ExecutionProperties` |
| [src/utils/PropertyResolver.ts](../../src/utils/PropertyResolver.ts)                                                   | Add resolution logic + `ResolvedProperties.thinkingLevel`           |
| [src/utils/ConfigurationUtils.ts](../../src/utils/ConfigurationUtils.ts)                                               | Add `getThinkingLevel()`                                            |
| [schemas/prompt-schema.json](../../schemas/prompt-schema.json)                                                         | Add `thinkingLevel` enum field to `executionProperties`             |
| [src/flightpath/harness/claude/ClaudeCliProvider.ts](../../src/flightpath/harness/claude/ClaudeCliProvider.ts)         | `--effort` implementation                                           |
| [src/flightpath/harness/codex/CodexCliProvider.ts](../../src/flightpath/harness/codex/CodexCliProvider.ts)             | no-op with debug log                                                |
| [src/flightpath/harness/copilot/CopilotCliProvider.ts](../../src/flightpath/harness/copilot/CopilotCliProvider.ts)     | no-op with debug log                                                |
| [src/flightpath/harness/opencode/OpenCodeCliProvider.ts](../../src/flightpath/harness/opencode/OpenCodeCliProvider.ts) | `--variant` + `--thinking true`                                     |
| [src/flightpath/harness/chat/CopilotChatIntegration.ts](../../src/flightpath/harness/chat/CopilotChatIntegration.ts)   | `modelOptions.thinkingBudget`                                       |
| [package.json](../../package.json)                                                                                     | New `flightpath.thinkingLevel` setting                              |
