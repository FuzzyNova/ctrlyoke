# Custom CLI Arguments Plan

## Overview

Some users need to pass arguments that FlightPath doesn't expose as built-in settings. Common cases include:

- Inline MCP server configs not supported by FlightPath's dynamic queue system
- Extension-specific flags (`--dangerouslySkipPermissions`, custom `--config` blocks, etc.)
- Tool allow/deny patterns using the CLI's native format without going through FlightPath's permission layer
- Experimental/undocumented CLI flags that FlightPath hasn't added support for

The `customArgs` field lets users take direct ownership of their CLI command, bypassing most of FlightPath's argument management. When set, FlightPath drops back to injecting only the bare minimum it needs to function correctly (hooks, output format, MCP orchestration), and appends the user's raw args string to the command.

---

## Schema Change

Add `customArgs` to `executionProperties` in `schemas/prompt-schema.json`:

```json
"customArgs": {
  "type": "string",
  "description": "Raw CLI arguments string appended to the command. When set, FlightPath skips all managed arguments (model, tool permissions, workspace dirs, session flags) and injects only the minimum required for its own operation (completion hooks, headless output format, MCP orchestration if enabled). Applies only to CLI harnesses (copilot-cli, claude-cli, codex-cli). Ignored for copilot-chat."
}
```

`customArgs` lives in `executionProperties` so it participates in the full three-tier precedence: prompt-level → workflow-level → VS Code settings.

Add a corresponding VS Code setting (`flightpath.cliCustomArgs: string`, default `""`) so users can also set it globally in their workspace settings. An empty string means "not set" (standard behaviour).

---

## Behaviour Specification

### What FlightPath Always Injects (customArgs present or not)

These are injected regardless of `customArgs` because without them FlightPath cannot orchestrate the workflow:

| Category                       | Component                                                                | Why it's non-negotiable                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Completion detection hooks** | Interactive: sessionEnd / stop / notify hook scripts                     | FlightPath polls for these; without them the workflow stalls indefinitely                                                      |
| **Headless output format**     | Claude: `-p --output-format stream-json --verbose`; Codex: `exec --json` | FlightPath's response parsers expect a specific format; wrong format = silent failure                                          |
| **MCP orchestration**          | `--mcp-config` (or equivalent) + `--allow-tool flightpath`               | Only injected when `allowDynamicExtension` is resolving to `true`; can be suppressed by setting `allowDynamicExtension: false` |

**Copilot CLI** requires no special headless output flags (it already returns structured output), so for Copilot the only always-injected args in headless mode are MCP config (if applicable). In interactive mode the sessionEnd hook is injected.

### What Gets Skipped When customArgs Is Set

| Category                                                                         | Normally built by                          | Skipped             |
| -------------------------------------------------------------------------------- | ------------------------------------------ | ------------------- |
| `--model`                                                                        | `validateAndGetModel()`                    | ✅                  |
| `--add-dir` workspace dirs                                                       | `CliProviderUtils.getWorkspaceDirs()`      | ✅                  |
| `--allow-all-paths`                                                              | `ConfigurationUtils.shouldAllowAllPaths()` | ✅                  |
| Tool permissions (`--allow-all-tools`, `--allowedTools`, disallowed-tools, etc.) | `IToolPermissionMapper.buildArgs()`        | ✅                  |
| Session resumption (`-r`, `--resume`, `resume <id>`)                             | Session management block                   | ✅ (see note below) |

### Session Management Nuance

When `customArgs` is set, session resumption flags are skipped. This is intentional — the user is controlling the command and can include their own `-r`/`--resume` if needed.

However, FlightPath still **reads and stores** session IDs from CLI output as normal. This means:

1. If a later prompt in the same workflow does **not** have `customArgs` and sets `resumeSession: true`, FlightPath will have a session ID to resume with.
2. If the user wants FlightPath-managed resumption with custom args, they should omit `customArgs` on the resume prompt and let FlightPath fill in the session flags.

This hybrid use case is intentional and supported without special handling.

### Interaction with Other Schema Fields

When `customArgs` is set, these fields are **silently ignored** (no error, but see UI section):

- `model`
- `agent` (injected into prompt text, not CLI args, so this one is actually unaffected — see note)
- `skills` (same — injected into prompt text, not CLI args, also unaffected)
- `harness` — still respected; `customArgs` only affects _arg building_, not harness selection
- `resumeSession` / `sessionId` — skipped (see above)

> **Agent and skills note**: Because agents and skills are injected into the **prompt text** by `HarnessIntegration.buildPromptText()` (not as CLI args), they continue to work even when `customArgs` is set. The UI should still show these as active, not grayed out.

Fields that **continue to work normally** alongside `customArgs`:

- `harness` — respects harness selection
- `agent` / `skills` — injected into prompt text, unaffected
- `allowDynamicExtension` — controls whether MCP config is injected (the one always-injected block)
- `endCondition` — purely FlightPath-side logic, unaffected
- `prompt` / `name` / `id` — unaffected

---

## Per-Harness Specifics

### copilot-cli

**Interactive mode** — always inject:

```
--events-hook <path/to/flightpath-copilot-hook.js>
```

(the sessionEnd hook, needed for completion detection)

Skipped: `--model`, `--add-dir`, `--allow-all-paths`, `--allow-tool` (non-MCP), `--resume`

**Headless mode** — no required output flags beyond what the CLI defaults to. Only MCP args injected if applicable.

Skipped: same as interactive plus all tool permission args.

Final command shape (interactive):

```
copilot -i "<prompt>" --events-hook <hookPath> [MCP args if applicable] <customArgs>
```

Final command shape (headless):

```
copilot --prompt "<prompt>" [MCP args if applicable] <customArgs>
```

---

### claude-cli

**Interactive mode** — always inject:

```
--settings '<stop hook JSON>'
```

(needed for completion detection via the stop hook script)

Skipped: `--model`, `--add-dir`, `-r <sessionId>`

Skipped (tool permissions): `--allowedTools`, `--disallowedTools`

**Headless mode** — always inject:

```
-p --output-format stream-json --verbose
```

(FlightPath's Claude response parser requires `stream-json` format; without `--verbose` it does not emit token counts or some metadata)

Skipped: same as interactive.

Final command shape (interactive):

```
claude "<prompt>" --settings '<hookJson>' [MCP args if applicable] <customArgs>
```

Final command shape (headless):

```
claude "<prompt>" -p --output-format stream-json --verbose [MCP args if applicable] <customArgs>
```

---

### codex-cli

**Interactive mode** — always inject:

```
--config '<notify hook TOML>'
```

(needed for completion detection via the notify hook script)

**Note**: If the user's `customArgs` also includes `--config`, there will be a conflict because Codex's `--config` is a single-value flag. This is a known limitation documented in the warnings section below.

Skipped: `--model`, `--add-dir`, tool permission args, resume subcommand.

**Headless mode** — always inject:

```
exec --json
```

(FlightPath's Codex response parser requires JSONL event stream; `exec` subcommand enables headless pipe mode)

Final command shape (interactive):

```
codex "<prompt>" --config '<hookToml>' [MCP args if applicable] <customArgs>
```

Final command shape (headless):

```
codex exec --json [MCP args if applicable] <customArgs> "<prompt>"
```

---

### opencode-cli

**Interactive mode** — always inject:

The OpenCode plugin file (written to `.opencode/plugin/flightpath-completion-hook.js` before launch) — needed for idle-based completion detection via the session.status event. This is deployed as a side effect of `buildCliArgs()`, not as a CLI arg itself, so it is unaffected by `customArgs`.

Skipped: `--model` (`-m provider/model`), `-s <sessionId>`

Skipped (tool permissions): OpenCode uses config-file-driven permissions (`opencode.json`), so `IToolPermissionMapper.buildArgs()` returns `[]` — nothing to skip.

**Headless mode** — always inject:

```
run --format json
```

(`run` subcommand puts OpenCode in headless pipe mode; `--format json` is required for FlightPath's JSONL response parser)

Final command shape (interactive):

```
opencode --prompt "<prompt>" [MCP args if applicable] <customArgs>
```

Final command shape (headless):

```
opencode run --format json [MCP args if applicable] <customArgs> "<prompt>"
```

> **Note**: Like Codex's `exec` subcommand, the `run` subcommand is structural (not an arg). If `customArgs` includes a subcommand, it would conflict. Document this as a known limitation.

---

## Implementation Plan

### 1. Schema (`schemas/prompt-schema.json`)

- Add `customArgs: { type: "string" }` to `executionProperties` definition
- Run `npm run generate-schema` to regenerate YAML schema

### 2. Types (`src/types/FlightPathTypes.ts`)

- Add `customArgs?: string` to `PromptItem` interface (inherits via `executionProperties` in schema; verify the type mirrors the schema)

### 3. Extension Settings (`package.json`)

- Add `flightpath.cliCustomArgs` setting (`type: string`, default `""`, description matching schema)
- Add to `ConfigurationUtils` as `getCliCustomArgs(): string`

### 4. PropertyResolver (`src/flightpath/`)

- Ensure `customArgs` is included in `ResolvedProperties` so it participates in three-tier resolution
- Add `resolvedCustomArgs` to the resolved output alongside `resolvedModel`, `resolvedResumeSession`, etc.

### 5. Each Provider's `buildCliArgs` (`src/flightpath/harness/*/`)

Pattern — at the top of each method, check for custom args:

```typescript
const resolvedCustomArgs =
  (workflowContext?.resolvedProperties?.customArgs ??
    ConfigurationUtils.getCliCustomArgs()) ||
  undefined;
const useCustomArgs = !!resolvedCustomArgs;
```

Then wrap each "skippable" block in `if (!useCustomArgs) { ... }` guards:

- Model selection block
- `--add-dir` workspace dirs block
- `--allow-all-paths` block
- Tool permissions block
- Session resumption block

At the end of the method, append custom args:

```typescript
if (resolvedCustomArgs) {
  // Split on whitespace respecting quoted segments, then push each token
  const tokens = parseArgString(resolvedCustomArgs); // new shared util
  args.push(...tokens);
  Log.info(
    `🔧 Custom CLI args applied (${tokens.length} tokens); standard args skipped`
  );
}
```

The `parseArgString` utility (new, in `src/utils/CliArgParser.ts`) should handle basic shell-style quoting (double-quoted strings preserved as single token, unquoted whitespace-split). Does **not** need to support bash substitution — inputs are static strings from YAML.

### 6. `buildHeadlessArgs` / `buildInteractiveTuiCommand`

No changes needed. These methods only handle prompt positioning and the always-injected output format flags, which continue to be added.

### 7. Dashboard UI (`src/ui/webview-react/`)

When the resolved `customArgs` is non-empty for a prompt:

- Gray out / disable: model selector, tool permissions selector, allowed/denied tool lists, workspace path settings, session resume controls
- Show a tooltip or inline note: _"Custom CLI args active — these settings are bypassed"_
- Agent, skills, endCondition, and allowDynamicExtension controls remain active

This is purely cosmetic — the logic enforcement is in the provider's `buildCliArgs`.

### 8. Warnings & Validation

- If `customArgs` is set alongside `model`, `resumeSession`, or `sessionId`, emit a `Log.warn` (not an error) indicating the fields are bypassed.
- If the harness is `copilot-chat`, emit a `Log.warn` that `customArgs` is ignored (chat harness has no CLI args).
- **Codex conflict**: if `customArgs` contains `--config` and the harness is `codex-cli` in interactive mode, emit a `vscode.window.showWarningMessage` noting the conflict with FlightPath's completion hook. Do not block execution.

---

## Open Questions

1. **Arg parsing fidelity**: Should `parseArgString` attempt full POSIX-style quoting (single-quoted strings, escaped chars)? Probably yes for basic single-quote support since MCP inline config strings often use `--mcp-config '{"key":"value"}'`. The implementation complexity is low.

2. **Per-prompt vs workflow-level**: `customArgs` at workflow level means _all_ prompts use it. Should there be a way to opt individual prompts back out (e.g., set `customArgs: ""` on a specific prompt to explicitly clear the workflow default)? This is the standard three-tier behaviour — an empty string at prompt level should override a workflow default. Need to confirm that PropertyResolver treats `""` as "explicitly set" vs "not provided" to avoid masking the workflow default. May need `customArgs: null` or a sentinel to clear.

3. **Splitting responsibility for always-injected flags**: Currently `buildHeadlessArgs` handles headless format flags for Claude and Codex. It would be cleaner to move that responsibility explicitly into a `buildAlwaysRequiredArgs()` method on each provider so it's clearly separated from the "skippable" args. Low priority but worth doing as part of this work.

4. **Codex `exec` subcommand**: The `exec` subcommand in headless mode is part of the command structure, not an "arg". Consider adding an `alwaysInjectBeforeCustomArgs?: string[]` or `getRequiredSubcommands()` method to the provider interface to cleanly model this.
