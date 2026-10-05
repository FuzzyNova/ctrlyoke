# ctrlyoke Core Features and Positioning

**Status:** Living marketing reference  
**Purpose:** Source material for the website, Marketplace listing, README, launch posts, demos, and other marketing copy. This is not a user guide or a complete product specification.

## Positioning in one line

**Category:** Workflow engine and control surface for AI coding CLIs, delivered as a VS Code extension.  
**Core promise:** Keep your prompting habits, reusable toolkit, controls, and history when you switch harnesses.

### Recommended tagline

> **One workflow engine for every CLI coding agent**

### Recommended supporting line

> Prompt, steer, automate, and revisit every AI coding session — one message or a whole workflow.

### VS Code identity

The tagline and supporting line intentionally do not spell out "VS Code extension" — that fact is carried by a small **VS Code Extension** badge placed directly above the hero headline (see `landing/src/pages/index.astro`), using the official Microsoft VS Code icon (`landing/public/icons/vscode.svg`, the "stable" blue mark; `vscode-alt.svg` is the white variant for low-contrast backgrounds — see the branding guidelines at code.visualstudio.com/brand before reusing these elsewhere). Keeping that fact in a badge instead of the headline/subhead leaves both free to carry the harness-CLI-scope and single-prompt-vs-workflow distinctions instead. Any marketing surface that cannot place a badge next to the headline (README, Marketplace description, social copy) should state "VS Code extension" explicitly in its own first line instead of assuming the reader already knows.

This tagline replaces the older **"One interface for every AI coding harness."** That phrasing overclaimed on two axes: "every" harness (ctrlyoke supports six, all CLI-based, by design) and "interface," which undersold that ctrlyoke is a genuine workflow engine, not just a chrome layer. "CLI" replaces "harness" in the headline specifically because ctrlyoke's supported harnesses are all CLIs by design (no GUI-based harness like the removed copilot-chat is supported or planned as a near-term default) — see the guardrail on **CLI vs. harness** below for when to use which word.

The supporting line replaces **"The better way to prompt, steer, automate, and revisit work across Claude Code, Codex, Copilot CLI, and more."** The new version keeps the same four-verb rhythm (prompt/steer/automate/revisit) but drops naming specific CLIs — the harness strip lower on the homepage already shows all six — and adds **"one message or a whole workflow"** to explicitly head off the impression that ctrlyoke is only useful for pre-planned, multi-step automation. Most real usage is a single conversational prompt; the workflow engine is there when a sequence is worth repeating, not a prerequisite for everyday use.

### Useful alternate taglines

- **Switch harnesses, not habits.**
- **Take control of every AI coding harness.**
- **Your prompts. Your workflows. Any harness.**
- **Pilot every AI coding harness from one interface.**
- **One yoke for piloting every AI harness.**
- **Automate your favorite AI coding harness.**

**Switch harnesses, not habits** is the preferred campaign line and the strongest alternative to the main tagline. **Take control of every AI coding harness** is the preferred brand-forward option: it evokes the control-yoke name without becoming too literal. The two pilot/yoke options are useful for playful brand moments, but both require more explanation and should not lead general product positioning. **Automate your favorite AI coding harness** is direct and searchable, but narrower than the product; it works best as campaign copy or the heading of a workflow-focused section. These alternates still use "harness" rather than "CLI" — that's fine for campaign moments and body copy per the guardrail below; only the primary hero tagline needed the more literal, scope-accurate word.

## Elevator pitch

### Short version

ctrlyoke is a VS Code extension and workflow engine for AI coding CLIs. Use one prompt language, one full-featured editor, one output view, and one set of controls whether the work runs through Claude Code, Codex, Copilot CLI, or another supported harness — for a single conversational prompt or a validated multi-step workflow.

### Full version

ctrlyoke is a VS Code extension that gives developers one place to prompt, steer, automate, and revisit work across their AI coding CLIs. It handles harness-specific invocation, session resumption, permissions, MCP servers, hooks, agents, and skills behind a consistent interface — configure your toolkit once and it works across every supported harness instead of being copied by hand into each harness's own config directory. Its prompt editor understands project files, symbols, selections, images, Git changes, prior results, and the size of the expanded context; its dashboard turns harness-specific event streams into a unified, navigable history with diffs and granular undo/redo. Start with one prompt, visually build a validated multi-step workflow, mix harnesses within the same run, take it to CI, or inspect the workspace and steer the live terminal from a phone.

## Messaging hierarchy

Marketing should present ctrlyoke in this order:

1. **One control surface across harnesses** — switch tools without switching mental models.
2. **A better way to write prompts** — rich project context, completions, validation, and spell check.
3. **Visual workflow building with portable files underneath** — compose in the dashboard; save, share, version, and run as YAML or JSON.
4. **A better way to understand and control results** — normalized output, diffs, navigation, history, and undo/redo.
5. **Native CLI interaction plus structured observability** — preserve the real terminal while gaining a control layer around it.
6. **Repeatable automation when it is useful** — reusable workflows, scripts, validation, retries, and dynamic task loops.
7. **The same work wherever it needs to run** — VS Code, an embedded terminal, a browser or phone, the CLI, and CI/CD.
8. **One place for the surrounding ecosystem** — sessions, agents, skills, MCP servers, hooks, and permissions.

This order keeps ctrlyoke relevant to developers who want a better single-prompt experience as well as those who want fully automated workflows.

## Core differentiating features

### 1. One interface across AI coding harnesses

**Customer value:** Choose the best harness for the task without memorizing a new set of flags, configuration files, session commands, permission modes, MCP syntax, and hook behavior every time.

ctrlyoke provides a consistent interface for supported harnesses while translating the details each CLI expects. Harness, model, session behavior, additional arguments, permissions, MCP servers, hooks, agents, and skills can be configured globally, at the workflow level, or for an individual prompt where applicable.

This is not limited to choosing one harness for an entire run. Individual steps can select their own harness and model while remaining in the same queue, output timeline, and saved workflow. A workflow can use one harness to plan, another to implement, and another to review without requiring separate orchestration glue.

**Marketing copy:**

> Stop rebuilding your setup around every AI CLI. ctrlyoke gives Claude Code, Codex, Copilot CLI, OpenCode, Qwen Code, and Antigravity a shared control surface—so switching harnesses does not mean switching habits. Choose one harness for the workflow or the best harness for each individual step.

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

The CodeMirror editor provides context-aware completions, syntax-aware reference chips, reference validation and quick fixes, search, undo/redo, keyboard workflows, and native VS Code theming. It also includes local spell checking.

Its token estimate includes the content behind supported references, not only the words visible in the editor, so developers can see the approximate size of the context they are actually assembling. Clipboard images can be pasted directly into a prompt—including multiple images at once—and become reusable, content-addressed attachments instead of a manual save-and-reference chore. When a harness reports it, live and completed steps also show context-window utilization and detailed token metadata.

**Marketing copy:**

> Prompts are part of the work. Edit them like it—with completions for project context, reference validation, expanded-context token estimates, image paste, search, undo/redo, and, yes, spell check.

**Personality copy:**

> Spell check in a prompt editor. Somehow still a differentiator.

### 4. Build workflows visually and save them as code

**Customer value:** Get the convenience of a visual workflow builder without trapping valuable automation in an opaque project format.

The dashboard can create and edit workflows without requiring hand-authored YAML. Developers can add prompt and script steps, configure workflow-wide defaults and individual overrides, drag pending steps to reorder them, enable or disable steps, copy and paste steps, configure a final step, choose where execution begins, and save or export a clean shareable workflow without runtime state.

Built-in and custom templates make repeatable workflows approachable. Templates can be scoped to a workspace or user, selected as a default, and expose typed inputs such as text, multiline text, files, directories, options, and harness choices. The result is still an ordinary YAML or JSON workflow that can be reviewed, versioned, shared, or run from the CLI.

**Marketing copy:**

> **Build visually. Save as code.** Compose and rearrange workflows in the dashboard, then keep the result as ordinary YAML or JSON that can travel with the project and run anywhere ctrlyoke does.

### 5. One rich, reversible view of every result

**Customer value:** Keep the output experience consistent even when the underlying harness changes.

ctrlyoke normalizes streaming harness output into a chronological view of prompts, responses, reasoning events, shell commands, file operations, web searches, MCP calls, tool calls, status, and token information when the harness supplies it. File edits render as inline diffs with responsive unified or split views.

The output minimap shows the shape of the entire run: each step, its position in the output, and red/green change regions. Developers can jump directly to a step or diff and undo or redo selected files at the individual file-diff, prompt, or whole-workflow level.

**Marketing copy:**

> Different harness underneath. The same clear view on top. Follow the whole run, see every change in context, jump through the minimap, and undo only the work you do not want.

### 6. Keep the native CLI and gain a control room

**Customer value:** Preserve the immediacy and full interactivity of the harness's real terminal without giving up structured, persistent, cross-harness observability.

In interactive mode, ctrlyoke runs the actual AI CLI in an embedded xterm.js terminal. Developers can watch and steer it directly, keep separate AI and shell sessions in a tab rail, and continue using native interactive behavior. At the same time, ctrlyoke captures the run into its normalized output timeline with tool calls, diffs, token details, history, and workflow attribution. Headless mode provides the same orchestration model when no interactive terminal is needed.

**Marketing copy:**

> **Keep the native CLI. Gain a control room.** Steer the real interactive terminal while ctrlyoke builds a structured, searchable, reversible record beside it—or switch to headless execution when no one needs to watch.

### 7. Workflows that grow from simple to sophisticated

**Customer value:** Start with a prompt, then add structure only when the task needs it.

ctrlyoke supports simple Markdown prompts and shareable YAML or JSON workflows. A workflow can mix AI prompt steps with ordinary script steps and can select a different harness or model for each step. Common execution properties can be set once at the workflow level and selectively overridden or disabled for an individual step, including the harness, model, agent, skills, session behavior, prior context, MCP servers, hooks, permissions, validation, and error policy.

Variables and enabled/disabled steps make workflows reusable without forcing every run to be identical.

**Marketing copy:**

> Start with one prompt. Add another step, a test gate, a script, or a different harness when you need it. ctrlyoke scales from quick requests to durable engineering workflows without changing formats halfway through.

### 8. Portable automation, not trapped chat history

**Customer value:** Turn successful ways of working into assets that can be reviewed, versioned, shared, compared, and run again.

Workflows are ordinary YAML, JSON, or Markdown files. Favorite a useful workflow for quick reuse, rerun it with different variables or harnesses, or execute it headlessly with the ctrlyoke CLI in local scripts and CI/CD.

Multiple workflows can run concurrently rather than making unrelated work wait in one global queue. Each retains independent execution state, sessions, terminals, output, and pause, resume, and cancel controls.

**Marketing copy:**

> When a prompt sequence works, keep it. Version it with the code, share it with the team, rerun it with another harness, or move it into CI. Run several independent workflows at once without forcing one task to wait for another.

### 9. Validation based on the project, not the model's confidence

**Customer value:** Let real project state decide what happens next.

Pre-conditions can run a script before a prompt and continue, skip the prompt, or stop the workflow. End conditions run after a prompt and can continue, stop, or retry with structured script output. Standalone script steps bring deterministic commands into the same execution timeline without involving an AI harness.

**Marketing copy:**

> “Looks done” is not a test result. Gate AI work with the scripts your project already trusts, then continue, retry, skip, or stop based on what actually happened.

### 10. Dynamic agentic task loops without an external orchestrator

**Customer value:** Let the workflow discover and schedule follow-up work while preserving an explicit, inspectable queue.

A final step can review the completed run and use ctrlyoke's built-in MCP server to append specific follow-up prompts. ctrlyoke runs the new queue entries and invokes the final step again, creating a controlled plan–implement–review loop until the completion criteria are met.

**Marketing copy:**

> Build the “keep going until it is actually done” loop into the workflow. A final review step can inspect the work, queue the remaining tasks, and run again until there is nothing left to fix.

### 11. Resume conversations without learning every CLI's resume command

**Customer value:** Continue the right conversation while ctrlyoke handles harness-specific session mechanics.

A step can resume the immediately preceding compatible session, refer to the session created by an earlier step, use an exact harness session ID, or continue the latest final-step session. ctrlyoke keeps session reuse harness-aware rather than blindly sending one harness's session ID to another.

**Marketing copy:**

> Continue the conversation you mean. ctrlyoke tracks the session and calls the right harness-specific resume path for you.

### 12. Search, replay, and reuse every run

**Customer value:** Find an earlier decision, command, file change, or answer without remembering which workflow or harness produced it—and return to the complete run around it.

The persistent history index searches more than response prose. It covers prompts, responses and reasoning, shell commands and output, file paths and diffs, tool and MCP activity, web-search results, and status messages. Results link back to the relevant workflow run and step, with a disk-scan fallback if the index is unavailable.

History is not a flat transcript archive. Saved runs use the same ordered event model and rich rendering as live output, so developers can select and replay a run, inspect its structured tool activity and diffs, use available historical undo actions, export it as Markdown, or rerun the underlying workflow.

**Marketing copy:**

> Your AI coding history should be usable. Search for the answer, command, diff, tool call, or prompt you remember; reopen the complete run around it; then export or run the workflow again.

### 13. A browser control room for the entire workspace

**Customer value:** Start a long-running task at the desk and retain meaningful development control from another browser or phone.

The hosted dashboard brings workflows, output, the workspace, source control, and the live terminal to a browser. The workspace viewer can browse and edit files across multi-root workspaces, understand multiple Git repositories, inspect working, staged, stash, and commit diffs, stage or unstage files, discard changes, generate commit messages with a selected harness, commit, pull, push, browse commit history, and check out branches or commits.

Its responsive mobile layout and terminal control bar provide touch-friendly Esc, Tab, arrow, Enter, control-key, and customizable shortcut buttons. Hosted access supports token-protected routes, TLS configuration, LAN/public URL selection, controller handoff between clients, and browser push notifications.

**Marketing copy:**

> Start the task at your desk. From another browser or phone, inspect and edit files, review and commit changes, answer the prompt, or steer the live harness terminal when hosted access is configured.

Remote/LAN access is a Pro feature; localhost browser access remains part of the free product.

### 14. One management surface for agents, skills, MCP servers, and hooks

**Customer value:** Reuse the surrounding AI toolchain instead of maintaining it independently for every harness.

The agents and skills manager discovers definitions across supported locations, distinguishes workspace and user scope, and can save or synchronize copies to ctrlyoke or harness-native directories. The MCP manager discovers local configurations, searches the remote MCP Registry, maintains ctrlyoke's registry, sets workflow defaults, and exports servers to supported harness configurations. Hooks can be defined globally, per workflow, or per prompt and are mapped to supported harness lifecycle events.

**Marketing copy:**

> Your harness may change. Your toolkit should not. Manage reusable agents, skills, MCP servers, hooks, and their workspace or user scope from ctrlyoke.

## Technical differentiator: predictable context delivery

This capability is more useful in product education and technical evaluation than in the primary hero, but it is an important reason ctrlyoke can deliver complex prompts consistently across harnesses.

For a simple prompt, ctrlyoke can use the harness's direct input path. When a prompt includes richer assembled context, ctrlyoke packages that content into clearly categorized files instead of concatenating one enormous terminal command or one undifferentiated document. Categories include:

- agent instructions;
- available skills;
- direct workspace file references;
- prior conversation context;
- expanded selection, symbol, directory, and Git excerpts;
- the user's main prompt.

The harness receives a short ordered instruction that names the available categories and identifies the main prompt as the controlling task. Reference syntax is adapted for each harness. Large generated sections are split conservatively by token and line count; prior context is split at step boundaries, and attachment blocks are kept intact where possible.

This design reduces dependence on shell and terminal command-length limits—especially on Windows—and avoids asking a harness to consume one oversized generated file that exceeds known per-file read limits. It also makes the payload easier for a harness or a human debugging a run to audit: supporting material has an explicit role, and the main request is not buried inside it.

**Marketing copy:**

> **Your prompt arrives organized, not as a blob.** ctrlyoke packages instructions, skills, project files, prior context, excerpts, and the main request into a predictable, harness-aware payload—and splits large sections before per-file limits become the problem.

**Documentation guidance:** Explain this in the context-reference manual rather than requiring users to understand it during onboarding. Show the categorized instruction shape, explain that simple prompts may still use a direct fast path, and position the mechanism as transparent delivery infrastructure rather than new syntax the user must author.

## Supporting strengths worth featuring

These are important supporting benefits even when they do not lead the page:

- **Prior-result injection:** Pass selected earlier output into a fresh session when direct session continuation would overfill the context window.
- **Workspace change safety:** Inspect diffs and selectively restore files instead of treating a run as an all-or-nothing black box.
- **Favorites and run comparison:** Keep useful workflows close and rerun them with different harnesses to compare results.
- **Notifications:** Receive completion and hosted-browser notifications instead of continuously watching a long task.
- **Workspace-aware security:** Scope file operations and hosted workspace access to trusted roots.
- **Rich response rendering:** Render streaming Markdown safely, including highlighted code, images, diagrams, links, and incomplete syntax while a response is still arriving.
- **Harness preflight guidance:** Detect whether supported CLIs are available and show the relevant installation commands when none are ready.
- **AI commit messages:** Generate commit messages from the real Git diff using the selected harness and model from VS Code, the hosted workspace, or the CLI.

## The core story by audience

### Developer trying multiple harnesses

> Keep your workflow and switch the engine—or assign a different engine to each step. ctrlyoke gives every supported harness the same prompt syntax, editor, output view, session controls, and reusable toolkit.

### Developer who mostly sends one prompt at a time

> You do not need to author YAML to benefit from ctrlyoke. Start with the prompt editor, rich context references, image paste, expanded-context token estimates, embedded terminal, normalized output, diffs, undo/redo, and searchable history. Build visually and save a workflow only when a sequence is worth repeating.

### Power user automating long tasks

> Combine prompts and scripts, validate each stage, retry failures with real command output, and let a final review step extend the queue until the task is complete.

### Team or CI/CD user

> Build workflows visually or author them as text, then store the reviewable YAML, JSON, or Markdown beside the code. Share the same execution contract across developers, run workflows in parallel, and execute them headlessly in CI.

### Remote/mobile user

> Keep long-running harnesses on the development machine and use the hosted dashboard to browse and edit the workspace, review and commit changes, respond to prompts, and steer the terminal from another browser or phone.

## Suggested homepage narrative

1. **Badge:** VS Code Extension, placed directly above the headline.
2. **Hero:** One workflow engine for every CLI coding agent.
3. **Subhead:** Prompt, steer, automate, and revisit every AI coding session — one message or a whole workflow.
4. **Harness strip:** Show the supported harnesses early as proof of breadth.
5. **Three primary promises:** One prompt language; one rich output view; one reusable toolkit.
6. **Everyday use:** Demonstrate a single prompt with file, selection, image, Git, and prior-context references plus the expanded-context token estimate.
7. **Visual authoring:** Build and rearrange a workflow in the dashboard, then reveal the clean YAML file underneath.
8. **Native terminal, structured control:** Show the real CLI terminal beside the normalized output timeline.
9. **Control and safety:** Show the output minimap, diffs, history search/replay, and undo/redo.
10. **Automation:** Introduce mixed prompt/script steps, per-step harness choice, parallel workflows, validation, retries, and dynamic final-step loops.
11. **Anywhere:** Show the CLI/CI path and the mobile browser's workspace, source control, output, and terminal surfaces.
12. **Closing CTA:** Start with one prompt. Build visually. Automate when you are ready.

This order corrects the impression that users must first become YAML workflow authors before ctrlyoke becomes useful.

## Claims and language guardrails

- Prefer **“supported harnesses”** to **“every harness”** in factual body copy. “Every” is acceptable in the aspirational tagline when nearby copy names the supported set.
- Prefer **“consistent”**, **“normalized”**, or **“shared interface”** to **“identical capabilities.”** Permissions, hooks, session behavior, structured events, and MCP support differ between harnesses.
- Do not claim a fixed harness count unless it is checked against the current schema and release. The named harness list is more durable and more useful.
- Describe agents, skills, MCP servers, and hooks as managed or synchronized **from one place**. Some features are exported to harness-native files rather than stored in literally one physical file.
- Describe undo/redo as applying to **workspace file changes captured by ctrlyoke**. It does not reverse arbitrary external side effects or the internal state of a harness.
- Describe history search as searching **saved ctrlyoke workflow output in the current workspace**, not every conversation created directly in every vendor's native client.
- Describe categorized prompt delivery as **designed to reduce command-length and per-file truncation risks**, not as a guarantee that every third-party harness or model will always consume every referenced byte.
- Qualify remote claims with **“when hosted access is configured.”** Network reachability depends on the selected bind address, TLS, and the user's LAN or remote-access setup.
- Avoid unverified exclusivity claims such as **“the only tool”** or **“no other VS Code extension.”** The spell-check joke can keep its personality without making an absolute competitive claim.
- Use **harness** for the AI execution strategy. Reserve **provider** for VS Code API concepts.
- **CLI vs. harness:** Use **"CLI coding agent"** in the primary hero tagline and other headline-scale copy where scope precision matters most — it makes the CLI-only, no-GUI-harness boundary explicit without extra qualification. Use **"harness"** everywhere else (body copy, feature descriptions, campaign lines) — it is the established, more specific product term and is still accurate since every current harness is a CLI. Do not treat this as a wholesale terminology swap; only the tagline changed. Where a public page first moves from "coding agent" to "harness", bridge the two with **"Each CLI coding agent you run through ctrlyoke is a harness."** Avoid phrasings like "ctrlyoke calls them harnesses", which make the term sound like a renaming rather than a definition.

## Product evidence map

Use these implementation anchors when refreshing claims:

| Capability                                                                                            | Primary evidence                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt editor, completions, validation, spell check, image paste, expanded-context token estimate     | [`CodeMirrorEditor.tsx`](../../src/ui/webview-react/components/editor/CodeMirrorEditor.tsx), [`EditorFooter.tsx`](../../src/ui/webview-react/components/editor/EditorFooter.tsx), [`useAttachmentTokenCount.ts`](../../src/ui/webview-react/hooks/useAttachmentTokenCount.ts), [`PromptCompletionProvider.ts`](../../src/completions/PromptCompletionProvider.ts)                                      |
| Visual workflow authoring, reordering, templates, variables, and clean save/export                    | [`WorkflowStepsPanel.tsx`](../../src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx), [`WorkflowPropertiesPanel.tsx`](../../src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx), [`TemplateModal.tsx`](../../src/ui/webview-react/components/workflow/TemplateModal.tsx), [`SaveWorkflowDialog.tsx`](../../src/ui/webview-react/components/workflow/SaveWorkflowDialog.tsx) |
| Unified output, history replay, diffs, workflow undo/redo                                             | [`OutputSection.tsx`](../../src/ui/webview-react/components/layout/OutputSection.tsx), [`OutputRow.tsx`](../../src/ui/webview-react/components/output/OutputRow.tsx), [`UndoChangesDialog.tsx`](../../src/ui/webview-react/components/output/UndoChangesDialog.tsx)                                                                                                                                    |
| Native interactive terminal, multiple terminal sessions, and headless mode                            | [`TerminalView.tsx`](../../src/ui/webview-react/components/output/TerminalView.tsx), [`TerminalInstance.tsx`](../../src/ui/webview-react/components/output/TerminalInstance.tsx), [`CliIntegration.ts`](../../src/core/harness/CliIntegration.ts)                                                                                                                                                      |
| Whole-run navigation and change visualization                                                         | [`OutputMinimap.tsx`](../../src/ui/webview-react/components/output/OutputMinimap.tsx)                                                                                                                                                                                                                                                                                                                  |
| Workflow defaults, step overrides, prompt/script steps, validation, sessions, hooks, MCP, permissions | [`workflow-schema.yaml`](../../schemas/workflow-schema.yaml)                                                                                                                                                                                                                                                                                                                                           |
| Parallel workflow instances and independent orchestration state                                       | [`WorkflowOrchestrator.ts`](../../src/core/WorkflowOrchestrator.ts), [`WorkflowInstance.ts`](../../src/core/WorkflowInstance.ts)                                                                                                                                                                                                                                                                       |
| Dynamic final-step loop                                                                               | [`spec-driven-loop.ctrlyoke.yaml`](../../src/templates/workflows/spec-driven-loop.ctrlyoke.yaml), [`dynamic-queue.md`](../../docs/workflows/dynamic-queue.md)                                                                                                                                                                                                                                          |
| Indexed history search, replay, and fallback                                                          | [`HistorySearchService.ts`](../../src/core/orchestration/HistorySearchService.ts), [`HistorySearchIndexService.ts`](../../src/core/orchestration/HistorySearchIndexService.ts), [`OutputHistoryManager.ts`](../../src/core/orchestration/OutputHistoryManager.ts)                                                                                                                                      |
| Categorized, harness-aware prompt delivery and large-content splitting                                | [`CliIntegration.ts`](../../src/core/harness/CliIntegration.ts), [`CliPromptPreparer.ts`](../../src/core/harness/shared/CliPromptPreparer.ts), [`PromptFileSplitter.ts`](../../src/utils/PromptFileSplitter.ts), [`context-files.md`](../../docs/workflows/context-files.md)                                                                                                                           |
| Hosted browser dashboard, workspace editing, Git controls, access controls, client control, and push  | [`CtrlYokeHostedServer.ts`](../../src/server/CtrlYokeHostedServer.ts), [`HostedWorkspaceViewerService.ts`](../../src/server/HostedWorkspaceViewerService.ts), [`WorkspaceViewerModal.tsx`](../../src/ui/webview-react/components/workspace-viewer/WorkspaceViewerModal.tsx), [`WorkspaceSourceControlPane.tsx`](../../src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx) |
| Mobile terminal controls                                                                              | [`TerminalControlBar.tsx`](../../src/ui/webview-react/components/output/TerminalControlBar.tsx)                                                                                                                                                                                                                                                                                                        |
| Agent and skill discovery/synchronization                                                             | [`AgentSkillsManagerSection.tsx`](../../src/ui/webview-react/components/settings/AgentSkillsManagerSection.tsx)                                                                                                                                                                                                                                                                                        |
| MCP discovery, registry, defaults, and harness export                                                 | [`McpManagerSection.tsx`](../../src/ui/webview-react/components/settings/McpManagerSection.tsx)                                                                                                                                                                                                                                                                                                        |
| Public overview of current shipped behavior                                                           | [`README.md`](../../README.md)                                                                                                                                                                                                                                                                                                                                                                         |
