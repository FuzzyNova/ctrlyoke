# Agent & Model Selection Commands for Chat Mode

**Discovery Date**: November 23, 2025  
**Status**: Research findings for Chat mode agent support

---

## Key Chat Commands Discovered

From the 356 available chat commands in VS Code, the following are relevant for programmatic agent and model selection in Chat mode:

### Agent Selection Commands

1. **`workbench.action.chat.assignSelectedAgent`**
   - **Purpose**: Programmatically assign/select an agent in the chat view
   - **Potential use**: Could allow FlightPath to select specific agents before sending prompts in Chat mode
   - **Status**: Needs parameter investigation

2. **`workbench.action.chat.picker.customagents`**
   - **Purpose**: Open custom agent picker UI
   - **Potential use**: Programmatic agent selection via picker
   - **Status**: Needs parameter investigation

3. **`workbench.action.chat.configure.customagents`**
   - **Purpose**: Configure custom agents
   - **Potential use**: Agent management/configuration
   - **Status**: UI command (may not be useful for automation)

4. **`workbench.action.chat.toggleAgentMode`**
   - **Purpose**: Toggle agent mode on/off
   - **Potential use**: Enable/disable agent mode programmatically
   - **Status**: Needs investigation

### Model Selection Commands

1. **`workbench.action.chat.changeModel`** ✅ **CONFIRMED WORKING**
   - **Purpose**: Change the AI model in chat
   - **Status**: ✅ Successfully tested and confirmed working
   - **Parameter Format**:
     ```typescript
     {
       vendor: "copilot",
       family: "model-family",  // e.g., "claude-sonnet-4.5", "gpt-5"
       id: "model-id"           // Same as family (NOT "copilot/model-name")
     }
     ```
   - **Example**:
     ```typescript
     await vscode.commands.executeCommand("workbench.action.chat.changeModel", {
       vendor: "copilot",
       family: "claude-sonnet-4.5",
       id: "claude-sonnet-4.5",
     });
     ```
   - **Key Finding**: The `id` field is just the model name (e.g., `claude-sonnet-4.5`), NOT `copilot/claude-sonnet-4.5` as some documentation suggests

---

## Implications for FlightPath Chat Mode

### Current Chat Integration Architecture

FlightPath's Chat mode (`CopilotChatIntegration`) currently:

1. Opens chat panel/tab/window
2. Sets prompt text via `workbench.action.chat.submit` or text insertion
3. Relies on UI automation and polling for response detection

### Potential Enhancements with Agent Commands

If `workbench.action.chat.assignSelectedAgent` accepts parameters (agent name), FlightPath could:

```typescript
// BEFORE sending prompt in Chat mode:
await vscode.commands.executeCommand(
  "workbench.action.chat.assignSelectedAgent",
  "flightpath-orchestrator" // Agent name parameter?
);

// THEN send prompt as usual
await vscode.commands.executeCommand(
  "workbench.action.chat.submit",
  promptText
);
```

For model selection (CONFIRMED WORKING):

```typescript
// Select model programmatically BEFORE sending prompt
await vscode.commands.executeCommand("workbench.action.chat.changeModel", {
  vendor: "copilot",
  family: "claude-sonnet-4.5",
  id: "claude-sonnet-4.5",
});

// Then send prompt as usual
await vscode.commands.executeCommand(
  "workbench.action.chat.submit",
  promptText
);
```

---

## Model Selection - CONFIRMED FINDINGS ✅

**Testing Date**: November 23, 2025  
**Command**: `workbench.action.chat.changeModel`  
**Status**: ✅ Fully working and ready for implementation

### Working Parameter Format

The command accepts a Language Model object with three required properties:

```typescript
{
  vendor: "copilot",       // Always "copilot" for GitHub Copilot models
  family: "model-family",  // Model family name (e.g., "claude-sonnet-4.5")
  id: "model-id"           // Model ID (same as family, NOT "copilot/model-name")
}
```

### Key Discovery

**Critical**: The `id` field format is just the model name, NOT `copilot/model-name`:

- ✅ Correct: `id: "claude-sonnet-4.5"`
- ❌ Wrong: `id: "copilot/claude-sonnet-4.5"`

This differs from some VS Code Language Model API documentation which uses the `vendor/family` format for model selection in other contexts.

### Available Models (Tested November 23, 2025)

Query models programmatically:

```typescript
const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
models.forEach((m) => console.log(`ID: ${m.id}, Family: ${m.family}`));
```

Common models available:

- **Claude Models**: `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`
- **GPT Models**: `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `gpt-4`
- **Gemini Models**: `gemini-2.5-pro`, `gemini-3-pro-preview`
- **Other**: `grok-code-fast-1`, `copilot-fast`, `auto`

See full list at the end of this document.

### Implementation Example

```typescript
// Example: Switch to Claude Sonnet 4.5 before sending prompt
async function sendPromptWithModel(promptText: string, modelId: string) {
  // Step 1: Switch model
  await vscode.commands.executeCommand("workbench.action.chat.changeModel", {
    vendor: "copilot",
    family: modelId,
    id: modelId,
  });

  // Step 2: Wait for model to switch (small delay recommended)
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Step 3: Send prompt
  await vscode.commands.executeCommand(
    "workbench.action.chat.submit",
    promptText
  );
}

// Usage
await sendPromptWithModel("Explain this code", "claude-sonnet-4.5");
```

### FlightPath Integration

This enables FlightPath to support `model` field in Chat mode (matching CLI mode):

```json
{
  "prompt": "Analyze this codebase architecture",
  "model": "claude-sonnet-4.5"
}
```

FlightPath can call `workbench.action.chat.changeModel` before sending each prompt in Chat mode, enabling per-prompt model selection just like CLI mode.

---

## Investigation Needed

### Command Parameter Discovery

To determine if these commands are usable for automation, we need to:

1. **Inspect Command Signatures**: Use VS Code extension API to query command metadata
2. **Test Parameter Formats**: Try various parameter formats (string, object, etc.)
3. **Monitor Behavior**: Use debug logs to observe command execution
4. **Check Source Code**: Review VS Code GitHub repo for command definitions

### Test Implementation

```typescript
// Test in FlightPath extension
async function investigateAgentCommand() {
  try {
    // Attempt 1: String parameter
    await vscode.commands.executeCommand(
      "workbench.action.chat.assignSelectedAgent",
      "flightpath-orchestrator"
    );

    // Attempt 2: Object parameter
    await vscode.commands.executeCommand(
      "workbench.action.chat.assignSelectedAgent",
      { agentId: "flightpath-orchestrator" }
    );

    // Attempt 3: No parameters (may open picker)
    await vscode.commands.executeCommand(
      "workbench.action.chat.assignSelectedAgent"
    );
  } catch (error) {
    console.log("Command failed:", error);
  }
}
```

---

## Updated Implementation Strategy

### Option A: CLI-Only (Current Plan)

**Pros**:

- Simple, deterministic API (`--agent` flag)
- Well-documented in `copilot --help`
- No UI dependencies
- Already works in FlightPath's prompt mode

**Cons**:

- Only works in CLI mode (not Chat mode)
- Requires users to use CLI integration

### Option B: Dual Support (CLI + Chat)

**Pros**:

- Works in both integration modes
- Users can choose their preferred mode
- Future-proof as Chat mode evolves

**Cons**:

- More complex implementation
- Chat mode requires command parameter discovery
- May have UI timing issues
- Less reliable than CLI

### Option C: CLI-First with Chat Fallback

**Pros**:

- Leverages reliable CLI support
- Adds Chat support if/when parameters are confirmed
- Incremental development path

**Cons**:

- Users in Chat mode may not get agent support immediately

---

## Recommendation

**Implement Option C: CLI-First with Chat Investigation**

### Phase 1: CLI Agent Support (Immediate)

- Implement `--agent` flag support as documented in main plan
- Full agent support for CLI mode users
- No blockers, can ship immediately

### Phase 2: Chat Command Investigation (Parallel)

- Create test command to investigate `workbench.action.chat.assignSelectedAgent`
- Document parameter formats that work
- Create proof-of-concept integration

### Phase 3: Chat Agent Support (Conditional)

- **IF** commands accept programmatic parameters:
  - Implement agent/model selection in `CopilotChatIntegration`
  - Add pre-prompt command execution
  - Update documentation
- **IF NOT** (commands are UI-only):
  - Document limitation
  - Recommend CLI mode for agent workflows
  - Consider feature request to VS Code team

---

## Chat Mode Agent Selection Research Tasks

### Immediate Tasks

1. **Create test command**: `flightpath.test.chatAgentSelection`
2. **Test agent command**: Try different parameter formats
3. **Monitor VS Code logs**: Check for command execution details
4. **Review VS Code source**: Search GitHub for command definitions
5. **Document findings**: Update this document with results

### Long-term Tasks

1. **Feature request**: If commands are UI-only, request programmatic API
2. **Community discussion**: Ask in VS Code/Copilot community about agent automation
3. **Alternative approaches**: Investigate other automation methods (Language Model API?)

---

## Language Model API Alternative

VS Code's Language Model API might provide an alternative approach:

```typescript
// From VS Code API documentation
const models = await vscode.lm.selectChatModels({
  vendor: "copilot",
  family: "gpt-4o", // or 'claude-3.5-sonnet'
});

const [model] = models;
const response = await model.sendRequest(craftedPrompt, {}, token);
```

**Considerations**:

- This bypasses the Chat UI entirely
- Requires implementing our own response handling
- May not have access to agent personas (just base models)
- Could be used for hybrid approach (CLI-like reliability in Chat mode)

---

## Available Copilot Models (November 23, 2025)

The following models were discovered via `vscode.lm.selectChatModels({ vendor: "copilot" })`:

| Model ID                | Family             | Notes                           |
| ----------------------- | ------------------ | ------------------------------- |
| `claude-sonnet-4.5`     | claude-sonnet-4.5  | Latest Claude Sonnet            |
| `claude-sonnet-4`       | claude-sonnet-4    | Previous Claude Sonnet          |
| `claude-haiku-4.5`      | claude-haiku-4.5   | Fast Claude model               |
| `gpt-5`                 | gpt-5              | Latest GPT model                |
| `gpt-5-mini`            | gpt-5-mini         | Lightweight GPT-5               |
| `gpt-5.1`               | gpt-5.1            | GPT 5.1 variant                 |
| `gpt-5.1-codex`         | gpt-5.1-codex      | Code-optimized GPT 5.1          |
| `gpt-5.1-codex-mini`    | gpt-5.1-codex-mini | Lightweight code model          |
| `gpt-5-codex`           | gpt-5-codex        | Code-optimized GPT-5            |
| `gpt-4.1`               | gpt-4.1            | GPT 4.1                         |
| `gpt-4o`                | gpt-4o             | GPT-4 Optimized                 |
| `gpt-4o-mini`           | gpt-4o-mini        | Lightweight GPT-4o              |
| `gpt-4`                 | gpt-4              | Standard GPT-4                  |
| `gpt-4-0125-preview`    | gpt-4-turbo        | GPT-4 Turbo                     |
| `gpt-3.5-turbo`         | gpt-3.5-turbo      | Legacy GPT-3.5                  |
| `gemini-2.5-pro`        | gemini-2.5-pro     | Google Gemini 2.5 Pro           |
| `gemini-3-pro-preview`  | gemini-3-pro       | Google Gemini 3 Preview         |
| `grok-code-fast-1`      | grok-code          | xAI Grok (code-focused)         |
| `copilot-fast`          | copilot-fast       | Fast Copilot model              |
| `oswe-vscode-secondary` | gpt-5-mini         | Internal secondary model        |
| `auto`                  | gpt-5              | Auto-select (defaults to GPT-5) |

**Note**: Model availability may vary based on your GitHub Copilot subscription tier and region.

---

## Next Steps

1. ✅ **Document chat commands** (this file)
2. ✅ **Test model selection command** (confirmed working!)
3. ⏳ **Implement model selection in CopilotChatIntegration**
4. ⏳ **Test chat agent commands** (parameter investigation)
5. ⏳ **Implement CLI agent support** (main plan Phase 1)
6. ⏳ **Update implementation plan** based on findings

---

## References

- Main implementation plan: `docs/AGENT_SUPPORT_IMPLEMENTATION.md`
- Chat commands list: `docs/CHAT_COMMANDS.md`
- VS Code Language Model API: [VS Code API Docs](https://code.visualstudio.com/api/extension-guides/language-model)
- Custom Agents Docs: [GitHub Copilot Custom Agents](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-custom-agents)
