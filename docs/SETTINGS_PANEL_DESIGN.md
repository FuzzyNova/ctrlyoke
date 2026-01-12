# Settings Panel Design

This document describes the FlightPath Settings Panel architecture - a dedicated webview for provider and model selection.

## Overview

FlightPath uses a multi-view panel architecture with two webview views in the same container:

- **Dashboard**: Workflow execution, prompts list, output streaming, controls
- **Settings**: Provider selection, model selection, agent selection, execution mode, and workflow options

Views display side-by-side in the bottom panel with native VS Code collapsible headers.

## Design Principles

1. **Consistent behavior across providers**: All four providers (Copilot CLI, Copilot Chat, Claude CLI, Codex CLI) apply the selected model before sending prompts
2. **Persistent settings**: Selection is saved to VS Code settings and restored on reload
3. **Clear precedence**: Prompt file `model` field overrides settings panel selection
4. **Scalable UI**: Settings panel can accommodate future settings
5. **Graceful degradation**: Show warning when model switch fails (e.g., model not available on user's subscription)
6. **Provider availability checking**: CLI providers are checked for installation at startup

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
|                                                          | | Agent           |  |
|                                                          | | +-------------+ |  |
|                                                          | | | Default   ▼| |  |
|                                                          | | +-------------+ |  |
|                                                          | |                 |  |
|                                                          | | [ ] New Chat    |  |
|                                                          | |     Session     |  |
|                                                          | |                 |  |
|                                                          | | Execution Mode  |  |
|                                                          | | +-------------+ |  |
|                                                          | | |Interactive▼| |  |
|                                                          | | +-------------+ |  |
|                                                          | |                 |  |
|                                                          | | [ ] Dynamic     |  |
|                                                          | |     Queue       |  |
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
- **Claude CLI**: Uses Anthropic's Claude Code CLI
- **Codex CLI**: Uses OpenAI's Codex CLI

Updates the `flightpath.provider` setting. Providers are checked for availability at startup - unavailable providers are shown as disabled in the dropdown.

### Model Dropdown

Dynamic options based on selected provider:

| Provider     | Models                                                                 | Setting                       |
| ------------ | ---------------------------------------------------------------------- | ----------------------------- |
| Copilot CLI  | Dynamic - queried from `copilot help config`                           | `flightpath.copilotCliModel`  |
| Copilot Chat | Dynamic - queried from VS Code LM API (full list)                      | `flightpath.copilotChatModel` |
| Claude CLI   | sonnet, sonnet[1m], opus, haiku                                        | `flightpath.claudeCliModel`   |
| Codex CLI    | gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.2, gpt-5.1 | `flightpath.codexCliModel`    |

### Agent Dropdown

Selects the Copilot agent to use:

- **Default**: No specific agent
- **@workspace**: Uses workspace context
- **@vscode**: VS Code-specific assistance
- **@terminal**: Terminal-focused assistance
- **@github**: GitHub-specific features

Updates the `flightpath.copilotAgent` setting.

### New Chat Session Checkbox

When enabled, starts a fresh chat session for each prompt. Updates `flightpath.newChatSessionPerPrompt` setting.

### Execution Mode Dropdown

Only visible for CLI providers (Copilot CLI, Claude CLI, Codex CLI):

- **Interactive**: Opens VS Code terminal for visibility and Ctrl+C abort
- **Headless**: Runs silently in background process

Updates the `flightpath.cliExecutionMode` setting.

### Dynamic Queue Checkbox

Enables dynamic queue extension feature. Updates `flightpath.enableDynamicQueue` setting.

---

## Order of Precedence

**Highest to Lowest:**

1. `model` field in `.flightpath.yaml` or `.flightpath.json` file
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

### CLI Modes (Copilot CLI, Claude CLI, Codex CLI)

Always pass `--model` parameter to CLI command. Model comes from:

1. `prompt.model` field in prompt file
2. Provider-specific setting (`copilotCliModel`, `claudeCliModel`, or `codexCliModel`)

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

| File                                   | Purpose                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `src/ui/FlightPathSettingsProvider.ts` | Settings WebviewViewProvider                                            |
| `src/ui/webview/settings.html`         | Settings view HTML template                                             |
| `src/ui/webview/settings.css`          | Settings view styles                                                    |
| `src/ui/webview/settings.js`           | Settings view logic                                                     |
| `src/types/DashboardConstants.ts`      | Shared constants (PROVIDER_IDS, MESSAGE_TYPES, CLAUDE_CLI_MODELS, etc.) |
| `src/utils/ModelRegistry.ts`           | Runtime model discovery from VS Code LM API                             |
| `src/utils/ModelConstants.ts`          | Static model definitions and display names                              |

---

## Future Enhancements

- **Quick Switch**: Keyboard shortcut to cycle through models
- **Recent Models**: Remember last N used models for quick access
- **Additional Views**: History view, Templates view
