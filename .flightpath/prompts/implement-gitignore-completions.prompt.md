Implement the "Respect .gitignore for Completions" feature for FlightPath using Option A (simple approach).

## Background

FlightPath shows file/symbol completions when users type `@` or `#` in prompts. Currently, it shows ALL workspace files including gitignored files (node_modules/, dist/, logs, etc.). We need a toggle to respect .gitignore.

**Research doc:** @docs/research/GITIGNORE_COMPLETIONS_RESEARCH.md

## Implementation (Option A - Simple Approach)

### 1. Add Setting to package.json

Add after `flightpath.autoAttachFiles` (line ~555):

```json
"flightpath.respectGitignoreForCompletions": {
  "order": 20,
  "type": "boolean",
  "default": true,
  "description": "Respect .gitignore files when showing file and symbol completions",
  "markdownDescription": "When enabled (default), FlightPath excludes gitignored files from `@` file completions and `#` symbol completions. This filters out build artifacts, dependencies, and IDE config files.\n\nDisable if you need to reference files in `.gitignore` (e.g., debugging build outputs, including error logs, referencing dependencies).\n\n**Applies to:** Dashboard prompt editor and VS Code editor (when editing `.flightpath.yml` files).\n\n**Toggle quickly:** Use checkbox in Settings panel → Session Settings (Quick Access)."
}
```

### 2. Update CompletionHelpers.ts

**File:** @src/completions/CompletionHelpers.ts

**Add helper function** (after imports):

```typescript
/**
 * Get the current value of respectGitignoreForCompletions setting
 */
function shouldRespectGitignore(): boolean {
  return vscode.workspace
    .getConfiguration("flightpath")
    .get<boolean>("respectGitignoreForCompletions", true);
}
```

**Update getWorkspaceFiles()** (lines 95-118):

Replace the entire function with:

```typescript
export async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const now = Date.now();

  // Return cached results if still valid
  if (
    filesCache.length > 0 &&
    filesCacheTimestamp &&
    now - filesCacheTimestamp < CACHE_DURATION_MS
  ) {
    return filesCache;
  }

  const respectGitignore = shouldRespectGitignore();

  // ON (true):  Let VS Code respect .gitignore, .ignore, files.exclude, etc.
  // OFF (false): Show ALL files (only exclude .git database - never useful)
  const exclude = respectGitignore
    ? undefined // VS Code handles exclusions (.gitignore, .ignore, files.exclude)
    : "**/.git/**"; // Only exclude Git database - show EVERYTHING else

  const files = await vscode.workspace.findFiles("**/*", exclude);

  // Update cache
  filesCache = files;
  filesCacheTimestamp = now;

  return files;
}
```

**Add cache invalidation** (after clearFilesCache function, around line 127):

```typescript
/**
 * Configuration change watcher for cache invalidation
 */
let configWatcher: vscode.Disposable | undefined;

/**
 * Initialize configuration watcher to clear cache on setting change
 */
export function initializeCompletionHelpers(
  context: vscode.ExtensionContext
): void {
  // Clear cache when gitignore setting changes
  configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("flightpath.respectGitignoreForCompletions")) {
      clearFilesCache();
      Log.info("[Completions] Cache cleared due to gitignore setting change");
    }
  });

  context.subscriptions.push(configWatcher);
}

/**
 * Dispose resources
 */
export function disposeCompletionHelpers(): void {
  configWatcher?.dispose();
}
```

### 3. Initialize in extension.ts

**File:** @src/extension.ts

**Add import:**

```typescript
import { initializeCompletionHelpers } from "./completions/CompletionHelpers";
```

**In activate() function** (after other initializations):

```typescript
// Initialize completion helpers with config watcher
initializeCompletionHelpers(context);
```

### 4. Add UI Checkbox to Settings Panel

**File:** @src/ui/webview/settings.html

**Add after Execution Mode setting** (after line 220, before "More Settings" button):

```html
<!-- Respect Gitignore Checkbox -->
<div class="setting-group">
  <label class="checkbox-label">
    <input type="checkbox" id="respect-gitignore" checked />
    <span>Respect .gitignore for completions</span>
  </label>
  <span class="setting-description">
    When enabled, hides gitignored files from @ and # completions. Disable to
    reference build outputs, logs, or dependencies.
  </span>
</div>
```

### 5. Wire Up Checkbox in settings.js

**File:** @src/ui/webview/settings.js

**Find the initialization code** (likely in `window.addEventListener('message')` or `loadSettings()`):

**Add checkbox wiring:**

```javascript
// Get checkbox element
const respectGitignoreCheckbox = document.getElementById('respect-gitignore');

// Request initial value from extension
vscode.postMessage({
  type: 'getConfig',
  key: 'respectGitignoreForCompletions'
});

// Handle config value response
// (Add this case to existing message handler)
case 'configValue':
  if (message.key === 'respectGitignoreForCompletions') {
    respectGitignoreCheckbox.checked = message.value ?? true;
  }
  break;

// Update setting when checkbox changes
respectGitignoreCheckbox.addEventListener('change', (e) => {
  vscode.postMessage({
    type: 'updateConfig',
    key: 'respectGitignoreForCompletions',
    value: e.target.checked
  });
});
```

### 6. Add Message Handlers to FlightPathSettingsProvider.ts

**File:** @src/ui/FlightPathSettingsProvider.ts

**In \_handleWebviewMessage() method** (add these cases):

```typescript
case 'getConfig': {
  const value = vscode.workspace
    .getConfiguration('flightpath')
    .get<boolean>(message.key);

  this._view.webview.postMessage({
    type: 'configValue',
    key: message.key,
    value: value
  });
  break;
}

case 'updateConfig': {
  await vscode.workspace
    .getConfiguration('flightpath')
    .update(message.key, message.value, vscode.ConfigurationTarget.Global);
  break;
}
```

## Expected Behavior

**Setting ON (default):**

- Dashboard completions: Hides gitignored files
- VS Code editor completions: Hides gitignored files
- Dropdown shows ~5,000 files (clean, source files only)

**Setting OFF:**

- Dashboard completions: Shows ALL files including node_modules/, dist/, logs
- VS Code editor completions: Shows ALL files
- Dropdown shows ~10,000 files (everything except .git/)
- Only `.git/` directory excluded (binary database)

**Checkbox in Settings Panel:**

- Checked = ON (respect .gitignore)
- Unchecked = OFF (show all files)
- Changes global VS Code setting immediately
- Cache cleared automatically, completions update on next trigger

## Testing Checklist

1. ✅ Create test file in `.gitignore` (e.g., `test.log`)
2. ✅ Setting ON: File does NOT appear in `@` completions
3. ✅ Setting OFF: File DOES appear in `@` completions
4. ✅ Toggle checkbox in Settings panel updates completions immediately
5. ✅ Verify `node_modules/` hidden when ON, shown when OFF
6. ✅ Test in VS Code editor (editing `.flightpath.yml` file) - same behavior
7. ✅ Verify cache clears when toggling setting (check console logs)

## Notes

- VS Code's `findFiles()` respects .gitignore by default when exclude is `undefined`
- When setting is OFF, we only exclude `**/.git/**` (Git database directory)
- Symbol completions (`#` trigger) likely already respect .gitignore (no changes needed)
- Cache invalidation is critical - config change listener clears cache immediately

## Success Criteria

- Checkbox appears in Settings panel under "Session Settings (Quick Access)"
- Checkbox is checked by default (respects .gitignore)
- Toggling checkbox updates VS Code setting globally
- Completions update immediately after toggle (no reload needed)
- Works in both dashboard and VS Code editor
- Console shows cache clear message when setting changes
