# VS Code IDE MCP Integration Plan

## Summary

Expose VS Code's diagnostic (LSP) state to the AI agents ctrlyoke runs — not as a generic VS Code MCP bridge, but as a tight workflow integration: diagnostics as end-condition gates, `{diagnostics}` interpolation in retry prompts, and auto-injection into every harness MCP config with zero user setup.

---

## Recommendation: Build the ctrlyoke-native diagnostic integration — skip the generic LSP bridge

**TL;DR:** A generic "VS Code as MCP server" extension already exists in at least 10 community forms. Don't build the 11th. The unoccupied space — and ctrlyoke's real opportunity — is using live IDE diagnostics as a structured workflow gate. That problem is uniquely solvable from inside an extension host and has genuine 10–100× improvement potential over the current `tsc --noEmit` script approach.

---

## Research Findings

### The generic bridge problem is already crowded

| Project                                          | Tools                                                                | Stars               |
| ------------------------------------------------ | -------------------------------------------------------------------- | ------------------- |
| `vscode-mcp/vscode-mcp-server` (tjx666)          | getDiagnostics, getReferences, renameSymbol, executeCommand, 8 tools | 74                  |
| `acomagu/vscode-as-mcp-server`                   | executeCommand, code_checker, debug, text_editor                     | 114                 |
| `trademe/vscode-lsp-mcp`                         | workspace_symbols, document_symbols, find_symbol_locations           | 530 installs        |
| `beixiyo/CJL.lsp-mcp`                            | hover, definition, completions, references, rename                   | 530 installs        |
| `juehang/vscode-mcp-server`                      | file ops, symbols, diagnostics, shell                                | 349 stars           |
| `Oolab-labs/claude-ide-bridge`                   | ~140 tools across LSP, debugging, git, terminal                      | 33 stars            |
| `newbpydev/mcp-diagnostics-extension`            | getProblems, getProblemsForFile, real-time notifications             | 22 stars, 810 tests |
| Microsoft Semantic Workbench `mcp-server-vscode` | code_checker, focus_editor, symbol search                            | Official research   |

**VS Code itself** is MCP-client-only. Microsoft has not announced plans to expose IDE APIs outward as an MCP server.

### Claude Code's built-in IDE server (the key context)

Claude Code's VS Code extension ships a hidden `mcp__ide__getDiagnostics` tool that returns the Problems panel state. It works by binding to a local random port when the Claude CLI runs inside VS Code's integrated terminal.

**Critical limitation for ctrlyoke:** This connection does not exist when ctrlyoke runs Claude Code as a detached headless subprocess (which is how all harnesses work). The IDE server only activates for terminals Claude Code knows it launched. GitHub issues [#8635](https://github.com/anthropics/claude-code/issues/8635) and [#40766](https://github.com/anthropics/claude-code/issues/40766) confirm this is not fixable from the CLI side. Anthropic closed [#5495](https://github.com/anthropics/claude-code/issues/5495) (broader LSP APIs) as "not planned."

The same limitation applies to GitHub Copilot CLI's IDE integration — it's scoped to terminal sessions it owns.

### Gaps no existing solution solves

1. **Detached subprocess access.** ctrlyoke spawns CLI agents as automated background processes. No existing bridge auto-registers with ctrlyoke's per-harness MCP injection. Users must manually configure `~/.claude.json` or `.vscode/mcp.json` and the agent must be in a controlled terminal.

2. **Diagnostics as end-condition gates.** Every existing solution exposes diagnostics as a read-only AI tool call. None uses diagnostic state as a structured pass/fail gate that triggers a retry loop with the actual error list injected into the retry prompt.

3. **Cross-harness uniformity.** Each community extension targets one or two agents. ctrlyoke runs seven harnesses — a native integration would give all of them the same capability automatically.

4. **Millisecond diagnostic checks.** `vscode.languages.getDiagnostics()` is synchronous and returns in <1 ms. Cold `tsc --noEmit` takes 5–30 seconds. For tight retry loops, this is the difference between a workflow that feels instant and one that grinds.

---

## What to Build

### Phase 1: Diagnostic End-Condition Gate (high value, low complexity)

Add a new `kind: "diagnostics"` end-condition type that evaluates directly inside the extension host without any MCP or subprocess.

**Schema addition** (`schemas/workflow-schema.json`):

```yaml
endCondition:
  kind: diagnostics # new, alternative to kind: script
  scope: workspace # "workspace" | "openFiles" | "file"
  file: src/index.ts # only when scope: file
  maxErrors: 0
  maxWarnings: ~ # omit = no limit
  sources: [typescript, eslint] # omit = all sources
```

**Implementation touch points:**

- `src/types/CtrlYokeTypes.ts` — add `DiagnosticsEndCondition` to `EndCondition` union type
- `src/core/EndConditionEvaluator.ts` — add `evaluateDiagnostics()` that calls `vscode.languages.getDiagnostics()` (cannot run in child process since it needs the VS Code API; needs a new in-process evaluation path)
- `src/core/EndConditionHandler.ts` — route `kind: "diagnostics"` to new evaluator
- `src/platform/VsCodeAdapter.ts` — expose `getDiagnostics(scope, filter)` through `PlatformAdapter` so CLI adapter can stub it for tests

### Phase 2: `{diagnostics}` Retry Prompt Interpolation

When a diagnostics end-condition fails, automatically format and inject the diagnostic list into the retry prompt.

```yaml
endCondition:
  kind: diagnostics
  maxErrors: 0
  retryPrompt: |
    The following TypeScript errors still exist. Fix them:
    {diagnostics}
```

`{diagnostics}` expands to a formatted list:

```
src/foo.ts:12:4 error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/bar.ts:8:1 error TS2304: Cannot find name 'Foo'.
```

**Implementation:**

- `src/core/WorkflowExecutor.ts` — extend the retry prompt interpolation (currently handles `{stderr}`, `{stdout}`) to also resolve `{diagnostics}` when end-condition kind is `diagnostics`

### Phase 3: `ctrlyoke-ide` MCP Server (auto-injected)

A thin MCP server that exposes `getDiagnostics` to CLI harnesses running as detached processes. Unlike community extensions that require manual user configuration, this auto-registers via the existing `SettingsJsonMcpTracker` infrastructure.

**Architecture:**

```
Extension host (VsCodeAdapter)
    ↕ local named pipe or HTTP port (reuse pattern from mcp-server.ts)
ctrlyoke-ide MCP server (stdio binary, like ctrlyoke-mcp)
    ↕ MCP protocol
Claude Code / Copilot CLI / Codex (spawned by CliIntegration)
```

**Tools exposed:**

- `ctrlyoke_ide_get_diagnostics(scope?, file?, severity?)` — returns Problems panel state
- `ctrlyoke_ide_get_workspace_summary()` — file count, language breakdown, error/warning totals

**Auto-injection:** `SettingsJsonMcpTracker` already injects the `ctrlyoke` MCP server into each harness's config at launch. The `ctrlyoke-ide` server would be injected the same way — zero user setup required. Agents running under ctrlyoke automatically have access; agents running standalone don't see it.

**Scope note:** Skip `hover`, `findReferences`, `gotoDefinition`, `workspaceSymbols`, `executeCommand` — these have no workflow automation value and users who want them can install a community extension. Keep the surface to what drives the diagnostic gate loop.

### Phase 4: Diagnostic Snapshot in `_runtime` Blocks (deferred)

After each prompt step completes, capture and store the diagnostic snapshot in the working file's `_runtime` block:

```json
{
  "_runtime": {
    "completedAt": "2026-04-21T...",
    "diagnosticsSnapshot": {
      "errorCount": 3,
      "warningCount": 12,
      "errors": [{ "file": "src/foo.ts", "line": 12, "message": "..." }]
    }
  }
}
```

This enables the dashboard to show diagnostic trend across a workflow run and gives `OutputHistoryManager` richer data for replay.

---

## What to Skip

| Capability                                          | Why skip                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Generic VS Code command executor (`executeCommand`) | Security surface. No workflow automation value. Community tools cover it.              |
| Hover / go-to-definition / find-references          | No value for autonomous agent workflows. Community tools cover it.                     |
| Full LSP bridge (20+ tools)                         | Solved problem. Direct users to `vscode-mcp/vscode-mcp-server` or `CJL.lsp-mcp`.       |
| Workspace file system tools                         | Already covered by CLI harnesses' native file access and ctrlyoke's `ContextExpander`. |
| Debug session tools                                 | Out of scope for prompt workflow automation.                                           |

---

## Implementation Order

1. **Phase 1** — Diagnostic end-condition gate (pure in-process, no new binaries, highest leverage)
2. **Phase 2** — `{diagnostics}` interpolation (builds directly on Phase 1)
3. **Phase 3** — `ctrlyoke-ide` MCP stdio server (needed for harnesses to call diagnostics themselves during a step; Phases 1–2 cover the end-condition use case without it)
4. **Phase 4** — Diagnostic snapshots in `_runtime` (quality-of-life, deferred)

Phases 1 and 2 together deliver the core value proposition with no new executables, no new ports, and no user configuration. Phase 3 adds the ability for the AI itself to check diagnostic state mid-step, which is secondary to the end-condition gate.

---

## Effort Estimate

| Phase                             | Complexity  | New files                            | Key risk                                                                                                |
| --------------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1 — Diagnostic end-condition      | Medium      | 1 (DiagnosticsEndConditionEvaluator) | In-process evaluation bypasses child process isolation; need to handle `PlatformAdapter` stub for tests |
| 2 — `{diagnostics}` interpolation | Low         | 0                                    | Formatting long diagnostic lists into prompts                                                           |
| 3 — `ctrlyoke-ide` MCP server     | Medium-High | 2–3 (binary + IPC bridge)            | Named pipe lifecycle, auth token, server discovery by harnesses                                         |
| 4 — `_runtime` snapshots          | Low         | 0                                    | Working file schema churn                                                                               |

---

## Alternative: Point Users to Existing Extensions

If the team decides not to build this, the best existing recommendation for ctrlyoke users wanting IDE context in CLI agents is:

- **`vscode-mcp/vscode-mcp-server`** — best TypeScript quality, Unix socket IPC, actively maintained
- **`newbpydev/mcp-diagnostics-extension`** — diagnostics-only focus, 810 tests, very well-tested
- **`juehang/vscode-mcp-server`** — broadest tool set, 349 stars

Users would need to manually add these to `.vscode/mcp.json` and to each harness's MCP server list in ctrlyoke settings. This works but loses the zero-setup advantage and the end-condition integration.
