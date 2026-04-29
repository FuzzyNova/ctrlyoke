import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { getLanguageFromPath } from "../utils/syntaxHighlighting";

/** Maps a file path to the appropriate CodeMirror LanguageSupport extension. Returns null for plain text. */
export function getLanguageExtension(filePath: string) {
  const lang = getLanguageFromPath(filePath);
  switch (lang) {
    case "javascript":
      return javascript({ jsx: false });
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "python":
      return python();
    case "rust":
      return rust();
    case "json":
      return json();
    case "markup":
      return html();
    case "css":
    case "scss":
      return css();
    case "yaml":
      return yaml();
    case "markdown":
      return markdown();
    case "java":
      return java();
    case "cpp":
    case "c":
      return cpp();
    case "php":
      return php();
    default:
      return null;
  }
}

/** HighlightStyle using VS Code CSS variables, matching the colours in SYNTAX_TOKEN_STYLES. */
export function createWorkspaceEditorHighlightExtension() {
  const style = HighlightStyle.define([
    {
      tag: [tags.keyword, tags.definitionKeyword, tags.modifier],
      color: "var(--vscode-symbolIcon-functionForeground, #569cd6)",
    },
    {
      tag: [tags.string, tags.character, tags.attributeValue],
      color: "var(--vscode-debugTokenExpression-string, #ce9178)",
    },
    {
      tag: tags.number,
      color: "var(--vscode-debugTokenExpression-number, #b5cea8)",
    },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: "var(--vscode-charts-green, #6a9955)",
      fontStyle: "italic",
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.name)],
      color: "#dcdcaa",
    },
    {
      tag: [tags.className, tags.typeName, tags.namespace],
      color: "var(--vscode-chat-editedFileForeground, #4ec9b0)",
    },
    {
      tag: [
        tags.variableName,
        tags.propertyName,
        tags.attributeName,
        tags.local(tags.variableName),
        tags.definition(tags.variableName),
      ],
      color: "var(--vscode-symbolIcon-variableForeground, #9cdcfe)",
    },
    {
      tag: [tags.bool, tags.null],
      color: "var(--vscode-debugTokenExpression-boolean, #4e94ce)",
    },
    {
      tag: tags.regexp,
      color: "var(--vscode-charts-red, #d16969)",
    },
    {
      tag: tags.tagName,
      color: "var(--vscode-symbolIcon-constructorForeground, #4ec9b0)",
    },
    {
      tag: tags.url,
      color: "var(--vscode-textLink-foreground, #4e94ce)",
    },
  ]);
  return syntaxHighlighting(style);
}
