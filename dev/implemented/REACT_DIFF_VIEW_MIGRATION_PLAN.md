# Plan: Replace Custom DiffView with `react-diff-view`

## Status: Proposed

---

## Context

We have a custom `DiffView.tsx` (~390 lines) backed by `diffUtils.ts` (~240 lines) and a custom async HLJS highlighting pipeline. Several bugs have been found and fixed in this custom diff renderer. The user also wants collapsible context sections (GitHub-style "N hidden lines" between hunks). Rather than continuing to patch a bespoke renderer, this plan evaluates replacing it with `react-diff-view` and outlines the migration.

---

## Evaluation: Is react-diff-view a Good Fit?

### Yes — Key reasons

1. **Battle-tested**: Actively maintained, GitHub-inspired design, ~92.9% TypeScript, full type definitions. Far more test coverage than our custom code.

2. **Both display modes already built in**: `viewType="split"` and `viewType="unified"` map directly to our current side-by-side and inline modes — no custom table/layout code needed.

3. **Collapsible context hunks (the requested feature)**: The library ships `getCollapsedLinesCountBetween`, `expandFromRawCode`, and `addStubHunk` utilities specifically for this. Combined with the `Decoration` component we can render a "▸ 42 hidden lines" row between hunks and expand on click — exactly like GitHub.

4. **Inline word-level diffs**: The `markEdits()` enhancer highlights character-level differences within changed lines for free. Our current renderer has no equivalent.

5. **Theming via CSS variables**: `react-diff-view/style/index.css` exposes `--diff-gutter-insert-background-color`, `--diff-gutter-delete-background-color`, etc. These map cleanly to our existing VS Code theme tokens — one short CSS block in `index.css` wires everything up.

6. **ESM support**: Available via `react-diff-view/esm` for Vite tree-shaking.

### Concerns to manage

| Concern | Impact | Mitigation |
|---|---|---|
| Input format mismatch — we receive `UnifiedDiffHunk[]` or raw old/new content, not git unified diff text | Medium | Write a thin `toRdvHunks()` adapter (see below); avoids round-tripping through a string |
| Refractor peer dep for syntax highlighting | Low | Add `refractor` + language registrations; replaces HLJS. Only register languages we actually use. |
| CSS file alongside Tailwind | Low | Import `react-diff-view/style/index.css` in `index.css`; override variables with our VS Code tokens |
| Bundle size increase | Low | react-diff-view itself is small; refractor registers only used languages |
| `oldContent`/`newContent` full-file diff path | Low | Use existing `diff` library's `createPatch()` then feed to `parseDiff()` |

---

## Input Format Mapping

We need a function that converts our internal `UnifiedDiffHunk[]` to the hunk objects react-diff-view expects. We do **not** need to serialize to a diff string and re-parse; we can construct the objects directly.

react-diff-view's hunk shape (from its TypeScript types):
```ts
interface Hunk {
  content: string;           // "@@ -oldStart,oldLines +newStart,newLines @@"
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: Change[];
}

// Change is one of:
type Change =
  | { type: "normal"; oldLineNumber: number; newLineNumber: number; content: string; }
  | { type: "insert"; lineNumber: number; content: string; }
  | { type: "delete"; lineNumber: number; content: string; }
```

Our `UnifiedDiffHunk.lines` already carries the `+`/`-`/` ` prefixes, so the adapter is straightforward:

```ts
// src/ui/webview-react/utils/rdvAdapter.ts
import type { UnifiedDiffHunk } from "../types/cliEvents";
import type { Hunk, Change } from "react-diff-view";

export function toRdvHunks(hunks: UnifiedDiffHunk[]): Hunk[] { ... }
```

For the `oldContent`/`newContent` path we use `diff.createPatch()` (already a dependency) and pass the result to react-diff-view's `parseDiff()`.

---

## New Component Architecture

```
DiffView.tsx  (public API unchanged — same props)
  ├── uses parseDiff() or toRdvHunks() to build RDV hunk array
  ├── uses tokenize() + refractor for async syntax highlighting
  ├── Diff (viewType="split" | "unified")
  │     ├── Decoration  ← "N hidden lines ▸" rows between hunks
  │     └── Hunk        ← one per hunk
  └── collapse toggle + actionSlot (unchanged)
```

The external `DiffView` props interface stays identical so no callers change.

---

## Collapsible Context Hunk Feature

This is implemented with `getCollapsedLinesCountBetween` and `expandFromRawCode`:

```tsx
// Between every consecutive hunk pair, render a Decoration row:
{expandedHunks.map((hunk, i) => [
  i > 0 && (() => {
    const collapsed = getCollapsedLinesCountBetween(expandedHunks[i - 1], hunk);
    if (collapsed === 0) return null;
    return (
      <Decoration key={`gap-${i}`}>
        <button onClick={() => expand(i - 1, i, 10)}>
          ▸ {collapsed} hidden lines
        </button>
      </Decoration>
    );
  })(),
  <Hunk key={hunk.content} hunk={hunk} />,
])}
```

`expand()` calls `expandFromRawCode(hunks, sourceCode, start, end)` and merges the result via `insertHunk()`. This requires `oldContent` to be available for the expansion to work. When only a structured patch is supplied (no source), we show the collapsed line count but disable click-to-expand (or offer a "show all" fallback).

---

## Theming

**Approach**: Scoped CSS block in `src/ui/webview-react/styles/globals.css` — the same pattern already used for `.markdown-text` (Streamdown). Do **not** add more Tailwind tokens; react-diff-view's own CSS variable system is the right interface.

react-diff-view exposes 11 CSS variables. The full mapping to VS Code theme tokens (using the validated Dark+ defaults from `dev/reference/vscode-css-vars-defaultdark.json`):

| react-diff-view variable | VS Code variable | Dark+ fallback |
|---|---|---|
| `--diff-background-color` | `--vscode-editor-background` | `#121314` |
| `--diff-text-color` | `--vscode-editor-foreground` | `#bbbebf` |
| `--diff-font-family` | `--vscode-editor-font-family` | `Consolas, 'Courier New', monospace` |
| `--diff-selection-background-color` | `--vscode-editor-selectionBackground` | `rgba(39,103,130,0.87)` |
| `--diff-gutter-insert-background-color` | `--vscode-diffEditor-insertedLineBackground` | `rgba(52,125,57,0.15)` |
| `--diff-gutter-delete-background-color` | `--vscode-diffEditor-removedLineBackground` | `rgba(201,60,55,0.15)` |
| `--diff-code-insert-background-color` | `--vscode-diffEditor-insertedLineBackground` | `rgba(52,125,57,0.15)` |
| `--diff-code-delete-background-color` | `--vscode-diffEditor-removedLineBackground` | `rgba(201,60,55,0.15)` |
| `--diff-code-insert-edit-background-color` | `--vscode-diffEditor-insertedTextBackground` | `rgba(87,171,90,0.3)` |
| `--diff-code-delete-edit-background-color` | `--vscode-diffEditor-removedTextBackground` | `rgba(244,112,103,0.3)` |
| `--diff-omit-gutter-line-color` | `--vscode-diffEditor-unchangedRegionForeground` | `#bfbfbf` |

> **`insertedLineBackground` vs `insertedTextBackground`**: VS Code uses two distinct variables — `insertedLineBackground` (subtle, whole-line tint) for the row background, and `insertedTextBackground` (more saturated) for inline character-level highlights. The mapping above mirrors VS Code's own diff editor exactly. The old plan incorrectly used `insertedTextBackground` for both.

Add to the bottom of `src/ui/webview-react/styles/globals.css`:

```css
/* ============================================================================
   react-diff-view Theme
   ============================================================================
   Maps react-diff-view's 11 CSS variables to VS Code theme tokens.
   Scoped to .diff (the root class applied by the Diff component).
   Additional rules below cover gutter foreground, font size, and the
   collapsed-context (omit) row that react-diff-view variables don't expose.
   ============================================================================ */
@import "react-diff-view/style/index.css";

.diff {
  /* Base */
  --diff-background-color:          var(--vscode-editor-background);
  --diff-text-color:                var(--vscode-editor-foreground);
  --diff-font-family:               var(--vscode-editor-font-family, 'Consolas, Courier New, monospace');
  --diff-selection-background-color: var(--vscode-editor-selectionBackground, rgba(39,103,130,0.87));

  /* Insert (added) lines — full-line tint */
  --diff-gutter-insert-background-color:      var(--vscode-diffEditor-insertedLineBackground, rgba(52,125,57,0.15));
  --diff-code-insert-background-color:        var(--vscode-diffEditor-insertedLineBackground, rgba(52,125,57,0.15));
  /* Insert — inline word-level highlight (markEdits enhancer) */
  --diff-code-insert-edit-background-color:   var(--vscode-diffEditor-insertedTextBackground, rgba(87,171,90,0.3));

  /* Delete (removed) lines — full-line tint */
  --diff-gutter-delete-background-color:      var(--vscode-diffEditor-removedLineBackground, rgba(201,60,55,0.15));
  --diff-code-delete-background-color:        var(--vscode-diffEditor-removedLineBackground, rgba(201,60,55,0.15));
  /* Delete — inline word-level highlight */
  --diff-code-delete-edit-background-color:   var(--vscode-diffEditor-removedTextBackground, rgba(244,112,103,0.3));

  /* Omit row divider (the colored line in the gutter for collapsed context rows) */
  --diff-omit-gutter-line-color:    var(--vscode-diffEditor-unchangedRegionForeground, #bfbfbf);

  /* Font size — react-diff-view has no variable for this; set it on the container */
  font-size: var(--fp-output-font-size-sm);
}

/* Gutter column (line numbers) — smaller than code text, muted foreground */
.diff .diff-gutter {
  font-size: var(--fp-output-font-size-xs);
  color: var(--vscode-editorLineNumber-foreground, #858889);
}

/* Collapsed context stub row ("N hidden lines" decoration) */
.diff-omit,
.diff .diff-omit {
  background-color: var(--vscode-diffEditor-unchangedRegionBackground, var(--vscode-editor-background));
  color: var(--vscode-diffEditor-unchangedRegionForeground, #bfbfbf);
}
```

The existing Tailwind `diff-*` color tokens in `tailwind.config.js` (`diff-added-bg`, `diff-added-fg`, `diff-removed-bg`, `diff-removed-fg`, `diff-context-fg`, `diff-line-num`) can be removed once the migration is validated — they are only consumed by the old `DiffView.tsx`.

---

## Files Changed

| File | Change |
|---|---|
| `src/ui/webview-react/components/output/DiffView.tsx` | Full rewrite using `react-diff-view` components |
| `src/ui/webview-react/utils/rdvAdapter.ts` | **New** — `toRdvHunks()` adapter + `toRdvFromContent()` |
| `src/ui/webview-react/utils/diffUtils.ts` | Remove `buildSideBySideRows`, `parseUnifiedDiff`, `generateDiffLines` (replaced by adapter); keep `normalizeStructuredPatch`, `countStructuredPatchDisplayLines`, `isStructuredPatchMalformed` |
| `src/ui/webview-react/utils/hljsUtils.ts` | Remove `highlightLines` and `splitHighlightedHtml` only — `highlightCode`, `injectHljsStyles`, `getLanguageFromPath` stay (still used by `MarkdownText`, `FileOperationOutput`, `UndoChangesDialog`) |
| `src/ui/webview-react/utils/outputUtils.ts` | Update re-exports to remove deleted diffUtils exports |
| `src/ui/webview-react/styles/globals.css` | Add `@import "react-diff-view/style/index.css"` and the `.diff` theme block at the bottom |
| `src/ui/webview-react/tailwind.config.js` | Remove `diff-added-bg`, `diff-added-fg`, `diff-removed-bg`, `diff-removed-fg`, `diff-context-fg`, `diff-line-num` tokens once migration is validated |
| `package.json` (webview) | Add `react-diff-view`, `refractor`; remove `diff` if no other consumers |

---

## Implementation Steps

1. **Install packages** — `npm install react-diff-view refractor` in the webview package.

2. **Write `rdvAdapter.ts`** — `toRdvHunks(hunks: UnifiedDiffHunk[]): Hunk[]` and `toRdvFromContent(oldContent: string, newContent: string): { hunks: Hunk[]; type: DiffType }`. The content path uses `diff.createPatch()` → `parseDiff()`.

3. **Rewrite `DiffView.tsx`** — Keep the same props interface. Replace the diff computation with the adapter, replace the HLJS pipeline with `tokenize()` + `refractor`, replace the manual table rendering with `<Diff>` + `<Hunk>`. Preserve: `globallyCollapsed` / `diffResetVersion` expand logic, `actionSlot`, `useElementNarrow` for `split` vs `unified` mode switch, `data-diff-anchor` propagation effect.

4. **Implement collapsible hunks** — Add a `useState` for the current expanded hunk array. Render `<Decoration>` gap rows between hunks. Wire `expandFromRawCode` + `insertHunk` to expand on click (enabled only when `oldContent` is available).

5. **CSS theming** — Add the `@import` and `.diff` theme block to `styles/globals.css` as specified in the Theming section. Visually verify against Dark+, Light+, and a high-contrast theme.

6. **Clean up dead code** — Remove `buildSideBySideRows`, `parseUnifiedDiff`, `generateDiffLines` from `diffUtils.ts`; remove `highlightLines` and `splitHighlightedHtml` from `hljsUtils.ts` (do **not** remove the file — `MarkdownText`, `FileOperationOutput`, `UndoChangesDialog` still need it); update `outputUtils.ts` re-exports.

7. **Verify no TypeScript errors** — `npm run compile` from repo root; `npm run build:webview` for the Vite bundle.

8. **Manual QA** — Test with: (a) a structured patch from a Claude step, (b) a full-file old/new content edit, (c) the global collapse/expand buttons, (d) side-by-side vs inline layout change at the 1024 px threshold.

---

## What We Lose

- The async HLJS pipeline in `DiffView` (`highlightLines`, `splitHighlightedHtml`) — replaced by refractor + `tokenize()`. HLJS itself stays for `MarkdownText`.
- The manual side-by-side table implementation in `SideBySideDiffTable` / `SideBySideDiffCell` (~80 lines)
- The `+`/`-` prefix character in code lines — react-diff-view uses GitHub-style colored backgrounds without the prefix notation (improvement, not regression)
- The `diff` library dependency if `DiffView` is its only consumer — verify with `grep -r "from.*diff" src/ui/webview-react` before removing

## What We Gain

- GitHub-style collapsible context sections between hunks (the requested feature)
- Character-level inline diffs via `markEdits()`
- Far fewer custom rendering bugs — the library's internals are community-maintained
- ~230 fewer lines of bespoke diff logic to own
