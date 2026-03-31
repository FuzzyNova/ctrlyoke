# OpenCode CLI Flags — FlightPath Gap Analysis

**Date:** 2026-03-07
**OpenCode Version Researched:** 1.2.20 (live `opencode --help` + `opencode run --help`)
**Status:** Research complete — ready for implementation planning

---

## 1. Executive Summary

OpenCode 1.2.20 exposes several flags on `opencode run` and the top-level TUI entry point that FlightPath does not currently surface. The highest-value gaps for automation workflows are:

- `--variant` / `--thinking` — reasoning effort control (partially planned in `THINKING_LEVEL_PLAN.md`)
- `-f / --file` — file attachment for context-heavy workflows
- `--fork` — branch-before-continue for safe multi-step experiments
- `--title` — session labeling for observability
- `--dir` — remote-server working directory targeting

An "append custom args" escape hatch (`customArgs` field, already planned in `CUSTOM_CLI_ARGS_PLAN.md`) is viable for OpenCode with one structural caveat documented in section 5.

---

## 2. Full Flag Inventory

### 2.1 `opencode run` Subcommand (Headless Mode)

Source: live `opencode run --help` on version 1.2.20.

| Flag | Type | Default | FlightPath Status |
|---|---|---|---|
| `message` (positional) | array | `[]` | Handled — prompt passed as trailing positional |
| `--format` | string (`default`\|`json`) | `default` | Handled — always set to `json` |
| `-m, --model` | string | (none) | Handled — `provider/model` format |
| `-s, --session` | string | (none) | Handled — session resumption |
| `-c, --continue` | boolean | false | Intentionally NOT used (global scope issue) |
| `--variant` | string | (none) | Planned (`THINKING_LEVEL_PLAN.md`) |
| `--thinking` | boolean | false | Planned (`THINKING_LEVEL_PLAN.md`) |
| `--agent` | string | (none) | NOT handled natively (see section 3.3) |
| `-f, --file` | array | (none) | NOT handled (see section 3.1) |
| `--fork` | boolean | false | NOT handled (see section 3.2) |
| `--share` | boolean | false | NOT handled (see section 3.4) |
| `--title` | string | (none) | NOT handled (see section 3.5) |
| `--attach` | string | (none) | NOT applicable (see section 3.6) |
| `--dir` | string | (none) | NOT applicable (see section 3.7) |
| `--port` | number | random | NOT applicable (see section 3.8) |
| `--command` | string | (none) | NOT applicable (see section 3.9) |
| `--print-logs` | boolean | false | NOT applicable |
| `--log-level` | string | (none) | NOT applicable |

### 2.2 Top-Level `opencode` Entry Point (Interactive / TUI Mode)

Source: live `opencode --help` on version 1.2.20.

| Flag | Type | Default | FlightPath Status |
|---|---|---|---|
| `--prompt` | string | (none) | Handled — prompt injection mechanism |
| `-m, --model` | string | (none) | Handled |
| `-s, --session` | string | (none) | Handled |
| `-c, --continue` | boolean | false | Intentionally NOT used |
| `--fork` | boolean | false | NOT handled (see section 3.2) |
| `--agent` | string | (none) | NOT handled natively (see section 3.3) |
| `--port` | number | 0 (random) | NOT applicable |
| `--hostname` | string | `127.0.0.1` | NOT applicable |
| `--mdns` | boolean | false | NOT applicable |
| `--mdns-domain` | string | `opencode.local` | NOT applicable |
| `--cors` | array | `[]` | NOT applicable |
| `--print-logs` | boolean | false | NOT applicable |
| `--log-level` | string | (none) | NOT applicable |

**Key difference from headless:** `--variant`, `--thinking`, `-f/--file`, `--share`, `--title`, `--attach`, `--dir`, and `--command` are NOT available on the top-level `opencode` command. They are `opencode run`-only flags.

---

## 3. Per-Flag Analysis — Unhandled Flags

### 3.1 `-f / --file` — File Attachment

**What it does:** Attaches one or more files to the message sent to the model. The model receives the file content as part of its context, alongside the prompt text. Accepts multiple `-f` flags or an array.

**Automation value:** HIGH. Complex prompts that reference source files, specs, or data files can attach them directly rather than embedding their content inline in the prompt text. This is relevant for:
- Sending large reference documents to the model
- Attaching generated artefacts from a previous workflow step
- Providing structured data files (JSON, CSV) as context

**Conflicts with FlightPath's existing approach:** Moderate. FlightPath currently uses `ContextExpander` to expand `#file:` references by inlining file content into the prompt text before sending. The `-f` flag is an alternative mechanism — the model receives the file via a structured attachment rather than inline text. These are complementary rather than conflicting; `-f` is only available in headless (`opencode run`) mode.

**Implementation options:**
1. Expose as a `files` array property on `PromptItem` (parallel to Claude's `--add-dir`-style expansion)
2. Users can include `-f path/to/file` in `customArgs` as an immediate workaround

**Priority: MEDIUM** — Useful but `ContextExpander` covers most cases; `-f` adds value for binary files or very large files that are expensive to inline.

---

### 3.2 `--fork` — Session Fork Before Continuing

**What it does:** When combined with `-c` (continue last) or `-s <sessionId>` (resume session), `--fork` creates a branch of the existing session rather than extending it in-place. The original session history is preserved; the new prompts are appended to a copy. Produces a new session ID distinct from the parent.

**Automation value:** MEDIUM. Enables multi-branch experimentation workflows:
- Run the same prompt against a shared base session history, producing two independent branches
- Safe "what-if" continuation: try a risky refactor without losing the original session state
- A/B testing two different follow-up prompts from the same starting point

**Conflicts with FlightPath's existing approach:** None. FlightPath's session management only uses `-s <sessionId>` for resumption and never `--fork`. Adding `--fork` alongside `-s` (when `resumeSession: true` and a `fork: true` prompt property is set) would be clean.

**Note:** `--fork` is available on both `opencode run` and the top-level `opencode` TUI entry point.

**Priority: MEDIUM** — Niche but useful for experimentation workflows. Low implementation complexity.

---

### 3.3 `--agent` — Named Agent Selection

**What it does:** Selects a named agent defined in `opencode.json` (under the `agent` key). Agents have custom descriptions, models, system prompts, and tool restrictions. This is OpenCode's native agent system, distinct from FlightPath's `.agent.md`-based agent file injection.

**Automation value:** HIGH. Users who have invested in configuring opencode agents (e.g., a `build` agent with specific tool access, a `review` agent focused on read-only operations) can select them per-prompt in a FlightPath workflow. The native agent system is more powerful than injecting an `.agent.md` file because it controls tool access at the opencode level.

**Conflicts with FlightPath's existing approach:** Minor conceptual overlap. FlightPath injects `.agent.md` content into the prompt text via `HarnessIntegration.buildPromptText()`. OpenCode's `--agent` bypasses that and uses opencode's own agent resolution. The two are mutually exclusive for a given prompt — using `--agent` means the FlightPath `.agent.md` injection is unnecessary (though not harmful).

**Current behavior:** FlightPath's `agent` property on `PromptItem` resolves an agent file and injects its content as a prompt prefix. For OpenCode specifically, this is a workaround — the native `--agent` flag is a more appropriate mechanism.

**Implementation option:** Map the FlightPath `agent` property to `--agent <name>` in `OpenCodeCliProvider.buildCliArgs()` when the value looks like an agent name (no path separators, no `.md` extension) rather than a file path. Otherwise fall back to the existing file-injection approach.

**Priority: HIGH** — OpenCode's native agent system is a first-class feature that automation workflows should be able to target by name.

---

### 3.4 `--share` — Session Sharing

**What it does:** Shares the session to opncd.ai (OpenCode's hosted session sharing service), making it accessible via a public URL. When set, the session URL is emitted in the output.

**Automation value:** LOW. Useful for sharing debugging sessions or workflow results with teammates, but not a core automation concern. The `OPENCODE_AUTO_SHARE` environment variable provides a global equivalent for users who always want sharing enabled.

**Conflicts with FlightPath's existing approach:** None.

**Priority: LOW** — Niche use case. Easily handled via `customArgs` when needed.

---

### 3.5 `--title` — Session Title

**What it does:** Sets a human-readable label for the session (visible in `opencode session list` and the TUI history). Without this flag, OpenCode derives a title from a truncated version of the first prompt. Only available in `opencode run` (headless).

**Automation value:** MEDIUM. In multi-workflow setups, being able to set meaningful session titles makes `opencode session list` output and the TUI history legible. A FlightPath workflow named "Refactor Auth Module" could stamp that name onto the session.

**Conflicts with FlightPath's existing approach:** None.

**Implementation note:** The workflow `name` field (from `PromptFile`) or the `id` field of the prompt are natural sources for this value. Could auto-populate from the workflow file name when not explicitly set.

**Priority: LOW** — Quality-of-life improvement. Simple to implement but low urgency.

---

### 3.6 `--attach` — Connect to Running Server

**What it does:** Sends the prompt to an already-running `opencode serve` or `opencode web` server instance rather than spawning a new process. Accepts a server URL (e.g., `http://localhost:4096`).

**Automation value:** NOT APPLICABLE for standard FlightPath workflows. FlightPath manages its own process lifecycle per prompt execution. Attaching to a pre-existing server is a different execution model that conflicts with FlightPath's spawn-and-monitor approach.

**Conflicts:** Significant architectural conflict — FlightPath monitors the spawned process's stdout/stderr for JSONL events. With `--attach`, there is no managed process. Session and completion detection would need a fundamentally different approach.

**Priority: NOT APPLICABLE** — Out of scope for the current architecture.

---

### 3.7 `--dir` — Working Directory Override

**What it does:** Sets the working directory for the opencode process when used with `--attach` (targeting a remote server). Without `--attach`, it appears to be a no-op (opencode already runs in the directory where it was invoked).

**Automation value:** LOW in standard mode. Potentially relevant for remote server scenarios, but those are out of scope (see `--attach` above).

**Priority: NOT APPLICABLE** in the standard FlightPath execution model.

---

### 3.8 `--port` — Local Server Port

**What it does:** Specifies the port for the local opencode server process that backs each `opencode run` invocation. Defaults to a random available port if not specified.

**Automation value:** LOW. Could be useful in environments where network policies restrict ephemeral port usage, or when running parallel FlightPath instances that need port predictability. For most users, the random-port default is fine.

**Conflicts:** None, but FlightPath does not currently need to know the port. It monitors stdout directly.

**Priority: LOW** — Edge case. `customArgs` is the right escape hatch here.

---

### 3.9 `--command` — Named Command Execution

**What it does:** Executes a named command defined in `opencode.json` (under the `command` key). The message positional arguments are passed as `$ARGUMENTS` substituted into the command template. This is OpenCode's built-in macro system.

**Automation value:** MEDIUM. Users with complex, reusable command templates in their `opencode.json` could invoke them from FlightPath workflows. For example, a `review` command template that runs a specific code review workflow could be triggered with per-prompt arguments.

**Conflicts with FlightPath's existing approach:** Conceptual overlap with FlightPath's own prompt templates, but not a conflict. `--command` accesses opencode-native command templates; FlightPath templates are separate.

**Priority: LOW** — Niche. Users with opencode command templates are a subset of all FlightPath users. `customArgs` covers this.

---

### 3.10 `--print-logs` and `--log-level` — Logging Flags

**What they do:** `--print-logs` emits opencode's internal debug logs to stderr. `--log-level` controls verbosity (`DEBUG`, `INFO`, `WARN`, `ERROR`).

**Automation value:** LOW for production workflows, HIGH for debugging FlightPath-OpenCode integration issues.

**Conflicts:** `--print-logs` would mix debug output into stderr, which FlightPath might capture. `--log-level DEBUG` alongside `--format json` would interleave non-JSON lines into the output stream — this would break `OpenCodeResponseParser` if it appears in stdout (unclear whether it goes to stderr or stdout).

**Priority: LOW** — Debug tooling only. `customArgs` is the right mechanism.

---

## 4. Environment Variables — Unexposed but Useful

The following environment variables control OpenCode behavior that FlightPath cannot currently influence. These would be set at process spawn time if FlightPath chose to expose them.

### 4.1 `OPENCODE_CONFIG_CONTENT` — Inline JSON Config

**What it does:** Accepts a full JSON configuration string as an alternative to the `opencode.json` file. OpenCode merges it with other config sources.

**Automation value:** HIGH for FlightPath's MCP injection. Currently FlightPath writes `.opencode/opencode.json` to inject the MCP server config, then cleans it up after execution. `OPENCODE_CONFIG_CONTENT` eliminates the write-then-cleanup pattern — the MCP config is injected as a process environment variable at spawn time, leaving no filesystem artefacts.

**Current situation:** The existing plan (`OPENCODE_HARNESS.md`, section 5) notes this as a future improvement over the current file-based approach. It requires extending the provider interface to support `getSpawnEnv()` or similar, as `getMcpConfigArgs()` currently returns CLI args, not env vars.

**Priority: HIGH** (future architecture improvement) — Cleaner than file-based config injection. No immediate action needed while file-based approach works, but this is the preferred long-term approach.

---

### 4.2 `OPENCODE_DISABLE_AUTOCOMPACT` — Disable Context Auto-Compaction

**What it does:** Disables OpenCode's automatic context compaction (the process of summarizing old context when approaching context window limits).

**Automation value:** MEDIUM. In workflows where exact context preservation matters (e.g., a long multi-step refactor where early context must remain verbatim), disabling auto-compaction ensures the model sees the full history. The tradeoff is context window overflow risk on very long sessions.

**Priority: MEDIUM** — Could be exposed as `flightpath.openCodeDisableAutocompact: boolean` setting or a per-workflow property.

---

### 4.3 `OPENCODE_DISABLE_AUTOUPDATE` — Disable Update Checks

**What it does:** Prevents opencode from checking for updates during execution.

**Automation value:** LOW. In CI/CD environments, update checks add latency and may produce unexpected output. Setting this at the FlightPath extension level (in spawn env) would be a quality-of-life improvement for all headless executions.

**Priority: LOW** — Simple to add as a default in `OpenCodeCliProvider` spawn env.

---

### 4.4 `OPENCODE_DISABLE_CLAUDE_CODE` — Skip `.claude` Directory Reading

**What it does:** Prevents OpenCode from reading `.claude/` directory contents (Claude Code instructions, `CLAUDE.md` files).

**Automation value:** LOW. Relevant if a workspace has Claude Code instructions that conflict with the OpenCode workflow being run.

**Priority: LOW** — Edge case.

---

### 4.5 `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` — Response Token Limit

**What it does:** Caps the maximum output tokens per response (experimental).

**Automation value:** MEDIUM. In cost-sensitive automation workflows, capping output tokens prevents runaway responses. More reliable than prompt-level instructions to "be concise".

**Priority: LOW** — Experimental flag, unstable.

---

### 4.6 `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` — Bash Tool Timeout

**What it does:** Sets the default timeout for bash tool calls (experimental).

**Automation value:** MEDIUM. In automation workflows where the AI runs build commands or tests, a reasonable timeout prevents hanging executions. The default may be too long or too short depending on the project.

**Priority: LOW** — Experimental flag, unstable.

---

## 5. `opencode.json` Config Gaps

The following `opencode.json` configuration fields are currently not written by FlightPath when it generates the MCP config file (`.opencode/opencode.json`), but could be useful to expose:

| Config Field | Type | What It Controls | FlightPath Relevance |
|---|---|---|---|
| `permission` | object | Per-tool approval requirements (`ask` \| `allow`) | FlightPath has `cliToolPermissions` setting but does NOT currently write permission entries into `opencode.json`. Currently all tools are allowed by default. |
| `tools` | object | Enable/disable specific tools entirely (`write: false`) | No FlightPath equivalent. Could map to `cliDeniedTools` setting. |
| `compaction.auto` | boolean | Auto-compact when context fills | Not exposed. Default is `true`. |
| `compaction.reserved` | number | Token buffer before compaction triggers | Not exposed. |
| `small_model` | string | Lightweight model for background tasks (title generation, etc.) | Not exposed. |
| `autoupdate` | boolean\|`"notify"` | Update check behavior | Not exposed. `false` is useful for automation. |
| `instructions` | array | Additional instruction files to load at startup | Not exposed. Could integrate with FlightPath's agent/skills system. |
| `share` | `"manual"`\|`"auto"`\|`"disabled"` | Session sharing policy | Not exposed. |

**Highest-value gap:** The `permission` object. FlightPath has a tool permissions concept (`cliToolPermissions` setting with `allowAll`, `dangerouslyAllowAll`, `custom` modes) but does not currently write permission entries into the generated `opencode.json`. For the `custom` mode to work with OpenCode, FlightPath needs to translate `cliAllowedTools`/`cliDeniedTools` settings into opencode's `permission` object format and write them to `opencode.json` at execution time.

---

## 6. `customArgs` Viability for OpenCode

The `CUSTOM_CLI_ARGS_PLAN.md` describes a `customArgs` string field that lets users append raw args to the CLI command. This is viable for OpenCode with one structural caveat.

### 6.1 Command Structure

OpenCode headless mode uses a subcommand pattern:

```
opencode run --format json -m model <customArgs> "prompt"
```

The `run` subcommand is a structural keyword, not a flag. If a user's `customArgs` string contains another subcommand (e.g., `serve` or `attach`), it would conflict with the already-injected `run`. This is the same issue noted for Codex's `exec` subcommand in the custom args plan.

**Conclusion:** `customArgs` works cleanly for flags (e.g., `--variant high --thinking true --title "My Session"`) but not for subcommand substitution. This matches the documented behaviour in `CUSTOM_CLI_ARGS_PLAN.md` and does not require any special handling beyond the existing caveat warning.

### 6.2 Flag Positioning

OpenCode's yargs-based parser accepts flags in any position relative to the positional `message` argument. Flags appended by `customArgs` before the prompt string will be parsed correctly.

The current headless command shape from `CUSTOM_CLI_ARGS_PLAN.md`:

```
opencode run --format json [MCP args] <customArgs> "prompt"
```

This is correct. Flags in `customArgs` placed before the trailing prompt positional are parsed by yargs normally.

### 6.3 Flags That Conflict With FlightPath's Always-Injected Args

If a user includes any of the following in `customArgs`, they will duplicate or conflict with FlightPath's injected args:

| User-provided flag | FlightPath-injected equivalent | Conflict type |
|---|---|---|
| `--format default` or `--format json` | `--format json` | Duplicate/override — yargs last-wins for scalar flags. User setting `--format default` would break the response parser. |
| `-m <model>` | `-m <model>` | Duplicate — skipped by FlightPath when `customArgs` is set (standard `customArgs` behaviour) |
| `-s <sessionId>` | `-s <sessionId>` | Duplicate — skipped by FlightPath when `customArgs` is set |
| `run` (subcommand) | `run` | Duplicate subcommand — opencode would receive `run run ...` and error |

When `customArgs` is set, FlightPath already skips `-m` and `-s` per the `CUSTOM_CLI_ARGS_PLAN.md` behaviour. The `--format json` flag is one of the "always-injected" args that FlightPath must keep regardless. Users should not include `--format` in `customArgs` for the OpenCode harness — document this as a known limitation.

### 6.4 Verdict

`customArgs` is a viable escape hatch for OpenCode CLI. It correctly handles all the "NOT applicable" and "LOW priority" flags from section 3 without requiring FlightPath to expose them natively. Users needing `--title`, `--share`, `--port`, `--dir`, or `--command` can pass them via `customArgs` today once that feature is implemented.

---

## 7. Priority Summary

### Implement Natively (High Value)

| Feature | Flag | Effort | Notes |
|---|---|---|---|
| Reasoning effort | `--variant` + `--thinking` | Low | Already fully planned in `THINKING_LEVEL_PLAN.md`. Maps to FlightPath `thinkingLevel` property. Headless only. |
| Native agent selection | `--agent <name>` | Low | Map `agent` property to `--agent` when value is an agent name (no path). Falls back to file injection for `.agent.md` paths. |
| Tool permissions write | `opencode.json` `permission` + `tools` | Medium | FlightPath's `cliToolPermissions`/`cliAllowedTools`/`cliDeniedTools` settings need to be translated into the `opencode.json` config written at execution time. Currently this config section is not written at all. |

### Implement Natively (Medium Value)

| Feature | Flag | Effort | Notes |
|---|---|---|---|
| File attachment | `-f / --file` | Medium | New `files` array property on `PromptItem`. Headless only. Complements rather than replaces `ContextExpander`. |
| Session forking | `--fork` | Low | New `fork: boolean` property on `PromptItem`. Works alongside `resumeSession: true`. Available in both modes. |
| Disable auto-compaction | `OPENCODE_DISABLE_AUTOCOMPACT` env var | Low | New `disableAutocompact: boolean` workflow/prompt property or global setting. Injected at spawn time. |
| Session title | `--title` | Low | Auto-populate from workflow `name` or `id`. Headless only. |

### Handle via `customArgs` Escape Hatch (Low Value / Niche)

| Feature | Flag | Notes |
|---|---|---|
| Session sharing | `--share` | Niche. `customArgs: "--share"` works. |
| Custom port | `--port` | Edge case for CI environments. |
| Debug logging | `--print-logs` / `--log-level` | Dev tooling only. |
| Command templates | `--command` | Requires opencode.json setup by user. |
| Output token cap | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | Experimental, unstable. |
| Bash timeout | `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | Experimental, unstable. |

### Architecture Improvement (Future Work)

| Feature | Mechanism | Notes |
|---|---|---|
| MCP config via env var | `OPENCODE_CONFIG_CONTENT` | Replaces file write+cleanup with env var injection. Requires `getSpawnEnv()` on provider interface. See `OPENCODE_HARNESS.md` section 5. |
| Disable update checks | `OPENCODE_DISABLE_AUTOUPDATE` | Always set in spawn env for headless runs to eliminate update check latency. |

---

## 8. References

- Live CLI output: `opencode --help` and `opencode run --help` (version 1.2.20, 2026-03-07)
- [OpenCode CLI Documentation](https://opencode.ai/docs/cli/)
- [OpenCode Config Documentation](https://opencode.ai/docs/config/)
- [DeepWiki — OpenCode CLI Reference](https://deepwiki.com/sst/opencode/6.1-command-line-interface-(cli))
- `docs/OPENCODE_HARNESS.md` — FlightPath OpenCode implementation reference (version 1.1.48 research)
- `docs/research/THINKING_LEVEL_PLAN.md` — `--variant` / `--thinking` implementation plan
- `docs/research/CUSTOM_CLI_ARGS_PLAN.md` — `customArgs` escape hatch design
