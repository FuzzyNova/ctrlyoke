# Harness home-directory overrides are ignored (Claude, Qwen, Copilot)

- **Found:** 2026-11-07 by Claude during the 0.5.0 release (Qwen user-scope hooks review)
- **Area:** `src/core/harness/{claude,qwen,copilot}/`, `src/core/harness/shared/StatuslineManager.ts`, `src/utils/{McpConfigPaths,LspConfigPaths,ModelRegistry}.ts`
- **Severity:** medium

## Symptom

Three harness CLIs let the user move their global config/state directory with an
environment variable. ctrlyoke hard-codes `os.homedir()/.<harness>` for those
harnesses, so for a user who sets the variable, ctrlyoke reads and writes a directory
the CLI never looks at. The CLI inherits the variable from ctrlyoke's spawn env and
uses the moved directory. Depending on the path, the user sees:

- no streamed output, session ID or subagent attribution, because the log parser tails
  `~/.<harness>/...` while the CLI writes its transcripts elsewhere;
- the status line installed into a `settings.json` the CLI doesn't read;
- user MCP servers, LSP config and Qwen model settings missing from the dashboard, the
  execution preview and the collision checks.

## Verified per harness (installed versions of 2026-11-07)

| Harness | Override the CLI honours | ctrlyoke |
| --- | --- | --- |
| Claude 2.1.319 | `CLAUDE_CONFIG_DIR` replaces `~/.claude` (the native binary's own text: "the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude)") | **Ignored everywhere** |
| Qwen 0.26.9 | `QWEN_HOME` replaces `~/.qwen` (`Storage.getGlobalQwenDir`, so user `settings.json` too); `QWEN_RUNTIME_DIR` moves runtime output, including session data under `projects/` (`Storage.getRuntimeBaseDir`, `packages/core/src/config/storage.ts`) | **Ignored everywhere** |
| Copilot 1.0.107 | `XDG_CONFIG_HOME` → `$XDG_CONFIG_HOME/.copilot` (config, `copilot-instructions.md`); `XDG_STATE_HOME` → `$XDG_STATE_HOME/.copilot/session-state` (and `pkg/`) | **Ignored.** `McpConfigPaths.getCopilotUserMcpConfigPath` honours `COPILOT_HOME`, but that string no longer appears anywhere in the 1.0.107 package, so the branch is stale |
| Codex 0.167.0 | `CODEX_HOME` | Handled (`src/utils/CodexHome.ts`, used by the log parser and MCP paths) |
| OpenCode 2.2.6 | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME` | Mostly handled. `OpenCodeInlineConfig` covers all three. `McpConfigPaths.getOpenCodeUserMcpConfigPath` and `LspConfigPaths.getOpenCodeUserLspConfigPath` honour the two `OPENCODE_*` variables but fall back to `~/.config` without checking `XDG_CONFIG_HOME` (minor). ctrlyoke doesn't read OpenCode's `XDG_DATA_HOME` data directory |
| Antigravity 1.5.3 | None found. The `ANTIGRAVITY_*_DIR` strings in `agy.exe` are internal sidecar variables, and the CLI documents `~/.gemini/...` as fixed | Not affected (the `~/.gemini` paths are correct) |

## Hard-coded paths to fix

- **Claude:**
  - `ClaudeLogParser.ts:248`, `:2212` (`~/.claude/projects`)
  - `StatuslineManager.ts:136-138`
  - `LspConfigPaths.getClaudeInstalledPluginsManifestPath`
  - `McpConfigPaths.ts:59` (`~/.claude.json`, which moves to `$CLAUDE_CONFIG_DIR/.claude.json`)
  - the `~/.claude/agents` and `~/.claude/skills` entries in `HarnessDirectoryUtils.ts:22`, `:40`
- **Qwen:**
  - `QwenLogParser.ts:209`, `:751`, `:1597` (`~/.qwen/projects`; should follow `QWEN_RUNTIME_DIR`, then `QWEN_HOME`)
  - `StatuslineManager.ts:150-152`
  - `McpConfigPaths.getQwenUserMcpConfigPath`
  - `ModelRegistry.ts:453`
  - `SettingsJsonMcpTracker.ts:279`
  - `HarnessDirectoryUtils.ts:27`, `:48` (`~/.qwen/agents`, `~/.qwen/skills`)
  - The isolated home in `inline-config.harness.test.ts` (`withIsolatedQwenHome`), which would be simpler with `QWEN_HOME`
- **Copilot:**
  - `CopilotLogParser.ts:257`, `:1385`, `:1914` (`session-state`, should follow `XDG_STATE_HOME`), `:2068` (`logs`)
  - `StatuslineManager.ts:143-145`
  - `LspConfigPaths.getHomeLspConfigPath`
  - `HarnessDirectoryUtils.ts:23`, `:41` (`~/.copilot/agents`, `~/.copilot/skills`)
  - The dashboard's displayed paths (`McpManagerSection.tsx`, `LanguageServersSection.tsx`) should come from the backend instead of `~/...` literals
  - `McpConfigPaths.getCopilotUserMcpConfigPath`: replace `COPILOT_HOME` with `XDG_CONFIG_HOME`, or keep it as a fallback if older Copilot versions read it

## Steps to Reproduce

1. Set `CLAUDE_CONFIG_DIR` (or `QWEN_HOME`, or `XDG_STATE_HOME` for Copilot) to an empty directory and sign the CLI in there.
2. Start VS Code from that environment and run a workflow step on that harness.
3. The step runs, but the output panel never streams the transcript and the session ID stays unresolved. The CLI wrote its session under the override, and ctrlyoke tails `~/.<harness>`.

## Root Cause

Each harness module builds its global paths from `os.homedir()` inline, and only Codex
has a resolver (`getCodexHomeDir`). Nothing single-sources "this harness's global
directory".

## Suggested Fix

Add one resolver per harness next to `CodexHome.ts` (for example a `HarnessHome.ts`
exporting `claudeConfigDir()`, `qwenHomeDir()`, `qwenRuntimeDir()`,
`copilotConfigDir()`, `copilotStateDir()`). Each takes `env` so tests can inject it.
Route every path above through it. Resolve against the spawn env the harness actually
receives (`getInteractiveSpawnEnv`/`getHeadlessSpawnEnv`), not only `process.env`, so
an `env:` override in a workflow is honoured as well. Add unit tests for each resolver,
and add a grep-style lint test that fails on new `os.homedir()` + `.claude`/`.qwen`/
`.copilot` joins outside the resolver module.

No compatibility path is needed: this changes no stored format and alters behaviour
only for users who set these variables, whose runs are broken today. It still needs a
**Fixed** entry in `CHANGELOG.md` when it lands.
