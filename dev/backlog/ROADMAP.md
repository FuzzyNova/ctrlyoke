# FlightPath Extension — Strategic Roadmap

**Last updated:** April 5, 2026  
**Current version:** 0.1.0 (pre-release)  
**Status:** Active development — no backward compatibility constraints

---

## Executive Summary

FlightPath is a VS Code extension that automates AI coding assistants (GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini) through structured YAML/JSON prompt workflows. The core engine is fully functional: multi-harness CLI/Chat execution, parallel workflow execution, per-prompt session management, dynamic queue extension, React webview dashboard with CodeMirror 6 editor, script-based end conditions, agent injection, a standalone CLI binary, stale-state recovery, an embedded terminal, and mobile-responsive layout are all working. The project is pre-release and approaching a marketable v0.1.0 milestone — the primary remaining gap is CHANGELOG population and the documentation site. The architecture is clean and SOLID-compliant, making new features straightforward to add.

---

## Current Version & Completed Milestones

### Core Engine (Shipped)

- **Multi-harness execution**: Copilot CLI, Claude Code CLI, Codex CLI, OpenCode CLI, and Copilot Chat UI automation
- **Composition-based CLI architecture**: Single `CliIntegration` class + `ICliProvider` interface; zero core changes needed to add new harnesses
- **Parallel workflow execution**: `WorkflowInstance` (self-contained execution unit) + `WorkflowOrchestrator` (multi-workflow registry); per-workflow pause/resume/cancel; configurable concurrency
- **Per-prompt session management**: Three-tier session ID resolution (prompt > workflow > global), session persistence across restarts
- **Dynamic queue extension**: Copilot can autonomously extend workflows by modifying `.flightpath.yaml`/`.flightpath.json` files at runtime
- **End condition evaluation**: Script-based validation with retry logic, timeout protection, and template variables
- **Workflow-level properties**: Three-tier precedence (prompt > workflow > global settings) for harness, model, agent, end conditions
- **Agent injection**: `AgentExpander.ts` reads agent file content and wraps in `<agentInstructions>` XML; injected via `HarnessIntegration.buildPromptText()`; supports workspace-relative, `.flightpath/`-relative, and absolute paths
- **Final prompt**: `finalStep` field on `PromptFile` runs once after all queue items complete; `FinalStepFooter` component in dashboard
- **Multi-format support**: `.flightpath.yaml`, `.flightpath.json`, `.prompt.md` with unified JSON schema (AJV validation)
- **MCP server entrypoint**: `flightpath-mcp` binary for tool-based queue operations
- **Stale state recovery**: `WorkflowLockManager` with atomic writes, PID probing, 30s heartbeat, and `normalizeStaleLocks` on startup
- **Standalone CLI binary**: `src/cli.ts` with Commander (`run`, `validate` commands); `PlatformAdapter`/`CliAdapter`/`VsCodeAdapter`; `out/cli.js` esbuild target; `flightpath` bin entry in `package.json`
- **Gemini CLI harness**: `gemini-cli` — JSON streaming, hook-based completion, MCP config support
- **Qwen Code CLI harness**: `qwen-cli` — JSONL events, log-based session discovery, hook completion
- **Variable substitution**: `--var key=value` CLI flag; `{{varName}}` placeholders in workflow YAML; workflow-level `vars:` defaults; env var injection for end condition scripts
- **Custom CLI args**: `extraArgs?: string[]` on `PromptItem` and `PromptFile`; per-provider pass-through in `buildCommand()`
- **User-defined hooks**: `ExecutionProperties.hooks` for pre/post execution alongside agent/skills/mcpServers; headless mode support

### UI & Developer Experience (Shipped)

- **React 19 webview dashboard**: Zustand state, resizable panels, Tailwind CSS, full VS Code theme integration
- **Multi-workflow UI**: Tab/list switching between active workflows, per-workflow status, independent controls
- **CodeMirror 6 editor**: Replaced contenteditable (eliminates cursor jumping/blank line collapse bugs); Typo.js spell check, Ctrl+Click `#file:` navigation, undo/redo
- **IntelliSense completions**: `@file`, `#file:`, `#sym:` references with gitignore-aware file filtering; dynamic model completions from live Copilot API
- **Status bar integration**: Real-time execution state (Initializing → Ready → Running → Paused)
- **Dropdown hide/show**: `DROPDOWN_NAMESPACES` in `types/dropdownNamespaces.ts`; `hiddenDropdownOptions` in `uiStore`; `HideableProps` on `CustomSelect` and `MultiCheckboxDropdown`
- **Output history**: `OutputHistoryManager`, run selector UI, persistent run history
- **Mobile-responsive layout**: Responsive breakpoints, overlay sidebar, drag-and-drop prompt reordering on mobile
- **Embedded/interactive terminal**: `PtyProcessManager` singleton; xterm.js display; `kind: 'ai-cli'` and `kind: 'shell'` sessions
- **Custom icons system**: SVG sources → auto-converted CSS; 7 harness-specific icons
- **DashboardBroadcastHub**: Fan-out hub decoupling orchestrator from webview and other sinks
- **Permission/Context quick pickers**: `PermissionsQuickPicker` and `ContextQuickPicker` footer controls
- **Undo/redo controls**: `UndoRedoControl` in editor with action logging and workflow properties sync
- **Drawer tab architecture**: `DrawerTabBar` in `EditorFooter`; per-tab state management; workflow properties panel rename

### CLI Infrastructure (Shipped)

- **Per-provider log parsers**: `BaseLogParser`, `CopilotLogParser`, `ClaudeLogParser`, `CodexLogParser`
- **Universal CLI output format**: `UniversalCliOutput` + `CliOutputFormatter` for standardized response handling
- **ANSI/output fixes**: Codex CLI ANSI stripping and JSONL event parsing hardened
- **Adaptive prompt passing**: Direct injection ≤300 chars, temp file for complex prompts
- **Two execution modes**: Interactive terminal (visible, Ctrl+C abort) and headless background

### Schema & Tooling (Shipped)

- **Unified schema pipeline**: `prompt-schema.json` → auto-generated YAML schema → AJV runtime validation
- **Model sync workflow**: `sync-models.mjs` syncs `ModelConstants.ts` ↔ `package.json` ↔ `prompt-schema.json`
- **`name` field on prompts**: Named prompt identification + index-based completion tracking migration
- **Build-time dev/prod split**: `IS_DEV_MODE` flag with esbuild dead code elimination strips dev commands from production

---

## Known Issues & Technical Debt

### Bugs / Broken Features

- **Chat mode model switch**: `workbench.action.chat.changeModel` occasionally fails silently — shows warning and continues with current model, which may not match the configured default.
- **Codex headless completion**: Detection via `{"type":"turn.completed"}` JSONL events is fragile; notify hook fallback behavior needs hardening.

### Pre-Release Blockers

- **CHANGELOG not populated**: Only "Unreleased" section exists — needs proper version history before publication. `images/icon.png` ✅ and `.vscodeignore` ✅ are already in place.

### Technical Debt

- **`WorkflowInstance.ts` and `WorkflowOrchestrator.ts` are large**: The parallel workflow refactoring extracted `FlightPathManager.ts` (was ~1,885 lines) into these two classes (2,168 and 1,683 lines respectively). Further responsibility migration to the `orchestration/` subdirectory should continue over time.
- **Webview security — `style-src 'unsafe-inline'`**: Required by Tailwind CSS and CodeMirror — cannot be removed without migrating away from those libraries. Accepted risk, documented.
- **Webview security — message payload validation**: Incoming messages from the webview are not schema-validated. A malicious webview could send unexpected payloads. Low priority given the single-user local deployment model, but should be addressed before any multi-user scenario.
- **Chores are manual**: CLI version updates, model discovery, VS Code command refreshes are documented in `CHORES.md` but not automated in CI. The `scripts/chores.mjs` script exists but isn't wired to any scheduled process.
- **Test coverage gaps**: CLI/Chat integration tests are partial (`⚠️`). End-to-end workflow tests require live AI responses (inherently manual). Unit test suite is solid but CLI output parsing needs more coverage after recent ANSI/format fixes.

---

## Prioritized Roadmap

### Tier 1 — Quick Wins & Critical Fixes

_Less than 1 week each. High impact, low risk._

---

#### 1.1 BMAD Workflow Templates

**Priority: HIGH** | **Effort: 2–3 days** | **Doc: [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)**

BMAD (Breakthrough Method of Agile AI-Driven Development) is a structured multi-agent methodology that maps directly onto FlightPath's workflow model. Adding BMAD templates requires **zero core changes** — it's purely new template/prompt content.

**What to build:**

- Self-contained agent prompt files with embedded personas: `analyst.prompt.md`, `pm.prompt.md`, `architect.prompt.md`, `developer.prompt.md`, `qa.prompt.md`
- `.flightpath.json` workflow templates for each BMAD track:
  - Quick Flow (3-step lightweight)
  - Full Method (complete PRD → architecture → implementation → review)
  - Brownfield (analysis-first for existing codebases)
- End condition scripts: `tests-pass.js`, `docs-complete.js`, `review-approved.js`
- Import via `flightpath.importWorkflowTemplates` command

**Why it matters:** Gives FlightPath an opinionated "best practice" workflow out of the box. Demonstrates the full power of multi-step AI orchestration to new users. High discoverability — can be featured in README and marketplace listing.

**Dependencies:** Agent injection is complete. BMAD agent personas will work correctly.

---

#### 1.2 Pre-Release Publication Prep

**Priority: HIGH** | **Effort: 1–2 days**

Remaining blocker before publishing to VS Code Marketplace. `images/icon.png` ✅ and `.vscodeignore` ✅ are already done. Ship these before v0.1.0 tag:

- **CHANGELOG**: Document what shipped in v0.1.0 — use git log and the "Completed Milestones" section above as source material
- **README polish**: Verify quick-start instructions still work end-to-end with current CLI versions

**Dependencies:** None.

---

#### 1.3 Chore Automation (CI Integration)

**Priority: MEDIUM** | **Effort: 2–3 days**

The `scripts/chores.mjs` script exists but isn't run automatically. Wire it into a GitHub Actions workflow.

**What to build:**

- Monthly scheduled workflow: `npm run chores -- --task update-deps` + `npm audit fix` + PR creation
- On-push: `npm run sync-models:check` to fail CI if models are out of sync between `ModelConstants.ts` and `package.json`
- Model discovery reminder in release checklist automation

**Why it matters:** Manual chores accumulate. Automated dependency updates and model sync checks prevent drift that is invisible until a user reports a bug.

**Dependencies:** GitHub Actions configuration.

### Tier 2 — High-Value Features

_1–4 weeks each. Core product improvements that significantly expand utility._

---

#### 2.1 Template Setup Scripts

**Priority: HIGH** | **Effort: 1–2 weeks** | **Doc: [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md)**

Templates currently require users to manually replace `{placeholder}` variables. Setup scripts would run automatically when a template is instantiated, auto-populating variables by inspecting the repository.

**What to build:**

- Extend `WorkflowTemplate` type with `setupScript?: string` field
- `TemplateSetupRunner.ts`: Executes setup scripts with workspace context injection (repo name, file list, detected framework, etc.)
- Built-in `analyze-repo-for-agents.js`: Inspects directory structure and generates appropriate agent configurations
- UI: Progress indicator during setup, editable variable confirmation step before creating workflow
- Schema update: Add `setupScript` to `prompt-schema.json`

**Why it matters:** The gap between "I imported a template" and "this template is ready to run on my codebase" is currently filled by manual editing. Setup scripts close that gap and make FlightPath feel intelligent rather than generic.

**Dependencies:** Template infrastructure (already built). No core harness changes.

---

#### 2.2 AGENTS.md Generation & Injection

**Priority: HIGH** | **Effort: 1–2 weeks** | **Doc: [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md)**

Two distinct subsystems that work together to make FlightPath project-context-aware:

**Subsystem 1 — `AgentsFileResolver`:**

- Walk parent directories from the active workspace to find `AGENTS.md` files (same discovery pattern as CLAUDE.md/GEMINI.md)
- Inject discovered content as `<projectInstructions>` XML tags into CLI prompts
- Apply `--no-custom-instructions` workaround for Copilot CLI's single-file native loading conflict
- Respects Copilot's own AGENTS.md discovery so FlightPath doesn't double-inject

**Subsystem 2 — `GenerateAgentsWorkflow` command:**

- New VS Code command: `FlightPath: Generate AGENTS.md`
- Multi-prompt workflow template that: (1) analyzes directory tree, (2) identifies key files/patterns, (3) generates a comprehensive `AGENTS.md`
- Output validated by end condition script checking for required sections

**Why it matters:** AGENTS.md is becoming the standard context file for AI coding assistants (GitHub, Anthropic, Google all support it). FlightPath should be the tool that generates and leverages these files, not ignores them.

**Dependencies:** Agent injection (1.1) recommended first. Template setup scripts (2.1) make the generation workflow more robust.

---

#### 2.3 Output History UI Completion

**Priority: MEDIUM** | **Effort: 1 week**

`OutputHistoryManager` and run history persistence are implemented but the UI (`RunSelector` component) may not be fully wired into the dashboard.

**What to complete:**

- Verify `RunSelector` component renders run history with timestamps and harness labels
- Add diff view: compare current run output against a previous run
- Export run history to markdown (useful for sharing AI session summaries)
- Search/filter within output history

**Why it matters:** Run history is a differentiating feature — most AI tools don't persist session outputs. Completing the UI makes it discoverable and useful.

**Dependencies:** `OutputHistoryManager` (already built).

---

#### 2.4 Improved End Condition Developer Experience

**Priority: MEDIUM** | **Effort: 3–5 days**

End conditions are powerful but have a steep learning curve. Several improvements would make them more approachable:

**What to build:**

- **Inline end condition preview**: Show last script output in the dashboard prompt card (currently hidden)
- **Common built-in end conditions** (no script required): `tests-pass`, `file-exists`, `no-typescript-errors`, `git-clean`
- **`endCondition: "tests-pass"` shorthand syntax**: Resolve named conditions to built-in scripts
- **End condition sandbox**: Run a script manually from the dashboard against the current workspace state
- Schema update: Add named condition enum to `prompt-schema.json`

**Why it matters:** The most common use case ("did the tests pass?") shouldn't require users to write a script. Built-in conditions lower the barrier and make workflows more portable.

**Dependencies:** None — additive changes to `EndConditionEvaluator`.

---

#### ~~2.5 Custom CLI Args (`extraArgs`)~~ ✅ DONE

Implemented. See `dev/implemented/CUSTOM_CLI_ARGS_PLAN.md`.

---

#### 2.6 Prior Context Passing (`priorContext`)

**Priority: MEDIUM** | **Effort: 1–2 weeks** | **Doc: [`PROMPT_CONTEXT_PASSING_PLAN.md`](PROMPT_CONTEXT_PASSING_PLAN.md)**

Allow a prompt to automatically receive the AI output from a previous prompt step as part of its input context. Useful for chains where step N summarizes what step N-1 produced.

**What to build:**

- Add `priorContext?: number | string` to `PromptItem` (reference prior prompt by index or id)
- `ContextExpander` captures the raw AI output of each completed step
- Inject referenced output as `<priorContext>` XML tags before sending the current prompt
- Schema update

**Why it matters:** Currently users must manually copy-paste output between steps or write the workflow in one monolithic prompt. Structured prior context passing enables true multi-step reasoning chains.

**Dependencies:** None. Works with all harnesses since it's pre-prompt-build injection.

---

#### 2.7 Prompt Queue Reorder & Reset From Step

**Priority: MEDIUM** | **Effort: 1–2 weeks** | **Doc: [`PROMPT_QUEUE_POSITION_AND_REORDER_PLAN.md`](PROMPT_QUEUE_POSITION_AND_REORDER_PLAN.md)**

Allow users to drag-and-drop reorder prompt steps in the dashboard, and reset execution back to a specific step without editing the queue file.

**What to build:**

- Drag-and-drop reorder in the `PromptList` dashboard component
- "Reset from here" action per prompt card (sets queue index, clears downstream state)
- Persist reorder changes back to the workflow file
- `PromptQueue` method for `resetToStep(index)`

**Why it matters:** When a mid-workflow prompt fails, users currently have to manually edit the YAML and restart. Reset-from-step makes error recovery fast and reduces friction for iterative workflow development.

**Dependencies:** None — additive UI + queue operation.

---

#### 2.8 Prompt Undo Changes (Git Snapshot Service)

**Priority: LOW** | **Effort: 2–3 weeks** | **Doc: [`PROMPT_UNDO_CHANGES_PLAN.md`](PROMPT_UNDO_CHANGES_PLAN.md)**

Before AI executes a prompt step, take a Git snapshot of the workspace. If the step produces unsatisfactory results, allow one-click revert to the pre-step state.

**What to build:**

- `GitSnapshotService.ts`: `git stash`-based or branch-based snapshot before each prompt
- "Undo this step" action in the dashboard (revert workspace to snapshot)
- Configurable: off by default, opt-in per workflow or globally
- Cleanup: purge old snapshots after successful workflow completion

**Why it matters:** AI coding mistakes in the middle of a workflow currently require manual `git diff` and selective revert. Automated snapshots give users a safety net for exploring bolder AI prompts.

**Dependencies:** Git must be initialized in the workspace. No harness changes needed.

---

#### 2.9 Thinking Level / Effort Configuration

**Priority: MEDIUM** | **Effort: 3–5 days** | **Doc: [`THINKING_LEVEL_PLAN.md`](THINKING_LEVEL_PLAN.md)**

Expose AI effort/thinking budget controls per-prompt or per-workflow. Claude supports `thinking` budget tokens; other models have analogous effort parameters.

**What to build:**

- Add `thinkingLevel?: "auto" | "low" | "medium" | "high" | number` to `PromptItem`
- Map per-harness: Claude → `thinking.budget_tokens`, Codex → `reasoning.effort`, others → best approximation
- Dashboard slider or dropdown in the prompt card
- Schema update

**Why it matters:** For complex architectural prompts, higher thinking budgets produce dramatically better results at higher cost. For simple tasks, lower budgets save time and quota. Per-prompt tuning is a meaningful productivity lever.

**Dependencies:** None. Each provider maps the abstract level to their native API.

---

#### 2.10 Documentation Site (VitePress)

**Priority: MEDIUM** | **Effort: 1–2 weeks** | **Doc: [`DOCUMENTATION_STRATEGY_PLAN.md`](DOCUMENTATION_STRATEGY_PLAN.md)**

Build a public documentation site using VitePress. Currently all documentation lives in markdown files inside the repo — discoverable by developers but not by prospective users.

**What to build:**

- VitePress site in `docs-site/` (separate from `docs/` internal docs)
- Sections: Getting Started, Workflow Reference (schema), Harness Configuration, CLI Reference, MCP Reference, Tutorials
- Deployed to GitHub Pages via GitHub Actions on push to main
- Auto-generated schema reference from `prompt-schema.json`

**Why it matters:** A public docs site lowers onboarding friction and supports marketplace discoverability. Users searching for "Copilot workflow automation" need docs they can read before installing.

**Dependencies:** v0.1.0 publication prep (1.2) should stabilize the user-facing API first.

---

### Tier 3 — Strategic Investments

_1–2 months each. Architectural changes or significant new capabilities._

---

#### 3.1 FlightPath as a Platform: MCP Server Hardening

**Priority: MEDIUM** | **Effort: 2–3 weeks**

The `flightpath-mcp` binary exists but MCP tool coverage may be incomplete. Hardening the MCP interface turns FlightPath into a platform that other AI assistants can drive.

**What to build:**

- Complete MCP tool surface: `queue_workflow`, `get_status`, `pause`, `resume`, `cancel`, `get_output`, `list_runs`
- Authentication: Token-based access for multi-user or remote scenarios
- MCP tool schema validation against `prompt-schema.json`
- Integration tests: MCP round-trips using `@modelcontextprotocol/sdk` test utilities
- Documentation: MCP usage guide for Claude Desktop, Cursor, and other MCP clients

**Why it matters:** MCP adoption is accelerating. A well-designed MCP server lets Claude Desktop, Cursor, and any MCP-compatible client drive FlightPath workflows — multiplying distribution without requiring users to install the VS Code extension.

**Dependencies:** Stable core API. MCP spec changes are still frequent; defer until spec stabilizes or pin to a version.

---

### Tier 4 — Future Vision

_Longer-term or requiring external decisions before implementation._

---

#### 4.1 Premium Licensing (Pro Tier)

**Priority: LOW (business decision needed)** | **Effort: 3–4 weeks**

Gate power features behind a Pro subscription to fund continued development. The dynamic queue extension and unlimited parallel workflows are natural candidates for a paid tier.

**What to build:**

- `LicenseManager.ts`: LemonSqueezy API integration + `vscode.SecretStorage` for license key storage
- License validation: Online check at activation + offline grace period (7 days)
- Gated features: Dynamic queue, unlimited parallel workflows, extended output history retention
- `FlightPath: Activate License` command with webview UI
- Free tier: Full single-workflow execution with static queues (covers 90% of use cases)

**Why it matters:** Long-term sustainability. Sets pricing early while the project is pre-release (no user retraining required).

**Considerations:**

- Decide free vs. open-source model before implementation
- LemonSqueezy vs. Paddle vs. GitHub Sponsors — each has different integration complexity
- Consider time-limited free trials rather than a permanent free tier
- Requires legal/ToS decisions before engineering starts

**Dependencies:** Must have a stable, shipped v0.1.0 before gating features. Parallel workflows (3.1) and CLI (3.2) are the most logical Pro features — implement those first.

---

#### 4.2 AI-Powered Workflow Generation

**Priority: SPECULATIVE** | **Effort: 2–4 weeks**

Use the AI assistants FlightPath drives to generate FlightPath workflows themselves — a meta-loop.

**What to build:**

- `FlightPath: Generate Workflow from Description` command
- User describes goal in natural language → AI generates a `.flightpath.yaml` with appropriate prompts, end conditions, and agent assignments
- Validation: Generated workflows are schema-validated before being saved
- Feedback loop: Workflow execution results improve next-generation prompts

**Why it matters:** Lowers the barrier to entry dramatically. Users who don't know FlightPath's schema can describe what they want and get a working workflow. Especially powerful when combined with AGENTS.md generation (2.2) and BMAD templates (1.2).

**Dependencies:** AGENTS.md generation (2.2), Template setup scripts (2.1), and stable schema — all of which provide the building blocks for high-quality AI-generated workflows.

---

#### 4.3 VS Code Workspace Extension Marketplace Listing

**Priority: PREREQUISITE FOR GROWTH** | **Effort: 1 week prep**

Getting FlightPath listed on the VS Code Marketplace is the primary distribution channel. This is a Tier 4 item because it requires completing the Tier 1 pre-release prep (1.3) first, plus a quality bar.

**Pre-conditions:**

- PNG icon ✅ (already done)
- `.vscodeignore` ✅ (already done)
- CHANGELOG populated ✓ (from 1.2)
- Passing `npm run lint` and `npm test` ✓
- Published GitHub repository with README ✓
- At least one end-to-end workflow documented and tested

**Actions:**

- `vsce login nhickster`
- `vsce publish`
- Request VS Code Marketplace featured listing (submit via GitHub issue on `microsoft/vscode-discussions`)

---

## Dependency Graph

```
1.2 Pre-Release Prep (CHANGELOG)
  └─► 2.10 Documentation Site (docs lock in what v0.1.0 ships)
      └─► 4.3 Marketplace Listing

1.1 BMAD Templates
  └─► 2.2 AGENTS.md Generation (agent personas improve generation quality)

2.1 Template Setup Scripts
  └─► 2.2 AGENTS.md Generation (generation workflow uses setup scripts)

2.6 Prior Context Passing
  └─► 2.9 Thinking Level (both feed into richer multi-step chains)

3.1 Standalone Server
  └─► 4.3 Marketplace Listing (server docs improve discoverability)

4.1 Premium Licensing
  └── depends on stable v0.1.0 being shipped
```

---

## Estimated Timeline

| Milestone                  | Items                              | Target      |
| -------------------------- | ---------------------------------- | ----------- |
| **v0.1.0 Release**         | 1.2 (CHANGELOG) + 2.10 (docs site) | April 2026  |
| **v0.2.0 Templates & UX**  | 1.1 + 2.1 + 2.7 + 2.8              | May 2026    |
| **v0.3.0 Project Context** | 2.2 + 2.4 + 2.6                    | June 2026   |
| **v0.4.0 Power Features**  | 2.9 + 3.1 (standalone server)      | August 2026 |
| **v0.5.0 Platform & Pro**  | 4.1 + 4.2 + 4.3                    | Oct 2026    |

_Timeline is aspirational. Pre-release — prioritize quality over schedule._

---

## Research Documents Index

> **Convention:** Plans move to `dev/implemented/` when done. This index lists active/backlog items only — see `dev/implemented/` for the full archive.

### Active (in progress)

| Document                                                                               | Status    | Roadmap Item |
| -------------------------------------------------------------------------------------- | --------- | ------------ |
| [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md) | 🔄 ACTIVE | 2.10         |
| [`../active/AUTOMATION_API_PLAN.md`](../active/AUTOMATION_API_PLAN.md)                 | 🔄 ACTIVE | —            |

### Backlog (not yet started)

| Document                                                                     | Status          | Roadmap Item |
| ---------------------------------------------------------------------------- | --------------- | ------------ |
| [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md)                         | NOT_IMPLEMENTED | 2.2          |
| [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)                           | NOT_IMPLEMENTED | 1.1          |
| [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md)                     | NOT_IMPLEMENTED | 2.1          |
| [`INLINE_PRIOR_CONTEXT_PLAN.md`](INLINE_PRIOR_CONTEXT_PLAN.md)               | NOT_IMPLEMENTED | 2.6          |
| [`STANDALONE_SERVER_PLAN.md`](STANDALONE_SERVER_PLAN.md)                     | NOT_IMPLEMENTED | 3.1          |
| [`GLOBAL_SETTINGS_PLAN.md`](GLOBAL_SETTINGS_PLAN.md)                         | NOT_IMPLEMENTED | —            |
| [`ADDITIONAL_INSTRUCTIONS_PLAN.md`](ADDITIONAL_INSTRUCTIONS_PLAN.md)         | NOT_IMPLEMENTED | —            |
| [`INLINE_SUGGESTIONS_PLAN.md`](INLINE_SUGGESTIONS_PLAN.md)                   | NOT_IMPLEMENTED | —            |
| [`LIVE_CONTEXT_WINDOW_PLAN.md`](LIVE_CONTEXT_WINDOW_PLAN.md)                 | NOT_IMPLEMENTED | —            |
| [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md)                           | NOT_IMPLEMENTED | —            |
| [`SCM_COMMIT_MESSAGE_BUTTON.md`](SCM_COMMIT_MESSAGE_BUTTON.md)               | NOT_IMPLEMENTED | —            |
| [`SCRIPT_STEP_PLAN.md`](SCRIPT_STEP_PLAN.md)                                 | NOT_IMPLEMENTED | —            |
| [`WORKFLOW_STEP_PLAN.md`](WORKFLOW_STEP_PLAN.md)                             | NOT_IMPLEMENTED | —            |
| [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](DROPDOWN_VALIDATION_STYLING_PLAN.md) | NOT_IMPLEMENTED | —            |
| [`CLINE_INTEGRATION_PLAN.md`](CLINE_INTEGRATION_PLAN.md)                     | NOT_IMPLEMENTED | —            |
| [`VSCODE_LM_API_FEATURES.md`](VSCODE_LM_API_FEATURES.md)                     | NOT_IMPLEMENTED | —            |
| [`VSCODE_TESTING_E2E_MCP.md`](VSCODE_TESTING_E2E_MCP.md)                     | NOT_IMPLEMENTED | —            |
