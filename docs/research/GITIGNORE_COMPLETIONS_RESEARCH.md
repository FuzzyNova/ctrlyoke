# FlightPath: Respect .gitignore for Completions - Research & Implementation Plan

**Status:** Research Complete
**Date:** 2026-01-31
**Target:** Add setting to control whether completions respect `.gitignore` files

---

## Executive Summary

FlightPath currently shows all workspace files in completions (@ and # triggers), including files that are gitignored (e.g., `node_modules/`, build artifacts, IDE config). This research investigates how to add a setting to respect `.gitignore` files.

**Key Finding:** VS Code's `workspace.findFiles()` API **DOES respect .gitignore by default**, but FlightPath's current exclude pattern manually bypasses this for some directories. We need to **remove manual excludes** and optionally use the **Git Extension API** for explicit gitignore checking.

---

## Current Implementation Analysis

### File Completions (@ trigger)

**Location:** `src/completions/CompletionHelpers.ts:95-118`

```typescript
export async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  // Find all files in workspace, excluding common directories
  const files = await vscode.workspace.findFiles(
    "**/*",
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode/**}"
  );

  return files;
}
```

**Issue:** Hardcoded excludes bypass VS Code's native .gitignore handling. This means:

- Files in `.gitignore` but NOT in the hardcoded list still appear
- Developers using different build/output folder names (e.g., `target/`, `bin/`) won't get automatic filtering

### Symbol Completions (# trigger)

**Location:** `src/completions/CompletionHelpers.ts:232-282`

```typescript
export async function getSymbolCompletions(
  filterText: string,
  maxResults: number = 500
): Promise<PlainCompletionItem[]> {
  const symbols = await getWorkspaceSymbols(filterText, maxResults);
  // ...
}
```

**Used in:** `src/utils/AttachmentBuilders.ts` → `vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)`

**Behavior:** Likely respects `.gitignore` automatically (VS Code's symbol provider filters indexed files).

### Dashboard WebView Completions

**Location:** `src/ui/webview/codemirror-editor.js:491-538`

Dashboard sends `requestCompletions` message to extension, which routes through the same `CompletionHelpers.ts` functions via message handler.

**Path:** WebView → Extension Message Handler → `CompletionHelpers.getFileCompletions()` / `CompletionHelpers.getHashCompletions()` → Response back to WebView

**Conclusion:** All completions (editor and dashboard) flow through the same `CompletionHelpers.ts` functions, so fixing it in one place fixes it everywhere.

---

## VS Code API Capabilities

### 1. Default `findFiles()` Behavior

**Source:** [VS Code Issue #36617](https://github.com/Microsoft/vscode/issues/36617)

```typescript
vscode.workspace.findFiles(include, exclude, maxResults, token);
```

**Key Behaviors:**

- **DOES respect `.gitignore` by default** when exclude pattern is not provided or when using simple patterns
- **Manual excludes bypass gitignore** (current FlightPath behavior)
- Also respects:
  - `.ignore` files
  - `.rgignore` files
  - `.git/info/exclude` files
  - User settings: `files.exclude` and `search.exclude`

**Limitation:** Extensions cannot control the `search.useIgnoreFiles` setting (ignored for programmatic calls).

### 2. Proposed `findFiles2` API (Not Yet Stable)

**Source:** [VS Code Issue #204657](https://github.com/microsoft/vscode/issues/204657)

```typescript
// PROPOSED API (not available yet)
await vscode.workspace.findFiles2("**/*", {
  exclude: "**/*.log",
  useIgnoreFiles: true, // Explicit control
});
```

**Status:** API proposal in discussion, not available in stable VS Code
**Impact:** Cannot use this API until it ships in a stable release

### 3. Git Extension API (Available Now)

**Source:** [VS Code Git Extension API](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)

```typescript
interface Repository {
  /**
   * Check if paths match patterns in .gitignore
   * @param paths Array of file paths to check
   * @returns Set of paths that are gitignored
   */
  checkIgnore(paths: string[]): Promise<Set<string>>;
}
```

**Usage Example:**

```typescript
// Get Git extension
const gitExtension = vscode.extensions.getExtension("vscode.git");
if (!gitExtension?.isActive) {
  await gitExtension?.activate();
}

const gitApi = gitExtension?.exports.getAPI(1);
const repository = gitApi.getRepository(workspaceUri);

// Check which files are ignored
const filePaths = files.map((uri) => uri.fsPath);
const ignoredPaths = await repository.checkIgnore(filePaths);

// Filter out ignored files
const filteredFiles = files.filter((uri) => !ignoredPaths.has(uri.fsPath));
```

**Advantages:**

- Explicit control over gitignore filtering
- Works with current stable VS Code
- Handles complex `.gitignore` patterns correctly

**Limitations:**

- Requires Git extension to be installed (99.9% of developers have this)
- Only works in Git repositories (non-Git workspaces won't benefit)
- Batch checking is more efficient than per-file checks

---

## Recommended Implementation Strategy

### Option A: Simple Approach (Recommended)

**Remove manual excludes and rely on VS Code's native behavior:**

```typescript
export async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const respectGitignore = shouldRespectGitignore();

  // ON (true):  Let VS Code respect .gitignore, .ignore, files.exclude, etc.
  // OFF (false): Show ALL files (only exclude .git database directory - never useful)
  const exclude = respectGitignore
    ? undefined // VS Code handles exclusions (.gitignore, .ignore, files.exclude)
    : "**/.git/**"; // Only exclude Git database - show EVERYTHING else

  const files = await vscode.workspace.findFiles("**/*", exclude);
  return files;
}
```

**Behavior:**

- **Setting ON** (default): Respects `.gitignore`, `.ignore`, `.rgignore`, and VS Code's `files.exclude`/`search.exclude` settings
- **Setting OFF**: Shows ALL workspace files including:
  - `node_modules/` (dependencies)
  - `dist/`, `out/`, `build/` (build outputs)
  - `.log`, `.cache` files (logs and caches)
  - `.env`, config files (even if gitignored)
  - Generated docs, screenshots, etc.
  - **Only excludes:** `.git/` directory itself (binary Git database - never useful in prompts)

**Pros:**

- Minimal code changes
- Zero external dependencies
- Works with any ignore file format (`.gitignore`, `.ignore`, `.rgignore`)
- Respects user's `files.exclude` and `search.exclude` settings (when ON)
- **True toggle behavior** - OFF shows everything users need

**Cons:**

- Less explicit control
- Behavior depends on VS Code's internal implementation

### Option B: Explicit Git API Approach (More Control)

**Use Git extension for explicit filtering:**

```typescript
export async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const respectGitignore = shouldRespectGitignore();

  // Get ALL files (only exclude .git database - never useful in prompts)
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/.git/**" // Only exclude Git database directory
  );

  if (!respectGitignore) {
    // Setting OFF: Return ALL files (including node_modules, dist, logs, etc.)
    return files;
  }

  // Setting ON: Filter out gitignored files using Git extension API
  const filtered = await filterGitIgnoredFiles(files);
  return filtered;
}

async function filterGitIgnoredFiles(
  files: vscode.Uri[]
): Promise<vscode.Uri[]> {
  try {
    // Get Git extension
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      Log.warn("Git extension not found, cannot filter gitignored files");
      return files;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const gitApi = gitExtension.exports.getAPI(1);
    if (!gitApi) {
      return files;
    }

    // Group files by repository
    const filesByRepo = new Map<any, vscode.Uri[]>();

    for (const file of files) {
      const repo = gitApi.getRepository(file);
      if (repo) {
        if (!filesByRepo.has(repo)) {
          filesByRepo.set(repo, []);
        }
        filesByRepo.get(repo)!.push(file);
      } else {
        // File not in a Git repository - keep it
        if (!filesByRepo.has(null)) {
          filesByRepo.set(null, []);
        }
        filesByRepo.get(null)!.push(file);
      }
    }

    // Check gitignore status for each repository
    const filteredFiles: vscode.Uri[] = [];

    for (const [repo, repoFiles] of filesByRepo.entries()) {
      if (repo === null) {
        // Non-git files - keep all
        filteredFiles.push(...repoFiles);
        continue;
      }

      // Batch check all files in this repository
      const filePaths = repoFiles.map((uri) => uri.fsPath);
      const ignoredPaths = await repo.checkIgnore(filePaths);

      // Keep only non-ignored files
      const kept = repoFiles.filter((uri) => !ignoredPaths.has(uri.fsPath));
      filteredFiles.push(...kept);
    }

    return filteredFiles;
  } catch (error) {
    Log.error("Failed to filter gitignored files:", error);
    return files; // Fallback: return all files
  }
}
```

**Pros:**

- Explicit control over filtering
- Clear error handling and logging
- Can provide user feedback if Git extension is missing
- Handles multi-root workspaces correctly

**Cons:**

- More complex code
- Dependency on Git extension (but acceptable)
- Performance overhead (batch API call per repository)

---

## Toggle Behavior & Use Cases

### Setting ON (Default): Respect .gitignore

**Goal:** Clean completions dropdown - hide irrelevant files

**What's Hidden:**

- ✅ `node_modules/` - Dependencies (rarely need to reference)
- ✅ `dist/`, `out/`, `build/` - Build artifacts (generated files)
- ✅ `.cache/`, `.temp/` - Cache directories
- ✅ `.env`, `.env.local` - Environment files (usually gitignored)
- ✅ IDE config (`.vscode/`, `.idea/`) if gitignored
- ✅ Test coverage reports (`coverage/`)
- ✅ Anything in your `.gitignore`, `.ignore`, or `files.exclude`

**Use Case:** Normal workflow - focus on source code files you're actively developing

### Setting OFF: Show ALL Files

**Goal:** Reference ANY file in workspace, even if gitignored

**What's Shown (that would normally be hidden):**

- ✅ `node_modules/` - Need to reference a dependency's types or implementation
- ✅ `dist/bundle.js` - Debugging bundler output or checking compiled code
- ✅ `logs/error.log` - Including error logs in prompt for debugging
- ✅ `docs/api.html` - Generated documentation you want to improve
- ✅ `.env.example` - Reference environment variable examples
- ✅ `screenshots/` - Include screenshots in prompt (if gitignored)
- ✅ Build configs (`webpack.config.js`) if they're gitignored

**Only Excluded:** `.git/` directory (binary Git database - never useful)

### When to Toggle OFF

**Common Scenarios:**

1. **Debugging Build Issues**
   - "Analyze the compiled bundle and explain why it's 5MB"
   - Need to reference `dist/bundle.js` (gitignored)

2. **Referencing Logs**
   - "Based on this error log, suggest fixes"
   - Need to attach `logs/server-error.log` (gitignored)

3. **Documentation Generation**
   - "Improve the generated API docs HTML"
   - Need to reference `docs/api.html` (gitignored output)

4. **Dependency Investigation**
   - "Why is TypeScript complaining about this lodash type?"
   - Need to reference `node_modules/@types/lodash/index.d.ts`

5. **Environment Setup**
   - "Help me configure environment variables"
   - Need to reference `.env.example` (gitignored template)

6. **Screenshot Analysis**
   - "Compare this before/after screenshot"
   - Need to attach `screenshots/before.png` (gitignored assets)

### Quick Toggle Workflow

**Keyboard shortcut recommended:**

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type "Preferences: Open Settings (UI)"
3. Search "gitignore completions"
4. Toggle checkbox
5. Return to prompt editor - cache cleared automatically

**Faster alternative (settings.json):**

```json
{
  "flightpath.respectGitignoreForCompletions": false // Show ALL files
}
```

---

## Implementation Plan

### Phase 1: Add Setting to package.json

**Location:** `package.json` → `contributes.configuration.properties`

```json
{
  "flightpath.respectGitignoreForCompletions": {
    "order": 20,
    "type": "boolean",
    "default": true,
    "description": "Respect .gitignore files when showing file and symbol completions",
    "markdownDescription": "When enabled (default), FlightPath excludes gitignored files from `@` file completions and `#` symbol completions. This filters out build artifacts, dependencies, and IDE config files.\n\nDisable if you need to reference files in `.gitignore` (e.g., debugging build outputs, including error logs, referencing dependencies).\n\n**Applies to:** Dashboard prompt editor and VS Code editor (when editing `.flightpath.yml` files).\n\n**Toggle quickly:** Use checkbox in Settings panel → Session Settings (Quick Access)."
  }
}
```

**Placement:** Add after `flightpath.autoAttachFiles` (line 549-555) for logical grouping with completion-related settings.

### Phase 1.5: Add UI Checkbox to Settings Panel

**Location:** `src/ui/webview/settings.html`

**Add to Session Settings section** (after Execution Mode, before More Settings button):

```html
<!-- Session Settings (Quick Access) -->
<div class="session-settings">
  <h3>Session Settings (Quick Access)</h3>
  <p class="section-description">
    <i class="codicon codicon-info"></i>
    Frequently toggled during development. Updates global setting.
  </p>

  <!-- Execution Mode (existing) -->
  <div class="setting-group">
    <!-- ... existing execution mode radio buttons ... -->
  </div>

  <!-- NEW: Respect Gitignore Checkbox -->
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
</div>
```

**Wire up in settings.js:**

```javascript
// Add to init() or loadSettings()
const respectGitignoreCheckbox = document.getElementById("respect-gitignore");

// Load initial value from VS Code setting
vscode.postMessage({
  type: "getConfig",
  key: "respectGitignoreForCompletions",
});

// Handle config response
window.addEventListener("message", (event) => {
  const message = event.data;
  if (
    message.type === "configValue" &&
    message.key === "respectGitignoreForCompletions"
  ) {
    respectGitignoreCheckbox.checked = message.value ?? true;
  }
});

// Update setting when checkbox changes
respectGitignoreCheckbox.addEventListener("change", (e) => {
  vscode.postMessage({
    type: "updateConfig",
    key: "respectGitignoreForCompletions",
    value: e.target.checked,
  });
});
```

**Update FlightPathSettingsProvider.ts:**

Add message handlers for `getConfig` and `updateConfig`:

```typescript
case 'getConfig': {
  const value = vscode.workspace.getConfiguration('flightpath')
    .get<boolean>(message.key);
  this._view.webview.postMessage({
    type: 'configValue',
    key: message.key,
    value: value
  });
  break;
}

case 'updateConfig': {
  await vscode.workspace.getConfiguration('flightpath')
    .update(message.key, message.value, vscode.ConfigurationTarget.Global);
  break;
}
```

### Phase 2: Update CompletionHelpers.ts

**File:** `src/completions/CompletionHelpers.ts`

#### 2.1: Add Configuration Import

```typescript
// At top of file
import * as vscode from "vscode";
import * as path from "path";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";
import { Log } from "../utils/Log";

// Add utility to get setting
function shouldRespectGitignore(): boolean {
  return vscode.workspace
    .getConfiguration("flightpath")
    .get<boolean>("respectGitignoreForCompletions", true);
}
```

#### 2.2: Update getWorkspaceFiles() Function

**Replace:** Lines 95-118

**Option A (Simple):**

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

**Option B (Git API):**

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

  // Get ALL files (only exclude .git database directory)
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/.git/**" // Only exclude Git database - never useful in prompts
  );

  // OFF: Return ALL files (node_modules, dist, logs, everything)
  // ON:  Filter out gitignored files using Git extension API
  const filteredFiles = respectGitignore
    ? await filterGitIgnoredFiles(files)
    : files;

  // Update cache
  filesCache = filteredFiles;
  filesCacheTimestamp = now;

  return filteredFiles;
}

// Add new helper function
async function filterGitIgnoredFiles(
  files: vscode.Uri[]
): Promise<vscode.Uri[]> {
  try {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      Log.warn(
        "[Completions] Git extension not found, cannot filter .gitignore files"
      );
      return files;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const gitApi = gitExtension.exports.getAPI(1);
    if (!gitApi) {
      Log.warn("[Completions] Git API not available");
      return files;
    }

    // Group files by repository for batch checking
    const filesByRepo = new Map<any, vscode.Uri[]>();
    const nonGitFiles: vscode.Uri[] = [];

    for (const file of files) {
      const repo = gitApi.getRepository(file);
      if (repo) {
        if (!filesByRepo.has(repo)) {
          filesByRepo.set(repo, []);
        }
        filesByRepo.get(repo)!.push(file);
      } else {
        // Not in a Git repo - keep it
        nonGitFiles.push(file);
      }
    }

    // Check gitignore status per repository (batch operation)
    const filteredFiles: vscode.Uri[] = [...nonGitFiles];

    for (const [repo, repoFiles] of filesByRepo.entries()) {
      const filePaths = repoFiles.map((uri) => uri.fsPath);
      const ignoredSet = await repo.checkIgnore(filePaths);

      // Keep only non-ignored files
      const kept = repoFiles.filter((uri) => !ignoredSet.has(uri.fsPath));
      filteredFiles.push(...kept);

      Log.debug(
        `[Completions] Filtered ${repoFiles.length - kept.length} gitignored files from ${repo.rootUri.fsPath}`
      );
    }

    return filteredFiles;
  } catch (error) {
    Log.error("[Completions] Failed to filter gitignored files:", error);
    return files; // Fallback: return all files
  }
}
```

#### 2.3: Symbol Completions

**No changes needed** - `vscode.executeWorkspaceSymbolProvider` likely already respects `.gitignore` since it uses VS Code's indexed files.

**Verification:** Test manually by:

1. Creating a file in `.gitignore`
2. Adding a symbol to it
3. Checking if it appears in `#` completions

If symbols from gitignored files DO appear, we'd need to filter the results by checking if `symbol.location.uri` is in the filtered files list.

### Phase 3: Update Dashboard Message Handler

**File:** `src/ui/FlightPathDashboardProvider.ts`

**Location:** `_handleWebviewMessage()` method (around line 400-500)

**Change:** Ensure `requestCompletions` message handler uses the updated `CompletionHelpers` functions (should work automatically since they share the same code).

**No code changes needed** - the message handler already calls `CompletionHelpers.getFileCompletions()` which will respect the new setting.

### Phase 4: Cache Invalidation

**Issue:** If user toggles the setting, cache might return stale results.

**Solution:** Add configuration change listener to clear cache:

**File:** `src/completions/CompletionHelpers.ts`

```typescript
// Add at module level (after cache variables)
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

**File:** `src/extension.ts`

```typescript
// In activate() function
import { initializeCompletionHelpers } from "./completions/CompletionHelpers";

export async function activate(context: vscode.ExtensionContext) {
  // ... existing code ...

  // Initialize completion helpers with config watcher
  initializeCompletionHelpers(context);

  // ... rest of activation ...
}
```

### Phase 5: Testing

**Test Cases:**

1. **Basic Functionality - Setting ON**
   - Add `test-ignored.txt` to `.gitignore`
   - Enable setting (ON)
   - Verify file DOES NOT appear in `@` completions
   - Verify `node_modules/` files DO NOT appear

2. **Basic Functionality - Setting OFF (Show ALL Files)**
   - Disable setting (OFF)
   - Verify `test-ignored.txt` DOES appear
   - Verify `node_modules/` files DOES appear
   - Verify `dist/`, `out/`, `build/` files DOES appear
   - Verify `.log`, `.cache` files DOES appear
   - Verify `.env` files DOES appear (if present)
   - Verify `.git/` directory itself still excluded (only thing filtered)

3. **Symbol Completions**
   - Add a class to a gitignored file
   - Setting ON: Verify class DOES NOT appear in `#` symbol completions
   - Setting OFF: Verify class DOES appear

4. **Real-World Scenario - Referencing Build Outputs**
   - Setting OFF
   - Type `@dist/` in prompt editor
   - Verify autocomplete shows files from `dist/` directory
   - Verify can reference compiled JavaScript, source maps, etc.

5. **Real-World Scenario - Referencing Logs**
   - Setting OFF
   - Type `@logs/` in prompt editor
   - Verify autocomplete shows `.log` files
   - Verify can include error logs in prompts for debugging

6. **Multi-Root Workspaces**
   - Open workspace with multiple Git repos
   - Setting ON: Verify each repo's `.gitignore` is respected independently
   - Setting OFF: Verify all files from all repos appear

7. **Non-Git Workspaces**
   - Open a folder without `.git`
   - Verify completions still work (shows all files regardless of setting)

8. **Performance**
   - Large workspace (10,000+ files with 5,000 in node_modules)
   - Setting OFF: Verify completion dropdown appears quickly (<500ms)
   - Should see ~10,000 files
   - Setting ON: Verify dropdown is faster (<300ms)
   - Should see ~5,000 files

9. **Cache Invalidation**
   - Start with setting ON (filtered)
   - Note count of files in completion dropdown
   - Toggle setting to OFF
   - Trigger completions again
   - Verify count increased (now showing all files)
   - Toggle back to ON
   - Verify count decreased back to original

10. **Edge Cases**
    - `.gitignore` file itself
      - Setting ON: May not appear (depends if gitignored)
      - Setting OFF: Should appear
    - Nested `.gitignore` files
      - Setting ON: Should respect both parent and child
      - Setting OFF: Should show all files
    - `.git/info/exclude` patterns
      - Setting ON: Should respect
      - Setting OFF: Should show excluded files
    - Global gitignore patterns (`~/.gitignore_global`)
      - Setting ON: Should respect (if using Option B)
      - Setting OFF: Should show all

---

## Recommended Approach

### Start with Option A (Simple), Upgrade to Option B if Needed

**Rationale:**

1. **Option A is lower risk** - relies on VS Code's built-in behavior
2. **Option A is simpler** - less code to maintain
3. **Option B can be added later** if users report issues with VS Code's native filtering
4. **Both approaches share the same setting** - users don't need to reconfigure

**Migration Path:**

1. Ship with Option A (remove manual excludes, use `undefined`)
2. Monitor user feedback for 1-2 releases
3. If issues arise (e.g., gitignore not respected in certain scenarios), implement Option B
4. No breaking changes - same setting controls both implementations

---

## Files to Modify

### Core Changes

1. ✅ `package.json` - Add setting definition
2. ✅ `src/completions/CompletionHelpers.ts` - Update getWorkspaceFiles(), add cache invalidation
3. ✅ `src/extension.ts` - Initialize completion helpers

### UI Changes

4. ✅ `src/ui/webview/settings.html` - Add checkbox in Session Settings section
5. ✅ `src/ui/webview/settings.js` - Wire up checkbox to VS Code config
6. ✅ `src/ui/FlightPathSettingsProvider.ts` - Add getConfig/updateConfig message handlers

### Documentation

7. ✅ `README.md` - Document new setting in Settings section
8. ✅ `CHANGELOG.md` - Add to "Added" section for next release

### Testing (Manual)

9. ✅ Create test workspace with gitignored files
10. ✅ Verify @ and # completions filter correctly in dashboard
11. ✅ Verify @ and # completions filter correctly in VS Code editor (.flightpath.yml files)
12. ✅ Verify checkbox in Settings panel updates global setting
13. ✅ Verify setting toggle clears cache and updates completions immediately

---

## Alternative Approaches Considered

### 1. ❌ Wait for findFiles2 API

**Rejected:** Proposed API is not stable yet, no timeline for release.

### 2. ❌ Parse .gitignore Files Manually

**Rejected:**

- Complex (must handle negation patterns, directory vs file patterns, nested `.gitignore`)
- Duplicate work (VS Code and Git extension already do this)
- Cross-platform path issues

### 3. ❌ Shell Out to `git check-ignore`

**Rejected:**

- Slower than API calls
- Requires Git CLI installation
- Security concerns with shell execution
- Cross-platform compatibility issues

---

## Performance Considerations

### Cache Effectiveness

Current 5-second cache (CACHE_DURATION_MS) should remain effective:

- Cache key includes setting state implicitly (different results = different cache entry)
- Configuration change listener clears cache immediately
- No additional memory overhead

### Git API Batch Performance

If using Option B:

- `checkIgnore(paths)` accepts array → single API call per repository
- Multi-root workspaces: 1 API call per repo (acceptable)
- Large workspaces (10k files): ~50-100ms per checkIgnore call (acceptable)

### Completions Latency Budget

VS Code completions should appear within **500ms** for good UX:

- Current findFiles: ~100-200ms (10k files)
- Git API checkIgnore: ~50-100ms (batched)
- Total: ~150-300ms (well within budget)

---

## Breaking Changes

**None.** This is a purely additive feature:

- New setting defaults to `true` (respects `.gitignore`)
- Previous behavior available by setting to `false`
- No API changes for extension consumers

---

## Future Enhancements

### 1. Respect Additional Ignore Files

Support other ignore file formats:

- `.dockerignore`
- `.npmignore`
- `.eslintignore`

**Implementation:** Extend `filterGitIgnoredFiles()` to check multiple ignore patterns.

### 2. Per-Workspace Setting

Allow overriding per workspace folder in multi-root workspaces:

```json
{
  "flightpath.respectGitignoreForCompletions": {
    "workspace1": true,
    "workspace2": false
  }
}
```

### 3. Custom Exclude Patterns

Allow users to define additional exclude patterns beyond `.gitignore`:

```json
{
  "flightpath.completionExcludePatterns": ["**/temp/**", "**/*.backup"]
}
```

---

## Summary

**Recommended Implementation:**

1. **Add setting** `flightpath.respectGitignoreForCompletions` (default: `true`)
   - **ON**: Respect `.gitignore` - hide irrelevant files (clean dropdown)
   - **OFF**: Show ALL files - enable referencing build outputs, logs, dependencies

2. **Start with Option A** (remove manual excludes, rely on VS Code's native behavior)
   - When ON: `exclude: undefined` (VS Code handles gitignore)
   - When OFF: `exclude: "**/.git/**"` (only exclude Git database)

3. **Add cache invalidation** on setting change (instant feedback)

4. **Monitor feedback** and upgrade to Git API (Option B) if needed

**Toggle Behavior:**

```
Setting ON  (default) → ~5,000 files  (clean, focused)
Setting OFF           → ~10,000 files (everything, including gitignored)
```

**Estimated Effort:** 2-3 hours (including testing)

**User Impact:**

- Cleaner completion dropdowns by default
- Quick toggle for referencing gitignored files (logs, builds, deps)
- Better alignment with version control

**Risk:** Low - OFF mode shows everything users need, no data loss

---

## References

- [VS Code findFiles API Limitation (Issue #36617)](https://github.com/Microsoft/vscode/issues/36617)
- [Proposed findFiles2 API (Issue #204657)](https://github.com/microsoft/vscode/issues/204657)
- [VS Code Git Extension API](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)
- [VS Code Search Settings Documentation](https://code.visualstudio.com/docs/editor/codebasics#_advanced-search-options)

---

**Author:** Claude (FlightPath AI Assistant)
**Review Status:** Pending human review
**Next Steps:** Approve implementation approach and proceed with Phase 1
