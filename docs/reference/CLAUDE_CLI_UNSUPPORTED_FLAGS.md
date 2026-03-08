# Claude CLI Flags — Gap Analysis for FlightPath

**Claude CLI version:** 2.1.71
**Research date:** 2026-03-07
**Sources:** `claude --help` (live), https://code.claude.com/docs/en/cli-reference

---

## Executive Summary

FlightPath already handles the core automation flags well. Of the ~45 flags the Claude CLI exposes, roughly 14 are relevant to automation workflows and not yet natively supported by FlightPath. The highest-priority gaps are `--append-system-prompt` / `--append-system-prompt-file` (strong use case for per-workflow instructions), `--max-turns` (headless safety guard), `--effort` (cost/quality tuning), and `--fallback-model` (reliability). A general "extra CLI args" escape hatch is also warranted — the Claude CLI's argument-parsing model is friendly to appended args with one critical exception documented below.

---

## Flags FlightPath Already Handles

| Flag | How FlightPath Uses It |
|---|---|
| `--mcp-config <file>` | Written to temp file; passed when dynamic queue enabled |
| `--allowed-tools mcp__flightpath` | Auto-appended after MCP config block |
| `--model <model>` | From resolved properties (prompt > workflow > settings) |
| `--add-dir <dir>` | All workspace dirs, via `CliProviderUtils.getWorkspaceDirs()` |
| `-r <sessionId>` | Session resumption when explicit session ID known |
| `--allowedTools <pattern...>` | Custom tool permission mode (headless only) |
| `--disallowedTools <pattern...>` | Deny list for all non-dangerouslyAllowAll modes (headless only) |
| `--dangerously-skip-permissions` | When `dangerouslyAllowAll` permission mode set |
| `--tools "default"` | When `allowAll` permission mode set |
| `--permission-mode bypassPermissions` | Paired with `--tools`/`--allowedTools` in headless |
| `--settings <file>` | Stop hook for interactive completion detection |
| `-p` | Headless (print) mode |
| `--output-format stream-json` | Headless streaming output |
| `--verbose` | Headless mode always |

---

## Unsupported Flags — Detailed Analysis

### HIGH Priority

---

#### `--append-system-prompt <text>`

**What it does:** Appends custom text to the END of Claude's default system prompt, leaving all of Claude Code's built-in instructions intact. The companion `--append-system-prompt-file <path>` loads the text from a file.

**Automation value:** This is the primary mechanism for injecting workflow-specific behavioral rules without destroying Claude's default coding assistant capabilities. Use cases:
- Enforce a coding standard for a specific workflow ("Always use async/await, never callbacks")
- Inject project-specific context that should persist across all prompts in a workflow
- Add output format constraints for downstream parsing

**Contrast with `--system-prompt`:** The `--system-prompt` flag *replaces* the entire default system prompt, which removes Claude Code's built-in tool usage instructions and code editing behaviors. `--append-system-prompt` is safer for automation.

**FlightPath integration points:**
- Should be a `systemPrompt` / `appendSystemPrompt` field on `ExecutionProperties` (prompt-level and workflow-level, following three-tier precedence)
- `--append-system-prompt-file` variant would pair well with FlightPath's existing file-reference pattern (similar to how `agent` references `.agent.md` files)
- No conflict with existing args

**Conflicts:** None. These flags are safe to combine with all FlightPath flags.

**Priority: HIGH** — Directly enables parameterized, reproducible workflow behavior. Currently users have no way to inject system-level instructions without touching the prompt text itself.

---

#### `--max-turns <n>`

**What it does:** Limits the number of agentic turns Claude can take in a single print-mode (`-p`) invocation. Exits with an error when the limit is reached. No limit by default. Print-mode only.

**Automation value:** Critical safety guard for headless workflows. Without it, a single misbehaving prompt can run indefinitely (or until the API budget is exhausted), consuming tokens and blocking the queue from advancing. Setting a per-prompt turn ceiling gives predictable maximum execution time and cost.

**FlightPath integration points:**
- Should be an optional field on `ExecutionProperties` (e.g., `maxTurns?: number`), applied as `--max-turns <n>` in headless mode only
- Complements the existing `maxPromptExecutionTime` timeout — turn limits bound token consumption while time limits bound wall-clock duration

**Conflicts:** None. Headless-only; no effect in interactive mode, so FlightPath can safely omit it for interactive sessions.

**Priority: HIGH** — Essential for production headless workflows where cost and runtime predictability matter.

---

#### `--effort <level>`

**What it does:** Sets the thinking effort level for the session. Accepted values: `low`, `medium`, `high`. Controls the extended thinking budget Claude uses before responding.

**Automation value:** Workflow steps vary dramatically in cognitive complexity. A prompt that renames a variable needs `low`; an architectural design prompt benefits from `high`. Exposing effort at the prompt level lets workflow authors balance quality vs. cost/latency explicitly rather than always defaulting to the same effort level.

**FlightPath integration points:**
- Add `effort?: "low" | "medium" | "high"` to `ExecutionProperties` with three-tier precedence
- Map directly to `--effort <level>` in `ClaudeCliProvider.buildCliArgs()`
- Should apply in both interactive and headless modes (flag works in both)

**Conflicts:** None observed.

**Priority: HIGH** — Direct cost and quality lever. As Claude's extended thinking becomes more prominent this becomes more important, not less.

---

#### `--fallback-model <model>`

**What it does:** When the primary model is overloaded, automatically retries the request with the specified fallback model. Print-mode only.

**Automation value:** Long-running unattended workflows should not fail because of transient API overload. Without a fallback, a headless workflow gets an error and FlightPath has to handle retries at the workflow level. With `--fallback-model`, the CLI itself handles model-level fallback transparently.

**FlightPath integration points:**
- Add `fallbackModel?: string` to `ExecutionProperties`
- Apply as `--fallback-model <model>` in headless (print) mode only
- Could also be a global setting (`flightpath.claudeCliFallbackModel`)

**Conflicts:** Print-mode only — FlightPath already gates headless-only flags correctly.

**Priority: HIGH** — Reliability improvement for production headless automation with zero FlightPath retry logic required.

---

### MEDIUM Priority

---

#### `--system-prompt <text>` / `--system-prompt-file <path>`

**What it does:** Replaces the entire Claude Code default system prompt with custom text. `--system-prompt-file` loads from a file. Mutually exclusive with each other; can combine with the `--append-*` variants.

**Automation value:** Useful for highly specialized workflows where the standard Claude Code persona is counterproductive (e.g., a data-transformation pipeline that should never offer to edit files). However, replacing the full system prompt breaks Claude's built-in tool usage instructions, requiring the user to replicate any needed behaviors.

**Recommendation:** Implement `--append-system-prompt` first (HIGH priority above). Add `--system-prompt` as an advanced/power-user option with a warning in the docs that it removes Claude Code's default behaviors.

**Conflicts:** `--system-prompt` and `--system-prompt-file` are mutually exclusive with each other. The append variants can combine with either. FlightPath schema validation should enforce this.

**Priority: MEDIUM** — Valid use case but `--append-system-prompt` covers 90% of practical needs more safely.

---

#### `--no-session-persistence`

**What it does:** Disables session persistence to disk entirely. Sessions cannot be resumed after the invocation ends. Print-mode only.

**Automation value:** For workflows that intentionally start a fresh context on every prompt (i.e., no `resumeSession` ever), session persistence is overhead. More importantly, in high-volume parallel workflows this prevents session files from accumulating in `~/.claude/`. Useful for ephemeral CI/CD automation.

**FlightPath integration points:**
- Could be a workflow-level flag (e.g., `ephemeral: true`) or a global setting
- When set, FlightPath should also not attempt session ID tracking for that workflow

**Conflicts:** Incompatible with `resumeSession: true` — FlightPath should validate and reject that combination.

**Priority: MEDIUM** — Primarily a CI/CD cleanliness concern; lower urgency for VS Code extension workflows.

---

#### `--strict-mcp-config`

**What it does:** When present, Claude ignores all MCP server configurations from user/project settings and only uses servers declared via `--mcp-config` on this invocation.

**Automation value:** FlightPath already passes `--mcp-config` for the FlightPath MCP server. Without `--strict-mcp-config`, the user's personal MCP servers (e.g., a filesystem server, a GitHub server) also load for every FlightPath session. This is usually fine but can cause unexpected tool availability or permission prompts in unattended headless runs.

**FlightPath integration points:**
- Add an optional `flightpath.claudeCliStrictMcp` global setting (boolean, default `false`)
- When enabled, append `--strict-mcp-config` alongside every `--mcp-config` invocation

**Conflicts:** None. This flag only isolates; it does not break any existing behavior.

**Priority: MEDIUM** — Important for reproducible/auditable CI workflows; less critical for interactive developer use.

---

#### `--max-budget-usd <amount>`

**What it does:** Sets a maximum dollar spending cap for API calls within a single print-mode invocation. Stops execution and exits when the cap is reached. Print-mode only.

**Automation value:** Hard cost ceiling per prompt in headless workflows. Complements `--max-turns` (which bounds turns, not spend). Useful when running against the Anthropic API directly (API key users) rather than through a subscription.

**FlightPath integration points:**
- Add `maxBudgetUsd?: number` to `ExecutionProperties`
- Apply in headless mode only

**Conflicts:** None for FlightPath's standard args. Note: this flag is only meaningful when using an API key, not a Claude subscription account — document this clearly.

**Priority: MEDIUM** — Important for API-key-based users running cost-sensitive automation.

---

#### `--session-id <uuid>`

**What it does:** Forces a specific UUID as the session ID for a new conversation rather than having Claude auto-generate one.

**Automation value:** FlightPath tracks session IDs for resumption. Currently it discovers the session ID post-hoc by parsing Claude's JSON output. If FlightPath pre-generated and passed the UUID, it would know the session ID before the prompt even starts — simplifying session tracking and enabling more reliable parallel workflow session isolation.

**FlightPath integration points:**
- `FlightPathManager` or `WorkflowExecutor` could generate a UUID (via Node's `crypto.randomUUID()`) and pass it as `--session-id`
- The session ID would then be immediately available for the working file without waiting for output parsing
- Must be a valid UUID — crypto.randomUUID() guarantees this

**Conflicts:** Conflicts with `-r` / `--resume` (you can't specify a new fixed ID when resuming an existing session). FlightPath must omit `--session-id` when `sessionId` is set for resumption.

**Priority: MEDIUM** — Architectural improvement to session tracking; not blocking but would simplify session ID discovery.

---

#### `--permission-prompt-tool <mcp_tool>`

**What it does:** In non-interactive print mode, delegates permission prompts to a specified MCP tool instead of auto-denying or auto-approving. Allows an external system to make permission decisions programmatically.

**Automation value:** For advanced workflows where FlightPath itself (via the MCP server) could serve as the permission gatekeeper — accepting or rejecting tool calls based on workflow policy. This would let FlightPath implement dynamic, per-prompt tool policies beyond the static allow/deny list.

**Conflicts:** The MCP server must implement the permission prompt tool protocol. Non-trivial to implement.

**Priority: MEDIUM** — Powerful but complex. Low implementation effort once FlightPath MCP server is extended; high value for enterprise/policy-driven automation.

---

### LOW Priority

---

#### `--agents <json>`

**What it does:** Defines custom sub-agents inline via a JSON object. Each sub-agent has its own `description`, `prompt`, `tools`, `model`, and `maxTurns`. Claude spawns sub-agents as needed based on the task.

**Automation value:** Workflow-level sub-agent definitions could be powerful — e.g., a "code reviewer" sub-agent automatically invoked after changes. However, sub-agent spawning is non-deterministic (Claude decides when/whether to invoke them), which conflicts with FlightPath's sequential, deterministic execution model.

**Conflicts:** The `--agents` value is a JSON string, which requires careful escaping in shell contexts. Works fine with FlightPath's spawn model.

**Priority: LOW** — The non-deterministic nature of sub-agent invocation makes it a poor fit for FlightPath's structured workflow model. Better served by FlightPath's own sequential prompt chaining.

---

#### `--betas <beta...>`

**What it does:** Passes beta feature headers to the Anthropic API. API key users only — has no effect on subscription-based authentication.

**Automation value:** Enables opting into experimental Anthropic features (e.g., `interleaved-thinking`) on a per-workflow basis.

**Conflicts:** None. Variadic flag — same ordering considerations as `--allowedTools`.

**Priority: LOW** — Niche; only relevant for API-key users who need specific beta features.

---

#### `--fork-session`

**What it does:** When resuming a session (via `-r` or `-c`), creates a new session ID instead of appending to the original thread. Preserves the original session history.

**Automation value:** Would allow FlightPath to "branch" a workflow from a checkpoint without permanently advancing the session. Limited practical value for the current linear workflow model.

**Priority: LOW** — Interesting for future branching/rollback features; not useful today.

---

#### `--include-partial-messages`

**What it does:** Emits partial streaming chunks as they arrive (requires `--print` and `--output-format stream-json`).

**Automation value:** FlightPath already uses `stream-json` and the `ClaudeResponseParser` processes the stream. Partial messages would give finer-grained real-time output in the dashboard — but the parser would need to distinguish partial chunks from complete events.

**Priority: LOW** — UI enhancement; current streaming already gives near-real-time output. Parser complexity cost not justified.

---

#### `--debug [filter]` / `--debug-file <path>`

**What it does:** Enables debug logging, optionally filtered by category (e.g., `"api,hooks"` or `"!statsig,!file"`). `--debug-file` writes debug output to a specific file path.

**Automation value:** Primarily a troubleshooting tool. `--debug-file` could be useful for FlightPath to capture diagnostic logs for failed workflows.

**Priority: LOW** — Dev/troubleshooting use only. A `flightpath.claudeCliDebugFile` setting would be easy to add if users request it.

---

#### `--disable-slash-commands`

**What it does:** Disables all built-in Claude Code skills and slash commands for the session.

**Automation value:** In unattended headless automation, slash commands are never invoked (there's no interactive user). This flag has no practical effect in `-p` mode.

**Priority: LOW** — No-op in headless mode. Only marginally relevant for interactive mode.

---

#### `--plugin-dir <path>`

**What it does:** Loads plugins from a specified directory for the session. Can be specified multiple times.

**Automation value:** Niche. Would require FlightPath to know about plugin directories, which introduces coupling to a non-standard extension mechanism.

**Priority: LOW** — Edge case; plugin authors can pass this via a custom args escape hatch.

---

#### `--setting-sources <sources>`

**What it does:** Comma-separated list of setting sources to load: `user`, `project`, `local`. Controls which Claude configuration files are read on startup.

**Automation value:** In isolated CI environments, you may want to suppress user-level settings (`--setting-sources project,local`). Limited value for typical VS Code extension use.

**Priority: LOW** — CI-specific edge case.

---

#### `--worktree [-w]`

**What it does:** Creates an isolated git worktree for the session. Useful for parallel Claude sessions operating on separate branches.

**Automation value:** FlightPath's parallel workflow model already handles isolation at the process level. Git worktree management is out of scope for FlightPath's current architecture.

**Priority: LOW** — Out of scope; introduces git worktree lifecycle management.

---

#### Flags with No Automation Value

These flags are interactive-only or infrastructure-specific and should not be exposed by FlightPath:

| Flag | Reason to Exclude |
|---|---|
| `--continue` / `-c` | FlightPath deliberately avoids `-c` (global scope, wrong project risk) |
| `--chrome` / `--no-chrome` | Browser automation — unrelated to FlightPath workflows |
| `--ide` | VS Code IDE integration — already the host environment |
| `--tmux` | Terminal multiplexer — irrelevant in VS Code terminal |
| `--from-pr` | GitHub PR session resume — not a workflow automation concept |
| `--remote` | Cloud session creation — out of scope |
| `--teleport` | Cloud-to-local session bridge — out of scope |
| `--teammate-mode` | Agent team display mode — interactive UI concern |
| `--replay-user-messages` | stream-json input acknowledgment — internal protocol |
| `--json-schema` | Structured output validation — could be useful but niche |
| `--input-format stream-json` | FlightPath uses text input, not stream-json input |
| `--init` / `--init-only` / `--maintenance` | Lifecycle hooks, not workflow execution |
| `--allow-dangerously-skip-permissions` | FlightPath uses `--dangerously-skip-permissions` directly |
| `--mcp-debug` | Deprecated; use `--debug` instead |

---

## Summary Table

| Flag | Priority | Mode | Notes |
|---|---|---|---|
| `--append-system-prompt` / `--append-system-prompt-file` | HIGH | Both | Add to `ExecutionProperties`; file variant pairs with agent file pattern |
| `--max-turns <n>` | HIGH | Headless only | Safety guard; add to `ExecutionProperties` |
| `--effort <level>` | HIGH | Both | Cost/quality tuning per prompt; add to `ExecutionProperties` |
| `--fallback-model <model>` | HIGH | Headless only | API reliability; global setting or `ExecutionProperties` |
| `--system-prompt` / `--system-prompt-file` | MEDIUM | Both | Power-user; implement after append variants |
| `--no-session-persistence` | MEDIUM | Headless only | CI/ephemeral workflows |
| `--strict-mcp-config` | MEDIUM | Both | Reproducible/isolated MCP environments |
| `--max-budget-usd <amount>` | MEDIUM | Headless only | API-key users; add to `ExecutionProperties` |
| `--session-id <uuid>` | MEDIUM | Both | Pre-assign UUID to simplify session tracking |
| `--permission-prompt-tool <tool>` | MEDIUM | Headless only | Dynamic permissions via FlightPath MCP server |
| `--agents <json>` | LOW | Both | Non-deterministic; poor fit for structured workflows |
| `--betas <beta...>` | LOW | Both | API-key only; niche |
| `--fork-session` | LOW | Both | Future branching feature |
| `--include-partial-messages` | LOW | Headless only | Parser complexity not justified |
| `--debug` / `--debug-file` | LOW | Both | Troubleshooting only |
| `--disable-slash-commands` | LOW | Both | No-op in headless |
| `--plugin-dir` | LOW | Both | Escape hatch covers this |
| `--setting-sources` | LOW | Both | CI-specific edge case |

---

## "Append Custom Args" Escape Hatch Analysis

**Recommendation: Yes, implement this. The Claude CLI's arg parser is generally safe for appended args, with one critical exception.**

### How Claude CLI Parses Arguments

The Claude CLI uses [Commander.js](https://github.com/tj/commander) under the hood (standard Node.js CLI framework). Commander parses flags positionally left-to-right. Most flags are simple value flags (`--flag value`) or boolean toggles.

### The Critical Gotcha: Variadic Flags

Several Claude CLI flags are **variadic** — they consume all subsequent non-flag tokens as values:

- `--allowedTools <tools...>` — variadic
- `--disallowedTools <tools...>` — variadic
- `--add-dir <directories...>` — variadic
- `--mcp-config <configs...>` — variadic
- `--tools <tools...>` — variadic
- `--betas <betas...>` — variadic
- `--file <specs...>` — variadic

**FlightPath already documents this in `ClaudeCliProvider.ts`** (line 162-163 comment): `"--disallowedTools is variadic and will consume any flags after it"`. This is why tool permission args are appended AFTER session management flags.

If a user appends a custom arg like `--disallowedTools Write` at the end of the args array, it will consume any args that follow it. The safe rule: **user-supplied extra args must be appended after ALL FlightPath-generated args, AND any variadic flags in the user's custom args must come last within their own group.**

### Practical "Append" Implementation Notes

FlightPath's `buildHeadlessArgs()` currently constructs:

```
"<prompt>" -p --output-format stream-json --verbose ...baseArgs
```

For an escape hatch, user-supplied extra args should be appended to `baseArgs` before `buildHeadlessArgs()` is called, so they land after the FlightPath structured args but before the prompt string (which is always first in headless mode). Actually, because the prompt is positional first, user args should be appended to `baseArgs` directly — they will end up in the `...baseArgs` spread position, which is after `--verbose` and after all FlightPath structured args.

The one flag that should be **blocked** from the escape hatch (or at minimum warned against):
- `-p` / `--print` — FlightPath adds this itself; duplicating would cause double-print behavior
- `--output-format` — FlightPath requires `stream-json`; overriding would break `ClaudeResponseParser`
- `--verbose` — Harmless duplicate but unnecessary
- `--model` — Should go through FlightPath's model resolution instead

Everything else is safe to pass through.

### Schema Considerations

A `claudeExtraArgs?: string[]` field on `ExecutionProperties` (applied only to Claude CLI) is the cleanest approach. It's harness-specific so it should be documented as such in the YAML schema.

---

## References

- `claude --help` output (v2.1.71, captured 2026-03-07)
- https://code.claude.com/docs/en/cli-reference
- `C:\dev\FlightPath\src\flightpath\harness\claude\ClaudeCliProvider.ts`
- `C:\dev\FlightPath\src\flightpath\harness\claude\ClaudeToolPermissionMapper.ts`
- `C:\dev\FlightPath\src\types\FlightPathTypes.ts`
