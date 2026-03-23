# Copilot CLI Flags Research

**Source:** `copilot --help` output, CLI version current as of 2026-03-07
**Purpose:** Identify flags not yet natively supported by FlightPath that are useful for automation

---

## Executive Summary

The Copilot CLI exposes approximately 50 flags. FlightPath currently handles 10-12 of them.
The remaining ~38 flags break into three groups: high-value automation flags that FlightPath
should expose natively (7), medium-value flags worth a settings toggle (9), and low-value or
inapplicable flags (the rest). One flag — `--output-format json` — is a particularly significant
gap: it enables structured JSONL output that would make headless response parsing dramatically
more reliable than the current plain-text approach.

---

## Flags FlightPath Already Handles

| Flag | How FlightPath Uses It |
|------|------------------------|
| `--additional-mcp-config @<file>` | Written when dynamic queue / MCP enabled |
| `--allow-tool flightpath` | Auto-added when MCP is enabled |
| `--allow-all-tools` | `cliToolPermissions = dangerouslyAllowAll` or `allowAll` (headless only) |
| `--allow-tool <patterns>` | `cliToolPermissions = custom` + `cliAllowedTools` |
| `--deny-tool <patterns>` | `cliDeniedTools` setting |
| `--allow-all-paths` | `copilotCliAllowAllPaths` setting |
| `--add-dir <dir>` | Workspace root + extra dirs via `CliProviderUtils.getWorkspaceDirs()` |
| `--model <model>` | `copilotCliModel` setting / per-prompt `model` property |
| `--resume <sessionId>` | Per-prompt `resumeSession` / `sessionId` properties |
| `-p / --prompt <text>` | Headless mode prompt delivery |
| `-i / --interactive <prompt>` | Interactive mode prompt delivery |
| Hook config via `.github/hooks/flightpath.json` | Session end detection (interactive) |

---

## Unsupported Flags — Detailed Analysis

### HIGH PRIORITY

---

#### `--output-format json`

**What it does:** Switches CLI output from human-readable rich text to JSONL (one JSON object
per line). Each line is a structured event with typed fields.

**Automation value:** This is the single most impactful missing flag for headless automation.
FlightPath currently parses Copilot's plain-text output in `CopilotResponseParser`, which is
brittle against formatting changes, ANSI escape codes, and multi-line content. JSONL output
would allow `CopilotResponseParser` to switch to structured event parsing — the same approach
Claude CLI and Codex CLI already use. Response extraction, error detection, and token stats
would all become deterministic.

**Conflicts:** None. Pairs naturally with headless mode (`--prompt`). In interactive mode the
TUI renders its own output regardless of this flag, so it should only be applied in headless
execution.

**Implementation notes:**
- Add a new `HarnessConfig` flag like `supportsJsonOutputFormat: boolean` or wire it directly
  into `buildHeadlessArgs()` in `CopilotCliProvider`.
- `CopilotResponseParser` would need a JSON parse path alongside the existing plain-text path
  (or the plain-text path could be removed once JSON is confirmed stable).
- The existing `rawTextOutput: true` config flag on `HarnessConfig` would become conditional
  on whether JSON mode is active.

**Priority: HIGH** — directly improves reliability of the core headless execution path.

---

#### `--silent` / `-s`

**What it does:** Suppresses all output except the agent's response text (no stats, no
decorative chrome). Described as "useful for scripting with `-p`."

**Automation value:** Headless automation only needs the response content. Stats lines and
decorative separators currently require special-case stripping in `CopilotResponseParser`.
`--silent` would eliminate that noise at the source, making the plain-text parse path cleaner
while `--output-format json` support is developed.

**Conflicts:** None. Safe to always enable in headless mode alongside `--prompt`.

**Implementation notes:** Add unconditionally to `buildHeadlessArgs()` for headless execution.
No new setting needed — there is no scenario where a workflow user wants stats in headless output.

**Priority: HIGH** — immediate quality-of-life improvement with zero risk.

---

#### `--autopilot` + `--max-autopilot-continues <count>`

**What it does:** `--autopilot` enables automatic continuation when the model produces a
response that suggests it wants to keep going (e.g., a tool call result that warrants a follow-
up). Without it, non-interactive mode stops after the first response turn. `--max-autopilot-continues`
caps the number of continuation cycles (default: unlimited when autopilot is on).

**Automation value:** Without `--autopilot`, headless Copilot sessions behave differently from
interactive sessions — the model may produce incomplete work because it can't continue reasoning
after tool calls. This is likely why some headless workflows silently underperform. Enabling
autopilot by default in headless mode, with a configurable cap, would bring headless closer to
interactive quality.

**Conflicts:** None identified. The continuation cap guards against runaway sessions.

**Implementation notes:**
- Add a `flightpath.copilotAutopilot` boolean setting (default: `true` for headless).
- Add a `flightpath.copilotMaxAutopilotContinues` number setting (default: e.g. 20, matching
  what an interactive session would reasonably use).
- Apply both in `buildHeadlessArgs()` only.
- These could also be exposed as per-prompt properties in the YAML schema for fine-grained
  control over specific prompts.

**Priority: HIGH** — likely fixes silent quality degradation in headless mode.

---

#### `--no-ask-user`

**What it does:** Disables the `ask_user` tool, forcing the agent to operate autonomously
without pausing to ask clarifying questions.

**Automation value:** In an automated workflow, a prompt that causes the model to stop and ask
a question will stall the workflow indefinitely (or until timeout). This flag ensures the model
proceeds with its best interpretation rather than blocking. For automation, this is almost
always the correct behavior.

**Conflicts:** None. Should be applied by default in headless mode. Interactive mode users may
want the agent to ask questions, so this should be headless-only.

**Implementation notes:**
- Could be added unconditionally to `buildHeadlessArgs()` with no settings needed.
- Alternatively, expose as `flightpath.copilotNoAskUser` boolean (default: `true` for headless)
  to allow power users to opt out.

**Priority: HIGH** — prevents workflow stalls in headless automation.

---

#### `--available-tools [tools...]`

**What it does:** Restricts which tools are visible/available to the model at all. Unlike
`--allow-tool` (which controls auto-approval), `--available-tools` controls what the model can
even see. Tools not listed here are entirely hidden from the model's tool roster.

**Automation value:** Useful for workflows that want to run the model in a constrained
environment — e.g., a read-only analysis workflow that should only have `read_file` and
`search` visible, preventing the model from even attempting writes. Complements `--allow-tool`
and `--deny-tool` but operates at a different layer.

**Conflicts:** Interacts with `--allow-tool` / `--deny-tool`. The distinction is:
- `--available-tools`: controls model visibility (what the model knows exists)
- `--allow-tool`: controls auto-approval (what runs without user confirmation)
- `--excluded-tools`: the inverse of `--available-tools` (blacklist instead of whitelist)

All three can be combined.

**Implementation notes:**
- Add `flightpath.copilotAvailableTools` string array setting (default: empty = no restriction).
- Add `flightpath.copilotExcludedTools` string array setting (default: empty).
- Apply in `buildCliArgs()` alongside the existing tool permission args.
- Could be exposed as per-prompt properties in the YAML schema.

**Priority: HIGH** — enables a qualitatively different permission model not currently expressible
in FlightPath.

---

#### `--allow-all` / `--yolo`

**What it does:** Single flag equivalent to `--allow-all-tools --allow-all-paths --allow-all-urls`.
`--yolo` is an alias.

**Automation value:** FlightPath currently applies `--allow-all-tools` and `--allow-all-paths`
as separate flags when configured. `--allow-all` adds `--allow-all-urls` to the bundle and is
cleaner. However, the key gap is that `--allow-all-urls` is not currently applied at all.

**Conflicts:** None. Supersedes individual flags.

**Implementation notes:**
- When `cliToolPermissions = dangerouslyAllowAll` AND `copilotCliAllowAllPaths = true`, emit
  `--allow-all` instead of the two separate flags, and retire the current two-flag approach.
- Add a separate `flightpath.copilotAllowAllUrls` boolean setting for cases where users want
  URL freedom without full permission escalation.
- This is a clean-up / consolidation rather than a new capability.

**Priority: HIGH** — the current approach silently omits URL permissions, which matters for
workflows that need web access.

---

#### `--allow-url [urls...]` / `--deny-url [urls...]` / `--allow-all-urls`

**What it does:** Controls which URLs the agent can access. `--allow-url` whitelists specific
domains or URLs (HTTPS assumed for bare domains). `--deny-url` blacklists (takes precedence).
`--allow-all-urls` removes all URL restrictions.

**Automation value:** Workflows that need the agent to fetch documentation, call APIs, or
browse the web currently have no way to grant URL access through FlightPath. Without this, the
agent will pause and prompt for approval on every URL access in interactive mode, or fail
silently in headless mode.

**Conflicts:** None. These are additive to the existing permission model.

**Implementation notes:**
- Add `flightpath.copilotAllowUrls` string array setting.
- Add `flightpath.copilotDenyUrls` string array setting.
- Add `flightpath.copilotAllowAllUrls` boolean setting.
- Apply in `buildCliArgs()`.
- Could also be YAML per-prompt properties.

**Priority: HIGH** — web-access workflows are currently broken in automation without this.

---

### MEDIUM PRIORITY

---

#### `--no-custom-instructions`

**What it does:** Disables loading of custom instructions from `AGENTS.md` and related files
in the workspace.

**Automation value:** FlightPath workflows inject instructions via the `agent` property, which
prepends agent content directly into the prompt. If a workspace also has an `AGENTS.md`, the
model may receive conflicting or additive instructions. For precise workflow control, the
ability to suppress ambient workspace instructions is valuable.

**Conflicts:** None.

**Implementation notes:**
- Add `flightpath.copilotNoCustomInstructions` boolean setting (default: `false`).
- Could also be a per-prompt YAML property.

**Priority: MEDIUM** — niche but important for reproducible automated workflows.

---

#### `--disable-builtin-mcps` / `--disable-mcp-server <name>`

**What it does:** `--disable-builtin-mcps` turns off all built-in MCP servers (currently the
GitHub MCP server). `--disable-mcp-server <name>` targets a specific server.

**Automation value:** The GitHub MCP server is enabled by default and exposes GitHub API tools
(issues, PRs, repos, etc.). For workflows that don't need GitHub access, this is ambient
capability that could be confusing or unwanted. Disabling it also reduces the tool surface the
model has to reason about, potentially improving focus.

**Conflicts:** Conflicts with `--add-github-mcp-tool` / `--add-github-mcp-toolset` /
`--enable-all-github-mcp-tools` (disabling then re-enabling specific tools is contradictory).

**Implementation notes:**
- Add `flightpath.copilotDisableBuiltinMcps` boolean setting (default: `false`).
- `--disable-mcp-server` with a specific name is more surgical — could be a string array
  setting `flightpath.copilotDisabledMcpServers`.

**Priority: MEDIUM** — useful for clean, reproducible automation environments.

---

#### `--add-github-mcp-tool <tool>` / `--add-github-mcp-toolset <toolset>` / `--enable-all-github-mcp-tools`

**What it does:** Controls which tools from the built-in GitHub MCP server are available.
By default only a CLI subset is enabled. These flags expand that to specific tools, toolsets,
or all tools. `--enable-all-github-mcp-tools` overrides the other two.

**Automation value:** Workflows that interact with GitHub (creating issues, reviewing PRs,
fetching repo content) need specific GitHub MCP tools. Currently there is no way to request
them through FlightPath.

**Conflicts:** Conflicts with `--disable-builtin-mcps` (can't enable tools on a disabled server).

**Implementation notes:**
- Add `flightpath.copilotGithubMcpTools` string array setting.
- Add `flightpath.copilotGithubMcpToolsets` string array setting.
- Add `flightpath.copilotEnableAllGithubMcpTools` boolean setting.
- These are additive flags that can repeat, so they map cleanly to arrays.

**Priority: MEDIUM** — only relevant to GitHub-integrated workflows, but those are a natural
FlightPath use case.

---

#### `--secret-env-vars [vars...]`

**What it does:** Lists environment variable names whose values are stripped from shell and MCP
server environments and redacted from output. The variables are still present in the calling
process environment, but Copilot prevents them from leaking into spawned processes or logs.

**Automation value:** CI/CD automation workflows often run with API keys and tokens in the
environment. Passing `--secret-env-vars` prevents accidental leakage into AI output or MCP
server subprocesses while still allowing the shell environment to use them.

**Conflicts:** None.

**Implementation notes:**
- Add `flightpath.copilotSecretEnvVars` string array setting.
- Apply in `buildCliArgs()`.

**Priority: MEDIUM** — security feature relevant to any production/CI workflow.

---

#### `--share [path]` / `--share-gist`

**What it does:** After headless (`--prompt`) completion, exports the full session transcript
to a markdown file (`--share`) or a secret GitHub gist (`--share-gist`). Default path for
`--share` is `./copilot-session-<id>.md`.

**Automation value:** Workflow audit trails. For long-running automated workflows, capturing
the full session transcript automatically (without manual copy-paste) would be useful for
debugging, review, and compliance. The gist option enables sharing without filesystem access.

**Conflicts:** Only valid in `--prompt` (headless) mode.

**Implementation notes:**
- Add `flightpath.copilotShareSession` boolean and `flightpath.copilotShareSessionPath` string.
- The path could default to `.flightpath/.history/<run-id>/session.md` to integrate with
  FlightPath's existing history system.
- `--share-gist` could be a separate boolean.

**Priority: MEDIUM** — good integration with FlightPath's `OutputHistoryManager`.

---

#### `--log-level <level>` / `--log-dir <directory>`

**What it does:** `--log-level` sets verbosity: `none`, `error`, `warning`, `info`, `debug`,
`all`, or `default`. `--log-dir` redirects log files from the default `~/.copilot/logs/`.

**Automation value:** FlightPath already reads Copilot session logs from the default log
directory for session ID discovery (`CopilotLogParser`). Controlling log verbosity and
redirect is relevant for:
1. Debugging workflow failures (`debug` or `all` level).
2. Isolating logs per-workspace (redirect to `.flightpath/logs/copilot/`).
3. Suppressing log noise in production (`error` only).

**Conflicts:** `--log-dir` redirect would break `CopilotLogParser.discoverSessionLog()` which
expects logs at `~/.copilot/session-state/` unless the parser is also updated to respect the
redirect.

**Implementation notes:**
- Add `flightpath.copilotLogLevel` enum setting (`none`/`error`/`warning`/`info`/`debug`/`all`,
  default: `default`).
- `--log-dir` requires coordinated change in `CopilotLogParser` — defer until log dir
  abstraction is in place.

**Priority: MEDIUM** — log level alone is low-risk and useful; log dir redirect is higher effort.

---

#### `--stream <mode>` (`on` | `off`)

**What it does:** Controls whether responses are streamed as they are generated or returned
all at once. Choices: `on`, `off`.

**Automation value:** FlightPath headless mode currently uses streaming output monitoring
(`shouldStreamHeadlessOutput: true`). `--stream off` would switch to batch delivery — simpler
to parse but with worse time-to-first-output. `--stream on` aligns with current behavior.
Explicit control matters if a future Copilot version changes the default.

**Conflicts:** None.

**Implementation notes:** Likely no new setting needed — the current `shouldStreamHeadlessOutput`
flag already encodes the desired behavior. Just ensure `--stream on` is emitted explicitly in
headless mode to be future-proof against default changes.

**Priority: MEDIUM** — defensive hardening rather than new capability.

---

#### `--config-dir <directory>`

**What it does:** Redirects the Copilot configuration directory (default: `~/.copilot`).
Affects where `mcp-config.json`, logs, session state, and credentials are read from.

**Automation value:** Enables per-workspace or per-workflow isolated Copilot configurations.
Useful in CI/CD environments where multiple workflows run concurrently with different configs,
or where the home directory is not writable.

**Conflicts:** Same log-discovery issue as `--log-dir` — `CopilotLogParser` hardcodes the
session-state path derived from `~/.copilot`. Redirecting config-dir without updating the
parser would break session ID discovery.

**Implementation notes:**
- Add `flightpath.copilotConfigDir` string setting (default: empty = use Copilot default).
- Requires `CopilotLogParser` to accept a configurable base path.

**Priority: MEDIUM** — high value for multi-user CI environments; requires coordinated work.

---

#### `--plugin-dir <directory>`

**What it does:** Loads a Copilot plugin from a local directory. Repeatable for multiple
plugins.

**Automation value:** FlightPath workflows could benefit from custom Copilot plugins that add
domain-specific tools. Currently there is no way to configure plugin loading through FlightPath.

**Conflicts:** None.

**Implementation notes:**
- Add `flightpath.copilotPluginDirs` string array setting.
- Apply as repeated `--plugin-dir` args in `buildCliArgs()`.

**Priority: MEDIUM** — niche but clean to implement.

---

### LOW PRIORITY

---

#### `--acp` (Agent Client Protocol server)

**What it does:** Starts Copilot as an ACP (Agent Client Protocol) server instead of
running a session. ACP is an emerging standard for agent-to-agent communication.

**Automation value:** Not applicable to FlightPath's current execution model. FlightPath
drives Copilot as a subprocess; ACP is for orchestrating agents from another agent.
Potentially relevant if FlightPath itself were to become an ACP client in the future.

**Priority: LOW** — architectural mismatch with current model.

---

#### `--continue`

**What it does:** Resume the most recent session (no session ID required). Equivalent to
`--resume` with the most recent session ID auto-selected.

**Automation value:** FlightPath already manages explicit session IDs via `--resume <id>`.
`--continue` would be useful only if FlightPath lost track of the session ID and needed a
fallback. However, the current `extractSessionIdFromLogs()` fallback is more precise (prompt-
matched). `--continue` would pick the wrong session in concurrent workflows.

**Conflicts:** Dangerous in concurrent workflow scenarios — would resume whichever session
Copilot considers most recent, which may not be the correct one.

**Priority: LOW** — FlightPath's explicit session ID approach is superior; `--continue` is
a footgun in concurrent execution.

---

#### `--alt-screen [on|off]` / `--no-alt-screen`

**What it does:** Controls whether the TUI uses the terminal alternate screen buffer (the
full-screen mode that clears the scrollback).

**Automation value:** Relevant to interactive mode only. FlightPath manages terminal lifecycle
through VS Code's terminal API. Alt screen behavior doesn't affect output capture or
completion detection.

**Priority: LOW** — cosmetic/UX, no automation impact.

---

#### `--mouse [on|off]` / `--no-mouse`

**What it does:** Enables mouse support in alt-screen TUI mode.

**Automation value:** None for automation.

**Priority: LOW** — irrelevant.

---

#### `--bash-env [on|off]` / `--no-bash-env`

**What it does:** Controls whether Copilot loads `BASH_ENV` for bash shells it spawns.

**Automation value:** Low. Relevant only if a workflow relies on bash startup scripts for
environment setup (e.g., `nvm`, `rbenv`). If a workflow fails because of missing shell
environment, this becomes relevant. Not worth a global setting.

**Priority: LOW** — edge case; users with this need can use `extraArgs`.

---

#### `--banner`

**What it does:** Shows the startup banner (Copilot ASCII art / version header).

**Automation value:** None. FlightPath strips decorative output. The banner should probably
be suppressed in headless mode.

**Implementation notes:** Consider adding `--no-banner` equivalent if one exists, or rely on
`--silent` to suppress it.

**Priority: LOW** — cosmetic noise suppression.

---

#### `--disallow-temp-dir`

**What it does:** Prevents Copilot from automatically granting access to the system temp
directory.

**Automation value:** Security hardening for paranoid environments. Low practical impact since
FlightPath uses the workspace temp directory (`.flightpath/temp/`), not the system temp dir.

**Priority: LOW** — niche security use case.

---

#### `--experimental` / `--no-experimental`

**What it does:** Enables or disables experimental Copilot features.

**Automation value:** Unknown without knowing which features are experimental. Could become
relevant as new capabilities ship. Not safe to enable by default.

**Priority: LOW** — monitor for future features that warrant exposure.

---

#### `--no-auto-update`

**What it does:** Disables automatic CLI update downloads. Disabled by default in CI
environments.

**Automation value:** FlightPath workflows should run with a known CLI version. Auto-updates
mid-workflow could cause behavioral changes. However, Copilot already suppresses auto-update
in CI (detected via `CI` environment variable). Relevant only for non-CI automation.

**Priority: LOW** — most automation runs in environments where this is already suppressed.

---

#### `--no-color`

**What it does:** Disables all ANSI color codes in output.

**Automation value:** FlightPath headless output parsing may encounter ANSI codes in
plain-text mode. `--no-color` would eliminate them at the source, simplifying parsing. However,
this overlaps with `--silent` and `--output-format json` which solve the same problem more
comprehensively.

**Priority: LOW** — subsumed by higher-priority output format improvements.

---

#### `--plain-diff`

**What it does:** Disables rich diff rendering (syntax-highlighted diffs via `git config`'s
diff tool).

**Automation value:** None. Diff rendering is a TUI concern.

**Priority: LOW** — irrelevant.

---

#### `--screen-reader`

**What it does:** Enables screen reader accessibility optimizations in the TUI.

**Automation value:** None for automation.

**Priority: LOW** — irrelevant.

---

## Custom Args / Append Approach Analysis

### The Question

Would a `copilotExtraArgs` / `additionalArgs` escape hatch (FlightPath keeps all its standard
args, user appends extras at the end) work well for Copilot CLI?

### Assessment: YES, with one important caveat

Copilot CLI uses a well-behaved POSIX-style argument parser (Commander.js, based on the help
format). Key characteristics:

**1. Variadic flags use explicit syntax, not positional greediness.**

The variadic flags (`--allow-tool`, `--deny-tool`, `--available-tools`, `--excluded-tools`,
`--add-github-mcp-tool`, `--add-github-mcp-toolset`, `--secret-env-vars`) consume arguments
until the next flag token (starting with `--` or `-`). They do NOT consume the prompt text or
other positional arguments. This means appending extra flags after FlightPath's standard args
is safe — variadic consumption is bounded by flag boundaries.

Example: `copilot --allow-tool foo bar --model gpt-5` — here `--allow-tool` consumes `foo` and
`bar`, then stops at `--model`.

**2. The prompt flag (`--prompt` / `-p` and `-i`) takes a single quoted string argument.**

FlightPath already wraps prompt text in quotes. An `extraArgs` string appended after the base
args would not be consumed by the prompt flag.

**3. Potential gotcha: variadic flags followed by positional-looking values.**

If a user writes `extraArgs: "--secret-env-vars MY_KEY"`, Commander will correctly parse
`MY_KEY` as a value to `--secret-env-vars`. But if they write `extraArgs: "--secret-env-vars"`
with no value, the parser may try to consume the next token as the variable name. FlightPath
should document that variadic flags in `extraArgs` must include their values.

**4. No ordering constraints between flags.**

Copilot CLI does not appear to have any positional ordering requirements. Flags can appear in
any order relative to each other. FlightPath can safely prepend its required flags and let
user `extraArgs` come at the end.

**5. Headless vs. interactive mode flag isolation.**

Some flags are only meaningful in one mode (`--prompt` / `-i`, `--autopilot`, `--share`).
Copilot CLI does not error on receiving inapplicable flags — it ignores them. However, for
clarity FlightPath should document which flags belong to which mode, and ideally support
separate `headlessExtraArgs` and `interactiveExtraArgs` properties in the schema if the use
case warrants it.

### Recommended `extraArgs` design

```yaml
# In workflow YAML schema
prompts:
  - name: my-prompt
    prompt: Do something complex.
    extraArgs: "--secret-env-vars MY_API_KEY --no-custom-instructions"
```

Or at workflow level for all prompts:
```yaml
harness: copilot-cli
extraArgs: "--secret-env-vars MY_API_KEY"
prompts: [...]
```

In `CopilotCliProvider.buildCliArgs()`, append the parsed extra args at the end of the args
array, after all FlightPath-managed flags. Split on whitespace respecting shell quoting rules
(use a shell-quote-aware splitter, not a naive `split(" ")`).

---

## Prioritized Implementation Roadmap

### Phase 1 — Zero-risk headless hardening (no new settings required)

| Flag | Change |
|------|--------|
| `--silent` | Add unconditionally to `buildHeadlessArgs()` |
| `--no-ask-user` | Add unconditionally to `buildHeadlessArgs()` |
| `--stream on` | Add explicitly to `buildHeadlessArgs()` for future-proofing |

### Phase 2 — New settings, high value

| Flag(s) | New Setting(s) |
|---------|----------------|
| `--output-format json` | `copilotOutputFormat: "text" \| "json"` + update `CopilotResponseParser` |
| `--autopilot` + `--max-autopilot-continues` | `copilotAutopilot: boolean`, `copilotMaxAutopilotContinues: number` |
| `--allow-all-urls` / `--allow-url` / `--deny-url` | `copilotAllowAllUrls`, `copilotAllowUrls[]`, `copilotDenyUrls[]` |
| `--available-tools` / `--excluded-tools` | `copilotAvailableTools[]`, `copilotExcludedTools[]` |
| `--allow-all` consolidation | Emit `--allow-all` when both tools+paths are unrestricted |

### Phase 3 — Useful but lower urgency

| Flag(s) | New Setting(s) |
|---------|----------------|
| `--no-custom-instructions` | `copilotNoCustomInstructions: boolean` |
| `--disable-builtin-mcps` / `--disable-mcp-server` | `copilotDisableBuiltinMcps`, `copilotDisabledMcpServers[]` |
| `--add-github-mcp-tool` / `--add-github-mcp-toolset` | `copilotGithubMcpTools[]`, `copilotGithubMcpToolsets[]` |
| `--secret-env-vars` | `copilotSecretEnvVars[]` |
| `--log-level` | `copilotLogLevel: enum` |
| `--share` | `copilotShareSession: boolean`, `copilotShareSessionPath: string` |
| `--plugin-dir` | `copilotPluginDirs: string[]` |

### Phase 4 — Escape hatch

| Capability | Approach |
|-----------|----------|
| Any remaining flag | `copilotExtraArgs: string` at workflow + prompt level in YAML schema |

---

## References

- Flag data sourced from: `copilot --help` (live CLI, 2026-03-07)
- FlightPath provider: `src/flightpath/harness/copilot/CopilotCliProvider.ts`
- FlightPath settings: `src/utils/ConfigurationUtils.ts`
- Tool permission mapping: `src/flightpath/harness/copilot/CopilotToolPermissionMapper.ts`
- Session log parsing: `src/flightpath/harness/copilot/CopilotLogParser.ts`
