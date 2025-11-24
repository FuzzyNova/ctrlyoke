# Chat Mode Limitations and Requirements

## Chat Mode Selection (Ask/Agent/Plan/Custom Agents)

### The Issue

GitHub Copilot Chat supports multiple modes:

- **Ask Mode**: Text-only responses, no file edits
- **Plan Mode**: Planning and analysis, no file edits
- **Agent Mode**: Full capabilities including file edits and tool usage (default)
- **Edit Mode**: Code editing focus
- **Custom Agents**: User-created agents with specialized capabilities

**Problem**: Ask and Plan modes return immediate text responses without file edits, causing FlightPath's log-based completion detection to see `finish reason: [stop]` instantly, even though Copilot is still generating the response.

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

## Related Documentation

- `AGENT_CHAT_COMMANDS.md` - Agent and model selection testing
- `CHAT_LOG_BASED_COMPLETION.md` - Log-based completion detection
- `COPILOT_CHAT_INTEGRATION.md` - Chat automation architecture
