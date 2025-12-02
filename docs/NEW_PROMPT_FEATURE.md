# New Prompt Feature Implementation Plan

## Overview

Add a "New" button to the FlightPath dashboard that creates a timestamped draft prompt file and opens it in the VS Code editor for quick editing. This enables rapid prompt creation without manually creating files, leveraging VS Code's existing editor features (spell check, language server, autocomplete).

## User Flow

1. User clicks **New** button in dashboard header (next to Edit button)
2. FlightPath creates `.flightpath/prompts/YYYYMMDD-HHmmss.prompt.md`
3. File opens in VS Code editor, docked in bottom panel (if possible)
4. User writes their prompt using full VS Code editor features
5. File is auto-selected in dashboard, ready to run
6. **As user edits, dashboard auto-reloads the prompt content**

## Design Decisions ✅

| Decision         | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Folder name      | `.flightpath/prompts/`                                                  |
| File naming      | `YYYYMMDD-HHmmss.prompt.md` (e.g., `20251201-143052.prompt.md`)         |
| Template content | Empty file (blank)                                                      |
| Auto-select      | Yes - auto-select in dashboard after creation                           |
| File watching    | Yes - reload prompt content when file changes (before execution starts) |

## Implementation Steps

### 1. Add Message Type (DashboardConstants.ts)

```typescript
// Webview -> Extension
NEW_PROMPT: "newPrompt",
```

### 2. Update Dashboard HTML (dashboard.html)

Add "New" button after the Edit button in the file-buttons div:

```html
<div class="file-buttons">
  <button
    id="new-prompt"
    class="btn-secondary btn-small"
    title="Create new draft prompt"
  >
    New
  </button>
  <button
    id="select-file"
    class="btn-secondary btn-small"
    title="Select a different prompt file"
  >
    Select
  </button>
  <button
    id="edit-file"
    class="btn-secondary btn-small"
    title="Open current prompt file in editor"
    disabled
  >
    Edit
  </button>
</div>
```

### 3. Update Dashboard JavaScript (dashboard.js)

Add element reference and event listener:

```javascript
// In elements object
newPromptBtn: (document.getElementById("new-prompt"),
  // Add event listener
  elements.newPromptBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_PROMPT });
  }));
```

### 4. Update Dashboard Provider (FlightPathDashboardProvider.ts)

Add to messageCommandMap:

```typescript
[MESSAGE_TYPES.NEW_PROMPT, "flightpath.createDraftPrompt"],
```

### 5. Register New Command (extension.ts)

```typescript
const createDraftPromptCommand = vscode.commands.registerCommand(
  "flightpath.createDraftPrompt",
  async () => {
    await flightPathManager.createDraftPrompt();
  }
);
```

Add to subscriptions array.

### 6. Implement createDraftPrompt (FlightPathManager.ts)

```typescript
/**
 * Create a new draft prompt file with timestamp-based name
 * Opens in editor and auto-selects in dashboard
 */
async createDraftPrompt(): Promise<void> {
  try {
    if (!this.currentWorkspaceFolder) {
      vscode.window.showErrorMessage("FlightPath: No workspace folder found");
      return;
    }

    // Generate timestamp-based filename: YYYYMMDD-HHmmss.prompt.md
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fileName = `${timestamp}.prompt.md`;

    // Create prompts directory
    const promptsDir = path.join(
      this.currentWorkspaceFolder.uri.fsPath,
      ".flightpath",
      "prompts"
    );

    // Ensure directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(promptsDir));

    const filePath = path.join(promptsDir, fileName);
    const uri = vscode.Uri.file(filePath);

    // Create empty file
    await vscode.workspace.fs.writeFile(uri, Buffer.from("", "utf8"));

    // Open file in editor
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    // Move editor to bottom panel (best effort)
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToBelowGroup");
    } catch {
      // Ignore if command fails (no bottom group exists)
    }

    // Auto-select in dashboard (this will also set up the file watcher)
    await this.loadPromptFile(filePath);

    console.log(`FlightPath: Created draft prompt: ${fileName}`);
  } catch (error) {
    console.error("FlightPath: Failed to create draft prompt:", error);
    vscode.window.showErrorMessage(
      `FlightPath: Failed to create draft prompt: ${error}`
    );
  }
}
```

### 7. Add File Watcher for Live Reload (FlightPathManager.ts)

Add file watcher to reload prompt content when the selected file changes:

```typescript
private promptFileWatcher?: vscode.FileSystemWatcher;

/**
 * Set up file watcher for the currently loaded prompt file
 * Reloads prompt content when file changes (only when not executing)
 */
private setupPromptFileWatcher(filePath: string): void {
  // Dispose existing watcher
  this.promptFileWatcher?.dispose();

  // Create watcher for this specific file
  const pattern = new vscode.RelativePattern(
    path.dirname(filePath),
    path.basename(filePath)
  );

  this.promptFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  this.promptFileWatcher.onDidChange(async (uri) => {
    // Only reload if not currently executing
    const state = this.promptQueue.getState();
    if (state.status === EXECUTION_STATES.IDLE ||
        state.status === EXECUTION_STATES.COMPLETED ||
        state.status === EXECUTION_STATES.ERROR) {
      console.log(`FlightPath: Prompt file changed, reloading: ${uri.fsPath}`);
      await this.reloadCurrentPromptFile();
    }
  });

  // Also watch for deletion
  this.promptFileWatcher.onDidDelete((uri) => {
    console.log(`FlightPath: Prompt file deleted: ${uri.fsPath}`);
    this.currentPromptFile = undefined;
    if (this.dashboardProvider) {
      this.dashboardProvider.updateFileSelected("No file selected", []);
    }
  });
}

/**
 * Reload the currently loaded prompt file
 */
private async reloadCurrentPromptFile(): Promise<void> {
  if (!this.currentPromptFile) return;

  try {
    const filePath = this.currentPromptFile.filePath;
    const fileName = path.basename(filePath);

    // Re-parse the file
    const promptFile = await this.promptFileParser.parsePromptFile(filePath);
    if (!promptFile || !promptFile.prompts) return;

    // Validate
    const validation = this.promptFileParser.validatePromptItems(promptFile.prompts);
    if (!validation.valid) return;

    // Update stored file
    this.currentPromptFile = { filePath, promptFile };

    // Reload queue
    this.promptQueue.loadPrompts(promptFile.prompts);

    // Update dashboard
    if (this.dashboardProvider) {
      this.dashboardProvider.updateFileSelected(
        fileName,
        promptFile.prompts.map((p) => ({ prompt: p.prompt }))
      );
    }

    console.log(`FlightPath: Reloaded ${promptFile.prompts.length} prompt(s) from ${fileName}`);
  } catch (error) {
    console.error("FlightPath: Failed to reload prompt file:", error);
  }
}
```

Update `loadPromptFile()` to set up the watcher:

```typescript
async loadPromptFile(filePath: string): Promise<void> {
  // ... existing code ...

  // Store the loaded file
  this.currentPromptFile = { filePath, promptFile };

  // Set up file watcher for live reload
  this.setupPromptFileWatcher(filePath);

  // ... rest of existing code ...
}
```

Update `dispose()` to clean up watcher:

```typescript
dispose(): void {
  this.promptFileWatcher?.dispose();
  this.statusBarManager.dispose();
  this.endConditionEvaluator.dispose();
  console.log("FlightPath: Manager disposed");
}
```

### 8. Update package.json

Add command registration:

```json
{
  "command": "flightpath.createDraftPrompt",
  "title": "FlightPath: New Draft Prompt"
}
```

## VS Code Commands Used

| Command                                   | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `workbench.action.moveEditorToBelowGroup` | Move opened file to bottom panel area       |
| `workbench.action.newGroupBelow`          | Create new editor group below (alternative) |
| `workbench.action.splitEditorDown`        | Split editor downward (alternative)         |

## File Watcher Behavior

| Queue State | File Change Behavior                    |
| ----------- | --------------------------------------- |
| `idle`      | Reload prompt content immediately       |
| `completed` | Reload prompt content immediately       |
| `error`     | Reload prompt content immediately       |
| `running`   | **Ignore** - don't interrupt execution  |
| `paused`    | **Ignore** - don't disrupt paused state |

**Note:** Dynamic queue reloading during execution is handled separately by the existing `enableDynamicQueue` feature.

## Edge Cases

1. **No workspace folder**: Show error message
2. **Prompts folder doesn't exist**: Create it automatically (using `vscode.workspace.fs.createDirectory`)
3. **Move to bottom fails**: Silently ignore - file is still open, just not positioned
4. **File with same timestamp exists**: Extremely unlikely (second precision), but could add suffix
5. **File deleted while selected**: Clear selection, show "No file selected"
6. **File changed during execution**: Ignore changes until execution completes

## Future Enhancements

1. **Prompt cleanup**: Add command/button to delete old prompts (e.g., older than 7 days)
2. **Prompt renaming**: Prompt user to rename after successful execution
3. **Prompt templates**: Allow user-defined templates for new prompts
4. **Keyboard shortcut**: Add keybinding for rapid prompt creation
5. **Recent prompts list**: Show recent prompts in dashboard for quick access

## Files to Modify

| File                                    | Changes                                           |
| --------------------------------------- | ------------------------------------------------- |
| `src/types/DashboardConstants.ts`       | Add `NEW_PROMPT` message type                     |
| `src/ui/webview/dashboard.html`         | Add "New" button                                  |
| `src/ui/webview/dashboard.js`           | Add event listener for New button                 |
| `src/ui/FlightPathDashboardProvider.ts` | Map NEW_PROMPT to command                         |
| `src/flightpath/FlightPathManager.ts`   | Implement `createDraftPrompt()`, add file watcher |
| `src/extension.ts`                      | Register `flightpath.createDraftPrompt` command   |
| `package.json`                          | Add command definition                            |

## Testing Plan

1. **Happy path**: Click New → file created → opens in editor → selected in dashboard
2. **No workspace**: Verify error message shown
3. **First time (no drafts folder)**: Verify folder created automatically
4. **Multiple rapid clicks**: Verify unique filenames generated
5. **Run after creation**: Verify file executes correctly through FlightPath
6. **Edit and run cycle**: Create draft → edit → run → verify execution
7. **Live reload**: Edit file in editor → verify dashboard updates automatically
8. **No reload during execution**: Start execution → edit file → verify no reload until complete
9. **File deletion**: Delete selected file → verify dashboard clears selection
