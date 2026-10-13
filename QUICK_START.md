# ctrlyoke Quick Start

ctrlyoke automates AI coding assistants — Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI — through structured prompt workflows you define in YAML, JSON, or Markdown.

---

## Prerequisites

ctrlyoke drives whichever AI CLI tool you have installed. You need at least one:

| Harness           | CLI Tool                       |
| ----------------- | ------------------------------ |
| `copilot-cli`     | `copilot` (GitHub Copilot CLI) |
| `claude-cli`      | `claude` (Claude Code CLI)     |
| `codex-cli`       | `codex` (OpenAI Codex CLI)     |
| `opencode-cli`    | `opencode`                     |
| `qwen-cli`        | Qwen Code CLI                  |
| `antigravity-cli` | `agy` (Google Antigravity CLI) |

Each harness page under `docs/harnesses/` gives its install commands for macOS, Linux, and Windows. Use whichever one you already have. If you have not picked one, ctrlyoke uses the first installed harness in alphabetical order. Pick a specific default harness in **ctrlyoke Settings** inside the dashboard, or set it per-workflow with a root-level `harness:` field.

---

## Step 1: Initialize Your Workspace

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
ctrlyoke: Initialize Workspace
```

This creates a `.ctrlyoke/` directory in your workspace root containing a single
self-ignoring `.gitignore`, so initializing ctrlyoke leaves your worktree clean.

Subdirectories appear only once something needs them:

```
.ctrlyoke/
  prompts/       # single prompts produced by the editor's convert action
  scripts/       # end condition validation scripts
  templates/     # custom workflow templates
  agents/        # agents copied in from the Agents & Skills manager
  skills/        # skills copied in from the Agents & Skills manager
```

Workflow files themselves can live anywhere in your workspace — at the
`.ctrlyoke/` root, or beside the code they operate on.

### Tracking and Save As

**Workflows you build in the dashboard stay on your machine.** Run history is user-scoped by
default, under `<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/`, keyed from the workspace's
resolved `stateRoot`. It is outside the workspace and the harness sandbox because only ctrlyoke
reads it. Most of that work is a conversation, not an artifact, so nothing lands in your commits
by default.

Attachments and prompts remain ephemeral workspace-scoped files under `.ctrlyoke/`: the harness
needs to read them through `@` references inside its workspace sandbox. Set
`storage.runHistoryLocation` to `workspace` when you want run storage beside the repo at
`<stateRoot>/.ctrlyoke/.runs/`; workspace mode still ignores `.runs/`. The setting controls
locality and durability, not sharing. User-level, project-keyed session history is a familiar
pattern from Claude and Codex.

**When a workflow turns out to be worth keeping, use Save As.** It writes a portable copy — the
workflow file plus any assets it depends on — anywhere you choose in the repo. That copy is yours
to commit and share. Save As copies inline attachments into a sibling `<workflow>.assets/`
directory and inlines lone prompt-file bodies. The workflow file and its sibling assets directory
can travel together to another directory or repository. The pair carries generated dependencies
only; references to repository files, committed prompt files, and `.ctrlyoke/scripts/**` still need
the repository they operate on. You can also just write a `.ctrlyoke.yaml` by hand; files you
author are tracked like any other source file.

The generated `.ctrlyoke/.gitignore` ignores `.runs/`, `attachments/`, `prompts/`, logs, temporary
files, and other machine-local runtime data. It does not ignore exported `<workflow>.assets/`
directories. `ensureGitignore` restores missing entries on activation, so editing the file is not
the way to share or retain a run. To share a workflow, save it as a file, as described below.

**Durable workflows** are ordinary files you export with Save As, hand-author anywhere in the
repo, or promote to a template. Templates are the reusable form for workflows you run often; Save
As produces a copy rather than a reusable template.

---

## Step 2: Create Your First Workflow

**From a template (recommended for new users):**

1. Run `ctrlyoke: New Workflow from Template`
2. Choose a template (blank, simple-feature, fix-tests, full-feature)
3. Name and save the file

**From scratch:**

Create a file ending in `.ctrlyoke.yaml` anywhere in your workspace:

```yaml
steps:
  - name: analyze
    prompt: |
      Analyze @src/extension.ts and identify any issues with error handling.

  - name: fix
    prompt: |
      Fix the error handling issues you identified.
    resumeSession: true
```

The simplest possible workflow is a single `.prompt.md` file:

```markdown
Analyze @src/extension.ts and suggest improvements.
```

---

## Step 3: Run a Workflow

**From the Explorer:**

Right-click any `.ctrlyoke.yaml`, `.ctrlyoke.json`, or `.prompt.md` file, open the **Run with
ctrlyoke** submenu, and select **Run with ctrlyoke**. The same submenu is available from the
editor title toolbar.

**From the ctrlyoke panel:**

1. Open the panel: run `ctrlyoke: Open ctrlyoke Panel`
2. Click **Select Prompt File** and choose your workflow
3. Click **Run**

The dashboard shows live output from the AI as each step executes. Use the **Pause**, **Resume**, and **Stop** buttons to control execution.

---

## Workflow File Formats

Three formats are supported. All share the same JSON Schema and the same fields.

**YAML** (`.ctrlyoke.yaml`) — recommended for multi-step workflows:

```yaml
harness: claude-cli
model: sonnet

steps:
  - name: step-1
    prompt: Implement the feature described in @README.md
    endCondition:
      script: npm test
      maxRetries: 3
      retryPrompt: |
        Tests failed with: $endCondition:stderr
        Please fix the failures.

  - name: step-2
    prompt: Update the README to document the new feature.
    resumeSession: true
```

**JSON** (`.ctrlyoke.json`) — for programmatic generation or CI/CD:

```json
{
  "harness": "claude-cli",
  "steps": [{ "prompt": "Analyze the codebase and create a summary." }]
}
```

**Markdown** (`.prompt.md`) — for a single prompt with no configuration:

```markdown
Review @src/utils/SkillExpander.ts for potential bugs and suggest fixes.
```

---

## Choosing and Configuring a Harness

Set the harness in **ctrlyoke Settings** (gear icon in the dashboard) or override it per-workflow:

```yaml
harness: claude-cli # override for this workflow
model: opus # override model for this workflow

steps:
  - prompt: ...
    harness: codex-cli # override for this specific step
    model: gpt-6-sol
```

Each harness supports two execution modes:

- **Interactive** — opens a visible terminal, useful for workflows that require watching or interaction
- **Headless** — runs in the background, captures output without a visible terminal

Switch modes in ctrlyoke Settings or via the `cliExecutionMode` setting.

---

## Appending to a Running Workflow

You can extend a workflow while it is running, paused, or after it completes without clearing history.

1. Right-click any prompt file in the Explorer and open the **Run with ctrlyoke** submenu
2. Select **Queue Steps with ctrlyoke** (appends to the end of the current queue)
3. Or select **Queue Steps Next with ctrlyoke** (inserts immediately after the current step)

These two actions are shown only when the active queue already contains at least one step.

The dashboard shows all output continuously regardless of how many files were queued.

---

## End Conditions

End conditions let ctrlyoke validate each step before moving to the next. If validation fails, ctrlyoke retries with an error-aware prompt:

```yaml
steps:
  - prompt: Fix the failing tests.
    endCondition:
      script: npm test
      maxRetries: 3
      retryPrompt: |
        Tests still failing: $endCondition:stderr
        Fix all failures before continuing.
```

The script runs in an isolated child process. With no comparison configured, it passes when the
script exits with code 0. To compare output explicitly, set `compareSource` to `stdout`, `stderr`,
or `exitCode`, then set `operator` and `expected` (for example, `compareSource: stdout`,
`operator: contains`, `expected: passed`). `$endCondition:stdout`, `$endCondition:stderr`, and
`$endCondition:exitCode` are available in `retryPrompt`; `$preCondition:*` references are available
in both the step and retry prompts.

---

## Command Reference

| Command                                | What It Does                                          |
| -------------------------------------- | ----------------------------------------------------- |
| `ctrlyoke: Open ctrlyoke Panel`        | Open the dashboard sidebar                            |
| `ctrlyoke: Initialize Workspace`       | Create `.ctrlyoke/` directory structure               |
| `ctrlyoke: New Workflow from Template` | Create a workflow from a built-in template            |
| Editor convert button                  | Write a step prompt to `.ctrlyoke/prompts/`           |
| Save As from the dashboard             | Write a portable workflow and bundle its dependencies |
| `ctrlyoke: Run` (editor title bar)     | Run the active workflow file                          |
| `ctrlyoke: Pause Execution`            | Pause after the current step completes                |
| `ctrlyoke: Resume Execution`           | Resume a paused workflow                              |
| `ctrlyoke: Stop Execution`             | Stop and reset the current workflow                   |
| `ctrlyoke: Resume Session`             | Reconnect to an interrupted session                   |
| `ctrlyoke: Show Output Panel`          | Open the ctrlyoke output log                          |

Right-click context menu on workflow files — open the **Run with ctrlyoke** submenu:

| Action                         | Effect                                                                   |
| ------------------------------ | ------------------------------------------------------------------------ |
| Run with ctrlyoke              | Load and immediately run the file                                        |
| Load in ctrlyoke               | Load without running (edit first)                                        |
| Queue Steps with ctrlyoke      | Append to the current workflow queue (shown once it has steps)           |
| Queue Steps Next with ctrlyoke | Insert after the currently running step (shown once the queue has steps) |

---

## Troubleshooting

**Workflow never completes**

Check `.ctrlyoke/logs/ctrlyoke-<harness>-hook-debug.log`. The Stop hook should fire when the AI finishes — if it is not firing, the AI may have exited abnormally or the CLI version changed its output format.

**Wrong harness or model used**

Settings follow three-tier precedence: prompt-level overrides > workflow-level values > the
`defaults.*` settings in `.ctrlyoke/settings.json`. Check that you have not accidentally set a
harness at a level that is being overridden.

**Workflow stuck after a crash**

Inspect the run-storage lineage's `runner.json` if a workflow appears already running. ctrlyoke
checks stale locks on startup; do not remove a lock belonging to a live process. Managed worktree
runs use the initiating checkout's history; opening a worktree directory directly as its own VS
Code workspace gives it its own history.

**Output is missing or incomplete**

Open the run-storage lineage's `run-<timestamp>/workflow.ctrlyoke.json` for the exact run
definition and resumable metadata. Run output is recorded in that run's `events.jsonl`, while
`manifest.json` contains its summary. A home directory under OneDrive or Dropbox synchronizes
user-scoped history, but running the same project simultaneously on two synced machines is
unsupported: PIDs and file locks are machine-local and cannot coordinate across devices.

---

## Further Reading

- `docs/harnesses/index.md` — supported harnesses
- `docs/workflows/session-management.md` — session ID resolution and reuse
- `docs/workflows/dynamic-queue.md` — queue extension details
- `docs/workflows/end-conditions.md` — end condition configuration and examples
