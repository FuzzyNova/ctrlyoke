import React, { useMemo } from "react";
import { Streamdown } from "streamdown";
import { findAndReplace } from "mdast-util-find-and-replace";
import type { Root, Link } from "mdast";
import { openFile } from "@hooks/useMessageHandler";
import { highlightCode, injectHljsStyles } from "@utils/hljsUtils";

// Ensure the VS Code-themed HLJS stylesheet is in <head>
injectHljsStyles();

// ── File-link detection ────────────────────────────────────────────────────

const VSCODE_FILE_SCHEME = "vscode-file-ref://";

/**
 * Recognized file extensions for auto-linking workspace paths.
 * Conservative list to avoid false positives in prose.
 */
const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|py|sh|css|scss|html|toml|txt|rs|go|swift|java|c|cpp|h|vue|svelte|rb|php|dart|kt|cs";

/**
 * Matches workspace-relative or absolute file paths that end with a
 * recognized extension. Three alternatives:
 *   1. Windows absolute   – C:\path\to\file.ts  or  C:/path/to/file.ts
 *   2. Explicitly relative – ./path/file.ts  or  ../path/file.ts
 *   3. Bare relative       – src/path/file.ts  (lowercase start, ≥1 slash)
 *
 * Single-segment names like "file.ts" (no separator) are intentionally
 * excluded to avoid false positives in plain prose.
 */
const FILE_PATH_SOURCE =
  "(?:" +
  "[A-Za-z]:[/\\\\]" + // 1. Windows absolute  C:\  or  C:/
  "|" +
  "\\.{1,2}[/\\\\]" + // 2. Relative prefix   ./   or  ../
  "|" +
  "[a-z][\\w-]*[/\\\\]" + // 3. Bare relative      src/  lib/  …
  ")" +
  "(?:[\\w.\\-]+[/\\\\])*" + // Zero or more inner directory segments
  "[\\w.\\-]+" + // Final filename base
  "\\.(?:" +
  FILE_EXTENSIONS +
  ")\\b"; // Extension (required)

/**
 * Remark plugin that walks MDAST text nodes (outside code/links) and
 * converts recognised file path patterns into link nodes with the
 * custom `vscode-file-ref://` URL scheme.
 */
function remarkFileLinks() {
  return (tree: Root): undefined => {
    findAndReplace(
      tree,
      [
        [
          // Fresh regex instance per transform call so lastIndex is always reset
          new RegExp(FILE_PATH_SOURCE, "gi"),
          (match: string): Link => ({
            type: "link",
            url: VSCODE_FILE_SCHEME + match,
            children: [{ type: "text", value: match }],
          }),
        ],
      ],
      // Skip text nodes that are already inside a link to avoid double-wrapping
      { ignore: ["link"] }
    );
  };
}

// Module-level stable array so Streamdown's memo doesn't see a new reference
const REMARK_PLUGINS = [remarkFileLinks];

// ── Component ──────────────────────────────────────────────────────────────

interface MarkdownTextProps {
  /** The markdown string to render */
  children: string;
  /** Enable streaming animation (pass true while content is still arriving) */
  animated?: boolean;
  /** Optional additional CSS class on the container */
  className?: string;
}

/**
 * Renders AI-generated markdown text with Streamdown.
 *
 * Handles streaming-safe rendering with incomplete syntax healing.
 * Only used for TEXT and THINKING event types — tool calls retain
 * their own custom renderers.
 *
 * Enhancements over plain Streamdown:
 * - Workspace file paths are auto-linked and open in VS Code on click.
 * - Bold, italic, headings, tables, and blockquotes use VS Code theme colours
 *   drawn from the symbol-icon palette (interface blue, function purple,
 *   class amber) — similar to how Claude and Copilot colour their responses.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({
  children,
  animated = false,
  className,
}) => {
  // Memoize components to avoid re-creating on every streaming chunk
  const components = useMemo(
    () => ({
      // ── Links ─────────────────────────────────────────────────────────
      a: ({
        href,
        children: linkChildren,
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode;
      }) => {
        // File-ref links open the file in VS Code instead of a browser tab
        if (href?.startsWith(VSCODE_FILE_SCHEME)) {
          const filePath = href.slice(VSCODE_FILE_SCHEME.length);
          return (
            <button
              type="button"
              className="text-link-fg hover:underline inline-flex items-center gap-0.5 cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit]"
              onClick={() => openFile(filePath)}
              title={`Open ${filePath}`}
            >
              <i className="codicon codicon-file text-[10px] opacity-70" />
              {linkChildren}
            </button>
          );
        }
        // Regular URLs open in the external browser (webviews intercept clicks)
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-link-fg hover:underline"
          >
            {linkChildren}
          </a>
        );
      },

      // ── Inline emphasis ────────────────────────────────────────────────
      strong: ({ children: c }: React.HTMLAttributes<HTMLElement>) => (
        <strong className="font-semibold text-md-strong-fg">{c}</strong>
      ),

      em: ({ children: c }: React.HTMLAttributes<HTMLElement>) => (
        <em className="italic text-md-em-fg">{c}</em>
      ),

      // ── Headings ───────────────────────────────────────────────────────
      h1: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h1 className="text-md-heading-fg font-bold text-[1.25em] mt-4 mb-2 pb-1 border-b border-panel-border">
          {c}
        </h1>
      ),

      h2: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h2 className="text-md-heading-fg font-semibold text-[1.1em] mt-3 mb-1 pb-0.5 border-b border-panel-border opacity-90">
          {c}
        </h2>
      ),

      h3: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3 className="text-md-heading-fg font-semibold text-[1em] mt-3 mb-1 opacity-80">
          {c}
        </h3>
      ),

      h4: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h4 className="text-md-heading-fg font-medium text-[0.95em] mt-2 mb-0.5 opacity-70">
          {c}
        </h4>
      ),

      h5: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h5 className="text-md-heading-fg font-medium text-[0.9em] mt-2 mb-0.5 opacity-60">
          {c}
        </h5>
      ),

      h6: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h6 className="text-description-fg font-medium text-[0.85em] mt-2 mb-0.5 uppercase tracking-wide">
          {c}
        </h6>
      ),

      // ── Tables ─────────────────────────────────────────────────────────
      table: ({ children: c }: React.HTMLAttributes<HTMLTableElement>) => (
        <div className="overflow-x-auto my-2">
          <table className="border-collapse text-[0.9em] w-full">{c}</table>
        </div>
      ),

      thead: ({
        children: c,
      }: React.HTMLAttributes<HTMLTableSectionElement>) => (
        <thead className="bg-md-table-head-bg">{c}</thead>
      ),

      tbody: ({
        children: c,
      }: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody>{c}</tbody>,

      tr: ({ children: c }: React.HTMLAttributes<HTMLTableRowElement>) => (
        <tr className="border-b border-panel-border">{c}</tr>
      ),

      th: ({
        children: c,
        ...props
      }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
        <th
          {...props}
          className="border border-panel-border px-3 py-1.5 text-left text-md-strong-fg font-semibold whitespace-nowrap"
        >
          {c}
        </th>
      ),

      td: ({
        children: c,
        ...props
      }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
        <td {...props} className="border border-panel-border px-3 py-1.5">
          {c}
        </td>
      ),

      // ── Blockquote ─────────────────────────────────────────────────────
      blockquote: ({ children: c }: React.HTMLAttributes<HTMLQuoteElement>) => (
        <blockquote className="border-l-2 border-link-fg pl-3 my-2 text-description-fg italic">
          {c}
        </blockquote>
      ),

      // ── Inline code ────────────────────────────────────────────────────
      // When inside a fenced block the `code` node carries a `language-*`
      // class; inline backtick code has no class. We differentiate here:
      //   • No language class → styled inline span with a warm VS Code tint
      //   • Language class    → syntax-highlighted block via highlight.js
      code: ({
        children: codeChildren,
        className: langClass,
      }: React.HTMLAttributes<HTMLElement>) => {
        const language = langClass?.replace(/^language-/, "");

        // Inline code (single backtick, no language)
        if (!language) {
          return (
            <code className="bg-[var(--vscode-textCodeBlock-background)] text-code-inline-fg rounded px-1 py-0.5 font-mono text-[0.9em]">
              {codeChildren}
            </code>
          );
        }

        // Fenced code block – syntax-highlight with highlight.js
        const rawText = String(codeChildren).replace(/\n$/, "");
        const highlighted = highlightCode(rawText, language);

        return (
          <code
            dangerouslySetInnerHTML={{ __html: highlighted }}
            className={`hljs ${langClass ?? ""} font-mono text-[0.9em] block`}
          />
        );
      },

      // ── Code block wrapper ─────────────────────────────────────────────
      // Removes whitespace-pre-wrap so hljs span colouring renders cleanly;
      // whitespace-pre is enough (hljs never emits bare newlines outside spans).
      pre: ({ children: preChildren }: React.HTMLAttributes<HTMLElement>) => (
        <pre className="bg-editor-bg border border-panel-border rounded p-3 overflow-x-auto my-2 font-mono text-[0.9em] whitespace-pre">
          {preChildren}
        </pre>
      ),
    }),
    []
  );

  return (
    <Streamdown
      animated={animated}
      className={`markdown-text ${className ?? ""}`}
      components={components}
      remarkPlugins={REMARK_PLUGINS}
      // No plugins prop: omitting avoids Shiki WASM CSP issues in VS Code webview
    >
      {children}
    </Streamdown>
  );
};
