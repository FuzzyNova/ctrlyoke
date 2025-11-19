# Context Menu Integration - Implementation Plan

## ✅ IMPLEMENTATION COMPLETE

All features from this plan have been successfully implemented:

- ✅ Context menu commands for `.prompt.json`, `.flightpath.json`, and `.prompt.md` files
- ✅ Send to CLI and Send to Chat commands in Explorer view (right-click file)
- ✅ Send to CLI and Send to Chat commands in Editor tab (right-click tab)
- ✅ Mode override support in FlightPathManager
- ✅ Markdown prompt file support (`.prompt.md`)
- ✅ Documentation updated (README.md, QUICK_START.md, copilot-instructions.md)

**Key Implementation Details:**

- Markdown files (`.prompt.md`) are read as plain text and treated as single prompts
- No JSON parsing required for `.prompt.md` files
- All three file formats work with both context menu commands
- Context menus available in both Explorer view and Editor tab
- Mode override properly handled without affecting user settings

---

## Objective

Add context menu items to FlightPath prompt files (`.flightpath.json`, `.prompt.json`, `.prompt.md`) in VS Code Explorer with two commands:

- **FlightPath: Send to CLI** - Execute using Copilot CLI
- **FlightPath: Send to Chat** - Execute using Copilot Chat

## Implementation Steps

### 1. Update package.json

Add two new commands:

```json
{
  "command": "flightpath.sendToCli",
  "title": "Send to CLI",
  "category": "FlightPath",
  "icon": "$(terminal)"
},
{
  "command": "flightpath.sendToChat",
  "title": "Send to Chat",
  "category": "FlightPath",
  "icon": "$(comment)"
}
```

Add menu contributions:

```json
"menus": {
  "explorer/context": [
    {
      "command": "flightpath.sendToCli",
      "when": "resourceFilename =~ /\\.(prompt\\.json|flightpath\\.json|prompt\\.md)$/ && resourceScheme == file",
      "group": "flightpath@1"
    },
    {
      "command": "flightpath.sendToChat",
      "when": "resourceFilename =~ /\\.(prompt\\.json|flightpath\\.json|prompt\\.md)$/ && resourceScheme == file",
      "group": "flightpath@2"
    }
  ],
  "editor/title/context": [
    {
      "command": "flightpath.sendToCli",
      "when": "resourceFilename =~ /\\.(prompt\\.json|flightpath\\.json|prompt\\.md)$/ && resourceScheme == file",
      "group": "flightpath@1"
    },
    {
      "command": "flightpath.sendToChat",
      "when": "resourceFilename =~ /\\.(prompt\\.json|flightpath\\.json|prompt\\.md)$/ && resourceScheme == file",
      "group": "flightpath@2"
    }
  ],
  "commandPalette": [
    {
      "command": "flightpath.sendToCli",
      "when": "false"
    },
    {
      "command": "flightpath.sendToChat",
      "when": "false"
    }
  ]
}
```

**Key Points:**

- Regex pattern matches all three file types: `.prompt.json`, `.flightpath.json`, `.prompt.md`
- `resourceScheme == file` ensures local files only
- `group: "flightpath@1"` and `@2` creates grouped section in context menu
- `explorer/context` adds commands to file explorer right-click menu
- `editor/title/context` adds commands to editor tab right-click menu
- `commandPalette` with `"when": "false"` hides commands from palette (they need file context)

### 2. Register Command Handlers in extension.ts

```typescript
// Register context menu commands
context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.sendToCli",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await flightPathManager.executePromptFile(uri.fsPath, "cli");
        vscode.window.showInformationMessage(
          "FlightPath workflow started using CLI"
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute FlightPath workflow: ${error}`
        );
      }
    }
  )
);

context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.sendToChat",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await flightPathManager.executePromptFile(uri.fsPath, "chat");
        vscode.window.showInformationMessage(
          "FlightPath workflow started using Chat"
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute FlightPath workflow: ${error}`
        );
      }
    }
  )
);
```

### 3. Modify FlightPathManager.ts

#### 3a. Update executePromptFile() signature

```typescript
/**
 * Execute a prompt file with optional integration mode override
 * @param filePath Path to the prompt file
 * @param modeOverride Optional integration mode (overrides user settings for this execution)
 */
async executePromptFile(
  filePath: string,
  modeOverride?: "cli" | "chat"
): Promise<void> {
  try {
    console.log(`FlightPath: Executing prompt file: ${filePath}`);

    // Create integration for this execution (either override or default)
    const integration = this.createIntegrationForMode(modeOverride);

    // Check Copilot readiness FIRST
    const detailedStatus = integration.getDetailedStatus();
    const fileName = path.basename(filePath);

    // Block execution if still initializing
    if (detailedStatus.initializationStatus === "initializing") {
      const action = await vscode.window.showWarningMessage(
        `FlightPath is still initializing Copilot integration. Please wait a moment and try again.`,
        "Retry",
        "Cancel"
      );
      if (action === "Retry") {
        setTimeout(() => this.executePromptFile(filePath, modeOverride), 1000);
      }
      return;
    }

    // Block execution if waiting for Copilot
    if (detailedStatus.initializationStatus === "waiting") {
      const action = await vscode.window.showWarningMessage(
        `FlightPath is waiting for Copilot to activate (attempt ${detailedStatus.pollingAttempts}/${detailedStatus.maxPollingAttempts}). Please wait...`,
        "Retry",
        "Cancel"
      );
      if (action === "Retry") {
        setTimeout(() => this.executePromptFile(filePath, modeOverride), 2000);
      }
      return;
    }

    // Block execution if unavailable
    if (detailedStatus.initializationStatus === "unavailable") {
      const action = await vscode.window.showErrorMessage(
        `FlightPath: Copilot automation is unavailable. Please ensure GitHub Copilot Chat is installed and active.`,
        "Retry Detection",
        "View Requirements",
        "Cancel"
      );
      if (action === "Retry Detection") {
        await this.retryCopilotDetection();
        setTimeout(() => this.executePromptFile(filePath, modeOverride), 2000);
      } else if (action === "View Requirements") {
        if (this.isChatIntegration(integration)) {
          await integration.testAutomation();
        } else {
          vscode.window.showInformationMessage(
            "FlightPath: Using CLI integration. Test automation is not needed."
          );
        }
      }
      return;
    }

    // Parse the prompt file (existing logic)
    const promptFile = await this.promptFileParser.parsePromptFile(filePath);
    if (!promptFile || !promptFile.prompts) {
      vscode.window.showErrorMessage("FlightPath: Failed to parse prompt file");
      return;
    }

    // Validate prompts (existing logic)
    const validation = this.promptFileParser.validatePromptItems(promptFile.prompts);
    if (!validation.valid) {
      const errors = validation.errors.join("\n");
      vscode.window.showErrorMessage(`FlightPath: Validation failed:\n${errors}`);
      return;
    }

    // Load prompts into queue (existing logic)
    this.promptQueue.loadPrompts(promptFile.prompts);

    // Show confirmation
    let confirmMessage = `Execute ${promptFile.prompts.length} prompt(s) from ${fileName}?`;
    confirmMessage += "\n\n✅ Copilot automation is ready - workflow will run automatically!";

    const action = await vscode.window.showInformationMessage(
      confirmMessage,
      { modal: true },
      "Take Off 🚀",
      "Cancel"
    );

    if (action === "Take Off 🚀") {
      integration.setWorkflowProgress(1, promptFile.prompts.length);
      await this.startWorkflowExecution(integration);
    }
  } catch (error) {
    console.error("FlightPath: Failed to execute prompt file:", error);
    vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
  }
}
```

#### 3b. Add createIntegrationForMode() helper method

```typescript
/**
 * Create integration instance based on mode override or user settings
 * @param modeOverride Optional mode to override user settings
 * @returns Integration instance (either override or default)
 */
private createIntegrationForMode(modeOverride?: "cli" | "chat"): CopilotIntegration {
  if (modeOverride) {
    console.log(`🔀 FlightPath: Using mode override: ${modeOverride}`);

    switch (modeOverride) {
      case "cli":
        return new CopilotCommandLineIntegration(this.context, this.outputChannel);
      case "chat":
        return new CopilotChatIntegration(this.context);
    }
  }

  // Use default integration from instance (respects user settings)
  return this.copilotIntegration;
}
```

#### 3c. Update startWorkflowExecution() to accept integration parameter

```typescript
/**
 * Start workflow execution with Copilot integration
 * @param integration Optional integration to use (defaults to instance integration)
 */
private async startWorkflowExecution(integration?: CopilotIntegration): Promise<void> {
  const activeIntegration = integration || this.copilotIntegration;
  const state = this.promptQueue.getState();

  // Log workflow start to output channel
  const shouldShowOutput = vscode.workspace
    .getConfiguration("flightpath")
    .get<boolean>("showCliOutput", true);

  if (shouldShowOutput && this.isCliIntegration(activeIntegration)) {
    this.outputChannel.clear();
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
    this.outputChannel.appendLine("        FLIGHTPATH WORKFLOW STARTED");
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
    this.outputChannel.appendLine(`Started: ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine(`Total prompts: ${state.prompts.length}`);
    this.outputChannel.appendLine(
      `Integration: ${activeIntegration.getStatus().strategy.toUpperCase()}`
    );
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
    this.outputChannel.appendLine("");
    this.outputChannel.show(true);
  }

  for (let i = 0; i < state.prompts.length; i++) {
    const prompt = state.prompts[i];

    // Update progress
    activeIntegration.setWorkflowProgress(i + 1, state.prompts.length);

    console.log(`🚀 FlightPath: Executing prompt ${i + 1}/${state.prompts.length}`);

    // Only need completion detection for multi-prompt workflows
    const needsCompletionDetection = state.prompts.length > 1;

    // Set up response listener BEFORE sending prompt
    const responsePromise = needsCompletionDetection
      ? this.waitForResponseComplete(prompt, activeIntegration)
      : Promise.resolve("");

    // Send prompt to Copilot
    const success = await activeIntegration.sendPrompt(prompt, needsCompletionDetection);

    if (!success) {
      vscode.window.showErrorMessage(`FlightPath: Failed to execute prompt ${i + 1}`);
      break;
    }

    // Mark as sent in queue
    await this.promptQueue.markCurrentAsSent();

    // Wait for Copilot to finish responding
    let responseText = "";
    if (needsCompletionDetection) {
      console.log(`⏳ FlightPath: Waiting for Copilot to finish responding to prompt ${i + 1}...`);
      responseText = await responsePromise;
      console.log(`✅ FlightPath: Prompt ${i + 1} completed`);

      // Evaluate end condition if present
      if (prompt.endCondition) {
        console.log(`🔍 FlightPath: Evaluating end condition for prompt ${i + 1}...`);
        // TODO: Implement end condition evaluation with response text
      }
    } else {
      console.log(`✅ FlightPath: Single prompt sent successfully - workflow complete`);
    }

    // Check if workflow was paused
    if (this.promptQueue.getState().status === "paused") {
      console.log("⏸️ FlightPath: Workflow paused");
      break;
    }
  }

  console.log("🎉 FlightPath: Workflow execution complete");

  // Log workflow completion
  if (shouldShowOutput && this.isCliIntegration(activeIntegration)) {
    this.outputChannel.appendLine("");
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
    this.outputChannel.appendLine("        WORKFLOW COMPLETE ✓");
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
    this.outputChannel.appendLine(`Completed: ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine(`Prompts completed: ${state.prompts.length}/${state.prompts.length}`);
    this.outputChannel.appendLine("═══════════════════════════════════════════════════════════");
  }
}
```

#### 3d. Update waitForResponseComplete() to accept integration parameter

```typescript
/**
 * Wait for Copilot to call the response complete tool
 * @param prompt The current prompt being executed
 * @param integration The integration instance to use
 * @returns Promise that resolves with response text when complete
 */
private async waitForResponseComplete(
  prompt: PromptItem,
  integration: CopilotIntegration
): Promise<string> {
  const timeout = prompt.endCondition?.timeout || 1800000; // Default 30 minutes

  return new Promise<string>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      disposable.dispose();
      console.warn(`⚠️ FlightPath: Response completion timeout after ${timeout}ms`);
      vscode.window.showWarningMessage(
        `FlightPath: Response timeout after ${Math.round(timeout / 60000)} minutes - proceeding to next prompt.`
      );
      resolve("");
    }, timeout);

    let responseHandled = false;
    const disposable = integration.onResponseComplete(async (responseText: string) => {
      if (responseHandled) {
        console.log("⚠️ FlightPath: Duplicate response complete event ignored");
        return;
      }
      responseHandled = true;

      clearTimeout(timeoutHandle);
      disposable.dispose();
      console.log("✅ FlightPath: Response complete signal received");
      console.log(`📊 Response text length: ${responseText.length} characters`);

      // Wait for streaming to finish (chat integration only)
      if (this.isChatIntegration(integration)) {
        console.log("⏳ FlightPath: Waiting for Copilot chat to finish streaming...");
        await integration.waitForStreamingComplete();
        console.log("✅ FlightPath: Copilot finished streaming");
      }

      resolve(responseText);
    });
  });
}
```

## Testing Checklist

### File Extension Matching (Explorer View)

- [ ] Right-click `.flightpath.json` in explorer → Both commands appear
- [ ] Right-click `.prompt.json` in explorer → Both commands appear
- [ ] Right-click `.prompt.md` in explorer → Both commands appear
- [ ] Right-click regular `.json` in explorer → Commands do NOT appear

### File Extension Matching (Editor Tab)

- [ ] Right-click `.flightpath.json` tab → Both commands appear
- [ ] Right-click `.prompt.json` tab → Both commands appear
- [ ] Right-click `.prompt.md` tab → Both commands appear
- [ ] Right-click regular `.json` tab → Commands do NOT appear

### Command Execution

- [ ] "Send to CLI" executes workflow using CLI integration
- [ ] "Send to Chat" executes workflow using Chat integration
- [ ] Original user settings unchanged after execution
- [ ] Workflow completes successfully with override mode

### Error Handling

- [ ] Invalid prompt file shows error message
- [ ] Missing file handled gracefully
- [ ] Integration initialization failure shows appropriate message

### Context Stability

- [ ] Commands appear with Settings view open
- [ ] Commands appear with other panels focused

## Architecture Notes

### DRY Principles Applied

- All prompt parsing, validation, and execution logic remains in `executePromptFile()`
- Command handlers are thin (3-4 lines each)
- Integration creation reuses existing factory pattern
- No instance variable swapping (prevents race conditions)
- Backward compatible (optional parameter)

### Key Design Decisions

- **Optional parameter**: `modeOverride?: "cli" | "chat"` extends existing method
- **Pass integration explicitly**: Avoids race conditions from instance swapping
- **Minimal API changes**: Only adds optional parameters to existing methods
- **Single source of truth**: All workflow logic stays centralized

## Implementation Order

1. Update `package.json` (commands and menus)
2. Modify `FlightPathManager.ts` (add mode override support)
3. Register command handlers in `extension.ts`
4. Test all scenarios
5. Update user documentation (README.md, QUICK_START.md)
