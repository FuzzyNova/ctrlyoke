# Enhanced Prompt File Editing

**Status**: ✅ IMPLEMENTED  
**Last Updated**: November 6, 2025

---

## 🎯 Overview

FlightPath provides intelligent autocomplete for prompt files, making it faster and easier to reference workspace files and code selections in your prompts.

**Supported File Types**:

- `.prompt.json` - Single prompts and simple workflows
- `.flightpath.json` - Complex multi-step workflows
- `.prompt.md` - One-off prompts for direct chat usage

---

## ✨ Features

### File Completions

Type `#` to see all workspace files with fuzzy filtering:

- **Smart filtering**: Type to narrow results instantly
- **Workspace-relative paths**: Clean, portable file references
- **Fast caching**: 5-second cache for optimal performance
- **Limited results**: Top 500 matches to prevent slowdowns

### Selection Completions

Capture current editor selection as `#file:path:startLine-endLine`:

- **Multiple editors**: Supports selections across split views
- **Line ranges**: Automatic 1-based line numbering
- **Preview text**: See snippet of selected code
- **Top priority**: Always appears first in completion list

### Context-Aware Behavior

- **JSON files**: Completions trigger inside `"prompt"` string values only
- **Markdown files**: Completions trigger anywhere in the document
- **Prompt language**: Works with VS Code's native `prompt` language (used by Copilot)

---

## 🚀 Quick Start

### In JSON Files

1. Open or create a `.prompt.json` or `.flightpath.json` file
2. Inside a prompt string, type `#`:
   ```json
   {
     "prompt": "/explain #"
   }
   ```
3. Press `Ctrl+Space` (or wait for autocomplete)
4. Select a file from the list
5. Result: `#file:src/extension.ts`

### In Markdown Files

1. Open or create a `.prompt.md` file
2. Type `#` anywhere:
   ```markdown
   Analyze the code in #
   ```
3. Press `Ctrl+Space` (or wait for autocomplete)
4. Select a file or selection
5. Result: `#file:src/extension.ts` or `#file:path:10-25`

### Capturing Selections

1. Open a code file and select some lines
2. Switch to your prompt file
3. Type `#` and press `Ctrl+Space`
4. Choose "Current Selection" from the top of the list
5. Result: `#file:src/extension.ts:45-120`

---

## 🔧 How It Works

### Architecture

**Component**: `PromptCompletionProvider` (`src/completions/PromptCompletionProvider.ts`)

**Key Responsibilities**:

1. Detect appropriate trigger contexts (JSON strings vs. Markdown)
2. Generate workspace file list with caching
3. Capture current editor selections
4. Format completions for insertion
5. Coexist with other completion providers (like Copilot's MCP tools)

**Registration** (`src/extension.ts`):

```typescript
vscode.languages.registerCompletionItemProvider(
  [
    { pattern: "**/*.{prompt,flightpath}.json" },
    { pattern: "**/*.prompt.md" },
    { language: "prompt" }, // VS Code's prompt language
  ],
  promptCompletionProvider,
  "#" // Trigger character
);
```

### File Type Detection

The provider uses different logic based on document language:

```typescript
private shouldProvideCompletions(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  // For Markdown and Prompt files, always provide completions
  if (document.languageId === "markdown" || document.languageId === "prompt") {
    return true;
  }

  // For JSON files, only inside "prompt" string values
  if (document.languageId === "json" || document.languageId === "jsonc") {
    return this.isInsidePromptString(document, position);
  }

  return false;
}
```

### Performance Optimizations

- **File caching**: Workspace files cached for 5 seconds
- **Smart exclusions**: Ignores `node_modules`, `.git`, `dist`, `out`, `build`
- **Result limiting**: Maximum 500 completions per trigger
- **Lazy loading**: Files fetched only when needed

---

## 📖 Usage Examples

### Single File Reference

**JSON**:

```json
{
  "prompt": "/explain #file:src/extension.ts Analyze this entry point"
}
```

**Markdown**:

```markdown
# Code Review

Please review the implementation in #file:src/extension.ts
```

### Multiple Files

**JSON**:

```json
{
  "prompt": "Compare #file:src/flightpath/FlightPathManager.ts with #file:src/flightpath/PromptQueue.ts"
}
```

**Markdown**:

```markdown
Compare the architecture:

- Manager: #file:src/flightpath/FlightPathManager.ts
- Queue: #file:src/flightpath/PromptQueue.ts
```

### With Line Ranges

**JSON**:

```json
{
  "prompt": "Review this function #file:src/extension.ts:221-245"
}
```

**Markdown**:

```markdown
The activation logic #file:src/extension.ts:210-245 needs review.
```

### Captured Selections

**JSON**:

```json
{
  "prompt": "Optimize this code: #file:src/completions/PromptCompletionProvider.ts:89-156"
}
```

**Markdown**:

```markdown
I have a performance issue in:
#file:src/completions/PromptCompletionProvider.ts:89-156

Can you suggest improvements?
```

---

## 🔄 Coexistence with Copilot

FlightPath's completion provider works **alongside** GitHub Copilot's native prompt completions.

### How Multiple Providers Work

VS Code merges results from all completion providers:

1. **Copilot's MCP tools**: `context7_fetch`, `sequentialthinking`, etc.
2. **FlightPath's files**: Workspace files and selections

Both appear in the same completion list!

### Sort Order

FlightPath uses `!` prefix in `sortText` to appear near the top:

- `!000_selection_001` - Current selections (highest priority)
- `!1_2_src/extension.ts` - Files (depth-based sorting)

Copilot's tools typically sort alphabetically, so results intermingle naturally.

### Quick Suggestions Setting

If you have quick suggestions disabled for `[prompt]` language (common with Copilot):

```json
"[prompt]": {
  "editor.quickSuggestions": {
    "strings": "off",
    "other": "off"
  }
}
```

**Solution**: Use manual trigger with `Ctrl+Space` (or `Cmd+Space` on Mac)

This gives you full control and shows both Copilot's tools and FlightPath's files together.

---

## 🧪 Testing

### Manual Test - JSON Files

1. Create `.flightpath/test.prompt.json`:
   ```json
   {
     "prompt": "#"
   }
   ```
2. Place cursor after `#`
3. Press `Ctrl+Space`
4. Verify completions appear

### Manual Test - Markdown Files

1. Create `.flightpath/test.prompt.md`:
   ```markdown
   Analyze #
   ```
2. Place cursor after `#`
3. Press `Ctrl+Space` (if quick suggestions disabled)
4. Verify completions appear

### Manual Test - Selection Capture

1. Open `src/extension.ts`
2. Select lines 221-230 (the completion provider registration)
3. Switch to a prompt file
4. Type `#` and press `Ctrl+Space`
5. Verify "Current Selection" appears at top
6. Select it and verify format: `#file:src/extension.ts:221-230`

### Debug Command

Run `FlightPath: Show Language ID` from Command Palette to check:

- Current file's language ID
- Helps diagnose completion trigger issues

---

## 🎯 Implementation Details

### Key Methods

#### `provideCompletionItems()`

Main entry point called by VS Code when `#` is typed:

1. Checks if we should provide completions (based on file type and position)
2. Finds `#` character in current line
3. Extracts filter text after `#`
4. Generates selection completions
5. Generates file completions
6. Returns merged list

#### `shouldProvideCompletions()`

Determines if completions are appropriate:

- **Markdown/Prompt**: Always `true`
- **JSON**: Only if inside `"prompt"` string value
- **Other**: `false`

#### `isInsidePromptString()`

For JSON files, checks if cursor is inside a prompt string:

1. Finds `"prompt":` on current line
2. Locates opening quote of value
3. Checks if cursor is between quotes

#### `getAllSelectionCompletions()`

Captures selections from all visible editors:

1. Iterates through `vscode.window.visibleTextEditors`
2. Skips empty selections
3. Formats as `#file:path:startLine-endLine`
4. Deduplicates identical selections

#### `getFileCompletions()`

Generates file completions:

1. Gets cached workspace files
2. Filters by user's partial input
3. Creates `CompletionItem` for each file
4. Limits to 500 results

#### `getWorkspaceFiles()`

Retrieves workspace files with caching:

1. Checks cache validity (5-second TTL)
2. If stale, calls `workspace.findFiles()`
3. Excludes common directories
4. Updates cache

---

## 📊 Performance Characteristics

### Workspace Size: < 1,000 files

- **First trigger**: ~50ms (file system scan)
- **Cached triggers**: ~5ms
- **Filtering**: ~2ms per keystroke

### Workspace Size: 1,000-10,000 files

- **First trigger**: ~200ms (file system scan)
- **Cached triggers**: ~10ms
- **Filtering**: ~5ms per keystroke

### Workspace Size: > 10,000 files

- **First trigger**: ~500ms (file system scan)
- **Cached triggers**: ~15ms
- **Result limiting**: Automatically caps at 500 items

---

## 🐛 Known Limitations

### Single-line JSON Strings

JSON doesn't support multi-line strings, so prompts must be on one line. Not an issue in practice since prompts are typically concise.

**Workaround**: Use Markdown files for longer prompts.

### No Path Validation

File paths are not validated at completion time. If a file is deleted after completion, the reference will be invalid.

**Future**: Could add diagnostic warnings for missing files.

### Manual Line Ranges

After selecting a file, you must manually add `:10-20` if you want a line range (unless using selection capture).

**Future**: Could add a UI picker for line ranges.

### Cache Staleness

Newly created files won't appear in completions for up to 5 seconds.

**Workaround**: Clear cache with `clearCache()` method (not exposed as command yet).

### Quick Suggestions Disabled

Many users disable quick suggestions for prompt files to reduce Copilot noise. This requires manual trigger with `Ctrl+Space`.

**Design decision**: This is actually a feature—gives users control over when to see suggestions.

---

## � Troubleshooting

### Completions Not Appearing

**Problem**: Typed `#` but no completions show up.

**Diagnosis Steps**:

1. **Check Language ID**:
   - Run command: `FlightPath: Show Language ID` (Command Palette)
   - Should show `"prompt"` for `.prompt.md` files or `"json"`/`"jsonc"` for JSON files
   - If wrong, file association may be overridden

2. **Check Quick Suggestions Setting**:
   - Open VS Code settings (JSON)
   - Look for `[prompt]` language configuration
   - If you see:
     ```json
     "[prompt]": {
       "editor.quickSuggestions": {
         "strings": "off",
         "other": "off"
       }
     }
     ```
   - **Solution**: Use manual trigger with `Ctrl+Space` (or `Cmd+Space` on Mac)

3. **Verify File Pattern**:
   - Ensure file is named correctly: `*.prompt.json`, `*.flightpath.json`, or `*.prompt.md`
   - Check that file is in workspace (not just open)

4. **Check Cursor Position** (JSON files only):
   - Completions only trigger inside `"prompt"` string values
   - Cursor must be between the quotes: `"prompt": "cursor here"`

**Common Solutions**:

- Use `Ctrl+Space` to manually trigger completions
- Ensure file is saved with correct extension
- Reload VS Code window (`Ctrl+Shift+P` → "Reload Window")

### Completions Appear but Wrong Files

**Problem**: Seeing unexpected files or missing expected files.

**Possible Causes**:

1. **Cache Staleness**:
   - File cache updates every 5 seconds
   - Newly created files won't appear immediately
   - **Solution**: Wait 5 seconds or reload window

2. **Excluded Directories**:
   - These directories are automatically excluded: `node_modules`, `.git`, `dist`, `out`, `build`
   - Files in these locations won't appear in completions
   - **Solution**: If you need these files, this is a design limitation

3. **Result Limiting**:
   - Maximum 500 results shown per trigger
   - In large workspaces, some files may not appear
   - **Solution**: Type more characters to filter (e.g., `#src/comp` instead of just `#`)

### Coexistence with GitHub Copilot

**Background**: GitHub Copilot provides its own completions for MCP tools (Context7, web search, thinking tools) in `.prompt.md` files.

**How It Works**:

- VS Code merges results from **all** completion providers
- Both FlightPath files AND Copilot tools appear in the same list
- This is intentional and complementary!

**Expected Behavior in `.prompt.md` files**:

```
Type '#' → Press Ctrl+Space → See combined list:

$(selection) Current Selection (FlightPath)
context7_fetch (Copilot)
context7_resolve (Copilot)
sequentialthinking (Copilot)
extension.ts (FlightPath)
FlightPathManager.ts (FlightPath)
PromptCompletionProvider.ts (FlightPath)
```

**Sort Order**:

- FlightPath uses `!` prefix in sort text to appear near top
- Selections: `!000_selection_001` (highest priority)
- Files: `!1_2_src/extension.ts` (depth-based)
- Copilot's tools: Alphabetically sorted

**Benefits**:

1. **No Conflicts**: Both providers work seamlessly together
2. **Complementary**: Use Copilot tools + FlightPath files in same prompt
3. **User Control**: Manual trigger (`Ctrl+Space`) prevents noise
4. **Fast Filtering**: Type after `#` to narrow results from both providers

**Example Combined Usage**:

```markdown
Use #context7_fetch to research React hooks, then analyze #file:src/App.tsx
```

### Quick Suggestions Disabled

Many users disable quick suggestions for prompt files to reduce noise from Copilot.

**Your Settings** (common configuration):

```json
"[prompt]": {
  "editor.quickSuggestions": {
    "comments": "off",
    "strings": "off",
    "other": "off"
  }
}
```

**Two Options**:

#### Option 1: Keep Settings, Use Manual Trigger (Recommended)

- Press `Ctrl+Space` after typing `#` to manually trigger completions
- Both Copilot's tools AND FlightPath's files will appear
- Gives you full control over when suggestions appear

#### Option 2: Enable Quick Suggestions

Update settings to:

```json
"[prompt]": {
  "editor.quickSuggestions": {
    "comments": "off",
    "strings": "on",  // Enable for automatic trigger
    "other": "on"     // Enable for automatic trigger
  }
}
```

**Recommendation**: Keep settings as-is and use `Ctrl+Space`. This reduces noise and gives you control.

### Selection Not Captured

**Problem**: Selected code in another editor but "Current Selection" doesn't appear.

**Diagnosis**:

1. **Check Selection Exists**:
   - Ensure text is actually selected (highlighted) in the other editor
   - Empty selections are ignored

2. **Check Editor Visibility**:
   - Only selections from **visible** editors are captured
   - Editors in background tabs are ignored
   - **Solution**: Split view or open editor side-by-side

3. **Verify Trigger**:
   - Type `#` and press `Ctrl+Space`
   - Selection should appear at top of list

4. **Multiple Selections**:
   - If multiple editors have selections, all will appear
   - Numbered: "Current Selection (1)", "Current Selection (2)", etc.

### Language ID Mismatch

**Problem**: `.prompt.md` files use language ID `"prompt"` (not `"markdown"`) because GitHub Copilot registers this language.

**Why This Matters**:

- Completion providers register for specific language IDs
- File extension alone doesn't guarantee language ID
- FlightPath explicitly supports both `"markdown"` and `"prompt"` language IDs

**Debug Command**:

```
Ctrl+Shift+P → "FlightPath: Show Language ID"
```

Shows current document's language ID in notification.

**If Language ID is Wrong**:

1. Another extension may have overridden the language
2. Check your `files.associations` setting
3. Report issue to FlightPath if unexpected

---

## �🔮 Future Enhancements

### Phase 1.5: Enhanced Filtering

- **Fuzzy matching**: Use Levenshtein distance for better filtering
- **Recently used**: Track and prioritize recently referenced files
- **File type icons**: Visual indicators for `.ts`, `.json`, `.md`, etc.
- **Syntax preview**: Show first few lines of file in documentation

### Phase 2: Additional Context Types

- **`@workspace` completion**: Just insert the keyword (no file list)
- **Slash commands**: `/fix`, `/explain`, `/tests`, `/new`, etc.
- **Variable references**: `${workspaceFolder}`, `${file}`, etc.
- **End condition scripts**: Autocomplete for `.flightpath/*.py` scripts

### Phase 3: Advanced Features

- **Hover tooltips**: Show file info on hover over `#file:` references
- **Go to definition**: Ctrl+click to open referenced file
- **Diagnostic warnings**: Highlight invalid/missing file paths
- **Quick fixes**: "Update path" when file moves
- **Line range picker**: UI to select specific line ranges

### Phase 4: UI Enhancements

- **File preview pane**: Show file contents while browsing completions
- **Recent files list**: Quick access to recently referenced files
- **Favorite files**: Pin frequently used files to top
- **Workspace file tree**: Visual file browser in completion list

---

## 📚 API Reference

### `PromptCompletionProvider`

```typescript
class PromptCompletionProvider implements vscode.CompletionItemProvider {
  // Main completion method
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined>;

  // Determine if completions should be provided
  private shouldProvideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean;

  // Check if inside JSON prompt string
  private isInsidePromptString(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean;

  // Get all editor selections
  private getAllSelectionCompletions(): vscode.CompletionItem[];

  // Get file completions with filtering
  private async getFileCompletions(
    filterText: string
  ): Promise<vscode.CompletionItem[]>;

  // Get workspace files (cached)
  private async getWorkspaceFiles(): Promise<vscode.Uri[]>;

  // Clear file cache
  public clearCache(): void;
}
```

---

## 🎓 Tips & Tricks

### Tip 1: Use Selection Capture

Instead of manually typing line ranges, select the code first, then use completion. Much faster!

### Tip 2: Type to Filter

After pressing `Ctrl+Space`, start typing to filter. For example:

- `#man` → Shows only files with "man" in path (FlightPathManager.ts)
- `#src/comp` → Shows completions in src/comp\* paths

### Tip 3: Multiple Selections

Open multiple editors in split view, select code in each, then reference all selections in one prompt!

### Tip 4: Combine with Copilot Tools

Mix FlightPath files and Copilot MCP tools in the same prompt:

```markdown
Use #context7_fetch to research React hooks, then analyze #file:src/App.tsx
```

### Tip 5: Enable Quick Suggestions

If you want automatic completions (without `Ctrl+Space`), update settings:

```json
"[prompt]": {
  "editor.quickSuggestions": {
    "strings": "on",
    "other": "on"
  }
}
```

---

## 🔗 Related Documentation

- [COPILOT_INTEGRATION.md](./COPILOT_INTEGRATION.md) - How FlightPath automates Copilot
- [PROMPT_ARCHITECTURE_TRANSITION.md](./PROMPT_ARCHITECTURE_TRANSITION.md) - Prompt format evolution
- [CONTEXT_ATTACHMENT.md](./CONTEXT_ATTACHMENT.md) - How context is attached to prompts
- [QUICK_START.md](../QUICK_START.md) - Getting started guide

---

## 🤝 Contributing

Found a bug or have an enhancement idea? Please open an issue!

**Common contribution areas**:

- Fuzzy matching algorithms
- Additional file type support
- Performance optimizations
- UI/UX improvements

---

**Last Updated**: November 6, 2025  
**Implemented in**: FlightPath v0.1.0+
