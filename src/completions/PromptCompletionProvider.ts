import * as vscode from "vscode";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
import { findWordStartTriggerIndex } from "../utils/ReferenceBoundary";
import { toVSCodeCompletionItem } from "./CompletionHelpers";
import { getCompletionCore } from "./CompletionHelpers";
import type { SecretRegistryService } from "../ui/SecretRegistryService";
import {
  PROMPT_FILE_LANGUAGE_IDS,
  WORKFLOW_LOCATION_ROLES,
} from "../types/DashboardConstants";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import { getWorkflowLocation } from "./WorkflowDocumentLocation";
import {
  getWorkflowInsertEscape,
  type InsertTextEscape,
} from "./WorkflowInsertEscape";
import { getCtrlYokeSlashCompletions } from "./SlashTokenCompletionHelpers";
import { findPartialSlashTokenStart } from "../utils/CtrlYokeSlashTokens";
import {
  getDocumentPromptCodeRanges,
  isCursorInPromptCode,
} from "./PromptCodeRanges";

/**
 * Trigger character types for context-aware completions
 */
type TriggerChar = "@" | "#" | "~" | "$" | "!" | "/";

/**
 * Provides context-aware completions for ctrlyoke prompt files
 *
 * Features:
 * - Triggers on `@` character for full file references (CLI-native syntax)
 * - Triggers on `#` character for snippet references (line ranges, selections)
 * - Offers workspace files as completions
 * - Special handling for current selection (inserts #selection:path:line-line)
 * - Triggers on `/` for ctrlyoke `/skill:` and `/mcp:` tokens
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
    // Determine which trigger character is active
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);
    const lastAtIndex = findWordStartTriggerIndex(textBeforeCursor, "@");
    const lastHashIndex = findWordStartTriggerIndex(textBeforeCursor, "#");
    const lastTildeIndex = findWordStartTriggerIndex(textBeforeCursor, "~");
    const lastDollarIndex = findWordStartTriggerIndex(textBeforeCursor, "$");
    const lastBangIndex = findWordStartTriggerIndex(textBeforeCursor, "!");
    const lastSlashIndex = findPartialSlashTokenStart(textBeforeCursor);

    // Determine which trigger is most recent (closest to cursor)
    let triggerChar: TriggerChar | undefined;
    let afterTrigger: string;

    const maxIndex = Math.max(
      lastAtIndex,
      lastHashIndex,
      lastTildeIndex,
      lastDollarIndex,
      lastBangIndex,
      lastSlashIndex
    );

    if (maxIndex === -1) {
      return undefined; // No trigger found
    }

    const promptText = this.locatePromptText(document, position);
    if (!promptText) {
      return undefined;
    }
    const { escape } = promptText;

    // References inside code are sent literally, so don't offer to build one.
    if (
      isCursorInPromptCode(
        document.offsetAt(position),
        getDocumentPromptCodeRanges(document)
      )
    ) {
      return undefined;
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
    } else if (maxIndex === lastBangIndex) {
      triggerChar = "!";
      afterTrigger = textBeforeCursor.substring(lastBangIndex + 1);
    } else {
      triggerChar = "/";
      afterTrigger = textBeforeCursor.substring(lastSlashIndex + 1);
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
    if (triggerChar === "/" && !/^[\w:.-]*$/.test(afterTrigger)) {
      return undefined;
    }

    // Route to appropriate handler based on trigger
    if (triggerChar === "@") {
      return this.getAtCompletions(afterTrigger, escape);
    } else if (triggerChar === "#") {
      return this.getHashCompletions(afterTrigger, escape);
    } else if (triggerChar === "~") {
      return this.getTildeCompletions(afterTrigger, escape);
    } else if (triggerChar === "!") {
      return this.getSecretCompletions(afterTrigger, escape);
    } else if (triggerChar === "/") {
      return this.getSlashCompletions(afterTrigger, escape, position);
    } else {
      return this.getDollarCompletions(afterTrigger, escape);
    }
  }

  /**
   * Get completions for @ trigger (full file and directory references)
   * CLI-native syntax for full file/directory attachment
   */
  private async getAtCompletions(
    filterText: string,
    escape: InsertTextEscape | undefined
  ): Promise<vscode.CompletionList> {
    // Use shared helper to get plain completions
    const plainItems = await getCompletionCore().getFileCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("@");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "@", range, escape)
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
    escape: InsertTextEscape | undefined
  ): Promise<vscode.CompletionList> {
    // Use shared helper to get plain completions
    const plainItems = await getCompletionCore().getHashCompletions(filterText);

    // Convert to VS Code completion items with range for YAML compatibility
    const range = this.calculateCompletionRange("#");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "#", range, escape)
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
    escape: InsertTextEscape | undefined
  ): Promise<vscode.CompletionList> {
    const workspaceRoot = getVsCodeWorkspaceRoot() ?? "";
    const plainItems = await getCompletionCore().getGitChangeCompletions(
      workspaceRoot,
      filterText
    );

    const range = this.calculateCompletionRange("~");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "~", range, escape)
    );

    return new vscode.CompletionList(items, true);
  }

  private getDollarCompletions(
    filterText: string,
    escape: InsertTextEscape | undefined
  ): vscode.CompletionList {
    const plainItems =
      getCompletionCore().getPriorContextCompletions(filterText);
    const range = this.calculateCompletionRange("$");
    const items = plainItems.map((item) =>
      toVSCodeCompletionItem(item, "$", range, escape)
    );

    return new vscode.CompletionList(items, true);
  }

  /**
   * `/skill:` and `/mcp:` tokens. Unlike the other triggers the item text
   * includes the `/`, so the replacement range starts on it.
   */
  private async getSlashCompletions(
    afterSlash: string,
    escape: InsertTextEscape | undefined,
    position: vscode.Position
  ): Promise<vscode.CompletionList> {
    const workspaceRoot = getVsCodeWorkspaceRoot();
    const plainItems = await getCtrlYokeSlashCompletions(
      workspaceRoot,
      `/${afterSlash}`
    );
    const range = new vscode.Range(
      position.line,
      position.character - afterSlash.length - 1,
      position.line,
      position.character
    );
    const items = plainItems.map((item) => {
      const vscodeItem = toVSCodeCompletionItem(item, "/", range, escape);
      // VS Code filters on the range text, which starts on the `/`, so the
      // bare name in `filterText` would match nothing.
      vscodeItem.filterText = item.insertText;
      return vscodeItem;
    });
    return new vscode.CompletionList(items, true);
  }

  private async getSecretCompletions(
    filterText: string,
    escape: InsertTextEscape | undefined
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
      toVSCodeCompletionItem(item, "!", range, escape)
    );
    return new vscode.CompletionList(items, true);
  }

  /**
   * Prompt tokens complete in prompt text only. A ctrlyoke file asks
   * `getWorkflowLocation` (so `retryPrompt`, `passRetryPrompt` and a
   * `.prompt.md` body count and frontmatter, scripts and comments do not);
   * any other markdown or `prompt`-language document is prompt text throughout.
   * Returns undefined outside prompt text, and otherwise the escape inserted
   * text needs for the string it lands in (a JSON or quoted YAML prompt).
   */
  private locatePromptText(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { escape: InsertTextEscape | undefined } | undefined {
    const kind = getCtrlYokeFileKind(document.fileName);
    if (kind) {
      const location = getWorkflowLocation(
        document.getText(),
        document.offsetAt(position),
        kind
      );
      return location.role === WORKFLOW_LOCATION_ROLES.PROMPT_TEXT
        ? { escape: getWorkflowInsertEscape(location) }
        : undefined;
    }
    return document.languageId === PROMPT_FILE_LANGUAGE_IDS.MARKDOWN ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.PROMPT
      ? { escape: undefined }
      : undefined;
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
