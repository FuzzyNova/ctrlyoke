import React from "react";
import type { ReactNode } from "react";
import type { Element, Properties, RootContent } from "hast";
import { refractor as refractorCore } from "refractor/core";
import refractorBash from "refractor/bash";
import refractorC from "refractor/c";
import refractorCpp from "refractor/cpp";
import refractorCsharp from "refractor/csharp";
import refractorCss from "refractor/css";
import refractorGo from "refractor/go";
import refractorJava from "refractor/java";
import refractorJavascript from "refractor/javascript";
import refractorJson from "refractor/json";
import refractorJsx from "refractor/jsx";
import refractorKotlin from "refractor/kotlin";
import refractorMarkdown from "refractor/markdown";
import refractorMarkup from "refractor/markup";
import refractorPhp from "refractor/php";
import refractorPython from "refractor/python";
import refractorRuby from "refractor/ruby";
import refractorRust from "refractor/rust";
import refractorScss from "refractor/scss";
import refractorSwift from "refractor/swift";
import refractorToml from "refractor/toml";
import refractorTsx from "refractor/tsx";
import refractorTypescript from "refractor/typescript";
import refractorYaml from "refractor/yaml";

const REGISTERED_SYNTAXES = [
  refractorTypescript,
  refractorTsx,
  refractorJavascript,
  refractorJsx,
  refractorPython,
  refractorBash,
  refractorJson,
  refractorYaml,
  refractorCss,
  refractorScss,
  refractorMarkup,
  refractorMarkdown,
  refractorRust,
  refractorGo,
  refractorJava,
  refractorCsharp,
  refractorC,
  refractorCpp,
  refractorKotlin,
  refractorPhp,
  refractorRuby,
  refractorSwift,
  refractorToml,
];

for (const syntax of REGISTERED_SYNTAXES) {
  refractorCore.register(syntax);
}

refractorCore.alias({
  bash: ["sh", "shell", "zsh"],
  csharp: "cs",
  cpp: ["cc", "cxx", "h", "hpp"],
  javascript: ["js", "mjs", "cjs"],
  kotlin: "kt",
  markdown: "md",
  markup: ["html", "htm", "xml", "svg", "vue", "svelte"],
  php: "php",
  python: "py",
  ruby: "rb",
  rust: "rs",
  typescript: ["ts", "mts", "cts"],
  yaml: "yml",
});

const LANGUAGE_ALIAS_MAP: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  css: "css",
  cts: "typescript",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kotlin: "kotlin",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  python: "python",
  rb: "ruby",
  rs: "rust",
  ruby: "ruby",
  rust: "rust",
  scss: "scss",
  sh: "bash",
  shell: "bash",
  svelte: "markup",
  svg: "markup",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  vue: "markup",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  svelte: "markup",
  svg: "markup",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "markup",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

const SYNTAX_TOKEN_STYLES = `
/* FlightPath - VS Code themed refractor tokens */
.fp-syntax {
  color: var(--vscode-editor-foreground, #d4d4d4);
}

.fp-syntax .token,
.diff .token {
  color: inherit;
}

.fp-syntax .token.keyword,
.fp-syntax .token.atrule,
.diff .token.keyword,
.diff .token.atrule {
  color: var(--vscode-symbolIcon-functionForeground, #569cd6);
}

.fp-syntax .token.string,
.fp-syntax .token.char,
.fp-syntax .token.attr-value,
.diff .token.string,
.diff .token.char,
.diff .token.attr-value {
  color: var(--vscode-debugTokenExpression-string, #ce9178);
}

.fp-syntax .token.number,
.diff .token.number {
  color: var(--vscode-debugTokenExpression-number, #b5cea8);
}

.fp-syntax .token.comment,
.fp-syntax .token.prolog,
.fp-syntax .token.doctype,
.fp-syntax .token.cdata,
.diff .token.comment,
.diff .token.prolog,
.diff .token.doctype,
.diff .token.cdata {
  color: var(--vscode-charts-green, #6a9955);
  font-style: italic;
}

.fp-syntax .token.function,
.diff .token.function {
  color: var(--vscode-debugTokenExpression-string, #dcdcaa);
}

.fp-syntax .token.class-name,
.fp-syntax .token.maybe-class-name,
.diff .token.class-name,
.diff .token.maybe-class-name {
  color: var(--vscode-chat-editedFileForeground, #4ec9b0);
}

.fp-syntax .token.variable,
.fp-syntax .token.parameter,
.fp-syntax .token.property,
.fp-syntax .token.attr-name,
.diff .token.variable,
.diff .token.parameter,
.diff .token.property,
.diff .token.attr-name {
  color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
}

.fp-syntax .token.builtin,
.fp-syntax .token.constant,
.fp-syntax .token.namespace,
.diff .token.builtin,
.diff .token.constant,
.diff .token.namespace {
  color: var(--vscode-scmGraph-foreground4, #4ec9b0);
}

.fp-syntax .token.boolean,
.fp-syntax .token.null,
.fp-syntax .token.symbol,
.diff .token.boolean,
.diff .token.null,
.diff .token.symbol {
  color: var(--vscode-debugTokenExpression-boolean, #4e94ce);
}

.fp-syntax .token.regex,
.diff .token.regex {
  color: var(--vscode-charts-red, #d16969);
}

.fp-syntax .token.annotation,
.fp-syntax .token.decorator,
.fp-syntax .token.important,
.diff .token.annotation,
.diff .token.decorator,
.diff .token.important {
  color: var(--vscode-editorCodeLens-foreground, #c9b299);
}

.fp-syntax .token.tag,
.diff .token.tag {
  color: var(--vscode-symbolIcon-constructorForeground, #4ec9b0);
}

.fp-syntax .token.selector,
.fp-syntax .token.selector-class,
.fp-syntax .token.selector-id,
.fp-syntax .token.selector-pseudo-class,
.fp-syntax .token.selector-pseudo-element,
.diff .token.selector,
.diff .token.selector-class,
.diff .token.selector-id,
.diff .token.selector-pseudo-class,
.diff .token.selector-pseudo-element {
  color: var(--vscode-chat-editedFileForeground, #d7ba7d);
}

.fp-syntax .token.entity,
.fp-syntax .token.url,
.diff .token.entity,
.diff .token.url {
  color: var(--vscode-textLink-foreground, #4e94ce);
}
`;

const FIND_HIGHLIGHT_STYLES = `
.markdown-text mark {
  background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.markdown-text mark[data-find-active="true"] {
  background-color: var(--vscode-editor-findMatchBackground, rgba(246, 185, 77, 0.7));
  outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder, #007fd4));
}
`;

function injectStyle(id: string, cssText: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = cssText;
  document.head.appendChild(style);
}

export function injectSyntaxHighlightStyles(): void {
  injectStyle("fp-syntax-theme", SYNTAX_TOKEN_STYLES);
}

export function injectFindHighlightStyles(): void {
  injectStyle("fp-find-highlight", FIND_HIGHLIGHT_STYLES);
}

export function normalizeSyntaxLanguage(
  language: string | undefined
): string | undefined {
  const normalized = language
    ?.trim()
    .toLowerCase()
    .replace(/^language-/, "");
  if (!normalized) return undefined;

  const canonical = LANGUAGE_ALIAS_MAP[normalized] ?? normalized;
  return refractorCore.registered(canonical) ? canonical : undefined;
}

export function getLanguageFromPath(filePath: string): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const fileName = normalizedPath.split("/").pop();
  const extension = fileName?.split(".").pop();
  return extension ? EXTENSION_LANGUAGE_MAP[extension] : undefined;
}

function toReactProps(
  properties: Properties | undefined
): Record<string, unknown> {
  const reactProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value === undefined || value === null) continue;
    reactProps[key] = Array.isArray(value) ? value.join(" ") : value;
  }

  return reactProps;
}

function renderSyntaxNode(node: RootContent, key: string): ReactNode {
  if (node.type === "text") {
    return node.value;
  }

  if (node.type !== "element") {
    return null;
  }

  const element = node as Element;
  return React.createElement(
    element.tagName,
    { key, ...toReactProps(element.properties) },
    renderSyntaxNodes(element.children, key)
  );
}

function renderSyntaxNodes(
  nodes: ReadonlyArray<RootContent>,
  keyPrefix: string
): ReactNode[] {
  return nodes.map((node, index) =>
    renderSyntaxNode(node, `${keyPrefix}-${index}`)
  );
}

export function renderHighlightedCode(
  code: string,
  language: string | undefined
): ReactNode {
  const normalized = normalizeSyntaxLanguage(language);
  if (!normalized) return code;

  try {
    const tree = refractorCore.highlight(code, normalized);
    return renderSyntaxNodes(tree.children, normalized);
  } catch {
    return code;
  }
}

export const refractor = {
  highlight(value: string, language: string) {
    return refractorCore.highlight(value, language).children;
  },
  registered(aliasOrLanguage: string) {
    return refractorCore.registered(aliasOrLanguage);
  },
};
