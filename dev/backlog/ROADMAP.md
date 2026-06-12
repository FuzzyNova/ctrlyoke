# FlightPath Extension — Strategic Roadmap

**Last updated:** June 12, 2026  
**Current version:** 0.1.0 (unreleased — preparing the first VS Code Marketplace publish)  
**Status:** Pre-release — no backward compatibility constraints

---

## Executive Summary

FlightPath is a VS Code extension that automates AI coding assistants (GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini) through structured YAML/JSON prompt workflows. The core engine is fully functional: multi-harness CLI/Chat execution, parallel workflow execution, per-prompt session management, dynamic queue extension, React webview dashboard with CodeMirror 6 editor, script-based end conditions, agent injection, a standalone CLI binary, stale-state recovery, an embedded terminal, and mobile-responsive layout are all working.

**FlightPath has not shipped yet.** The engine is feature-complete and a large number of post-MVP features are already implemented in the codebase — completion notifications (1.1), backtick context suppression (1.2), workflow favorites (1.4), SCM commit message button (1.7), inline prior context (2.6), pre-conditions, and the full error-behavior subsystem (2.1) — but nothing has been published to the VS Code Marketplace or npm. The architecture is clean and SOLID-compliant, making new features straightforward to add.

**Recommended next focus — the launch path.** The remaining work before a public launch is no longer core features; it is the go-to-market layer:

1. **Landing page + docs site** at `flightpath.dev` ([`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md), [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md))
2. **Pro licensing / monetization model** — now split into its own plan ([`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)) because the long-term licensing model (license key vs. user accounts) is a strategic decision that should be settled before launch, not after.
3. **Marketplace publish mechanics** — the Tier 0 checklist below (publisher setup, production VSIX verification, CHANGELOG, listing polish, npm package).

See [Tier 0](#tier-0--launch-blockers) for the remaining ship blockers.

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
- **Side-by-side diff**: Output diff view for comparing AI changes (responsive split/unified)
- **Live context window**: Tracks token usage and context state during execution
- **Global settings**: Extension settings panel integrated into the dashboard
- **Inline prior context (2.6)**: `$previous`, `$all`, `$step:N` prior-context references injected into subsequent steps without requiring `resumeSession`
- **Completion notifications (1.1)**: VS Code toast on workflow complete/error; `flightpath.notifications.onComplete` setting
- **Backtick context suppression (1.2)**: Context expansion skips `@path`, `#sym:`, etc. inside triple-backtick fenced blocks
- **Workflow favorites (1.4)**: Star button persists `isFavorite` in working file; favorites sort to the top of the workflow list
- **SCM commit message button (1.7)**: VS Code Source Control panel button generates a commit message via staged diff and active harness
- **Error behavior (2.1)**: `errorBehavior` execution property (`stop`/`retry`/`continue`) for harness/session failures; structured `FailureKind` classification; Claude `StopFailure`, Copilot `errorOccurred`, and OpenCode `session.error` interactive error hooks; fixes the interactive-hang bug and the process-exit-routed-to-cancel bug
- **Pre-conditions**: Script-based `preCondition` gate that must pass before a step runs, mirroring the end-condition mechanism
- **MCP registry manager**: Central MCP server management UI with user/workspace merge and registry pagination
- **Output virtualization**: Virtual row rendering for large outputs via `@tanstack/react-virtual`
- **Output history search**: Dedicated history search modal with in-output find bar integration
- **Markdown export**: Customizable workflow output export with command inclusion, metadata, and step range options

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
- **~~Interactive hang on harness error~~ ✅ FIXED**: Resolved by the error-behavior work (2.1). Claude `StopFailure`, Copilot `errorOccurred`, and OpenCode `session.error` now write `{sessionId}-error.json`, and process exit/timeout route through `errorBehavior` instead of hanging. Codex/Qwen/Gemini still rely on process-exit/timeout fallback (no verified session-level error hook yet).

### Technical Debt

- **`WorkflowInstance.ts` and `WorkflowOrchestrator.ts` are large**: Further responsibility migration to the `orchestration/` subdirectory should continue over time.
- **Webview security — `style-src 'unsafe-inline'`**: Required by Tailwind CSS and CodeMirror — cannot be removed without migrating away from those libraries. Accepted risk, documented.
- **Webview security — message payload validation**: Incoming messages from the webview are not schema-validated. Low priority given single-user local deployment, but should be addressed before any multi-user scenario.
- **Test coverage gaps**: CLI/Chat integration tests are partial. End-to-end workflow tests require live AI responses (inherently manual). Unit test suite is solid but CLI output parsing needs more coverage.

---

## Tier 0 — Launch Blockers

_FlightPath has **not** been published yet. This section is the remaining path to the first public release. The engineering MVP is done; the open work is the go-to-market layer (landing page, licensing model) plus the mechanical publish checklist. Prior drafts of this roadmap incorrectly marked these "shipped" — treat every item below as **needs verification before publish**, since the publish was never actually executed. See [`RELEASE_PLAN.md`](RELEASE_PLAN.md) for the full checklist._

**The two strategic blockers (do these first):**

- **0.A — Landing page + docs site** ([`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md), [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md)): `flightpath.dev` marketing page, published VitePress docs, pricing page. The homepage is the extension's primary first impression outside the Marketplace.
- **0.B — Pro licensing model** ([`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)): Decide and implement the monetization model. **This was previously folded into the landing-page plan and has now been split out** because the choice between a simple pasted license key and a full user-account/sign-in model is a long-term architectural decision that affects the extension, the website, and the backend. It must be settled before launch so the free/Pro gating ships in v0.1.0.

**The mechanical publish checklist (do after the strategic blockers):**

---

### 0.1 Populate the CHANGELOG

**Status: NEEDS VERIFICATION**

`CHANGELOG.md` must be populated before the Marketplace publish. Use "Current Version & Completed Milestones" above as source material.

---

### 0.2 Production Build Verification

**Status: NEEDS VERIFICATION**

Run `npm run package`, install the VSIX locally via **Extensions: Install from VSIX**, and verify:

- Dashboard panel loads (React webview renders, not blank)
- New Workflow from Template works
- Run a simple `.prompt.md` file end-to-end in at least one harness
- Dev commands (DevMenu) are NOT visible in the command palette
- Pro-gated features behave correctly in the unlicensed (free) state — see [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)

---

### 0.3 macOS Testing

**Status: NEEDS VERIFICATION**

FlightPath has primarily been developed and tested on Windows. macOS is the primary platform for VS Code users. Key risks: `node-pty` native binaries differ per architecture, Homebrew CLI paths may not be in `PATH`, `chokidar` uses FSEvents on macOS. Test on Apple Silicon (arm64) if possible.

---

### 0.4 Publisher Setup & Publish

**Status: NOT DONE — this is the actual ship gate**

Create or verify the Azure DevOps publisher account (`nhickster`), generate a PAT, run `vsce login nhickster`, verify `vsce ls` output shows the correct file inclusion/exclusion, then `vsce publish` (and `ovsx publish` for Open VSX).

---

### 0.5 Marketplace Listing Polish

**Status: NEEDS VERIFICATION**

- Update `package.json` description to mention all supported harnesses (current description undersells)
- Add `keywords` field: `["AI", "automation", "copilot", "claude", "codex", "workflow", "prompt", "agent", "LLM"]`
- Add `galleryBanner` (`"color": "#1e1e2e", "theme": "dark"`)
- Add screenshots or demo GIF to README — significantly increases Marketplace click-through rate
- Verify GitHub repo is public and README links resolve correctly

---

### 0.6 CLI npm Package

**Status: NEEDS VERIFICATION**

The `flightpath` CLI (`out/cli.js`) ships separately from the VSIX. Decide on single vs. separate `package.json` structure, add `files` field, test with `npm pack --dry-run`, publish to npm.

---

## Prioritized Roadmap

### Tier 1 — Quick Wins

_Under 1 week each. High impact, low risk. Ship in the weeks immediately after v0.1.0._

---

#### 1.1 Completion Notifications ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/COMPLETION_NOTIFICATIONS_PLAN.md)

---

#### 1.2 Backtick Context Suppression ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/BACKTICK_CONTEXT_SUPPRESSION_PLAN.md)

---

#### 1.3 Raw Prompt Mode

**Priority: HIGH** | **Effort: 1–2 days** | **Doc: [`RAW_PROMPT_MODE_PLAN.md`](RAW_PROMPT_MODE_PLAN.md)**

New `rawPromptMode: true` execution property that bypasses the entire context expansion and categorized temp file pipeline. The prompt is sent verbatim — no `@path` expansion, no agent/skills injection, no prior context wrapping.

**Why it matters:** Users who manage their own context references, or who are debugging FlightPath sessions (where the debug prompt contains raw FlightPath instruction strings), need a clean passthrough. Also a trust signal for skeptical users.

**Dependencies:** ✅ Backtick suppression (1.2) is done — 1.3 is ready to implement now.

---

#### 1.4 Workflow Favorites ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/WORKFLOW_FAVORITES_PLAN.md)

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

#### 1.7 SCM Commit Message Button ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/SCM_COMMIT_MESSAGE_BUTTON.md)

---

#### 1.8 BMAD Workflow Templates

**Priority: MEDIUM** | **Effort: 2–3 days** | **Doc: [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)**

BMAD (Breakthrough Method of Agile AI-Driven Development) maps directly onto FlightPath's workflow model. Add self-contained agent prompt files (`analyst`, `pm`, `architect`, `developer`, `qa`) and workflow templates (Quick Flow, Full Method, Brownfield). Zero core changes — purely new template content.

**Why it matters:** Opinionated "best practice" multi-agent workflow out of the box. Demonstrates the full power of multi-step orchestration to new users. High discoverability in README and marketplace listing.

---

### Tier 2 — High-Value Features

_1–4 weeks each. Core product improvements that significantly expand utility._

---

#### 2.1 Error Behavior ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/ERROR_BEHAVIOR_PLAN.md)

All five phases are complete: the `errorBehavior` execution property (`stop`/`retry`/`continue`), structured `FailureKind` classification, Claude `StopFailure` / Copilot `errorOccurred` / OpenCode `session.error` interactive error hooks, `WorkflowExecutor` routing, and the prompt/workflow/default UI. This also fixed the interactive-hang bug and the process-exit-routed-to-cancel bug. Codex/Qwen/Gemini remain on the process-exit/timeout fallback (no verified session-level error hook yet).

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

#### 2.6 Inline Prior Context ✅ IMPLEMENTED (unreleased)

**Status: DONE** | [Plan moved to `dev/implemented/`](../implemented/INLINE_PRIOR_CONTEXT_PLAN.md)

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

#### 4.2 Premium Licensing (Pro Tier) — see [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)

**Priority: LAUNCH BLOCKER (0.B)** | **Effort: see plan**

> **Reclassified.** This was a Tier 4 "someday" item, but the first paid tier and its gating must ship **with** v0.1.0 so the free/Pro boundary is set from day one. The full design — tier structure, licensing-model decision (pasted license key vs. user accounts/sign-in), offline entitlement verification, provider choice, and the extension `LicenseService` — now lives in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md). The original Pro-licensing content has been moved out of [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md) into that plan.

Later, usage-data-driven tier tuning and a possible subscription "Pro+" / Teams tier follow telemetry (2.2) and real adoption data.

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
LAUNCH (not yet shipped) — gated on:
  0.A Landing Page + Docs ─┐
  0.B Pro Licensing ───────┼─► Tier 0 publish checklist ─► 4.3 Marketplace Listing
  Tier 0 publish mechanics ┘

0.B Pro Licensing (PRO_LICENSE_PLAN.md)
  ├── needs: licensing-model decision (license key vs. user accounts)
  └── consumes: 2.8 / 0.A Landing Page (pricing page + checkout)

1.2 Backtick Context Suppression ✅ DONE
  └─► 1.3 Raw Prompt Mode (ready to implement)

2.1 Error Behavior ✅ DONE

1.8 BMAD Templates
  └─► 2.4 AGENTS.md Generation (agent personas improve generation quality)

2.3 Template Setup Scripts
  └─► 2.4 AGENTS.md Generation (generation workflow uses setup scripts)

2.8 Documentation Site
  └─► 4.3 Marketplace Listing

4.1 AI Workflow Generation
  └── depends on: 2.3 + 2.4 + stable schema

4.2 Premium Licensing (Pro tier)
  └── now tracked in PRO_LICENSE_PLAN.md; pricing/gating ships at launch,
      usage-data-driven tier tuning follows telemetry (2.2)
```

---

## Estimated Timeline

| Milestone                  | Items                                                                  | Target          |
| -------------------------- | ---------------------------------------------------------------------- | --------------- |
| **Engine MVP** ✅          | Core engine + 1.1, 1.2, 1.4, 1.7, 2.1, 2.6, pre-conditions (all built) | Done            |
| **v0.1.0 Launch**          | 0.A landing page, 0.B Pro licensing, Tier 0 publish checklist          | Next up         |
| **v0.1.x Rapid UX**        | 1.3 (ready), 1.5, 1.6                                                   | After launch    |
| **v0.2.0 Polish & DX**     | 1.8, 2.2 (telemetry), 2.5                                              | Following       |
| **v0.3.0 Project Context** | 2.3 + 2.4 + 2.8 (docs site expansion)                                  | Later           |
| **v0.4.0 Power Features**  | 3.1 + 3.2 + 3.3                                                        | Later           |
| **v0.5.0 Platform & Pro+** | 4.1 + 4.2 (Pro+ tiers) + 4.3                                           | Later           |

_Dates removed: the prior timeline asserted a May 12, 2026 release that never happened. Pre-release — prioritize quality and the launch blockers over a schedule._

---

## Research Documents Index

> **Convention:** Plans move to `dev/implemented/` when done. This index lists active/backlog items only — see `dev/implemented/` for the full archive.

### Active (in progress)

| Document                                                                               | Status    | Roadmap Item |
| -------------------------------------------------------------------------------------- | --------- | ------------ |
| [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md) | 🔄 ACTIVE | 2.8          |
| [`../active/AUTOMATION_API_PLAN.md`](../active/AUTOMATION_API_PLAN.md)                 | 🔄 ACTIVE | —            |

### Launch Blockers (must land before publish)

| Document                                            | Status      | Roadmap Item |
| --------------------------------------------------- | ----------- | ------------ |
| [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md)     | 📝 PLANNING | 0.A / 2.8    |
| [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)       | 📝 PLANNING | 0.B / 4.2    |
| [`RELEASE_PLAN.md`](RELEASE_PLAN.md)               | 🔄 PARTIAL  | Tier 0       |

### Backlog (not yet started)

| Document                                                                     | Status          | Roadmap Item |
| ---------------------------------------------------------------------------- | --------------- | ------------ |
| [`RAW_PROMPT_MODE_PLAN.md`](RAW_PROMPT_MODE_PLAN.md)                         | NOT_IMPLEMENTED | 1.3          |
| [`SCRIPT_FIELD_COMPLETIONS_PLAN.md`](SCRIPT_FIELD_COMPLETIONS_PLAN.md)       | NOT_IMPLEMENTED | 1.5          |
| [`DRY_RUN_PREVIEW_PLAN.md`](DRY_RUN_PREVIEW_PLAN.md)                         | NOT_IMPLEMENTED | 1.6          |
| [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)                           | NOT_IMPLEMENTED | 1.8          |
| [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md)                                     | NOT_IMPLEMENTED | 2.2          |
| [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md)                     | NOT_IMPLEMENTED | 2.3          |
| [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md)                         | NOT_IMPLEMENTED | 2.4          |
| [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](DROPDOWN_VALIDATION_STYLING_PLAN.md) | NOT_IMPLEMENTED | 2.7          |
| [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md)                           | NOT_IMPLEMENTED | 3.1          |
| [`WORKFLOW_STEP_PLAN.md`](WORKFLOW_STEP_PLAN.md)                             | NOT_IMPLEMENTED | 3.2          |
| [`CLINE_INTEGRATION_PLAN.md`](CLINE_INTEGRATION_PLAN.md)                     | NOT_IMPLEMENTED | 3.4          |
| [`VSCODE_LM_API_FEATURES.md`](VSCODE_LM_API_FEATURES.md)                     | NOT_IMPLEMENTED | 3.5          |
| [`TERMINAL_FOLLOWUP_TRACKING_PLAN.md`](TERMINAL_FOLLOWUP_TRACKING_PLAN.md)   | NOT_IMPLEMENTED | 3.6          |
| [`INLINE_SUGGESTIONS_PLAN.md`](INLINE_SUGGESTIONS_PLAN.md)                   | NOT_IMPLEMENTED | 3.7          |
| [`ADDITIONAL_INSTRUCTIONS_PLAN.md`](ADDITIONAL_INSTRUCTIONS_PLAN.md)         | NOT_IMPLEMENTED | 3.8          |
| [`VSCODE_TESTING_E2E_MCP.md`](VSCODE_TESTING_E2E_MCP.md)                     | NOT_IMPLEMENTED | 3.9          |

### Implemented Since April 2026 (moved to `dev/implemented/`)

| Document                                                                                                     | Roadmap Item |
| ------------------------------------------------------------------------------------------------------------ | ------------ |
| [`../implemented/COMPLETION_NOTIFICATIONS_PLAN.md`](../implemented/COMPLETION_NOTIFICATIONS_PLAN.md)         | 1.1          |
| [`../implemented/BACKTICK_CONTEXT_SUPPRESSION_PLAN.md`](../implemented/BACKTICK_CONTEXT_SUPPRESSION_PLAN.md) | 1.2          |
| [`../implemented/WORKFLOW_FAVORITES_PLAN.md`](../implemented/WORKFLOW_FAVORITES_PLAN.md)                     | 1.4          |
| [`../implemented/SCM_COMMIT_MESSAGE_BUTTON.md`](../implemented/SCM_COMMIT_MESSAGE_BUTTON.md)                 | 1.7          |
| [`../implemented/ERROR_BEHAVIOR_PLAN.md`](../implemented/ERROR_BEHAVIOR_PLAN.md)                             | 2.1          |
| [`../implemented/INLINE_PRIOR_CONTEXT_PLAN.md`](../implemented/INLINE_PRIOR_CONTEXT_PLAN.md)                 | 2.6          |
