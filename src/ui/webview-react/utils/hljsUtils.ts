/**
 * Shared highlight.js utilities for the FlightPath webview.
 *
 * Single source of truth for:
 *  - Registering all languages (import core only, no bundled themes)
 *  - VS Code Dark+ themed CSS injected once into document.head
 *  - Helpers used by MarkdownText and DiffView
 */
import hljs from "highlight.js/lib/core";
import hljsTS from "highlight.js/lib/languages/typescript";
import hljsJS from "highlight.js/lib/languages/javascript";
import hljsPython from "highlight.js/lib/languages/python";
import hljsBash from "highlight.js/lib/languages/bash";
import hljsJson from "highlight.js/lib/languages/json";
import hljsYaml from "highlight.js/lib/languages/yaml";
import hljsCss from "highlight.js/lib/languages/css";
import hljsXml from "highlight.js/lib/languages/xml";
import hljsMarkdown from "highlight.js/lib/languages/markdown";
import hljsRust from "highlight.js/lib/languages/rust";
import hljsGo from "highlight.js/lib/languages/go";
import hljsJava from "highlight.js/lib/languages/java";
import hljsCSharp from "highlight.js/lib/languages/csharp";
import hljsCpp from "highlight.js/lib/languages/cpp";

// ── Language registration ─────────────────────────────────────────────────

hljs.registerLanguage("typescript", hljsTS);
hljs.registerLanguage("tsx", hljsTS);
hljs.registerLanguage("javascript", hljsJS);
hljs.registerLanguage("jsx", hljsJS);
hljs.registerLanguage("mjs", hljsJS);
hljs.registerLanguage("cjs", hljsJS);
hljs.registerLanguage("python", hljsPython);
hljs.registerLanguage("py", hljsPython);
hljs.registerLanguage("bash", hljsBash);
hljs.registerLanguage("sh", hljsBash);
hljs.registerLanguage("shell", hljsBash);
hljs.registerLanguage("json", hljsJson);
hljs.registerLanguage("yaml", hljsYaml);
hljs.registerLanguage("yml", hljsYaml);
hljs.registerLanguage("css", hljsCss);
hljs.registerLanguage("scss", hljsCss);
hljs.registerLanguage("html", hljsXml);
hljs.registerLanguage("xml", hljsXml);
hljs.registerLanguage("svg", hljsXml);
hljs.registerLanguage("markdown", hljsMarkdown);
hljs.registerLanguage("md", hljsMarkdown);
hljs.registerLanguage("rust", hljsRust);
hljs.registerLanguage("rs", hljsRust);
hljs.registerLanguage("go", hljsGo);
hljs.registerLanguage("java", hljsJava);
hljs.registerLanguage("csharp", hljsCSharp);
hljs.registerLanguage("cs", hljsCSharp);
hljs.registerLanguage("cpp", hljsCpp);
hljs.registerLanguage("c", hljsCpp);
hljs.registerLanguage("h", hljsCpp);

export { hljs };

// ── VS Code Dark+ themed CSS ──────────────────────────────────────────────

/**
 * Token colour rules for highlight.js classes mapped to VS Code CSS vars.
 * Every token uses a semantic VS Code CSS variable with a Dark+ fallback.
 *
 * Variable choices:
 *   keywords        → debugView-valueChangedHighlight  (blue keyword tint)
 *   strings         → debugTokenExpression-string      (orange string tint)
 *   numbers         → debugTokenExpression-number      (green number tint)
 *   comments        → charts-green                     (muted green)
 *   function names  → symbolIcon-functionForeground    (yellow function icon)
 *   class names     → symbolIcon-classForeground       (teal class icon)
 *   variables       → symbolIcon-variableForeground    (light-blue variable icon)
 *   built-ins       → symbolIcon-interfaceForeground   (teal interface icon)
 *   booleans        → debugTokenExpression-boolean     (blue boolean tint)
 *   regexp          → charts-red                       (red chart token)
 *   meta/decorators → editorCodeLens-foreground        (muted annotation grey)
 *   HTML tag names  → symbolIcon-classForeground       (teal, same as class)
 *   CSS selectors   → chat-editedFileForeground        (warm amber)
 *   doc tags        → charts-green                     (green, same as comments)
 *   headings        → symbolIcon-classForeground       (themed heading colour)
 *   links           → textLink-foreground              (standard link blue)
 */
export const HLJS_STYLES = `
/* FlightPath – VS Code Dark+ themed highlight.js */
.hljs { color: var(--vscode-editor-foreground, #d4d4d4); }

/* Keywords, control flow */
.hljs-keyword,
.hljs-selector-tag { color: var(--vscode-symbolIcon-functionForeground, #569cd6); }

/* Strings */
.hljs-string,
.hljs-template-string,
.hljs-template-variable { color: var(--vscode-debugTokenExpression-string, #ce9178); }

/* Numbers */
.hljs-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }

/* Comments */
.hljs-comment,
.hljs-quote { color: var(--vscode-charts-green, #6a9955); font-style: italic; }

/* Function / method names */
.hljs-title.function_,
.hljs-title.function { color: var(--vscode-debugTokenExpression-string, #dcdcaa); }

/* Class / type names */
.hljs-title.class_,
.hljs-title.class { color: var(--vscode-chat-editedFileForeground, #4ec9b0); }

/* Generic titles (fallback) */
.hljs-title { color: var(--vscode-editorBracketHighlight-foreground1, #dcdcaa); }

/* Variables, parameters, properties */
.hljs-variable,
.hljs-params,
.hljs-property { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }

/* Built-in types / functions */
.hljs-built_in,
.hljs-type { color: var(--vscode-scmGraph-foreground4, #4ec9b0); }

/* Booleans, null, undefined */
.hljs-literal,
.hljs-symbol { color: var(--vscode-debugTokenExpression-boolean, #4e94ce); }

/* Attributes / HTML/JSX attributes */
.hljs-attr { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }

/* Regex */
.hljs-regexp { color: var(--vscode-charts-red, #d16969); }

/* Decorators, annotations, meta */
.hljs-meta,
.hljs-meta .hljs-keyword { color: var(--vscode-editorCodeLens-foreground, #c9b299); }

/* Diff additions / deletions */
.hljs-addition { color: var(--vscode-charts-green, #89d185); }
.hljs-deletion { color: var(--vscode-charts-red, #f14c4c); }

/* Headings in Markdown */
.hljs-section { color: var(--vscode-symbolIcon-classForeground, #ee9d28); font-weight: bold; }

/* HTML/JSX tag names */
.hljs-tag .hljs-name,
.hljs-name { color: var(--vscode-symbolIcon-constructorForeground, #4ec9b0); }

/* HTML/JSX tag attributes */
.hljs-tag .hljs-attr { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }

/* CSS selectors */
.hljs-selector-class,
.hljs-selector-id,
.hljs-selector-pseudo { color: var(--vscode-chat-editedFileForeground, #d7ba7d); }

/* Sub-substitutions */
.hljs-subst { color: var(--vscode-editor-foreground, #d4d4d4); }

/* Links */
.hljs-link { color: var(--vscode-textLink-foreground, #4e94ce); text-decoration: underline; }

/* Doc comment tags */
.hljs-doctag { color: var(--vscode-charts-green, #608b4e); }
`;

/** Inject the HLJS theme stylesheet once per document lifetime. Idempotent. */
export function injectHljsStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("fp-hljs-theme")) return;
  const style = document.createElement("style");
  style.id = "fp-hljs-theme";
  style.textContent = HLJS_STYLES;
  document.head.appendChild(style);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Map of lowercase file extension → hljs language identifier. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  go: "go",
  java: "java",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  kt: "java", // close enough for symbol coloring
  rb: "bash", // rough approximation
  php: "bash",
  swift: "java",
  dart: "java",
  vue: "html",
  svelte: "html",
  toml: "yaml",
};

/**
 * Infer an hljs language from a file path/name.
 * Returns `undefined` when the extension is unrecognised.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? EXT_TO_LANGUAGE[ext] : undefined;
}

/**
 * Syntax-highlight a single code string with highlight.js.
 *
 * @param code     Raw source text (no trailing newline required)
 * @param language hljs language identifier (e.g. "typescript").
 *                 Falls back to auto-detection when undefined/unknown.
 * @returns        HTML string with hljs `<span class="hljs-*">` tokens.
 *                 Safe to assign via `dangerouslySetInnerHTML`.
 */
export function highlightCode(code: string, language?: string): string {
  const text = code.replace(/\n$/, "");
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    // Final fallback: HTML-escape only
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

