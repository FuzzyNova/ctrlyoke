# Enhanced JSON Editing - Implementation Plan

**Status**: 🚀 Ready to Implement  
**Priority**: Phase 1 (Immediate)  
**Last Updated**: November 5, 2025

---

## 🎯 Goal

Add context-aware completions to `.prompt.json` and `.flightpath.json` files to make prompt creation faster and more intuitive. When users type `#` inside a prompt string, they should see:

1. **All workspace files** - filterable list with fuzzy search
2. **Current selection** - special `#selection` option that expands to `#file:path:startLine-endLine`

---

## 📋 Scope

### In Scope (Phase 1)
- ✅ `#` trigger for file picker in JSON string values
- ✅ `#selection` option that captures current editor selection
- ✅ File completions with workspace-relative paths
- ✅ Line range support (`#file:path:45-120`)
- ✅ Fuzzy filtering of file list

### Out of Scope (Future)
- ❌ `@workspace` completions (future enhancement)
- ❌ `/` slash command completions (future enhancement)
- ❌ End condition script path validation (future enhancement)
- ❌ Full Monaco editor integration (Phase 2)

---

## 🏗️ Architecture

### New File: `src/completions/PromptCompletionProvider.ts`

**Purpose**: Provide context-aware completions for prompt JSON files

**Key Responsibilities**:
1. Detect when cursor is inside a `"prompt"` string value
2. Trigger completions on `#` character
3. Generate file list from workspace
4. Handle `#selection` special case
5. Format completion items with proper syntax

### Integration Point: `extension.ts`

Register the completion provider during activation:

```typescript
// In activate() function
const promptCompletionProvider = new PromptCompletionProvider();
context.subscriptions.push(
  vscode.languages.registerCompletionItemProvider(
    { pattern: '**/*.{prompt,flightpath}.json' },
    promptCompletionProvider,
    '#' // Trigger character
  )
);
```

---

## 🔍 Technical Deep Dive

### Challenge 1: Detecting Position Inside JSON String

**Problem**: We need to determine if the cursor is inside a `"prompt"` string value, not just anywhere in the JSON file.

**Solution**: Parse the line and check for string boundaries

```typescript
/**
 * Check if position is inside a "prompt" string value
 */
private isInsidePromptString(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const line = document.lineAt(position.line).text;
  const charIndex = position.character;
  
  // Find the key before the cursor
  const beforeCursor = line.substring(0, charIndex);
  
  // Check if we're on a line with "prompt": 
  // Match pattern: "prompt": "..." or "prompt":"..."
  const promptKeyMatch = /\"prompt\"\s*:\s*\"/.test(line);
  
  if (!promptKeyMatch) {
    return false;
  }
  
  // Find opening quote position
  const openQuoteIndex = line.indexOf('"', line.indexOf(':'));
  
  // Find closing quote position (if exists)
  const closeQuoteIndex = line.indexOf('"', openQuoteIndex + 1);
  
  // Cursor must be between opening and closing quotes
  return (
    openQuoteIndex >= 0 &&
    charIndex > openQuoteIndex &&
    (closeQuoteIndex < 0 || charIndex < closeQuoteIndex)
  );
}
```

**Edge Cases**:
- Multi-line strings (JSON doesn't support them natively - out of scope)
- Escaped quotes inside strings (`\"`)
- Nested JSON objects

**Simplified Approach**: Since JSON strings are single-line, we can check if:
1. Line contains `"prompt":`
2. Cursor is after the opening `"` of the value
3. Cursor is before the closing `"` (if it exists on the same line)

---

### Challenge 2: Filtering on `#` Character

**Problem**: Completion should only trigger after `#`, not just anywhere in the string.

**Solution**: Check if the character immediately before the cursor is `#`

```typescript
provideCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
  context: vscode.CompletionContext
): vscode.ProviderResult<vscode.CompletionList> {
  // Check if we're inside a prompt string
  if (!this.isInsidePromptString(document, position)) {
    return undefined;
  }
  
  // Get the word/text before cursor
  const line = document.lineAt(position.line).text;
  const textBeforeCursor = line.substring(0, position.character);
  
  // Check if last character is # or if we're continuing a #file: pattern
  const lastHashIndex = textBeforeCursor.lastIndexOf('#');
  
  if (lastHashIndex === -1) {
    return undefined; // No # found
  }
  
  // Check if we're still typing after the #
  const afterHash = textBeforeCursor.substring(lastHashIndex);
  
  // If there's a space after #, don't provide completions
  if (afterHash.includes(' ')) {
    return undefined;
  }
  
  // Provide completions
  return this.generateCompletions(afterHash, document, position);
}
```

---

### Challenge 3: Getting Workspace Files

**Problem**: Need to efficiently get all workspace files for completion list.

**Solution**: Use VS Code's `workspace.findFiles()` API with caching

```typescript
private async getWorkspaceFiles(): Promise<vscode.Uri[]> {
  // Cache results for 5 seconds to avoid repeated scans
  const now = Date.now();
  if (this.filesCacheTimestamp && (now - this.filesCacheTimestamp) < 5000) {
    return this.filesCache;
  }
  
  const files = await vscode.workspace.findFiles(
    '**/*', // Include all files
    '**/node_modules/**' // Exclude node_modules
  );
  
  this.filesCache = files;
  this.filesCacheTimestamp = now;
  
  return files;
}
```

**Performance Optimization**:
- Cache file list for 5 seconds
- Exclude common directories (node_modules, .git, etc.)
- Limit results to 500 files (configurable)
- Use fuzzy matching for filtering

---

### Challenge 4: Current Selection Context

**Problem**: Need to capture the current editor selection and format it as `#file:path:startLine-endLine`.

**Solution**: Check active editor and get selection range

```typescript
private getCurrentSelectionCompletion(): vscode.CompletionItem | undefined {
  const editor = vscode.window.activeTextEditor;
  
  if (!editor || editor.selection.isEmpty) {
    return undefined; // No selection
  }
  
  const selection = editor.selection;
  const document = editor.document;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  
  if (!workspaceFolder) {
    return undefined;
  }
  
  // Get workspace-relative path
  const relativePath = vscode.workspace.asRelativePath(
    document.uri,
    false
  );
  
  // Convert to 1-based line numbers (VS Code uses 0-based)
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  
  // Format: #file:path:startLine-endLine
  const completionText = `#file:${relativePath}:${startLine}-${endLine}`;
  
  const item = new vscode.CompletionItem(
    'Current Selection',
    vscode.CompletionItemKind.Reference
  );
  
  item.insertText = completionText;
  item.detail = `Lines ${startLine}-${endLine} in ${relativePath}`;
  item.documentation = new vscode.MarkdownString(
    `Insert reference to currently selected code:\n\n\`${completionText}\``
  );
  
  // Sort at top of list
  item.sortText = '000_selection';
  
  return item;
}
```

**Visual Indicator**:
- Use `⌘` icon for selection item
- Show preview of selected text in detail
- Sort at the top of completion list

---

## 📝 Implementation Code

### File: `src/completions/PromptCompletionProvider.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Provides context-aware completions for FlightPath prompt JSON files
 * 
 * Features:
 * - Triggers on `#` character inside "prompt" string values
 * - Offers workspace files as completions
 * - Special handling for current selection (#selection)
 */
export class PromptCompletionProvider implements vscode.CompletionItemProvider {
  // Cache for workspace files
  private filesCache: vscode.Uri[] = [];
  private filesCacheTimestamp: number = 0;
  private readonly CACHE_DURATION_MS = 5000; // 5 seconds
  
  /**
   * Provide completion items for prompt JSON files
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    // Only provide completions if we're inside a "prompt" string value
    if (!this.isInsidePromptString(document, position)) {
      return undefined;
    }
    
    // Check if we just typed # or are continuing after #
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);
    const lastHashIndex = textBeforeCursor.lastIndexOf('#');
    
    if (lastHashIndex === -1) {
      return undefined; // No # found
    }
    
    // Get the partial text after # (for filtering)
    const afterHash = textBeforeCursor.substring(lastHashIndex + 1);
    
    // Don't provide completions if there's a space after #
    // (user has moved on to next context item)
    if (afterHash.includes(' ')) {
      return undefined;
    }
    
    // Generate completions
    const items: vscode.CompletionItem[] = [];
    
    // 1. Add current selection completion (if available)
    const selectionItem = this.getCurrentSelectionCompletion();
    if (selectionItem) {
      items.push(selectionItem);
    }
    
    // 2. Add workspace files
    const fileItems = await this.getFileCompletions(afterHash);
    items.push(...fileItems);
    
    return new vscode.CompletionList(items, false);
  }
  
  /**
   * Check if cursor position is inside a "prompt" string value
   */
  private isInsidePromptString(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    const line = document.lineAt(position.line).text;
    const charIndex = position.character;
    
    // Check if line contains "prompt":
    const promptMatch = line.match(/\"prompt\"\s*:\s*\"/);
    if (!promptMatch) {
      return false;
    }
    
    // Find the opening quote of the value
    const colonIndex = line.indexOf(':', promptMatch.index!);
    const openQuoteIndex = line.indexOf('"', colonIndex);
    
    if (openQuoteIndex === -1 || charIndex <= openQuoteIndex) {
      return false;
    }
    
    // Check if there's a closing quote after the cursor
    const closeQuoteIndex = line.indexOf('"', charIndex);
    
    // We're inside the string if:
    // - We're after the opening quote
    // - Either no closing quote exists, or we're before it
    return charIndex > openQuoteIndex;
  }
  
  /**
   * Get completion for current editor selection
   */
  private getCurrentSelectionCompletion(): vscode.CompletionItem | undefined {
    const editor = vscode.window.activeTextEditor;
    
    // No active editor or empty selection
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    
    const selection = editor.selection;
    const document = editor.document;
    
    // Get workspace-relative path
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    
    // Convert to 1-based line numbers
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    
    // Format: #file:path:startLine-endLine
    const completionText = `file:${relativePath}:${startLine}-${endLine}`;
    
    const item = new vscode.CompletionItem(
      '$(selection) Current Selection',
      vscode.CompletionItemKind.Reference
    );
    
    item.insertText = completionText;
    item.detail = `Lines ${startLine}-${endLine} in ${path.basename(relativePath)}`;
    item.documentation = new vscode.MarkdownString(
      `Insert reference to the currently selected code:\n\n\`#${completionText}\``
    );
    
    // Sort at top of list
    item.sortText = '000_selection';
    
    // Show full path in filter text for searchability
    item.filterText = `selection ${relativePath}`;
    
    return item;
  }
  
  /**
   * Get file completions from workspace
   */
  private async getFileCompletions(
    filterText: string
  ): Promise<vscode.CompletionItem[]> {
    const files = await this.getWorkspaceFiles();
    const items: vscode.CompletionItem[] = [];
    
    // Convert filter text to lowercase for case-insensitive matching
    const filter = filterText.toLowerCase().replace(/^file:/, '');
    
    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);
      
      // Simple filtering: check if the path contains the filter text
      if (filter && !relativePath.toLowerCase().includes(filter)) {
        continue;
      }
      
      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);
      
      const item = new vscode.CompletionItem(
        fileName,
        vscode.CompletionItemKind.File
      );
      
      // The text to insert
      item.insertText = `file:${relativePath}`;
      
      // Show directory in detail
      item.detail = dirName === '.' ? 'Root directory' : dirName;
      
      // Full path in documentation
      item.documentation = new vscode.MarkdownString(
        `Insert reference to file:\n\n\`#file:${relativePath}\`\n\n` +
        `You can also add line ranges:\n\`#file:${relativePath}:10-20\``
      );
      
      // Sort by path depth (shorter paths first) then alphabetically
      const depth = relativePath.split(path.sep).length;
      item.sortText = `${depth}_${relativePath}`;
      
      // Include path in filter text for fuzzy search
      item.filterText = `file ${relativePath} ${fileName}`;
      
      items.push(item);
      
      // Limit to 500 items for performance
      if (items.length >= 500) {
        break;
      }
    }
    
    return items;
  }
  
  /**
   * Get all workspace files (with caching)
   */
  private async getWorkspaceFiles(): Promise<vscode.Uri[]> {
    const now = Date.now();
    
    // Return cached results if still valid
    if (
      this.filesCache.length > 0 &&
      this.filesCacheTimestamp &&
      now - this.filesCacheTimestamp < this.CACHE_DURATION_MS
    ) {
      return this.filesCache;
    }
    
    // Find all files in workspace, excluding common directories
    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode/**}'
    );
    
    // Update cache
    this.filesCache = files;
    this.filesCacheTimestamp = now;
    
    return files;
  }
  
  /**
   * Clear the cache (useful for testing or when workspace changes)
   */
  public clearCache(): void {
    this.filesCache = [];
    this.filesCacheTimestamp = 0;
  }
}
```

---

## 🔌 Registration in `extension.ts`

Add to the `activate()` function:

```typescript
import { PromptCompletionProvider } from './completions/PromptCompletionProvider';

export async function activate(context: vscode.ExtensionContext) {
  console.log('FlightPath is now active');
  
  // ... existing initialization code ...
  
  // Register completion provider for prompt JSON files
  const promptCompletionProvider = new PromptCompletionProvider();
  
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { pattern: '**/*.{prompt,flightpath}.json' },
      promptCompletionProvider,
      '#' // Trigger on # character
    )
  );
  
  console.log('FlightPath: Registered completion provider for prompt files');
  
  // ... rest of activation code ...
}
```

---

## ✅ Testing Strategy

### Manual Testing

1. **Basic File Completion**
   - Create a `.prompt.json` file
   - Type `{ "prompt": "#` 
   - Verify completion list appears with workspace files
   - Select a file and verify it inserts `#file:path/to/file.ext`

2. **Current Selection**
   - Open a file and select some lines
   - In a prompt JSON file, type `{ "prompt": "#`
   - Verify "Current Selection" appears at top of list
   - Select it and verify format: `#file:path:10-20`

3. **Filtering**
   - Type `{ "prompt": "#src`
   - Verify only files in `src` directory appear
   - Type more characters and verify list narrows

4. **Multi-file Context**
   - Type `{ "prompt": "#file:src/extension.ts #`
   - Verify completion list appears again for second file

5. **Invalid Positions**
   - Type `#` outside of a prompt string
   - Verify no completions appear
   - Type `#` in end condition script path
   - Verify no completions appear

### Unit Tests

Create `src/test/completions/promptCompletionProvider.test.ts`:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { PromptCompletionProvider } from '../../completions/PromptCompletionProvider';

suite('PromptCompletionProvider Tests', () => {
  
  test('Should provide completions after # in prompt string', async () => {
    const provider = new PromptCompletionProvider();
    
    // Create a test document
    const doc = await vscode.workspace.openTextDocument({
      content: '{ "prompt": "#',
      language: 'json'
    });
    
    const position = new vscode.Position(0, 14); // After #
    
    const completions = await provider.provideCompletionItems(
      doc,
      position,
      new vscode.CancellationTokenSource().token,
      { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '#' }
    );
    
    assert.ok(completions, 'Should return completions');
    assert.ok(completions.items.length > 0, 'Should have completion items');
  });
  
  test('Should not provide completions outside prompt string', async () => {
    const provider = new PromptCompletionProvider();
    
    const doc = await vscode.workspace.openTextDocument({
      content: '{ "otherKey": "#',
      language: 'json'
    });
    
    const position = new vscode.Position(0, 16);
    
    const completions = await provider.provideCompletionItems(
      doc,
      position,
      new vscode.CancellationTokenSource().token,
      { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '#' }
    );
    
    assert.strictEqual(completions, undefined, 'Should not return completions');
  });
  
  test('Should include current selection when available', async () => {
    // This would require setting up an active editor with selection
    // More complex test - may need integration test
  });
});
```

---

## 📐 User Experience

### Before (Current)
```json
{
  "prompt": "/explain #file:src/extension.ts Analyze this code"
}
```
User must manually type the full path. Error-prone, slow.

### After (Enhanced)
```json
{
  "prompt": "/explain #█"
}
```
User types `#` and sees:
```
┌─────────────────────────────────────────┐
│ $(selection) Current Selection          │
│ Lines 10-25 in extension.ts            │
├─────────────────────────────────────────┤
│ extension.ts                            │
│ src                                     │
├─────────────────────────────────────────┤
│ FlightPathManager.ts                    │
│ src/flightpath                          │
├─────────────────────────────────────────┤
│ PromptQueue.ts                          │
│ src/flightpath                          │
└─────────────────────────────────────────┘
```

User can:
- Type to filter (e.g., `#manager` shows only FlightPathManager.ts)
- Arrow keys to navigate
- Enter to select
- See preview in detail/documentation

---

## 🚀 Implementation Steps

### Step 1: Create Completion Provider
- [ ] Create directory: `src/completions/`
- [ ] Create file: `src/completions/PromptCompletionProvider.ts`
- [ ] Implement `isInsidePromptString()` method
- [ ] Implement `provideCompletionItems()` skeleton

### Step 2: File Completions
- [ ] Implement `getWorkspaceFiles()` with caching
- [ ] Implement `getFileCompletions()` with filtering
- [ ] Test with various file structures

### Step 3: Selection Completion
- [ ] Implement `getCurrentSelectionCompletion()`
- [ ] Test with different selection ranges
- [ ] Verify line number formatting (1-based)

### Step 4: Registration
- [ ] Update `extension.ts` to import and register provider
- [ ] Add to `context.subscriptions`
- [ ] Test activation and registration

### Step 5: Testing
- [ ] Write unit tests
- [ ] Manual testing with various scenarios
- [ ] Performance testing with large workspaces

### Step 6: Documentation
- [ ] Update QUICK_START.md with new feature
- [ ] Update README.md with completion demo
- [ ] Add GIF/video demo to docs

---

## 🎨 Future Enhancements (Post-Phase 1)

### Phase 1.5: Enhanced Filtering
- Fuzzy matching (not just substring)
- Recently used files at top
- File type icons
- Syntax highlighting in preview

### Phase 2: Additional Context Types
- `@workspace` completion (just insert the keyword)
- Slash commands (`/fix`, `/explain`, `/new`, `/tests`)
- End condition script path validation

### Phase 3: Inline Documentation
- Hover tooltips for `#file:` syntax
- Code actions to convert between formats
- Quick fixes for invalid paths

---

## 📊 Success Metrics

### User Experience
- ✅ Completions appear within 100ms of typing `#`
- ✅ File list filtered within 50ms of additional keystrokes
- ✅ Current selection always appears at top
- ✅ No false positives (completions where they shouldn't appear)

### Performance
- ✅ Handles workspaces with 10,000+ files
- ✅ Cache reduces repeated file system scans
- ✅ Completion list limited to 500 items max

### Reliability
- ✅ No errors in console during normal usage
- ✅ Graceful handling of missing files
- ✅ Works across different VS Code themes

---

## 🐛 Known Limitations

1. **Single-line only**: JSON strings are single-line by nature, so multi-line prompt strings won't work (not a problem in practice)

2. **No validation**: We don't validate that the file path is correct, just that it's a valid workspace file at completion time

3. **No line range picker**: Users must manually add `:10-20` after selecting a file (could be enhanced in future)

4. **Cache staleness**: File cache is 5 seconds, so newly created files won't appear immediately (acceptable trade-off)

---

## 📚 References

- [VS Code Completion Provider API](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#show-code-completion-proposals)
- [CompletionItem API](https://code.visualstudio.com/api/references/vscode-api#CompletionItem)
- [Workspace API](https://code.visualstudio.com/api/references/vscode-api#workspace)
- [JSON String Parsing](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON)

---

**Ready to implement!** 🚀

Let's start with Step 1: Create the completion provider skeleton.
