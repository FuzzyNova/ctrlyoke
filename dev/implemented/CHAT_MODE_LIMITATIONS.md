# Chat Mode Limitations and Requirements

## Overview

FlightPath's Chat mode automation has several important limitations due to the lack of VS Code APIs for chat session management and the log-based completion detection approach.

## Chat Mode Selection (Ask/Agent/Plan/Custom Agents)

### The Issue

GitHub Copilot Chat supports multiple modes:

- **Ask Mode**: Text-only responses, no file edits
- **Plan Mode**: Planning and analysis, no file edits
- **Agent Mode**: Full capabilities including file edits and tool usage (default)
- **Edit Mode**: Code editing focus
- **Custom Agents**: User-created agents with specialized capabilities

**Problem**: Ask and Plan modes return immediate text responses without file edits, causing FlightPath's log-based completion detection to see `finish reason: [stop]` instantly, even though Copilot is still generating the response.

### Agent Selection Limitation

**Critical Limitation**: FlightPath **cannot programmatically select custom agents** for Chat mode workflows.

**Why this matters:**

- VS Code provides no API to select a specific agent programmatically
- The `workbench.action.chat.openagent` command only opens the **default Agent mode**, not custom agents
- Custom agents must be manually selected from the dropdown before running workflows
- This limitation prevents FlightPath from implementing the agent assignment feature described in `AGENT_SUPPORT_IMPLEMENTATION.md` for Chat mode

**Impact:**

- ✅ CLI mode: Full agent support via `--agent <name>` flag (planned feature)
- ❌ Chat mode: No programmatic agent selection possible
- ⚠️ Workaround: Users must manually select desired custom agent before starting FlightPath workflow

**Recommendation**: Use CLI mode for workflows requiring custom agent selection.

### FlightPath's Solution

FlightPath provides an **optional** setting to automatically ensure agent mode:

**Setting**: `flightpath.forceAgentModeForChat` (default: `false`)

**When disabled (default - recommended for custom agents):**

- ✅ Preserves your custom agent selections
- ✅ Allows using custom agents with FlightPath workflows
- ⚠️ User must manually ensure agent mode is selected (not ask/plan)
- ⚠️ If ask/plan mode is active, completion detection may fail

**When enabled (recommended if you switch between ask/plan modes):**

- ✅ Automatically switches to default agent mode before each prompt
- ✅ Prevents ask/plan mode issues with completion detection
- ✅ Guarantees file editing workflows work correctly
- ⚠️ Overrides custom agent selections (switches to default agent)

**Implementation**:

```typescript
const config = vscode.workspace.getConfiguration("flightpath");
const forceAgentMode = config.get<boolean>("forceAgentModeForChat", false);
if (forceAgentMode) {
  await vscode.commands.executeCommand("workbench.action.chat.openagent");
}
```

### API Limitations

**No mode detection API**: VS Code doesn't provide an API to query the current chat mode (ask/agent/plan). FlightPath cannot determine which mode is active.

**Workaround**: Always call `openagent` before sending prompts. If already in agent mode, this command is a no-op and has no negative effect.

### User Impact

**Default behavior (forceAgentModeForChat = false):**

- Custom agents work perfectly with FlightPath
- Users should manually select agent mode before running workflows
- If ask/plan mode is active, workflow may fail with premature completion

**Optional enforcement (forceAgentModeForChat = true):**

- FlightPath automatically switches to default agent mode
- Custom agent selections will be overridden
- Best for users who frequently switch between ask/plan/agent modes

**For text-only workflows**: Use CLI mode instead of Chat mode:

```bash
# CLI mode supports custom agents and models
npx @github/copilot-cli --agent ask "What is TypeScript?"
```

### Recommendation

**Use custom agents?** Keep `forceAgentModeForChat` disabled (default)

- Manually select your custom agent before running workflows
- FlightPath will respect your agent choice

**Frequently use ask/plan modes?** Enable `forceAgentModeForChat`

- FlightPath will auto-switch to default agent mode
- Prevents accidental failures from wrong mode selection

---

## Model Selection in Chat Mode

### ✅ Model Selection Works

Unlike agent selection, **model selection works programmatically** in Chat mode via `workbench.action.chat.changeModel`.

**Command Format** (tested November 23, 2025):

```typescript
await vscode.commands.executeCommand("workbench.action.chat.changeModel", {
  vendor: "copilot",
  family: "claude-sonnet-4.5", // Model family name
  id: "claude-sonnet-4.5", // Same as family (NOT "copilot/model-name")
});
```

**Key Discovery**: The `id` field is just the model name, NOT `copilot/model-name`:

- ✅ Correct: `id: "claude-sonnet-4.5"`
- ❌ Wrong: `id: "copilot/claude-sonnet-4.5"`

### Available Models

Common models (availability varies by subscription):

| Model ID            | Family            | Notes                  |
| ------------------- | ----------------- | ---------------------- |
| `claude-sonnet-4.5` | claude-sonnet-4.5 | Latest Claude Sonnet   |
| `claude-sonnet-4`   | claude-sonnet-4   | Previous Claude Sonnet |
| `claude-haiku-4.5`  | claude-haiku-4.5  | Fast Claude model      |
| `gpt-5`             | gpt-5             | Latest GPT model       |
| `gpt-5-mini`        | gpt-5-mini        | Lightweight GPT-5      |
| `gpt-4o`            | gpt-4o            | GPT-4 Optimized        |
| `gemini-2.5-pro`    | gemini-2.5-pro    | Google Gemini          |
| `auto`              | gpt-5             | Auto-select            |

Query models programmatically:

```typescript
const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
```

### Agent vs Model Summary

| Feature             | CLI Mode          | Chat Mode                |
| ------------------- | ----------------- | ------------------------ |
| **Agent Selection** | ✅ `--agent` flag | ❌ Manual only           |
| **Model Selection** | ✅ `--model` flag | ✅ `changeModel` command |

---

### Technical Details

**Command used**: `workbench.action.chat.openagent` (only when setting enabled)

- Opens a new chat in default agent mode (if starting new session)
- Switches existing chat to default agent mode (if reusing session)
- No-op if already in default agent mode
- **Limitation**: Always switches to DEFAULT agent, overrides custom agents

**Why custom agents are overridden**: The `openagent` command targets the **default Agent** option at the top of the mode dropdown, not custom agents listed below the separator.

**Alternative commands** (not used by FlightPath):

- `workbench.action.chat.openask` - Ask mode (text-only)
- `workbench.action.chat.openedit` - Plan/edit mode (planning only)
- `workbench.action.chat.toggleAgentMode` - Toggle (state unknown)

**Why not use toggleAgentMode?**: We can't query current state, so toggle could turn agent mode OFF instead of ON.

---

## Parallel Execution Limitation

### Improved Session Isolation (Session File Monitoring)

FlightPath's Chat mode completion detection uses **VS Code's internal chatSessions JSON files** (`workspaceStorage/*/chatSessions/*.json|*.jsonl`). Unlike the old log-file approach, session files contain per-request structure and prompt text, which allows FlightPath to match the specific prompt it sent.

**How it works**: `ChatSessionMonitor` searches all session files for the exact prompt text it submitted, then monitors only that session file for `requests[-1].result.timings.totalElapsed > 0`.

**Remaining limitation**: If VS Code creates a new session file before the prompt is written (before `findSessionFileByPromptText()` can match it), there is a brief window where the session file has not yet been identified. In practice this is handled by a retry loop in `waitForCompletion()`.

**Concurrent workflow risk**: Running two FlightPath workflows in Chat mode simultaneously with identical prompt text could theoretically cause one to latch onto the other's session file. In practice this is unlikely, but the safest approach remains **one Chat mode workflow at a time**.

**Problem Scenarios (reduced but not eliminated):**

1. **Manual user interaction**: If the user sends a chat message with the same text as the current prompt, the monitor may latch to the wrong session. Unique prompt text makes this very unlikely.

2. **Multiple FlightPath workflows** with identical first prompts: Same-text collision risk; use unique prompts.

**CLI mode has no parallel execution issues:**

- CLI creates isolated session files (`.copilot-session-<uuid>.json`)
- Each session has a unique ID tracked by FlightPath
- No cross-contamination possible

**Recommendation**: For automated concurrent workflows, use **CLI mode**.

### Completion Detection Behavior by Mode

| Mode  | File Edits | Log Marker           | FlightPath Behavior     |
| ----- | ---------- | -------------------- | ----------------------- |
| Ask   | ❌ No      | Immediate `[stop]`   | ⚠️ Premature completion |
| Plan  | ❌ No      | Immediate `[stop]`   | ⚠️ Premature completion |
| Agent | ✅ Yes     | After edits `[stop]` | ✅ Correct detection    |

### Future Improvements

If VS Code adds a mode query API, FlightPath could:

1. Detect current mode before prompts
2. Warn users when wrong mode is selected
3. Support per-prompt mode selection in `.flightpath.json`

Until then, agent mode enforcement is the safest approach.

---

## Summary of Chat Mode Limitations

| Limitation                     | Impact                                           | Workaround                                         |
| ------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| **No API for mode detection**  | Can't verify ask/plan/agent mode                 | Force agent mode via setting                       |
| **No API for agent selection** | Can't select custom agents programmatically      | Manually select agent before workflow              |
| **Session file match window**  | Brief window before session file is identified   | Retry loop handles this automatically              |
| **Identical-prompt collision** | Two simultaneous workflows with same prompt text | Use unique prompt text; prefer CLI for concurrency |

**General Recommendation**: Use **CLI mode** for production workflows. Chat mode is best for:

- Manual testing and debugging
- Single-step workflows
- Interactive exploration
- Scenarios where you want to see the chat UI

Use **CLI mode** for:

- Automated workflows in production
- Concurrent execution
- Custom agent selection (planned feature)
- Reliable completion detection
- Multi-step workflows with session continuity

---

## Related Documentation

- `CHAT_COMPLETION_DETECTION.md` - Detailed completion detection strategy
- `COPILOT_CLI_DESIGN.md` - CLI mode architecture (recommended for automation)
- `QUEUE_APPEND_FEATURE.md` - Queue append and dynamic extension guide
