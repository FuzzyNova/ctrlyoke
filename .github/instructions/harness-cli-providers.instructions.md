---
applyTo: "src/flightpath/harness/copilot/**, src/flightpath/harness/claude/**, src/flightpath/harness/codex/**, src/flightpath/harness/opencode/**, src/flightpath/harness/qwen/**, src/flightpath/harness/gemini/**"
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
</gotchas>
