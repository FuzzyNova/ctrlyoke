# Side-by-Side Diff View Plan

## Background

`DiffView` currently renders diffs in **unified (inline) format** — added and removed lines
stacked vertically with `+`/`-` prefixes. This is compact but harder to read when hunks have
many paired line changes. When the panel is wide enough, a split-column layout (old on the
left, new on the right) is far more readable.

The existing `useElementNarrow` hook already solves the responsive-width problem: it uses
`ResizeObserver` to track an element's rendered width, re-firing correctly after
collapse/expand cycles. We can use it with a **1024 px threshold** — below that, fall back to
the existing inline view; at or above that, render side by side.

All `DiffView` consumers share the same component, so this change propagates everywhere with
no call-site updates.

---

## Scope

- **Only `DiffView.tsx` is modified** for the rendering logic.
- A small helper function is added to `@utils/outputUtils` (or inline in `DiffView.tsx` if
  it stays small) to pair unified diff lines into side-by-side rows.
- No schema changes, no new settings, no new stores.

---

## Data Model

`DiffLine` (from `outputUtils`) has fields:

```ts
type DiffLine = {
  type: "added" | "removed" | "context";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
};
```

For side-by-side rendering we need **row pairs** — one optional left cell (removed/context)
and one optional right cell (added/context). A helper converts the flat `DiffLine[]` into
`SideBySideRow[]`:

```ts
type SideBySideRow = {
  left: DiffLine | null;   // removed or context
  right: DiffLine | null;  // added or context
};
```

### Pairing algorithm

Process the `DiffLine[]` hunk by hunk. Within each changed block (consecutive
`removed`/`added` lines), zip removed lines with added lines in order — if one side has more
lines, pad the shorter side with `null`. Context lines always produce a symmetric row
(`left === right` conceptually, rendered in both columns with the same content).

```
removed A   →  left: removed A  |  right: added A'
removed B   →  left: removed B  |  right: null
added  A'          ↑ zipped in order
context C   →  left: context C  |  right: context C
```

This matches the behaviour of standard diff UIs (GitHub, VS Code's built-in diff editor).

---

## Implementation Steps

### 1. Add `buildSideBySideRows` to `outputUtils.ts`

```ts
export function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[] { ... }
```

The algorithm:
1. Iterate `lines`.
2. Collect consecutive `removed` lines into a buffer, then pair them with the immediately
   following `added` lines (zip, pad shorter side with `null`).
3. `context` lines flush any open removed/added buffers first, then emit a symmetric row.
4. Flush any remaining removed/added buffer at end of input.

Export `SideBySideRow` type alongside the function.

### 2. Wire `useElementNarrow` into `DiffView`

```tsx
const SIDE_BY_SIDE_THRESHOLD = 1024;
const [wideRef, isWide] = useElementNarrow<HTMLDivElement>(SIDE_BY_SIDE_THRESHOLD);
// isWide = true when width >= threshold (useElementNarrow returns isNarrow,
// so: const isWide = !isNarrow)
```

Attach `wideRef` to the existing outer wrapper `<div>` (the one currently assigned
`wrapperRef`). Since we also need `wrapperRef` for the `data-diff-collapsed` propagation
effect, **merge the two refs** using a small `mergeRefs` utility (or just two separate refs
attached via a callback ref pattern).

Alternatively: rename `wrapperRef` and pass a combined callback ref that updates both
`wrapperRef.current` and the `ResizeObserver` node.

### 3. Compute `sideBySideRows` lazily (memoised)

```ts
const sideBySideRows = useMemo(
  () => (isExpanded && isWide ? buildSideBySideRows(diffLines) : []),
  [isExpanded, isWide, diffLines]
);
```

Only computed when both expanded and wide — zero cost in the common collapsed or narrow case.

### 4. Branch the render

```tsx
{isExpanded && diffLines.length > 0 && (
  isWide
    ? <SideBySideDiffTable rows={sideBySideRows} highlightedLines={highlightedLines} />
    : <InlineDiffList lines={diffLines} highlightedLines={highlightedLines} />
)}
```

Extract the existing inline render into `InlineDiffList` (internal component or just a
render helper inside `DiffView.tsx` — no need for a separate file).

### 5. `SideBySideDiffTable` layout

Render a CSS grid or flex table with two equal-width columns. Each row:

```
| old-line-num | removed-content | new-line-num | added-content |
```

- Line number columns: `w-10 shrink-0` (same sizing as current inline view).
- Content columns: `flex-1 min-w-0` with `overflow-x: auto` independently per cell so very
  long lines don't force the other column to scroll.
- Row background: split — left cell gets `bg-diff-removed-bg` when `removed`, right cell gets
  `bg-diff-added-bg` when `added`. Both cells get `bg-transparent` for context rows.
- A vertical divider (`border-r border-diff-line-num`) between the two halves.

HLJS highlighting: the existing `highlightedLines` array is indexed by the **original**
`DiffLine` index. `SideBySideRow` must carry the original indices so the highlighted HTML
can be looked up correctly. Extend `SideBySideRow`:

```ts
type SideBySideRow = {
  left:  { line: DiffLine; originalIndex: number } | null;
  right: { line: DiffLine; originalIndex: number } | null;
};
```

### 6. Toggle label update

The "Show diff / Hide diff" header label already works for both views. No change needed.
Optionally update the `title` attribute on the toggle button to hint at the current layout:
"Expand diff (side by side)" vs. "Expand diff".

---

## Styling Notes

- Use `grid grid-cols-2` or `flex` for the side-by-side container. `grid-cols-2` is simpler
  since both columns are always equal width.
- `overflow-x-auto` on the **outer container** (not per-cell) keeps horizontal scrolling
  unified so both columns scroll together — matches VS Code's diff editor behaviour.
- Keep the same `rounded-[3px]` border and `bg-vscode-bg` wrapper as the inline view.
- Line number columns use the existing `text-diff-line-num` token; removed side shows
  `oldLineNum`, added side shows `newLineNum`.

---

## Testing Checklist

- [ ] Narrow panel (< 1024 px): inline view renders correctly, no regressions.
- [ ] Wide panel (≥ 1024 px): side-by-side renders with correct pairing of removed/added.
- [ ] Context lines appear in both columns with same content.
- [ ] Hunks where removed count ≠ added count: shorter side padded with empty cells.
- [ ] HLJS highlighting applies correctly in both views.
- [ ] Collapse/expand works in both views; `data-diff-collapsed` attribute propagates.
- [ ] Global "Expand all / Collapse all" resets both views.
- [ ] `structuredPatch` path and `oldContent/newContent` path both produce correct rows.
- [ ] Resizing panel across the 1024 px boundary live-switches between views.
- [ ] Empty diff (`hasDiff === false`) still returns `null` in both views.

---

## Files Affected

| File | Change |
|------|--------|
| `src/ui/webview-react/components/output/DiffView.tsx` | Main render logic + `useElementNarrow` wiring |
| `src/ui/webview-react/utils/outputUtils.ts` | Add `buildSideBySideRows` + `SideBySideRow` type |

No other files need changes.

---

## Status

`NOT_IMPLEMENTED`
