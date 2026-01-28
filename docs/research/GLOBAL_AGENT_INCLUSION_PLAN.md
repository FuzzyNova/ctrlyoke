# Global Custom Agent Inclusion Plan

**Date**: January 28, 2026  
**Status**: Planning Phase  
**Related**: [AgentDiscovery.ts](../../src/utils/AgentDiscovery.ts), [prompt-schema.json](../../schemas/prompt-schema.json)

## Problem Statement

Currently, FlightPath handles custom agents differently across providers:

- **Copilot CLI**: Uses `--agent <name>` flag, works with agents in `.github/agents/` and user prompts directory
- **Claude CLI**: Agent support is BROKEN (issue #9930), `--agent` flag doesn't work with file-based agents
- **Codex CLI**: No agent support at all
- **Copilot Chat**: Cannot programmatically select agents (manual only)

This creates inconsistency, breaks workflows across providers, and requires provider-specific code paths.

## Proposed Solution

**Standardize agent inclusion by embedding agent content directly in prompts**, removing all provider-specific `--agent` flags.

### Core Concept

When a user selects an agent from the dropdown:

1. **Read** the agent file content (`.agent.md`)
2. **Prepend** agent instructions to the prompt
3. **Instruct** the LLM to "be" that agent and execute the user's prompt
4. **Remove** all `--agent` flags from CLI arguments

This mimics what providers do internally - they all ultimately send the agent instructions as part of the system prompt or user message.

---

## Current Architecture Analysis

### Agent Property Flow

The `agent` property from [prompt-schema.json](../../schemas/prompt-schema.json):

```json
"agent": {
  "type": "string",
  "description": "Custom agent to use for this prompt (CLI mode only). Specify ONLY the agent name without file extensions (e.g., 'flightpath-orchestrator' for file 'flightpath-orchestrator.agent.md'). The '.agent' suffix is automatically added. Agents are discovered from .github/agents/ or ~/.copilot/agents/. Chat mode cannot programmatically select agents - users must manually select from dropdown.",
  "pattern": "^[a-zA-Z0-9-_]+$"
}
```

### Files That Reference `agent` Property

Based on grep search results:

#### 1. **Provider buildCliArgs() Methods**

All three CLI providers handle agents in `buildCliArgs()`:

**CopilotCliProvider.ts** (lines 190-197):

```typescript
// Agent handling - use resolved property if available
if (resolvedAgent) {
  const agentName = resolvedAgent.endsWith(".agent")
    ? resolvedAgent
    : `${resolvedAgent}.agent`;
  args.push("--agent", agentName);
  Log.info(`🤖 Using agent: ${agentName}`);
}
```

**ClaudeCliProvider.ts** (lines 156-168):

```typescript
// NOTE: Claude CLI agent support is currently BROKEN (as of v2.1.7)
// Keeping minimal code for future when this is fixed
if (resolvedAgent) {
  Log.warn(
    `⚠️ Claude CLI agent support is currently non-functional (known bug #9930). Agent "${resolvedAgent}" will be ignored.`
  );
  Log.warn(`   See: https://github.com/anthropics/claude-code/issues/9930`);
}
```

**CodexCliProvider.ts**:

- No agent handling at all (Codex has no agent concept)

#### 2. **AgentDiscovery.ts**

Discovers agents from:

- User prompts directory: `%APPDATA%\Code\User\prompts\` (Windows) or `~/.config/Code/User/prompts/` (macOS/Linux)
- Workspace `.github/agents/`
- Workspace `.claude/agents/`

Returns `AgentInfo[]` with:

```typescript
interface AgentInfo {
  name: string; // e.g., "flightpath-orchestrator"
  displayName: string; // e.g., "Flightpath Orchestrator"
  path: string; // Full path to .agent.md file
  source: "user" | "workspace-github" | "workspace-claude";
  supportsCopilotCli: boolean;
  supportsClaudeCli: boolean;
}
```

#### 3. **PropertyResolver.ts** (likely exists)

Resolves the three-tier precedence:

- Prompt-level `agent` property
- Workflow-level `agent` property
- Global setting `flightpath.agent`

Provides `resolvedProperties.agent` to `buildCliArgs()`.

#### 4. **Dashboard UI**

Settings panel and prompt editor show agent dropdown populated from `AgentDiscovery`.

#### 5. **ContextExpander.ts**

Already handles `#file:` references by:

1. Parsing file references from prompt
2. Reading file content
3. Building attachment XML
4. Prepending to prompt

We can use the same pattern for agents!

---

## New Architecture Design

### High-Level Flow

```
User selects agent → PropertyResolver resolves agent name →
AgentExpander reads agent file → Agent content prepended to prompt →
CLI executed WITHOUT --agent flag
```

### Component Changes

#### 1. Create `AgentExpander` Utility (New File)

**Location**: `src/utils/AgentExpander.ts`

**Responsibilities**:

- Read agent file content given agent name
- Format agent content for prepending to prompts
- Handle missing agents gracefully

**API**:

```typescript
export class AgentExpander {
  /**
   * Expand agent reference to include agent instructions in prompt
   * @param agentName Agent name (without .agent.md extension)
   * @param workspaceRoot Workspace root for resolving paths
   * @returns Formatted agent instructions or null if agent not found
   */
  static async expandAgent(
    agentName: string,
    workspaceRoot?: string
  ): Promise<string | null> {
    // 1. Discover agents using AgentDiscovery
    // 2. Find matching agent by name
    // 3. Read agent file content
    // 4. Format as attachment or system instruction
    // 5. Return formatted content
  }
}
```

**Agent Content Format Options**:

**Option A: Attachment-Style XML** (matches ContextExpander pattern):

````xml
<attachment id="agent:flightpath-orchestrator">
Custom Agent: flightpath-orchestrator
```chatagent
[full agent file content]
````

</attachment>

[user's original prompt]

```

**Option B: Direct Instruction** (simpler, more explicit):
```

You are now using the custom agent definition below. Follow its instructions carefully.

---BEGIN AGENT DEFINITION---
[full agent file content]
---END AGENT DEFINITION---

Now execute this task:
[user's original prompt]

```

**Option C: System Prompt Style** (what providers do internally):
```

CUSTOM AGENT ROLE:
[agent content extracted from frontmatter and body]

USER REQUEST:
[user's original prompt]

````

**Recommendation**: Start with **Option B** (Direct Instruction) because:
- Most explicit and clear to LLMs
- Doesn't require XML parsing
- Easy to debug and understand
- Similar to how Copilot CLI likely handles agents internally

#### 2. Modify `CopilotIntegration.buildPromptText()` (Base Class)

**Location**: `src/flightpath/base/CopilotIntegration.ts`

**Current Flow**:
```typescript
protected async buildPromptText(prompt: PromptItem): Promise<string> {
  const expander = new ContextExpander(workspaceRoot);
  return await expander.expandContext(prompt.prompt);
}
````

**New Flow**:

```typescript
protected async buildPromptText(
  prompt: PromptItem,
  resolvedProperties?: ResolvedProperties
): Promise<string> {
  let finalPrompt = prompt.prompt;

  // 1. Expand agent if specified
  const agentName = resolvedProperties?.agent;
  if (agentName) {
    const agentContent = await AgentExpander.expandAgent(
      agentName,
      this.workspaceRoot
    );
    if (agentContent) {
      finalPrompt = `${agentContent}\n\n${finalPrompt}`;
      Log.info(`🤖 Agent "${agentName}" instructions prepended to prompt`);
    } else {
      Log.warn(`⚠️ Agent "${agentName}" not found, continuing without agent`);
    }
  }

  // 2. Expand context references (#file:, @file, etc.)
  const expander = new ContextExpander(this.workspaceRoot);
  finalPrompt = await expander.expandContext(finalPrompt);

  return finalPrompt;
}
```

**Key Decision**: Agent expansion happens BEFORE context expansion because:

- Agent instructions should wrap the entire prompt
- Context attachments are part of the user's request
- Natural reading order: Agent role → User request with attachments

#### 3. Remove `--agent` Flags from All Providers

**CopilotCliProvider.ts** (lines 190-197):

```typescript
// REMOVE THIS BLOCK:
// if (resolvedAgent) {
//   const agentName = resolvedAgent.endsWith(".agent")
//     ? resolvedAgent
//     : `${resolvedAgent}.agent`;
//   args.push("--agent", agentName);
//   Log.info(`🤖 Using agent: ${agentName}`);
// }

// Agent handling is now done via prompt prepending in buildPromptText()
// No CLI flag needed
```

**ClaudeCliProvider.ts** (lines 156-168):

```typescript
// REMOVE THIS BLOCK:
// if (resolvedAgent) {
//   Log.warn(...);
// }

// Agent handling is now done via prompt prepending in buildPromptText()
// Fixes broken --agent flag issue!
```

**CodexCliProvider.ts**:

- No changes needed (already has no agent support)

#### 4. Update PropertyResolver to Pass Agent to buildPromptText()

**Assumption**: PropertyResolver already resolves `agent` property.

**Change**: Ensure `resolvedProperties.agent` is passed to `buildPromptText()`.

#### 5. Update CliIntegration to Pass resolvedProperties

**Location**: `src/flightpath/cli/CliIntegration.ts`

**Current**: buildPromptText() called without resolved properties
**New**: Pass resolvedProperties from workflowContext

```typescript
// When building prompts
const resolvedProperties = workflowContext?.resolvedProperties;
const expandedPrompt = await this.buildPromptText(prompt, resolvedProperties);
```

#### 6. Update Schema Documentation

**Location**: `schemas/prompt-schema.json`

**Current**:

```json
"agent": {
  "type": "string",
  "description": "Custom agent to use for this prompt (CLI mode only). Specify ONLY the agent name..."
}
```

**New**:

```json
"agent": {
  "type": "string",
  "description": "Custom agent to use for this prompt. Specify ONLY the agent name without file extensions (e.g., 'flightpath-orchestrator' for file 'flightpath-orchestrator.agent.md'). The agent's instructions will be prepended to your prompt. Agents are discovered from .github/agents/, .claude/agents/, or user prompts directory. Works with all providers (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat).",
  "pattern": "^[a-zA-Z0-9-_]+$"
}
```

#### 7. Update AgentDiscovery Compatibility Flags (Optional)

**Location**: `src/utils/AgentDiscovery.ts`

**Current**: Agents marked as `supportsCopilotCli` or `supportsClaudeCli`

**New**: All agents support all providers (since we're using prompt prepending)

```typescript
// All agents now work with all providers
const supportsCopilotCli = true;
const supportsClaudeCli = true;
const supportsCodexCli = true; // NEW
const supportsCopilotChat = true; // NEW
```

OR: Remove these flags entirely since they're no longer needed.

---

## Agent File Format Parsing

### Existing Format (Copilot/Claude)

Agent files use frontmatter + markdown:

```chatagent
---
name: flightpath-orchestrator
description: Creates structured FlightPath workflow files
tools: ["search", "fetch", "githubRepo", "usages"]
model: Claude Sonnet 4.5
---

# FlightPath Orchestrator

You are an AI workflow architect...

## Your Purpose

1. **Understand** the user's feature request
2. **Analyze** the codebase structure
...
```

### Parsing Strategy

**Simple Approach** (Recommended for MVP):

- Read entire file content as-is
- Include both frontmatter and body in prepended instructions
- Let the LLM parse the structure naturally

**Advanced Approach** (Future Enhancement):

- Parse frontmatter (YAML between `---`)
- Extract `description`, `tools`, `model`
- Format body with frontmatter context
- Potentially override model if specified in agent

**Recommendation**: Start simple. The LLM can understand the agent format without parsing.

---

## Prompt Template Design

### Key Questions

1. **Where to position agent instructions?**
   - Before the user's prompt (recommended)
   - After the user's prompt (less intuitive)

2. **How to frame the instructions?**
   - Explicit instruction to "be" the agent
   - Implicit inclusion (just prepend content)

3. **Should we reference a "temp file"?**
   - No, just inline the content directly
   - Avoids file system overhead and complexity

### Proposed Template (Option B - Direct Instruction)

```
You are now using the custom agent definition below. Follow its instructions carefully.

---BEGIN AGENT DEFINITION---
[full agent file content, including frontmatter]
---END AGENT DEFINITION---

Now execute this task:
[user's original prompt with expanded context attachments]
```

**Benefits**:

- Clear separation of agent vs user instructions
- Explicit instruction to follow agent definition
- No ambiguity about what to do
- Mirrors how providers likely handle agents internally

### Alternative Template (Option C - System Prompt Style)

```
ROLE:
You are acting as the following custom agent:

[agent content]

TASK:
[user's prompt]
```

**Benefits**:

- More concise
- Natural LLM framing (role → task)

**Drawbacks**:

- Requires parsing frontmatter to extract role description
- More work for MVP

**Recommendation**: Use **Option B** for MVP, consider **Option C** for v2 if needed.

---

## Implementation Plan

### Phase 1: Core Infrastructure

**Files to Create**:

1. `src/utils/AgentExpander.ts` - Agent expansion utility

**Files to Modify**: 2. `src/flightpath/base/CopilotIntegration.ts` - Add agent expansion to buildPromptText() 3. `src/flightpath/cli/CliIntegration.ts` - Pass resolvedProperties to buildPromptText()

**Tasks**:

- [ ] Create `AgentExpander.ts` with `expandAgent()` method
  - [ ] Use AgentDiscovery to find agent file
  - [ ] Read file content with fs.promises.readFile()
  - [ ] Format with "BEGIN/END AGENT DEFINITION" wrapper
  - [ ] Handle missing agents gracefully (return null + log warning)
  - [ ] Add unit tests
- [ ] Modify `CopilotIntegration.buildPromptText()`
  - [ ] Add optional `resolvedProperties` parameter
  - [ ] Call `AgentExpander.expandAgent()` before context expansion
  - [ ] Prepend agent content if found
  - [ ] Log agent usage with emoji 🤖
- [ ] Modify `CliIntegration` to pass `resolvedProperties` to `buildPromptText()`
- [ ] Test with Copilot CLI (should work immediately)

### Phase 2: Remove Provider-Specific Agent Flags

**Files to Modify**:

1. `src/flightpath/cli/copilot/CopilotCliProvider.ts` - Remove `--agent` flag
2. `src/flightpath/cli/claude/ClaudeCliProvider.ts` - Remove broken agent warning
3. `src/flightpath/cli/codex/CodexCliProvider.ts` - No changes (never had agent support)

**Tasks**:

- [ ] Remove `--agent` flag logic from CopilotCliProvider
  - [ ] Delete lines 190-197
  - [ ] Add comment explaining agent handling via prompt prepending
  - [ ] Test with existing agent workflows
- [ ] Remove broken agent warning from ClaudeCliProvider
  - [ ] Delete lines 156-168
  - [ ] Add comment about new agent handling
  - [ ] Test Claude CLI with agents (should now work!)
- [ ] Update CodexCliProvider comments (no code changes)
  - [ ] Document that agents now work via prompt prepending

### Phase 3: Documentation & Schema Updates

**Files to Modify**:

1. `schemas/prompt-schema.json` - Update agent property description
2. `docs/FLIGHTPATH_CUSTOM_TEMPLATES.md` - Update agent documentation
3. `docs/COPILOT_CLI_DESIGN.md` - Remove agent flag references
4. `docs/CLAUDE_CLI_DESIGN.md` - Update broken agent status
5. `src/utils/AgentDiscovery.ts` - Update compatibility documentation

**Tasks**:

- [ ] Update schema description to mention prompt prepending
- [ ] Update docs to reflect new agent handling
- [ ] Remove references to broken Claude agent support
- [ ] Add examples of agent usage with all providers

### Phase 4: UI/UX Updates (Optional)

**Files to Modify**:

1. Dashboard prompt editor - Show agent preview?
2. Settings panel - Update agent selection help text

**Tasks**:

- [ ] Consider showing agent preview in editor when agent selected
- [ ] Update help text to clarify agents work with all providers
- [ ] Test agent dropdown across all providers

### Phase 5: Testing & Validation

**Test Cases**:

1. Copilot CLI with agent
2. Claude CLI with agent (should now work!)
3. Codex CLI with agent (should now work!)
4. Copilot Chat with agent (should work if LLM respects instructions)
5. Agent not found (graceful degradation)
6. Agent + context expansion (#file: references)
7. Workflow-level agent property
8. Prompt-level agent override

**Files to Create/Modify**:

- `src/test/utils/AgentExpander.test.ts` - Unit tests
- `manual-test/agent-*.flightpath.json` - Integration test workflows

---

## Benefits of This Approach

### 1. **Provider Independence**

- Works with ALL providers (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat)
- No reliance on provider-specific flags that may be broken or nonexistent

### 2. **Simplicity**

- Single code path for all providers
- No branching logic in providers
- Easy to debug (just inspect the final prompt)

### 3. **Flexibility**

- Can customize prompt template in one place (AgentExpander)
- Easy to add formatting improvements
- Future: Support agent chaining or multi-agent workflows

### 4. **Fixes Current Bugs**

- Claude CLI agent support now works (bypasses broken `--agent` flag)
- Codex CLI gets agent support for free
- Copilot Chat can use agents programmatically

### 5. **Consistency**

- Agent handling matches context attachment pattern (ContextExpander)
- Unified architecture across all expansion utilities
- Same three-tier precedence system (prompt → workflow → global)

---

## Potential Challenges & Solutions

### Challenge 1: Agent Frontmatter Parsing

**Issue**: Agent files use frontmatter (YAML between `---`) that may confuse LLMs.

**Solution**: Include frontmatter as-is in agent definition block. LLMs understand YAML and markdown. If needed, parse frontmatter in Phase 2.

### Challenge 2: Large Agent Files

**Issue**: Some agents may have long instructions that inflate token count.

**Solution**:

- Log token count when agent is prepended
- Warn if agent + prompt exceeds reasonable size
- Future: Support agent compression or summarization

### Challenge 3: Agent + Context Expansion Order

**Issue**: Does agent content come before or after context attachments?

**Solution**: Agent BEFORE context is correct because:

- Agent defines the role
- Context is part of the user's request
- Natural reading order: Role → Task

### Challenge 4: Provider Model Override

**Issue**: Some agents specify a preferred model in frontmatter. Should we honor it?

**Solution**:

- Phase 1: Ignore model in frontmatter (user-selected model takes precedence)
- Phase 2: Consider parsing frontmatter and using agent's model as fallback
- Respect three-tier precedence: Prompt → Workflow → Agent → Global

### Challenge 5: Testing Without All Providers Installed

**Issue**: Can't test Claude/Codex if not installed.

**Solution**:

- Unit tests can mock file reading and expansion
- Integration tests focus on Copilot CLI first (most stable)
- Community testing for Claude/Codex

---

## Success Metrics

### MVP Success Criteria

- [ ] Agents work with Copilot CLI (no regression)
- [ ] Agents work with Claude CLI (fixing current bug)
- [ ] Agents work with Codex CLI (new feature)
- [ ] No `--agent` flags remain in any provider code
- [ ] AgentExpander has unit tests with >80% coverage
- [ ] Documentation updated to reflect new behavior

### Phase 2 Success Criteria

- [ ] Agents work with Copilot Chat (programmatic selection)
- [ ] Agent file format documented with examples
- [ ] Dashboard shows agent preview when selected
- [ ] All test cases pass

---

## Alternative Approaches Considered

### Alternative 1: Keep Provider-Specific Flags

**Rejected because**:

- Claude CLI flag is broken
- Codex has no agent support
- Copilot Chat can't be automated
- Creates maintenance burden for provider-specific code

### Alternative 2: Use System Prompt Injection

**Rejected because**:

- Not all providers expose system prompt configuration
- Would require provider-specific implementation
- Less portable than prompt prepending

### Alternative 3: Create Temporary Agent File References

**Rejected because**:

- More complex (file system overhead)
- Still requires provider support for file references
- Doesn't solve Claude/Codex limitations
- Less debuggable (need to inspect temp files)

### Alternative 4: Use MCP Tools for Agent Loading

**Rejected because**:

- Overkill for simple agent inclusion
- Requires MCP server running
- Adds latency for agent lookup
- Not needed when we can just prepend content

---

## Open Questions

1. **Should we parse agent frontmatter or include raw?**
   - Recommendation: Include raw for MVP, parse in Phase 2

2. **What's the exact prompt template format?**
   - Recommendation: "BEGIN/END AGENT DEFINITION" wrapper (Option B)

3. **Should agent model override user-selected model?**
   - Recommendation: No, user selection takes precedence

4. **Should we cache agent file content?**
   - Recommendation: Not for MVP (file reads are fast), consider in Phase 2

5. **Should we validate agent file format?**
   - Recommendation: No strict validation, log warnings for malformed files

6. **Should AgentDiscovery.supportsCopilotCli flags be removed?**
   - Recommendation: Yes, all agents work with all providers now

7. **Should we support agent chaining (multiple agents)?**
   - Recommendation: Not for MVP, consider in future (Phase 3+)

---

## Timeline Estimate

### Phase 1: Core Infrastructure (2-3 days)

- Day 1: Create AgentExpander utility + unit tests
- Day 2: Modify CopilotIntegration.buildPromptText()
- Day 3: Testing with Copilot CLI

### Phase 2: Remove Provider Flags (1 day)

- Morning: Remove flags from all providers
- Afternoon: Test with Claude CLI (verify agent now works)

### Phase 3: Documentation (1 day)

- Update schema, docs, code comments

### Phase 4: UI Updates (1 day, optional)

- Dashboard agent preview
- Settings help text

### Phase 5: Testing (1-2 days)

- Integration tests across providers
- Manual testing with real workflows

**Total**: ~6-8 days for full implementation

---

## Next Steps

1. **Get approval** on this plan from team/stakeholders
2. **Create AgentExpander.ts** with basic implementation
3. **Test with simple agent** to validate prompt template
4. **Modify CopilotIntegration** to use AgentExpander
5. **Remove provider flags** and test across providers
6. **Update documentation** to reflect new behavior

---

## References

- [AgentDiscovery.ts](../../src/utils/AgentDiscovery.ts) - Existing agent discovery
- [ContextExpander.ts](../../src/utils/ContextExpander.ts) - Similar expansion pattern
- [prompt-schema.json](../../schemas/prompt-schema.json) - Agent property definition
- [CONTEXT_ATTACHMENT.md](../CONTEXT_ATTACHMENT.md) - File attachment implementation
- [CLAUDE_CLI_DESIGN.md](../CLAUDE_CLI_DESIGN.md) - Claude agent bug details
- [COPILOT_CLI_DESIGN.md](../COPILOT_CLI_DESIGN.md) - Copilot agent flag documentation

---

**END OF PLAN**
