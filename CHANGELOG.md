# Changelog

All notable changes to FlightPath will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-12

Initial release.

### Added

- Multi-harness execution: Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, and Copilot Chat UI automation
- Parallel workflow execution with independent pause, resume, and cancel per workflow
- React dashboard with CodeMirror 6 prompt editor, live output viewer, and embedded terminal
- Script-based end conditions with retry logic, timeout protection, and template variable substitution
- Dynamic queue extension via MCP tools — AI can autonomously extend a running workflow at runtime
- Agent injection via `.agent.md` files and per-prompt `agent:` field
- Skills injection with per-prompt `skills:` field
- IntelliSense completions for `@file`, `#file:`, and `#sym:` references with gitignore-aware filtering
- Output history with run selector and persistent per-run snapshots
- Workflow templates: blank, simple-feature, fix-tests, and full-feature
- Multi-format workflow files: `.flightpath.yaml`, `.flightpath.json`, `.prompt.md` with unified JSON Schema validation
- Status bar showing real-time execution state
- Standalone CLI binary (`flightpath run`, `flightpath validate`)
- MCP server binary (`flightpath-mcp`) for tool-based queue operations from AI assistants
- Variable substitution with `--var key=value` flag and `{{varName}}` placeholders in workflows
- Per-prompt session management with three-tier resolution (prompt > workflow > global)
- Side-by-side diff view for comparing AI-generated changes
- Stale-state recovery with atomic file locking and PID-based runner detection
