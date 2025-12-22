# Agent Support Implementation Plan

**Status**: Planning Phase  
**Target**: Enable FlightPath CLI mode to leverage GitHub Copilot's custom agent system  
**Author**: Nathan + Claude (Prompt Planner mode)  
**Date**: November 24, 2025

---

## Executive Summary

This document outlines the plan to integrate GitHub Copilot's custom agent system into FlightPath's **CLI mode only**. Due to VS Code API limitations (see `CHAT_MODE_LIMITATIONS.md`), agent selection is not available for Chat mode. Users can specify which specialized agents should handle each step of their automated workflows via the `agent` field in `.flightpath.json` files. Additionally, FlightPath will ship with a built-in "FlightPath Orchestrator" agent that can plan features and create/edit `.flightpath.json` files autonomously.

**Chat Mode Limitation**: Chat mode cannot programmatically select custom agents. The `workbench.action.chat.openagent` command only opens the default Agent mode, not custom agents. Users must manually select their desired agent from the dropdown before running Chat mode workflows.

---

## Understanding Agents vs Chat Modes

### Key Findings from Research

**What They Are:**

- **Chat modes** were renamed to **agents** in October 2025 (functionally identical)
- Agents are specialized AI personas defined in Markdown files with YAML frontmatter
- Located in `.github/agents/*.agent.md` (repo-level) or `~/.copilot/agents/*.agent.md` (user-level)
- Previously: `.github/chatmodes/*.chatmode.md` (deprecated path)

**Agent Capabilities:**

```markdown
---
name: my-specialist
description: Expert in specific domain
model: claude-sonnet-4.5
tools:
  - read
  - search
  - edit
---

Custom instructions and expertise for this agent...
```

### CLI Mode vs Chat Mode

**CLI Mode (FlightPath Default)**:

- ✅ Full programmatic agent selection via `--agent <name>` flag
- ✅ FlightPath can pass agent name directly to Copilot CLI
- ✅ Supports custom agents defined in `.github/agents/` or `~/.copilot/agents/`
- ✅ Agent selection works reliably for automated workflows
- ⚠️ **Agent naming**: File is `my-agent.agent.md`, use name `my-agent` in JSON (`.agent` suffix auto-added)

**Chat Mode (Limited Support)**:

- ❌ **Cannot programmatically select custom agents** (VS Code API limitation)
- ❌ `workbench.action.chat.openagent` only opens default Agent mode
- ⚠️ Users must manually select custom agents from dropdown before running workflows
- ⚠️ FlightPath cannot assign agents per-prompt in Chat mode

**Recommendation**: Use **CLI mode** for workflows requiring custom agent selection. See `CHAT_MODE_LIMITATIONS.md` for detailed explanation of Chat mode restrictions.

---

## CLI Integration Points

### Current CLI Support (from `copilot --help`)

```bash
--agent <agent>    Specify a custom agent to use, only in prompt mode
```

**Why CLI Mode is Perfect for Agent Support:**

- CLI `--agent` flag works in **prompt mode** (non-interactive) - exactly what FlightPath uses!
- FlightPath already sends prompts via stdin to Copilot CLI
- CLI auto-discovers agents from:
  - `.github/agents/` (repository-level, version-controlled)
  - `~/.copilot/agents/` (user-level global agents)
- No VS Code API dependencies - pure command-line integration

### How FlightPath Uses CLI Currently

```typescript
// Current implementation (simplified from CopilotCommandLineIntegration.ts)
const args = [
  "--allow-all-tools",
  "--allow-all-paths",
  "--model",
  selectedModel,
  "--log-dir",
  logDirectory,
];

// Prompt sent via stdin
spawn("copilot", args, { stdin: promptText });
```

**Adding Agent Support (Simple One-Line Addition):**

```typescript
// NEW: Add agent flag if specified in prompt
if (options.agent) {
  args.push("--agent", options.agent);
}
```

That's it! The CLI handles everything else (agent discovery, loading, execution).

---

## Implementation Plan

### Phase 1: Basic Agent Support (MVP) - CLI Mode Only

**Goal**: Allow users to specify custom agents in their `.flightpath.json` workflows (CLI mode execution).

**Scope**: This feature is **CLI mode only**. Chat mode cannot programmatically select custom agents due to VS Code API limitations.

#### 1.1 Update Type Definitions

**File**: `src/types/FlightPathTypes.ts`

```typescript
export interface PromptItem {
  prompt: string;
  model?: string; // Already exists
  agent?: string; // NEW: Agent name to use for this prompt
  endCondition?: EndCondition;
  newChatSession?: boolean;
  retryPrompt?: string;
  maxRetries?: number;
  allowDynamicExtension?: boolean;
}
```

#### 1.2 Update CLI Options Interface

**File**: `src/types/CopilotTypes.ts`

```typescript
export interface CopilotCliOptions {
  addDirs?: string[];
  model?: string;
  resumeSession?: string;
  agent?: string; // NEW: Custom agent name
}
```

#### 1.3 Modify CLI Integration

**File**: `src/flightpath/cli/CopilotCommandLineIntegration.ts`

**Important Discovery**: The Copilot CLI expects agent names with `.agent` suffix:

- **Agent file on disk**: `my-agent.agent.md`
- **CLI expects**: `--agent my-agent.agent`
- **User specifies in JSON**: `"agent": "my-agent"` (FlightPath appends `.agent` automatically)

**Changes needed:**

1. Extract agent from prompt (if specified):

```typescript
// In sendPrompt() method
const options: CopilotCliOptions = {
  addDirs: this.getWorkspaceDirs(),
  model: prompt.model || this.getConfiguredModel(),
  agent: prompt.agent, // NEW: Pass agent to CLI (undefined if not specified)
  resumeSession:
    prompt.newChatSession === false && this.sessionId
      ? this.sessionId
      : undefined,
};
```

2. Add agent flag to CLI args:

```typescript
// In executeCopilotCommand() method
private async executeCopilotCommand(
  prompt: string,
  options: CopilotCliOptions = {}
): Promise<CopilotCliResult> {
  const args: string[] = [];

  // ... existing flags ...

  // NEW: Add agent flag if specified
  if (options.agent) {
    // Copilot CLI expects agent name with .agent suffix (e.g., "my-agent.agent")
    // File on disk: my-agent.agent.md
    // CLI expects: my-agent.agent
    // User specifies: my-agent (we append .agent)
    const agentName = options.agent.endsWith('.agent')
      ? options.agent
      : `${options.agent}.agent`;

    args.push('--agent', agentName);
    this.log(`🤖 Using agent: ${agentName}`);

    // When using --agent, we must use -p flag (not stdin)
    args.push('-p', JSON.stringify(prompt));
  }

  // ... rest of implementation ...
}
}
```

#### 1.4 Update JSON Schema

**File**: `schemas/prompt-schema.json`

Add `agent` property to the `promptItem` definition:

```json
{
  "definitions": {
    "promptItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Optional unique identifier for this prompt..."
        },
        "prompt": {
          "type": "string",
          "description": "The final-form prompt text to send to GitHub Copilot..."
        },
        "model": {
          "type": "string",
          "enum": ["claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "gpt-5", ...],
          "description": "AI model to use for this prompt..."
        },
        "agent": {
          "type": "string",
          "description": "Custom agent to use for this prompt (CLI mode only). Specify the agent name as defined in .github/agents/*.agent.md or ~/.copilot/agents/*.agent.md (e.g., 'flightpath-orchestrator', 'testing-specialist'). Chat mode cannot programmatically select agents - users must manually select from dropdown.",
          "pattern": "^[a-zA-Z0-9-_]+$"
        },
        "newChatSession": {
          "type": "boolean",
          "description": "Whether to start a new chat session..."
        },
        "allowDynamicExtension": {
          "type": "boolean",
          "description": "If true, inject instructions for extending the queue..."
        },
        "endCondition": {
          "$ref": "#/definitions/endCondition"
        }
      },
      "required": ["prompt"]
    }
  }
}
```

**Key Points**:

- Add `agent` property after `model` property
- Use regex pattern to validate agent names (alphanumeric, hyphens, underscores only)
- Include clear description mentioning CLI-only support
- Make it optional (not in `required` array)
- No default value - if not specified, `--agent` flag is not passed to CLI

#### 1.5 Error Handling

Add graceful error handling for missing agents in `CopilotCommandLineIntegration.ts`:

```typescript
// In executeCopilotCommand() method, when processing CLI stderr
private async executeCopilotCommand(
  prompt: string,
  options: CopilotCliOptions = {}
): Promise<CopilotCliResult> {
  // ... existing spawn logic ...

  // Error handling
  if (exitCode !== 0) {
    // Check for agent-specific errors
    if (options.agent && stderr.toLowerCase().includes("agent")) {
      if (stderr.toLowerCase().includes("not found") || stderr.toLowerCase().includes("unknown")) {
        const message = `Agent "${options.agent}" not found. Make sure the agent is defined in:\n` +
                       `• .github/agents/${options.agent}.agent.md (project-level)\n` +
                       `• ~/.copilot/agents/${options.agent}.agent.md (user-level)`;
        vscode.window.showErrorMessage(`FlightPath: ${message}`);
        this.log(`❌ Agent error: ${message}`, "error");
      } else if (stderr.toLowerCase().includes("syntax") || stderr.toLowerCase().includes("invalid")) {
        const message = `Agent "${options.agent}" has syntax errors. Check the agent file's YAML frontmatter.`;
        vscode.window.showErrorMessage(`FlightPath: ${message}`);
        this.log(`❌ Agent syntax error: ${message}`, "error");
      } else {
        this.log(`❌ Agent-related error: ${stderr}`, "error");
      }
    }

    throw new Error(`Copilot CLI failed: ${stderr}`);
  }

  // ... rest of method ...
}
```

**Helpful Error Messages**:

- Agent not found → Suggest correct file paths
- Syntax error → Point to YAML frontmatter validation
- Generic agent error → Show full stderr for debugging

**Logging**:

- Log agent selection with 🤖 emoji when successful
- Log detailed errors when agent fails to load

---

### Chat Mode Behavior (No Implementation Required)

**Important**: The `agent` field in `.flightpath.json` files is **ignored in Chat mode** due to VS Code API limitations.

**Why Chat Mode Cannot Support Agent Selection**:

1. VS Code provides no API to programmatically select custom agents
2. `workbench.action.chat.openagent` only switches to the **default Agent mode**, not custom agents
3. Custom agents appear below a separator in the dropdown and cannot be targeted by commands
4. See `CHAT_MODE_LIMITATIONS.md` for detailed technical explanation

**User Workaround for Chat Mode**:

- Manually select the desired custom agent from the dropdown before running the workflow
- FlightPath will respect the manually-selected agent for all prompts
- Cannot switch agents between prompts in Chat mode workflows

**Recommendation**: Use **CLI mode** (default) for workflows requiring agent selection or agent switching between prompts.

**Implementation Impact**:

- No changes needed to `CopilotChatIntegration.ts`
- Schema allows `agent` field universally (for consistency)
- Documentation should clearly state CLI-only support
- Consider showing a warning if user has `provider: "copilot-chat"` and uses `agent` field

---

### Phase 2: FlightPath Orchestrator Agent

**Goal**: Ship a built-in agent that can plan features and create `.flightpath.json` files.

#### 2.1 Agent Profile Design

**File**: `.github/agents/flightpath-orchestrator.agent.md`

```markdown
---
name: flightpath-orchestrator
description: Specialized agent for planning features as FlightPath automated workflows. Expert in creating and editing .flightpath.json files with proper structure, end conditions, and multi-step automation.
model: claude-sonnet-4.5
tools:
  - read
  - search
  - write
  - edit
---

# FlightPath Orchestrator Agent

You are the **FlightPath Orchestrator**, a specialized AI agent with deep expertise in automated workflow planning and the FlightPath VS Code extension architecture.

## Core Responsibilities

1. **Feature Planning**: Break down complex software features into sequential, testable steps
2. **Workflow Creation**: Design `.flightpath.json` files with optimal prompt sequences
3. **Agent Composition**: Leverage user's custom agents for specialized tasks
4. **Quality Assurance**: Create end conditions for automated validation

## FlightPath Knowledge Base

### Architecture Overview

FlightPath automates GitHub Copilot through structured JSON-based workflows:

- **Prompt Files**: `.flightpath.json` or `.flightpath.yaml` in `.flightpath/` directory
- **Execution Modes**: CLI (default) or Chat window automation
- **Model Selection**: Per-prompt or global configuration
- **Session Management**: Multi-turn conversations with `newChatSession: false`
- **Dynamic Queues**: Copilot can extend workflows during execution
- **End Conditions**: Script-based validation (Python, JavaScript, Bash, Batch)

### JSON Structure

\`\`\`json
{
"prompts": [
{
"prompt": "Step 1: Analyze codebase structure",
"agent": "code-analyzer",
"model": "claude-sonnet-4.5",
"endCondition": {
"script": "check_analysis.js",
"returns": "true",
"timeout": 30000
}
},
{
"prompt": "Step 2: Implement feature based on analysis",
"agent": "implementor",
"newChatSession": false,
"retryPrompt": "Fix failed: {scriptOutput}",
"maxRetries": 3,
"endCondition": {
"script": "run_tests.sh",
"returns": "0"
}
}
]
}
\`\`\`

### Best Practices

1. **Single Responsibility**: Each prompt should have ONE clear objective
2. **Sequential Order**: Dependencies should execute before dependent steps
3. **Clear Acceptance Criteria**: End conditions should be unambiguous
4. **Context Preservation**: Use `newChatSession: false` when steps depend on previous context
5. **Agent Specialization**: Delegate to domain-specific agents when available
6. **Model Selection**: Use haiku for simple tasks, sonnet for complex planning/coding
7. **Retry Logic**: Add retry prompts for validation-heavy steps
8. **File Attachments**: Use `#file:path` syntax for context (auto-attached by FlightPath)

### Available Agents (User's Custom Agents)

When planning workflows, check for available custom agents:

- Testing specialists
- Documentation experts
- Language-specific agents (Python, TypeScript, etc.)
- Domain specialists (API design, database, frontend, etc.)

Assign appropriate agents to matching tasks using the `agent` field.

### End Condition Patterns

**File exists check (Bash)**:
\`\`\`bash
#!/bin/bash
[ -f "path/to/file" ] && echo "true" || echo "false"
\`\`\`

**Test execution (JavaScript)**:
\`\`\`javascript
const { execSync } = require('child_process');
try {
execSync('npm test', { stdio: 'inherit' });
console.log('true');
} catch {
console.log('false');
}
\`\`\`

**Content validation (Python)**:
\`\`\`python
import re
with open('file.ts') as f:
content = f.read()
has_function = bool(re.search(r'function\s+myFunc', content))
print('true' if has_function else 'false')
\`\`\`

## Workflow Planning Process

When asked to plan a feature:

1. **Understand Requirements**: Ask clarifying questions if needed
2. **Analyze Context**: Review codebase structure, existing patterns, tech stack
3. **Break Down Tasks**: Identify logical steps with clear boundaries
4. **Assign Agents**: Match steps to available specialized agents
5. **Create End Conditions**: Define validation scripts for each step
6. **Optimize Execution**: Minimize context switches, preserve session when needed
7. **Generate `.flightpath.json`**: Create properly formatted workflow file
8. **Explain Plan**: Provide rationale for step sequence and agent assignments

## Example Interaction

**User**: "Add user authentication to my Express app"

**Your Response**:

1. Analyze current app structure (routes, database, middleware)
2. Create workflow with steps:
   - Database schema for users (@database-expert agent)
   - Auth middleware implementation (@backend-specialist)
   - Login/register endpoints (@api-designer)
   - Frontend login UI (@frontend-dev)
   - Integration tests (@testing-specialist)
3. Generate `.flightpath/add-authentication.flightpath.json`
4. Each step has validation via end conditions
5. Session continuity where needed (middleware → endpoints)

## Output Format

Always create complete, runnable `.flightpath.json` files. Include:

- Clear step descriptions in prompts
- Agent assignments (when applicable)
- Model selection (haiku vs sonnet)
- End conditions with actual script content
- Retry logic for critical steps
- Session management flags

Focus on creating workflows that are:

- **Executable**: Can run immediately without modification
- **Understandable**: Clear purpose for each step
- **Robust**: Validation and retry logic for reliability
- **Efficient**: Optimal agent/model selection for cost/quality balance
```

#### 2.2 Installation Strategy

**Option A: Bundle with Extension**

Copy agent file to user's workspace on first run:

```typescript
// In extension.ts activation
async function installBuiltInAgents(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const agentDir = path.join(workspaceRoot, ".github", "agents");
  const orchestratorPath = path.join(
    agentDir,
    "flightpath-orchestrator.agent.md"
  );

  // Check if agent already exists
  if (fs.existsSync(orchestratorPath)) return;

  // Copy from extension resources
  const extensionAgentPath = path.join(
    context.extensionPath,
    "resources",
    "agents",
    "flightpath-orchestrator.agent.md"
  );

  await fs.promises.mkdir(agentDir, { recursive: true });
  await fs.promises.copyFile(extensionAgentPath, orchestratorPath);

  vscode.window.showInformationMessage(
    "FlightPath: Installed FlightPath Orchestrator agent in .github/agents/"
  );
}
```

**Option B: Global User Agent**

Install to `~/.copilot/agents/` (available across all repositories):

```typescript
const globalAgentDir = path.join(os.homedir(), ".copilot", "agents");
const orchestratorPath = path.join(
  globalAgentDir,
  "flightpath-orchestrator.agent.md"
);
```

**Recommendation**: Use Option A (workspace-level) so agent is version-controlled with the project.

#### 2.3 Discovery Command

Add command to help users discover available agents:

```typescript
// package.json
{
  "commands": [
    {
      "command": "flightpath.listAgents",
      "title": "List Available Agents",
      "category": "FlightPath"
    }
  ]
}

// Command implementation
vscode.commands.registerCommand('flightpath.listAgents', async () => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const agentDir = path.join(workspaceRoot, '.github', 'agents');
  const agents = await fs.promises.readdir(agentDir);

  const agentList = agents
    .filter(f => f.endsWith('.agent.md'))
    .map(f => `- ${f.replace('.agent.md', '')}`);

  vscode.window.showInformationMessage(
    `Available agents:\n${agentList.join('\n')}`
  );
});
```

---

### Phase 3: Documentation & Examples

#### 3.1 Update README

Add section on agent support with CLI-only clarification:

````markdown
## Custom Agent Support (CLI Mode Only)

FlightPath's **CLI mode** supports GitHub Copilot's custom agent system, allowing you to assign specialized agents to specific workflow steps.

**Important**: Agent selection is only available in CLI mode (the default). Chat mode cannot programmatically select agents due to VS Code API limitations. See `docs/CHAT_MODE_LIMITATIONS.md` for details.

### Using Agents in Workflows

```json
{
  "prompts": [
    {
      "prompt": "Create comprehensive test suite",
      "agent": "testing-specialist",
      "model": "claude-haiku-4.5"
    },
    {
      "prompt": "Document the new API endpoints",
      "agent": "documentation-expert",
      "model": "claude-sonnet-4.5"
    }
  ]
}
```

**Requirements**:

- Set `flightpath.provider` to `"copilot-cli"` (default)
- Define agents in `.github/agents/*.agent.md` or `~/.copilot/agents/*.agent.md`
- Use valid agent names (alphanumeric, hyphens, underscores only)

### Agent Discovery

FlightPath automatically uses the Copilot CLI's agent discovery:

- **Project-level agents**: `.github/agents/my-agent.agent.md` (version-controlled, shared with team)
- **User-level agents**: `~/.copilot/agents/my-agent.agent.md` (global, personal agents)

The CLI will search both locations and load the specified agent automatically.
````

### FlightPath Orchestrator Agent

FlightPath ships with a built-in "FlightPath Orchestrator" agent that can:

- Plan features as automated workflows
- Create and edit `.flightpath.json` files
- Leverage your custom agents for specialized tasks

**Usage with Copilot CLI** (recommended for workflow generation):

```bash
# Use orchestrator to plan a feature workflow
copilot --agent flightpath-orchestrator -p "Plan workflow for adding OAuth2 authentication"

# Orchestrator creates .flightpath/add-oauth2.flightpath.json
# Then execute the generated workflow:
# FlightPath: Take Off → select add-oauth2.flightpath.json
```

**Usage in VS Code Copilot Chat** (interactive planning):

```
@flightpath-orchestrator Plan user authentication feature with email verification
```

**Note**: The orchestrator agent itself can be used in both CLI and Chat modes for interactive planning conversations. However, the `.flightpath.json` workflows it generates will use agent assignments that only work in CLI mode execution.

### Chat Mode Limitation

The `agent` field in `.flightpath.json` files is **ignored when executing workflows in Chat mode**. If you need agent selection:

1. Use CLI mode (default): `flightpath.provider: "copilot-cli"`
2. OR manually select the desired agent in Chat before running the workflow (cannot switch agents mid-workflow)

For automated workflows with multiple agents, **CLI mode is required**.

### Creating Custom Agents

See [GitHub's Custom Agent Documentation](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-custom-agents) for details on creating your own specialized agents.

````

#### 3.2 Example Workflows

**File**: `manual-test/agent-workflow-example.flightpath.json`

```json
{
  "prompts": [
    {
      "prompt": "Analyze the current authentication implementation and identify security gaps",
      "agent": "security-auditor",
      "model": "claude-sonnet-4.5",
      "endCondition": {
        "script": "validate_analysis.js",
        "returns": "true"
      }
    },
    {
      "prompt": "Implement fixes for the identified security issues",
      "agent": "backend-specialist",
      "newChatSession": false,
      "retryPrompt": "Tests failed: {scriptOutput}. Please fix the implementation.",
      "maxRetries": 3,
      "endCondition": {
        "script": "run_security_tests.sh",
        "returns": "0"
      }
    },
    {
      "prompt": "Update documentation to reflect security improvements",
      "agent": "documentation-expert",
      "endCondition": {
        "script": "check_docs.py",
        "returns": "true"
      }
    }
  ]
}
````

---

## Benefits & Use Cases

### Key Benefits (CLI Mode)

1. **Specialized Expertise**: Leverage domain-specific agents for each task in automated workflows
2. **Consistent Quality**: Agents encode team conventions and best practices
3. **Reduced Context Switching**: Different agents for different concerns within a single workflow
4. **Meta-Automation**: Orchestrator agent creates workflows autonomously
5. **Team Collaboration**: Share agent profiles across team members via `.github/agents/`
6. **Extensibility**: Easy to add new agents as team needs evolve
7. **Deterministic Execution**: CLI mode ensures reliable agent selection for each workflow step

### Use Cases

**Note**: All use cases below require **CLI mode execution** (`flightpath.provider: "copilot-cli"`).

#### Use Case 1: Full-Stack Feature Development

```json
{
  "prompts": [
    {
      "prompt": "Design database schema for user profiles with proper indexing and constraints",
      "agent": "database-architect",
      "model": "claude-sonnet-4.5",
      "endCondition": {
        "script": "validate_schema.js",
        "returns": "true"
      }
    },
    {
      "prompt": "Implement backend API endpoints using the database schema from previous step",
      "agent": "backend-specialist",
      "newChatSession": false,
      "endCondition": {
        "script": "npm test -- api",
        "returns": "0"
      }
    },
    {
      "prompt": "Create React components for profile UI with TypeScript types",
      "agent": "frontend-developer",
      "endCondition": {
        "script": "npm run typecheck && npm test -- ui",
        "returns": "0"
      }
    },
    {
      "prompt": "Write comprehensive integration tests for the full feature",
      "agent": "testing-specialist",
      "endCondition": {
        "script": "npm run test:integration",
        "returns": "0"
      }
    }
  ]
}
```

**Why CLI mode**: Each prompt needs a different agent with specialized expertise. Chat mode cannot switch agents programmatically.

#### Use Case 2: Documentation Sprint

```json
{
  "prompts": [
    {
      "prompt": "Generate comprehensive API reference documentation from TypeScript source code",
      "agent": "documentation-expert",
      "model": "claude-sonnet-4.5",
      "endCondition": {
        "script": "check_api_docs_complete.js",
        "returns": "true"
      }
    },
    {
      "prompt": "Create step-by-step user guides for new features with screenshots",
      "agent": "technical-writer",
      "endCondition": {
        "script": "validate_user_guides.py",
        "returns": "true"
      }
    },
    {
      "prompt": "Update README with installation instructions, troubleshooting, and examples",
      "agent": "documentation-expert",
      "endCondition": {
        "script": "test -f README.md && grep -q 'Installation' README.md",
        "returns": "0"
      }
    }
  ]
}
```

**Why CLI mode**: Different documentation tasks benefit from specialized agents (API docs vs user guides vs README).

#### Use Case 3: Meta-Planning

```bash
# User invokes orchestrator to plan a feature
copilot --agent flightpath-orchestrator -p "Plan workflow for adding OAuth2 authentication"

# Orchestrator creates:
# .flightpath/add-oauth2.flightpath.json
# - With appropriate agents assigned to each step
# - End conditions for validation
# - Retry logic for critical steps

# User then executes the generated workflow:
flightpath takeOff .flightpath/add-oauth2.flightpath.json
```

---

## Technical Considerations

### Agent Discovery

CLI automatically discovers agents from:

- `.github/agents/*.agent.md` (repo-level, version-controlled)
- `~/.copilot/agents/*.agent.md` (user-level, global)

FlightPath doesn't need to implement discovery - CLI handles it!

### Agent Naming Conventions

- Use lowercase-with-hyphens: `flightpath-orchestrator`
- Prefix with project/domain: `myapp-database-specialist`
- Avoid special characters (only: `.`, `-`, `_`, `a-z`, `A-Z`, `0-9`)

### Model Selection Priority

When both `agent` and `model` are specified:

```typescript
// Agent profile has: model: claude-sonnet-4.5
// Prompt specifies: model: gpt-5

// CLI behavior: Prompt-level model OVERRIDES agent's default model
```

**Recommendation**: Let agents specify their optimal model; only override if necessary.

### Tool Restrictions

Agents can limit tool access:

```markdown
---
tools:
  - read
  - search
---
```

This prevents agents from accidentally modifying code when they should only analyze.

### Error Handling Matrix

| Scenario                          | CLI Mode Behavior                                       | Chat Mode Behavior                        |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| Agent not found                   | CLI error + FlightPath shows helpful message with paths | ⚠️ Ignored (uses manually selected agent) |
| Agent syntax error                | CLI error + FlightPath suggests validation              | ⚠️ Ignored (uses manually selected agent) |
| Model + agent both specified      | Both applied (prompt-level model takes precedence)      | Only model is applied, agent ignored      |
| No agent specified                | Uses default agent (if configured) or no agent          | Uses manually selected agent              |
| Agent requires unavailable tool   | CLI error about tool access permissions                 | N/A (agent field ignored)                 |
| Agent field in Chat mode workflow | N/A                                                     | ⚠️ Silently ignored (should show warning) |

**Recommendation**: Implement a validation warning in `FlightPathManager` when user has `provider: "copilot-chat"` and workflow contains `agent` fields.

---

## Testing Strategy

### Unit Tests (CLI Mode Only)

```typescript
describe("CopilotCommandLineIntegration - Agent Support", () => {
  it("should pass agent flag to CLI when specified in prompt", async () => {
    const prompt: PromptItem = {
      prompt: "Test prompt",
      agent: "testing-specialist",
    };

    // Verify --agent testing-specialist is included in spawn args
    // Verify log shows: 🤖 Using agent: testing-specialist
  });

  it("should not pass agent flag when agent is undefined", async () => {
    const prompt: PromptItem = { prompt: "Test" };

    // Verify --agent flag is NOT included in args
  });

  it("should show helpful error message when agent not found", async () => {
    const prompt: PromptItem = {
      prompt: "Test",
      agent: "nonexistent-agent",
    };

    // Mock CLI stderr: "agent 'nonexistent-agent' not found"
    // Verify error message includes both .github/agents/ and ~/.copilot/agents/ paths
  });

  it("should handle undefined agent gracefully", async () => {
    const prompt: PromptItem = { prompt: "Test" };

    // Verify --agent flag is NOT included in args when agent is undefined
  });
});
```

### Integration Tests (CLI Mode)

**Test Suite**: `agent-support.test.ts`

1. **Agent Execution Test**:
   - Create test agent in `.github/agents/test-agent.agent.md`
   - Define agent with specific instructions and tool restrictions
   - Create workflow using that agent
   - Execute via CLI mode
   - Verify CLI receives correct `--agent test-agent` flag
   - Verify agent's instructions are reflected in Copilot's output

2. **FlightPath Orchestrator Test**:
   - Invoke: `copilot --agent flightpath-orchestrator -p "Plan simple feature"`
   - Verify orchestrator creates valid `.flightpath.json` file
   - Verify generated workflow is executable
   - Verify workflow includes proper end conditions and retry logic

3. **Error Handling Test**:
   - Specify non-existent agent in workflow
   - Execute and verify:
     - CLI exits with error
     - FlightPath shows error message with helpful paths
     - Error is logged to output panel

4. **Agent + Model Override Test**:
   - Create agent with `model: claude-haiku-4.5` in frontmatter
   - Use agent in prompt with `model: "claude-sonnet-4.5"`
   - Verify CLI receives both `--agent` and `--model` flags
   - Verify prompt-level model takes precedence

### Chat Mode Tests

**Test Suite**: `chat-mode-agent-limitation.test.ts`

1. **Agent Field Ignored Test**:
   - Create workflow with `agent` fields
   - Set `provider: "copilot-chat"`
   - Execute workflow
   - Verify `agent` field is silently ignored
   - Verify workflow uses manually-selected agent (if any)

2. **Warning for Chat + Agent Test** (future enhancement):
   - Create workflow with `agent` fields
   - Set `provider: "copilot-chat"`
   - Verify FlightPath shows warning:
     - "This workflow uses agent assignments, which only work in CLI mode"
     - Suggest switching to CLI mode or removing agent fields

### Manual Testing Checklist

**CLI Mode Tests**:

- [ ] Create custom agent in `.github/agents/my-test-agent.agent.md`
- [ ] Reference agent in `.flightpath.json` workflow
- [ ] Execute workflow with CLI mode (verify `flightpath.provider: "copilot-cli"`)
- [ ] Check output panel shows: `🤖 Using agent: my-test-agent`
- [ ] Verify CLI logs include `--agent my-test-agent` flag
- [ ] Test FlightPath Orchestrator via `copilot --agent flightpath-orchestrator -p "Plan feature"`
- [ ] Verify orchestrator creates valid `.flightpath.json` file
- [ ] Test workflow without agent field (verify `--agent` flag not passed)
- [ ] Test agent + model override behavior (both flags passed to CLI)
- [ ] Test error handling for non-existent agent (helpful error message)
- [ ] Test multi-agent workflow (different agent for each step)

**Chat Mode Tests**:

- [ ] Create workflow with `agent` fields
- [ ] Set `flightpath.provider: "copilot-chat"`
- [ ] Execute workflow
- [ ] Verify agent fields are ignored (workflow uses manually-selected agent)
- [ ] Verify no errors occur (graceful degradation)
- [ ] (Future) Verify warning is shown about agent fields being ignored in Chat mode

**Agent Discovery Tests**:

- [ ] Place agent in `.github/agents/` (project-level)
- [ ] Verify CLI discovers and uses it
- [ ] Place agent in `~/.copilot/agents/` (user-level)
- [ ] Verify CLI discovers and uses it
- [ ] Test name collision (project-level should take precedence)

**Edge Cases**:

- [ ] Agent with invalid YAML frontmatter (syntax error handling)
- [ ] Agent with restricted tools (verify CLI respects restrictions)
- [ ] Empty agent name (should skip agent flag)
- [ ] Agent name with special characters (should be validated by schema)

---

## Future Enhancements

### Phase 4: Default Agent Configuration & Additional Bundled Agents

**When to add**: After Phase 2 (FlightPath Orchestrator) is shipped and users have multiple FlightPath agents to choose from.

**Configuration Setting** (`package.json`):

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "flightpath.defaultAgent": {
          "type": "string",
          "default": "",
          "description": "Default custom agent to use for all CLI mode prompts (can be overridden per-prompt)",
          "markdownDescription": "Specify a default custom agent name (e.g., `flightpath-orchestrator`) to use for all CLI mode prompts unless explicitly overridden in the `.flightpath.json` file. **Note**: This setting only applies to CLI mode. Chat mode requires manual agent selection."
        }
      }
    }
  }
}
```

**Additional Bundled Agents**:

**flightpath-implementor.agent.md**: Focused on executing implementation tasks with FlightPath awareness

**flightpath-tester.agent.md**: Specialized in creating end condition validation scripts

**flightpath-debugger.agent.md**: Expert in troubleshooting workflow failures and suggesting fixes

**Why defer this**: In Phase 1, users only specify agents explicitly when needed. Once we ship bundled agents (Phase 2+), a default agent setting becomes useful for users who want all prompts to use a specific agent unless overridden.

### Phase 5: Agent Marketplace (Future Vision)

- Curated collection of FlightPath-compatible agents
- Community-contributed agents
- One-click installation from marketplace
- Rating and feedback system

### Phase 6: Dynamic Agent Composition (Advanced)

Allow workflows to query available agents and assign dynamically:

```json
{
  "prompts": [
    {
      "prompt": "Analyze code and create tests",
      "agentQuery": {
        "preferredAgents": ["testing-specialist", "qa-expert"],
        "fallback": "default"
      }
    }
  ]
}
```

---

## Implementation Timeline

**Week 1**: Phase 1 (Basic Agent Support - CLI Mode Only)

- Day 1: Type definitions (`FlightPathTypes.ts`, `CopilotTypes.ts`)
- Day 2: CLI integration (`CopilotCommandLineIntegration.ts` - add `--agent` flag support)
- Day 3: JSON schema update (`prompt-schema.json` - add `agent` field with validation)
- Day 4: Configuration setting (`package.json` - add `flightpath.defaultAgent`)
- Day 5: Error handling, logging, and unit tests

**Week 2**: Phase 2 (FlightPath Orchestrator Agent)

- Day 1-2: Agent profile creation (`flightpath-orchestrator.agent.md` with comprehensive instructions)
- Day 3: Installation mechanism (bundle with extension, copy to `.github/agents/` on activation)
- Day 4: Agent discovery command (`flightpath.listAgents`)
- Day 5: Testing orchestrator with real workflow generation

**Week 3**: Phase 3 (Documentation & Polish)

- Day 1: Update README with agent support documentation (CLI-only emphasis)
- Day 2: Create example workflows (`manual-test/agent-workflow-example.flightpath.json`)
- Day 3: Update `CHAT_MODE_LIMITATIONS.md` with agent selection limitation
- Day 4: Integration tests and manual testing checklist
- Day 5: User guide, troubleshooting tips, video tutorial (optional)

**Total Estimated Time**: 3 weeks (15 working days)

**Note**: Removed Chat mode implementation from scope. Future enhancement could add a validation warning when `agent` fields are used with Chat mode.

---

## Success Metrics

1. **Adoption**: Percentage of FlightPath users creating custom agents
2. **Orchestrator Usage**: Number of workflows created via orchestrator
3. **Agent Diversity**: Variety of custom agents in the ecosystem
4. **Workflow Complexity**: Average number of agents per workflow
5. **Error Rate**: Frequency of agent-related errors

---

## Conclusion

Adding agent support to FlightPath's **CLI mode** transforms it from a workflow executor to an intelligent automation orchestrator. The FlightPath Orchestrator agent creates a powerful meta-automation capability where users can ask an AI to plan complex features as automated workflows that leverage specialized AI agents for each step.

This positions FlightPath as a next-generation development tool that bridges human intent, AI planning, and autonomous execution in a seamless, composable system.

**CLI Mode Advantage**: By implementing agent support exclusively in CLI mode, FlightPath provides reliable, deterministic agent selection without the limitations and workarounds required in Chat mode. Users get a production-ready automation system with full control over which specialized agents handle each workflow step.

**Chat Mode Trade-off**: While Chat mode cannot programmatically select agents, users can still manually select a custom agent and run workflows interactively. This is ideal for exploratory work and debugging, while CLI mode handles production automation.

**Next Steps**:

1. ✅ Review and approve this plan
2. ⏳ Begin Phase 1 implementation (CLI integration)
3. ⏳ Create FlightPath Orchestrator agent profile
4. ⏳ Update JSON schema and type definitions
5. ⏳ Test with real-world workflows
6. ⏳ Document limitations and best practices
7. ⏳ Gather user feedback and iterate

**See Also**:

- `CHAT_MODE_LIMITATIONS.md` - Detailed explanation of why agent selection doesn't work in Chat mode
- `COPILOT_CLI_IMPLEMENTATION.md` - CLI integration architecture
- GitHub's [Custom Agent Documentation](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-custom-agents)
