# ctrlyoke VS Code Extension

<projectPurpose>
ctrlyoke automates AI coding harnesses through structured YAML/JSON/Markdown workflows, sequential execution, end-condition validation, pause/resume support, and context-aware prompt expansion. The repository contains a shared workflow engine plus VS Code, CLI, MCP server, and React dashboard adapters around that core.
</projectPurpose>

<orientation>
## Terminology
- Use **harness** for AI execution strategies (`copilot-cli`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, `antigravity-cli`, `copilot-chat`). Reserve **provider** for VS Code API types such as `CompletionItemProvider` or `WebviewViewProvider`.
</orientation>

<debugging>
## Debugging

**Log files** (in `.ctrlyoke/logs/`):

- `ctrlyoke-<timestamp>.log` — session log; state transitions, orchestration flow, session ID resolution. Start here for unexpected stops or state issues.
- `ctrlyoke-<harness>-hook-debug.log` (e.g. `ctrlyoke-copilot-hook-debug.log`) — every hook/notify invocation and result. Start here when completion never fires or session IDs don't match.

**Working files** (in `.ctrlyoke/.queue/`):

- `<name>.ctrlyoke.json` — live working copy with `_runtime` blocks per step (harness, sessionId, responseText, timestamps).
- `<name>.runner.json` — runner lock; a stale file with a dead PID can cause false "already running" errors — safe to delete.

**History files** (in `.ctrlyoke/.history/<name>-<timestamp>/run-<timestamp>/`):

- `events.jsonl` — per-step output events (one CLI output chunk per line). Useful for comparing actual AI output vs. what an end-condition script received, or diagnosing why a retry loop triggered.
- `manifest.json` — step metadata and run summary.

**Adding logs**: use `Log` from `src/utils/Log.ts` for extension/backend code; use `WebviewLog` from `src/ui/webview-react/utils/logger.ts` for webview/UI code. Do not use `console.log` directly.

**Crash investigation**: a VS Code "crash" a few seconds after a workflow completes is usually an **extension-host V8 heap OOM** (the ext host is a Node UtilityProcess), not a webview/GPU crash — the tell is the ctrlyoke session log stopping dead mid-line with no error written. Minidumps land in `%APPDATA%\Code\Crashpad\reports\*.dmp`; scan them for ASCII strings (`electron.v8-oom.is_heap_oom=1`, `CALL_AND_RETRY_LAST`) to confirm — no symbol server needed. A single large allocation on an already-large heap (not a slow leak) is the typical shape.

**Temp prompt files**: prompt files under `.ctrlyoke/temp/` are deleted by `TempFileManager` as soon as the turn that consumed them completes. Never try to re-read a temp file that was referenced in an _earlier_ turn — it will 404. Infer intent from the changes already made instead of re-fetching the source.
</debugging>

<commonCommands>
## Common Commands

### Build & Compilation

| Command                     | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `npm run compile`           | Compile both extension and webview (full build)            |
| `npm run compile:extension` | Compile extension only (faster for extension-only changes) |
| `npm run compile:webview`   | Compile webview only (faster for UI-only changes)          |
| `npm run typecheck`         | Run TypeScript type checking without emitting code         |

### Testing

| Command                | Purpose                           |
| ---------------------- | --------------------------------- |
| `npm test`             | Run all tests (extension + UI)    |
| `npm run test:ui`      | Run React dashboard UI tests only |
| `npm run test:harness` | Run harness integration tests     |

### Code Quality

| Command                | Purpose                               |
| ---------------------- | ------------------------------------- |
| `npm run lint`         | Lint TypeScript/TSX files             |
| `npm run lint:fix`     | Auto-fix linting issues               |
| `npm run format`       | Format code with Prettier             |
| `npm run format:check` | Check code formatting without changes |

</commonCommands>

<architecture>
## Architecture at a glance
1. Prompt files (`.ctrlyoke.yaml/.yml/.json`, `.prompt.md`) are parsed and validated by `PromptFileParser` against `schemas/workflow-schema.json`.
2. `WorkflowOrchestrator` manages harness integrations and shared services.
3. `WorkflowInstance`, `WorkflowExecutor`, `WorkflowStateMachine`, `PromptQueue`, and end-condition classes run the workflow lifecycle.
4. `src/core/harness/` adapts the core engine to CLI harnesses, shared CLI services, and Copilot Chat.
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
| `src/core/*.ts` | Core workflow engine and runtime orchestration |
| `src/core/orchestration/` | File loading, watching, command handling, history, session helpers |
| `src/core/harness/` | Harness runtime, CLI provider implementations, shared CLI services, Copilot Chat integration |
| `src/ui/` | VS Code-side dashboard bridge, message routing, notifications, serialization |
| `src/ui/webview-react/` | React dashboard, Zustand stores, hooks, components, hosted-browser support |
| `src/types/` | Shared contracts and runtime constants across core/UI/server |
| `src/config/`, `src/utils/` | Configuration backends/services and shared helpers |
| `src/server/` | Hosted dashboard server |
| `src/templates/` | Built-in workflow and agent templates |
| `src/test/`, `src/ui/webview-react/test/` | Mocha and Vitest coverage |
</navigationGuide>

<singleSourcesOfTruth>
- `src/types/DashboardConstants.ts` — shared string constants and helper union types
- `src/types/CtrlYokeTypes.ts` — core workflow and harness contracts
- `src/config/CtrlYokeConfigService.ts` — platform-agnostic config hierarchy
- `src/utils/ConfigurationUtils.ts` — VS Code settings access
- `src/utils/ModelConstants.ts` — model lists and display metadata
- `schemas/workflow-schema.json` — prompt schema source
</singleSourcesOfTruth>

<agentGuidance>
- Keep shared contracts, persisted workflow fields, schema definitions, config plumbing, and webview/server message payloads synchronized when changing cross-layer behavior.
- Update nearby tests with every behavior change: core/orchestration/harness changes belong in `src/test/**`; React dashboard changes belong in `src/ui/webview-react/test/**`.
</agentGuidance>

<knowledgeCapture>
## Capturing project knowledge (shared memory)
- **Always record project memory here, never in harness-private memory.** ctrlyoke is built with 7 different harnesses (Claude, Copilot, Codex, Qwen, Antigravity, Copilot Chat, opencode); anything you save to a single harness's private/internal memory (e.g. Claude's `~/.claude` memory) is invisible to the other six and is effectively lost. The `.github/instructions/*.instructions.md` files and this root file ARE the project's shared, cross-harness memory. If you catch yourself about to write a harness-private note about ctrlyoke, put it in the right instruction file instead.
- When you learn something durable and non-obvious — a root cause, a cross-layer gotcha, an architectural decision, a "do it this way" convention, or a sharp edge that cost real debugging time — write it into the relevant `.github/instructions/*.instructions.md` file (or this base file for cross-cutting facts). These instruction files ARE the project's shared memory: every harness reads them, whereas any single agent's private/internal memory is invisible to the others. Do not leave shared-worthy knowledge in agent-private memory.
- Pick the most specific instruction file using the routing table in `CLAUDE.md`. Keep entries concise and forward-looking: capture the durable rule, constraint, or "why", not a play-by-play of the change (git history already has that). Don't restate what the code or schema already makes obvious.
- Verify any file/symbol/line references against the current code before recording them — instruction files are asserted as fact, so stale citations are worse than none.
</knowledgeCapture>

<commits>
- Do not add attribution or trailer lines to commit messages — no `Co-Authored-By:`, no "Generated with …" footers. Use plain conventional-commit messages only.
</commits>

<codingPrinciples>
- **SOLID principles**: Separation of concerns, always look for opportunities to single source code and follow the DRY principle.
- **DRY (SINGLE SOURCE)**: Never duplicate code that can be single sourced in a helper function or base class.
- **TypeScript strict mode**: Comprehensive type safety
- **Single source of truth**: No hardcoded string duplication across files
- **Security first**: Workspace-scoped operations, process isolation for scripts
</codingPrinciples>>
