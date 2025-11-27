# Changelog

All notable changes to FlightPath will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-11-27

### Added

- **CLI Mode** (Default): Deterministic Copilot automation via `copilot` CLI
  - Model selection: Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 4.5, GPT-5
  - Agent support via `--agent` flag
  - Session resumption for multi-turn conversations
  - Streaming output with real-time display

- **Chat Mode**: UI-based automation for Copilot Chat window
  - Language Model Tool API for response detection
  - 22 model options including GPT-5, Claude, and Gemini variants
  - Native file attachment support

- **Dynamic Queue System**: Let Copilot extend workflows autonomously
  - Prompt identity tracking (explicit ID + content hash)
  - Safety guardrails: queue size limits, execution time limits
  - Selective instruction injection
  - Unlimited mode for advanced users

- **End Conditions**: Script-based validation with automatic retry
  - Support for Python, JavaScript, TypeScript, PowerShell, Bash, Batch
  - Configurable retry prompts with placeholder substitution
  - Timeout protection and process isolation

- **WebView Dashboard**: Real-time workflow visualization
  - Live CLI output streaming
  - Step-by-step progress tracking
  - Pause/Resume/Stop controls

- **File Format Support**
  - `.prompt.json`: Single prompt files
  - `.flightpath.json`: Multi-prompt workflows
  - `.prompt.md`: Markdown-based prompts (no JSON needed)
  - JSON Schema validation with IntelliSense

- **Context Integration**
  - `@workspace` context inclusion
  - `#file:path` and `#file:path:line-line` references
  - `#selection` for current editor selection
  - Slash commands: `/fix`, `/explain`, `/new`, `/tests`

- **Developer Experience**
  - Status bar with real-time execution status
  - Context menu integration (Send to CLI / Send to Chat)
  - End condition script templates
  - Comprehensive settings for customization

### Security

- Script path validation (no directory traversal, no shell injection)
- Workspace-scoped file operations
- Process isolation for end condition scripts
- Configurable timeout protection

---

## [Unreleased]

### Planned

- Custom tool permissions for CLI mode
- Workflow templates and snippets
- VS Code notebooks integration

[0.1.0]: https://github.com/nhickster/flightpath/releases/tag/v0.1.0
[Unreleased]: https://github.com/nhickster/flightpath/compare/v0.1.0...HEAD
