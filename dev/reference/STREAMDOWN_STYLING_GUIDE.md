# Streamdown Styling Guide for VS Code Webviews

A practical reference for correctly styling Streamdown-rendered markdown (prose, tables, copy/download controls) inside a VS Code webview using Tailwind CSS v4 and VS Code CSS variables. ctrlyoke's own setup is in `src/ui/webview-react/styles/globals.css`.

---

## How Streamdown Styling Works

Streamdown ships compiled JS dist files containing Tailwind class name strings. The **host app's Tailwind** scans those files (via `content` / `@source`) and generates CSS using the host's own theme config. Streamdown does **not** bundle its own CSS for color/layout — it depends on the host.

Streamdown follows **shadcn/ui naming conventions** for color tokens. If your Tailwind config doesn't define those token names, the classes produce no output and elements appear unstyled.

---

## Step 1 — Scan Streamdown's Dist for Class Names

```css
/* globals.css — the path is relative to the stylesheet */
@source "../../../../node_modules/streamdown/dist/*.js";
```

Automatic source detection skips `node_modules`, so this line is required even without `source(none)`.

---

## Step 2 — Add Streamdown's Expected Color Tokens to Your Tailwind Config

Streamdown's table controls use these shadcn/ui token names. Map each to your theme's equivalent color variable:

```css
/* globals.css — these names must match exactly so Tailwind generates the
   right classes. 'foreground' is usually already defined; add the rest. */
@theme {
  --color-background: var(--vscode-editor-background);
  --color-sidebar: var(--vscode-sideBar-background);
  --color-border: var(--vscode-panel-border, transparent);
  --color-muted: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1));
  --color-muted-foreground: var(--vscode-descriptionForeground);
  --color-foreground: var(--vscode-foreground);
  --color-ring: var(--vscode-focusBorder, transparent);
}
```

This causes Tailwind to generate:

- `bg-background` → editor/content area background
- `bg-sidebar` → table wrapper card background
- `border-border` → table and dropdown border color
- `text-muted-foreground` → Copy/Download icon button default color
- `hover:text-foreground` → Copy/Download icon button hover color
- `bg-muted` → subtle background (used in hover states)
- `text-muted-foreground` → dimmed text color

---

## Step 3 — Import Streamdown's Animation Styles

Streamdown's `styles.css` provides animation keyframes for the streaming caret and word fade-in. Import it into the `base` layer ahead of Tailwind, so utilities still win over it:

```css
@layer theme, base, components, utilities;
@import "streamdown/styles.css" layer(base);
@import "tailwindcss";
```

Streamdown's dist also carries `dark:` classes for Shiki's dual themes. Tailwind 4's default `dark:` follows the OS `prefers-color-scheme`, not the VS Code theme, so declare a class-based variant (`@custom-variant dark (&:where(.dark, .dark *));`) to keep them under your control.

---

## Step 4 — Style the Prose Elements

Streamdown renders semantic HTML (`<h1>`–`<h6>`, `<ul>`, `<table>`, `<blockquote>`, etc.) with no base styles. Scope prose styles using the className you pass to `<Streamdown className="markdown-text">`:

```css
.markdown-text {
  color: var(--vscode-editor-foreground);
  font-size: 12px;
  line-height: 1.6;
}
.markdown-text h1,
.markdown-text h2,
.markdown-text h3 {
  font-weight: 600;
  margin-top: 1em;
}
.markdown-text p {
  margin: 0.5em 0;
}
.markdown-text ul,
.markdown-text ol {
  padding-left: 1.4em;
  margin: 0.5em 0;
}
.markdown-text blockquote {
  border-left: 3px solid var(--vscode-textBlockQuote-border, #007acc);
}
.markdown-text table {
  border-collapse: collapse;
  width: 100%;
}
.markdown-text th,
.markdown-text td {
  border: 1px solid var(--vscode-panel-border);
  padding: 4px 8px;
}
```

Alternatively use `[data-streamdown="..."]` attribute selectors (see Step 5) for scoping without an extra className.

---

## Step 5 — Style Table Controls via `data-streamdown` Selectors

Every Streamdown element has a `data-streamdown` attribute you can target:

```css
[data-streamdown="table-wrapper"]   /* outer card */
[data-streamdown="table"]           /* <table> element */
[data-streamdown="table-header"]    /* <thead> */
[data-streamdown="table-body"]      /* <tbody> */
[data-streamdown="table-row"]       /* <tr> */
[data-streamdown="table-header-cell"] /* <th> */
[data-streamdown="table-cell"]      /* <td> */
```

**The Copy and Download buttons have no `data-streamdown` attribute.** Target them via descendant selectors from the wrapper.

---

## Step 6 — Fix the Gaps Streamdown's Classes Leave

### Gap 1: Dropdown Panel Background

Streamdown uses `bg-background` for both the table area and dropdown panels, but dropdowns should use the dropdown-specific background color. Override explicitly:

```css
/* Target dropdown panels via :has() — matches the div whose direct children
   are the full-width format buttons (CSV, TSV, Markdown).
   :has() requires Chromium 105+, supported in all modern VS Code versions. */
[data-streamdown="table-wrapper"] div:has(> button[class*="w-full"]) {
  background-color: var(
    --vscode-dropdown-background,
    var(--vscode-editor-background)
  );
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
}
```

### Gap 2: Dropdown Item Hover

Under Tailwind v3, opacity modifiers (e.g. `bg-muted/40`) were silently dropped when the color value is a CSS variable, because v3 cannot decompose a `var(...)` into RGB channels. **Tailwind v4 fixes this** by emitting `color-mix()`, so `bg-muted/40` now renders as a 40% tint of the hover color. The explicit rule below is only needed if you want the dropdown-specific colors instead:

```css
/* Dropdown item text color */
[data-streamdown="table-wrapper"] div:has(> button[class*="w-full"]) button {
  color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground));
}

/* Dropdown item hover — replaces the non-functional bg-muted/40 */
[data-streamdown="table-wrapper"]
  div:has(> button[class*="w-full"])
  button:hover {
  background-color: var(
    --vscode-list-hoverBackground,
    rgba(127, 127, 127, 0.15)
  );
  color: var(--vscode-list-hoverForeground, var(--vscode-foreground));
}
```

**Why `button[class*="w-full"]` is safe:** icon trigger buttons have `p-1` padding and no `w-full` class; only the dropdown item buttons are full-width. The selector correctly ignores the trigger buttons.

---

## Quick Reference: What Each Token Controls

| Streamdown class        | Token needed       | Controls                                                  |
| ----------------------- | ------------------ | --------------------------------------------------------- |
| `bg-sidebar`            | `sidebar`          | Outer table wrapper card background                       |
| `bg-background`         | `background`       | Inner table area + dropdown panel background              |
| `border-border`         | `border`           | Table wrapper border, inner table border, dropdown border |
| `text-muted-foreground` | `muted-foreground` | Copy/Download icon button default color                   |
| `hover:text-foreground` | `foreground`       | Copy/Download icon button hover color                     |
| `bg-muted`              | `muted`            | Hover background base (`/40` modifier works in v4)        |
| `ring-ring`             | `ring`             | Focus rings                                               |
| `shadow-lg`             | (built-in)         | Dropdown panel drop shadow                                |

---

## Hiding the Download Button in VS Code Webviews

The Download table button uses a standard blob anchor click (`a.href = URL.createObjectURL(blob); a.click()`) to trigger a file save. **VS Code webviews block this** — the click is silently swallowed and nothing happens.

There is no built-in Streamdown prop to hide only the download button while keeping the copy button. The `controls` prop accepts `{ table: boolean }` — a single toggle for both buttons together. (Unlike `mermaid` controls, which do support per-button granularity.)

**Solution: CSS structural selector**

The controls bar is always the last direct-child `<div>` of `[data-streamdown="table-wrapper"]`, and within it the Download dropdown is always last:

```css
/* Hide the Download table dropdown wrapper (last child of the controls bar) */
[data-streamdown="table-wrapper"] > div:last-child > div:last-child {
  display: none;
}
```

This selector is safe when `controls={{ table: false }}` (no controls bar rendered) because the table scroller's only direct child is a `<table>` element, not a `<div>`, so the selector matches nothing.

**Alternative: make download work via VS Code API**

If you want downloads to actually work, you can intercept the blob anchor click in the webview and route it through the extension:

1. In the webview, add a global `click` listener that captures `<a download>` events, reads the `blob:` URL via `fetch()`, base64-encodes the content, and sends it to the extension via `postMessage`.
2. In the extension, handle the message with `vscode.window.showSaveDialog()` followed by `vscode.workspace.fs.writeFile()`.

This is the correct approach for VS Code — it gives users a native save dialog and writes to disk with full workspace permissions.

---

## Avoiding the `@streamdown/code` Plugin in VS Code Webviews

The Shiki syntax-highlighting plugin (`@streamdown/code`) uses WebAssembly and loads grammars from a CDN — both blocked in VS Code webviews by the default Content Security Policy. **Do not import it.** Use a custom `components.pre` / `components.code` override with `highlight.js` instead (no WASM, no CDN required).

---

## Streaming Caret Color

```css
[data-streamdown="caret"] {
  background-color: var(
    --vscode-editorCursor-foreground,
    var(--vscode-foreground)
  );
}
```
