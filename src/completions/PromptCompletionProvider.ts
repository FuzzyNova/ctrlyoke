import * as vscode from "vscode";
import {
  COPILOT_CLI_MODEL_IDS,
  COPILOT_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
import { findWordStartTriggerIndex } from "../utils/ReferenceBoundary";
import { toVSCodeCompletionItem } from "./CompletionHelpers";
import { getCompletionCore } from "./CompletionHelpers";
import type { SecretRegistryService } from "../ui/SecretRegistryService";
import { PROMPT_FILE_LANGUAGE_IDS } from "../types/DashboardConstants";
import { isPositionInsideYamlBlockScalar } from "./YamlBlockScalarContext";
import { getPromptCodeRanges, isCursorInPromptCode } from "./PromptCodeRanges";

/**
 * Trigger character types for context-aware completions
 */
type TriggerChar = "@" | "#" | "~" | "$" | "!";

/**
 * Provides context-aware completions for ctrlyoke prompt files
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
 * - #selection:path:10-20     → Line range snippet (ctrlyoke XML)
 * - #sym:symbolName           → Symbol reference (planned)
 */
export class PromptCompletionProvider implements vscode.CompletionItemProvider {
  // No local cache - using the shared CompletionCore cache

  constructor(
    private readonly getSecretRegistry?: () => SecretRegistryService | undefined
  ) {}

  /**
   * Provide completion items for prompt files (JSON and Markdown)
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    // For JSON files, check for model context first
    if (
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.JSON ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.JSONC
    ) {
      if (this.isInsideModelString(document, position)) {
        return this.getModelCompletions(document, position);
      }
    }

    // Check if we should provide file/selection completions
    if (!this.shouldProvideCompletions(document, position)) {
      return undefined;
    }

    // References inside code are sent literally, so don't offer to build one.
    if (
      isCursorInPromptCode(
        document.offsetAt(position),
        getPromptCodeRanges(
          document.getText(),
          document.fileName,
          document.languageId
        )
      )
    ) {
      return undefined;
    }

    // Determine which trigger character is active
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);
    const lastAtIndex = findWordStartTriggerIndex(textBeforeCursor, "@");
    const lastHashIndex = findWordStartTriggerIndex(textBeforeCursor, "#");
    const lastTildeIndex = findWordStartTriggerIndex(textBeforeCursor, "~");
    const lastDollarIndex = findWordStartTriggerIndex(textBeforeCursor, "$");
    const lastBangIndex = findWordStartTriggerIndex(textBeforeCursor, "!");

    // Determine which trigger is most recent (closest to cursor)
    let triggerChar: TriggerChar | undefined;
    let afterTrigger: string;

    const maxIndex = Math.max(
      lastAtIndex,
      lastHashIndex,
      lastTildeIndex,
      lastDollarIndex,
      lastBangIndex
    );

    if (maxIndex === -1) {
      return undefined; // No trigger found
    }

    if (maxIndex === lastAtIndex) {
      triggerChar = "@";
      afterTrigger = textBeforeCursor.substring(lastAtIndex + 1);
    } else if (maxIndex === lastHashIndex) {
      triggerChar = "#";
      afterTrigger = textBeforeCursor.substring(lastHashIndex + 1);
    } else if (maxIndex === lastTildeIndex) {
      triggerChar = "~";
      afterTrigger = textBeforeCursor.substring(lastTildeIndex + 1);
    } else if (maxIndex === lastDollarIndex) {
      triggerChar = "$";
      afterTrigger = textBeforeCursor.substring(lastDollarIndex + 1);
    } else {
      triggerChar = "!";
      afterTrigger = textBeforeCursor.substring(lastBangIndex + 1);
    }

    // Don't provide completions if there's a space after trigger
    // (except for @ inside a quoted path: @"path with spaces/...")
    const isInsideQuotedPath =
      triggerChar === "@" &&
      afterTrigger.startsWith('"') &&
      !afterTrigger.slice(1).includes('"');
    if (afterTrigger.includes(" ") && !isInsideQuotedPath) {
      return undefined;
    }
    if (triggerChar === "$" && !/^[a-zA-Z0-9:,\-]*$/.test(afterTrigger)) {
      return undefined;
    }
    if (triggerChar === "!" && !/^[A-Z0-9_]*$/.test(afterTrigger)) {
      return undefined;
    }

    // Route to appropriate handler based on trigger
    if (triggerChar === "@") {
      return this.getAtCompletions(afterTrigger, document);
    } else if (triggerChar === "#") {
      return this.getHashCompletions(afterTrigger, document);
    } else if (triggerChar === "~") {
      return this.getTildeCompletions(afterTrigger, document);
    } else if (triggerChar === "!") {
      return this.getSecretCompletions(afterTrigger, document);
    } else {
      return this.getDollarCompletions(afterTrigger, document);
    }
  }

  /**
   * Get completions for @ trigger (full file and directory references)
   * CLI-native syntax for full file/directory attachment
   */
  private async getAtCompletions(
    filterText: string,
    document: vscode.TextDocument
  ): Promise<vscode.CompletionList> {
    // Use shared helper to get plain completions
    const plainItems = await getCompletionCore().getFileCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("@");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "@", range, document)
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
    filterText: string,
    document: vscode.TextDocument
  ): Promise<vscode.CompletionList> {
    // Use shared helper to get plain completions
    const plainItems = await getCompletionCore().getHashCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("#");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "#", range, document)
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
   * Get completions for ~ trigger (git change context)
   */
  private async getTildeCompletions(
    filterText: string,
    document: vscode.TextDocument
  ): Promise<vscode.CompletionList> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : "";
    const plainItems = await getCompletionCore().getGitChangeCompletions(
      workspaceRoot,
      filterText
    );

    const range = this.calculateCompletionRange("~");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "~", range, document)
    );

    return new vscode.CompletionList(items, true);
  }

  private getDollarCompletions(
    filterText: string,
    document: vscode.TextDocument
  ): vscode.CompletionList {
    const plainItems =
      getCompletionCore().getPriorContextCompletions(filterText);
    const range = this.calculateCompletionRange("$");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "$", range, document)
    );

    return new vscode.CompletionList(items, true);
  }

  private async getSecretCompletions(
    filterText: string,
    document: vscode.TextDocument
  ): Promise<vscode.CompletionList> {
    const registry = this.getSecretRegistry?.();
    if (!registry || !vscode.workspace.workspaceFolders?.length) {
      return new vscode.CompletionList([], true);
    }

    const names = await registry.getCompletionNames();
    const plainItems = getCompletionCore().getSecretCompletions(
      names,
      filterText
    );
    const range = this.calculateCompletionRange("!");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "!", range, document)
    );
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
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.MARKDOWN ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.PROMPT
    ) {
      return true;
    }

    // For YAML files, only provide completions inside "prompt:" values
    if (
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.YAML ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.YML
    ) {
      return this.isInsideYamlPromptValue(document, position);
    }

    // For JSON files, only provide completions inside "prompt" string values
    if (
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.JSON ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.JSONC
    ) {
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
    const currentLineText = document.lineAt(position.line).text;
    if (
      isPositionInsideYamlBlockScalar(
        (line) => document.lineAt(line).text,
        position.line,
        position.character,
        "prompt"
      )
    ) {
      return true;
    }

    const currentPromptHeader = /^\s*(?:-\s+)?prompt:\s*(.*)$/.exec(
      currentLineText
    );
    if (currentPromptHeader) {
      return currentPromptHeader[1].trim() !== "";
    }

    for (
      let line = position.line - 1;
      line >= Math.max(0, position.line - 50);
      line--
    ) {
      const text = document.lineAt(line).text;
      const promptHeader = /^\s*(?:-\s+)?prompt:\s*(.*)$/.exec(text);
      if (!promptHeader) continue;
      if (promptHeader[1].trim() !== "") return false;

      const promptIndent = text.indexOf("prompt");
      for (
        let contentLine = line + 1;
        contentLine <= position.line;
        contentLine++
      ) {
        const content = document.lineAt(contentLine).text;
        if (content.trim() === "") continue;
        const indent = content.search(/\S/);
        if (indent <= promptIndent) return false;
      }
      return true;
    }

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
    const items: vscode.CompletionItem[] = [];

    // Get the current partial text for filtering
    const line = document.lineAt(position.line).text;
    const modelMatch = line.match(/\"model\"\s*:\s*\"/);
    if (!modelMatch) {
      return new vscode.CompletionList(items, false);
    }

    const colonIndex = line.indexOf(":", modelMatch.index!);
    const openQuoteIndex = line.indexOf('"', colonIndex);

    for (const modelId of COPILOT_CLI_MODEL_IDS) {
      const label = COPILOT_CLI_MODEL_LABELS[modelId] ?? modelId;
      const item = new vscode.CompletionItem(
        modelId,
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
      item.insertText = modelId;
      item.detail = label;

      const doc = new vscode.MarkdownString();
      doc.appendMarkdown(`**${label}**\n\n`);
      doc.appendMarkdown(`- Model ID: \`${modelId}\`\n`);
      item.documentation = doc;

      item.filterText = modelId;

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
    const triggerIndex = findWordStartTriggerIndex(
      textBeforeCursor,
      triggerChar
    );

    if (triggerIndex === -1) {
      return undefined;
    }

    const replaceStart = new vscode.Position(currentPos.line, triggerIndex + 1);
    const replaceEnd = currentPos;
    return new vscode.Range(replaceStart, replaceEnd);
  }
}
