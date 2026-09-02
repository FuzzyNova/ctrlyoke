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
import { CODEMIRROR_LANGUAGE_IDS } from "@root/types/DashboardConstants";

/** Maps a file path to the appropriate CodeMirror LanguageSupport extension. Returns null for plain text. */
export function getLanguageExtension(filePath: string) {
  const lang = getLanguageFromPath(filePath);
  switch (lang) {
    case CODEMIRROR_LANGUAGE_IDS.JAVASCRIPT:
      return javascript({ jsx: false });
    case CODEMIRROR_LANGUAGE_IDS.JSX:
      return javascript({ jsx: true });
    case CODEMIRROR_LANGUAGE_IDS.TYPESCRIPT:
      return javascript({ typescript: true });
    case CODEMIRROR_LANGUAGE_IDS.TSX:
      return javascript({ typescript: true, jsx: true });
    case CODEMIRROR_LANGUAGE_IDS.PYTHON:
      return python();
    case CODEMIRROR_LANGUAGE_IDS.RUST:
      return rust();
    case CODEMIRROR_LANGUAGE_IDS.JSON:
      return json();
    case CODEMIRROR_LANGUAGE_IDS.MARKUP:
      return html();
    case CODEMIRROR_LANGUAGE_IDS.CSS:
    case CODEMIRROR_LANGUAGE_IDS.SCSS:
      return css();
    case CODEMIRROR_LANGUAGE_IDS.YAML:
      return yaml();
    case CODEMIRROR_LANGUAGE_IDS.MARKDOWN:
      return markdown();
    case CODEMIRROR_LANGUAGE_IDS.JAVA:
      return java();
    case CODEMIRROR_LANGUAGE_IDS.CPP:
    case CODEMIRROR_LANGUAGE_IDS.C:
      return cpp();
    case CODEMIRROR_LANGUAGE_IDS.PHP:
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
