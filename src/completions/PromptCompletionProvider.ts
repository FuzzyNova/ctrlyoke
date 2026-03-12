import * as vscode from "vscode";
import * as path from "path";
import { getAvailableModelsSync } from "../utils/ModelRegistry";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
  toVSCodeCompletionItem,
  clearFilesCache,
} from "./CompletionHelpers";

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
 * - Special handling for current selection (inserts #selection:path:line-line)
 * - Dynamic model completions inside "model" string values (JSON files)
 *
 * Syntax Reference (see docs/PROMPT_SYNTAX.md):
 * - @path/to/file.ts          → Full file (CLI handles natively)
 * - #selection:path:10-20     → Line range snippet (FlightPath XML)
 * - #sym:symbolName           → Symbol reference (planned)
 */
export class PromptCompletionProvider implements vscode.CompletionItemProvider {
  // No local cache - using shared cache from CompletionHelpers

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
    // unless we're inside a quoted path: @"path with spaces/..."
    // A quoted path starts with " immediately after the trigger character
    const isInsideQuotedPath =
      afterTrigger.startsWith('"') && !afterTrigger.slice(1).includes('"');
    if (afterTrigger.includes(" ") && !isInsideQuotedPath) {
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
    // Use shared helper to get plain completions
    const plainItems = await getFileCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("@");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "@", range)
    );

    return new vscode.CompletionList(items, true);
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
    // Use shared helper to get plain completions
    const plainItems = await getHashCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("#");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "#", range)
    );

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
   * Check if we should provide completions based on file type and cursor position
   */
  private shouldProvideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    // For Markdown and Prompt files, always provide completions
    if (
      document.languageId === "markdown" ||
      document.languageId === "prompt"
    ) {
      return true;
    }

    // For YAML files, only provide completions inside "prompt:" values
    if (document.languageId === "yaml" || document.languageId === "yml") {
      return this.isInsideYamlPromptValue(document, position);
    }

    // For JSON files, only provide completions inside "prompt" string values
    if (document.languageId === "json" || document.languageId === "jsonc") {
      return this.isInsidePromptString(document, position);
    }

    // For other file types, don't provide completions
    return false;
  }

  /**
   * Check if cursor position is inside a YAML prompt value
   */
  private isInsideYamlPromptValue(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    const currentLine = position.line;
    const currentLineText = document.lineAt(currentLine).text;

    // Get current line indentation (handle empty/whitespace-only lines)
    const currentIndent = currentLineText.search(/\S/);
    const currentIndentActual =
      currentIndent === -1 ? currentLineText.length : currentIndent;

    Log.trace(
      `[isInsideYamlPromptValue] Checking line ${currentLine}: "${currentLineText}" (indent=${currentIndentActual})`
    );

    // Search backwards for "prompt:" key (up to 50 lines)
    for (let i = currentLine; i >= Math.max(0, currentLine - 50); i--) {
      const lineText = document.lineAt(i).text;

      // Check for "prompt:" (with optional leading spaces/dashes for list items)
      const promptMatch = lineText.match(/^\s*-?\s*prompt:\s*(.*)$/);

      if (promptMatch) {
        const afterColon = promptMatch[1].trim();
        const promptIndent = lineText.search(/\S/);

        // Case 1: prompt: | or prompt: > (multi-line block scalar)
        if (afterColon === "|" || afterColon === ">") {
          if (i < currentLine) {
            // We're on a line after the prompt: line
            // For block scalars, content must be indented more than the key
            // Empty lines are OK (stay in block)
            if (currentLineText.trim() === "") {
              return true;
            }
            // Non-empty lines must be indented more than prompt key
            if (currentIndentActual > promptIndent) {
              return true;
            }
            // Equal/less indentation = out of block
            return false;
          }
          // We're on the prompt: line itself, after the | or >
          // Allow completions here too (user typing on same line)
          return (
            position.character >
            lineText.indexOf(afterColon) + afterColon.length
          );
        }

        // Case 2: prompt: "inline string" or prompt: 'inline string'
        if (afterColon.startsWith('"') || afterColon.startsWith("'")) {
          return i === currentLine;
        }

        // Case 3: prompt: inline text without quotes
        if (afterColon !== "") {
          return i === currentLine;
        }

        // prompt: with nothing after (value on next line)
        if (i < currentLine) {
          // Check indentation - must be more indented
          if (
            currentLineText.trim() === "" ||
            currentIndentActual > promptIndent
          ) {
            return true;
          }
        }

        return false;
      }

      // Stop if we hit another YAML key at same/less indentation
      // (we've moved out of the prompt block into another field)
      if (i < currentLine && lineText.match(/^\s*-?\s*\w+:\s*/)) {
        const lineIndent = lineText.search(/\S/);
        if (lineIndent !== -1 && lineIndent <= currentIndentActual) {
          return false;
        }
      }
    }

    Log.trace(`[isInsideYamlPromptValue] No prompt: found, returning false`);
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
    return (
      charIndex > openQuoteIndex &&
      (closeQuoteIndex === -1 || charIndex <= closeQuoteIndex)
    );
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
   * Clear the cache (useful for testing or when workspace changes)
   */
  public clearCache(): void {
    // Delegate to shared cache in CompletionHelpers
    clearFilesCache();
  }

  /**
   * Calculate completion range for YAML compatibility
   *
   * CRITICAL: VS Code YAML extension suppresses completions without explicit range.
   * This calculates the range from the trigger character to cursor position.
   *
   * @param triggerChar The trigger character ("@" or "#")
   * @returns Range to replace, or undefined if no active editor or trigger not found
   */
  private calculateCompletionRange(
    triggerChar: string
  ): vscode.Range | undefined {
    const currentPos = vscode.window.activeTextEditor?.selection.active;
    if (!currentPos) {
      return undefined;
    }

    const line = vscode.window.activeTextEditor!.document.lineAt(
      currentPos.line
    ).text;
    const textBeforeCursor = line.substring(0, currentPos.character);
    const triggerIndex = textBeforeCursor.lastIndexOf(triggerChar);

    if (triggerIndex === -1) {
      return undefined;
    }

    const replaceStart = new vscode.Position(currentPos.line, triggerIndex + 1);
    const replaceEnd = currentPos;
    return new vscode.Range(replaceStart, replaceEnd);
  }
}
