# Changelog

All notable changes to ctrlyoke will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Dynamic queue extension via MCP tools — AI can autonomously extend a running workflow at runtime
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
