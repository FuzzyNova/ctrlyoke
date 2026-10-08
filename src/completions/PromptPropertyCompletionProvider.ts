import * as vscode from "vscode";
import { isPositionInsideYamlBlockScalar } from "./YamlBlockScalarContext";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import { getWorkflowPropertySnippet } from "./WorkflowPropertySnippets";
import {
  CTRLYOKE_FILE_KINDS,
  STEP_TYPES,
  PROMPT_PROPERTIES,
  PROMPT_FILE_LANGUAGE_IDS,
  WORKFLOW_OBJECT_KINDS,
} from "../types/DashboardConstants";
import { WORKFLOW_SCHEMA_OUTLINE } from "../types/generated/WorkflowSchemaOutline";

interface PropertyDefinition {
  key: string;
  detail: string;
  documentation: string;
  insertSnippet?: string;
}

const YAML_STEP_LIST_PARENT_KEYS = {
  STEPS: PROMPT_PROPERTIES.STEPS,
  PARALLEL: PROMPT_PROPERTIES.PARALLEL,
} as const;
type StepListParentKey =
  (typeof YAML_STEP_LIST_PARENT_KEYS)[keyof typeof YAML_STEP_LIST_PARENT_KEYS];

type StepObjectKind =
  | typeof WORKFLOW_OBJECT_KINDS.PROMPT_STEP
  | typeof WORKFLOW_OBJECT_KINDS.SCRIPT_STEP;

/** The outline owns the allowed keys; snippets only add completion polish. */
function getStepPropertyDefinitions(
  objectKind: StepObjectKind
): PropertyDefinition[] {
  const outline = WORKFLOW_SCHEMA_OUTLINE[objectKind];
  if (!outline) return [];
  return Object.entries(outline.properties).map(([key, property]) => {
    const snippet = getWorkflowPropertySnippet(objectKind, key);
    return {
      key,
      detail:
        snippet.detail ??
        property.enum?.join(" | ") ??
        "Workflow step property",
      documentation:
        snippet.documentation ??
        property.description ??
        `Workflow property \`${key}\`.`,
      insertSnippet: snippet.insertSnippet,
    };
  });
}

/**
 * Provides YAML property key completions for ctrlyoke workflow files.
 *
 * When editing a prompt item block in a .ctrlyoke.yaml file, this provider
 * offers context-aware property key suggestions:
 *
 * - Default (AI prompt step): offers the prompt-step properties allowed by the schema
 * - Script step (type: script): offers the script-step properties allowed by the schema
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
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    // Only active for YAML workflow files
    if (
      document.languageId !== PROMPT_FILE_LANGUAGE_IDS.YAML &&
      document.languageId !== PROMPT_FILE_LANGUAGE_IDS.YML &&
      getCtrlYokeFileKind(document.fileName) !==
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
    ) {
      return undefined;
    }

    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);

    if (
      isPositionInsideYamlBlockScalar(
        (lineNumber) => document.lineAt(lineNumber).text,
        position.line,
        position.character
      )
    ) {
      return undefined;
    }

    // Only provide completions when typing a property key.
    // A property key position looks like: "  keyName" (no colon yet, or cursor is before the colon)
    // Pattern: optional whitespace + optional list dash + whitespace + key characters
    // We avoid positions that are inside a value (i.e., after "key: ")
    if (!this.isAtPropertyKeyPosition(line, position.character)) {
      return undefined;
    }

    // Check if we're inside a steps list item block
    const blockInfo = this.findPromptStepBlock(
      document,
      position.line,
      line.match(/^\s*/)?.[0].length ?? 0,
      /^\s*-\s/.test(textBeforeCursor)
    );
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
    currentLine: number,
    cursorIndent: number,
    cursorHasListDash: boolean
  ): { isInsidePromptStep: boolean; hasTypeScript: boolean } {
    const NOT_INSIDE = { isInsidePromptStep: false, hasTypeScript: false };

    // Find the list item whose body indentation matches the logical key
    // indentation (the key in `- key:` starts two columns after the dash).
    let itemStartLine = -1;
    let itemIndent = -1;
    const logicalCursorIndent = cursorIndent + (cursorHasListDash ? 2 : 0);

    for (let i = currentLine; i >= Math.max(0, currentLine - 100); i--) {
      const text = document.lineAt(i).text;
      const dashMatch = text.match(/^(\s*)-\s/);
      if (dashMatch) {
        const candidateIndent = dashMatch[1].length;
        if (candidateIndent + 2 === logicalCursorIndent) {
          itemStartLine = i;
          itemIndent = candidateIndent;
          break;
        }
      } else if (text.trim() !== "" && !/^\s*#/.test(text)) {
        const lineIndent = text.search(/\S/);
        if (lineIndent < logicalCursorIndent) return NOT_INSIDE;
      }
    }

    if (itemStartLine === -1) {
      return NOT_INSIDE;
    }

    const parentKey = this.findListParentKey(
      document,
      itemStartLine,
      itemIndent
    );
    if (
      parentKey !== YAML_STEP_LIST_PARENT_KEYS.STEPS &&
      (parentKey !== YAML_STEP_LIST_PARENT_KEYS.PARALLEL ||
        !this.isParallelGroupInsideSteps(document, itemStartLine, itemIndent))
    ) {
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

  private findListParentKey(
    document: vscode.TextDocument,
    itemStartLine: number,
    itemIndent: number
  ): StepListParentKey | undefined {
    const parentIndent = itemIndent - 2;
    if (parentIndent < 0) return undefined;

    for (let line = itemStartLine - 1; line >= 0; line--) {
      const text = document.lineAt(line).text;
      if (text.trim() === "" || /^\s*#/.test(text)) continue;
      const indent = text.search(/\S/);
      const keyIndent = indent + (/^\s*-\s+/.test(text) ? 2 : 0);
      if (keyIndent < parentIndent) return undefined;
      if (keyIndent !== parentIndent) continue;
      const parentKeyPattern = new RegExp(
        `^(?:\\s*-\\s+)?(${Object.values(YAML_STEP_LIST_PARENT_KEYS).join("|")})\\s*:`
      );
      const keyMatch = parentKeyPattern.exec(text);
      return keyMatch?.[1] as StepListParentKey | undefined;
    }
    return undefined;
  }

  private isParallelGroupInsideSteps(
    document: vscode.TextDocument,
    itemStartLine: number,
    itemIndent: number
  ): boolean {
    const parallelLine = itemStartLine - 1;
    for (
      let line = parallelLine;
      line >= Math.max(0, parallelLine - 100);
      line--
    ) {
      const text = document.lineAt(line).text;
      const dashMatch = text.match(/^(\s*)-\s/);
      if (!dashMatch) continue;
      const ownerIndent = dashMatch[1].length;
      if (ownerIndent >= itemIndent) continue;
      if (
        this.findListParentKey(document, line, ownerIndent) ===
        YAML_STEP_LIST_PARENT_KEYS.STEPS
      ) {
        return true;
      }
      return false;
    }
    return false;
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
        "Optional: `timeoutSec` (seconds), `compareSource`/`operator`/`expected`, `onPass`, `onFail`."
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

    // The outline owns the allowed keys; snippets only add completion polish.
    const propertyDefs = getStepPropertyDefinitions(
      isScriptStep
        ? WORKFLOW_OBJECT_KINDS.SCRIPT_STEP
        : WORKFLOW_OBJECT_KINDS.PROMPT_STEP
    );

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
