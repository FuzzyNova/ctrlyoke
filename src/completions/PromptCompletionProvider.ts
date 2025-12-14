import * as vscode from "vscode";
import * as path from "path";
import { getAvailableModelsSync } from "../utils/ModelRegistry";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";

/**
 * Trigger character types for context-aware completions
 */
type TriggerChar = "@" | "#";

/**
 * Provides context-aware completions for FlightPath prompt files
 *
 * Features:
 * - Triggers on `@` character for full file references (CLI-native syntax)
 * - Triggers on `#` character for snippet references (line ranges, selections)
 * - Offers workspace files as completions
 * - Special handling for current selection (inserts #file:path:line-line)
 * - Dynamic model completions inside "model" string values (JSON files)
 *
 * Syntax Reference (see docs/PROMPT_SYNTAX.md):
 * - @path/to/file.ts       → Full file (CLI handles natively)
 * - #file:path:10-20       → Line range snippet (FlightPath XML)
 * - #sym:symbolName        → Symbol reference (planned)
 */
export class PromptCompletionProvider implements vscode.CompletionItemProvider {
  // Cache for workspace files
  private filesCache: vscode.Uri[] = [];
  private filesCacheTimestamp: number = 0;
  private readonly CACHE_DURATION_MS = 5000; // 5 seconds

  /**
   * Provide completion items for prompt files (JSON and Markdown)
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    // For JSON files, check for model context first
    if (document.languageId === "json" || document.languageId === "jsonc") {
      if (this.isInsideModelString(document, position)) {
        return this.getModelCompletions(document, position);
      }
    }

    // Check if we should provide file/selection completions
    if (!this.shouldProvideCompletions(document, position)) {
      return undefined;
    }

    // Determine which trigger character is active
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");
    const lastHashIndex = textBeforeCursor.lastIndexOf("#");

    // Determine which trigger is more recent (closer to cursor)
    let triggerChar: TriggerChar | undefined;
    let afterTrigger: string;

    if (lastAtIndex > lastHashIndex) {
      triggerChar = "@";
      afterTrigger = textBeforeCursor.substring(lastAtIndex + 1);
    } else if (lastHashIndex !== -1) {
      triggerChar = "#";
      afterTrigger = textBeforeCursor.substring(lastHashIndex + 1);
    } else {
      return undefined; // No trigger found
    }

    // Don't provide completions if there's a space after trigger
    // (user has moved on to next context item)
    if (afterTrigger.includes(" ")) {
      return undefined;
    }

    // Route to appropriate handler based on trigger
    if (triggerChar === "@") {
      return this.getAtCompletions(afterTrigger);
    } else {
      return this.getHashCompletions(afterTrigger);
    }
  }

  /**
   * Get completions for @ trigger (full file and directory references)
   * CLI-native syntax for full file/directory attachment
   */
  private async getAtCompletions(
    filterText: string
  ): Promise<vscode.CompletionList> {
    const items: vscode.CompletionItem[] = [];
    const files = await this.getWorkspaceFiles();

    // Convert filter text to lowercase and normalize path separators
    // (VS Code always uses forward slashes, but Windows users type backslashes)
    const filter = filterText.toLowerCase().replace(/\\/g, "/");

    // Track unique directories we've seen
    const directories = new Set<string>();

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);

      // Simple filtering: check if the path contains the filter text
      if (filter && !relativePath.toLowerCase().includes(filter)) {
        continue;
      }

      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);

      // Add file completion
      const fileItem = new vscode.CompletionItem(
        fileName,
        vscode.CompletionItemKind.File
      );

      // Insert just the path (@ is already typed)
      fileItem.insertText = relativePath;

      // Show directory in detail
      fileItem.detail = dirName === "." ? "Root directory" : dirName;

      // Full path in documentation with @path example
      fileItem.documentation = new vscode.MarkdownString(
        `**Full file attachment** (CLI-native)\n\n` +
          `Insert: \`@${relativePath}\`\n\n` +
          `The CLI will automatically attach this file's content.\n\n` +
          `_For line ranges, use \`#file:${relativePath}:10-20\`_`
      );

      // Sort by path depth (shorter paths first) then alphabetically
      const depth = relativePath.split(path.sep).length;
      fileItem.sortText = `0_${depth}_${relativePath}`;

      // Include path in filter text for fuzzy search
      fileItem.filterText = `${relativePath} ${fileName}`;

      items.push(fileItem);

      // Track directory for directory completions
      if (dirName !== ".") {
        directories.add(dirName);
      }

      // Limit to 500 items for performance
      if (items.length >= 500) {
        break;
      }
    }

    // Add directory completions (with trailing slash)
    for (const dirPath of directories) {
      if (filter && !dirPath.toLowerCase().includes(filter)) {
        continue;
      }

      const dirName = path.basename(dirPath);
      const parentDir = path.dirname(dirPath);

      const dirItem = new vscode.CompletionItem(
        dirName + "/",
        vscode.CompletionItemKind.Folder
      );

      // Insert directory path WITH trailing slash
      dirItem.insertText = dirPath + "/";

      // Show parent directory
      dirItem.detail = parentDir === "." ? "Root directory" : parentDir;

      // Documentation
      dirItem.documentation = new vscode.MarkdownString(
        `**Directory structure attachment**\n\n` +
          `Insert: \`@${dirPath}/\`\n\n` +
          `FlightPath will attach a file tree of this directory.\n\n` +
          `_No file contents, just structure._`
      );

      // Sort directories before files at same depth
      const depth = dirPath.split(path.sep).length;
      dirItem.sortText = `0_${depth}_0_${dirPath}`;

      dirItem.filterText = `${dirPath} ${dirName}`;

      items.push(dirItem);
    }

    return new vscode.CompletionList(items, false);
  }

  /**
   * Get completions for # trigger (selections + symbols)
   *
   * Shows:
   * 1. Current editor selections (bubbled to top, if any)
   * 2. Workspace symbols (functions, classes, methods, etc.)
   *
   * Behavior:
   * - `#` → Shows selections + symbols
   * - `#Fl` → Shows selections + symbols matching "Fl"
   */
  private async getHashCompletions(
    filterText: string
  ): Promise<vscode.CompletionList> {
    const items: vscode.CompletionItem[] = [];

    // 1. Add selection completions FIRST (bubbled to top with sortText)
    const selectionItems = this.getAllSelectionCompletions();
    selectionItems.forEach((item) => {
      // Prefix sortText to bubble selections to top
      item.sortText = `0_${item.sortText || item.label}`;
    });
    items.push(...selectionItems);

    // 2. Add workspace symbols
    const symbolItems = await this.getSymbolCompletions(filterText);
    symbolItems.forEach((item) => {
      // Prefix sortText to keep symbols below selections
      item.sortText = `1_${item.sortText || item.label}`;
    });
    items.push(...symbolItems);

    // CRITICAL: Must be true to get fresh symbol queries as user types
    // DO NOT CHANGE TO FALSE - list will not refresh without this
    //
    // Known VS Code bug: isIncomplete: true sometimes shows duplicate entries in the
    // completion dropdown (only affects UI, not the data we return). This is a VS Code
    // issue with how it handles completion list updates. isIncomplete: false is worse:
    // it still has dupes AND doesn't update the list as the user types.
    return new vscode.CompletionList(items, true);
  }

  /**
   * Get symbol completions for # trigger
   * Shows workspace symbols from all file types (functions, classes, methods, variables, markdown headers, etc.)
   */
  private async getSymbolCompletions(
    filterText: string
  ): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];

    try {
      // Query workspace symbols (all file types)
      const symbols = await getWorkspaceSymbols(filterText, 500);

      for (const symbol of symbols) {
        const item = new vscode.CompletionItem(
          symbol.name,
          vscode.CompletionItemKind.Reference
        );

        // Get workspace-relative path for detail
        const relativePath = vscode.workspace.asRelativePath(
          symbol.location.uri,
          false
        );

        // Get line number (1-based)
        const line = symbol.location.range.start.line + 1;

        // Insert #sym:path/to/file.ts:SymbolName:123
        // This format allows disambiguation when:
        // - Same symbol name exists in multiple files
        // - Same symbol name appears multiple times in same file
        item.insertText = `sym:${relativePath}:${symbol.name}:${line}`;

        // Show symbol kind and location
        const symbolKindName = vscode.SymbolKind[symbol.kind];
        item.detail = `${symbolKindName} in ${relativePath}:${line}`;

        // Documentation shows full location
        item.documentation = new vscode.MarkdownString(
          `**Symbol Reference**\n\n` +
            `Type: ${symbolKindName}\n\n` +
            `Location: \`${relativePath}:${line}\`\n\n` +
            `Insert: \`#sym:${relativePath}:${symbol.name}:${line}\`\n\n` +
            `_FlightPath will resolve this symbol to its exact location and attach the code._`
        );

        // Sort by symbol name
        item.sortText = symbol.name;

        // Filter text includes both symbol name and file path
        item.filterText = `${symbol.name} ${relativePath}`;

        items.push(item);
      }
    } catch (error) {
      console.error("Failed to get symbol completions:", error);
    }

    return items;
  }

  /**
   * Check if we should provide completions based on file type and cursor position
   */
  private shouldProvideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    // For Markdown and Prompt files (*.prompt.md, *.md), always provide completions
    if (
      document.languageId === "markdown" ||
      document.languageId === "prompt"
    ) {
      return true;
    }

    // For JSON files, only provide completions inside "prompt" string values
    if (document.languageId === "json" || document.languageId === "jsonc") {
      return this.isInsidePromptString(document, position);
    }

    // For other file types, don't provide completions
    return false;
  }

  /**
   * Check if cursor position is inside a "prompt" string value (JSON files only)
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
    const colonIndex = line.indexOf(":", promptMatch.index!);
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
   * Check if cursor position is inside a "model" string value (JSON files only)
   */
  private isInsideModelString(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    const line = document.lineAt(position.line).text;
    const charIndex = position.character;

    // Check if line contains "model":
    const modelMatch = line.match(/\"model\"\s*:\s*\"/);
    if (!modelMatch) {
      return false;
    }

    // Find the opening quote of the value
    const colonIndex = line.indexOf(":", modelMatch.index!);
    const openQuoteIndex = line.indexOf('"', colonIndex);

    if (openQuoteIndex === -1 || charIndex <= openQuoteIndex) {
      return false;
    }

    // We're inside the string if we're after the opening quote
    return charIndex > openQuoteIndex;
  }

  /**
   * Get model completions from ModelRegistry
   */
  private getModelCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList {
    const models = getAvailableModelsSync();
    const items: vscode.CompletionItem[] = [];

    // Get the current partial text for filtering
    const line = document.lineAt(position.line).text;
    const modelMatch = line.match(/\"model\"\s*:\s*\"/);
    if (!modelMatch) {
      return new vscode.CompletionList(items, false);
    }

    const colonIndex = line.indexOf(":", modelMatch.index!);
    const openQuoteIndex = line.indexOf('"', colonIndex);
    const partialText = line.substring(openQuoteIndex + 1, position.character);

    for (const model of models) {
      const item = new vscode.CompletionItem(
        model.id,
        vscode.CompletionItemKind.EnumMember
      );

      // Replace the entire value inside the quotes
      const startPos = new vscode.Position(position.line, openQuoteIndex + 1);
      const endQuoteIndex = line.indexOf('"', position.character);
      const endPos =
        endQuoteIndex > position.character
          ? new vscode.Position(position.line, endQuoteIndex)
          : position;

      item.range = new vscode.Range(startPos, endPos);
      item.insertText = model.id;

      // Show CLI support indicator
      item.detail = model.cliSupported ? "CLI & Chat" : "Chat only";

      // Documentation with model info
      const doc = new vscode.MarkdownString();
      doc.appendMarkdown(`**${model.id}**\n\n`);
      doc.appendMarkdown(`- Vendor: ${model.vendor}\n`);
      doc.appendMarkdown(`- Family: ${model.family}\n`);
      doc.appendMarkdown(
        `- CLI Support: ${model.cliSupported ? "✅ Yes" : "❌ No (Chat mode only)"}\n`
      );
      item.documentation = doc;

      // Sort CLI-supported models first
      item.sortText = model.cliSupported ? `0_${model.id}` : `1_${model.id}`;

      // Filter text includes partial for search
      item.filterText = model.id;

      items.push(item);
    }

    // If no models available, show a helpful message
    if (items.length === 0) {
      const noModelsItem = new vscode.CompletionItem(
        "No models available",
        vscode.CompletionItemKind.Text
      );
      noModelsItem.detail = "Model registry not initialized";
      noModelsItem.insertText = "";
      items.push(noModelsItem);
    }

    return new vscode.CompletionList(items, false);
  }

  /**
   * Get completions for all editor selections (from all visible editors)
   */
  private getAllSelectionCompletions(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    // Get all visible editors (including split views)
    const visibleEditors = vscode.window.visibleTextEditors;

    // Track unique selections (avoid duplicates if same file/range appears multiple times)
    const seenSelections = new Set<string>();

    let selectionIndex = 0;

    for (const editor of visibleEditors) {
      // Skip if no selection or selection is empty
      if (editor.selection.isEmpty) {
        continue;
      }

      const selection = editor.selection;
      const document = editor.document;

      // Get workspace-relative path
      const relativePath = vscode.workspace.asRelativePath(document.uri, false);

      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;

      // Create unique key for this selection
      const selectionKey = `${relativePath}:${startLine}-${endLine}`;

      // Skip if we've already seen this exact selection
      if (seenSelections.has(selectionKey)) {
        continue;
      }
      seenSelections.add(selectionKey);

      // Format: #file:path:startLine-endLine
      const completionText = `file:${relativePath}:${startLine}-${endLine}`;

      // Create label with file name and line range
      const fileName = path.basename(relativePath);
      const label =
        visibleEditors.length > 1
          ? `$(selection) ${fileName} (lines ${startLine}-${endLine})`
          : `$(selection) Current Selection`;

      const item = new vscode.CompletionItem(
        label,
        vscode.CompletionItemKind.Reference
      );

      item.insertText = completionText;
      item.detail = `Lines ${startLine}-${endLine} in ${relativePath}`;

      // Get preview of selected text (first 100 chars)
      const selectedText = document.getText(selection);
      const preview =
        selectedText.length > 100
          ? selectedText.substring(0, 100) + "..."
          : selectedText;

      item.documentation = new vscode.MarkdownString(
        `Insert reference to selected code:\n\n\`#${completionText}\`\n\n` +
          `**Preview:**\n\`\`\`\n${preview}\n\`\`\``
      );

      // Sort at top of list, with index to maintain order
      // Use "!" prefix to sort before other items (ASCII sort)
      item.sortText = `!000_selection_${selectionIndex.toString().padStart(3, "0")}`;

      // Show full path in filter text for searchability
      item.filterText = `file selection ${relativePath} ${fileName}`;

      items.push(item);
      selectionIndex++;
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
      "**/*",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode/**}"
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
