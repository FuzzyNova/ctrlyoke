# Streamdown Markdown Rendering Plan

## Overview

This document covers the research and implementation plan for integrating [Streamdown](https://streamdown.ai/docs) into FlightPath's output panel to render AI-generated markdown text blocks with proper formatting, including streaming support.

**Goal**: Replace plain-text rendering of AI text/message responses with rich markdown rendering using Streamdown. Tool call blocks (bash commands, file operations, MCP calls, web search, etc.) keep their existing custom formatting — only `TEXT` and `THINKING` event types are affected.

---

## What Is Streamdown?

Streamdown (`npm: streamdown`, v2.2.x) is a React component library from Vercel built specifically for rendering streaming AI-generated markdown. Key differentiators:

- **Stream-aware healing** (via "Remend"): Gracefully handles incomplete syntax mid-stream — unterminated code fences, half-written headers, partial tables — rather than breaking or showing raw markdown
- **Streaming caret**: Blinking cursor at the end of in-progress content
- **Per-word animation**: Optional `animated` prop fades in words as they arrive
- **Plugin architecture** (v2+): Heavy features (Mermaid, Math, CJK, Shiki syntax highlighting) are separate opt-in packages — base bundle is lean
- **GFM built-in**: GitHub Flavored Markdown (tables, task lists, strikethrough) via `remark-gfm`
- **Security**: Default rehype plugins include `rehype-sanitize` and `rehype-harden`
- **Component overrides**: Same `components` prop API as `react-markdown` for custom element rendering

---

## Current Output Rendering Architecture

The FlightPath output system renders events of these types (from `CLI_EVENT_TYPES`):

| Event Type | Current Rendering | Proposed Change |
|---|---|---|
| `TEXT` | Plain `<pre>`/`<span>` text | **→ Use Streamdown** |
| `THINKING` | Collapsible pre-formatted block | **→ Use Streamdown inside** |
| `BASH_COMMAND` | Custom terminal-style component (`BashOutput`) | No change |
| `FILE_READ` | Custom file op component (`ToolCallOutput`) | No change |
| `FILE_WRITE` | Custom file op component | No change |
| `FILE_EDIT` | Unified diff viewer with color coding | No change |
| `FILE_DELETE` | Custom file op component | No change |
| `MCP_TOOL_CALL` | Custom MCP component | No change |
| `WEB_SEARCH` | Custom search results component | No change |
| `TOOL_CALL` | Generic tool call component | No change |
| `TOOL_RESULT` | Tool result component | No change |

**Plain-text streaming fallback** (`streamingChunks` in `workflowStore`) is also used when structured events haven't arrived yet — this should also be rendered with Streamdown.

### Key Files

| File | Role |
|---|---|
| `src/ui/webview-react/components/output/CliOutput.tsx` | Main output container; renders all event types |
| `src/ui/webview-react/components/output/ToolCallOutput.tsx` | Tool call event renderers (no changes) |
| `src/ui/webview-react/components/output/BashOutput.tsx` | Bash command renderer (no changes) |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Orchestrates all output; manages chronological sort |
| `src/ui/webview-react/store/workflowStore.ts` | `streamingChunks`, `cliOutputs` state |

---

## Critical Constraint: VS Code Webview CSP

**The most important constraint for this integration.**

The `code` plugin (Shiki syntax highlighting) uses **WebAssembly**, which requires `wasm-unsafe-eval` in the Content Security Policy. VS Code webviews do **not** allow `wasm-unsafe-eval` by default.

Additionally, Streamdown v2's Shiki integration loads language grammars from a **CDN at runtime** — which is blocked in VS Code webviews entirely (no external network access by default).

### Decision: Use Streamdown Without the `code` Plugin

Use the **base Streamdown package without the `@streamdown/code` plugin**. Code blocks in AI responses will render as unstyled `<code>` elements by default. We can optionally provide a custom `components.code` override using `highlight.js` (no WASM, no CDN) for syntax coloring.

**What works in VS Code webview (no issues):**
- All GFM: headings, bold/italic, tables, task lists, blockquotes, lists, links
- Inline code
- Fenced code blocks (unstyled, via custom `code` component)
- `animated` prop (pure CSS — no WASM)
- CSS variable theming (maps perfectly to VS Code theme tokens)
- Custom `components` prop overrides
- Tailwind `className` prop

**What does NOT work (skip for now):**
- `@streamdown/code` plugin (Shiki, requires `wasm-unsafe-eval` + CDN)
- `@streamdown/mermaid` plugin (Mermaid bundles server-side packages)

---

## Implementation Plan

### Step 1 — Install Streamdown

In `src/ui/webview-react/` (the Vite/React subproject):

```bash
npm install streamdown
```

**No additional plugin packages needed** (`@streamdown/code`, `@streamdown/math`, `@streamdown/mermaid` are all optional and skipped for now).

---

### Step 2 — Configure Tailwind CSS

Streamdown uses Tailwind utility classes internally. The webview's CSS must scan the Streamdown dist for class names.

**In `src/ui/webview-react/styles/globals.css`** (or equivalent main CSS entry):

```css
/* Allow Tailwind to scan Streamdown's bundled classes */
@source "../../../node_modules/streamdown/dist/*.js";

/* Import Streamdown base styles (required for animated prop) */
@import "streamdown/styles.css";
```

> **Note**: Confirm Tailwind version compatibility. If the project uses Tailwind v4, the `@source` directive syntax is as above. If v3, add to `tailwind.config.js` `content` array instead: `"./node_modules/streamdown/dist/*.js"`.

---

### Step 3 — Create a `MarkdownText` Component

Create a new shared component that wraps Streamdown with FlightPath-appropriate defaults. This centralizes all Streamdown configuration in one place.

**New file: `src/ui/webview-react/components/output/MarkdownText.tsx`**

```tsx
import React, { useMemo } from "react";
import { Streamdown } from "streamdown";

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
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({
  children,
  animated = false,
  className,
}) => {
  // Memoize components to avoid re-creating on every chunk
  const components = useMemo(
    () => ({
      // Override <a> to open in external browser (webviews intercept clicks)
      a: ({ href, children: linkChildren }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--vscode-textLink-foreground)] hover:underline"
        >
          {linkChildren}
        </a>
      ),
      // Inline code: use VS Code monospace style
      code: ({ children: codeChildren, className: langClass }: React.HTMLAttributes<HTMLElement>) => (
        <code
          className={`${langClass ?? ""} bg-[var(--vscode-textCodeBlock-background)] text-[var(--vscode-editor-foreground)] rounded px-1 py-0.5 font-mono text-[0.9em]`}
        >
          {codeChildren}
        </code>
      ),
      // Code block wrapper: terminal-like appearance matching existing style
      pre: ({ children: preChildren }: React.HTMLAttributes<HTMLElement>) => (
        <pre className="bg-[var(--vscode-terminal-background,var(--vscode-editor-background))] border border-[var(--vscode-panel-border)] rounded p-3 overflow-x-auto my-2 font-mono text-[0.9em] whitespace-pre-wrap">
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
      // No plugins: avoids Shiki WASM CSP issues in VS Code webview
      plugins={[]}
    >
      {children}
    </Streamdown>
  );
};
```

---

### Step 4 — Add Markdown Prose Styles

Streamdown renders semantic HTML elements (`<h1>`–`<h6>`, `<ul>`, `<ol>`, `<table>`, `<blockquote>`, etc.) that need base styles. Add a scoped CSS block in `globals.css` so these elements look appropriate in the VS Code theme context.

**In `src/ui/webview-react/styles/globals.css`:**

```css
/* ─── Streamdown Markdown Prose Styles ─────────────────────────────────────── */
.markdown-text {
  color: var(--vscode-editor-foreground);
  font-size: 12px;
  line-height: 1.6;
}

.markdown-text h1,
.markdown-text h2,
.markdown-text h3,
.markdown-text h4,
.markdown-text h5,
.markdown-text h6 {
  font-weight: 600;
  margin-top: 1em;
  margin-bottom: 0.4em;
  color: var(--vscode-foreground);
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 0.2em;
}

.markdown-text h1 { font-size: 1.4em; }
.markdown-text h2 { font-size: 1.2em; }
.markdown-text h3 { font-size: 1.1em; }
.markdown-text h4, .markdown-text h5, .markdown-text h6 { font-size: 1em; }

.markdown-text p {
  margin: 0.5em 0;
}

.markdown-text ul,
.markdown-text ol {
  padding-left: 1.4em;
  margin: 0.5em 0;
}

.markdown-text li {
  margin: 0.2em 0;
}

/* Task list checkboxes */
.markdown-text input[type="checkbox"] {
  margin-right: 0.4em;
  accent-color: var(--vscode-checkbox-selectBackground, #007acc);
}

.markdown-text blockquote {
  border-left: 3px solid var(--vscode-textBlockQuote-border, #007acc);
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
  padding: 0.3em 0.8em;
  margin: 0.5em 0;
  color: var(--vscode-descriptionForeground);
}

.markdown-text table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 0.9em;
}

.markdown-text th,
.markdown-text td {
  border: 1px solid var(--vscode-panel-border);
  padding: 4px 8px;
  text-align: left;
}

.markdown-text th {
  background: var(--vscode-sideBar-background);
  font-weight: 600;
}

.markdown-text tr:nth-child(even) td {
  background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.05));
}

.markdown-text hr {
  border: none;
  border-top: 1px solid var(--vscode-panel-border);
  margin: 1em 0;
}

.markdown-text strong {
  font-weight: 700;
  color: var(--vscode-foreground);
}

.markdown-text em {
  font-style: italic;
}

.markdown-text del {
  text-decoration: line-through;
  color: var(--vscode-descriptionForeground);
}

/* Streaming caret color */
[data-streamdown="caret"] {
  background-color: var(--vscode-editorCursor-foreground, var(--vscode-foreground));
}
```

---

### Step 5 — Update `CliOutput.tsx` to Use `MarkdownText`

The `CliOutput.tsx` component contains `TextOutput` (or equivalent inline rendering) for `CLI_EVENT_TYPES.TEXT` events. Replace the plain text rendering with `<MarkdownText>`.

#### 5a — For Structured TEXT Events

Find the text event renderer inside `CliOutput.tsx` (or in the event renderer switch). Replace plain text display:

```tsx
// BEFORE (approximate current pattern):
case CLI_EVENT_TYPES.TEXT:
  return (
    <div className="text-[var(--vscode-editor-foreground)] whitespace-pre-wrap px-3 py-1">
      {event.data.text}
    </div>
  );

// AFTER:
import { MarkdownText } from "./MarkdownText";

case CLI_EVENT_TYPES.TEXT:
  return (
    <div className="px-3 py-1">
      <MarkdownText animated={false}>
        {event.data.text}
      </MarkdownText>
    </div>
  );
```

#### 5b — For Streaming Text Chunks (Plain Text Fallback)

In the streaming render path where `streamingChunk` is displayed before structured events arrive:

```tsx
// BEFORE:
<div className="whitespace-pre-wrap text-[var(--vscode-editor-foreground)] px-3 py-1">
  {streamingChunk}
</div>

// AFTER:
<div className="px-3 py-1">
  <MarkdownText animated={output.isStreaming}>
    {streamingChunk}
  </MarkdownText>
</div>
```

> **Key**: `animated={output.isStreaming}` enables the per-word fade animation while the response is live. Set to `false` (or omit) once the final output is received.

#### 5c — For THINKING Blocks

The `ThinkingOutput` component renders Claude's thinking/reasoning content inside a collapsible block. Apply `MarkdownText` to the inner content:

```tsx
// BEFORE:
<div className="whitespace-pre-wrap text-[var(--vscode-descriptionForeground)]">
  {thinking.text}
</div>

// AFTER:
<div className="text-[var(--vscode-descriptionForeground)]">
  <MarkdownText>
    {thinking.text}
  </MarkdownText>
</div>
```

---

### Step 6 — Export `MarkdownText` from the Output Index

**In `src/ui/webview-react/components/output/index.ts`:**

```ts
export { MarkdownText } from "./MarkdownText";
```

---

## What Does NOT Change

These components keep their current rendering unchanged — they represent structured tool interactions, not AI text content, and already have purpose-built UI:

- `BashOutput` — Terminal-style command/output blocks
- `FileEditOutput` — Unified diff viewer with color-coded additions/deletions
- `FileWriteOutput` — File creation display
- `FileReadOutput` — File read display
- `FileDeleteOutput` — File deletion display
- `McpToolCallOutput` — MCP server calls
- `WebSearchOutput` — Web search results
- `GenericToolCallOutput` — Generic tool calls
- `ToolResultOutput` — Tool execution results
- `StatusMessage` — Info/warning/error status messages

---

## File Change Summary

| File | Change Type | Description |
|---|---|---|
| `src/ui/webview-react/package.json` | Dependency | Add `"streamdown": "^2.2.0"` |
| `src/ui/webview-react/styles/globals.css` | Config + Styles | Add `@source` for Tailwind, import `streamdown/styles.css`, add `.markdown-text` prose styles |
| `src/ui/webview-react/components/output/MarkdownText.tsx` | New file | Wrapped Streamdown component with VS Code theme customizations |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Edit | Use `MarkdownText` for TEXT event type and streaming chunk display |
| `src/ui/webview-react/components/output/index.ts` | Edit | Export `MarkdownText` |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Streamdown's Tailwind classes not scanned → unstyled output | Medium | Add `@source` directive; verify with a build |
| `code` plugin CSP error if accidentally imported | High if imported | Do not import `@streamdown/code`; use custom `pre`/`code` components |
| CDN fetch blocked (Shiki grammar loading) | High if code plugin used | Confirmed: not using code plugin |
| Bundle size increase | Low-Medium | Base Streamdown (no plugins) is substantially smaller than v1; monitor with `npm run build:webview` |
| AI response contains no/little markdown | Low risk | Streamdown renders plain text fine; no visual regression |
| `animated` prop causing jank on large responses | Medium | Only set `animated={true}` while `isStreaming === true`; once final output arrives it stops |
| Tailwind v4 `@source` syntax differs | Low | Verify during Step 2; fallback is adding to content array |

---

## Optional Future Enhancements

1. **Syntax highlighting (post-CSP decision)**: If we decide to add `wasm-unsafe-eval` to the webview CSP, enable the `@streamdown/code` plugin with a VS Code-adjacent Shiki theme (`'dark-plus'` / `'light-plus'`). This would be controlled via a VS Code theme color (`data-vscode-theme-kind` attribute on `<body>`).

2. **Math rendering**: If AI responses contain LaTeX, the `@streamdown/math` plugin (KaTeX — no WASM) can be added. KaTeX works in VS Code webviews and doesn't require CSP changes.

3. **Custom code highlighting (no WASM)**: Use `highlight.js` in the custom `components.code` override as an alternative to Shiki for syntax coloring without CSP concerns.

4. **VS Code theme awareness**: Read `document.body.getAttribute('data-vscode-theme-kind')` (`'vscode-dark'`, `'vscode-light'`, `'vscode-high-contrast'`) and dynamically adjust the `MarkdownText` CSS variable overrides.

---

## References

- [Streamdown Documentation](https://streamdown.ai/docs)
- [Streamdown GitHub (vercel/streamdown)](https://github.com/vercel/streamdown)
- [Streamdown npm](https://www.npmjs.com/package/streamdown)
- [Streamdown v2 announcement](https://vercel.com/changelog/streamdown-v2)
- [Streamdown 2.2 changelog](https://vercel.com/changelog/streamdown-2-2)
- [VS Code webview CSP + WASM issue](https://github.com/microsoft/vscode-extension-samples/issues/366)
- [FlightPath CliOutput.tsx](../../src/ui/webview-react/components/output/CliOutput.tsx)
- [FlightPath OutputSection.tsx](../../src/ui/webview-react/components/layout/OutputSection.tsx)
