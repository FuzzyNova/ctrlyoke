import * as vscode from "vscode";
import * as path from "path";
import { getAvailableModelsSync } from "../utils/ModelRegistry";

/**
 * Provides context-aware completions for FlightPath prompt files
 *
 * Features:
 * - Triggers on `#` character inside "prompt" string values (JSON files)
 * - Triggers on `#` character anywhere in Markdown files
 * - Offers workspace files as completions
 * - Special handling for current selection (#selection)
 * - Dynamic model completions inside "model" string values (JSON files)
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

    // Check if we just typed # or are continuing after #
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);
    const lastHashIndex = textBeforeCursor.lastIndexOf("#");

    if (lastHashIndex === -1) {
      return undefined; // No # found
    }

    // Get the partial text after # (for filtering)
    const afterHash = textBeforeCursor.substring(lastHashIndex + 1);

    // Don't provide completions if there's a space after #
    // (user has moved on to next context item)
    if (afterHash.includes(" ")) {
      return undefined;
    }

    // Generate completions
    const items: vscode.CompletionItem[] = [];

    // 1. Add all editor selection completions (from visible editors)
    const selectionItems = this.getAllSelectionCompletions();
    items.push(...selectionItems);

    // 2. Add workspace files
    const fileItems = await this.getFileCompletions(afterHash);
    items.push(...fileItems);

    // Return a complete list (not incomplete) so it works even with quick suggestions disabled
    // VS Code will still filter these items based on what the user types
    return new vscode.CompletionList(items, false);
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
   * Get file completions from workspace
   */
  private async getFileCompletions(
    filterText: string
  ): Promise<vscode.CompletionItem[]> {
    const files = await this.getWorkspaceFiles();
    const items: vscode.CompletionItem[] = [];

    // Convert filter text to lowercase for case-insensitive matching
    const filter = filterText.toLowerCase().replace(/^file:/, "");

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
      item.detail = dirName === "." ? "Root directory" : dirName;

      // Full path in documentation
      item.documentation = new vscode.MarkdownString(
        `Insert reference to file:\n\n\`#file:${relativePath}\`\n\n` +
          `You can also add line ranges:\n\`#file:${relativePath}:10-20\``
      );

      // Sort by path depth (shorter paths first) then alphabetically
      // Use "!1" prefix to sort near top but after selections
      const depth = relativePath.split(path.sep).length;
      item.sortText = `!1_${depth}_${relativePath}`;

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
