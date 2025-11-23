# Agent Support Implementation Plan

**Status**: Planning Phase  
**Target**: Enable FlightPath to leverage GitHub Copilot's custom agent system  
**Author**: Nathan + Claude (Prompt Planner mode)  
**Date**: November 23, 2025

---

## Executive Summary

This document outlines the plan to integrate GitHub Copilot's custom agent system into FlightPath, enabling users to specify which specialized agents should handle each step of their automated workflows. Additionally, FlightPath will ship with a built-in "FlightPath Orchestrator" agent that can plan features and create/edit `.flightpath.json` files autonomously.

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

**How Agents Differ from FlightPath's Copilot Instructions:**

| Feature             | Copilot Instructions              | Custom Agents                           |
| ------------------- | --------------------------------- | --------------------------------------- |
| **File Location**   | `.github/copilot-instructions.md` | `.github/agents/*.agent.md`             |
| **Scope**           | Always included (global context)  | Selectively invoked per task            |
| **Purpose**         | Project-wide conventions/patterns | Specialized task-specific personas      |
| **Tool Control**    | No restrictions                   | Can limit tool access                   |
| **Model Selection** | Not specified                     | Can specify preferred model             |
| **Invocation**      | Automatic                         | Explicit via `--agent` or `@agent-name` |

**Key Insight**: Copilot instructions provide baseline knowledge; agents provide specialized execution strategies.

---

## CLI Integration Points

### Current CLI Support (from `copilot --help`)

```bash
--agent <agent>    Specify a custom agent to use, only in prompt mode
```

**Important Notes:**

- Only works in **prompt mode** (non-interactive) - PERFECT for FlightPath!
- FlightPath already uses prompt mode (`-p` flag sends prompts via stdin)
- Agents can also be invoked with `/agent` slash command in interactive mode
- CLI auto-discovers agents from:
  - `.github/agents/` (repository-level)
  - `~/.copilot/agents/` (user-level global agents)

### How FlightPath Uses CLI Currently

```typescript
// Current implementation (simplified)
const args = [
  "--allow-all-tools",
  "--allow-all-paths",
  "--model",
  "claude-sonnet-4.5",
  "--log-dir",
  logDirectory,
];

// Prompt sent via stdin (not -p flag)
spawn("copilot", args, { stdin: promptText });
```

**Adding Agent Support:**

```typescript
// NEW: Add agent flag if specified
if (options.agent) {
  args.push("--agent", options.agent);
}
```

---

## Implementation Plan

### Phase 1: Basic Agent Support (MVP)

**Goal**: Allow users to specify custom agents in their `.flightpath.json` workflows.

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

**Changes needed:**

1. Extract agent from prompt (if specified):

```typescript
// In sendPrompt() method
const options: CopilotCliOptions = {
  addDirs: this.getWorkspaceDirs(),
  model: prompt.model || this.getConfiguredModel(),
  agent: prompt.agent, // NEW: Pass agent to CLI
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
    args.push('--agent', options.agent);
    this.log(`🤖 Using agent: ${options.agent}`);
  }

  // ... rest of implementation ...
}
```

#### 1.4 Update JSON Schema

**File**: `schemas/prompt-schema.json`

Add agent property to prompt definition:

```json
{
  "properties": {
    "prompt": { "type": "string" },
    "model": {
      "type": "string",
      "enum": ["claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "gpt-5"]
    },
    "agent": {
      "type": "string",
      "description": "Custom agent to use for this prompt (e.g., 'flightpath-orchestrator', 'testing-specialist')"
    },
    "endCondition": { ... },
    "newChatSession": { "type": "boolean" },
    "retryPrompt": { "type": "string" },
    "maxRetries": { "type": "integer" },
    "allowDynamicExtension": { "type": "boolean" }
  }
}
```

#### 1.5 Add Configuration Setting (Optional)

**File**: `package.json`

```json
{
  "configuration": {
    "properties": {
      "flightpath.defaultAgent": {
        "type": "string",
        "default": "",
        "description": "Default custom agent to use for all prompts (can be overridden per-prompt)",
        "markdownDescription": "Specify a default custom agent name (e.g., `flightpath-orchestrator`) to use for all prompts unless explicitly overridden in the `.flightpath.json` file."
      }
    }
  }
}
```

```typescript
// In CopilotCommandLineIntegration.ts
private getDefaultAgent(): string | undefined {
  return vscode.workspace
    .getConfiguration("flightpath")
    .get<string>("defaultAgent") || undefined;
}

// Use in sendPrompt():
const options: CopilotCliOptions = {
  agent: prompt.agent || this.getDefaultAgent(),
  // ...
};
```

#### 1.6 Error Handling

Add graceful error handling for missing agents:

```typescript
// If CLI returns error about unknown agent, show helpful message
if (stderr.includes("agent") && stderr.includes("not found")) {
  vscode.window.showErrorMessage(
    `FlightPath: Agent "${options.agent}" not found. ` +
      `Make sure the agent is defined in .github/agents/ or ~/.copilot/agents/`
  );
}
```

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

- **Prompt Files**: `.flightpath.json` or `.prompt.json` in `.flightpath/` directory
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

Add section on agent support:

````markdown
## Custom Agent Support

FlightPath supports GitHub Copilot's custom agent system, allowing you to assign specialized agents to specific workflow steps.

### Using Agents in Workflows

```json
{
  "prompts": [
    {
      "prompt": "Create comprehensive test suite",
      "agent": "testing-specialist"
    },
    {
      "prompt": "Document the new API endpoints",
      "agent": "documentation-expert"
    }
  ]
}
```
````

### FlightPath Orchestrator Agent

FlightPath ships with a built-in "FlightPath Orchestrator" agent that can:

- Plan features as automated workflows
- Create and edit `.flightpath.json` files
- Leverage your custom agents for specialized tasks

**Usage**:

```bash
# In Copilot CLI
copilot --agent flightpath-orchestrator

# Or in VS Code Copilot Chat
@flightpath-orchestrator Plan user authentication feature
```

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

### Key Benefits

1. **Specialized Expertise**: Leverage domain-specific agents for each task
2. **Consistent Quality**: Agents encode team conventions and best practices
3. **Reduced Context Switching**: Different agents for different concerns
4. **Meta-Automation**: Orchestrator agent creates workflows autonomously
5. **Team Collaboration**: Share agent profiles across team members
6. **Extensibility**: Easy to add new agents as team needs evolve

### Use Cases

#### Use Case 1: Full-Stack Feature Development

```json
{
  "prompts": [
    {
      "prompt": "Design database schema for user profiles",
      "agent": "database-architect"
    },
    {
      "prompt": "Implement backend API endpoints",
      "agent": "backend-specialist",
      "newChatSession": false
    },
    {
      "prompt": "Create React components for profile UI",
      "agent": "frontend-developer"
    },
    {
      "prompt": "Write integration tests",
      "agent": "testing-specialist"
    }
  ]
}
```

#### Use Case 2: Documentation Sprint

```json
{
  "prompts": [
    {
      "prompt": "Generate API reference documentation from code",
      "agent": "documentation-expert"
    },
    {
      "prompt": "Create user guides for new features",
      "agent": "technical-writer"
    },
    {
      "prompt": "Update README with installation instructions",
      "agent": "documentation-expert"
    }
  ]
}
```

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

| Scenario                        | Behavior                                       |
| ------------------------------- | ---------------------------------------------- |
| Agent not found                 | CLI error + FlightPath shows helpful message   |
| Agent syntax error              | CLI error + FlightPath suggests validation     |
| Model conflict                  | Prompt-level model takes precedence            |
| No agent specified              | Uses default agent (if configured) or no agent |
| Agent requires unavailable tool | CLI error about tool access                    |

---

## Testing Strategy

### Unit Tests

```typescript
describe("CopilotCommandLineIntegration - Agent Support", () => {
  it("should pass agent flag to CLI when specified", async () => {
    const prompt: PromptItem = {
      prompt: "Test prompt",
      agent: "testing-specialist",
    };

    // Verify --agent flag is included in spawn args
  });

  it("should use default agent when prompt agent is undefined", async () => {
    // Configure flightpath.defaultAgent = 'default-agent'
    // Verify flag is included
  });

  it("should not pass agent flag when agent is undefined and no default", async () => {
    // Verify --agent flag is NOT included
  });
});
```

### Integration Tests

1. **Agent Execution Test**:
   - Create test agent in `.github/agents/test-agent.agent.md`
   - Create workflow using that agent
   - Verify CLI receives correct agent flag
   - Verify agent's instructions are followed

2. **Orchestrator Test**:
   - Ask orchestrator to plan a simple feature
   - Verify it creates valid `.flightpath.json`
   - Verify workflow can execute successfully

3. **Error Handling Test**:
   - Specify non-existent agent
   - Verify error message is helpful

### Manual Testing Checklist

- [ ] Create custom agent in `.github/agents/`
- [ ] Reference agent in `.flightpath.json`
- [ ] Execute workflow and verify agent is used
- [ ] Check CLI logs show agent flag
- [ ] Test FlightPath Orchestrator via Copilot CLI
- [ ] Verify orchestrator creates valid workflows
- [ ] Test default agent configuration
- [ ] Test agent + model override behavior

---

## Future Enhancements

### Phase 4: Additional Bundled Agents (Future)

**flightpath-implementor.agent.md**: Focused on executing implementation tasks with FlightPath awareness

**flightpath-tester.agent.md**: Specialized in creating end condition validation scripts

**flightpath-debugger.agent.md**: Expert in troubleshooting workflow failures and suggesting fixes

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

**Week 1**: Phase 1 (Basic Agent Support)

- Day 1-2: Type definitions, CLI integration
- Day 3-4: JSON schema, configuration settings
- Day 5: Testing and documentation

**Week 2**: Phase 2 (FlightPath Orchestrator)

- Day 1-3: Agent profile creation and refinement
- Day 4: Installation mechanism
- Day 5: Testing and examples

**Week 3**: Phase 3 (Documentation & Polish)

- Day 1-2: Comprehensive documentation
- Day 3-4: Example workflows
- Day 5: User guide and video tutorial

---

## Success Metrics

1. **Adoption**: Percentage of FlightPath users creating custom agents
2. **Orchestrator Usage**: Number of workflows created via orchestrator
3. **Agent Diversity**: Variety of custom agents in the ecosystem
4. **Workflow Complexity**: Average number of agents per workflow
5. **Error Rate**: Frequency of agent-related errors

---

## Conclusion

Adding agent support to FlightPath transforms it from a workflow executor to an intelligent automation orchestrator. The FlightPath Orchestrator agent creates a powerful meta-automation capability where users can ask an AI to plan complex features as automated workflows that leverage specialized AI agents for each step.

This positions FlightPath as a next-generation development tool that bridges human intent, AI planning, and autonomous execution in a seamless, composable system.

**Next Steps**:

1. Review and approve this plan
2. Begin Phase 1 implementation
3. Create FlightPath Orchestrator agent profile
4. Test with real-world workflows
5. Gather user feedback and iterate
