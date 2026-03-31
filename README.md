# FlightPath 🚀

**One extension. Every AI harness. Fully automated.**

FlightPath is a VS Code extension that lets you automate AI coding assistants — GitHub Copilot CLI, Claude Code, Codex CLI, and Copilot Chat — through structured YAML/JSON/Markdown workflows. Define your prompts once, run them against any harness, and let the AI keep working while you focus on something else.

## 🎯 What Problems Does FlightPath Solve?

### Automate AI harnesses through structured workflows

Rather than manually typing prompts and waiting for responses, FlightPath lets you define multi-step workflows in YAML, JSON, or Markdown. Each prompt runs automatically, waits for the AI to finish, optionally validates the output with a script, and then moves to the next step — all without interaction.

```yaml
prompts:
  - name: analyze
    prompt: |
      Analyze @workspace for security vulnerabilities.
      Focus on input validation and authentication.

  - name: fix
    prompt: |
      Fix the issues identified in the analysis.
    endCondition:
      script: npm test
      returns: "true"
```

### Let AI extend its own workflow

FlightPath supports **dynamic queue extension** — the running AI harness can append new prompts to the queue via MCP tools, allowing it to autonomously plan and continue working on complex tasks without human involvement. Enable it per workflow or globally, with configurable size limits and notifications.

📖 **[Queue Extension Docs](./docs/QUEUE_APPEND_FEATURE.md)**

### Single-source your agents and skills across all harnesses

FlightPath provides a **universal agent and skills system**. Define your agent instructions and skill files once, and FlightPath automatically discovers them from standard locations (`.github/agents/`, `.claude/agents/`, `.flightpath/agents/`, user-level directories). Reference them by name in any workflow — no paths needed.

```yaml
agent: senior-dev
skills:
  - testing-patterns
  - code-review

prompts:
  - prompt: "Refactor the authentication module"
```

FlightPath injects the agent and skill content into each prompt regardless of which harness is running — no harness-specific flags or configuration required.

Use `flightpath.defaultAgent` and `flightpath.defaultSkills` settings to attach agents and skills to every new workflow automatically.

### A unified interface for all AI harnesses

FlightPath is a single mental model for all your AI tools. Switch between harnesses in one setting — everything else (workflow format, permission config, agent/skill attachment, output dashboard) stays the same. No learning a new interface for each tool, no duplicating configurations.

**Supported harnesses:**

| Harness        | Description               |
| -------------- | ------------------------- |
| `copilot-cli`  | GitHub Copilot CLI        |
| `claude-cli`   | Anthropic Claude Code CLI |
| `codex-cli`    | OpenAI Codex CLI          |
| `copilot-chat` | Copilot Chat UI (VS Code) |

All harnesses are first-class citizens — there is no default or fallback hierarchy. Pick the one that fits your workflow.

### Interactive or headless CLI execution

CLI harnesses (`copilot-cli`, `claude-cli`, `codex-cli`) can run in two modes:

- **Interactive** (`cliExecutionMode: interactive`): Opens a VS Code terminal with the live TUI output. You can watch the AI work in real time and abort with Ctrl+C.
- **Headless** (`cliExecutionMode: headless`): Runs silently in the background. Ideal for fully automated pipelines where you don't need to watch output.

Switch modes per-run or set a default in settings.

### Harness-agnostic permission configuration

Every AI harness has its own tool permission syntax. FlightPath unifies this into a single allow/deny list that is automatically converted to the correct format for whichever harness is running. Configure once, works everywhere.

```json
{
  "flightpath.cliToolPermissions": "custom",
  "flightpath.cliAllowedTools": ["read_file", "edit_file", "run_command"],
  "flightpath.cliDeniedTools": ["web_search"]
}
```

### Dashboard with live output and a prompt editor built for large codebases

The FlightPath sidebar panel gives you:

- **Live output streaming** — see CLI output as it arrives, step-by-step progress, and run history
- **Prompt editor** — a full CodeMirror-based editor with syntax highlighting, spell check, and intelligent autocomplete for `#file:` paths and `@` references optimized for large codebases
- **Workflow controls** — pause, resume, stop, and re-run workflows without leaving the panel

---

## 📋 Requirements

- **VS Code**: 1.85.0 or higher
- **Node.js**: 18+ (for end condition scripts and the MCP server)
- **At least one AI harness** installed and authenticated (see below)

### Harness Installation

**GitHub Copilot CLI**: `npm install -g @github/copilot-cli` — requires a GitHub Copilot subscription

**Claude Code CLI**: Follow the [Claude Code installation guide](https://github.com/anthropics/claude-code) — requires an Anthropic API key

**Codex CLI**: Follow the [Codex CLI installation guide](https://github.com/openai/codex-cli) — requires an OpenAI API key

**Copilot Chat**: Install the GitHub Copilot extension in VS Code — requires a GitHub Copilot subscription

---

## 🚀 Getting Started

### 1. Open the FlightPath Panel

```
Command Palette → FlightPath: Open FlightPath Panel
```

Or click the FlightPath icon in the Activity Bar.

### 2. Create a workflow

**Option A** — Use the panel to create a new workflow from a template:

```
Panel → New Workflow from Template
```

**Option B** — Create a `.flightpath.yaml` file manually in your workspace.

**Option C** — Create a simple `.prompt.md` file for a single prompt:

```markdown
Analyze #file:src/extension.ts for potential improvements.

Focus on:

- Code organization
- Type safety
- Error handling
```

### 3. Configure your harness

Set your preferred harness in VS Code settings:

```json
{
  "flightpath.harness": "claude-cli"
}
```

### 4. Run

- **Via the panel**: Load a workflow file into the dashboard and click **Run**
- **Via context menu**: Right-click any prompt file → **Run with FlightPath**
- **Via context menu**: Right-click to **Queue with FlightPath** to append to a running workflow

---

## 📝 Workflow File Formats

FlightPath supports three formats, all validated against the same JSON schema with full IntelliSense in VS Code:

| Format   | Extension                              | Best For                            |
| -------- | -------------------------------------- | ----------------------------------- |
| YAML     | `.flightpath.yaml` / `.flightpath.yml` | Multi-step workflows, human editing |
| JSON     | `.flightpath.json`                     | Programmatic generation, CI/CD      |
| Markdown | `.prompt.md`                           | Single prompts (simplest)           |

### Multi-step YAML workflow

```yaml
# Workflow-level defaults (overridable per prompt)
harness: copilot-cli
model: claude-sonnet-4.5
agent: .flightpath/agents/my-agent.agent.md
endCondition:
  script: npm test
  returns: "true"

prompts:
  - name: analyze
    prompt: |
      Analyze @workspace for security vulnerabilities.

  - name: implement
    prompt: |
      Fix the identified issues.
    resumeSession: true # Continue conversation from previous prompt

  - name: verify
    prompt: |
      Verify the fixes are complete and tests pass.
    endCondition:
      script: .flightpath/scripts/verify.js
      returns: "true"
      maxRetries: 3
      retryPrompt: "Tests still failing: {error}. Please fix."
```

### Session management

Control which prompts share conversation context:

```yaml
prompts:
  - name: research
    prompt: "Research the problem"
    # Starts new session

  - name: implement
    prompt: "Implement the solution"
    sessionId: 1 # Resume session from prompt 1 (numeric reference)

  - name: review
    prompt: "Review for edge cases"
    newChatSession: true # Start completely fresh
```

📖 **[Session Management Guide](./dev/implemented/SESSION_MANAGEMENT.md)**

### Context variables

```yaml
prompt: |
  Review the changes in #file:src/auth/login.ts lines 45-120
  and check against #file:docs/auth-spec.md

  The current selection shows: #selection
```

Supported: `@workspace`, `#file:path`, `#file:path:start-end`, `#selection`, slash commands (`/fix`, `/explain`, `/tests`)

---

## 📋 Available Commands

| Command                                   | Description                                             |
| ----------------------------------------- | ------------------------------------------------------- |
| `FlightPath: Open FlightPath Panel`       | Open the sidebar dashboard                              |
| `FlightPath: New Workflow from Template`  | Create a workflow from a built-in or custom template    |
| `FlightPath: New Blank Workflow`          | Start with an empty workflow                            |
| `FlightPath: New Draft Prompt`            | Create a draft `.prompt.md` file                        |
| `FlightPath: Create Prompt File`          | Create a new prompt file                                |
| `FlightPath: Run with FlightPath`         | Run a prompt file (context menu)                        |
| `FlightPath: Load in FlightPath`          | Load a prompt file without running (context menu)       |
| `FlightPath: Queue with FlightPath`       | Append a prompt file to the active queue (context menu) |
| `FlightPath: Pause Execution`             | Pause a running workflow                                |
| `FlightPath: Resume Execution`            | Resume a paused workflow                                |
| `FlightPath: Stop Execution`              | Stop and reset the workflow                             |
| `FlightPath: Resume Session`              | Resume from a saved session                             |
| `FlightPath: Import FlightPath Agents`    | Import agent files into the workspace                   |
| `FlightPath: Import Workflow Templates`   | Import workflow templates                               |
| `FlightPath: Create End Condition Script` | Scaffold a validation script                            |

---

## 🔧 Key Settings

| Setting                         | Default       | Description                                                              |
| ------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `flightpath.harness`            | `copilot-cli` | Active harness: `copilot-cli`, `claude-cli`, `codex-cli`, `copilot-chat` |
| `flightpath.cliExecutionMode`   | `interactive` | `interactive` (terminal) or `headless` (background)                      |
| `flightpath.cliToolPermissions` | `allowAll`    | `dangerouslyAllowAll`, `allowAll`, or `custom`                           |
| `flightpath.cliAllowedTools`    | `[]`          | Tool allow patterns (converted per harness automatically)                |
| `flightpath.cliDeniedTools`     | `[]`          | Tool deny patterns (take precedence over allow)                          |
| `flightpath.defaultAgent`       | —             | Default agent file attached to every workflow                            |
| `flightpath.defaultSkills`      | `[]`          | Default skill files attached to every workflow                           |
| `flightpath.enableDynamicQueue` | `false`       | Allow the AI to extend the workflow queue via MCP                        |
| `flightpath.scriptTimeout`      | `30`          | End condition script timeout in seconds                                  |
| `flightpath.promptsDirectory`   | `.flightpath` | Base directory for workflows and scripts                                 |

---

📚 **[Quick Start Guide](./QUICK_START.md)** | 📖 **[Session Management](./dev/implemented/SESSION_MANAGEMENT.md)** | 🔧 **[Adding a New Harness](./dev/implemented/ADDING_NEW_CLI_HARNESS.md)**

---

**Enjoy!**
