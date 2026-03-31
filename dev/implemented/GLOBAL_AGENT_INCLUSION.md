# Global Custom Agent Inclusion

**Date**: January 28, 2026  
**Implemented**: February 2026  
**Status**: ✅ Fully Implemented  
**Related**: [AgentExpander.ts](../../src/utils/AgentExpander.ts), [AgentDiscovery.ts](../../src/utils/AgentDiscovery.ts), [prompt-schema.json](../../schemas/prompt-schema.json)

## Problem Statement

Previously, FlightPath handled custom agents differently across providers:

- **Copilot CLI**: Used `--agent <name>` flag, worked with agents in `.github/agents/` and user prompts directory
- **Claude CLI**: Agent support was BROKEN (issue #9930), `--agent` flag didn't work with file-based agents
- **Codex CLI**: No agent support at all
- **Copilot Chat**: Cannot programmatically select agents (manual only)

This created inconsistency, broke workflows across providers, and required provider-specific code paths.

## Solution

**Standardized agent inclusion by embedding agent content directly in prompts**, removing all provider-specific `--agent` flags.

When a prompt specifies an agent:

1. **Read** the agent file content (`.agent.md`)
2. **Prepend** agent instructions to the prompt wrapped in `<agentInstructions>` XML tags
3. **Send** the combined prompt — no `--agent` CLI flag needed
4. Works identically with all providers (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat)

---

## Implementation

### New Files Created

#### `src/utils/AgentExpander.ts`

Discovers and reads agent files using `AgentDiscovery`, returning raw file content with frontmatter stripped. Uses TTL-based caching (5 seconds) for the agent discovery list; individual file reads are never cached to prevent stale content.

**API**:

```typescript
export class AgentExpander {
  static async expandAgent(
    agentName: string,
    workspaceRoot?: string
  ): Promise<string | null>;
  static extractFrontmatterName(content: string): string | undefined;
  static getCommandNameSuffix(
    agentName: string,
    workspaceRoot?: string
  ): Promise<string>;
}
```

Returns `null` if the agent is not found (graceful degradation with a warning log).

### Modified Files

#### `src/flightpath/HarnessIntegration.ts` — `buildPromptText()`

Added agent expansion to the base class `buildPromptText()` method:

```typescript
protected async buildPromptText(
  prompt: PromptItem,
  resolvedAgent?: string,
  resolvedSkills?: string[]
): Promise<string>
```

**Expansion order** (order matters):

1. **Context expansion FIRST** (`ContextExpander`) — generates all `<attachment>` blocks
2. **Agent insertion SECOND** (`AgentExpander`) — positions `<agentInstructions>` after attachments
3. **Skill insertion THIRD** (`SkillExpander`) — positions `<skillInstructions>` after agent
4. **User prompt LAST** — remains at the end for maximum LLM weight

**Final prompt structure**:

```
<attachment>file1 content</attachment>
<attachment>file2 content</attachment>

<agentInstructions>
agent definition (frontmatter stripped)
</agentInstructions>

<skillInstructions>
skill definition
</skillInstructions>

User's original prompt text
```

The `insertAgentInstructions()` helper locates the last `</attachment>` tag and inserts the agent block between attachments and the user prompt. If no attachments are present, the agent block is prepended before the entire prompt.

> **Note**: `SkillExpander` integration was added alongside this feature and handles `.skill.md` files the same way.

#### `src/flightpath/harness/copilot/CopilotCliProvider.ts`

Removed `--agent <name>` flag block. Replaced with comment:

```typescript
// Agent handling is now done via prompt prepending in HarnessIntegration.buildPromptText()
// AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
// No --agent CLI flag needed; this works with all providers (Copilot, Claude, Codex).
```

#### `src/flightpath/harness/claude/ClaudeCliProvider.ts`

Removed broken agent warning (GitHub issue #9930). Agent instructions are now injected into the prompt, bypassing the broken `--agent` flag entirely.

#### `src/utils/AgentDiscovery.ts`

Updated compatibility documentation:

```typescript
// All agents now work with all providers via prompt prepending (AgentExpander).
```

### Schema Update

`schemas/prompt-schema.json` — `agent` property description updated to reflect cross-provider support:

```json
"agent": {
  "type": "string",
  "description": "Custom agent to use for this prompt. Specify ONLY the agent name without file extensions (e.g., 'flightpath-orchestrator' for file 'flightpath-orchestrator.agent.md'). The agent's instructions will be prepended to your prompt. Agents are discovered from .github/agents/, .claude/agents/, or user prompts directory. Works with all providers (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat).",
  "pattern": "^[a-zA-Z0-9-_]+$"
}
```

---

## Architecture

### Component Flow

```
User sets agent: in prompt/workflow
    → PropertyResolver resolves agent name (three-tier precedence)
    → HarnessIntegration.buildPromptText()
        → ContextExpander (generates <attachment> blocks)
        → AgentExpander.expandAgent()
            → AgentDiscovery (TTL-cached agent list)
            → fs.readFile (agent .agent.md content, uncached)
            → AgentExpander.stripFrontmatter()
        → insertAgentInstructions() (<agentInstructions> injected)
        → SkillExpander (optional <skillInstructions>)
    → Final prompt sent to CLI/Chat without --agent flag
```

### Agent File Discovery Sources

1. User prompts directory: `%APPDATA%\Code\User\prompts\` (Windows) / `~/.config/Code/User/prompts/` (macOS/Linux)
2. Workspace `.github/agents/`
3. Workspace `.claude/agents/`

### Frontmatter Handling

Agent file frontmatter (`---` blocks) is **stripped** before injection — only the body content is included in `<agentInstructions>`. This keeps the prompt clean and avoids confusing the LLM with raw YAML metadata.

The `extractFrontmatterName()` utility is available for cases where the declared agent name (from frontmatter `name:` field) needs to be resolved independently of the filename.

---

## Benefits

1. **Provider Independence** — Works with ALL providers. No reliance on flags that may be broken or nonexistent.
2. **Fixes Claude CLI bug** — Bypasses the broken `--agent` flag (GitHub issue #9930). Claude CLI agents now work.
3. **New Codex support** — Codex CLI gets agent support for free.
4. **Single code path** — No branching logic in individual providers. `HarnessIntegration` is the single point of control.
5. **Debuggable** — Final prompt structure is easy to inspect.
6. **Consistent** — Matches Copilot's `<modeInstructions>` naming pattern; parallels `ContextExpander`'s `<attachment>` pattern.

---

## Design Decisions

### XML wrapper: `<agentInstructions>`

Semantically specific and LLM-friendly. Mirrors GitHub Copilot's `<modeInstructions>` convention. Clear separation of content types in the final prompt.

### Positioning: After attachments, before user prompt

Natural reading order: Context → Role → Task. Attachments provide files/data the agent may reference; agent instructions define role and behavior; user prompt gets maximum weight by being last.

### Raw content (frontmatter stripped)

Frontmatter metadata is stripped to avoid LLM confusion. The body content is included as-is. No complex parsing needed.

### No temp files

Content is inlined directly into the prompt. Simpler, more debuggable, no file system overhead.

### No model override from agent frontmatter

Agent frontmatter `model:` field is ignored. Three-tier precedence (prompt → workflow → settings) controls model selection. This may be revisited if there is demand for agents to suggest a preferred model as a fallback.
