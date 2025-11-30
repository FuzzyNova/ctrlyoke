# Model Selection UI Implementation Plan

This document details the implementation plan for adding model selection to the FlightPath dashboard UI with a settings drawer approach.

## Overview

Add a settings drawer (slide-out panel) to the FlightPath dashboard for provider and model selection, with readonly header feedback showing current selections.

## Design Goals

1. **Consistent behavior across providers**: All three providers (Copilot CLI, Copilot Chat, Claude CLI) apply the selected model before sending prompts
2. **Persistent settings**: Selection is saved to VS Code settings and restored on reload
3. **Clear precedence**: Prompt file `model` field overrides dashboard selection
4. **Scalable UI**: Settings drawer can accommodate future settings (e.g., dynamic queue toggle)
5. **Graceful degradation**: Show warning when model switch fails (e.g., model not available on user's subscription)

---

## Current Implementation Analysis

### CLI Integrations (Copilot CLI & Claude CLI)

- **Always pass `--model` parameter** to CLI command
- Model comes from `options.model` which is resolved from:
  1. `prompt.model` field in prompt file
  2. `flightpath.copilotCliModel` or `flightpath.claudeCliModel` setting

### Chat Integration

- **Currently**: Only calls `switchModelIfNeeded()` when `prompt.model` is specified
- **Problem**: If no model specified, uses whatever model was last selected in Chat UI
- **New behavior**: Always switch to selected model setting (consistent with CLI)

### API Limitation

- `ChatRequest.model` only available within chat participant handlers
- **No VS Code API to read currently selected Chat model** from outside chat context
- **Solution**: Use setting default (`claude-sonnet-4.5`), always switch to it (can't sync on first load)

### Default Model Decision

- **All Copilot modes default to `claude-sonnet-4.5`** for consistency and quality
- Claude CLI defaults to `sonnet` (its equivalent)
- Rationale: FlightPath is a power-user tool; users likely have paid subscriptions
- If model not available, show warning and continue with current model (graceful degradation)

---

## UI Design

### Multi-View Panel Architecture

Use VS Code's native multi-view support within a single panel container. Views in the bottom panel display **side-by-side** (horizontally) and have native collapsible headers with `>` / `∨` toggles.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ FlightPath                                                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ∨ DASHBOARD                                              │ ∨ SETTINGS           │
│ ┌──────────────────────────────────────────────────────┐ │ ┌─────────────────┐  │
│ │ [Header: File Info, State, Controls]                 │ │ │ Provider        │  │
│ │                                                      │ │ │ ┌─────────────┐ │  │
│ │ ┌─────────────────┐  ┌────────────────────────────┐  │ │ │ │ Copilot CLI▼│ │  │
│ │ │ Prompts         │  │ Output                     │  │ │ │ └─────────────┘ │  │
│ │ │ 1. Analyze...   │  │ [CLI output streaming...]  │  │ │ │                 │  │
│ │ │ 2. Implement... │  │                            │  │ │ │ Model           │  │
│ │ │ 3. Test...      │  │                            │  │ │ │ ┌─────────────┐ │  │
│ │ └─────────────────┘  └────────────────────────────┘  │ │ │ │claude-4.5 ▼│ │  │
│ │                                                      │ │ │ └─────────────┘ │  │
│ └──────────────────────────────────────────────────────┘ │ │                 │  │
│                                                          │ │ ☐ Dynamic Queue │  │
│                                                          │ └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Benefits:**

- **Native VS Code UX**: Collapsible headers with `>` / `∨` icons (no custom implementation)
- **Clean file separation**: Each view has its own HTML/CSS/JS files
- **Side-by-side layout**: Bottom panel views display horizontally in wide panels
- **User control**: Users can collapse Settings when not needed, giving Dashboard full width
- **Scalable**: Easy to add more views in the future (e.g., "History", "Templates")

### Dashboard View (existing, refactored)

The main workflow view - prompts list, output, execution controls:

- File selection and info
- Execution state badge and controls (Run/Pause/Stop)
- Prompts list with status indicators
- Output/response streaming area
- **Remove**: Provider dropdown (moves to Settings view)

### Settings View (new)

Dedicated settings panel:

- Provider dropdown (Copilot CLI / Copilot Chat / Claude CLI)
- Model dropdown (dynamic options based on provider)
- Future: Dynamic Queue toggle checkbox
- Future: Other execution options

---

## Model Options by Provider

### Copilot CLI Models

Current enum from `flightpath.copilotCliModel`:

- `claude-sonnet-4.5` (default)
- `claude-haiku-4.5`
- `claude-opus-4.5`
- `claude-sonnet-4`
- `gpt-5`
- `gpt-5.1`
- `gpt-5.1-codex-mini`
- `gpt-5.1-codex`
- `gemini-3-pro-preview`

### Copilot Chat Models

Same as Copilot CLI (new setting `flightpath.copilotChatModel`):

- Same enum values as above
- Default: `claude-sonnet-4.5`

### Claude CLI Models

Current enum from `flightpath.claudeCliModel`:

- `sonnet` (default)
- `opus`
- `haiku`

---

## Order of Precedence

**Highest to Lowest:**

1. `model` field in `.prompt.json` or `.flightpath.json` file
2. Dashboard model dropdown selection (backed by VS Code setting)

---

## Implementation Tasks

### Phase 1: New Setting (package.json)

Add `flightpath.copilotChatModel` setting:

```json
"flightpath.copilotChatModel": {
  "order": 110,
  "type": "string",
  "enum": [
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-opus-4.5",
    "claude-sonnet-4",
    "gpt-5",
    "gpt-5.1",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex",
    "gemini-3-pro-preview"
  ],
  "default": "claude-sonnet-4.5",
  "description": "[Chat Mode] Default AI model",
  "markdownDescription": "**Chat Mode Only.** Default AI model for Copilot Chat. FlightPath will switch to this model before sending each prompt. Prompts can override with `\"model\": \"...\"`."
}
```

### Phase 2: CopilotChatIntegration Changes

Modify `sendPrompt()` to always apply model setting:

```typescript
// In sendPrompt(), before sending prompt:
const model = prompt.model || this.getDefaultModel();
await this.switchModelIfNeeded(model);

// New helper method:
private getDefaultModel(): string {
  return vscode.workspace.getConfiguration("flightpath")
    .get<string>("copilotChatModel", "claude-sonnet-4.5");
}
```

Modify `switchModelIfNeeded()`:

- Remove the early return for undefined model (now always has a value)
- Or pass through empty string to skip (if prompt explicitly sets no model)
- **Add warning on failure**: When model switch fails, show a warning message suggesting the user change their model setting

```typescript
// Enhanced error handling in switchModelIfNeeded():
catch (error) {
  console.error(`❌ Model switch failed (${model}):`, error);
  vscode.window.showWarningMessage(
    `FlightPath: Could not switch to model "${model}". ` +
    `This model may not be available on your subscription. ` +
    `Using current model instead. You can change the default in Settings.`
  );
  // Continue execution with current model - don't block the workflow
}
```

### Phase 3: Package.json - Add Settings View

Register a second webview view in the FlightPath panel:

```json
"views": {
  "flightpath": [
    {
      "type": "webview",
      "id": "flightpath.dashboard",
      "name": "Dashboard"
    },
    {
      "type": "webview",
      "id": "flightpath.settings",
      "name": "Settings"
    }
  ]
}
```

### Phase 4: Create Settings Webview Files

Create new files for the Settings view:

**`src/ui/webview/settings.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src {{cspSource}};"
    />
    <link rel="stylesheet" href="{{styleUri}}" />
    <title>FlightPath Settings</title>
  </head>
  <body>
    <div id="settings-app">
      <div class="setting-group">
        <label for="provider-dropdown">Provider</label>
        <select
          id="provider-dropdown"
          title="Select AI provider for prompt execution"
        >
          <option value="copilot-cli">Copilot CLI</option>
          <option value="copilot-chat">Copilot Chat</option>
          <option value="claude-cli">Claude Code</option>
        </select>
        <span class="setting-description">Choose which AI provider to use</span>
      </div>

      <div class="setting-group">
        <label for="model-dropdown">Model</label>
        <select id="model-dropdown" title="Select AI model">
          <!-- Populated dynamically based on provider -->
        </select>
        <span class="setting-description">AI model for prompt execution</span>
      </div>

      <hr class="setting-divider" />

      <div class="setting-group">
        <label class="checkbox-label">
          <input type="checkbox" id="dynamic-queue-checkbox" />
          <span>Enable Dynamic Queue Extension</span>
        </label>
        <span class="setting-description"
          >Allow prompts to extend the workflow queue</span
        >
      </div>
    </div>

    <script src="{{constantsUri}}"></script>
    <script src="{{scriptUri}}"></script>
  </body>
</html>
```

**`src/ui/webview/settings.css`**

```css
:root {
  --bg-primary: var(--vscode-editor-background);
  --bg-secondary: var(--vscode-sideBar-background);
  --fg-primary: var(--vscode-editor-foreground);
  --fg-secondary: var(--vscode-descriptionForeground);
  --border-color: var(--vscode-panel-border);
}

body {
  margin: 0;
  padding: 12px;
  color: var(--fg-primary);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

#settings-app {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-group label {
  font-weight: 600;
  font-size: 12px;
}

.setting-group select {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  cursor: pointer;
  max-width: 200px;
}

.setting-group select:hover {
  border-color: var(--vscode-focusBorder);
}

.setting-description {
  font-size: 11px;
  color: var(--fg-secondary);
}

.setting-divider {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 8px 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: normal;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
}
```

**`src/ui/webview/settings.js`**

```javascript
(function () {
  const vscode = acquireVsCodeApi();
  const { MESSAGE_TYPES } = window.FlightPathConstants;

  // Model options per provider
  const MODEL_OPTIONS = {
    "copilot-cli": [
      { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
      { value: "claude-opus-4.5", label: "Claude Opus 4.5" },
      { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { value: "gpt-5", label: "GPT-5" },
      { value: "gpt-5.1", label: "GPT-5.1" },
      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
    ],
    "copilot-chat": [
      // Same as copilot-cli (Copilot Chat supports same models)
      { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
      { value: "claude-opus-4.5", label: "Claude Opus 4.5" },
      { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { value: "gpt-5", label: "GPT-5" },
      { value: "gpt-5.1", label: "GPT-5.1" },
      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
    ],
    "claude-cli": [
      { value: "sonnet", label: "Sonnet (Recommended)" },
      { value: "opus", label: "Opus (Most Capable)" },
      { value: "haiku", label: "Haiku (Fastest)" },
    ],
  };

  let state = {
    provider: "copilot-cli",
    model: "claude-sonnet-4.5",
    dynamicQueueEnabled: false,
  };

  const elements = {
    providerDropdown: document.getElementById("provider-dropdown"),
    modelDropdown: document.getElementById("model-dropdown"),
    dynamicQueueCheckbox: document.getElementById("dynamic-queue-checkbox"),
  };

  // Event listeners
  elements.providerDropdown.addEventListener("change", (e) => {
    state.provider = e.target.value;
    updateModelDropdownOptions(state.provider);
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_PROVIDER,
      provider: state.provider,
    });
  });

  elements.modelDropdown.addEventListener("change", (e) => {
    state.model = e.target.value;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_MODEL,
      model: state.model,
      provider: state.provider,
    });
  });

  elements.dynamicQueueCheckbox.addEventListener("change", (e) => {
    state.dynamicQueueEnabled = e.target.checked;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE,
      enabled: state.dynamicQueueEnabled,
    });
  });

  // Message handler
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === MESSAGE_TYPES.INIT) {
      handleInit(message.data);
    }
  });

  function handleInit(data) {
    state = { ...state, ...data };
    elements.providerDropdown.value = state.provider;
    updateModelDropdownOptions(state.provider);
    elements.modelDropdown.value = state.model;
    elements.dynamicQueueCheckbox.checked = state.dynamicQueueEnabled;
  }

  function updateModelDropdownOptions(provider) {
    const options = MODEL_OPTIONS[provider] || [];
    elements.modelDropdown.innerHTML = options
      .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
      .join("");

    // Try to keep current model if available in new provider
    const matchingOption = options.find((opt) => opt.value === state.model);
    if (matchingOption) {
      elements.modelDropdown.value = state.model;
    } else if (options.length > 0) {
      // Default to first option for this provider
      state.model = options[0].value;
      elements.modelDropdown.value = state.model;
      // Notify extension of model change due to provider switch
      vscode.postMessage({
        type: MESSAGE_TYPES.CHANGE_MODEL,
        model: state.model,
        provider: state.provider,
      });
    }
  }

  // Request initial state
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
```

### Phase 5: Create SettingsViewProvider

**`src/ui/FlightPathSettingsProvider.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { MESSAGE_TYPES } from "../types/DashboardConstants";

export class FlightPathSettingsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  private static readonly WEBVIEW_PATH_SEGMENTS = ["out", "ui", "webview"];

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getWebviewPath(...segments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      ...FlightPathSettingsProvider.WEBVIEW_PATH_SEGMENTS,
      ...segments
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.getWebviewPath()],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });
  }

  private handleWebviewMessage(message: any): void {
    switch (message.type) {
      case MESSAGE_TYPES.READY:
        this.sendInitialState();
        break;
      case MESSAGE_TYPES.CHANGE_PROVIDER:
        this.handleProviderChange(message.provider);
        break;
      case MESSAGE_TYPES.CHANGE_MODEL:
        this.handleModelChange(message.model, message.provider);
        break;
      case MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE:
        this.handleDynamicQueueChange(message.enabled);
        break;
    }
  }

  private sendInitialState(): void {
    const config = vscode.workspace.getConfiguration("flightpath");
    const provider = config.get<string>("provider", "copilot-cli");
    const model = this.getModelForProvider(provider);
    const dynamicQueueEnabled = config.get<boolean>(
      "enableDynamicQueue",
      false
    );

    this.view?.webview.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: { provider, model, dynamicQueueEnabled },
    });
  }

  private getModelForProvider(provider: string): string {
    const config = vscode.workspace.getConfiguration("flightpath");
    const modelSettingMap: Record<string, string> = {
      "copilot-cli": "copilotCliModel",
      "copilot-chat": "copilotChatModel",
      "claude-cli": "claudeCliModel",
    };
    const settingKey = modelSettingMap[provider] || "copilotCliModel";
    const defaultModel =
      provider === "claude-cli" ? "sonnet" : "claude-sonnet-4.5";
    return config.get<string>(settingKey, defaultModel);
  }

  private async handleProviderChange(provider: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update("provider", provider, vscode.ConfigurationTarget.Global);
  }

  private async handleModelChange(
    model: string,
    provider: string
  ): Promise<void> {
    const settingMap: Record<string, string> = {
      "copilot-cli": "copilotCliModel",
      "copilot-chat": "copilotChatModel",
      "claude-cli": "claudeCliModel",
    };
    const settingKey = settingMap[provider];
    if (settingKey) {
      await vscode.workspace
        .getConfiguration("flightpath")
        .update(settingKey, model, vscode.ConfigurationTarget.Global);
    }
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update("enableDynamicQueue", enabled, vscode.ConfigurationTarget.Global);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    // Similar to dashboard - load settings.html template
    // Replace {{styleUri}}, {{scriptUri}}, {{constantsUri}}, {{cspSource}}
    // ... (implementation similar to FlightPathDashboardProvider)
  }
}
```

### Phase 6: Update DashboardConstants.ts

Add new message types for settings:

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...

  // Settings view messages
  CHANGE_MODEL: "changeModel",
  CHANGE_DYNAMIC_QUEUE: "changeDynamicQueue",
} as const;
```

### Phase 7: Update Dashboard - Remove Provider Dropdown

Refactor `dashboard.html` to remove the provider selector (now in Settings view):

```html
<!-- REMOVE this from dashboard.html header -->
<div id="provider-selector">
  <label for="provider-dropdown">Provider:</label>
  <select id="provider-dropdown">
    ...
  </select>
</div>
```

Update `dashboard.js` to remove provider change handling (Settings view owns this now).

### Phase 8: Register Settings View Provider in extension.ts

```typescript
import { FlightPathSettingsProvider } from "./ui/FlightPathSettingsProvider";

// In activate():
const settingsProvider = new FlightPathSettingsProvider(context);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    "flightpath.settings",
    settingsProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  )
);
```

### Phase 9: Cross-View Communication (Optional Enhancement)

If Dashboard needs to react to Settings changes (e.g., show current provider/model):

**Option A**: Both views listen to `vscode.workspace.onDidChangeConfiguration`
**Option B**: Use a shared state manager that broadcasts to both views

Recommended: **Option A** - simpler, leverages VS Code's built-in config change events.

```typescript
// In both providers:
context.subscriptions.push(
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("flightpath")) {
      this.sendInitialState(); // Refresh view with new config
    }
  })
);
```

---

## Testing Checklist

### Unit Tests

- [ ] Model setting is read correctly for each provider
- [ ] Model change updates correct setting based on provider
- [ ] Default model is used when setting is not configured

### Integration Tests

- [ ] Copilot CLI passes correct `--model` flag
- [ ] Copilot Chat switches to correct model before prompt
- [ ] Claude CLI passes correct `--model` flag
- [ ] Prompt file `model` field overrides Settings view selection

### UI Tests (Manual)

- [ ] Settings view displays side-by-side with Dashboard in bottom panel
- [ ] Settings view collapses/expands with native VS Code `>` / `∨` toggle
- [ ] Provider dropdown updates model options dynamically
- [ ] Model selection persists after VS Code reload
- [ ] Settings changes reflect in Dashboard (via config change listener)

---

## Future Enhancements

1. ~~**Dynamic Queue Toggle**: Add checkbox in settings drawer~~ ✅ Included in initial implementation
2. ~~**Model Validation**: Warn if selected model not available~~ ✅ Implemented via warning on switch failure
3. **Model Discovery**: Refresh available models from API periodically
4. **Quick Switch**: Keyboard shortcut to cycle through models
5. **Recent Models**: Remember last N used models for quick access
6. **Additional Views**: History view, Templates view

---

## Files to Modify

| File                                            | Changes                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `package.json`                                  | Add `flightpath.copilotChatModel` setting, add `flightpath.settings` view |
| `src/types/DashboardConstants.ts`               | Add `CHANGE_MODEL`, `CHANGE_DYNAMIC_QUEUE` message types                  |
| `src/ui/webview/settings.html`                  | **NEW** - Settings view HTML template                                     |
| `src/ui/webview/settings.css`                   | **NEW** - Settings view styles                                            |
| `src/ui/webview/settings.js`                    | **NEW** - Settings view logic                                             |
| `src/ui/FlightPathSettingsProvider.ts`          | **NEW** - Settings WebviewViewProvider                                    |
| `src/ui/webview/dashboard.html`                 | Remove provider dropdown (moved to Settings)                              |
| `src/ui/webview/dashboard.js`                   | Remove provider handling, add config change listener                      |
| `src/ui/FlightPathDashboardProvider.ts`         | Add config change listener for cross-view sync                            |
| `src/flightpath/chat/CopilotChatIntegration.ts` | Always apply model from setting                                           |
| `src/extension.ts`                              | Register FlightPathSettingsProvider                                       |

---

## Implementation Prompt

The following XML-structured prompt is ready for an AI coding agent to implement this feature:

```xml
<context>
FlightPath VS Code extension needs model selection via a separate Settings webview panel.
Use VS Code's native multi-view support - two webview views (Dashboard + Settings) in the same panel container.
Views in the bottom panel display side-by-side with native collapsible headers.
All providers (Copilot CLI, Copilot Chat, Claude CLI) should consistently apply the selected model.
</context>

<requirements>
1. Add `flightpath.settings` webview view to package.json views contribution
2. Add new `flightpath.copilotChatModel` setting with same enum values as copilotCliModel
3. Create Settings view files: settings.html, settings.css, settings.js
4. Create FlightPathSettingsProvider.ts to manage Settings webview
5. Settings view contains: Provider dropdown, Model dropdown, Dynamic Queue checkbox
6. Model dropdown options update dynamically based on selected provider
7. Changes update appropriate backing settings (provider, copilotCliModel/copilotChatModel/claudeCliModel, enableDynamicQueue)
8. Remove provider dropdown from Dashboard view (Settings view owns this now)
9. Use vscode.workspace.onDidChangeConfiguration for cross-view synchronization
10. CopilotChatIntegration always applies model from setting (consistent with CLI modes)
11. Order of precedence: prompt.json model field > Settings view selection
</requirements>

<files_to_create>
- src/ui/webview/settings.html
- src/ui/webview/settings.css
- src/ui/webview/settings.js
- src/ui/FlightPathSettingsProvider.ts
</files_to_create>

<files_to_modify>
- package.json (add copilotChatModel setting, add flightpath.settings view)
- src/types/DashboardConstants.ts (add CHANGE_MODEL, CHANGE_DYNAMIC_QUEUE message types)
- src/ui/webview/dashboard.html (remove provider dropdown)
- src/ui/webview/dashboard.js (remove provider handling, add config listener)
- src/ui/FlightPathDashboardProvider.ts (add config change listener)
- src/flightpath/chat/CopilotChatIntegration.ts (always apply model from setting)
- src/extension.ts (register FlightPathSettingsProvider)
</files_to_modify>

<success_criteria>
- Dashboard and Settings views appear side-by-side in bottom panel
- Each view has native VS Code collapsible header with > / ∨ toggle
- Provider change updates model dropdown options in Settings view
- Model selection persists to correct VS Code setting per provider
- Settings changes sync to Dashboard via configuration change events
- Copilot Chat mode always switches to selected model (not just when prompt specifies)
- Model from prompt file takes precedence over Settings view selection
- Warning shown when model switch fails (includes suggestion to change settings)
- Workflow continues with current model when switch fails (graceful degradation)
- Clean file separation: each view has its own HTML/CSS/JS
</success_criteria>
```
