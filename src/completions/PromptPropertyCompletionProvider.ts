import * as vscode from "vscode";
import { isPositionInsideYamlBlockScalar } from "./YamlBlockScalarContext";
import * as fs from "fs";
import * as path from "path";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import {
  CTRLYOKE_FILE_KINDS,
  STEP_TYPES,
  PROMPT_PROPERTIES,
  PROMPT_FILE_LANGUAGE_IDS,
} from "../types/DashboardConstants";

type SchemaNode = Record<string, unknown>;

interface PropertyDefinition {
  key: string;
  detail: string;
  documentation: string;
  insertSnippet?: string;
}

type PropertyOverride = Partial<Omit<PropertyDefinition, "key">>;

const RUNTIME_PROPERTY = "_runtime";
const YAML_STEP_LIST_PARENT_KEYS = {
  STEPS: PROMPT_PROPERTIES.STEPS,
  PARALLEL: PROMPT_PROPERTIES.PARALLEL,
} as const;
type StepListParentKey =
  (typeof YAML_STEP_LIST_PARENT_KEYS)[keyof typeof YAML_STEP_LIST_PARENT_KEYS];

/** Human-focused completion details; the workflow schema owns the key set. */
const PROPERTY_OVERRIDES: Readonly<Record<string, PropertyOverride>> = {
  [PROMPT_PROPERTIES.STEP_TYPE]: {
    detail: `Step type: "${STEP_TYPES.PROMPT}" | "${STEP_TYPES.SCRIPT}"`,
    documentation:
      "Discriminates the step type. Omit for an AI prompt step (backwards compatible). " +
      `Set to \`"${STEP_TYPES.SCRIPT}"\` for a shell script step with no AI interaction.`,
    insertSnippet: `${PROMPT_PROPERTIES.STEP_TYPE}: `,
  },
  [PROMPT_PROPERTIES.NAME]: {
    detail: "Display label (optional)",
    documentation:
      "Human-readable label shown in the ctrlyoke dashboard. " +
      "If omitted, the dashboard shows a truncated preview of the prompt or script.",
    insertSnippet: `${PROMPT_PROPERTIES.NAME}: `,
  },
  [PROMPT_PROPERTIES.PROMPT]: {
    detail: "Prompt text or path to .prompt.md (required)",
    documentation:
      "The prompt to send to the AI assistant. Supports inline text (with `@file` and `#selection:` references) or a path to a `.prompt.md`, `.md`, or `.txt` file.",
    insertSnippet: `${PROMPT_PROPERTIES.PROMPT}: |\n  `,
  },
  [PROMPT_PROPERTIES.HARNESS]: {
    detail: "Harness override for this step",
    documentation:
      "Overrides the workflow-level harness for this step (e.g., `claude-cli`, `copilot-cli`).",
    insertSnippet: `${PROMPT_PROPERTIES.HARNESS}: `,
  },
  [PROMPT_PROPERTIES.MODEL]: {
    detail: "Model override for this step",
    documentation:
      "Overrides the workflow-level model for this step (e.g., `claude-sonnet-4.5`).",
    insertSnippet: `${PROMPT_PROPERTIES.MODEL}: `,
  },
  [PROMPT_PROPERTIES.AGENT]: {
    detail: "Path to .agent.md custom agent file",
    documentation:
      "Path to a custom agent definition (`.agent.md`) used for this step.",
    insertSnippet: `${PROMPT_PROPERTIES.AGENT}: `,
  },
  [PROMPT_PROPERTIES.SKILLS]: {
    detail: "Skills to attach to this step",
    documentation: "List of skill identifiers to make available to this step.",
    insertSnippet: `${PROMPT_PROPERTIES.SKILLS}:\n  - `,
  },
  [PROMPT_PROPERTIES.RESUME_SESSION]: {
    detail: "Continue conversation from previous step (boolean)",
    documentation:
      "When `true`, resumes the AI session from the previous step rather than starting a new conversation.",
    insertSnippet: `${PROMPT_PROPERTIES.RESUME_SESSION}: true`,
  },
  [PROMPT_PROPERTIES.SESSION_ID]: {
    detail: "Session ID or prior step index to resume",
    documentation:
      "Resume a specific AI session by GUID/thread ID, or reference a prior prompt by step number (e.g., `1`).",
    insertSnippet: `${PROMPT_PROPERTIES.SESSION_ID}: `,
  },
  [PROMPT_PROPERTIES.MCP_SERVERS]: {
    detail: "MCP servers to attach",
    documentation:
      'List of MCP server identifiers to attach for this step (e.g., `["ctrlyoke"]`).',
    insertSnippet: `${PROMPT_PROPERTIES.MCP_SERVERS}:\n  - `,
  },
  [PROMPT_PROPERTIES.HOOKS]: {
    detail: "Pre/post execution hooks",
    documentation: "User-defined hooks executed before and after this step.",
    insertSnippet: `${PROMPT_PROPERTIES.HOOKS}:\n  `,
  },
  [PROMPT_PROPERTIES.END_CONDITION]: {
    detail: "Validation script run after AI response",
    documentation:
      "End condition evaluated after the AI responds. If the condition passes, `onPass: retry` re-runs the step with `passRetryPrompt` (or the step's own prompt); if it fails, the step retries with `retryPrompt`. `onPass` supports `continue | retry | stopWorkflow`; `onFail` supports `continue | retry | stopWorkflow`.",
    insertSnippet: `${PROMPT_PROPERTIES.END_CONDITION}:\n  script: `,
  },
  [PROMPT_PROPERTIES.PRE_CONDITION]: {
    detail: "Script gate evaluated before the AI prompt runs",
    documentation:
      "Pre-condition script that gates whether the prompt runs. `onPass` (default: continue) and `onFail` (default: skipPrompt) control the outcome. Actions: continue | skipPrompt | stopWorkflow.",
    insertSnippet: `${PROMPT_PROPERTIES.PRE_CONDITION}:\n  script: \n  onFail: skipPrompt`,
  },
  [PROMPT_PROPERTIES.ERROR_BEHAVIOR]: {
    detail: "Harness/session failure policy",
    documentation:
      "Controls what happens when the harness itself fails. `onError` supports `stopWorkflow`, `retry`, or `continue`. `maxRetries` and `retryDelaySec` apply when retry is selected.",
    insertSnippet: `${PROMPT_PROPERTIES.ERROR_BEHAVIOR}:\n  onError: stopWorkflow`,
  },
  [PROMPT_PROPERTIES.SCRIPT]: {
    detail: "Shell command or script path (required)",
    documentation:
      "Shell command or path to script file to execute. Resolved relative to workspace root or `.ctrlyoke/`.",
    insertSnippet: `${PROMPT_PROPERTIES.SCRIPT}: `,
  },
  [PROMPT_PROPERTIES.TIMEOUT]: {
    detail: "Timeout in seconds",
    documentation:
      "Timeout in seconds. Defaults to the `execution.scriptTimeoutSec` setting.",
    insertSnippet: `${PROMPT_PROPERTIES.TIMEOUT}: `,
  },
  [PROMPT_PROPERTIES.COMPARE_SOURCE]: {
    detail: "Which output the comparison reads",
    documentation:
      "Which output is compared against `expected`. `exitCode` (default): the numeric exit code. `stdout`/`stderr`: the trimmed text. A text comparison does not also require a clean exit.",
    insertSnippet: `${PROMPT_PROPERTIES.COMPARE_SOURCE}: `,
  },
  [PROMPT_PROPERTIES.OPERATOR]: {
    detail: "How the comparison is made",
    documentation:
      "How the compare source is compared against `expected`. `eq` (default) / `ne`, `contains` / `notContains`, `gte` / `gt` / `lte` / `lt` (numeric — both sides must be numbers), `matches` (unanchored regex), `isEmpty` / `isNotEmpty` (no value needed). Word tokens only: `>=` is a YAML parse error and `!=` silently parses as a YAML tag.",
    insertSnippet: `${PROMPT_PROPERTIES.OPERATOR}: `,
  },
  [PROMPT_PROPERTIES.EXPECTED]: {
    detail: "Value the compare source is checked against",
    documentation:
      "Value the compare source is compared against, as a string or number. Omit it entirely to pass when the script exits 0 — there is no boolean form, and `true`/`false` are not exit-code values.",
    insertSnippet: `${PROMPT_PROPERTIES.EXPECTED}: `,
  },
  [PROMPT_PROPERTIES.IGNORE_CASE]: {
    detail: "Compare text case-insensitively",
    documentation:
      "Compare text without regard to case. Applies only to the string operators (`eq`, `ne`, `contains`, `notContains`). Default: false.",
    insertSnippet: `${PROMPT_PROPERTIES.IGNORE_CASE}: `,
  },
  [PROMPT_PROPERTIES.ON_PASS]: {
    detail: "Action on script pass: continue | stopWorkflow",
    documentation:
      "What to do when the script passes. `continue`: advance the queue (default). `stopWorkflow`: halt execution.",
    insertSnippet: `${PROMPT_PROPERTIES.ON_PASS}: `,
  },
  [PROMPT_PROPERTIES.ON_FAIL]: {
    detail: "Action on script fail: continue | stopWorkflow",
    documentation:
      "What to do when the script fails. `stopWorkflow`: halt execution (default). `continue`: log a warning and advance the queue.",
    insertSnippet: `${PROMPT_PROPERTIES.ON_FAIL}: `,
  },
};

function resolveSchemaReference(
  schema: SchemaNode,
  reference: string
): SchemaNode | undefined {
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((node, part) => {
      if (typeof node !== "object" || node === null) return undefined;
      return (node as Record<string, unknown>)[part];
    }, schema) as SchemaNode | undefined;
}

function resolveSchemaNode(schema: SchemaNode, node: SchemaNode): SchemaNode {
  const reference = node.$ref;
  if (typeof reference !== "string") return node;
  return resolveSchemaReference(schema, reference) ?? node;
}

function collectSchemaProperties(
  schema: SchemaNode,
  node: SchemaNode,
  properties = new Map<string, SchemaNode>()
): Map<string, SchemaNode> {
  const resolved = resolveSchemaNode(schema, node);
  const nodeProperties = resolved.properties;
  if (typeof nodeProperties === "object" && nodeProperties !== null) {
    for (const [key, property] of Object.entries(nodeProperties)) {
      if (
        key === RUNTIME_PROPERTY ||
        typeof property !== "object" ||
        property === null
      ) {
        continue;
      }
      properties.set(key, property as SchemaNode);
    }
  }

  const allOf = resolved.allOf;
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (typeof branch === "object" && branch !== null) {
        collectSchemaProperties(schema, branch as SchemaNode, properties);
      }
    }
  }
  return properties;
}

function readWorkflowSchema(): SchemaNode {
  const schemaPaths = [
    path.join(__dirname, "schemas", "workflow-schema.json"),
    path.join(__dirname, "..", "schemas", "workflow-schema.json"),
  ];
  const schemaPath = schemaPaths.find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error(
      `workflow-schema.json not found in any of: ${schemaPaths.join(", ")}`
    );
  }
  return JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SchemaNode;
}

const WORKFLOW_SCHEMA = readWorkflowSchema();

function getStepPropertyDefinitions(
  definitionName: "promptStep" | "scriptStep"
): PropertyDefinition[] {
  const definitions = WORKFLOW_SCHEMA.$defs as Record<string, SchemaNode>;
  const definition = definitions[definitionName];
  const properties = collectSchemaProperties(WORKFLOW_SCHEMA, definition);

  return [...properties].map(([key, schemaNode]) => {
    const override = PROPERTY_OVERRIDES[key] ?? {};
    const resolvedProperty = resolveSchemaNode(WORKFLOW_SCHEMA, schemaNode);
    const documentation =
      override.documentation ??
      (typeof resolvedProperty.description === "string"
        ? resolvedProperty.description
        : `Workflow property \`${key}\`.`);
    return {
      key,
      detail: override.detail ?? "Workflow step property",
      documentation,
      insertSnippet: override.insertSnippet,
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

    // The schema owns the allowed keys; overrides only add completion polish.
    const propertyDefs = getStepPropertyDefinitions(
      isScriptStep ? "scriptStep" : "promptStep"
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
