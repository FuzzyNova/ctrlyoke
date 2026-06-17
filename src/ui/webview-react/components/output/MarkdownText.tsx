import React, { memo, useMemo } from "react";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { findAndReplace } from "mdast-util-find-and-replace";
import { visit } from "unist-util-visit";
import { toString as mdastToString } from "mdast-util-to-string";
import type { Root } from "mdast";
import type { PluginTuple } from "unified";
import { openFile } from "@hooks/useMessageHandler";
import {
  highlightCodeText,
  injectFindHighlightStyles,
  injectSyntaxHighlightStyles,
  renderHighlightedCode,
  type CodeFindHighlight,
} from "@utils/syntaxHighlighting";

// Ensure the shared VS Code-themed syntax/find-highlight styles are in <head>.
injectSyntaxHighlightStyles();
injectFindHighlightStyles();

// ── File-link detection ────────────────────────────────────────────────────

/**
 * Recognized file extensions for auto-linking workspace paths.
 * Conservative list to avoid false positives in prose.
 */
const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|py|sh|css|scss|html|toml|txt|rs|go|swift|java|c|cpp|h|vue|svelte|rb|php|dart|kt|cs";

/**
 * Matches workspace-relative or absolute file paths that end with a
 * recognized extension. Five alternatives:
 *   1. Windows absolute   – C:\path\to\file.ts  or  C:/path/to/file.ts
 *                           Also handles escaped double-backslashes (C:\\path)
 *                           output by some harnesses on Windows.
 *   2. Codex pseudo-abs    – /abs/path/c:/path/file.ts
 *   3. Slash drive abs     – /c:/path/file.ts
 *   4. Explicitly relative – ./path/file.ts  or  ../path/file.ts
 *   5. Bare relative       – src/path/file.ts  (lowercase start, ≥1 slash)
 *
 * Single-segment names like "file.ts" (no separator) are intentionally
 * excluded to avoid false positives in plain prose.
 *
 * Separators allow 1–2 consecutive slashes/backslashes so that harnesses
 * that escape their output (e.g. writing C:\\dev\\) are also matched.
 */
const SEP = "[/\\\\]{1,2}"; // matches /  \  //  \\  (1–2 of either)
const FILE_PATH_SOURCE =
  "(?:" +
  "[A-Za-z]:" +
  SEP + // 1. Windows absolute  C:\  or  C:/  or  C:\\
  "|" +
  "/abs/path/" +
  "[A-Za-z]:/" + // 2. Codex pseudo-absolute /abs/path/c:/
  "|" +
  "/" +
  "[A-Za-z]:/" + // 3. Slash-prefixed Windows absolute /c:/
  "|" +
  "\\.{1,2}" +
  SEP + // 4. Relative prefix   ./   or  ../
  "|" +
  "[a-z][\\w-]*" +
  SEP + // 5. Bare relative      src/  lib/  …
  ")" +
  "(?:[\\w.\\-]+" +
  SEP +
  ")*" + // Zero or more inner directory segments
  "[\\w.\\-]+" + // Final filename base
  "\\.(?:" +
  FILE_EXTENSIONS +
  ")\\b"; // Extension (required)

/** Escapes HTML special characters for use in raw HTML node text content. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes regex special characters so a search query can be used as a literal pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => getNodeText(item)).join("");
  }

  if (React.isValidElement(node)) {
    return getNodeText((node.props as { children?: React.ReactNode }).children);
  }

  return "";
}

/**
 * Converts web-safe absolute file-link target forms back to native Windows
 * absolute paths:
 *   /abs/path/c:/dev/repo/file.ts -> C:/dev/repo/file.ts
 *   /c:/dev/repo/file.ts          -> C:/dev/repo/file.ts
 */
function normalizeCodexAbsPath(raw: string): string {
  const pathWithDrive = raw.match(/^\/abs\/path\/([A-Za-z]:)(\/.*)$/);
  if (pathWithDrive) {
    return `${pathWithDrive[1].toUpperCase()}${pathWithDrive[2]}`;
  }

  const slashDrivePath = raw.match(/^\/([A-Za-z]:)(\/.*)$/);
  if (slashDrivePath) {
    return `${slashDrivePath[1].toUpperCase()}${slashDrivePath[2]}`;
  }

  return raw;
}

/**
 * Remark plugin that walks MDAST text nodes (outside code/links) and
 * converts recognised file path patterns into raw HTML `<file-ref>` nodes.
 *
 * Using a custom element instead of a `link` node bypasses rehype-sanitize
 * (which strips unrecognised URL schemes from `<a href>`) and rehype-harden
 * (which only processes `<a>` and `<img>` tags). The `allowedTags` prop on
 * `<Streamdown>` tells rehype-sanitize to keep `<file-ref path="…">`.
 */
function remarkFileLinks() {
  return (tree: Root): undefined => {
    findAndReplace(
      tree,
      [
        [
          // Fresh regex instance per transform call so lastIndex is always reset
          new RegExp(FILE_PATH_SOURCE, "gi"),
          (match: string) => {
            const normalized = normalizeCodexAbsPath(
              match.replace(/\\{2,}/g, "\\")
            );
            const encoded = encodeURIComponent(normalized);
            const display = escapeHtml(normalized);
            return {
              type: "html",
              value: `<file-ref path="${encoded}">${display}</file-ref>`,
            };
          },
        ],
      ],
      // Skip text nodes that are already inside a link to avoid double-wrapping
      { ignore: ["link"] }
    );
  };
}

/**
 * Returns true when the given href is a local file reference that VS Code's
 * webview would otherwise block:
 *   - `file://` / `file:///` URLs
 *   - Raw Windows absolute paths  (C:\…  or  C:/…)
 *   - Codex pseudo-absolute paths (/abs/path/c:/…)
 *   - Slash-prefixed Windows paths (/c:/…)
 *   - Explicitly relative paths   (./…  or  ../…)
 */
function isLocalFileHref(href: string): boolean {
  return (
    href.startsWith("file://") ||
    /^[A-Za-z]:[/\\]/.test(href) ||
    /^\/abs\/path\/[A-Za-z]:\//.test(href) ||
    /^\/[A-Za-z]:\//.test(href) ||
    /^\.\.?[/\\]/.test(href)
  );
}

/**
 * Extracts a usable file-system path from a potentially blocked href so it
 * can be forwarded to `openFile`.
 *
 * Handles:
 *   - `file:///C:/path/file.ts`  →  `C:/path/file.ts`
 *   - `file:///C:\path\file.ts`  →  `C:\path\file.ts`
 *   - `/abs/path/c:/path/file.ts` → `C:/path/file.ts`
 *   - `/c:/path/file.ts`          → `C:/path/file.ts`
 *   - Raw paths passed through unchanged.
 */
function extractFilePath(href: string): string {
  if (href.startsWith("file:///")) {
    return normalizeCodexAbsPath(
      decodeURIComponent(href.slice("file:///".length))
    );
  }
  if (href.startsWith("file://")) {
    return normalizeCodexAbsPath(
      decodeURIComponent(href.slice("file://".length))
    );
  }
  return normalizeCodexAbsPath(href);
}

/**
 * Splits a file path that may have a trailing `:line` suffix (e.g.
 * `src/foo.ts:45`) into the bare path and an optional 1-based line number.
 * Windows drive letters (C:) are never mistaken because lastIndexOf finds the
 * *last* colon, and drive colons always sit at index 1.
 */
function parseFilePathAndLine(raw: string): { path: string; line?: number } {
  const colon = raw.lastIndexOf(":");
  if (colon > 1) {
    const suffix = raw.slice(colon + 1);
    if (/^\d+$/.test(suffix)) {
      return { path: raw.slice(0, colon), line: parseInt(suffix, 10) };
    }
  }
  return { path: raw };
}

/** Button that opens a local file in VS Code on click. */
function FileRefButton({
  filePath,
  children,
}: {
  filePath: string;
  children?: React.ReactNode;
}) {
  const { path, line } = parseFilePathAndLine(filePath);
  const title = line !== undefined ? `Open ${path}:${line}` : `Open ${path}`;
  return (
    <button
      type="button"
      className="group inline-flex items-baseline gap-0.5 cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit]"
      onClick={() =>
        line !== undefined ? openFile(path, line) : openFile(path)
      }
      title={title}
    >
      <i className="codicon codicon-file text-xxs opacity-70" />
      <span className="group-hover:underline">{children}</span>
    </button>
  );
}

/**
 * Remark plugin that converts explicit markdown links whose href is a local
 * file path (Windows absolute, file://, or relative ./) into <file-ref> nodes.
 *
 * Without this, rehype-harden intercepts these <a> elements in the HAST
 * pipeline — before the React `a` component renderer runs — and replaces
 * them with a <span> suffixed with " [blocked]" because Windows paths like
 * C:\... fail URL validation. Converting to <file-ref> here bypasses both
 * rehype-sanitize and rehype-harden entirely.
 */
function remarkLocalLinks() {
  return (tree: Root): undefined => {
    visit(tree, "link", (node, index, parent) => {
      if (!parent || typeof index !== "number") return;
      if (!isLocalFileHref(node.url)) return;

      const filePath = extractFilePath(node.url);
      const encoded = encodeURIComponent(filePath);
      const displayText = escapeHtml(mdastToString(node) || filePath);

      (parent.children as typeof parent.children)[index] = {
        type: "html",
        value: `<file-ref path="${encoded}">${displayText}</file-ref>`,
      };
    });
  };
}

/** Options for {@link remarkHighlightMatches}, passed via the standard remark `[plugin, options]` tuple form. */
interface HighlightMatchesOptions {
  /** "Find in output" query to wrap in `<mark>`. Falsy/whitespace-only disables highlighting. */
  query: string;
  /** Whether `query` matching is case-sensitive. */
  caseSensitive: boolean;
  /** 0-based index (across the whole tree) of the currently-active match. */
  activeIndex: number;
}

/**
 * Remark plugin that wraps occurrences of `query` in MDAST text nodes with
 * raw `<mark>` HTML nodes, mirroring the "find in output" highlight applied
 * to plain-text rows via `highlightText()`. Operating on parsed text nodes
 * (rather than the raw markdown source) avoids fragile offset math against
 * Streamdown's incomplete-markdown healing.
 *
 * `activeIndex` marks the currently-focused match (0-based, across the whole
 * tree) with `data-find-active="true"` so it can be styled distinctly via
 * `injectFindHighlightStyles()`.
 *
 * Requires the tree passed to this plugin to represent the *entire* markdown
 * document in one pass (see the `mode="static"` override below) — `occurrence`
 * resets to 0 for every separate tree this transformer runs against, so if
 * Streamdown's streaming mode split the document into multiple independently
 * transformed blocks, `activeIndex` (a document-global index) would line up
 * with occurrence 0 in *every* block instead of a single occurrence overall.
 *
 * Takes its parameters via the `[plugin, options]` tuple form (see
 * `remarkPlugins` below) rather than a per-render factory function. Streamdown
 * caches its unified processor keyed on `${plugin.name}:${JSON.stringify(options)}`
 * for tuple entries, so this stable, module-level function reference keeps
 * the cache key's plugin-identity portion constant across renders — only the
 * serialized `options` change — instead of minting a brand-new function (and
 * processor-cache entry) on every keystroke or match navigation.
 *
 * Known limitation: `findAndReplace` only visits parsed `text` mdast nodes,
 * so a query that spans an inline-formatting boundary (e.g. searching "foo"
 * when the source is `**fo**o`) won't produce a `<mark>` here, even though
 * the plain-text "find in output" pass (`outputFind.ts`, which searches the
 * raw markdown source) counts it as a match. When that happens `activeIndex`
 * may not line up with any `<mark>` in this tree — the active-match outline
 * simply won't render for that occurrence.
 */
function remarkHighlightMatches({
  query,
  caseSensitive,
  activeIndex,
}: HighlightMatchesOptions) {
  return (tree: Root): undefined => {
    if (!query) return;

    let occurrence = -1;
    findAndReplace(tree, [
      [
        new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi"),
        (match: string) => {
          occurrence += 1;
          const activeAttr =
            occurrence === activeIndex ? ' data-find-active="true"' : "";
          return {
            type: "html",
            value: `<mark${activeAttr}>${escapeHtml(match)}</mark>`,
          };
        },
      ],
    ]);
  };
}

// Module-level stable array so Streamdown's memo doesn't see a new reference.
// Spread streamdown's defaults (remarkGfm) first, then add our file-link plugins.
const REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkLocalLinks,
  remarkFileLinks,
];

// Extends rehype-sanitize's allowlist so it keeps <file-ref path="…"> and
// <mark data-find-active="…"> nodes produced by remarkFileLinks /
// remarkHighlightMatches.
const FILE_REF_ALLOWED_TAGS = {
  "file-ref": ["path"],
  mark: ["dataFindActive"],
};

// ── Component ──────────────────────────────────────────────────────────────

interface MarkdownTextProps {
  /** The markdown string to render */
  children: string;
  /** Enable streaming animation (pass true while content is still arriving) */
  animated?: boolean;
  /** Optional additional CSS class on the container */
  className?: string;
  /** "Find in output" query to highlight within the rendered markdown */
  highlightQuery?: string;
  /** Whether `highlightQuery` matching is case-sensitive */
  highlightCaseSensitive?: boolean;
  /** 0-based index (across the whole text) of the currently-active match */
  highlightActiveIndex?: number;
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
const MarkdownTextComponent: React.FC<MarkdownTextProps> = ({
  children,
  animated = false,
  className,
  highlightQuery,
  highlightCaseSensitive = false,
  highlightActiveIndex = -1,
}) => {
  // Find-highlight options for code blocks/inline code. These are skipped by
  // remarkHighlightMatches (which only visits markdown text nodes), so they're
  // highlighted at render time here instead. Memoized so the `components` memo
  // below stays stable across re-renders while the query is unchanged.
  const codeFindHighlight: CodeFindHighlight | undefined = useMemo(
    () =>
      highlightQuery?.trim()
        ? { query: highlightQuery, caseSensitive: highlightCaseSensitive }
        : undefined,
    [highlightQuery, highlightCaseSensitive]
  );

  // Memoize components to avoid re-creating on every streaming chunk
  const components = useMemo(
    () => ({
      // ── File-ref custom element ────────────────────────────────────────
      // Rendered by remarkFileLinks for auto-detected file paths in AI text.
      // rehype-sanitize keeps this element because of FILE_REF_ALLOWED_TAGS.
      // rehype-harden ignores it (only processes <a> and <img>).
      "file-ref": (props: Record<string, unknown>) => {
        const encoded = props.path as string | undefined;
        const filePath = encoded ? decodeURIComponent(encoded) : "";
        return (
          <FileRefButton filePath={filePath}>
            {props.children as React.ReactNode}
          </FileRefButton>
        );
      },

      // ── Links ─────────────────────────────────────────────────────────
      a: ({
        href,
        children: linkChildren,
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode;
      }) => {
        // Explicit markdown links whose href is a local path (e.g. the AI
        // wrote [file.ts](C:\\dev\\path\\file.ts) or a file:// URL).
        // VS Code's webview would block these; intercept and open in VS Code.
        if (href && isLocalFileHref(href)) {
          return (
            <FileRefButton filePath={extractFilePath(href)}>
              {linkChildren}
            </FileRefButton>
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
        <h1 className="text-md-heading-fg font-bold text-xl mt-4 mb-2 pb-1 border-b border-panel-border">
          {c}
        </h1>
      ),

      h2: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h2 className="text-md-heading-fg font-semibold text-lg mt-3 mb-1 pb-0.5 border-b border-panel-border opacity-90">
          {c}
        </h2>
      ),

      h3: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3 className="text-md-heading-fg font-semibold text-base mt-3 mb-1 opacity-80">
          {c}
        </h3>
      ),

      h4: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h4 className="text-md-heading-fg font-medium text-base mt-2 mb-0.5 opacity-70">
          {c}
        </h4>
      ),

      h5: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h5 className="text-md-heading-fg font-medium text-sm mt-2 mb-0.5 opacity-60">
          {c}
        </h5>
      ),

      h6: ({ children: c }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h6 className="text-description-fg font-medium text-sm mt-2 mb-0.5 uppercase tracking-wide">
          {c}
        </h6>
      ),

      // ── Tables ─────────────────────────────────────────────────────────
      table: ({ children: c }: React.HTMLAttributes<HTMLTableElement>) => (
        <div className="overflow-x-auto my-2">
          <table className="border-collapse w-full">{c}</table>
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
      //   • Language class    → syntax-highlighted block via refractor
      code: ({
        children: codeChildren,
        className: langClass,
      }: React.HTMLAttributes<HTMLElement>) => {
        const language = langClass?.replace(/^language-/, "");

        // Inline code (single backtick, no language)
        if (!language) {
          return (
            <code className="bg-code-block text-code-inline-fg rounded px-1 py-0.5 font-mono">
              {codeFindHighlight
                ? highlightCodeText(getNodeText(codeChildren), codeFindHighlight)
                : codeChildren}
            </code>
          );
        }

        const rawText = getNodeText(codeChildren).replace(/\n$/, "");

        return (
          <code className={`fp-syntax ${langClass ?? ""} font-mono block`}>
            {renderHighlightedCode(rawText, language, codeFindHighlight)}
          </code>
        );
      },

      // ── Code block wrapper ─────────────────────────────────────────────
      // Preserve indentation while still allowing long code lines to wrap
      // inside narrow output panes instead of forcing horizontal overflow.
      pre: ({ children: preChildren }: React.HTMLAttributes<HTMLElement>) => (
        <pre className="bg-editor-bg border border-panel-border rounded p-3 my-2 font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {preChildren}
        </pre>
      ),
    }),
    [codeFindHighlight]
  );

  // Only append the highlight plugin when there's a non-whitespace query, so
  // the common case keeps Streamdown's stable REMARK_PLUGINS reference (and a
  // query of all spaces doesn't wrap every space character in <mark>).
  const remarkPlugins = useMemo(() => {
    if (!highlightQuery?.trim()) return REMARK_PLUGINS;

    const highlightPlugin: PluginTuple<[HighlightMatchesOptions], Root, Root> = [
      remarkHighlightMatches,
      {
        query: highlightQuery,
        caseSensitive: highlightCaseSensitive,
        activeIndex: highlightActiveIndex,
      },
    ];

    return [...REMARK_PLUGINS, highlightPlugin];
  }, [highlightQuery, highlightCaseSensitive, highlightActiveIndex]);

  // Streamdown's <Streamdown> is wrapped in React.memo with a custom comparator
  // that never compares `remarkPlugins`/`rehypePlugins`/`allowedTags` — only
  // `children`, `className`, `mode`, `dir`, and a handful of other props. So a
  // `remarkPlugins` reference change alone (e.g. the active match moving to the
  // next occurrence) is silently dropped: Streamdown keeps rendering the
  // previously-cached <mark> output even though our plugin's options changed.
  // Keying on the highlight state forces React to remount Streamdown whenever
  // it changes, guaranteeing the new highlight options take effect. The key is
  // a constant when there's no active query, so the common case never remounts.
  const isHighlighting = !!highlightQuery?.trim();
  const streamdownKey = isHighlighting
    ? `find:${JSON.stringify([highlightQuery, highlightCaseSensitive, highlightActiveIndex])}`
    : "no-find";

  // Streamdown's default "streaming" mode splits markdown into independently
  // transformed top-level blocks (paragraphs, headings, etc.), each running
  // `remarkHighlightMatches` against its own subtree with `occurrence` reset
  // to 0. That breaks the document-global `activeIndex` numbering — see the
  // comment on `remarkHighlightMatches`. "static" mode runs the whole
  // document through a single transform, restoring global occurrence order,
  // at the cost of skipping incomplete-markdown healing while highlighting.
  return (
    <Streamdown
      key={streamdownKey}
      animated={animated}
      mode={isHighlighting ? "static" : "streaming"}
      className={`markdown-text ${className ?? ""}`}
      components={components}
      remarkPlugins={remarkPlugins}
      allowedTags={FILE_REF_ALLOWED_TAGS}
      // No plugins prop: omitting avoids Shiki WASM CSP issues in VS Code webview
    >
      {children}
    </Streamdown>
  );
};

export const MarkdownText = memo(MarkdownTextComponent);
MarkdownText.displayName = "MarkdownText";
