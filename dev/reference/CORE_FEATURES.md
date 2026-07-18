# ctrlyoke Core Features and Positioning

**Status:** Living marketing reference  
**Purpose:** Source material for the website, Marketplace listing, README, launch posts, demos, and other marketing copy. This is not a user guide or a complete product specification.

## Positioning in one line

**Category:** Multi-harness AI coding control and workflow automation.  
**Core promise:** Keep your prompting habits, reusable toolkit, controls, and history when you switch harnesses.

### Recommended tagline

> **One cockpit for every AI coding harness.**

### Recommended supporting line

> Prompt, steer, automate, and revisit work across Claude Code, Codex, Copilot CLI, and more—without relearning the tools around each harness.

This leads with ctrlyoke's broadest differentiator: it is not merely a workflow file runner. It is a consistent control surface around the developer's preferred AI coding harnesses. Workflow automation is one of its strongest capabilities, but not the limit of the product.

### Useful alternate taglines

- **Your prompts. Your workflows. Any harness.**
- **One interface for every AI coding harness.**
- **Switch harnesses, not habits.**
- **The better way to prompt, steer, and automate AI coding harnesses.**
- **Automate your favorite AI coding harness.**

The last option is direct and searchable, but it is narrower than the product. It works best as campaign copy or the heading of a workflow-focused section rather than the master tagline.

## Elevator pitch

### Short version

ctrlyoke is a unified control surface for AI coding harnesses. Use one prompt language, one full-featured editor, one output view, and one set of controls whether the work runs through Claude Code, Codex, Copilot CLI, or another supported harness.

### Full version

ctrlyoke gives developers one place to prompt, steer, automate, and revisit work across their AI coding harnesses. It handles harness-specific invocation, session resumption, permissions, MCP servers, hooks, agents, and skills behind a consistent interface. Its prompt editor understands project files, symbols, selections, Git changes, and prior results; its dashboard turns harness-specific event streams into a unified, navigable history with diffs and granular undo/redo. Start with one prompt, build a validated multi-step workflow, run it again with another harness, take it to CI, or steer the live terminal from a phone.

## Messaging hierarchy

Marketing should present ctrlyoke in this order:

1. **One control surface across harnesses** — switch tools without switching mental models.
2. **A better way to write prompts** — rich project context, completions, validation, and spell check.
3. **A better way to understand and control results** — normalized output, diffs, navigation, history, and undo/redo.
4. **Repeatable automation when it is useful** — reusable workflows, scripts, validation, retries, and dynamic task loops.
5. **The same work wherever it needs to run** — VS Code, an embedded terminal, a browser or phone, the CLI, and CI/CD.
6. **One place for the surrounding ecosystem** — sessions, agents, skills, MCP servers, hooks, and permissions.

This order keeps ctrlyoke relevant to developers who want a better single-prompt experience as well as those who want fully automated workflows.

## Core differentiating features

### 1. One interface across AI coding harnesses

**Customer value:** Choose the best harness for the task without memorizing a new set of flags, configuration files, session commands, permission modes, MCP syntax, and hook behavior every time.

ctrlyoke provides a consistent interface for supported harnesses while translating the details each CLI expects. Harness, model, session behavior, additional arguments, permissions, MCP servers, hooks, agents, and skills can be configured globally, at the workflow level, or for an individual prompt where applicable.

**Marketing copy:**

> Stop rebuilding your setup around every AI CLI. ctrlyoke gives Claude Code, Codex, Copilot CLI, OpenCode, Qwen Code, and Antigravity a shared control surface—so switching harnesses does not mean switching habits.

### 2. A universal language for project context

**Customer value:** Give a harness the right context without copying files, hand-writing line ranges, or repeatedly explaining where the work lives.

Prompts can reference:

- files and directory trees;
- symbols and selected line ranges, including selections surfaced from multiple visible editors;
- working changes, staged changes, stashes, and commits;
- previous steps, selected prior steps, and final-step output.

These references remain readable in the authored prompt and are expanded before the prompt reaches the harness.

**Marketing copy:**

> Point at the context you mean. Reference a file, directory, symbol, selection, Git change, commit, or earlier result with the same syntax in every harness.

### 3. A prompt editor built for real development work

**Customer value:** Write and refine serious prompts with editor ergonomics instead of a plain chat box.

The CodeMirror editor provides context-aware completions, syntax-aware reference chips, reference validation and quick fixes, search, undo/redo, keyboard workflows, pasted-image handling, and native VS Code theming. It also includes local spell checking.

**Marketing copy:**

> Prompts are part of the work. Edit them like it—with completions for project context, reference validation, search, undo/redo, and, yes, spell check.

**Personality copy:**

> Spell check in a prompt editor. Somehow still a differentiator.

### 4. One rich, reversible view of every result

**Customer value:** Keep the output experience consistent even when the underlying harness changes.

ctrlyoke normalizes streaming harness output into a chronological view of prompts, responses, reasoning events, shell commands, file operations, web searches, MCP calls, tool calls, status, and token information when the harness supplies it. File edits render as inline diffs with responsive unified or split views.

The output minimap shows the shape of the entire run: each step, its position in the output, and red/green change regions. Developers can jump directly to a step or diff and undo or redo selected files at the individual file-diff, prompt, or whole-workflow level.

**Marketing copy:**

> Different harness underneath. The same clear view on top. Follow the whole run, see every change in context, jump through the minimap, and undo only the work you do not want.

### 5. Workflows that grow from simple to sophisticated

**Customer value:** Start with a prompt, then add structure only when the task needs it.

ctrlyoke supports simple Markdown prompts and shareable YAML or JSON workflows. A workflow can mix AI prompt steps with ordinary script steps. Common execution properties can be set once at the workflow level and selectively overridden or disabled for an individual step, including the harness, model, agent, skills, session behavior, prior context, MCP servers, hooks, permissions, validation, and error policy.

Variables and enabled/disabled steps make workflows reusable without forcing every run to be identical.

**Marketing copy:**

> Start with one prompt. Add another step, a test gate, a script, or a different harness when you need it. ctrlyoke scales from quick requests to durable engineering workflows without changing formats halfway through.

### 6. Portable automation, not trapped chat history

**Customer value:** Turn successful ways of working into assets that can be reviewed, versioned, shared, compared, and run again.

Workflows are ordinary YAML, JSON, or Markdown files. Favorite a useful workflow for quick reuse, rerun it with different variables or harnesses, or execute it headlessly with the ctrlyoke CLI in local scripts and CI/CD.

Multiple workflows can run concurrently with independent pause, resume, and cancel controls.

**Marketing copy:**

> When a prompt sequence works, keep it. Version it with the code, share it with the team, rerun it with another harness, or move it into CI.

### 7. Validation based on the project, not the model's confidence

**Customer value:** Let real project state decide what happens next.

Pre-conditions can run a script before a prompt and continue, skip the prompt, or stop the workflow. End conditions run after a prompt and can continue, stop, or retry with structured script output. Standalone script steps bring deterministic commands into the same execution timeline without involving an AI harness.

**Marketing copy:**

> “Looks done” is not a test result. Gate AI work with the scripts your project already trusts, then continue, retry, skip, or stop based on what actually happened.

### 8. Dynamic agentic task loops without an external orchestrator

**Customer value:** Let the workflow discover and schedule follow-up work while preserving an explicit, inspectable queue.

A final step can review the completed run and use ctrlyoke's built-in MCP server to append specific follow-up prompts. ctrlyoke runs the new queue entries and invokes the final step again, creating a controlled plan–implement–review loop until the completion criteria are met.

**Marketing copy:**

> Build the “keep going until it is actually done” loop into the workflow. A final review step can inspect the work, queue the remaining tasks, and run again until there is nothing left to fix.

### 9. Resume conversations without learning every CLI's resume command

**Customer value:** Continue the right conversation while ctrlyoke handles harness-specific session mechanics.

A step can resume the immediately preceding compatible session, refer to the session created by an earlier step, use an exact harness session ID, or continue the latest final-step session. ctrlyoke keeps session reuse harness-aware rather than blindly sending one harness's session ID to another.

**Marketing copy:**

> Continue the conversation you mean. ctrlyoke tracks the session and calls the right harness-specific resume path for you.

### 10. Searchable conversation history across runs

**Customer value:** Find an earlier decision, command, file change, or answer without remembering which workflow or harness produced it.

The persistent history index searches more than response prose. It covers prompts, responses and reasoning, shell commands and output, file paths and diffs, tool and MCP activity, web-search results, and status messages. Results link back to the relevant workflow run and step, with a disk-scan fallback if the index is unavailable.

**Marketing copy:**

> Your AI coding history should be searchable. Find the answer, command, diff, tool call, or prompt you remember—even when you do not remember which run it came from.

### 11. Steer live work from a browser or phone

**Customer value:** Start a long-running task at the desk and remain in control away from it.

The hosted dashboard brings workflows, output, the workspace viewer, source control, and the live terminal to a browser. Its responsive mobile layout and terminal control bar provide touch-friendly Esc, Tab, arrow, Enter, control-key, and customizable shortcut buttons. Hosted access supports token-protected routes, TLS configuration, LAN/public URL selection, controller handoff between clients, and browser push notifications.

**Marketing copy:**

> Start the task at your desk. Check the diff, answer the prompt, send terminal controls, or steer the harness from your phone when hosted access is configured.

Remote/LAN access is a Pro feature; localhost browser access remains part of the free product.

### 12. One management surface for agents, skills, MCP servers, and hooks

**Customer value:** Reuse the surrounding AI toolchain instead of maintaining it independently for every harness.

The agents and skills manager discovers definitions across supported locations, distinguishes workspace and user scope, and can save or synchronize copies to ctrlyoke or harness-native directories. The MCP manager discovers local configurations, searches the remote MCP Registry, maintains ctrlyoke's registry, sets workflow defaults, and exports servers to supported harness configurations. Hooks can be defined globally, per workflow, or per prompt and are mapped to supported harness lifecycle events.

**Marketing copy:**

> Your harness may change. Your toolkit should not. Manage reusable agents, skills, MCP servers, hooks, and their workspace or user scope from ctrlyoke.

## Supporting strengths worth featuring

These are important supporting benefits even when they do not lead the page:

- **Interactive or headless execution:** Watch and steer a real CLI terminal, or run quietly in the background.
- **Live terminal plus structured history:** Keep the harness's native interactivity without giving up normalized, persistent output.
- **Per-harness choice inside one workflow:** Use the harness or model best suited to each step rather than forcing one vendor on the entire task.
- **Prior-result injection:** Pass selected earlier output into a fresh session when direct session continuation would overfill the context window.
- **Workspace change safety:** Inspect diffs and selectively restore files instead of treating a run as an all-or-nothing black box.
- **Shareable templates and variables:** Package repeatable workflows with user-supplied values rather than cloning and editing near-identical files.
- **Favorites and run comparison:** Keep useful workflows close and rerun them with different harnesses to compare results.
- **Exportable results:** Preserve or share a run as Markdown.
- **Notifications:** Receive completion and hosted-browser notifications instead of continuously watching a long task.
- **Workspace-aware security:** Scope file operations and hosted workspace access to trusted roots.

## The core story by audience

### Developer trying multiple harnesses

> Keep your workflow and switch the engine. ctrlyoke gives every supported harness the same prompt syntax, editor, output view, session controls, and reusable toolkit.

### Developer who mostly sends one prompt at a time

> You do not need to author YAML to benefit from ctrlyoke. Start with the prompt editor, rich context references, embedded terminal, normalized output, diffs, undo/redo, and searchable history. Save a workflow only when a sequence is worth repeating.

### Power user automating long tasks

> Combine prompts and scripts, validate each stage, retry failures with real command output, and let a final review step extend the queue until the task is complete.

### Team or CI/CD user

> Store AI workflows beside the code as reviewable YAML, JSON, or Markdown. Share the same execution contract across developers and run it headlessly in CI.

### Remote/mobile user

> Keep long-running harnesses on the development machine and use the hosted dashboard to review, respond, and steer from another browser or phone.

## Suggested homepage narrative

1. **Hero:** One cockpit for every AI coding harness.
2. **Subhead:** Prompt, steer, automate, and revisit work across supported harnesses from one interface.
3. **Harness strip:** Show the supported harnesses early as proof of breadth.
4. **Three primary promises:** One prompt language; one rich output view; one reusable toolkit.
5. **Everyday use:** Demonstrate a single prompt with file, selection, Git, and prior-context references.
6. **Control and safety:** Show the output minimap, diffs, history, and undo/redo.
7. **Automation:** Introduce shareable workflows, prompt/script steps, validation, retries, and dynamic final-step loops.
8. **Anywhere:** Show the CLI/CI path and the mobile hosted dashboard.
9. **Closing CTA:** Start with one prompt. Automate when you are ready.

This order corrects the impression that users must first become YAML workflow authors before ctrlyoke becomes useful.

## Claims and language guardrails

- Prefer **“supported harnesses”** to **“every harness”** in factual body copy. “Every” is acceptable in the aspirational tagline when nearby copy names the supported set.
- Prefer **“consistent”**, **“normalized”**, or **“shared interface”** to **“identical capabilities.”** Permissions, hooks, session behavior, structured events, and MCP support differ between harnesses.
- Do not claim a fixed harness count unless it is checked against the current schema and release. The named harness list is more durable and more useful.
- Describe agents, skills, MCP servers, and hooks as managed or synchronized **from one place**. Some features are exported to harness-native files rather than stored in literally one physical file.
- Describe undo/redo as applying to **workspace file changes captured by ctrlyoke**. It does not reverse arbitrary external side effects or the internal state of a harness.
- Describe history search as searching **saved ctrlyoke workflow output in the current workspace**, not every conversation created directly in every vendor's native client.
- Qualify remote claims with **“when hosted access is configured.”** Network reachability depends on the selected bind address, TLS, and the user's LAN or remote-access setup.
- Avoid unverified exclusivity claims such as **“the only tool”** or **“no other VS Code extension.”** The spell-check joke can keep its personality without making an absolute competitive claim.
- Use **harness** for the AI execution strategy. Reserve **provider** for VS Code API concepts.

## Product evidence map

Use these implementation anchors when refreshing claims:

| Capability                                                                                            | Primary evidence                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt editor, completions, validation, spell check                                                   | [`CodeMirrorEditor.tsx`](../../src/ui/webview-react/components/editor/CodeMirrorEditor.tsx), [`PromptCompletionProvider.ts`](../../src/completions/PromptCompletionProvider.ts), [`CompletionHelpers.ts`](../../src/completions/CompletionHelpers.ts)               |
| Unified output, history replay, diffs, workflow undo/redo                                             | [`OutputSection.tsx`](../../src/ui/webview-react/components/layout/OutputSection.tsx), [`OutputRow.tsx`](../../src/ui/webview-react/components/output/OutputRow.tsx), [`UndoChangesDialog.tsx`](../../src/ui/webview-react/components/output/UndoChangesDialog.tsx) |
| Whole-run navigation and change visualization                                                         | [`OutputMinimap.tsx`](../../src/ui/webview-react/components/output/OutputMinimap.tsx)                                                                                                                                                                               |
| Workflow defaults, step overrides, prompt/script steps, validation, sessions, hooks, MCP, permissions | [`workflow-schema.yaml`](../../schemas/workflow-schema.yaml)                                                                                                                                                                                                        |
| Dynamic final-step loop                                                                               | [`spec-driven-loop.ctrlyoke.yaml`](../../src/templates/workflows/spec-driven-loop.ctrlyoke.yaml), [`dynamic-queue.md`](../../docs/workflows/dynamic-queue.md)                                                                                                       |
| Indexed history search and fallback                                                                   | [`HistorySearchService.ts`](../../src/core/orchestration/HistorySearchService.ts), [`HistorySearchIndexService.ts`](../../src/core/orchestration/HistorySearchIndexService.ts)                                                                                      |
| Hosted browser dashboard, access controls, workspace API, client control, push                        | [`CtrlYokeHostedServer.ts`](../../src/server/CtrlYokeHostedServer.ts), [`HostedWorkspaceViewerService.ts`](../../src/server/HostedWorkspaceViewerService.ts)                                                                                                        |
| Mobile terminal controls                                                                              | [`TerminalControlBar.tsx`](../../src/ui/webview-react/components/output/TerminalControlBar.tsx)                                                                                                                                                                     |
| Agent and skill discovery/synchronization                                                             | [`AgentSkillsManagerSection.tsx`](../../src/ui/webview-react/components/settings/AgentSkillsManagerSection.tsx)                                                                                                                                                     |
| MCP discovery, registry, defaults, and harness export                                                 | [`McpManagerSection.tsx`](../../src/ui/webview-react/components/settings/McpManagerSection.tsx)                                                                                                                                                                     |
| Public overview of current shipped behavior                                                           | [`README.md`](../../README.md)                                                                                                                                                                                                                                      |
