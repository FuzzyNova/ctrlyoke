# Agent & Model Selection Commands for Chat Mode

**Discovery Date**: November 23, 2025  
**Status**: Research complete - Model selection ✅ working, Agent selection ❌ not available

---

## Summary of Findings

### ✅ Model Selection: WORKING

`workbench.action.chat.changeModel` is fully functional and allows programmatic model switching in Chat mode.

### ❌ Agent Selection: NOT AVAILABLE

After extensive testing, **no VS Code command exists for programmatically selecting custom agents in Chat mode**. All agent-related commands are UI-only or non-functional for automation.

**Recommendation**: Use CLI mode (`--agent` flag) for agent support in FlightPath workflows.

---

## Key Chat Commands Discovered

From the 356 available chat commands in VS Code, the following were tested for programmatic agent and model selection in Chat mode:

### Agent Selection Commands - ❌ TESTED, NOT USABLE

1. **`workbench.action.chat.openagent`** ❌ **NOT USABLE**
   - **Purpose**: Switches to agent mode (toggles agent mode on)
   - **Tested parameters**: String (agent name), No parameters
   - **Result**: Only toggles agent mode on/off, does NOT accept agent name or select specific agents
   - **Conclusion**: Cannot be used for agent selection

2. **`workbench.action.chat.assignSelectedAgent`** ❌ **NOT USABLE**
   - **Purpose**: Likely for cloud agents or agent sidebar selection
   - **Tested parameters**: String (agent name), Object with various properties
   - **Result**: Command executes but does nothing visible - no agent selection occurs
   - **Conclusion**: Likely internal command for cloud agents or UI state, not usable for automation

3. **`workbench.action.chat.picker.customagents`** ⚠️ **UI ONLY**
   - **Purpose**: Opens the agent picker UI for editing agents
   - **Tested parameters**: No parameters
   - **Result**: Opens agent management/editing UI
   - **Conclusion**: UI command only, not useful for automation (but good for user configuration)

4. **`workbench.action.chat.toggleAgentMode`** ❌ **NOT USABLE**
   - **Purpose**: Unknown (possibly deprecated or internal)
   - **Tested parameters**: No parameters
   - **Result**: Command executes but does nothing visible
   - **Conclusion**: Non-functional or internal command

5. **`workbench.action.chat.configure.customagents`** ⚠️ **UI ONLY**
   - **Purpose**: Opens agent picker with ability to create new agents
   - **Tested parameters**: Not tested (command is exposed in UI)
   - **Result**: Opens agent configuration UI
   - **Conclusion**: UI command only, not useful for automation (but good for agent management)

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

## Implications for FlightPath

### Current Limitations

**Chat Mode Agent Selection**: ❌ Not possible programmatically

- No VS Code command supports programmatic custom agent selection
- Users must manually select agents in the Chat UI
- Agent selection state is not exposed to extensions

**Chat Mode Model Selection**: ✅ Fully supported

- `workbench.action.chat.changeModel` works perfectly
- Can switch models before each prompt
- Enables per-prompt model configuration in Chat mode

### Recommendation: CLI-Only Agent Support

Given the testing results, FlightPath should:

1. **Implement agent support in CLI mode only** - The `--agent` flag works reliably
2. **Implement model selection in both CLI and Chat modes** - Both work well
3. **Document the limitation** - Users who need agent support must use CLI mode
4. **Monitor VS Code updates** - Agent selection API may be added in future releases

### Future Possibilities

If VS Code adds agent selection APIs in the future, FlightPath can easily add Chat mode support. The architecture is ready - we just need a working command.

**Ideal future command** (if added by VS Code):

```typescript
await vscode.commands.executeCommand(
  "workbench.action.chat.selectAgent", // Hypothetical future command
  "agent-name"
);
```

---

## Testing Summary

**Test Date**: November 23, 2025  
**Test Method**: Created test agents (`test-agent-alpha`, `test-agent-beta`) in `manual-test/.github/agents/`  
**Test Command**: `flightpath.test.chatAgentSelection`

**Commands Tested**:

- ❌ `workbench.action.chat.openagent` - Only toggles agent mode
- ❌ `workbench.action.chat.assignSelectedAgent` - No visible effect
- ⚠️ `workbench.action.chat.picker.customagents` - UI only (opens editor)
- ❌ `workbench.action.chat.toggleAgentMode` - No visible effect

**Conclusion**: No programmatic agent selection available in Chat mode.

---

## Model Selection - CONFIRMED WORKING ✅

**Testing Date**: November 23, 2025  
**Command**: `workbench.action.chat.changeModel`  
**Status**: ✅ Fully working and ready for implementation in FlightPath Chat mode

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

## Implementation Strategy - UPDATED BASED ON TESTING

### ✅ What We Can Implement Now

1. **CLI Mode: Full Agent + Model Support**
   - Agent selection via `--agent` flag (confirmed working in CLI)
   - Model selection via `--model` flag (confirmed working in CLI)
   - **Status**: Ready to implement immediately

2. **Chat Mode: Model Selection Only**
   - Model selection via `workbench.action.chat.changeModel` (confirmed working)
   - **Status**: Ready to implement immediately
   - **Limitation**: No agent selection available

### ❌ What We Cannot Implement (Yet)

1. **Chat Mode: Agent Selection**
   - No working VS Code command found
   - Users must manually select agents in Chat UI
   - **Status**: Not possible until VS Code adds API support

### Recommended Implementation Plan

**Phase 1: Immediate Implementation**

- ✅ Add `agent` field support in `.flightpath.json` schema
- ✅ Implement `--agent` flag in CLI mode
- ✅ Implement `workbench.action.chat.changeModel` in Chat mode for model selection
- ✅ Document that agent selection only works in CLI mode

**Phase 2: Future Enhancement (when VS Code adds support)**

- ⏳ Monitor VS Code release notes for agent selection API
- ⏳ Add Chat mode agent selection when available
- ⏳ Update documentation

### User Experience

**CLI Mode** (Recommended for agent workflows):

```json
{
  "prompts": [
    {
      "prompt": "Analyze this code",
      "agent": "code-analyzer",
      "model": "claude-sonnet-4.5"
    }
  ]
}
```

✅ Both agent and model work

**Chat Mode** (Model only):

```json
{
  "prompts": [
    {
      "prompt": "Analyze this code",
      "model": "claude-sonnet-4.5"
    }
  ]
}
```

✅ Model works, ⚠️ agent field ignored (user must select manually)

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

1. ✅ **Document chat commands** - Complete
2. ✅ **Test model selection command** - Confirmed working
3. ✅ **Test chat agent commands** - Confirmed NOT working
4. ⏳ **Implement model selection in CopilotChatIntegration** - Ready to implement
5. ⏳ **Implement CLI agent support** - Ready to implement (main plan Phase 1)
6. ⏳ **Document agent limitation in Chat mode** - Update user documentation
7. ⏳ **Consider feature request to VS Code team** - Request agent selection API

---

## References

- Main implementation plan: `docs/AGENT_SUPPORT_IMPLEMENTATION.md`
- Chat commands list: `docs/CHAT_COMMANDS.md`
- VS Code Language Model API: [VS Code API Docs](https://code.visualstudio.com/api/extension-guides/language-model)
- Custom Agents Docs: [GitHub Copilot Custom Agents](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-custom-agents)
