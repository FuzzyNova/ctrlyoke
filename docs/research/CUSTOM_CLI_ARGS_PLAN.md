# Custom CLI Arguments Plan

## Overview

AI CLIs evolve faster than FlightPath can natively support every flag. Two complementary escape hatches bridge the gap:

- **`additionalArgs`** — FlightPath manages all its standard settings normally (model, permissions, dirs, session); the user appends extra flags on top. The common case: adding a flag FlightPath doesn't expose natively yet.
- **`customArgs`** — FlightPath drops its managed arg blocks and injects only the minimum required for its own operation. The user controls the full command. The escape hatch for power users who want full ownership.

Both fields live in `executionProperties` and participate in the standard three-tier precedence (prompt > workflow > VS Code settings). Using two separate named fields rather than one field + a mode toggle keeps the schema self-documenting — the field name communicates intent without reading docs.

A companion VS Code setting exists for each: `flightpath.cliAdditionalArgs` and `flightpath.cliCustomArgs` (both `string`, default `""`), so users can also set them globally.

---

## Decision Rationale

### Why Both Fields Instead of One Field + Mode Toggle

A single `customArgs` field with a `customArgsMode: append | replace` toggle creates a conditional schema relationship — `customArgsMode` is meaningless without `customArgs`, and IntelliSense would need to explain a two-field contract. Two distinct field names are self-documenting:

- `additionalArgs` — clearly additive ("add these on top")
- `customArgs` — clearly a takeover ("I control this command")

### Why Not Just Keep Adding Native Flags

Native support is the right long-term approach for stable, cross-harness properties (model, permissions, session). But:

- Each CLI is adding new flags faster than FlightPath can track
- Many useful flags are harness-specific (e.g., `--effort` for Claude, `--profile` for Codex, `--variant` for OpenCode) — adding them natively means cluttering the schema with fields that only apply to one harness
- `additionalArgs` handles the 90% case (additive flags) with zero schema complexity
- `customArgs` handles the 10% case (conflicting flags, full ownership) without requiring FlightPath to model every edge case

The fields are complementary to — not a replacement for — adding native support for high-value flags.

---

## Schema Change

Add both fields to `executionProperties` in `schemas/prompt-schema.json`:

```json
"additionalArgs": {
  "type": "string",
  "description": "Extra CLI flags appended to FlightPath's standard argument set. FlightPath continues to manage model, permissions, workspace dirs, and session flags normally. The extra flags are injected at a safe position before the prompt argument. Applies only to CLI harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli). Ignored for copilot-chat."
},
"customArgs": {
  "type": "string",
  "description": "Raw CLI arguments string that replaces FlightPath's managed arguments (model, tool permissions, workspace dirs, session flags). FlightPath injects only the minimum required for its own operation (completion hooks, headless output format, MCP orchestration if enabled). Use this when you need full control over the CLI command. Applies only to CLI harnesses. Ignored for copilot-chat."
}
```

Add corresponding VS Code settings (`flightpath.cliAdditionalArgs: string`, `flightpath.cliCustomArgs: string`, both default `""`).

---

## `additionalArgs` Behaviour

### What It Does

FlightPath builds its full standard arg set as normal, then injects the parsed tokens from `additionalArgs` at a safe position — before tool permission args (which may be variadic and consume subsequent tokens) but after model/dir/session args.

**Injection position in `buildCliArgs()` output:**

```
[mcpArgs] [model] [addDir...] [session] [additionalArgs tokens] [toolPermissionArgs]
```

This ordering ensures `additionalArgs` tokens are not consumed by variadic flags like `--disallowedTools` (Claude), `--deny-tool` (Copilot), or similar.

### Per-Harness Specifics

#### claude-cli

Inject `additionalArgs` before tool permission args in `buildCliArgs()`.

**Safe to pass:**

- `--append-system-prompt "<text>"` / `--append-system-prompt-file <path>`
- `--max-turns <n>`
- `--effort <low|medium|high>`
- `--fallback-model <model>`
- `--max-budget-usd <n>`
- `--strict-mcp-config`
- `--no-session-persistence`
- `--fork-session`
- `--session-id <uuid>`
- `--betas <feature>` (before tool permission block)

**Prohibited (emit `Log.warn` + skip the token):**

- `--output-format` — FlightPath's parser requires `stream-json`; overriding breaks response parsing
- `-p` / `--print` — always injected by `buildHeadlessArgs()`
- `--model` — use the schema `model` field instead
- `--settings` — conflicts with stop hook injection (interactive mode)
- `--mcp-config` — conflicts with FlightPath's MCP config injection

**Variadic gotcha:** `--allowedTools`, `--disallowedTools`, `--add-dir`, `--mcp-config`, `--tools`, `--betas`, `--file` consume all subsequent tokens until the next `--flag`. If passed in `additionalArgs`, they must come last within the user's arg string, or their values will be consumed by the next FlightPath-managed arg.

#### copilot-cli

Inject `additionalArgs` before tool permission args. No ordering constraints between non-variadic flags.

**Safe to pass:**

- `--available-tools <pattern>` / `--excluded-tools <pattern>`
- `--allow-url <url>` / `--deny-url <url>` / `--allow-all-urls`
- `--no-custom-instructions`
- `--disable-builtin-mcps`
- `--add-github-mcp-tool <tool>` / `--enable-all-github-mcp-tools`
- `--secret-env-vars <var>`
- `--log-level <level>`
- `--config-dir <path>`
- `--plugin-dir <path>`

**Prohibited:**

- `--output-format` — parser depends on current output format
- `--prompt` / `-i` — prompt arg is managed by `buildHeadlessArgs()`
- `--model` — use schema `model` field
- `--resume` — use schema `resumeSession` field

**Note:** `--autopilot`, `--no-ask-user`, and `--silent` will be added unconditionally to `buildHeadlessArgs()` as they should always be on in headless mode — not passed via `additionalArgs`.

#### codex-cli

**Known limitation:** Codex has a two-tier arg structure — global flags (before `exec`) and exec-specific flags (after `exec`). FlightPath injects `exec` structurally, so `additionalArgs` tokens are injected after `exec` (exec-specific position only). Global-tier flags like `--profile` cannot be passed via `additionalArgs`.

Inject `additionalArgs` before tool permission args, after `exec --json --model [addDir...]`.

**Safe to pass (exec-specific):**

- `--output-last-message <path>` / `-o`
- `--skip-git-repo-check`
- `--ephemeral`
- `--color never`
- `--image <path>` / `-i`
- `-c model_reasoning_effort=<level>` (additive TOML key — multiple `-c` flags are safe)
- `-c model_reasoning_summary=<value>`
- `-c hide_agent_reasoning=true`

**Prohibited:**

- `--json` — always injected for headless mode
- `--model` — use schema `model` field
- `resume` — use schema `resumeSession` field (subcommand, not a flag)
- `exec` — structural subcommand managed by FlightPath
- Bare strings — `resume` consumes the next positional as session ID; bare strings corrupt the PROMPT position

**Global-tier flags** (`--profile`, `--oss`, etc.) cannot be passed via `additionalArgs` because `exec` is already in the arg list. Users needing global-tier Codex flags should use `customArgs` instead.

#### opencode-cli

Inject `additionalArgs` before the prompt. OpenCode's yargs parser accepts flags anywhere relative to the positional prompt argument, so no ordering issues.

**Safe to pass:**

- `--variant <name>`
- `--thinking true`
- `--fork`
- `--title <text>`
- `--file <path>` / `-f`
- `--share`

**Prohibited:**

- `--format` — `OpenCodeResponseParser` requires JSON format; overriding breaks parsing
- `-m` / `--model` — use schema `model` field
- `-s` — use schema `resumeSession` field
- `run` — structural subcommand managed by FlightPath; would produce `run run ...`

---

## `customArgs` Behaviour (Replace Mode)

### What FlightPath Always Injects (Even With `customArgs`)

| Category                   | Component                                                                                                         | Why non-negotiable                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Completion detection hooks | Copilot: sessionEnd hook file; Claude: `--settings <file>`; Codex: `--config <toml>`; OpenCode: plugin file write | Without these, the workflow stalls indefinitely                                                          |
| Headless output format     | Claude: `-p --output-format stream-json --verbose`; Codex: `exec --json`; OpenCode: `run --format json`           | FlightPath's response parsers require specific formats                                                   |
| MCP orchestration          | `--mcp-config` (or equivalent) + tool approval                                                                    | Only when `allowDynamicExtension` resolves to `true`; suppress by setting `allowDynamicExtension: false` |

### What Gets Skipped When `customArgs` Is Set

| Category                                                       | Skipped                                 |
| -------------------------------------------------------------- | --------------------------------------- |
| `--model`                                                      | Yes                                     |
| `--add-dir` workspace dirs                                     | Yes                                     |
| `--allow-all-paths`                                            | Yes                                     |
| Tool permissions (`--allowedTools`, `--disallowedTools`, etc.) | Yes                                     |
| Session resumption (`-r`, `--resume`, `resume <id>`)           | Yes (user includes own flags if needed) |

### Per-Harness Command Shape

**copilot-cli headless:**

```
copilot --prompt "<prompt>" [MCP args if applicable] <customArgs>
```

**copilot-cli interactive:**

```
copilot -i "<prompt>" [sessionEnd hook auto-written to .github/hooks/] [MCP args if applicable] <customArgs>
```

**claude-cli headless:**

```
claude "<prompt>" -p --output-format stream-json --verbose [MCP args if applicable] <customArgs>
```

**claude-cli interactive:**

```
claude "<prompt>" --settings <hookFile> [MCP args if applicable] <customArgs>
```

**codex-cli headless:**

```
codex exec --json [MCP args if applicable] <customArgs> "<prompt>"
```

**codex-cli interactive:**

```
codex --config <hookToml> [MCP args if applicable] <customArgs> "<prompt>"
```

**opencode-cli headless:**

```
opencode run --format json [MCP args if applicable] <customArgs> "<prompt>"
```

**opencode-cli interactive:**

```
opencode --prompt "<prompt>" [plugin file written beforehand] [MCP args if applicable] <customArgs>
```

### Session Management With `customArgs`

When `customArgs` is set, session resumption flags are skipped — the user can include their own `-r`/`--resume` if needed. FlightPath still **reads and stores** session IDs from CLI output as normal. A later prompt in the same workflow that does not have `customArgs` and sets `resumeSession: true` will have a session ID to resume with.

### Interaction With Other Schema Fields

When `customArgs` is set, these are silently bypassed (no error, but see Warnings section):

- `model` — skipped (no `--model` injected)
- `resumeSession` / `sessionId` — skipped

These continue to work normally alongside `customArgs`:

- `harness` — still respected (affects harness selection, not arg building)
- `agent` / `skills` — injected into prompt text by `HarnessIntegration.buildPromptText()`, not as CLI args
- `allowDynamicExtension` — controls whether MCP config is injected (the one always-injected block)
- `endCondition` / `prompt` / `name` / `id` — unaffected
- `additionalArgs` — if both `customArgs` and `additionalArgs` are set, `additionalArgs` is applied after `customArgs` (appended to the user-controlled portion)

---

## `parseArgString` Utility

Both fields use a shared `parseArgString(input: string): string[]` in `src/utils/CliArgParser.ts`.

Supports:

- Whitespace-separated tokens
- Double-quoted strings preserved as single token: `--arg "foo bar"` → `["--arg", "foo bar"]`
- Single-quoted strings preserved: `--config '{"key":"val"}'` → `["--config", '{"key":"val"}']`
- Escaped quotes within double-quoted strings: `"foo \"bar\""` → `['foo "bar"']`

Does **not** support: bash substitution, backticks, environment variable expansion. Inputs are static strings from YAML — this is intentional.

---

## Warnings & Validation

- If `additionalArgs` contains a prohibited flag (`--output-format`, `-p`, `--model`, `--settings`, etc.), emit `Log.warn` and **skip that token and its value**.
- If `customArgs` is set alongside `model`, `resumeSession`, or `sessionId`, emit `Log.warn` indicating those fields are bypassed.
- If either field is set and the harness is `copilot-chat`, emit `Log.warn` that the field is ignored (chat harness has no CLI args).
- **Codex `exec` conflict:** if `additionalArgs` contains `exec` or `resume` (subcommands), emit `Log.warn` that subcommands cannot be passed via `additionalArgs`.
- **Codex `--config` overlap:** if `customArgs` contains `--config` and the harness is `codex-cli` in interactive mode, emit a `vscode.window.showWarningMessage` noting the conflict with FlightPath's completion hook. Do not block execution.
- If `additionalArgs` contains flags that are variadic and therefore unsafe in non-terminal position, emit `Log.info` advising the user to place variadic flags last in the string.

---

## Implementation Plan

### 1. Schema (`schemas/prompt-schema.json`)

- Add `additionalArgs: { type: "string" }` and `customArgs: { type: "string" }` to `executionProperties` definition
- Run `npm run generate-schema` to regenerate YAML schema

### 2. Types (`src/types/FlightPathTypes.ts`)

- Add `additionalArgs?: string` and `customArgs?: string` to `PromptItem` interface

### 3. Extension Settings (`package.json`)

- Add `flightpath.cliAdditionalArgs` setting (`type: string`, default `""`)
- Add `flightpath.cliCustomArgs` setting (`type: string`, default `""`)
- Add both to `ConfigurationUtils` as `getCliAdditionalArgs(): string` and `getCliCustomArgs(): string`

### 4. PropertyResolver (`src/utils/PropertyResolver.ts`)

- Add `additionalArgs?: string` and `customArgs?: string` to `ResolvedProperties` interface
- Add resolution logic for each (three-tier: prompt > workflow > VS Code settings)
- Empty string at prompt level should be treated as "explicitly cleared" — overrides a workflow-level value (set to `undefined` during resolution so it doesn't mask the workflow default unless the user explicitly set it)

### 5. Shared Utility (`src/utils/CliArgParser.ts`)

- Implement `parseArgString(input: string): string[]` with shell-style quoting support
- Unit tests covering double-quoted, single-quoted, escaped chars, and empty string edge cases

### 6. Each Provider's `buildCliArgs()`

**For `additionalArgs`:**

```typescript
const additionalArgs =
  workflowContext?.resolvedProperties?.additionalArgs ||
  ConfigurationUtils.getCliAdditionalArgs() ||
  undefined;

const appendTokens = additionalArgs
  ? filterProhibitedArgs(
      parseArgString(additionalArgs),
      PROHIBITED_FLAGS[harness]
    )
  : [];
```

Inject `appendTokens` before the tool permission block:

```typescript
// [mcpArgs] [model] [addDir...] [session] [appendTokens] [toolPermissionArgs]
if (appendTokens.length > 0) {
  args.push(...appendTokens);
  Log.info(`Extra args applied (${appendTokens.length} tokens)`);
}
// then: args.push(...toolPermissionArgs);
```

**For `customArgs`:**

```typescript
const customArgs =
  workflowContext?.resolvedProperties?.customArgs ||
  ConfigurationUtils.getCliCustomArgs() ||
  undefined;
const useCustomArgs = !!customArgs;
```

Wrap each skippable block in `if (!useCustomArgs) { ... }`. At end of method:

```typescript
if (customArgs) {
  args.push(...parseArgString(customArgs));
  Log.info(`Custom CLI args applied; standard managed args skipped`);
}
```

### 7. `buildHeadlessArgs()` / `buildInteractiveTuiCommand()`

No changes needed. Always-injected flags (output format, print mode) continue to be added by these methods.

### 8. Dashboard UI (`src/ui/webview-react/`)

When `customArgs` is non-empty for a resolved prompt:

- Gray out: model selector, tool permissions, workspace path settings, session resume controls
- Show inline note: "Custom CLI args active — these settings are bypassed"

When `additionalArgs` is non-empty:

- Show inline note on the prompt card: "Extra args: `<value>`"
- No graying out (all settings still active)

`agent`, `skills`, `endCondition`, `allowDynamicExtension` controls remain fully active in both cases.

---

## Native Flag Roadmap

Research across all four harnesses identified high-priority flags to add natively (in addition to the escape hatches above). These are flags valuable enough to deserve first-class schema support rather than leaving to `additionalArgs`:

### Cross-Harness (All or Most CLIs)

| Flag                                     | Harnesses | Priority | Notes                                                                |
| ---------------------------------------- | --------- | -------- | -------------------------------------------------------------------- |
| `--append-system-prompt`                 | Claude    | HIGH     | Per-workflow behavioral rules; most-requested gap                    |
| `--max-turns <n>`                        | Claude    | HIGH     | Safety ceiling on agentic turns; prevents runaway token burn         |
| `--fallback-model <model>`               | Claude    | MEDIUM   | Graceful overload handling                                           |
| URL permissions (`--allow-url`, etc.)    | Copilot   | HIGH     | Currently unmanaged; web fetch silently fails                        |
| `--available-tools` / `--excluded-tools` | Copilot   | HIGH     | Tool visibility sandboxing (different layer from allow/deny)         |
| `--output-format json` + parser update   | Copilot   | HIGH     | Structured output; would make Copilot match Claude/Codex reliability |

### Claude-Specific

| Flag                           | Priority | Notes                                                   |
| ------------------------------ | -------- | ------------------------------------------------------- |
| `--effort <low\|medium\|high>` | HIGH     | Per-prompt thinking effort tuning                       |
| `--max-budget-usd`             | MEDIUM   | Hard spend cap per prompt                               |
| `--strict-mcp-config`          | MEDIUM   | Prevents user's personal MCP servers from loading in CI |
| `--no-session-persistence`     | MEDIUM   | Ephemeral/CI use                                        |

### Copilot-Specific

| Flag/Behaviour                                  | Priority | Notes                                                                         |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `--autopilot` (headless default)                | HIGH     | Without it, headless stops after one turn; likely explains incomplete results |
| `--silent` + `--no-ask-user` (headless default) | HIGH     | Should be added unconditionally to `buildHeadlessArgs()` — not user-facing    |
| `--add-github-mcp-toolset`                      | MEDIUM   | GitHub ecosystem integration                                                  |

### Codex-Specific

| Flag                               | Priority | Notes                                                              |
| ---------------------------------- | -------- | ------------------------------------------------------------------ |
| `--output-last-message <path>`     | HIGH     | Clean final-answer file for end condition scripts                  |
| `--skip-git-repo-check`            | HIGH     | Prevents silent failures on non-Git workspaces                     |
| `--profile <name>`                 | HIGH     | Named config profiles (model + reasoning + sandbox bundled)        |
| `model_reasoning_effort` TOML key  | HIGH     | Speed vs. depth tuning per workflow                                |
| `--ephemeral`                      | MEDIUM   | No session files; useful for parallel CI runs                      |
| `--color never` (headless default) | MEDIUM   | Should be added unconditionally — prevents ANSI in captured stderr |

### OpenCode-Specific

| Flag                                   | Priority | Notes                                                      |
| -------------------------------------- | -------- | ---------------------------------------------------------- |
| `--variant` + `--thinking`             | HIGH     | Already designed in `THINKING_LEVEL_PLAN.md`               |
| `--agent <name>`                       | HIGH     | Native OpenCode agent system (vs. file injection fallback) |
| Tool permissions in `opencode.json`    | HIGH     | Required for `custom` mode to actually work with OpenCode  |
| `--fork`                               | MEDIUM   | Fork session before continuing                             |
| `OPENCODE_DISABLE_AUTOCOMPACT` env var | MEDIUM   | Exact context preservation for multi-step workflows        |

---

## Open Questions

1. **`additionalArgs` + `customArgs` both set:** If both resolve to non-empty, `additionalArgs` is appended after the user's `customArgs` tokens (treated as an additive layer on top of whatever the user specified). Document clearly. Consider whether this is useful or confusing.

2. **Codex global-tier flags:** `--profile` and other global flags (before `exec`) can't be passed via `additionalArgs`. Options: (a) document the limitation and tell users to use `customArgs` instead, (b) add a `codexGlobalArgs` field as a Codex-only schema extension, (c) add native `--profile` support. Recommendation: document + `customArgs` for now, native `--profile` support later.

3. **`parseArgString` with `null` clearing:** PropertyResolver must treat `additionalArgs: ""` (empty string) at prompt level as "explicitly cleared" so it doesn't inherit from workflow level. Verify that the resolver distinguishes `""` (explicitly set to empty) from `undefined` (not set) — may need a sentinel or `null` value in YAML.

4. **Prohibited flag enforcement in `additionalArgs`:** Silently skipping prohibited tokens could confuse users who don't see the warning in logs. Consider surfacing a VS Code notification for prohibited flags rather than just `Log.warn`.
