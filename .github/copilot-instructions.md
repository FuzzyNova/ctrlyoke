# ctrlyoke VS Code Extension

<projectPurpose>
ctrlyoke automates AI coding harnesses through structured YAML/JSON/Markdown workflows, sequential execution, end-condition validation, pause/resume support, and context-aware prompt expansion. The repository contains a shared workflow engine plus VS Code, CLI, MCP server, and React dashboard adapters around that core.
</projectPurpose>

<orientation>
## Terminology
- Use **harness** for AI execution strategies. There are exactly six, and `HARNESS_IDS` in `src/types/DashboardConstants.ts` is the source of truth: `copilot-cli`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, `antigravity-cli`. Reserve **provider** for VS Code API types such as `CompletionItemProvider` or `WebviewViewProvider`.
- **There is no `copilot-chat` harness.** It was permanently removed before release for policy/legal reasons (see `dev/implemented/COPILOT_CHAT_ARCHIVAL_REMOVAL_PLAN.md`) and must never be reintroduced into code, schemas, docs, plans, or capability tables. Historical references survive in `dev/implemented/`, `dev/rejected/`, `dev/reference/`, and `dev/research/` as an accurate record of past work — do not treat those as evidence that the harness still exists.
</orientation>

<debugging>
## Debugging

**Log files** (in `.ctrlyoke/logs/`):

- `ctrlyoke-<timestamp>.log` — session log; state transitions, orchestration flow, session ID resolution. Start here for unexpected stops or state issues.
- `ctrlyoke-<harness>-hook-debug.log` (e.g. `ctrlyoke-copilot-hook-debug.log`) — every hook/notify invocation and result. Start here when completion never fires or session IDs don't match.

**Run storage** is resolved by `WorkflowPaths.runsRoot(stateRoot)`. In the default user mode it
is `<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/`; in workspace mode it is
`<stateRoot>/.ctrlyoke/.runs/<workflowKey>/`. Managed worktree runs keep the initiating
checkout's `stateRoot`; opening a worktree directory directly as its own VS Code workspace gives
it its own history.

- `workflow.json` — lineage descriptor (name, favorite, `latestRunRef`, `nextRunId`).
- `runner.json` — runner lock, naming the exact executing `RunRef`; a stale file with a dead PID can cause false "already running" errors — safe to delete.
- `draft/workflow.ctrlyoke.json` — the lineage's not-yet-executed definition, present before the first run.
- `run-<timestamp>/workflow.ctrlyoke.json` — that run's live working copy with `_runtime` blocks per step (harness, sessionId, responseText, timestamps).
- `run-<timestamp>/events.jsonl` — per-step output events (one CLI output chunk per line). Useful for comparing actual AI output vs. what an end-condition script received, or diagnosing why a retry loop triggered.
- `run-<timestamp>/manifest.json` — step metadata and run summary.

User-scoped history under OneDrive or Dropbox is synchronized, but running the same project
simultaneously on two synced machines is unsupported: PIDs and file locks are machine-local and
cannot coordinate across devices. The `.ctrlyoke/logs/` guidance above remains workspace-scoped
because logs deliberately do not move.

**Adding logs**: use `Log` from `src/utils/Log.ts` for extension/backend code; use `WebviewLog` from `src/ui/webview-react/utils/logger.ts` for webview/UI code. Do not use `console.log` directly.

**Crash investigation**: a VS Code "crash" a few seconds after a workflow completes is usually an **extension-host V8 heap OOM** (the ext host is a Node UtilityProcess), not a webview/GPU crash — the tell is the ctrlyoke session log stopping dead mid-line with no error written. Minidumps land in `%APPDATA%\Code\Crashpad\reports\*.dmp`; scan them for ASCII strings (`electron.v8-oom.is_heap_oom=1`, `CALL_AND_RETRY_LAST`) to confirm — no symbol server needed. A single large allocation on an already-large heap (not a slow leak) is the typical shape.

**Temp prompt files**: prompt files under `.ctrlyoke/temp/` are deleted by `TempFileManager` as soon as the turn that consumed them completes. Never try to re-read a temp file that was referenced in an _earlier_ turn — it will 404. Infer intent from the changes already made instead of re-fetching the source.

**Driving the hosted dashboard with Playwright**: in dev builds, `CtrlYokeHostedServer` mirrors the live hosted-server URL (including its access token) to `.ctrlyoke/dev/server-url.txt` (gitignored) as soon as `ctrlyoke.enableServer` starts listening, and deletes the file on `dispose()`. Read that file directly to get the current URL instead of asking the user to paste it — it's absent/stale exactly when the server isn't running. This requires the Playwright MCP server to be attached to the session; the user doesn't attach it by default (it's a large MCP and costs context space), so if it isn't available, ask them to attach it rather than assuming it's missing on purpose.
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

| Command                    | Purpose                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm test`                 | Run all tests (extension + UI)                                                  |
| `npm run test:ui`          | Run React dashboard UI tests only                                               |
| `npm run test:harness`     | Run harness integration tests (NEVER CALL THIS UNLESS EXPLICITLY TOLD TO DO SO) |
| `npm run test:coverage`    | Extension-host coverage report (`coverage/extension/index.html`)                |
| `npm run test:ui:coverage` | React dashboard coverage report (`src/ui/webview-react/coverage/index.html`)    |

NOTE: `npm run test:harness` runs real harnesses, costs money, and is very slow (30+ minutes). Never run this command unless explicitly told to do so. Use `npm test` which invokes all extension, integration, and UI tests, but does not run the harness tests.

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
4. `src/core/harness/` adapts the core engine to CLI harnesses and shared CLI services.
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
| `src/core/harness/` | Harness runtime, CLI provider implementations, shared CLI services |
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
- `schemas/settings-schema.json` + `src/types/CtrlYokeSettings.ts` — the only settings surface. Every ctrlyoke setting is read from `.ctrlyoke/settings.json` through `CtrlYokeConfigService`/`ConfigurationUtils`. **`package.json`'s `contributes.configuration` is not a settings surface** — `vscode.workspace.getConfiguration('ctrlyoke')` is called in exactly one place (`VsCodeWorkspaceRoot.ts`), for exactly one setting, `ctrlyoke.workspaceDirectory`, which must live there because ctrlyoke needs it to *locate* `.ctrlyoke/settings.json` in the first place — a real bootstrap exception, not a precedent. Any other property added to `package.json`'s configuration block is a disconnected, do-nothing duplicate that appears in VS Code's native Settings UI but is never read by any code path (confirmed by removing 13 such stale entries — six `statusLineTracking` and six `usageTracking`/`modelPricing`/`ui.hideCost` properties — on 2026-08-21). If a setting needs machine-scope-style exclusion from Settings Sync or user-vs-workspace write restrictions, implement it in `CtrlYokeConfigService.ts` (see `WORKSPACE_FORBIDDEN_SETTING_ROOTS`) — not by mirroring it into `package.json`.
</singleSourcesOfTruth>

<agentGuidance>
- Keep shared contracts, persisted workflow fields, schema definitions, config plumbing, and webview/server message payloads synchronized when changing cross-layer behavior.
- Update nearby tests with every behavior change: core/orchestration/harness changes belong in `src/test/**`; React dashboard changes belong in `src/ui/webview-react/test/**`.
</agentGuidance>

<knowledgeCapture>
## Capturing project knowledge (shared memory)
- **If you record project knowledge, record it here — never in harness-private memory.** ctrlyoke is *developed using* several different AI assistants (Claude, Copilot CLI, Copilot Chat, Codex, Qwen, Antigravity, opencode); anything you save to a single assistant's private/internal memory (e.g. Claude's `~/.claude` memory) is invisible to the others and is effectively lost. Note that this is the list of tools used to build ctrlyoke — it is **not** the list of harnesses ctrlyoke supports, which is the six in `HARNESS_IDS` above. The `.github/instructions/*.instructions.md` files and this root file are the project's shared, cross-harness memory. If you catch yourself about to write a harness-private note about ctrlyoke, put it in the right instruction file (or a backlog doc) instead.
- **Most turns should not touch an instruction file, and that's expected.** These files are not a running log of what you did — git history already has that. Do not feel obligated to add an entry just because you changed code or finished a task. The bar is high on purpose: instruction files stay valuable only while they stay lean.
- **Only add to an instruction file when the knowledge clears this bar:** it is durable (still true after this task), and it is *not* readily discoverable by reading the code — a genuine gotcha, a non-obvious cross-layer coupling, an architectural decision and its "why", a "do it this way / not that way" convention, or a sharp edge that cost real debugging time and would cost the next agent the same. If a competent agent would find it quickly by reading the relevant file, leave it out; the code is the source of truth for how things work, and instruction files exist to surface only what the code can't easily tell you.
- **Plans for unimplemented work go in `dev/backlog/`, not instruction files.** Instruction files describe how the code *currently* works. Keep design proposals, and any gotchas specific to a not-yet-built feature, inside that feature's backlog doc.
- When you do write an entry: pick the most specific instruction file via the routing table in `CLAUDE.md`, keep it concise and forward-looking (the durable rule/constraint/why, not a play-by-play), don't restate what the code or schema already makes obvious, and prefer editing/tightening an existing bullet over appending a near-duplicate. Verify any file/symbol/line references against the current code first — these files are asserted as fact, so a stale citation is worse than none.
</knowledgeCapture>

<commits>
- Do not add attribution or trailer lines to commit messages — no `Co-Authored-By:`, no "Generated with …" footers. Use plain conventional-commit messages only.
- Git's stash stack is shared by every worktree in a repository. If stashing is unavoidable, always give the stash a globally unique message that identifies the workflow/agent and worktree, then resolve and restore that exact stash entry (prefer its commit hash). Never use an unqualified `git stash pop`/`git stash apply` or assume `stash@{0}` is yours while another agent may be running; another worktree can push between those operations and cause changes to cross worktrees.
</commits>

<codingPrinciples>
- **SOLID principles**: Separation of concerns, always look for opportunities to single source code and follow the DRY principle.
- **DRY (SINGLE SOURCE)**: Never duplicate code that can be single sourced in a helper function or base class.
- **TypeScript strict mode**: Comprehensive type safety
- **No hardcoded strings for flow control**: If a string is used with `==`, `!=`, or `switch/case`, it should be a constant or enum value in DashboardConstants.ts or CtrlYokeTypes.ts. This ensures that the string is single-sourced and avoids typos.
- **Security first**: Workspace-scoped operations, process isolation for scripts
- **Make structural relationships nominal**: Always express type relationships explicitly rather than relying on structural compatibility alone — this keeps VS Code's language service and dead-code tooling (`scripts/find-dead-methods.mjs`) able to trace references symbol-by-symbol. Concretely: (1) replace `as unknown as { ... }` casts with a real shared interface or an optional member added to the target type; (2) give every test double an `implements` clause for _each_ type it stands in for, including framework types — not just the narrowest local interface; (3) add `implements SomePluginInterface` to anonymous class literals passed to framework APIs whenever the library exports that interface; (4) avoid string-keyed/dynamic dispatch (`obj[methodName]()`, reflection over `Object.keys(this)`) — if dynamic dispatch is unavoidable, keep the set of valid keys as a typed union or `const` object at the dispatch site so at least the key set is statically checked.
</codingPrinciples>>
