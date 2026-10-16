# Changelog

All notable changes to ctrlyoke will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The `execution.injectMode` setting is now `execution.reuseRunningTerminal`. If you turned it
  off, turn off the new setting instead; the old key is ignored. A prompt sent to a running
  terminal now shows under a "Prompt sent to running terminal:" header in Output.
- Prior output references now include commands, tool calls and results, search results, file
  changes, and other structured events consistently across machines. Command output is
  tail-truncated and file reads include only their path and line range. The
  `general.includeFullDiffsInPriorContext` setting has been removed.
- History search indexes AI response matches from `TEXT` events.
- Run timeline format v2 removes duplicate prompt and flattened response fields from output
  records. Readers continue to show v1 output, including across a continued v1-to-v2 run.
- Dashboard Copy Output copies assistant-authored text; Copy Full Output includes the complete
  structured transcript. Script search matches use `matchField: "output"` and come from
  recorded stdout and stderr.
- Prior-context references take a `:summary` detail after the kind (`$previous:summary`,
  `$step:summary:1,3-5`) for deterministic prompt-head, changed-file, and text-tail excerpts. `priorContextDetail` adds the same Full / Summary choice in workflow and
  prompt properties; the default remains full detail.

## [0.1.2] - 2026-09-25

### Added

- Uninstalling ctrlyoke now removes its status line from the global settings of Claude Code,
  Copilot, Qwen Code and Antigravity, restoring any command you had before, and deletes
  `~/.ctrlyoke/bin/`. The extension does this when VS Code restarts after you uninstall it; for
  the npm CLI, run the new `ctrlyoke uninstall` before `npm uninstall -g ctrlyoke`. While another
  ctrlyoke installation is still in use, the status line is left for it.
- The `ctrlyoke` CLI ships inside the extension and is on `PATH` in VS Code's integrated
  terminals and in the harness processes ctrlyoke starts. For other shells and CI it is also
  published to npm as `ctrlyoke` at the same version; **ctrlyoke: Install CLI for Use Outside VS
  Code** types the install command for you.
- The CLI and the extension each record their version, and warn when an npm CLI is older than the
  installed extension.
- Shared run, lock, trust and coordination state carries a schema version. An older ctrlyoke
  refuses to write state created by a newer one instead of silently dropping fields.
- History search: `ctrlyoke history` commands on the CLI, plus regex and deep search in the
  dashboard drawer, with results streamed as they're found.
- Fuzzy-ranked file and symbol completions, with the matched characters highlighted.
- End-condition scripts compare stdout/stderr through an explicit operator.
- Prepare a run without starting it, final-step progress on workflow rows, and parallel-group
  highlighting in the prompt chip rail.

### Changed

- The `passthrough` permission mode is renamed to `none`, and `none` no longer escalates to
  bypass.
- The harness portability report is now a compatibility accordion.
- History search streams its index instead of holding it in memory.

### Fixed

- Steps wait for harness background tasks to finish, and the dashboard shows why a step is held.
- Interactive steps whose CLI exits non-zero before completing now fail instead of hanging.
- `ctrlyoke run` picks the harness from the workflow instead of defaulting to Copilot CLI.
- `--no-color` disables colored CLI output.
- Codex session logs are read from `CODEX_HOME`, and OpenCode resumes interactive prompts through
  its plugin.
- Headless output and session IDs survive stream-chunk boundaries, including multi-byte UTF-8.
- A cancelled headless run no longer leaves an orphaned harness process.
- The runner lock hands off cleanly between consecutive runs.
- MCP tools refuse operations they can't perform instead of reporting success.
- Many dashboard fixes: undo for workflow properties and step reorders, status-badge flicker,
  context-window gauge restore, and mobile layout of the dry-run dialog.

## [0.1.1] - 2026-09-17

### Changed

- Save As now creates a portable workflow bundle by copying generated attachments into a sibling
  `<workflow>.assets/` directory and inlining lone generated prompt files. The new ignore rules do
  not untrack files already committed; the only migration gap is a new screenshot added to an
  already-committed workflow that is never re-saved.
- `.ctrlyoke/settings.json` is tracked by default as project configuration. `server.certPath` and
  `server.keyPath` remain machine-local paths and should be configured separately on each machine.

## [0.1.0] - 2026-05-12

Initial release.

### Added

- Multi-harness execution: Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI
- Parallel workflow execution with independent pause, resume, and cancel per workflow
- React dashboard with CodeMirror 6 prompt editor, live output viewer, and embedded terminal
- Script-based end conditions with retry logic, timeout protection, and template variable substitution
- Dynamic workflows via MCP tools — the AI can append steps to a running workflow at runtime
- Agent injection via `.agent.md` files and per-prompt `agent:` field
- Skills injection with per-prompt `skills:` field
- IntelliSense completions for `@file`, `#file:`, and `#sym:` references with gitignore-aware filtering
- Output history with run selector and persistent per-run snapshots
- Workflow templates: blank, simple-feature, fix-tests, and full-feature
- Multi-format workflow files: `.ctrlyoke.yaml`, `.ctrlyoke.json`, `.prompt.md` with unified JSON Schema validation
- Status bar showing real-time execution state
- Standalone CLI binary (`ctrlyoke run`, `ctrlyoke validate`)
- MCP server binary (`ctrlyoke-mcp`) for tool-based queue operations from AI assistants
- Variable substitution with `--var key=value` flag and `{{varName}}` placeholders in workflows
- Per-prompt session management with three-tier resolution (prompt > workflow > global)
- Side-by-side diff view for comparing AI-generated changes
- Stale-state recovery with atomic file locking and PID-based runner detection
