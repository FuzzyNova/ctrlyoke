import * as vscode from "vscode";
import { STEP_TYPES, PROMPT_PROPERTIES } from "../types/DashboardConstants";

/**
 * Provides YAML property key completions for FlightPath workflow files.
 *
 * When editing a prompt item block in a .flightpath.yaml file, this provider
 * offers context-aware property key suggestions:
 *
 * - Default (AI prompt step): offers all AI-specific properties
 * - Script step (type: script): suppresses AI-only properties; offers script-specific ones
 * - The `type` property itself offers `"prompt"` and `"script"` enum values
 *
 * Detection logic:
 * - Searches the current item block (bounded by list-item boundary `-`) for `type: script`
 * - Property key position detected as: leading whitespace on a line (no colon yet, or just after
 *   an existing key) — i.e., cursor is at a point where a YAML key would appear
 */
export class PromptPropertyCompletionProvider
  implements vscode.CompletionItemProvider
{
  /** Properties available on script steps only */
  private static readonly SCRIPT_ONLY_PROPERTIES: ReadonlyArray<{
    key: string;
    detail: string;
    documentation: string;
    insertSnippet?: string;
  }> = [
    {
      key: PROMPT_PROPERTIES.SCRIPT,
      detail: "Shell command or script path (required)",
      documentation:
        "Shell command or path to script file to execute. Resolved relative to workspace root or `.flightpath/`.",
      insertSnippet: `${PROMPT_PROPERTIES.SCRIPT}: `,
    },
    {
      key: "timeout",
      detail: "Timeout in milliseconds",
      documentation:
        "Timeout in milliseconds. Defaults to the `flightpath.scriptTimeout` extension setting.",
      insertSnippet: "timeout: ",
    },
    {
      key: PROMPT_PROPERTIES.CONTINUE_ON_FAILURE,
      detail: "Continue workflow on non-zero exit (boolean)",
      documentation:
        "When `true`, a non-zero exit code is treated as a warning and the workflow continues. Default: `false`.",
      insertSnippet: `${PROMPT_PROPERTIES.CONTINUE_ON_FAILURE}: `,
    },
  ];

  /** Properties common to all step types */
  private static readonly COMMON_PROPERTIES: ReadonlyArray<{
    key: string;
    detail: string;
    documentation: string;
    insertSnippet?: string;
  }> = [
    {
      key: PROMPT_PROPERTIES.STEP_TYPE,
      detail: `Step type: "${STEP_TYPES.PROMPT}" | "${STEP_TYPES.SCRIPT}"`,
      documentation:
        "Discriminates the step type. Omit for an AI prompt step (backwards compatible). " +
        `Set to \`"${STEP_TYPES.SCRIPT}"\` for a shell script step with no AI interaction.`,
      insertSnippet: `${PROMPT_PROPERTIES.STEP_TYPE}: `,
    },
    {
      key: "name",
      detail: "Display label (optional)",
      documentation:
        "Human-readable label shown in the FlightPath dashboard. " +
        "If omitted, the dashboard shows a truncated preview of the prompt or script.",
      insertSnippet: "name: ",
    },
  ];

  /** AI prompt step properties (not applicable to script steps) */
  private static readonly AI_PROMPT_PROPERTIES: ReadonlyArray<{
    key: string;
    detail: string;
    documentation: string;
    insertSnippet?: string;
  }> = [
    {
      key: PROMPT_PROPERTIES.PROMPT,
      detail: "Prompt text or path to .prompt.md (required)",
      documentation:
        "The prompt to send to the AI assistant. Supports inline text (with `@file` and `#selection:` references) or a path to a `.prompt.md`, `.md`, or `.txt` file.",
      insertSnippet: `${PROMPT_PROPERTIES.PROMPT}: |\n  `,
    },
    {
      key: PROMPT_PROPERTIES.HARNESS,
      detail: "Harness override for this step",
      documentation:
        "Overrides the workflow-level harness for this step (e.g., `claude-cli`, `copilot-cli`).",
      insertSnippet: `${PROMPT_PROPERTIES.HARNESS}: `,
    },
    {
      key: PROMPT_PROPERTIES.MODEL,
      detail: "Model override for this step",
      documentation:
        "Overrides the workflow-level model for this step (e.g., `claude-sonnet-4.5`).",
      insertSnippet: `${PROMPT_PROPERTIES.MODEL}: `,
    },
    {
      key: PROMPT_PROPERTIES.AGENT,
      detail: "Path to .agent.md custom agent file",
      documentation:
        "Path to a custom agent definition (`.agent.md`) used for this step.",
      insertSnippet: `${PROMPT_PROPERTIES.AGENT}: `,
    },
    {
      key: PROMPT_PROPERTIES.SKILLS,
      detail: "Skills to attach to this step",
      documentation: "List of skill identifiers to make available for this step.",
      insertSnippet: `${PROMPT_PROPERTIES.SKILLS}:\n  - `,
    },
    {
      key: PROMPT_PROPERTIES.RESUME_SESSION,
      detail: "Continue conversation from previous step (boolean)",
      documentation:
        "When `true`, resumes the AI session from the previous step rather than starting a new conversation.",
      insertSnippet: `${PROMPT_PROPERTIES.RESUME_SESSION}: true`,
    },
    {
      key: PROMPT_PROPERTIES.SESSION_ID,
      detail: "Session ID or prior step index to resume",
      documentation:
        "Resume a specific AI session by GUID/thread ID, or reference a prior prompt by step number (e.g., `1`).",
      insertSnippet: `${PROMPT_PROPERTIES.SESSION_ID}: `,
    },
    {
      key: PROMPT_PROPERTIES.MCP_SERVERS,
      detail: "MCP servers to attach",
      documentation:
        "List of MCP server identifiers to attach for this step (e.g., `[\"flightpath\"]`).",
      insertSnippet: `${PROMPT_PROPERTIES.MCP_SERVERS}:\n  - `,
    },
    {
      key: PROMPT_PROPERTIES.HOOKS,
      detail: "Pre/post execution hooks",
      documentation: "User-defined hooks executed before and after this step.",
      insertSnippet: `${PROMPT_PROPERTIES.HOOKS}:\n  `,
    },
    {
      key: PROMPT_PROPERTIES.END_CONDITION,
      detail: "Validation script run after AI response",
      documentation:
        "End condition evaluated after the AI responds. If the condition fails, the step retries with `retryPrompt`.",
      insertSnippet: `${PROMPT_PROPERTIES.END_CONDITION}:\n  script: \n  returns: "true"`,
    },
    {
      key: "allowDynamicExtension",
      detail: "Allow AI to extend the workflow queue (boolean)",
      documentation:
        "When `true`, allows the AI to append new prompts to the workflow queue via MCP.",
      insertSnippet: "allowDynamicExtension: true",
    },
  ];

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    // Only active for YAML workflow files
    if (
      document.languageId !== "yaml" &&
      document.languageId !== "yml" &&
      !document.fileName.endsWith(".flightpath.yaml") &&
      !document.fileName.endsWith(".flightpath.yml")
    ) {
      return undefined;
    }

    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);

    // Only provide completions when typing a property key.
    // A property key position looks like: "  keyName" (no colon yet, or cursor is before the colon)
    // Pattern: optional whitespace + optional list dash + whitespace + key characters
    // We avoid positions that are inside a value (i.e., after "key: ")
    if (!this.isAtPropertyKeyPosition(line, position.character)) {
      return undefined;
    }

    // Check if we're inside a steps list item block
    const blockInfo = this.findPromptStepBlock(document, position.line);
    if (!blockInfo.isInsidePromptStep) {
      return undefined;
    }

    // Check for type: value completion (user is typing the value after "type: ")
    const typeValueMatch = textBeforeCursor.match(
      /^\s*(?:-\s+)?type:\s+(['"]?)(\w*)$/
    );
    if (typeValueMatch) {
      return this.getTypeValueCompletions();
    }

    // Determine partial key typed so far (for filtering)
    const keyMatch = textBeforeCursor.match(/^\s*(?:-\s+)?(\w*)$/);
    const partialKey = keyMatch ? keyMatch[1] : "";

    // Detect if this item block has type: script
    const isScriptStep = blockInfo.hasTypeScript;

    return this.getPropertyKeyCompletions(partialKey, isScriptStep, position);
  }

  /**
   * Check if the cursor is positioned where a YAML property key would appear.
   * True when the text before cursor is only: whitespace, an optional `- `, and
   * optionally a partial identifier (no colon + space, which would indicate we're
   * in a value position).
   */
  private isAtPropertyKeyPosition(line: string, charIndex: number): boolean {
    const textBefore = line.substring(0, charIndex);

    // Position after "type: " for value completions (handled separately, still key-area)
    if (/^\s*(?:-\s+)?type:\s+\S*$/.test(textBefore)) {
      return true;
    }

    // Standard property key position: whitespace + optional dash + partial word (no colon)
    // This matches lines like "  ", "  har", "  - har", etc.
    // Does NOT match "  harness: cop" (already has ": " — inside value)
    if (/^\s*(?:-\s+)?\w*$/.test(textBefore)) {
      return true;
    }

    return false;
  }

  /**
   * Searches the document backwards and forwards from the given line to
   * determine whether the cursor is inside a `steps:` list item block, and
   * whether that item already contains `type: script`.
   */
  private findPromptStepBlock(
    document: vscode.TextDocument,
    currentLine: number
  ): { isInsidePromptStep: boolean; hasTypeScript: boolean } {
    const NOT_INSIDE = { isInsidePromptStep: false, hasTypeScript: false };

    // Find the start of the current list item by searching backwards for a
    // list-item marker (`- `) that is at the prompt-list indentation level.
    let itemStartLine = -1;
    let itemIndent = -1;

    for (let i = currentLine; i >= Math.max(0, currentLine - 100); i--) {
      const text = document.lineAt(i).text;

      // A list item marker at some indentation
      const dashMatch = text.match(/^(\s*)-\s/);
      if (dashMatch) {
        itemStartLine = i;
        itemIndent = dashMatch[1].length;
        break;
      }

      // If we hit a YAML key at column 0 that is a parent key (not indented),
      // we've left the steps list area entirely.
      if (/^\w/.test(text) && text.includes(":")) {
        return NOT_INSIDE;
      }
    }

    if (itemStartLine === -1) {
      return NOT_INSIDE;
    }

    // Verify that this list item is under a `steps:` key by searching further back
    let underPromptsKey = false;
    for (let i = itemStartLine - 1; i >= Math.max(0, itemStartLine - 50); i--) {
      const text = document.lineAt(i).text;
      if (/^\s*steps\s*:/.test(text)) {
        underPromptsKey = true;
        break;
      }
      // Stop if we hit another top-level key (col 0 non-list key)
      if (/^\w/.test(text) && text.includes(":")) {
        break;
      }
    }

    if (!underPromptsKey) {
      return NOT_INSIDE;
    }

    // Scan the item block (from itemStartLine onwards until we hit a same-level
    // or lower-indent list item, or end of document) looking for `type: script`
    let hasTypeScript = false;
    const itemBodyIndent = itemIndent + 2; // Expected key indentation inside item

    for (
      let i = itemStartLine;
      i < Math.min(document.lineCount, itemStartLine + 100);
      i++
    ) {
      if (i === itemStartLine) {
        // First line: check for `- type: script` inline form
        const inlineTypeMatch = document
          .lineAt(i)
          .text.match(/^(\s*)-\s+type:\s*(\S+)/);
        if (inlineTypeMatch) {
          hasTypeScript =
            inlineTypeMatch[2].replace(/['"]/g, "") === STEP_TYPES.SCRIPT;
        }
        continue;
      }

      const lineText = document.lineAt(i).text;

      // Blank line: stay in block
      if (lineText.trim() === "") continue;

      const lineIndent = lineText.search(/\S/);

      // A new list item at same level — we've left this block
      if (lineIndent <= itemIndent && lineText.match(/^\s*-\s/)) {
        break;
      }

      // A key at lower indentation — left the block
      if (lineIndent < itemBodyIndent && lineText.match(/^\s*\w+\s*:/)) {
        break;
      }

      // Check for `type: script`
      const typeMatch = lineText.match(/^\s*type:\s*(['"]?)(\w+)\1/);
      if (typeMatch) {
        hasTypeScript = typeMatch[2] === STEP_TYPES.SCRIPT;
      }
    }

    return { isInsidePromptStep: true, hasTypeScript };
  }

  /**
   * Returns completions for the value of the `type:` property.
   */
  private getTypeValueCompletions(): vscode.CompletionList {
    const items: vscode.CompletionItem[] = [];

    const promptTypeItem = new vscode.CompletionItem(
      STEP_TYPES.PROMPT,
      vscode.CompletionItemKind.EnumMember
    );
    promptTypeItem.detail = "AI prompt step (default)";
    promptTypeItem.documentation = new vscode.MarkdownString(
      "Standard AI prompt step. The workflow sends the prompt text to the configured AI assistant.\n\n" +
        "This is the default step type — omitting `type` is equivalent to `type: prompt`."
    );
    promptTypeItem.insertText = STEP_TYPES.PROMPT;
    promptTypeItem.sortText = `0_${STEP_TYPES.PROMPT}`;
    items.push(promptTypeItem);

    const scriptItem = new vscode.CompletionItem(
      STEP_TYPES.SCRIPT,
      vscode.CompletionItemKind.EnumMember
    );
    scriptItem.detail = "Shell script step (no AI interaction)";
    scriptItem.documentation = new vscode.MarkdownString(
      "Runs a shell command or script file with no AI interaction.\n\n" +
        "Required additional property: `script` (the command or path to execute).\n\n" +
        "Optional: `timeout` (ms), `continueOnFailure` (bool)."
    );
    scriptItem.insertText = STEP_TYPES.SCRIPT;
    scriptItem.sortText = `1_${STEP_TYPES.SCRIPT}`;
    items.push(scriptItem);

    return new vscode.CompletionList(items, false);
  }

  /**
   * Returns property key completions for a prompt item block.
   *
   * @param partialKey  The key text already typed (may be empty)
   * @param isScriptStep  Whether the current item has `type: script`
   * @param position  Cursor position
   */
  private getPropertyKeyCompletions(
    partialKey: string,
    isScriptStep: boolean,
    position: vscode.Position
  ): vscode.CompletionList {
    const items: vscode.CompletionItem[] = [];

    // Build the list of property definitions to offer
    const propertyDefs = isScriptStep
      ? [
          ...PromptPropertyCompletionProvider.COMMON_PROPERTIES,
          ...PromptPropertyCompletionProvider.SCRIPT_ONLY_PROPERTIES,
        ]
      : [
          ...PromptPropertyCompletionProvider.COMMON_PROPERTIES,
          ...PromptPropertyCompletionProvider.AI_PROMPT_PROPERTIES,
        ];

    // Calculate replacement range: from start of the partial key to cursor
    const keyStartCol = position.character - partialKey.length;
    const replaceRange = new vscode.Range(
      new vscode.Position(position.line, keyStartCol),
      position
    );

    const filter = partialKey.toLowerCase();

    for (const prop of propertyDefs) {
      if (filter && !prop.key.toLowerCase().startsWith(filter)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        prop.key,
        vscode.CompletionItemKind.Property
      );
      item.detail = prop.detail;
      item.documentation = new vscode.MarkdownString(prop.documentation);
      item.insertText = new vscode.SnippetString(
        prop.insertSnippet ?? `${prop.key}: `
      );
      item.range = replaceRange;
      item.sortText = prop.key;
      items.push(item);
    }

    return new vscode.CompletionList(items, false);
  }
}
