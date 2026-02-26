# FlightPath Extension — Strategic Roadmap

**Last updated:** February 25, 2026  
**Current version:** 0.1.0 (pre-release)  
**Status:** Active development — no backward compatibility constraints

---

## Executive Summary

FlightPath is a VS Code extension that automates AI coding assistants (GitHub Copilot, Claude Code, Codex) through structured YAML/JSON prompt workflows. The core engine is fully functional: multi-harness CLI/Chat execution, per-prompt session management, dynamic queue extension, React webview dashboard with CodeMirror 6 editor, and script-based end conditions are all working. The project is pre-release and approaching a marketable v0.1.0 milestone — the primary gaps are UX polish, a broken agent injection mechanism, and a handful of high-value features that would significantly expand what users can do with the tool. The architecture is clean and SOLID-compliant, making new features straightforward to add.

---

## Current Version & Completed Milestones

### Core Engine (Shipped)

- **Multi-harness execution**: Copilot CLI, Claude Code CLI, Codex CLI, and Copilot Chat UI automation
- **Composition-based CLI architecture**: Single `CliIntegration` class + `ICliProvider` interface; zero core changes needed to add new harnesses
- **Per-prompt session management**: Three-tier session ID resolution (prompt > workflow > global), session persistence across restarts
- **Dynamic queue extension**: Copilot can autonomously extend workflows by modifying `.flightpath.yaml`/`.flightpath.json` files at runtime
- **End condition evaluation**: Script-based validation with retry logic, timeout protection, and template variables
- **Workflow-level properties**: Three-tier precedence (prompt > workflow > global settings) for harness, model, agent, end conditions
- **Multi-format support**: `.flightpath.yaml`, `.flightpath.json`, `.prompt.md` with unified JSON schema (AJV validation)
- **MCP server entrypoint**: `flightpath-mcp` binary for tool-based queue operations

### UI & Developer Experience (Shipped)

- **React 19 webview dashboard**: Zustand state, resizable panels, Tailwind CSS, full VS Code theme integration
- **CodeMirror 6 editor**: Replaced contenteditable (eliminates cursor jumping/blank line collapse bugs); Typo.js spell check, Ctrl+Click `#file:` navigation, undo/redo
- **IntelliSense completions**: `@file`, `#file:`, `#sym:` references with gitignore-aware file filtering; dynamic model completions from live Copilot API
- **Status bar integration**: Real-time execution state (Initializing → Ready → Running → Paused)
- **Output history**: `OutputHistoryManager`, run selector UI, persistent run history

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

- **`--agent` CLI flag is broken**: The `agent` property on workflows is plumbed through the type system and settings panel, but the Copilot CLI only supports a single `--agent` file natively (no multi-file composition). Agent file content is not actually injected into prompts. This is the highest-priority bug — see [`GLOBAL_AGENT_INCLUSION_PLAN.md`](GLOBAL_AGENT_INCLUSION_PLAN.md).
- **Chat mode model switch**: `workbench.action.chat.changeModel` occasionally fails silently — shows warning and continues with current model, which may not match the configured default.
- **Codex headless completion**: Detection via `{"type":"turn.completed"}` JSONL events is fragile; notify hook fallback behavior needs hardening.

### Pre-Release Blockers

- **No PNG icon**: VS Code Marketplace requires a PNG icon (≥128×128px). Current `images/icon.svg` needs export to `images/icon.png`.
- **No `.vscodeignore`**: Required before `vsce package` for a clean VSIX. Source files, research docs, and test fixtures need to be excluded.
- **CHANGELOG not populated**: Only "Unreleased" section exists — needs proper version history before publication.

### Technical Debt

- **`FlightPathManager.ts` is 1,885 lines**: Core orchestration class is well-structured but large. The orchestration subdirectory (`PromptFileLoader`, `PromptFileWatcher`, etc.) is the right direction; more responsibility can migrate there over time.
- **Chores are manual**: CLI version updates, model discovery, VS Code command refreshes are documented in `CHORES.md` but not automated in CI. The `scripts/chores.mjs` script exists but isn't wired to any scheduled process.
- **Test coverage gaps**: CLI/Chat integration tests are partial (`⚠️`). End-to-end workflow tests require live AI responses (inherently manual). Unit test suite is solid (2,227 lines, 11 files) but CLI output parsing needs more coverage after recent ANSI/format fixes.
- **`HarnessIntegration` rename pending**: The abstract base class is `CopilotIntegration` in comments/docs but `HarnessIntegration` in the import. Naming inconsistency across docs and code.

---

## Prioritized Roadmap

### Tier 1 — Quick Wins & Critical Fixes

_Less than 1 week each. High impact, low risk._

---

#### 1.1 Fix Agent Injection (Global Agent Inclusion)

**Priority: CRITICAL** | **Effort: ~1 week** | **Doc: [`GLOBAL_AGENT_INCLUSION_PLAN.md`](GLOBAL_AGENT_INCLUSION_PLAN.md)**

The `agent` property on workflows is currently broken — the Copilot CLI's `--agent` flag only loads a single file natively and doesn't compose with FlightPath's multi-file context system. Users setting `agent:` in their workflows get no agent behavior.

**What to build:**

- `AgentExpander.ts`: Reads agent file content, wraps in `<agentInstructions>` XML tags
- Modify `HarnessIntegration.buildPromptText()` to call `AgentExpander` after context expansion
- Remove the non-functional `--agent` CLI flag from all providers (`CopilotCliProvider`, `ClaudeCliProvider`, `CodexCliProvider`)
- Support agent resolution relative to workspace root, `.flightpath/`, and absolute paths

**Why it matters:** Agent files are a documented feature. Users discovering it silently does nothing damages trust. The fix also unblocks proper multi-agent composition (each prompt can use a different agent persona).

**Dependencies:** None — isolated change to prompt-building pipeline.

---

#### 1.2 BMAD Workflow Templates

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

**Dependencies:** Agent injection (1.1) should land first so agent personas work correctly in BMAD flows.

---

#### 1.3 Pre-Release Publication Prep

**Priority: HIGH** | **Effort: 1–2 days**

Block on publishing to VS Code Marketplace. Ship these before v0.1.0 tag:

- **PNG icon**: Export `images/icon.svg` → `images/icon.png` at 512×512px
- **`.vscodeignore`**: Exclude `docs/`, `src/`, `scripts/`, `manual-test/`, `test-logs/`, `archive/`, `*.md` (keep only `out/`, `schemas/`, `images/icon.png`, `package.json`, `LICENSE`)
- **CHANGELOG**: Document what shipped in v0.1.0 — use git log and the "Completed Milestones" section above as source material
- **README polish**: Verify quick-start instructions still work end-to-end with current CLI versions

**Dependencies:** None.

---

#### 1.4 Chore Automation (CI Integration)

**Priority: MEDIUM** | **Effort: 2–3 days**

The `scripts/chores.mjs` script exists but isn't run automatically. Wire it into a GitHub Actions workflow.

**What to build:**

- Monthly scheduled workflow: `npm run chores -- --task update-deps` + `npm audit fix` + PR creation
- On-push: `npm run sync-models:check` to fail CI if models are out of sync between `ModelConstants.ts` and `package.json`
- Model discovery reminder in release checklist automation

**Why it matters:** Manual chores accumulate. Automated dependency updates and model sync checks prevent drift that is invisible until a user reports a bug.

**Dependencies:** GitHub Actions configuration.

---

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

### Tier 3 — Strategic Investments

_1–2 months each. Architectural changes or significant new capabilities._

---

#### 3.1 Parallel Workflow Execution

**Priority: HIGH** | **Effort: 4–6 weeks** | **Doc: [`PARALLEL_WORKFLOWS_ARCHITECTURE.md`](PARALLEL_WORKFLOWS_ARCHITECTURE.md)**

Currently FlightPath can only run one workflow at a time. The `FlightPathManager` owns a single `PromptQueue` and a single `activeIntegration`. Parallel execution requires extracting these into a `WorkflowInstance` abstraction.

**What to build (5-phase migration):**

1. **Extract `WorkflowInstance`**: Self-contained execution unit (queue + integration + state + output stream)
2. **`WorkflowOrchestrator`**: Registry that manages a collection of `WorkflowInstance` objects
3. **Replace `FlightPathManager` singleton references** with orchestrator lookups
4. **Multi-workflow UI**: Tab/list switching in dashboard, per-workflow status indicators, independent pause/resume/cancel
5. **Resource management**: Configurable concurrency limit (default: 3 parallel workflows), shared CLI process pooling

**Why it matters:** Power users running large codebases often need to parallelize — run one workflow planning while another implements. This is a significant competitive differentiator. The architecture is cleanly extractable because of existing SOLID separation.

**Dependencies:** Requires stable core (all Tier 1 items should be complete). Significant risk of regressions — needs comprehensive test coverage before starting. Plan for a feature flag (`enableParallelWorkflows: false` by default during rollout).

---

#### 3.2 Standalone CLI (FlightPath without VS Code)

**Priority: MEDIUM** | **Effort: 3–5 weeks** | **Doc: [`FLIGHTPATH_CLI_DESIGN.md`](FLIGHTPATH_CLI_DESIGN.md)**

A standalone CLI entrypoint (`flightpath run workflow.yaml`) would unlock CI/CD and headless automation use cases — running structured AI workflows in GitHub Actions pipelines without needing a VS Code window.

**What to build:**

- `src/cli.ts`: New esbuild entry point (separate from `extension.ts`)
- `PlatformAdapter` interface with two implementations:
  - `VsCodeAdapter`: Wraps existing VS Code API calls (used by extension)
  - `CliAdapter`: Node.js replacements (file system, stdout, process.exit)
- Refactor `WorkflowExecutor` and `EndConditionEvaluator` to depend on `PlatformAdapter` rather than `vscode.*` directly
- Second esbuild target: `out/flightpath-cli.js` as a standalone executable
- CLI argument parsing: `--workflow`, `--harness`, `--model`, `--dry-run`, `--output`

**Why it matters:** CI/CD is a strong use case for FlightPath that the VS Code extension model can't serve. Reaching DevOps workflows dramatically expands the addressable audience. The detailed design doc already exists.

**Dependencies:** `WorkflowInstance` extraction (3.1) makes this easier by decoupling execution from the VS Code singleton. Can be done independently but will be messier.

---

#### 3.3 FlightPath as a Platform: MCP Server Hardening

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

**Priority: LOW (business decision needed)** | **Effort: 3–4 weeks** | **Doc: [`PREMIUM_LICENSING_STRATEGY.md`](PREMIUM_LICENSING_STRATEGY.md)**

Gate power features behind a Pro subscription to fund continued development. The dynamic queue and unlimited mode are natural candidates for a paid tier.

**What to build:**

- `LicenseManager.ts`: LemonSqueezy API integration + `vscode.SecretStorage` for license key storage
- License validation: Online check at activation + offline grace period (7 days)
- Gated features: Dynamic queue, unlimited mode, parallel workflows (Tier 3.1), standalone CLI (Tier 3.2)
- `FlightPath: Activate License` command with webview UI
- Free tier: Full single-workflow execution with static queues (covers 90% of use cases)

**Why it matters:** Long-term sustainability. Sets pricing early while the project is pre-release (no user retraining required). The extension is already substantial enough to justify a Pro tier.

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

- PNG icon ✓ (from 1.3)
- `.vscodeignore` ✓ (from 1.3)
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
1.1 Fix Agent Injection
  └─► 1.2 BMAD Templates (needs working agents)
  └─► 2.2 AGENTS.md Generation (builds on agent system)

1.3 Pre-Release Prep
  └─► 4.3 Marketplace Listing

2.1 Template Setup Scripts
  └─► 2.2 AGENTS.md Generation (generation workflow uses setup scripts)

3.1 Parallel Workflows
  └─► 3.2 Standalone CLI (WorkflowInstance extraction helps both)
  └─► 4.1 Premium Licensing (parallel = Pro feature)

4.1 Premium Licensing
  └── depends on: 3.1 + 3.2 being shipped (Pro features to gate)
```

---

## Estimated Timeline

| Milestone                    | Items                                  | Target         |
| ---------------------------- | -------------------------------------- | -------------- |
| **v0.1.0 Release**           | 1.3 (pub prep) + bug fixes             | March 2026     |
| **v0.2.0 Agent & Templates** | 1.1 + 1.2 + 2.1                        | April 2026     |
| **v0.3.0 Project Context**   | 2.2 + 2.3 + 2.4                        | May 2026       |
| **v0.4.0 Platform**          | 3.1 (parallel) + 3.3 (MCP)             | July 2026      |
| **v0.5.0 CLI & Pro**         | 3.2 (standalone CLI) + 4.1 (licensing) | September 2026 |

_Timeline is aspirational. Pre-release — prioritize quality over schedule._

---

## Research Documents Index

| Document                                                                                             | Status          | Roadmap Item |
| ---------------------------------------------------------------------------------------------------- | --------------- | ------------ |
| [`AGENTS_MD_GENERATION.md`](AGENTS_MD_GENERATION.md)                                                 | NOT_IMPLEMENTED | 2.2          |
| [`BMAD_FOR_FLIGHTPATH.md`](BMAD_FOR_FLIGHTPATH.md)                                                   | NOT_IMPLEMENTED | 1.2          |
| [`FLIGHTPATH_CLI_DESIGN.md`](FLIGHTPATH_CLI_DESIGN.md)                                               | NOT_IMPLEMENTED | 3.2          |
| [`GLOBAL_AGENT_INCLUSION_PLAN.md`](GLOBAL_AGENT_INCLUSION_PLAN.md)                                   | NOT_IMPLEMENTED | 1.1          |
| [`PARALLEL_WORKFLOWS_ARCHITECTURE.md`](PARALLEL_WORKFLOWS_ARCHITECTURE.md)                           | NOT_IMPLEMENTED | 3.1          |
| [`PREMIUM_LICENSING_STRATEGY.md`](PREMIUM_LICENSING_STRATEGY.md)                                     | NOT_IMPLEMENTED | 4.1          |
| [`TEMPLATE_SETUP_SCRIPTS.md`](TEMPLATE_SETUP_SCRIPTS.md)                                             | NOT_IMPLEMENTED | 2.1          |
| [`CLI_LOG_FILES_INVESTIGATION.md`](CLI_LOG_FILES_INVESTIGATION.md)                                   | ✅ IMPLEMENTED  | —            |
| [`CLI_LOG_FILE_MIGRATION_PLAN.md`](CLI_LOG_FILE_MIGRATION_PLAN.md)                                   | ✅ IMPLEMENTED  | —            |
| [`CLI_OUTPUT_STANDARDIZATION.md`](CLI_OUTPUT_STANDARDIZATION.md)                                     | ✅ IMPLEMENTED  | —            |
| [`CODEX_CLI_OUTPUT_FIXES.md`](CODEX_CLI_OUTPUT_FIXES.md)                                             | ✅ IMPLEMENTED  | —            |
| [`GITIGNORE_COMPLETIONS_RESEARCH.md`](GITIGNORE_COMPLETIONS_RESEARCH.md)                             | ✅ IMPLEMENTED  | —            |
| [`NAME_FIELD_AND_COMPLETION_TRACKING_MIGRATION.md`](NAME_FIELD_AND_COMPLETION_TRACKING_MIGRATION.md) | ✅ IMPLEMENTED  | —            |
| [`OUTPUT_HISTORY_ARCHITECTURE.md`](OUTPUT_HISTORY_ARCHITECTURE.md)                                   | ✅ IMPLEMENTED  | —            |
