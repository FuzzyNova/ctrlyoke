# ctrlyoke

ctrlyoke is a VS Code extension that automates AI coding assistants through structured YAML/JSON/Markdown workflows. Define multi-step prompt sequences, execute them against any supported harness, and let the AI continue working unattended.

---

## What it does

- **Sequential prompt execution** — define prompts in a YAML or JSON workflow file; ctrlyoke sends them one at a time, waits for each to finish, and advances automatically
- **Script-based validation** — attach an end condition script to any prompt; if the script returns the expected value the step passes, otherwise the AI retries with a configurable retry prompt
- **Harness-agnostic** — switch between seven AI harnesses with one setting; the workflow format, permissions, agent/skill injection, and the output dashboard stay the same
- **Dynamic queue extension** — include `"ctrlyoke"` in `mcpServers` to give the AI MCP tools (`ctrlyoke_append_queue`, `ctrlyoke_queue_status`) so it can extend the workflow queue autonomously
- **User-defined hooks** — attach shell commands to harness lifecycle events (`stop`, `sessionStart`, `preToolUse`, `postToolUse`) per prompt, per workflow, or globally in settings
- **Universal agents and skills** — define agent instruction files once; ctrlyoke discovers them from standard locations (`.github/agents/`, `.claude/agents/`, `.ctrlyoke/agents/`) and injects content into prompts regardless of harness
- **Dashboard with embedded terminal** — a bottom-panel UI with a CodeMirror prompt editor, live xterm.js terminal running the AI CLI directly, streaming output with tool-call visualization, file diff views, undo/redo for workspace changes, and per-run output history

---

## Requirements

- VS Code 1.104.0 or higher
- Node.js 18 or higher
- At least one supported harness installed and authenticated

---

## Supported Harnesses

| Harness ID        | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `copilot-cli`     | GitHub Copilot CLI — log file monitoring, session resumption (default)                |
| `claude-cli`      | Anthropic Claude Code CLI — JSON streaming, hook-based completion                     |
| `codex-cli`       | OpenAI Codex CLI — JSONL events, notify hook                                          |
| `opencode-cli`    | OpenCode CLI — JSONL events, config-file permissions                                  |
| `qwen-cli`        | Qwen Code CLI — JSONL events, log-based session discovery                             |
| `antigravity-cli` | Google Antigravity CLI — plain-text output, hook-based completion, MCP config support |

Set the active harness:

```json
{ "ctrlyoke.harness": "claude-cli" }
```

CLI harnesses run in **interactive** mode (VS Code terminal with live output) or **headless** mode (background process). Set with `ctrlyoke.cliExecutionMode`.

---

## Getting Started

### 1. Open the panel

```
Command Palette → ctrlyoke: Open ctrlyoke Panel
```

The panel opens in the bottom tab area of VS Code.

### 2. Create a workflow

**From a template:**

```
Panel → New Workflow from Template
```

**Manually** — create a `.ctrlyoke.yaml` file in your workspace.

**Simple single prompt** — create a `.prompt.md` file:

```markdown
Analyze @src/auth/login.ts for security issues.
Focus on input validation and authentication logic.
```

### 3. Run

- **Panel** — load a workflow file and click Run
- **Context menu** — right-click any prompt file → Run with ctrlyoke
- **Context menu** — right-click → Queue with ctrlyoke to append to a running workflow

---

## Workflow File Formats

All three formats validate against the same JSON Schema with full IntelliSense in VS Code.

| Format   | Extension                          | Best for                            |
| -------- | ---------------------------------- | ----------------------------------- |
| YAML     | `.ctrlyoke.yaml` / `.ctrlyoke.yml` | Multi-step workflows, human editing |
| JSON     | `.ctrlyoke.json`                   | Programmatic generation, CI/CD      |
| Markdown | `.prompt.md`                       | Single prompts                      |

### Multi-step YAML workflow

```yaml
# Workflow-level defaults — overridden per prompt (three-tier: prompt > workflow > settings)
harness: claude-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "0"
  compareSource: exitCode

steps:
  - name: analyze
    prompt: |
      Analyze @src/ for security vulnerabilities.
      Focus on input validation and authentication.

  - name: implement
    prompt: |
      Fix the issues identified in the analysis.
    resumeSession: true

  - name: verify
    prompt: |
      Verify the fixes are complete and all tests pass.
    endCondition:
      script: npm test
      returns: "0"
      compareSource: exitCode
      maxRetries: 3
      retryPrompt: |
        Tests still failing (attempt {retryCount}/{maxRetries}):
        {scriptOutput}
        Please fix the remaining issues.
```

---

## Prompt Properties

Properties follow a three-tier precedence: **prompt-level → workflow-level → VS Code settings**.

| Property          | Type                                    | Description                                                                                                  |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `prompt`          | `string`                                | Prompt text, or path to a `.prompt.md` / `.txt` file                                                         |
| `name`            | `string`                                | Display label for this step                                                                                  |
| `harness`         | harness ID                              | Override the active harness for this prompt                                                                  |
| `model`           | `string`                                | Model to use (harness-specific format)                                                                       |
| `agent`           | `string`                                | Portable ctrlyoke prompt attachment; resolved into a categorized prompt reference with `<agentInstructions>` |
| `skills`          | `string[]`                              | Portable ctrlyoke prompt attachments resolved into categorized prompt references                             |
| `resumeSession`   | `boolean`                               | Continue the previous prompt's conversation session                                                          |
| `sessionId`       | `string \| number`                      | Resume a session by ID or by prior prompt index                                                              |
| `mcpServers`      | `(string \| McpServerConfig)[] \| null` | MCP servers to inject; `"ctrlyoke"` enables dynamic queue extension                                          |
| `hooks`           | `UserHookConfig[]`                      | Shell commands to run at harness lifecycle events                                                            |
| `endCondition`    | `EndCondition`                          | Validation script with retry configuration                                                                   |
| `priorContext`    | `string \| number[]`                    | Inject prior prompt outputs: `none`, `previous`, `all`, or index array                                       |
| `additionalArgs`  | `string`                                | Extra flags appended to the CLI invocation                                                                   |
| `toolPermissions` | `ToolPermissionsOverride`               | Per-prompt override: `dangerouslyAllowAll`, `allowAll`, `custom`, `passthrough`                              |

### End condition

```yaml
endCondition:
  script: ./scripts/verify.js # file path or shell command
  returns: "true" # expected value
  compareSource: stdout # stdout (default), stderr, exitCode, or auto
  timeout: 60000 # ms
  maxRetries: 3 # -1 = unlimited
  retryPrompt: |
    Validation failed: {error}
    Please fix the issues.
```

### MCP servers

```yaml
# Enable dynamic queue extension (AI can append prompts via MCP tools)
mcpServers:
  - ctrlyoke

# User-defined MCP server alongside the built-in one
mcpServers:
  - ctrlyoke
  - id: my-database
    command: node
    args: [/path/to/db-mcp-server.js]
    env:
      DB_URL: "postgres://localhost/mydb"
    autoApprove: true   # or a list of tool name patterns

# Disable all MCP injection
mcpServers: null
```

The `"ctrlyoke"` shorthand injects the built-in ctrlyoke MCP server, giving the AI access to `ctrlyoke_append_queue` and `ctrlyoke_queue_status`. Include it on the last prompt (or as `finalStep`) to allow autonomous workflow extension.

### Final prompt

`finalStep` is a special prompt that runs after all queued prompts complete. If the AI appended new prompts during the final prompt loop and `"ctrlyoke"` is in `mcpServers`, the executor re-runs the queue then `finalStep` again until no new prompts are added.

```yaml
steps:
  - prompt: "Implement the feature"

finalStep:
  prompt: "Review the work and append follow-up tasks if needed."
  mcpServers:
    - ctrlyoke
```

### Hooks

```yaml
hooks:
  - event: stop
    command: node ./scripts/post-run-notify.js
  - event: sessionStart
    command: node ./scripts/setup.js
```

Supported events: `stop`, `sessionStart`, `preToolUse`, `postToolUse`, `userPromptSubmit` (support varies by harness). Hooks defined here are merged with any hooks already in the harness settings file — existing hooks are preserved.

### Session management

```yaml
steps:
  - name: research
    prompt: "Research the problem"

  - name: implement
    prompt: "Implement the solution"
    resumeSession: true # continue conversation from the previous prompt

  - name: review
    prompt: "Review for edge cases"
    sessionId: 1 # resume the session from prompt index 1
```

See `dev/implemented/SESSION_MANAGEMENT.md` for full details.

### Context references in prompts

The prompt editor provides IntelliSense completions triggered by three characters:

| Trigger | Purpose                                      | Example                             |
| ------- | -------------------------------------------- | ----------------------------------- |
| `@`     | File or directory reference                  | `@src/utils/auth.ts`                |
| `#`     | Current editor selection or workspace symbol | `#MyClass`, `#selection:path:10-20` |
| `~`     | Git-changed file reference                   | `~src/main.ts`                      |

Completions respect `.gitignore` by default (`ctrlyoke.respectGitignoreForCompletions`). They work inside YAML `prompt:` values, JSON `"prompt"` strings, and `.prompt.md` files.

---

## Dashboard

The ctrlyoke panel opens in the VS Code bottom panel area and contains:

**Prompts panel** — draggable prompt list with numbered slots, status indicators, and a prompt counter. Select any prompt to open it in the editor.

**Output panel** — chronological display of CLI output as it streams in, with:

- Tool call visualization (file edits, bash commands, web search, MCP tool calls)
- Inline file diff views for edits the AI makes
- Undo/redo for workspace file changes made during a workflow run
- Per-run output history with replay; re-run any previous workflow run
- Export to markdown

**Embedded terminal** — the AI CLI process runs directly in an xterm.js terminal inside the panel. You watch the AI work in real time. Multiple terminal sessions (AI CLI and shell) are managed with a tab rail.

**Prompt editor** — CodeMirror-based editor with:

- Syntax highlighting and spell check
- `@` / `#` / `~` IntelliSense completions
- Quick pickers for harness, model, agent, and skills
- Properties drawer for workflow-level and prompt-level configuration

---

## Commands

| Command                                 | Description                                           |
| --------------------------------------- | ----------------------------------------------------- |
| `ctrlyoke: Open ctrlyoke Panel`         | Open the dashboard in the bottom panel                |
| `ctrlyoke: New Workflow from Template`  | Create a workflow from a built-in or custom template  |
| `ctrlyoke: New Blank Workflow`          | Clear the dashboard and start with an empty workflow  |
| Editor convert button                   | Write a step prompt to `.ctrlyoke/prompts/`           |
| `ctrlyoke: Run with ctrlyoke`           | Run a prompt file (Explorer / editor context menu)    |
| `ctrlyoke: Load in ctrlyoke`            | Load a prompt file into the dashboard without running |
| `ctrlyoke: Queue with ctrlyoke`         | Append prompts to the end of the active queue         |
| `ctrlyoke: Queue Next with ctrlyoke`    | Insert prompts immediately after the current position |
| `ctrlyoke: Pause Execution`             | Pause a running workflow                              |
| `ctrlyoke: Resume Execution`            | Resume a paused workflow                              |
| `ctrlyoke: Stop Execution`              | Stop and reset the workflow                           |
| `ctrlyoke: Resume Session`              | Resume from a saved session                           |
| `ctrlyoke: Initialize Workspace`        | Set up `.ctrlyoke/` directory structure               |
| `ctrlyoke: Import ctrlyoke Agents`      | Import agent files into the workspace                 |
| `ctrlyoke: Import Workflow Templates`   | Import example workflow templates                     |
| `ctrlyoke: Create End Condition Script` | Scaffold a validation script                          |
| `ctrlyoke: Create New Custom Template`  | Save the current workflow as a reusable template      |
| `ctrlyoke: Show Output Panel`           | Show the CLI output panel                             |

---

## Settings

All settings use the `ctrlyoke.` prefix.

### Core

| Setting                    | Default       | Description                                                 |
| -------------------------- | ------------- | ----------------------------------------------------------- |
| `harness`                  | `copilot-cli` | Active harness                                              |
| `cliExecutionMode`         | `interactive` | `interactive` (terminal) or `headless` (background process) |
| `scriptTimeout`            | `30`          | End condition script timeout in seconds (range: 5–300)      |
| `promptsDirectory`         | `.ctrlyoke`   | Base directory for workflows and scripts                    |
| `maxPromptExecutionTime`   | `10800`       | Max seconds per prompt; -1 = unlimited                      |
| `maxWorkflowExecutionTime` | `86400`       | Max seconds per workflow; -1 = unlimited                    |

### Models

| Setting               | Default                       | Harness         |
| --------------------- | ----------------------------- | --------------- |
| `copilotCliModel`     | `claude-sonnet-4.5`           | Copilot CLI     |
| `claudeCliModel`      | `sonnet`                      | Claude CLI      |
| `codexCliModel`       | `gpt-5.1-codex`               | Codex CLI       |
| `openCodeCliModel`    | `anthropic/claude-sonnet-4-6` | OpenCode CLI    |
| `qwenCliModel`        | `coder-model`                 | Qwen CLI        |
| `antigravityCliModel` | `gemini-3.6-flash-medium`     | Antigravity CLI |

### Tool permissions

| Setting              | Default                                 | Description                                                  |
| -------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `cliToolPermissions` | `allowAll`                              | `dangerouslyAllowAll`, `allowAll`, or `custom`               |
| `cliAllowedTools`    | _(common git, npm, node patterns)_      | Tool allow patterns in `custom` mode — converted per harness |
| `cliDeniedTools`     | _(rm, del, sudo, git push/reset, etc.)_ | Deny patterns — take precedence over allow                   |

### Agents and skills

Workflow `agent` and `skills` fields are portable ctrlyoke prompt attachments,
resolved by `CliPromptPreparer.createCategorizedPromptFiles()` and supplied as
prompt references. Agent content is wrapped in `<agentInstructions>` tags.
The Agents & Skills settings page separately manages optional harness-native
discovery directories; native discovery behavior varies by harness and does
not determine workflow field support.

| Setting                       | Default | Description                                                  |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `defaultAgent`                | `""`    | Default agent file attached to every new workflow            |
| `defaultSkills`               | `[]`    | Default skill files attached to every new workflow           |
| `omitAgentsAndSkillsOnResume` | `true`  | Skip agent/skill injection when resuming an existing session |

### MCP and dynamic queue

| Setting                  | Default | Description                                                                                                 |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| `mcpServers`             | `[]`    | Default MCP servers for workflow prompts. Include `"ctrlyoke"` to enable dynamic queue extension by default |
| `maxQueueSize`           | `100`   | Maximum prompts allowed in the dynamic queue (range: 1–1000)                                                |
| `unlimitedMode`          | `false` | Remove queue size and execution time limits                                                                 |
| `notifyOnQueueExtension` | `true`  | Show a notification when the AI appends prompts to the queue                                                |

### Hooks

| Setting | Default | Description                                                                         |
| ------- | ------- | ----------------------------------------------------------------------------------- |
| `hooks` | `[]`    | Default hooks applied to every workflow (`event`, `command`, optional `timeoutSec`) |

### Retry and validation

| Setting                  | Default      | Description                                             |
| ------------------------ | ------------ | ------------------------------------------------------- |
| `defaultMaxRetries`      | `3`          | Default retry count for end conditions (-1 = unlimited) |
| `defaultRetryPrompt`     | _(template)_ | Default retry message template with placeholders        |
| `defaultPassRetryPrompt` | _(template)_ | Default message template for pass retries               |

### Session and context

| Setting                 | Default | Description                                                  |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `priorContext`          | `none`  | Inject prior outputs: `none`, `previous`, `all`, index array |
| `resumeExistingSession` | `false` | Resume existing chat session for each prompt                 |
| `autoLoadRecentSession` | `true`  | Auto-load the most recent workflow on VS Code startup        |

### Output and history

| Setting                      | Default | Description                                                                                                                                                 |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showCliOutput`              | `true`  | Show CLI output in the Output panel                                                                                                                         |
| `showCliCommand`             | `false` | Show the full CLI invocation in the dashboard                                                                                                               |
| `runs.maxRuns`               | `-1`    | Maximum completed runs retained per workflow lineage; `-1` keeps all runs in run storage                                                                    |
| `storage.runHistoryLocation` | `user`  | `user` keeps project-keyed history under the ctrlyoke state home; `workspace` keeps it beside the repo. This controls locality and durability, not sharing. |
| `enableDiagnosticLogs`       | `false` | Write diagnostic logs to `.ctrlyoke/logs/`                                                                                                                  |

---

## Further Reading

Design documents and implementation notes are in `dev/implemented/`.

| Document                                       | Topic                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `dev/implemented/WORKFLOW_PROPERTIES.md`       | Full prompt property reference                              |
| `dev/implemented/QUEUE_APPEND_FEATURE.md`      | Dynamic queue extension and `finalStep` loop behavior       |
| `dev/implemented/SESSION_MANAGEMENT.md`        | Session resumption across prompts and harnesses             |
| `dev/implemented/HOOKS_EXPOSURE_PLAN.md`       | User-defined hooks: events, merge behavior, harness support |
| `dev/implemented/MCP_SERVERS_PROPERTY_PLAN.md` | `mcpServers` property design and per-harness behavior       |
| `dev/implemented/ADDING_NEW_CLI_HARNESS.md`    | Guide for adding a new CLI harness                          |
| `QUICK_START.md`                               | Five-minute setup walkthrough                               |

---

## Support

- **Issues:** [github.com/FuzzyNova/ctrlyoke/issues](https://github.com/FuzzyNova/ctrlyoke/issues)
- **Email:** support@ctrlyoke.dev
- **Website:** [ctrlyoke.dev](https://ctrlyoke.dev)

---

## License

ctrlyoke is distributed under the commercial license in [LICENSE.md](LICENSE.md).

Third-party runtime dependency notices and attribution information are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
