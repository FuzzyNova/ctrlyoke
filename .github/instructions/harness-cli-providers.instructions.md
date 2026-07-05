---
applyTo: "src/core/harness/copilot/**, src/core/harness/claude/**, src/core/harness/codex/**, src/core/harness/opencode/**, src/core/harness/qwen/**, src/core/harness/gemini/**"
---

<purpose>
Harness-specific adapters for CLI execution. Provider directories should contain CLI-specific flags, parsing, hook/MCP setup, and cleanup — not shared orchestration.
</purpose>

<providerResponsibilities>
- Keep each provider focused on its CLI: static `config`, parser(s), notification monitor, permission mapper, log parser, and provider-specific arg building.
- `buildCliArgs()` should handle resolved model/session/workspace/additionalArgs and provider-only flags. Leave prompt assembly, generic hook dispatch, PTY lifecycle, and workflow runtime persistence to shared code.
- `buildHeadlessArgs()` / `buildInteractiveArgs()` are the source of truth for prompt flag/positional ordering. Some CLIs require different prompt placement between modes, so do not push that logic into shared helpers.
- Hook setup now belongs in `buildNotificationHookArgs()` and `buildHeadlessUserHookArgs()`, not inline inside `buildCliArgs()`.
</providerResponsibilities>

<statefulProviders>
- Copilot, Claude, and Codex may write temp config/hook artifacts; clean those through `getAdditionalCleanupFilePaths()` and `cleanupWorkspaceArtifacts()` rather than ad hoc deletes in parser/monitor code.
- Qwen and Gemini mutate shared `.{tool}/settings.json` state through the shared trackers. Always register/unregister per workflow and compute `--allowed-mcp-server-names` from the prompt-local MCP set so parallel workflows cannot see each other’s servers.
- OpenCode is intentionally different: MCP/tool permissions are config-file driven and completion comes from the deployed plugin. A near-empty permission mapper is expected there.
</statefulProviders>

<parsingAndRecovery>
- Headless and interactive paths should converge on the same `UniversalCliOutput` semantics. Share mapping logic between response parsers and log parsers whenever the CLI exposes both streams.
- Use `augmentParsedOutput()` to patch missing token/session/context-window metadata from logs after the initial parse instead of teaching the UI or `CliIntegration` about provider quirks.
- `extractSessionIdFromLogs()` is a fallback recovery path, not the primary contract.
</parsingAndRecovery>

<gotchas>
- Copilot can emit structured JSON headless output but still needs raw-text fallback support; keep that distinction in provider config/parser metadata, not UI conditionals.
- Claude interactive runs rely on `getInteractiveSpawnEnv()` to remove env that would otherwise block nested Claude execution.
- OpenCode must resume with explicit session IDs (`-s`), never “continue last session”.
- When a provider edits workspace files to register hooks/MCP, baseline restoration is more important than eager cleanup because other workflows may still be active.
- Copilot CLI 1.0.x (the 0.0.x → 1.0.x jump) silently dropped the `session.truncation` event entirely — it no longer fires on any turn, so any context-window logic keyed on it goes dark with no error. The only context signal left in `events.jsonl` is `session.shutdown`'s `currentTokens` (system+conversation+toolDefinitions total), which fires once at process exit and carries no token-limit field — pair it with `getCopilotContextWindowSize(model)` for the denominator. The `CompactionProcessor` utilization line in `~/.copilot/logs/process-*.log` (the other historical fallback) has also become unreliable — it no longer writes on most sessions. When Copilot bumps its CLI version, diff a fresh `~/.copilot/session-state/<id>/events.jsonl` against `CopilotLogParser`'s assumptions before trusting existing parsing logic.
- `session.shutdown` only fires when the Copilot **process** exits — and in interactive mode ctrlyoke deliberately keeps that process alive across a multi-step workflow (resumed via `--resume` between steps), so it may not fire until the whole workflow ends. Log-based context tracking is therefore fundamentally insufficient for interactive sessions, independent of the 1.0.x regression above.
- Copilot's OpenTelemetry file exporter (`copilot help monitoring`; `COPILOT_OTEL_ENABLED` + `COPILOT_OTEL_FILE_EXPORTER_PATH`) is the only genuinely live, per-turn context signal left, and `CopilotCliProvider`/`CopilotLogParser` now use it as the primary source (see `buildOtelSpawnEnv()`, `pollOtelContextWindow()`, `getFinalOtelUsage()`). Confirmed empirically: it writes JSON lines to the file *incrementally during* execution, not just at exit. Each `chat <model>` span carries `gen_ai.usage.input_tokens`/`.output_tokens` as plain attributes (no histogram math needed) — `input_tokens` is the full resent context size for that turn, i.e. exactly what `session.truncation` used to report. **Always override this env var explicitly per invocation** — some environments have `COPILOT_OTEL_FILE_EXPORTER_PATH` already set globally (observed pointed at `\\.\nul`, the Windows null device), which silently discards this data if left alone. The path must be generated fresh in `buildCliArgs()` (or unset) every prompt since the provider/parser instances are reused across prompts within a workflow but are fresh per workflow execution (`IntegrationFactory` — not a global singleton).
</gotchas>
