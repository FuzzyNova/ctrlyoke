# Harness home-directory overrides are ignored (Claude, Qwen, Copilot)

- **Found:** 2026-11-07 by Claude during the 0.5.0 release (Qwen user-scope hooks review)
- **Area:** `src/core/harness/{claude,qwen,copilot}/`, `src/core/harness/shared/StatuslineManager.ts`, `src/utils/{McpConfigPaths,LspConfigPaths,ModelRegistry}.ts`
- **Resolution:** fixed in this commit

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

| Harness           | Override the CLI honours                                                                                                                                                                                                                         | ctrlyoke                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude 2.1.319    | `CLAUDE_CONFIG_DIR` replaces `~/.claude` (the native binary's own text: "the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude)")                                                                                                    | **Ignored everywhere**                                                                                                                                                                                                                                                                                                                  |
| Qwen 0.26.9       | `QWEN_HOME` replaces `~/.qwen` (`Storage.getGlobalQwenDir`, so user `settings.json` too); `QWEN_RUNTIME_DIR` moves runtime output, including session data under `projects/` (`Storage.getRuntimeBaseDir`, `packages/core/src/config/storage.ts`) | **Ignored everywhere**                                                                                                                                                                                                                                                                                                                  |
| Copilot 1.0.107   | `XDG_CONFIG_HOME` → `$XDG_CONFIG_HOME/.copilot` (config, `copilot-instructions.md`); `XDG_STATE_HOME` → `$XDG_STATE_HOME/.copilot/session-state` (and `pkg/`)                                                                                    | **Ignored.** `McpConfigPaths.getCopilotUserMcpConfigPath` honours `COPILOT_HOME`, but that string no longer appears anywhere in the 1.0.107 package, so the branch is stale                                                                                                                                                             |
| Codex 0.167.0     | `CODEX_HOME`                                                                                                                                                                                                                                     | Handled (`src/utils/CodexHome.ts`, used by the log parser and MCP paths)                                                                                                                                                                                                                                                                |
| OpenCode 2.2.6    | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`                                                                                                                                                                                      | Mostly handled. `OpenCodeInlineConfig` covers all three. `McpConfigPaths.getOpenCodeUserMcpConfigPath` and `LspConfigPaths.getOpenCodeUserLspConfigPath` honour the two `OPENCODE_*` variables but fall back to `~/.config` without checking `XDG_CONFIG_HOME` (minor). ctrlyoke doesn't read OpenCode's `XDG_DATA_HOME` data directory |
| Antigravity 1.5.3 | None found. The `ANTIGRAVITY_*_DIR` strings in `agy.exe` are internal sidecar variables, and the CLI documents `~/.gemini/...` as fixed                                                                                                          | Not affected (the `~/.gemini` paths are correct)                                                                                                                                                                                                                                                                                        |

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

## Fix

`src/utils/HarnessHome.ts` (which absorbed `CodexHome.ts`) resolves every harness
home, and every path listed above now goes through it. The user agent and skill
folders in `HarnessDirectoryUtils.ts` are relative to the resolved home, Codex's
included, which also ignored `CODEX_HOME` before. OpenCode's user MCP/LSP paths and
`OpenCodeInlineConfig` share `getOpenCodeGlobalConfigDir`, so `XDG_CONFIG_HOME` is
honoured everywhere. The dashboard's MCP and LSP export menus show the user-scope
paths the backend resolved (`userConfigPaths` on the two local-scan result messages),
falling back to the `~/...` literals until the first scan arrives.
`HarnessHome.test.ts` covers each resolver and lints `src/` for new
`homedir()` + `.claude`/`.qwen`/`.copilot`/`.codex` joins and `~/.<harness>/...` path
strings. `harness-home.harness.test.ts` runs Claude, Qwen and Copilot with their homes
moved, in both modes, and checks the transcript, session ID and response text.

### Corrections to the findings above (verified 2026-11-07)

- **Copilot 1.0.107 honours `COPILOT_HOME`, not `XDG_*`.** `copilot help environment`
  documents "`COPILOT_HOME`: override the directory where configuration and state files
  are stored; defaults to `$HOME/.copilot`". The string was missing from the npm package
  only because the app lives in `~/.copilot/pkg/<platform>/<version>/` (the npm package
  is a launcher). Its changelog says it now _migrates_ an older `$XDG_CONFIG_HOME/.copilot`
  into `~/.copilot`. Probed: `COPILOT_HOME=<dir> copilot mcp add` wrote
  `<dir>/mcp-config.json`, while `XDG_CONFIG_HOME`/`XDG_STATE_HOME` changed nothing.
  So the existing `COPILOT_HOME` branch in `McpConfigPaths` was right, and the fix
  extends it to the other Copilot paths.
- **Claude:** probed `CLAUDE_CONFIG_DIR=<dir> claude mcp add --scope user`, which wrote
  `<dir>/.claude.json`, confirming the `.claude.json` move.
- **Qwen:** probed `QWEN_HOME=<dir> qwen mcp add --scope user`, which wrote
  `<dir>/settings.json`. Session data follows `QWEN_RUNTIME_DIR`, then the
  `advanced.runtimeOutputDir` setting, then `QWEN_HOME`.
- **Spawn env:** none of the providers' `getHeadlessSpawnEnv`/`getInteractiveSpawnEnv`
  sets a home variable, and `env:` exists only on script steps, which never launch a
  harness. A prompt step's harness therefore always inherits these variables from
  ctrlyoke's `process.env`, which is what the resolvers read. (A managed secret granted
  under one of these names would also be passed to the harness without being followed.)
- `SettingsJsonMcpTracker`'s default `userConfigPath` (`~/.<toolName>/settings.json`) has
  no production caller; every tracker for a moved-home harness passes its own path.

### Follow-up: per-step moves

The first fix left two moves unfollowed. The follow-up commit covers both:

- **Qwen `advanced.runtimeOutputDir`.** `QwenRuntimeDir.ts` copies Qwen 0.26.9's
  `loadSettings` merge for that one key: system defaults < user < workspace (trusted
  folders only) < system, with `$VAR`/`${VAR}` substitution and `~`/relative paths
  resolved against the workspace. When `security.folderTrust.enabled` is on, trust
  depends on Qwen's trusted-folder rules (precedence, path variants, IDE trust). Those
  are not reproduced. Instead the log parser searches both the trusted and untrusted
  candidates, which is safe because session IDs are unique.
- **Copilot `--config-dir`.** `resolveCopilotHome(configDir, COPILOT_HOME, homedir)`
  puts the flag first. `CopilotCliProvider` reads it from the step's `additionalArgs`
  (last one wins) and gives it to the log parser in the per-prompt runtime mutation.
  The parser's two former static helpers are instance methods now, so they see it too.
  The statusline and the dashboard's user MCP/LSP paths stay on `COPILOT_HOME`, because
  they are machine-wide and not tied to one step.
- **Found while doing this:** Qwen finds `system-defaults.json` in
  `dirname(getSystemSettingsPath())` unless `QWEN_CODE_SYSTEM_DEFAULTS_PATH` is set
  (Qwen 0.26.9 source). ctrlyoke's per-launch `QWEN_CODE_SYSTEM_SETTINGS_PATH` points
  into `.ctrlyoke/temp/`, so every ctrlyoke Qwen launch silently dropped the user's
  system defaults. The provider now also sets `QWEN_CODE_SYSTEM_DEFAULTS_PATH` to the
  real file.
