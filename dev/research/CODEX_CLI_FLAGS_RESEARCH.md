# Codex CLI Flags Research: Gaps and Automation Opportunities

**Research date:** 2026-03-07
**Codex CLI source:** https://developers.openai.com/codex/cli/reference/
**Config reference:** https://developers.openai.com/codex/config-reference/
**Non-interactive docs:** https://developers.openai.com/codex/noninteractive

---

## Executive Summary

FlightPath's `CodexCliProvider` already covers the most critical flags for headless automation. There are 10 flags and several TOML config settings not yet exposed that have varying relevance to workflow use cases. The highest-value gaps are: `--output-last-message` (structured output capture), `--skip-git-repo-check` (non-repo workflows), `--profile` (per-workflow config switching), `--image` (multimodal prompts), `--ephemeral` (privacy/clean CI runs), and `-c key=value` inline TOML overrides for model reasoning tuning. A "custom args" escape-hatch approach is viable for Codex but has three ordering constraints that must be documented.

---

## Section 1: What FlightPath Already Handles

Cross-referencing `CodexCliProvider.buildCliArgs()` and `ConfigurationUtils`:

| Flag / Behavior | FlightPath Setting | Notes |
|---|---|---|
| `-c mcp_servers.flightpath={...}` | Dynamic queue enabled | MCP TOML inline block |
| `exec` subcommand | Headless mode | Injected before `--json` |
| `--json` | Headless mode | Always on in headless |
| `--model` / `-m` | `codexCliModel` | With validation + fallback |
| `--add-dir` | Workspace root + `codexAllowedDirs` | Multi-value, applied correctly |
| `--full-auto` | `cliToolPermissions = allowAll` | Maps to safe automation preset |
| `--dangerously-bypass-approvals-and-sandbox` | `cliToolPermissions = dangerouslyAllowAll` | Also `--yolo` alias |
| `-s` / `--sandbox` | `codexSandboxMode` (custom mode) | Values: read-only, workspace-write, danger-full-access |
| `-a` / `--ask-for-approval` | `codexApprovalPolicy` (custom mode) | Values: untrusted, on-request, never |
| `--config` (notify TOML) | Interactive mode notify hook | `notify=['node','path']` inline string |
| `resume <SESSION_ID>` | `resumeSession: true` + session ID | Subcommand appended after other flags |

**Important:** The `--ask-for-approval` flag is listed in the CLI reference as `-a`. The source code uses `-a` in `CodexToolPermissionMapper.buildCodexSpecificArgs()`. This aligns correctly with the CLI.

---

## Section 2: Unsupported Flags — Analysis and Priority

### HIGH Priority

---

#### `--output-last-message <path>` / `-o <path>`

**What it does:** Writes the assistant's final message (the last agent turn) to a file at the given path after `codex exec` completes.

**Automation value:** Extremely high. FlightPath currently parses output from the JSONL stream, but capturing the final answer as a clean file enables:
- Post-processing by end condition scripts (read the file, validate content)
- Passing structured output between workflow steps without stream parsing
- Logging the final answer independently of the full JSONL transcript

**Conflicts:** None. Works additively alongside `--json`. The file is written at process exit, so it does not interfere with streaming.

**Implementation note:** The output path could be auto-generated per-run into `.flightpath/temp/` and its contents made available to end condition scripts via an environment variable. Alternatively it could be a per-prompt schema property `outputFile`.

**Priority: HIGH**

---

#### `--skip-git-repo-check`

**What it does:** Allows `codex exec` to run outside a Git repository. Without this flag, Codex refuses to start if the current directory is not within a Git repo.

**Automation value:** High. Users may legitimately want to run Codex workflows on non-repo directories (scratch directories, temporary workspaces, mounted volumes in CI). Without this flag, FlightPath silently fails on non-repo workspaces.

**Conflicts:** None. Safe boolean flag.

**Implementation note:** Should be a VS Code setting `flightpath.codexSkipGitRepoCheck` (boolean, default: false). Could also be auto-applied based on whether the workspace root has a `.git` directory.

**Priority: HIGH**

---

#### `--profile <name>` / `-p <name>`

**What it does:** Loads a named configuration profile from `~/.codex/config.toml`. Profiles can contain model, reasoning effort, sandbox mode, approval policy, and any other TOML key. The profile is merged over defaults before any `-c` overrides.

**Automation value:** High. A user could define profiles like `deep-review` (high reasoning, conservative sandbox) or `fast-ci` (low reasoning, full-auto) and select them per-workflow or per-prompt. This is a clean way to switch entire behavior sets without exposing every individual setting.

**Conflicts:** Interacts with `-c` overrides. The `-c` flags applied by FlightPath (MCP config, notify hook) override profile values for those keys, which is correct behavior. The profile only sets defaults.

**Implementation note:** Could be a workflow-level and prompt-level property in the FlightPath YAML schema, like `codexProfile: "deep-review"`. Also useful as a global VS Code setting.

**Priority: HIGH**

---

### MEDIUM Priority

---

#### `--image <path>` / `-i <path>`

**What it does:** Attaches one or more image files to the initial prompt. Accepts comma-separated paths or repeatable flags. Supported in both `codex` (interactive) and `codex exec`.

**Automation value:** Medium. Enables multimodal workflows where the prompt references a screenshot, diagram, or design mockup. Example use case: "analyze this screenshot of the error and fix the code." The `PromptItem` schema could accept an `images` array property.

**Conflicts:** None. Purely additive. The images attach only to the first message of the session.

**Implementation note:** Add `images?: string[]` to `PromptItem`. In `buildCliArgs()`, append `--image path1,path2` before the prompt. Paths must be resolvable at execution time (support workspace-relative and absolute paths, similar to `prompt` file references).

**Priority: MEDIUM**

---

#### `--ephemeral`

**What it does:** Prevents Codex from writing session rollout files to disk. The session still executes normally and produces JSONL output, but no transcript or session state is persisted locally.

**Automation value:** Medium. Useful for:
- Privacy-sensitive workflows where transcripts must not be stored
- Clean CI environments where disk usage must be minimized
- Parallel multi-instance runs where session files would collide

**Conflicts:** Breaks session resumption (`resume` subcommand). If `--ephemeral` is set, there is no session ID to resume from. FlightPath must either disallow `resumeSession: true` when ephemeral is enabled, or warn.

**Implementation note:** Boolean VS Code setting `flightpath.codexEphemeral` (default: false). When enabled in headless mode, append `--ephemeral` after `exec --json`. Document the incompatibility with `resumeSession`.

**Priority: MEDIUM**

---

#### `--cd <path>` / `-C <path>`

**What it does:** Sets the working directory for the Codex agent before it starts processing. This is distinct from `--add-dir`, which grants write access; `--cd` changes where the agent considers its root.

**Automation value:** Medium. FlightPath already sets the workspace root via `--add-dir`, and `codex exec` inherits the shell's working directory from the spawned process. However, for multi-root workspaces or when a workflow targets a subdirectory, `--cd` could allow the agent to treat a subdirectory as its workspace root without affecting file access permissions.

**Conflicts:** May conflict with FlightPath's workspace root assumptions if set incorrectly. Should only be exposed as an explicit per-prompt override.

**Implementation note:** Could be a per-prompt `codexWorkingDir` property or a workflow-level setting. Low-risk to add but low demand for most users.

**Priority: MEDIUM**

---

#### `--color <always|never|auto>`

**What it does:** Controls ANSI color codes in `codex exec` output. Default is `auto` (color when TTY detected).

**Automation value:** Medium. In headless mode FlightPath captures stdout/stderr from a spawned process. If color codes bleed into the JSONL stream (which they should not, since `--json` formats output as JSON), they could corrupt parsing. In practice, `--json` suppresses TUI output so color codes are not a concern for the JSON stream itself, but may affect stderr log output.

**Implementation note:** FlightPath should append `--color never` by default in headless mode to prevent any ANSI codes from appearing in captured stderr. This is a hardening measure, not a user-configurable setting.

**Priority: MEDIUM** (implementation detail, not a user-facing setting)

---

#### `--search` (live web search)

**What it does:** Enables live web search for a single run (overrides the default cached search). The default behavior uses OpenAI's pre-indexed cache; `--search` fetches live results.

**Automation value:** Low-medium. Useful for workflows that need current information (e.g., "check if library X has a known vulnerability as of today"). The global TOML setting `web_search = "live"` achieves the same persistently.

**Conflicts:** None. Additive flag.

**Implementation note:** Boolean per-prompt property `codexLiveSearch: true` or global `flightpath.codexWebSearch` setting with values `cached | live | disabled`.

**Priority: MEDIUM**

---

### LOW Priority

---

#### `--oss`

**What it does:** Uses a local open-source model provider via Ollama instead of OpenAI's hosted models.

**Automation value:** Low for most users. Only relevant for users running local Ollama instances. The model would need to be configured separately in Codex's config (`oss_provider` section in TOML). Not compatible with standard model validation in FlightPath.

**Conflicts:** Incompatible with `--model` if the OSS provider does not support that model name. Would require disabling FlightPath's model validation.

**Priority: LOW**

---

#### `--no-alt-screen`

**What it does:** Disables the alternate screen buffer in the TUI. Only relevant for the interactive TUI mode, not `exec`.

**Automation value:** None for headless mode. Irrelevant since FlightPath's headless mode uses `exec` which has no TUI. In interactive mode (terminal), this may affect terminal output behavior but is a cosmetic concern.

**Priority: LOW**

---

#### `--disable <feature>` / `--enable <feature>`

**What it does:** Force-enables or force-disables a named Codex feature flag for a single run (without modifying `config.toml`). Run `codex features list` to see available flags. Examples: `web_search`, `unified_exec`, `multi_agent`, `apply_patch_freeform`.

**Automation value:** Low for typical use, but potentially useful for advanced workflows that need to toggle experimental features. For example, disabling `multi_agent` to ensure single-threaded execution in CI.

**Conflicts:** None. Overrides the config.toml feature state for the duration of the run.

**Implementation note:** Could be exposed as a `codexEnabledFeatures` and `codexDisabledFeatures` string array setting, appended as repeatable `--enable X --disable Y` flags.

**Priority: LOW**

---

## Section 3: TOML Config Settings Not Currently Exposed

These settings can be passed via `-c key=value` inline overrides but FlightPath does not currently surface them. They are relevant for automation scenarios.

### Model Reasoning Settings (HIGH value for power users)

| TOML Key | Values | Description |
|---|---|---|
| `model_reasoning_effort` | minimal, low, medium, high, xhigh | Controls how much compute the model spends reasoning before responding. `xhigh` for deep analysis tasks, `minimal` for fast CI runs. |
| `model_reasoning_summary` | auto, concise, detailed, none | How much reasoning trace appears in output. `none` suppresses reasoning output for cleaner JSONL. |
| `model_verbosity` | low, medium, high | Controls response verbosity (GPT-5 Responses API). `low` produces terser output suitable for automation. |
| `model_context_window` | integer | Override the detected context window size. Rarely needed but useful for constrained environments. |

**Implementation path:** These could be exposed as Codex-specific settings or as per-prompt `-c` overrides. For example: `flightpath.codexReasoningEffort` with values `minimal | low | medium | high | xhigh`.

### Shell Environment Policy (MEDIUM value)

```toml
[shell_environment_policy]
inherit = "none"          # none | core | all
set = { MY_VAR = "val" }  # Explicit env vars to set
exclude = ["AWS_*"]       # Glob patterns to exclude
include_only = ["PATH"]   # Allowlist (mutually exclusive with exclude)
```

**Automation value:** In CI environments, controlling which environment variables the Codex subprocess inherits is important for security (preventing credential leakage) and reproducibility. The inline `-c` form: `-c 'shell_environment_policy.inherit="none"'`.

FlightPath could expose a `codexInheritEnv` setting (`all | core | none`) and a `codexEnvVars` key-value map.

### History Persistence (MEDIUM value)

```toml
[history]
persistence = "none"   # Disable transcript storage
max_bytes = 104857600  # Cap transcript size
```

**Automation value:** For privacy or disk-constrained CI environments where storing AI transcripts is undesirable. The `--ephemeral` flag achieves similar behavior per-run; this sets it permanently. Overlaps with `--ephemeral`.

### Custom Notify Hook (ALREADY HANDLED)

```toml
notify = ["node", "/path/to/script"]
```

FlightPath already generates this via `CodexNotificationMonitor.buildHookConfig()`. No gap here.

### Feature Toggles Useful for Automation

```toml
hide_agent_reasoning = true   # Suppress reasoning tokens from output (cleaner JSONL)
```

**Automation value:** Low-medium. In headless mode, reasoning tokens in the JSONL stream add noise. Setting this via `-c hide_agent_reasoning=true` could produce cleaner output for FlightPath's `CodexResponseParser`.

### OpenTelemetry / Logging (LOW value)

```toml
[otel]
exporter = "otlp-http"
environment = "staging"
log_user_prompt = false   # IMPORTANT: prevents prompt text from appearing in traces
```

**Automation value:** Low for most users; relevant only for teams with centralized telemetry infrastructure.

### Analytics / Feedback Opt-Out (LOW value)

```toml
[analytics]
enabled = false

[feedback]
enabled = false
```

**Automation value:** Low. CI environments may want these disabled to avoid outbound telemetry calls. Achievable today via `~/.codex/config.toml` without FlightPath involvement.

---

## Section 4: The "Custom Args" Escape-Hatch Approach

A `codexExtraArgs: string[]` setting (user appends arbitrary extra args) is a viable escape hatch for flags FlightPath does not natively support. However, there are three ordering constraints in Codex's argument parser that require careful documentation.

### Constraint 1: The `exec` subcommand must come before all exec-specific flags

Codex's argument structure is:

```
codex [global-flags] exec [exec-flags] [resume <SESSION_ID>] [PROMPT]
```

The `exec` subcommand is positional — it must appear before any exec-specific flags like `--json`, `--ephemeral`, `--output-last-message`, and `--skip-git-repo-check`. Global flags like `--model`, `--add-dir`, `--full-auto`, and `--profile` may appear before or after `exec` (they are parsed globally).

**Safe injection points for custom args:**
- Before `exec`: Global flags only (`--profile`, `--oss`, `--model`, `--add-dir`, custom `-c` overrides)
- After `exec --json`: Exec-specific flags (`--ephemeral`, `--output-last-message`, `--skip-git-repo-check`, `--color`, `--image`)

FlightPath currently builds the array in this order:
```
[-c MCP] [exec] [--json] [--model M] [--add-dir D] [permission-flags] [--config notify] [resume SESSION] ["PROMPT"]
```

If a single custom-args list is appended at the end (before `PROMPT`), it would be placed after `resume SESSION`. That position works for flags that are not exec-specific (i.e., global flags), but exec-specific flags must come before `resume`. A single append point after `resume` is therefore not safe for all flag categories.

**Recommended approach:** Two injection points:
- `codexExtraGlobalArgs`: injected after `-c MCP` and before `exec`
- `codexExtraExecArgs`: injected after `--json` and before `--model`

Or, document that custom args must be global-compatible and should not include exec-specific flags. For exec-specific flags, provide native FlightPath settings.

### Constraint 2: The `resume` subcommand consumes the next positional argument as the session ID

```
codex exec [flags] resume <SESSION_ID> [PROMPT]
```

Custom args that accidentally include a bare string (non-flag) before the prompt could be mistaken for the session ID when resume is active, or mistaken for the prompt itself. All custom args must be flags (starting with `--` or `-`), not bare positional values.

### Constraint 3: `-c` key=value overrides and `--config` for the notify hook are different usages

FlightPath uses `--config` (long form) for the notify TOML hook in interactive mode. The Codex CLI treats `-c` and `--config` identically. If a user's custom args include `-c` or `--config` for an unrelated override, there is no conflict — each `-c` instance is additive, not a replacement. The notify hook config is a separate `-c` invocation for a different key (`notify=...`). Custom `-c` overrides for other keys (like `model_reasoning_effort=high`) are safe to append alongside FlightPath's own `-c` flags.

### Summary: Is a Custom Args Approach Recommended?

Yes, with the following guidance:

- Expose it as `flightpath.codexExtraArgs: string[]` (array, not a raw string, to avoid shell-splitting issues)
- Document that it accepts global flags and exec-specific flags, but not positional values
- Inject the array at two points if possible: before `exec` (global scope) and after `--json` (exec scope), or use a single injection point after `--json` and document that global-only flags still work there
- The `resume` subcommand and `PROMPT` must always be the final positional elements

---

## Section 5: Priority Summary Table

| Flag / Setting | Category | Priority | Implementation Complexity |
|---|---|---|---|
| `--output-last-message` / `-o` | Exec flag | HIGH | Low — append after `--json`, expose path setting or auto-generate |
| `--skip-git-repo-check` | Exec flag | HIGH | Low — boolean setting, append when enabled |
| `--profile` / `-p` | Global flag | HIGH | Low — string setting, inject before `exec` |
| `--image` / `-i` | Global flag | MEDIUM | Medium — add `images[]` to PromptItem schema, path resolution |
| `--ephemeral` | Exec flag | MEDIUM | Low — boolean setting, document incompatibility with resumeSession |
| `--color never` | Exec flag | MEDIUM | None — hardcode in headless mode (not user-facing) |
| `--search` | Global flag | MEDIUM | Low — add `codexWebSearch` setting |
| `--cd` / `-C` | Global flag | MEDIUM | Low-medium — per-prompt override, path validation needed |
| `model_reasoning_effort` (TOML) | `-c` override | HIGH | Low — string enum setting, appended as `-c` flag |
| `model_reasoning_summary` (TOML) | `-c` override | MEDIUM | Low — string enum setting |
| `model_verbosity` (TOML) | `-c` override | LOW | Low |
| `shell_environment_policy` (TOML) | `-c` override | MEDIUM | Medium — structured setting |
| `history.persistence` (TOML) | `-c` override | LOW | Low — overlaps with `--ephemeral` |
| `hide_agent_reasoning` (TOML) | `-c` override | MEDIUM | Low — boolean, hardcode in headless or expose as setting |
| `--oss` | Global flag | LOW | Low — boolean, but breaks model validation |
| `--enable` / `--disable` | Global flag | LOW | Medium — string array settings |
| `--no-alt-screen` | Global flag | LOW | None — not applicable to exec mode |
| Custom args escape hatch | Meta | MEDIUM | Medium — two injection points needed |

---

## Section 6: Recommended Implementation Order

### Phase 1 — Low-hanging fruit, high value

1. `--skip-git-repo-check` — Single boolean setting, prevents silent failures on non-repo workspaces
2. `--ephemeral` — Single boolean setting, document the `resumeSession` incompatibility
3. `--color never` — Hardcode in headless mode (no user setting needed), defensive hygiene
4. `model_reasoning_effort` as `-c` override — High user value, trivial to implement as an enum setting
5. `--profile` — Single string setting injected before `exec`

### Phase 2 — Moderate effort, meaningful capability

6. `--output-last-message` — Auto-generate path in `.flightpath/temp/`, expose path to end condition scripts via env var
7. `--search` toggle — `codexWebSearch` enum setting (cached | live | disabled)
8. `model_reasoning_summary` and `hide_agent_reasoning` — Cleaner output for headless automation
9. Custom args escape hatch — Two injection points, string array type

### Phase 3 — Schema additions

10. `--image` / `-i` — Add `images?: string[]` to `PromptItem`, resolve paths, append before `exec`
11. `--cd` / `-C` — Per-prompt override for working directory
12. `shell_environment_policy` — Structured setting for CI security hardening

---

## References

- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex Config Reference](https://developers.openai.com/codex/config-reference/)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive)
- [Codex Advanced Config](https://developers.openai.com/codex/config-advanced/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [openai/codex on GitHub](https://github.com/openai/codex)
- `C:\dev\FlightPath\src\flightpath\harness\codex\CodexCliProvider.ts`
- `C:\dev\FlightPath\src\flightpath\harness\codex\CodexToolPermissionMapper.ts`
- `C:\dev\FlightPath\src\utils\ConfigurationUtils.ts`
- `C:\dev\FlightPath\package.json` (settings declarations, lines 801-872)
