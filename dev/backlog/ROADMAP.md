# FlightPath Extension — Strategic Roadmap

**Last updated:** April 20, 2026  
**Current version:** 0.1.0 (pre-release)  
**Status:** Active development — no backward compatibility constraints

---

## Executive Summary

FlightPath is a VS Code extension that automates AI coding assistants (GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini) through structured YAML/JSON prompt workflows. The core engine is fully functional: multi-harness CLI/Chat execution, parallel workflow execution, per-prompt session management, dynamic queue extension, React webview dashboard with CodeMirror 6 editor, script-based end conditions, agent injection, a standalone CLI binary, stale-state recovery, an embedded terminal, and mobile-responsive layout are all working.

The project is pre-release. The primary remaining gap before v0.1.0 ships is the CHANGELOG, production build verification, macOS testing, and VS Code Marketplace publisher setup. A dedicated `dev/backlog/RELEASE_PLAN.md` tracks every step. The architecture is clean and SOLID-compliant, making new features straightforward to add.

---

## Current Version & Completed Milestones

### Core Engine (implemented)

- **Multi-harness execution**: Copilot CLI, Claude Code CLI, Codex CLI, OpenCode CLI, Qwen Code CLI, Gemini CLI, Copilot Chat UI automation
- **Composition-based CLI architecture**: Single `CliIntegration` class + `ICliProvider` interface; zero core changes needed to add new harnesses
- **Parallel workflow execution**: `WorkflowInstance` (self-contained execution unit) + `WorkflowOrchestrator` (multi-workflow registry); per-workflow pause/resume/cancel; configurable concurrency
- **Per-prompt session management**: Three-tier session ID resolution (prompt > workflow > global), session persistence across restarts
- **Dynamic queue extension**: Copilot can autonomously extend workflows by modifying `.flightpath.yaml`/`.flightpath.json` files at runtime
- **End condition evaluation**: Script-based validation with retry logic, timeout protection, and template variables
- **Workflow-level properties**: Three-tier precedence (prompt > workflow > global settings) for harness, model, agent, end conditions
- **Agent injection**: `AgentExpander.ts` reads agent file content and wraps in `<agentInstructions>` XML; supports workspace-relative, `.flightpath/`-relative, and absolute paths
- **Final prompt**: `finalStep` field on `PromptFile` runs once after all queue items complete
- **Multi-format support**: `.flightpath.yaml`, `.flightpath.json`, `.prompt.md` with unified JSON schema (AJV validation)
- **MCP server entrypoint**: `flightpath-mcp` binary for tool-based queue operations
- **Stale state recovery**: `WorkflowLockManager` with atomic writes, PID probing, 30s heartbeat, and `normalizeStaleLocks` on startup
- **Standalone CLI binary**: `src/cli.ts` with Commander (`run`, `validate` commands); `PlatformAdapter`/`CliAdapter`/`VsCodeAdapter`; `out/cli.js` esbuild target
- **Variable substitution**: `--var key=value` CLI flag; `{{varName}}` placeholders in workflow YAML; workflow-level `vars:` defaults; env var injection for end condition scripts
- **Custom CLI args**: `extraArgs?: string[]` on `PromptItem` and `PromptFile`; per-provider pass-through in `buildCommand()`
- **User-defined hooks**: `ExecutionProperties.hooks` for pre/post execution alongside agent/skills/mcpServers; headless mode support
- **Script steps**: `type: script` step runs a shell command inline in the workflow, with `onFail` behavior
- **Side-by-side diff**: Output diff view for comparing AI changes
- **Live context window**: Tracks token usage and context state during execution
- **Global settings**: Extension settings panel integrated into the dashboard

### UI & Developer Experience (shipped)

- **React 19 webview dashboard**: Zustand state, resizable panels, Tailwind CSS, full VS Code theme integration
- **Multi-workflow UI**: Tab/list switching between active workflows, per-workflow status, independent controls
- **CodeMirror 6 editor**: Replaced contenteditable (eliminates cursor jumping/blank line collapse bugs); Typo.js spell check, Ctrl+Click `#file:` navigation, undo/redo
- **IntelliSense completions**: `@file`, `#file:`, `#sym:` references with gitignore-aware file filtering; dynamic model completions from live Copilot API
- **Status bar integration**: Real-time execution state (Initializing → Ready → Running → Paused)
- **Output history**: `OutputHistoryManager`, run selector UI, persistent run history
- **Mobile-responsive layout**: Responsive breakpoints, overlay sidebar, drag-and-drop prompt reordering on mobile
- **Embedded/interactive terminal**: `PtyProcessManager` singleton; xterm.js display; `kind: 'ai-cli'` and `kind: 'shell'` sessions
- **Custom icons system**: SVG sources → auto-converted CSS; 7 harness-specific icons
- **DashboardBroadcastHub**: Fan-out hub decoupling orchestrator from webview and other sinks
- **Permission/Context quick pickers**: `PermissionsQuickPicker` and `ContextQuickPicker` footer controls
- **Undo/redo controls**: `UndoRedoControl` in editor with action logging and workflow properties sync
- **Drawer tab architecture**: `DrawerTabBar` in `EditorFooter`; per-tab state management; workflow properties panel

### CLI Infrastructure (shipped)

- **Per-provider log parsers**: `BaseLogParser`, `CopilotLogParser`, `ClaudeLogParser`, `CodexLogParser`
- **Universal CLI output format**: `UniversalCliOutput` + `CliOutputFormatter` for standardized response handling
- **Adaptive prompt passing**: Direct injection ≤300 chars, temp file for complex prompts
- **Two execution modes**: Interactive terminal (visible, Ctrl+C abort) and headless background

### Schema & Tooling (shipped)

- **Unified schema pipeline**: `prompt-schema.json` → auto-generated YAML schema → AJV runtime validation
- **Model sync workflow**: `sync-models.mjs` syncs `ModelConstants.ts` ↔ `package.json` ↔ `prompt-schema.json`
- **Build-time dev/prod split**: `IS_DEV_MODE` flag with esbuild dead code elimination strips dev commands from production

---

## Known Issues & Technical Debt

### Bugs / Broken Features

- **Chat mode model switch**: `workbench.action.chat.changeModel` occasionally fails silently — shows warning and continues with current model, which may not match the configured default.
- **Codex headless completion**: Detection via `{"type":"turn.completed"}` JSONL events is fragile; notify hook fallback behavior needs hardening.
- **Interactive hang on harness error**: If a CLI harness encounters an unrecoverable error while keeping the TUI open (e.g. Claude `StopFailure`), FlightPath waits for a Stop hook that never arrives. Fix is tracked in `ERROR_BEHAVIOR_PLAN.md` (Phase 2 — Claude `StopFailure` hook).

### Technical Debt

- **`WorkflowInstance.ts` and `WorkflowOrchestrator.ts` are large**: Further responsibility migration to the `orchestration/` subdirectory should continue over time.
- **Webview security — `style-src 'unsafe-inline'`**: Required by Tailwind CSS and CodeMirror — cannot be removed without migrating away from those libraries. Accepted risk, documented.
- **Webview security — message payload validation**: Incoming messages from the webview are not schema-validated. Low priority given single-user local deployment, but should be addressed before any multi-user scenario.
- **Test coverage gaps**: CLI/Chat integration tests are partial. End-to-end workflow tests require live AI responses (inherently manual). Unit test suite is solid but CLI output parsing needs more coverage.

---

## Tier 0 — v0.1.0 Release Blockers

_Must be completed before publishing to the VS Code Marketplace. See [`RELEASE_PLAN.md`](RELEASE_PLAN.md) for the full checklist with exact commands._

---

### 0.1 Populate the CHANGELOG

**Priority: CRITICAL** | **Effort: 2–4 hours**

`CHANGELOG.md` has only an `[Unreleased]` stub. VS Code Marketplace requires a populated CHANGELOG. Use "Current Version & Completed Milestones" above as source material.

---

### 0.2 Production Build Verification

**Priority: CRITICAL** | **Effort: 1–2 hours**

Run `npm run package`, install the VSIX locally via **Extensions: Install from VSIX**, and verify:

- Dashboard panel loads (React webview renders, not blank)
- New Workflow from Template works
- Run a simple `.prompt.md` file end-to-end in at least one harness
- Dev commands (DevMenu) are NOT visible in the command palette

---

### 0.3 macOS Testing

**Priority: CRITICAL** | **Effort: 2–4 hours**

FlightPath has only been developed and tested on Windows/WSL. macOS is the primary platform for VS Code users. Key risks: `node-pty` native binaries differ per architecture, Homebrew CLI paths may not be in `PATH`, `chokidar` uses FSEvents on macOS. Test on Apple Silicon (arm64) if possible.

---

### 0.4 Publisher Setup

**Priority: CRITICAL** | **Effort: 1 hour**

Create or verify the Azure DevOps publisher account (`nhickster`), generate a PAT, run `vsce login nhickster`, and verify `vsce ls` output shows the correct file inclusion/exclusion.

---

### 0.5 Marketplace Listing Polish

**Priority: RECOMMENDED** | **Effort: 2–3 hours**

- Update `package.json` description to mention all supported harnesses (current description undersells)
- Add `keywords` field: `["AI", "automation", "copilot", "claude", "codex", "workflow", "prompt", "agent", "LLM"]`
- Add `galleryBanner` (`"color": "#1e1e2e", "theme": "dark"`)
- Add screenshots or demo GIF to README — significantly increases Marketplace click-through rate
- Verify GitHub repo is public and README links resolve correctly

---

### 0.6 CLI npm Package

**Priority: CRITICAL** | **Effort: 2–3 hours**

The `flightpath` CLI (`out/cli.js`) ships separately from the VSIX. Decide on single vs. separate `package.json` structure, add `files` field, test with `npm pack --dry-run`, publish to npm.

---

## Prioritized Roadmap

### Tier 1 — Quick Wins

_Under 1 week each. High impact, low risk. Ship in the weeks immediately after v0.1.0._

---

#### 1.1 Completion Notifications

**Priority: HIGH** | **Effort: ~0.5 days** | **Doc: [`COMPLETION_NOTIFICATIONS_PLAN.md`](COMPLETION_NOTIFICATIONS_PLAN.md)**

Show a VS Code toast notification when a workflow finishes (success or failure). Add `flightpath.notifications.onComplete` setting (`always` / `errorsOnly` / `never`). A `NotificationManager` subscribes to `DashboardBroadcastHub` — the infrastructure already exists.

**Why it matters:** Workflows can take 5–30+ minutes in the background. Users have no signal when they finish without staring at the status bar. This is the highest-impact, lowest-effort feature on the list.

---

#### 1.2 Backtick Context Suppression

**Priority: HIGH** | **Effort: ~2 hours** | **Doc: [`BACKTICK_CONTEXT_SUPPRESSION_PLAN.md`](BACKTICK_CONTEXT_SUPPRESSION_PLAN.md)**

Teach `ContextExpander` to skip expanding `@path`, `#sym:`, `#selection:`, `#file:`, and `~git` references inside triple-backtick fenced blocks. One private `maskBacktickBlocks()` method added to `ContextExpander.ts` — no schema or type changes.

**Why it matters:** Users embedding literal output, log data, or debug prompts in fenced blocks currently get their content corrupted by context expansion. Fixes a real, reproducible bug with ~2 hours of effort.

---

#### 1.3 Raw Prompt Mode

**Priority: HIGH** | **Effort: 1–2 days** | **Doc: [`RAW_PROMPT_MODE_PLAN.md`](RAW_PROMPT_MODE_PLAN.md)**

New `rawPromptMode: true` execution property that bypasses the entire context expansion and categorized temp file pipeline. The prompt is sent verbatim — no `@path` expansion, no agent/skills injection, no prior context wrapping.

**Why it matters:** Users who manage their own context references, or who are debugging FlightPath sessions (where the debug prompt contains raw FlightPath instruction strings), need a clean passthrough. Also a trust signal for skeptical users.

**Dependencies:** Implement backtick suppression (1.2) first — it covers the inline/per-block case; raw mode is the workflow-level bypass.

---

#### 1.4 Workflow Favorites

**Priority: MEDIUM** | **Effort: ~0.5 days** | **Doc: [`WORKFLOW_FAVORITES_PLAN.md`](WORKFLOW_FAVORITES_PLAN.md)**

Star button on each workflow row in the Workflows dropdown. Favorites sort to the top and persist as `isFavorite` in the working file. No new storage layer — `WorkflowSerializer` already reads every working file for the recent workflows list.

---

#### 1.5 Script Field Completions

**Priority: MEDIUM** | **Effort: 2–3 days** | **Doc: [`SCRIPT_FIELD_COMPLETIONS_PLAN.md`](SCRIPT_FIELD_COMPLETIONS_PLAN.md)**

Replace the plain `<input>` in `ScriptConditionEditor` with a single-line CodeMirror component that suggests workspace npm scripts (from `package.json`) and common shell commands (npm, git, pwsh, bash, etc.). CodeMirror is already in the webview bundle.

---

#### 1.6 Dry Run / Preview

**Priority: MEDIUM** | **Effort: 2–3 days** | **Doc: [`DRY_RUN_PREVIEW_PLAN.md`](DRY_RUN_PREVIEW_PLAN.md)**

A **Preview** button on each prompt card in the dashboard shows the fully resolved CLI command, prompt text, and temp file content for that step — without executing. Also exposes `flightpath run --dry-run` on the CLI.

**Why it matters:** Currently users must run a workflow and dig through logs to understand what was actually sent to the AI. Preview mode makes prompt debugging immediate and transparent.

---

#### 1.7 SCM Commit Message Button

**Priority: MEDIUM** | **Effort: 1–2 days** | **Doc: [`SCM_COMMIT_MESSAGE_BUTTON.md`](SCM_COMMIT_MESSAGE_BUTTON.md)**

Add a FlightPath button to the VS Code Source Control panel that generates a commit message using the staged diff and the active harness. Zero new workflow concepts — just a single-prompt trigger from SCM context.

---

#### 1.8 BMAD Workflow Templates

**Priority: MEDIUM** | **Effort: 2–3 days** | **Doc: [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)**

BMAD (Breakthrough Method of Agile AI-Driven Development) maps directly onto FlightPath's workflow model. Add self-contained agent prompt files (`analyst`, `pm`, `architect`, `developer`, `qa`) and workflow templates (Quick Flow, Full Method, Brownfield). Zero core changes — purely new template content.

**Why it matters:** Opinionated "best practice" multi-agent workflow out of the box. Demonstrates the full power of multi-step orchestration to new users. High discoverability in README and marketplace listing.

---

### Tier 2 — High-Value Features

_1–4 weeks each. Core product improvements that significantly expand utility._

---

#### 2.1 Error Behavior

**Priority: HIGH** | **Effort: ~3.5 days** | **Doc: [`ERROR_BEHAVIOR_PLAN.md`](ERROR_BEHAVIOR_PLAN.md)**

New `errorBehavior` execution property controlling what happens when a harness itself fails (rate limits, crashes, server timeouts):

- `onError: stop` — current behavior (default)
- `onError: retry` — re-run the same step after a delay, up to `maxRetries`
- `onError: continue` — log the error and advance to the next step

Also fixes two active bugs: the Claude `StopFailure` hook (interactive hang when TUI stays open on error) and the missing Copilot `errorOccurred` hook. The Claude fix can ship independently as Phase 2 of the plan before the full schema work.

**Why it matters:** Rate limits and transient server errors kill long-running workflows that would otherwise succeed on retry. The interactive hang bug is actively broken — users see error text in the TUI with FlightPath stuck waiting forever.

---

#### 2.2 Telemetry

**Priority: HIGH** | **Effort: 1–2 days** | **Doc: [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md)**

Opt-in anonymous usage telemetry via `@vscode/extension-telemetry` (Azure Application Insights). Automatically respects VS Code `telemetry.telemetryLevel`. Track: harness used, step counts, durations, workflow outcomes, error types. Never prompt text, file paths, or user-generated strings.

**Why it matters:** Post-release, building without usage data is slow. Knowing which harnesses users actually use, where workflows fail, and what features are adopted directly drives roadmap prioritization. Ship shortly after v0.1.0.

---

#### 2.3 Template Setup Scripts

**Priority: HIGH** | **Effort: 1–2 weeks** | **Doc: [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md)**

Templates currently require manual `{placeholder}` replacement. Setup scripts run automatically when a template is instantiated, auto-populating variables by inspecting the repository (directory structure, detected framework, repo name). Extends `WorkflowTemplate` type with `setupScript?: string`.

**Why it matters:** Closes the gap between "I imported a template" and "this workflow is ready to run on my codebase." Makes FlightPath feel intelligent rather than generic.

---

#### 2.4 AGENTS.md Generation & Injection

**Priority: HIGH** | **Effort: 1–2 weeks** | **Doc: [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md)**

Two subsystems:

- **`AgentsFileResolver`**: Walk parent directories to find `AGENTS.md` files and inject discovered content as `<projectInstructions>` XML into CLI prompts (same discovery pattern as CLAUDE.md/GEMINI.md)
- **`GenerateAgentsWorkflow` command**: Multi-prompt workflow template that analyzes the directory tree and generates a comprehensive `AGENTS.md`, validated by an end condition script

**Why it matters:** AGENTS.md is becoming the standard project context file for AI coding assistants (GitHub, Anthropic, Google all support it). FlightPath should be the tool that generates and leverages these files.

**Dependencies:** Template setup scripts (2.3) makes the generation workflow more robust.

---

#### 2.5 Improved End Condition DX

**Priority: MEDIUM** | **Effort: 3–5 days**

End conditions are powerful but steep to learn:

- **Common built-in end conditions** (no script required): `tests-pass`, `file-exists`, `no-typescript-errors`, `git-clean`
- **`endCondition: "tests-pass"` shorthand syntax**: Resolve named conditions to built-in scripts
- **Inline end condition preview**: Show last script output in the dashboard prompt card
- **End condition sandbox**: Run a script manually against the current workspace state from the dashboard

**Dependencies:** None — additive changes to `EndConditionEvaluator`.

---

#### 2.6 Inline Prior Context

**Priority: MEDIUM** | **Effort: 1–2 weeks** | **Doc: [`INLINE_PRIOR_CONTEXT_PLAN.md`](INLINE_PRIOR_CONTEXT_PLAN.md)**

Pass AI output from a previous step as injected context into subsequent steps without requiring `resumeSession`. Enables structured multi-step chains where each step builds on the last without sharing a full conversation session.

---

#### 2.7 Dropdown Validation Styling

**Priority: LOW** | **Effort: 1–3 days** | **Doc: [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](DROPDOWN_VALIDATION_STYLING_PLAN.md)**

Visual validation state (error/warning indicators) for dropdown and multi-checkbox controls in the workflow properties panel. Improves discoverability of misconfigured workflows before running.

---

#### 2.8 Documentation Site + Landing Page

**Priority: HIGH** | **Effort: 1–2 weeks** | **Doc: [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md)**

VitePress site in `docs-site/` with:

- Marketing homepage (hero section, feature highlights, harness logos, demo GIF)
- Getting Started guide
- Workflow Reference (schema auto-generated from `prompt-schema.json`)
- Harness Configuration, CLI Reference, MCP Reference
- Tutorials
- Deployed to GitHub Pages via GitHub Actions on push to main

**Why it matters:** A public docs site and landing page lowers onboarding friction and supports marketplace discoverability. Users searching for "Copilot workflow automation" need a page to land on before installing. The homepage is the extension's primary first impression outside the VS Code Marketplace.

**Dependencies:** Stable v0.1.0 user-facing API should be in place first.

---

### Tier 3 — Strategic Investments

_1–2 months each. Architectural changes or significant new capabilities._

---

#### 3.1 Parallel Steps

**Priority: MEDIUM** | **Effort: 2–4 weeks** | **Doc: [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md)**

Run multiple prompt steps in parallel within a single workflow. Extends the existing parallel workflow (multi-workflow) model down to the step level. Requires careful orchestration of shared session state and output buffering.

---

#### 3.2 Workflow Step Composition

**Priority: MEDIUM** | **Effort: 2–4 weeks** | **Doc: [`WORKFLOW_STEP_PLAN.md`](WORKFLOW_STEP_PLAN.md)**

A new step type (`type: workflow`) that invokes another workflow file as a sub-step, enabling reusable, composable workflow building blocks.

---

#### 3.3 MCP Server Hardening

**Priority: MEDIUM** | **Effort: 2–3 weeks**

The `flightpath-mcp` binary exists but MCP tool coverage may be incomplete. Harden the MCP interface to turn FlightPath into a platform other AI assistants can drive directly:

- Complete tool surface: `queue_workflow`, `get_status`, `pause`, `resume`, `cancel`, `get_output`, `list_runs`
- Token-based authentication
- MCP tool schema validation against `prompt-schema.json`
- Integration tests and usage guide for Claude Desktop, Cursor, and other MCP clients

---

#### 3.4 Cline Integration

**Priority: LOW** | **Effort: 1–2 weeks** | **Doc: [`CLINE_INTEGRATION_PLAN.md`](CLINE_INTEGRATION_PLAN.md)**

Add `cline-cli` harness. Expands FlightPath's coverage to the popular open-source Cline agent. Follows the established `ICliProvider` composition pattern — no core changes.

---

#### 3.5 VS Code LM API Features

**Priority: LOW** | **Effort: unknown** | **Doc: [`VSCODE_LM_API_FEATURES.md`](VSCODE_LM_API_FEATURES.md)**

Leverage VS Code's Language Model API for tighter GitHub Copilot integration beyond the current CLI harness. Potential: in-process model invocations, faster completions, richer tool call support.

---

#### 3.6 Terminal Follow-up Tracking

**Priority: LOW** | **Effort: unknown** | **Doc: [`TERMINAL_FOLLOWUP_TRACKING_PLAN.md`](TERMINAL_FOLLOWUP_TRACKING_PLAN.md)**

Detect and record when users type follow-up commands or additional prompts in the embedded terminal after a workflow step completes, enabling richer context for subsequent steps.

---

#### 3.7 Inline Suggestions

**Priority: LOW** | **Effort: unknown** | **Doc: [`INLINE_SUGGESTIONS_PLAN.md`](INLINE_SUGGESTIONS_PLAN.md)**

Surface AI-generated inline suggestions in the editor, driven by FlightPath workflow outputs — a tighter loop between workflow execution and code editing.

---

#### 3.8 Additional Instructions

**Priority: LOW** | **Effort: unknown** | **Doc: [`ADDITIONAL_INSTRUCTIONS_PLAN.md`](ADDITIONAL_INSTRUCTIONS_PLAN.md)**

Global or workspace-level instruction text injected into every prompt, independent of agent files. A lightweight alternative to agent injection for cross-cutting instructions.

---

#### 3.9 E2E Testing via MCP

**Priority: LOW** | **Effort: 2–3 weeks** | **Doc: [`VSCODE_TESTING_E2E_MCP.md`](VSCODE_TESTING_E2E_MCP.md)**

End-to-end integration test harness using the MCP server as an automation entry point, allowing scripted workflow execution and assertion without manual UI interaction.

---

### Tier 4 — Future Vision

_Longer-term or requiring external decisions before implementation._

---

#### 4.1 AI-Powered Workflow Generation

**Priority: SPECULATIVE** | **Effort: 2–4 weeks**

`FlightPath: Generate Workflow from Description` command — natural language description → `.flightpath.yaml` with appropriate prompts, end conditions, and agent assignments. Schema-validated before saving.

**Dependencies:** AGENTS.md generation (2.4), template setup scripts (2.3), stable schema.

---

#### 4.2 Premium Licensing (Pro Tier)

**Priority: LOW (business decision needed)** | **Effort: 3–4 weeks**

Gate power features behind a Pro subscription to fund continued development. Dynamic queue extension and unlimited parallel workflows are natural Pro candidates. `LicenseManager.ts` + LemonSqueezy API + `vscode.SecretStorage`.

**Considerations:** Decide free vs. open-source model before engineering. Requires stable v0.1.0 in users' hands first so gating decisions are based on real usage data.

**Dependencies:** Stable v0.1.0 shipped. Parallel workflows and MCP hardening (3.1, 3.3) are the most natural Pro features.

---

#### 4.3 VS Code Marketplace Featured Listing

**Priority: PREREQUISITE FOR GROWTH** | **Effort: 1 week prep**

Getting listed on the VS Code Marketplace is the primary distribution channel. Requires completing all Tier 0 items.

Pre-conditions:
- PNG icon ✅ (already done)
- `.vscodeignore` ✅ (already done)
- CHANGELOG populated (from 0.1)
- Passing `npm run lint` and `npm test`
- Published GitHub repository with README

Actions:
- `vsce login nhickster`
- `vsce publish`
- Open VSX Registry publish (`ovsx publish`) for VSCodium users
- Request VS Code Marketplace featured listing via GitHub issue on `microsoft/vscode-discussions`

---

## Dependency Graph

```
Tier 0 (Release Blockers)
  └─► 4.3 Marketplace Listing

1.2 Backtick Context Suppression
  └─► 1.3 Raw Prompt Mode (backtick covers inline case; raw mode covers workflow-level bypass)

2.1 Error Behavior Phase 2 (Claude StopFailure fix)
  → ships independently as a bug fix, before full schema work

1.8 BMAD Templates
  └─► 2.4 AGENTS.md Generation (agent personas improve generation quality)

2.3 Template Setup Scripts
  └─► 2.4 AGENTS.md Generation (generation workflow uses setup scripts)

2.8 Documentation Site
  └─► 4.3 Marketplace Listing

4.1 AI Workflow Generation
  └── depends on: 2.3 + 2.4 + stable schema

4.2 Premium Licensing
  └── depends on stable v0.1.0 + real usage data (telemetry from 2.2)
```

---

## Estimated Timeline

| Milestone | Items | Target |
|---|---|---|
| **v0.1.0 Release** | Tier 0 blockers | May 2026 |
| **v0.1.x Rapid UX** | 1.1 (notifications), 1.2 (backtick), 1.3 (raw mode), 1.4 (favorites) | May–June 2026 |
| **v0.2.0 Polish & DX** | 1.5–1.8, 2.1 (error behavior), 2.2 (telemetry) | June–July 2026 |
| **v0.3.0 Project Context** | 2.3 + 2.4 + 2.5 + 2.8 (docs site) | August 2026 |
| **v0.4.0 Power Features** | 2.6 + 3.1 + 3.2 + 3.3 | October 2026 |
| **v0.5.0 Platform & Pro** | 4.1 + 4.2 + 4.3 | Dec 2026 |

_Timeline is aspirational. Pre-release — prioritize quality over schedule._

---

## Research Documents Index

> **Convention:** Plans move to `dev/implemented/` when done. This index lists active/backlog items only — see `dev/implemented/` for the full archive.

### Active (in progress)

| Document | Status | Roadmap Item |
|---|---|---|
| [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md) | 🔄 ACTIVE | 2.8 |
| [`../active/AUTOMATION_API_PLAN.md`](../active/AUTOMATION_API_PLAN.md) | 🔄 ACTIVE | — |

### Backlog (not yet started)

| Document | Status | Roadmap Item |
|---|---|---|
| [`RELEASE_PLAN.md`](RELEASE_PLAN.md) | 🔄 IN_PROGRESS | Tier 0 |
| [`COMPLETION_NOTIFICATIONS_PLAN.md`](COMPLETION_NOTIFICATIONS_PLAN.md) | NOT_IMPLEMENTED | 1.1 |
| [`BACKTICK_CONTEXT_SUPPRESSION_PLAN.md`](BACKTICK_CONTEXT_SUPPRESSION_PLAN.md) | NOT_IMPLEMENTED | 1.2 |
| [`RAW_PROMPT_MODE_PLAN.md`](RAW_PROMPT_MODE_PLAN.md) | NOT_IMPLEMENTED | 1.3 |
| [`WORKFLOW_FAVORITES_PLAN.md`](WORKFLOW_FAVORITES_PLAN.md) | NOT_IMPLEMENTED | 1.4 |
| [`SCRIPT_FIELD_COMPLETIONS_PLAN.md`](SCRIPT_FIELD_COMPLETIONS_PLAN.md) | NOT_IMPLEMENTED | 1.5 |
| [`DRY_RUN_PREVIEW_PLAN.md`](DRY_RUN_PREVIEW_PLAN.md) | NOT_IMPLEMENTED | 1.6 |
| [`SCM_COMMIT_MESSAGE_BUTTON.md`](SCM_COMMIT_MESSAGE_BUTTON.md) | NOT_IMPLEMENTED | 1.7 |
| [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md) | NOT_IMPLEMENTED | 1.8 |
| [`ERROR_BEHAVIOR_PLAN.md`](ERROR_BEHAVIOR_PLAN.md) | NOT_IMPLEMENTED | 2.1 |
| [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md) | NOT_IMPLEMENTED | 2.2 |
| [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md) | NOT_IMPLEMENTED | 2.3 |
| [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md) | NOT_IMPLEMENTED | 2.4 |
| [`INLINE_PRIOR_CONTEXT_PLAN.md`](INLINE_PRIOR_CONTEXT_PLAN.md) | NOT_IMPLEMENTED | 2.6 |
| [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](DROPDOWN_VALIDATION_STYLING_PLAN.md) | NOT_IMPLEMENTED | 2.7 |
| [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md) | NOT_IMPLEMENTED | 3.1 |
| [`WORKFLOW_STEP_PLAN.md`](WORKFLOW_STEP_PLAN.md) | NOT_IMPLEMENTED | 3.2 |
| [`CLINE_INTEGRATION_PLAN.md`](CLINE_INTEGRATION_PLAN.md) | NOT_IMPLEMENTED | 3.4 |
| [`VSCODE_LM_API_FEATURES.md`](VSCODE_LM_API_FEATURES.md) | NOT_IMPLEMENTED | 3.5 |
| [`TERMINAL_FOLLOWUP_TRACKING_PLAN.md`](TERMINAL_FOLLOWUP_TRACKING_PLAN.md) | NOT_IMPLEMENTED | 3.6 |
| [`INLINE_SUGGESTIONS_PLAN.md`](INLINE_SUGGESTIONS_PLAN.md) | NOT_IMPLEMENTED | 3.7 |
| [`ADDITIONAL_INSTRUCTIONS_PLAN.md`](ADDITIONAL_INSTRUCTIONS_PLAN.md) | NOT_IMPLEMENTED | 3.8 |
| [`VSCODE_TESTING_E2E_MCP.md`](VSCODE_TESTING_E2E_MCP.md) | NOT_IMPLEMENTED | 3.9 |
