# Settings Panel Design

This document describes the FlightPath Settings Panel architecture - a dedicated webview for provider and model selection.

## Overview

FlightPath uses a multi-view panel architecture with two webview views in the same container:
- **Dashboard**: Workflow execution, prompts list, output streaming, controls
- **Settings**: Provider selection, model selection, dynamic queue toggle

Views display side-by-side in the bottom panel with native VS Code collapsible headers.

## Design Principles

1. **Consistent behavior across providers**: All three providers (Copilot CLI, Copilot Chat, Claude CLI) apply the selected model before sending prompts
2. **Persistent settings**: Selection is saved to VS Code settings and restored on reload
3. **Clear precedence**: Prompt file `model` field overrides settings panel selection
4. **Scalable UI**: Settings panel can accommodate future settings
5. **Graceful degradation**: Show warning when model switch fails (e.g., model not available on user's subscription)

---

## Architecture

### Multi-View Panel Layout

```
+---------------------------------------------------------------------------------+
| FlightPath                                                                      |
+---------------------------------------------------------------------------------+
| v DASHBOARD                                              | v SETTINGS           |
| +------------------------------------------------------+ | +-----------------+  |
| | [Header: File Info, State, Controls]                 | | | Provider        |  |
| |                                                      | | | +-------------+ |  |
| | +-----------------+  +----------------------------+  | | | | Copilot CLI▼| |  |
| | | Prompts         |  | Output                     |  | | | +-------------+ |  |
| | | 1. Analyze...   |  | [CLI output streaming...]  |  | | |                 |  |
| | | 2. Implement... |  |                            |  | | | Model           |  |
| | | 3. Test...      |  |                            |  | | | +-------------+ |  |
| | +-----------------+  +----------------------------+  | | | |claude-4.5 ▼| |  |
| |                                                      | | | +-------------+ |  |
| +------------------------------------------------------+ | |                 |  |
|                                                          | | [ ] Dynamic Queue|  |
|                                                          | +-----------------+  |
+---------------------------------------------------------------------------------+
```

**Benefits:**

- **Native VS Code UX**: Collapsible headers with `>` / `v` icons (no custom implementation)
- **Clean file separation**: Each view has its own HTML/CSS/JS files
- **Side-by-side layout**: Bottom panel views display horizontally in wide panels
- **User control**: Users can collapse Settings when not needed, giving Dashboard full width
- **Scalable**: Easy to add more views in the future (e.g., "History", "Templates")

### View Registration (package.json)

```json
"views": {
  "flightpath": [
    {
      "type": "webview",
      "id": "flightpath.dashboard",
      "name": "Dashboard",
      "icon": "$(dashboard)"
    },
    {
      "type": "webview",
      "id": "flightpath.settings",
      "name": "Settings",
      "icon": "$(settings-gear)"
    }
  ]
}
```

---

## Settings Panel Components

### Provider Dropdown

Selects the AI provider for prompt execution:
- **Copilot CLI** (default): Uses GitHub Copilot CLI
- **Copilot Chat**: Uses VS Code's Copilot Chat window
- **Claude Code**: Uses Anthropic's Claude Code CLI

Updates the `flightpath.provider` setting.

### Model Dropdown

Dynamic options based on selected provider:

| Provider | Models | Setting |
|----------|--------|---------|
| Copilot CLI | claude-sonnet-4.5, claude-haiku-4.5, claude-opus-4.5, claude-sonnet-4, gpt-5, gpt-5.1, gpt-5.1-codex-mini, gpt-5.1-codex, gpt-5-mini, gpt-4.1, gemini-3-pro-preview | `flightpath.copilotCliModel` |
| Copilot Chat | (same as Copilot CLI) | `flightpath.copilotChatModel` |
| Claude CLI | sonnet, opus, haiku | `flightpath.claudeCliModel` |

### Dynamic Queue Checkbox

Enables dynamic queue extension feature. Updates `flightpath.enableDynamicQueue` setting.

---

## Order of Precedence

**Highest to Lowest:**

1. `model` field in `.prompt.json` or `.flightpath.json` file
2. Settings panel model selection (backed by VS Code setting)

---

## Cross-View Synchronization

Both Dashboard and Settings views stay synchronized via VS Code's configuration change events:

```typescript
context.subscriptions.push(
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("flightpath")) {
      this.sendInitialState(); // Refresh view with new config
    }
  })
);
```

This approach:
- Leverages VS Code's built-in config change events
- No direct message passing between views needed
- Settings made in VS Code Settings UI also sync to both views

---

## Model Switching Behavior

### CLI Modes (Copilot CLI, Claude CLI)

Always pass `--model` parameter to CLI command. Model comes from:
1. `prompt.model` field in prompt file
2. Provider-specific setting (`copilotCliModel` or `claudeCliModel`)

### Chat Mode

Always switches to the selected model before sending prompts (consistent with CLI behavior):

```typescript
private getDefaultModel(): string {
  return vscode.workspace.getConfiguration("flightpath")
    .get<string>("copilotChatModel", "claude-sonnet-4.5");
}

private async switchModelIfNeeded(model?: string): Promise<void> {
  const targetModel = model || this.getDefaultModel();
  // Switch to targetModel using workbench.action.chat.changeModel
}
```

### Graceful Degradation

When model switch fails:
1. Log error to console
2. Show warning message with suggestion to change settings
3. Continue workflow with current model (don't block execution)

```typescript
catch (error) {
  vscode.window.showWarningMessage(
    `FlightPath: Could not switch to model "${targetModel}". ` +
    `This model may not be available on your subscription. ` +
    `Using current model instead. You can change the default in Settings.`
  );
}
```

---

## Files

| File | Purpose |
|------|---------|
| `src/ui/FlightPathSettingsProvider.ts` | Settings WebviewViewProvider |
| `src/ui/webview/settings.html` | Settings view HTML template |
| `src/ui/webview/settings.css` | Settings view styles |
| `src/ui/webview/settings.js` | Settings view logic |
| `src/types/DashboardConstants.ts` | Shared message types (CHANGE_MODEL, CHANGE_DYNAMIC_QUEUE, etc.) |

---

## Future Enhancements

- **Model Discovery**: Refresh available models from API periodically via `onModelsLoaded` event
- **Quick Switch**: Keyboard shortcut to cycle through models
- **Recent Models**: Remember last N used models for quick access
- **Additional Views**: History view, Templates view
