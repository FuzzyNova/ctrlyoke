# FlightPath Quick Start

FlightPath automates AI coding assistants — Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, and Copilot Chat — through structured prompt workflows you define in YAML, JSON, or Markdown.

---

## Prerequisites

FlightPath drives whichever AI CLI tool you have installed. You need at least one:

| Harness        | CLI Tool                              |
| -------------- | ------------------------------------- |
| `copilot-cli`  | `gh` with GitHub Copilot extension    |
| `claude-cli`   | `claude` (Claude Code CLI)            |
| `codex-cli`    | `codex` (OpenAI Codex CLI)            |
| `opencode-cli` | `opencode`                            |
| `qwen-cli`     | Qwen Code CLI                         |
| `gemini-cli`   | `gemini` (Google Gemini CLI)          |
| `copilot-chat` | GitHub Copilot Chat VS Code extension |

The default harness is `copilot-cli`. Change it in **FlightPath Settings** inside the dashboard, or set it per-workflow (see below).

---

## Step 1: Initialize Your Workspace

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
FlightPath: Initialize Workspace
```

This creates the `.flightpath/` directory structure in your workspace root:

```
.flightpath/
  workflows/     # ready-to-run workflow files
  prompts/       # draft single prompts
  scripts/       # end condition validation scripts
  templates/     # custom workflow templates
```

---

## Step 2: Create Your First Workflow

**From a template (recommended for new users):**

1. Run `FlightPath: New Workflow from Template`
2. Choose a template (blank, simple-feature, fix-tests, full-feature)
3. Name and save the file

**From scratch:**

Create a file ending in `.flightpath.yaml` anywhere in your workspace:

```yaml
harness: copilot-cli

prompts:
  - name: analyze
    prompt: |
      Analyze #file:src/app.ts and identify any issues with error handling.

  - name: fix
    prompt: |
      Fix the error handling issues you identified.
    resumeSession: true
```

The simplest possible workflow is a single `.prompt.md` file:

```markdown
Analyze #file:src/app.ts and suggest improvements.
```

---

## Step 3: Run a Workflow

**From the Explorer:**

Right-click any `.flightpath.yaml`, `.flightpath.json`, or `.prompt.md` file and select **Run with FlightPath**.

**From the FlightPath panel:**

1. Open the panel: run `FlightPath: Open FlightPath Panel`
2. Click **Select Prompt File** and choose your workflow
3. Click **Run**

The dashboard shows live output from the AI as each step executes. Use the **Pause**, **Resume**, and **Stop** buttons to control execution.

---

## Workflow File Formats

Three formats are supported. All share the same JSON Schema and the same fields.

**YAML** (`.flightpath.yaml`) — recommended for multi-step workflows:

```yaml
harness: claude-cli
model: claude-sonnet-4-5

prompts:
  - name: step-1
    prompt: Implement the feature described in #file:.flightpath/prompts/spec.prompt.md
    endCondition:
      script: npm test
      returns: "true"
      maxRetries: 3
      retryPrompt: |
        Tests failed with: {stderr}
        Please fix the failures.

  - name: step-2
    prompt: Update the README to document the new feature.
    resumeSession: true
```

**JSON** (`.flightpath.json`) — for programmatic generation or CI/CD:

```json
{
  "harness": "claude-cli",
  "prompts": [{ "prompt": "Analyze the codebase and create a summary." }]
}
```

**Markdown** (`.prompt.md`) — for a single prompt with no configuration:

```markdown
Review #file:src/utils.ts for potential bugs and suggest fixes.
```

---

## Choosing and Configuring a Harness

Set the harness in **FlightPath Settings** (gear icon in the dashboard) or override it per-workflow:

```yaml
harness: claude-cli # override for this workflow
model: claude-opus-4-5 # override model for this workflow

prompts:
  - prompt: ...
    harness: codex-cli # override for this specific step
    model: gpt-5
```

Each harness supports two execution modes:

- **Interactive** — opens a visible terminal, useful for workflows that require watching or interaction
- **Headless** — runs in the background, captures output without a visible terminal

Switch modes in FlightPath Settings or via the `cliExecutionMode` setting.

---

## Appending to a Running Workflow

You can extend a workflow while it is running, paused, or after it completes without clearing history.

1. Right-click any prompt file in the Explorer
2. Select **Queue with FlightPath** (appends to the end of the current queue)
3. Or select **Queue Next with FlightPath** (inserts immediately after the current step)

The dashboard shows all output continuously regardless of how many files were queued.

---

## End Conditions

End conditions let FlightPath validate each step before moving to the next. If validation fails, FlightPath retries with an error-aware prompt:

```yaml
prompts:
  - prompt: Fix the failing tests.
    endCondition:
      script: npm test
      returns: "true"
      maxRetries: 3
      retryPrompt: |
        Tests still failing: {stderr}
        Fix all failures before continuing.
```

The script runs in an isolated child process. The `returns` value is compared against `stdout`. Template variables `{stdout}`, `{stderr}`, `{exitCode}` are available in `retryPrompt`.

---

## Command Reference

| Command                                  | What It Does                                          |
| ---------------------------------------- | ----------------------------------------------------- |
| `FlightPath: Open FlightPath Panel`      | Open the dashboard sidebar                            |
| `FlightPath: Initialize Workspace`       | Create `.flightpath/` directory structure             |
| `FlightPath: New Workflow from Template` | Create a workflow from a built-in template            |
| `FlightPath: Create Prompt File`         | Create a new workflow file                            |
| `FlightPath: New Draft Prompt`           | Create a draft `.prompt.md` in `.flightpath/prompts/` |
| `FlightPath: Run` (editor title bar)     | Run the active workflow file                          |
| `FlightPath: Pause Execution`            | Pause after the current step completes                |
| `FlightPath: Resume Execution`           | Resume a paused workflow                              |
| `FlightPath: Stop Execution`             | Stop and reset the current workflow                   |
| `FlightPath: Resume Session`             | Reconnect to an interrupted session                   |
| `FlightPath: Show Output Panel`          | Open the FlightPath output log                        |

Right-click context menu on workflow files:

| Action                     | Effect                                  |
| -------------------------- | --------------------------------------- |
| Run with FlightPath        | Load and immediately run the file       |
| Load in FlightPath         | Load without running (edit first)       |
| Queue with FlightPath      | Append to the current workflow queue    |
| Queue Next with FlightPath | Insert after the currently running step |

---

## Troubleshooting

**Workflow never completes**

Check `.flightpath/logs/flightpath-<harness>-hook-debug.log`. The Stop hook should fire when the AI finishes — if it is not firing, the AI may have exited abnormally or the CLI version changed its output format.

**Wrong harness or model used**

Settings follow three-tier precedence: prompt-level overrides > workflow-level defaults > VS Code extension settings. Check that you have not accidentally set a harness at a level that is being overridden.

**Workflow stuck after a crash**

Delete the stale runner file at `.flightpath/.queue/<name>.runner.json` if the PID it references is no longer alive. FlightPath checks for stale locks on startup but does not auto-clean mid-session.

**Output is missing or incomplete**

Open `.flightpath/.queue/<name>.flightpath.json` — this is the live working copy of the workflow. Each step's `_runtime` block contains `sessionId`, `startedAt`, `completedAt`, and `responseText` for diagnosis.

---

## Further Reading

- `docs/ADDING_NEW_CLI_HARNESS.md` — adding support for a new AI CLI tool
- `docs/SESSION_MANAGEMENT.md` — session ID resolution and cross-harness validation
- `docs/QUEUE_APPEND_FEATURE.md` — dynamic queue extension details
- `.flightpath/scripts/` — end condition script examples after workspace initialization
