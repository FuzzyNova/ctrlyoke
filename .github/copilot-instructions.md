# FlightPath VS Code Extension

<projectPurpose>
FlightPath automates AI coding harnesses through structured YAML/JSON/Markdown workflows, sequential execution, end-condition validation, pause/resume support, and context-aware prompt expansion. The repository contains a shared workflow engine plus VS Code, CLI, MCP server, and React dashboard adapters around that core.
</projectPurpose>

<orientation>
## Terminology
- Use **harness** for AI execution strategies (`copilot-cli`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, `gemini-cli`, `copilot-chat`). Reserve **provider** for VS Code API types such as `CompletionItemProvider` or `WebviewViewProvider`.
</orientation>

<debugging>
## Debugging

**Log files** (in `.flightpath/logs/`):
- `flightpath-<timestamp>.log` — session log; state transitions, orchestration flow, session ID resolution. Start here for unexpected stops or state issues.
- `flightpath-<harness>-hook-debug.log` (e.g. `flightpath-copilot-hook-debug.log`) — every hook/notify invocation and result. Start here when completion never fires or session IDs don't match.

**Working files** (in `.flightpath/.queue/`):
- `<name>.flightpath.json` — live working copy with `_runtime` blocks per step (harness, sessionId, responseText, timestamps).
- `<name>.runner.json` — runner lock; a stale file with a dead PID can cause false "already running" errors — safe to delete.

**History files** (in `.flightpath/.history/<name>-<timestamp>/run-<timestamp>/`):
- `events.jsonl` — per-step output events (one CLI output chunk per line). Useful for comparing actual AI output vs. what an end-condition script received, or diagnosing why a retry loop triggered.
- `manifest.json` — step metadata and run summary.

**Adding logs**: use `Log` from `src/utils/Log.ts` for extension/backend code; use `WebviewLog` from `src/ui/webview-react/utils/logger.ts` for webview/UI code. Do not use `console.log` directly.
</debugging>

<architecture>
## Architecture at a glance
1. Prompt files (`.flightpath.yaml/.yml/.json`, `.prompt.md`) are parsed and validated by `PromptFileParser` against `schemas/prompt-schema.json`.
2. `WorkflowOrchestrator` manages harness integrations and shared services.
3. `WorkflowInstance`, `WorkflowExecutor`, `WorkflowStateMachine`, `PromptQueue`, and end-condition classes run the workflow lifecycle.
4. `src/flightpath/harness/` adapts the core engine to CLI harnesses, shared CLI services, and Copilot Chat.
5. `src/ui/` is the VS Code-side dashboard adapter layer; `src/ui/webview-react/` is the React client used by both the webview and hosted browser dashboard.
6. `src/cli.ts` and `src/mcp-server.ts` provide standalone binaries on top of the same core.
</architecture>

<navigationGuide>
## Key areas
| Path | Role |
| --- | --- |
| `src/extension.ts` | VS Code extension entry point and registration wiring |
| `src/cli.ts`, `src/cli/` | Standalone CLI binary and CLI-only helpers |
| `src/mcp-server.ts` | Standalone MCP server binary |
| `src/flightpath/*.ts` | Core workflow engine and runtime orchestration |
| `src/flightpath/orchestration/` | File loading, watching, command handling, history, session helpers |
| `src/flightpath/harness/` | Harness runtime, CLI provider implementations, shared CLI services, Copilot Chat integration |
| `src/ui/` | VS Code-side dashboard bridge, message routing, notifications, serialization |
| `src/ui/webview-react/` | React dashboard, Zustand stores, hooks, components, hosted-browser support |
| `src/types/` | Shared contracts and runtime constants across core/UI/server |
| `src/config/`, `src/utils/` | Configuration backends/services and shared helpers |
| `src/server/` | Hosted dashboard server |
| `src/templates/` | Built-in workflow and agent templates |
| `src/test/`, `src/ui/webview-react/test/` | Mocha and Vitest coverage |
</navigationGuide>

<singleSourcesOfTruth>
## Single sources of truth
- `src/types/DashboardConstants.ts` — shared string constants and helper union types
- `src/types/FlightPathTypes.ts` — core workflow and harness contracts
- `src/config/FlightPathConfigService.ts` — platform-agnostic config hierarchy
- `src/utils/ConfigurationUtils.ts` — VS Code settings access
- `src/utils/ModelConstants.ts` — model lists and display metadata
- `schemas/prompt-schema.json` — prompt schema source
</singleSourcesOfTruth>

<agentGuidance>
## Guidance for agents
- Work in the smallest layer that owns the behavior you are changing; avoid pushing feature logic into entry points or adapters when a lower-level class already owns it.
- Keep shared contracts, persisted workflow fields, schema definitions, config plumbing, and webview/server message payloads synchronized when changing cross-layer behavior.
- Update nearby tests with every behavior change: core/orchestration/harness changes belong in `src/test/**`; React dashboard changes belong in `src/ui/webview-react/test/**`.
- The instruction files below contain the detailed gotchas. Do not duplicate them in new code or docs; follow them directly.
</agentGuidance>

<instructionFiles>
## Instruction file map
| Pattern | Instruction file |
| --- | --- |
| `src/completions/**` | `.github/instructions/completions.instructions.md` |
| `src/config/**` | `.github/instructions/config.instructions.md` |
| `src/dev/**` | `.github/instructions/dev.instructions.md` |
| `src/extension.ts`, `src/mcp-server.ts` | `.github/instructions/extension.instructions.md` |
| `src/cli.ts`, `src/cli/**` | `.github/instructions/flightpath-cli-binary.instructions.md` |
| `src/flightpath/*.ts` | `.github/instructions/flightpath-core.instructions.md` |
| `src/flightpath/orchestration/**` | `.github/instructions/flightpath-orchestration.instructions.md` |
| `src/flightpath/harness/CliIntegration.ts`, `src/flightpath/harness/CliLogMonitor.ts`, `src/flightpath/harness/PtyProcessManager.ts` | `.github/instructions/harness-integrations.instructions.md` |
| `src/flightpath/harness/{copilot,claude,codex,opencode,qwen,gemini}/**` | `.github/instructions/harness-cli-providers.instructions.md` |
| `src/flightpath/harness/shared/**` | `.github/instructions/harness-shared.instructions.md` |
| `src/flightpath/harness/chat/**` | `.github/instructions/flightpath-chat.instructions.md` |
| `src/git/**` | `.github/instructions/git.instructions.md` |
| `src/platform/**` | `.github/instructions/platform.instructions.md` |
| `src/scm/**` | `.github/instructions/scm.instructions.md` |
| `src/scripts/**` | `.github/instructions/scripts.instructions.md` |
| `src/server/**` | `.github/instructions/server.instructions.md` |
| `src/templates/**` | `.github/instructions/templates.instructions.md` |
| `src/test/**` | `.github/instructions/test.instructions.md` |
| `src/types/**` | `.github/instructions/types.instructions.md` |
| `src/types/{DashboardConstants.ts,FlightPathTypes.ts,WorkflowContextTypes.ts,FlightPathSettings.ts,CliOutputTypes.ts,IDashboardSink.ts}` | `.github/instructions/types-core.instructions.md` |
| `src/types/{WebviewMessageTypes.ts,OutputHistoryTypes.ts,WorkflowTimelineTypes.ts}` | `.github/instructions/types-webview-history.instructions.md` |
| `src/types/{HostedWorkspaceViewerTypes.ts,IconColorDefaults.ts}` | `.github/instructions/types-hosted.instructions.md` |
| `src/ui/**` (exclude `src/ui/webview-react/**`) | `.github/instructions/ui.instructions.md` |
| `src/ui/webview-react/**` | `.github/instructions/webview-react.instructions.md` |
| `src/ui/webview-react/components/**` | `.github/instructions/webview-react-components.instructions.md` |
| `src/ui/webview-react/components/workspace-viewer/**` | `.github/instructions/webview-react-workspace.instructions.md` |
| `src/ui/webview-react/hooks/**` | `.github/instructions/webview-react-hooks.instructions.md` |
| `src/ui/webview-react/store/**` | `.github/instructions/webview-react-store.instructions.md` |
| `src/utils/**` | `.github/instructions/utils.instructions.md` |
</instructionFiles>
