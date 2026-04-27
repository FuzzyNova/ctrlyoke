# Plan: Migrate Webview Syntax Highlighting from `highlight.js` to `refractor`

## Status: Proposed

---

## Context

The webview currently ships two syntax-highlighting stacks:

1. `highlight.js`
2. `refractor` (already present because `react-diff-view` uses it)

That split is visible in the current code:

- `src/ui/webview-react/components/output/DiffView.tsx` already renders diffs through `react-diff-view` and calls `tokenize(..., { refractor })`.
- `src/ui/webview-react/components/output/MarkdownText.tsx` still calls `highlightCode()` from `src/ui/webview-react/utils/hljsUtils.ts`, which produces `hljs` HTML strings for fenced code blocks.
- `src/ui/webview-react/utils/hljsUtils.ts` is now a mixed-ownership module:
  - it registers `highlight.js` languages
  - it exports `highlightCode()`
  - it exports `getLanguageFromPath()`
  - it injects both `.hljs-*` theme rules and `.token.*` theme rules for `refractor` output in diffs

So the dependency duplication is real, and the current ownership boundaries are no longer coherent.

---

## Current State Audit

### What is already on the `refractor` path

- `DiffView.tsx` uses `react-diff-view` tokenization and `markEdits()`.
- `rdvAdapter.ts` exports the shared `refractor` instance consumed by `DiffView`.
- `hljsUtils.ts` already contains a separate `DIFF_REFRACTOR_STYLES` block for Prism-style `.token.*` classes.

### What still depends on `highlight.js`

- `MarkdownText.tsx` fenced code blocks
- `hljsUtils.ts` language registration and `highlightCode()`
- Test mocks that stub `@utils/hljsUtils` in:
  - `MarkdownText.test.tsx`
  - `DiffView.test.tsx`
  - `CliOutput.test.tsx`
  - `FileOperationOutput.test.tsx`
  - `UndoChangesDialog.test.tsx`

### Structural problems to fix during migration

1. **Language ownership is split**
   - `getLanguageFromPath()` returns names documented as `hljs` identifiers.
   - `rdvAdapter.normalizeLanguage()` patches only `tsx -> typescript` and `jsx -> javascript`.
   - There is no single alias/registration table for both markdown blocks and diffs.

2. **Theme ownership is split**
   - `injectHljsStyles()` injects both `hljs` and `refractor` theme CSS.
   - The function name and file name imply `highlight.js`, but half the styles are no longer `highlight.js`.

3. **Rendering model is inconsistent**
   - `MarkdownText` expects an HTML string and uses `dangerouslySetInnerHTML`.
   - `DiffView` uses token objects from `refractor`.
   - A complete migration needs one supported rendering path for syntax-highlighted code blocks.

4. **Dependency removal is currently blocked**
   - `package.json` still declares both `highlight.js` and `refractor`.
   - We cannot remove `highlight.js` until `MarkdownText` is migrated.

---

## Goal

Use `refractor` as the only syntax-highlighting engine in the webview, then remove `highlight.js` from `package.json`.

Success means:

- diffs and fenced markdown code blocks use the same language registry
- there is one shared theme injector for syntax tokens
- `getLanguageFromPath()` is no longer described in `hljs` terms
- `rg "highlight.js|hljs"` returns only intentional leftovers (migration docs or class names kept temporarily), not active runtime ownership
- `package.json` no longer depends on `highlight.js`

---

## Non-Goals

- Replacing `react-diff-view`
- Reworking the diff UX or collapse behavior in `DiffView`
- Introducing Shiki or any async/WASM highlighter into the VS Code webview
- Re-theming markdown prose outside syntax-highlighted code blocks

---

## Proposed End State

Create a single webview syntax-highlighting utility that owns:

- `refractor` language registration
- file-extension/language alias mapping
- shared theme CSS injection for Prism-style `.token.*` output
- markdown fenced-code rendering support
- diff tokenization support

At that point:

- `DiffView.tsx` imports the shared `refractor` instance and language helpers from the new utility
- `MarkdownText.tsx` renders fenced code blocks through the same utility
- `hljsUtils.ts` is deleted or renamed and repurposed as a neutral syntax module

---

## Key Design Decision

### `MarkdownText` needs a `refractor` rendering strategy

`highlight.js` returns HTML directly. `refractor` returns a HAST tree.

That means the migration needs one of these approaches:

1. **Preferred: render `refractor` output to React nodes**
   - Keeps rendering typed and avoids additional HTML-string plumbing.
   - Best fit for React code already customizing `<code>` and `<pre>`.

2. **Alternative: serialize the HAST tree to HTML**
   - Closer to the current `dangerouslySetInnerHTML` flow.
   - Simpler migration if we want to minimize changes in `MarkdownText`.

The implementation should choose one path explicitly and use it everywhere for fenced code blocks. Do not keep both.

---

## Implementation Plan

### Phase 1: Establish a neutral shared syntax module

Create or rename a utility module so it no longer implies `highlight.js` ownership.

Recommended target:

- `src/ui/webview-react/utils/syntaxHighlighting.ts`

Move these responsibilities into it:

- shared `refractor` instance export
- language registration
- file-extension to canonical language mapping
- alias normalization used by both markdown and diffs
- shared token theme injection

This phase should also rename:

- `injectHljsStyles()` -> `injectSyntaxHighlightStyles()`
- `getLanguageFromPath()` docs/comments so they refer to canonical syntax languages, not `hljs`

### Phase 2: Centralize language registration and aliases

Replace the current split tables with one authoritative registry.

It should cover at least the languages already mapped today:

- TypeScript / TSX
- JavaScript / JSX / MJS / CJS
- Python
- Bash / shell
- JSON
- YAML
- CSS / SCSS
- HTML / XML / SVG
- Markdown
- Rust
- Go
- Java
- C#
- C / C++

Also absorb the alias behavior currently split across two files:

- `tsx -> typescript`
- `jsx -> javascript`
- extension aliases like `sh`, `yml`, `cs`, `hpp`, etc.

The important constraint is that `MarkdownText` and `DiffView` must resolve the same input path or code-fence language to the same canonical language name.

### Phase 3: Migrate `MarkdownText` off `highlight.js`

Replace the fenced-code path in `MarkdownText.tsx`:

- remove `highlightCode()`
- use the shared `refractor`-based renderer
- keep the existing inline-code behavior unchanged

This is the real dependency-removal step. Until this is done, the migration is incomplete.

Implementation note:

- Keep the current behavior where unknown or unsupported languages fall back safely to plain escaped text rather than throwing.
- Preserve the current `language-*` class handling from Streamdown.

### Phase 4: Point `DiffView` at the same shared module

`DiffView` is already mostly migrated, but it should stop depending on `hljsUtils.ts` for style injection.

Cleanups:

- import the shared style injector from the neutral syntax module
- import language normalization from the same module instead of keeping `rdvAdapter.normalizeLanguage()` as a partial side table
- keep `rdvAdapter.ts` focused on diff-shape adaptation, not syntax-language ownership

### Phase 5: Remove dead `highlight.js` code

Once `MarkdownText` is migrated:

- delete `highlightCode()`
- delete `hljs` language imports and registration
- delete `.hljs-*` theme CSS
- delete or rename `hljsUtils.ts`
- update all imports
- remove `highlight.js` from `package.json`

### Phase 6: Update tests

Tests currently mock `@utils/hljsUtils`. Those mocks need to follow the new module/API.

Minimum update set:

- `src/ui/webview-react/test/components/output/MarkdownText.test.tsx`
- `src/ui/webview-react/test/components/output/DiffView.test.tsx`
- `src/ui/webview-react/test/components/output/CliOutput.test.tsx`
- `src/ui/webview-react/test/components/output/FileOperationOutput.test.tsx`
- `src/ui/webview-react/test/components/output/UndoChangesDialog.test.tsx`

Add at least one markdown-focused test for the new fenced-code path:

- supported language renders highlighted token markup
- unsupported language falls back safely
- shared style injector is still side-effect-safe in tests

---

## File-Level Change List

### Must change

- `src/ui/webview-react/components/output/MarkdownText.tsx`
- `src/ui/webview-react/components/output/DiffView.tsx`
- `src/ui/webview-react/utils/hljsUtils.ts` or its replacement module
- `src/ui/webview-react/utils/rdvAdapter.ts`
- `package.json`

### Likely import-only or comment updates

- `src/ui/webview-react/components/output/FileOperationOutput.tsx`
- `src/ui/webview-react/components/output/UndoChangesDialog.tsx`

### Test updates

- `src/ui/webview-react/test/components/output/MarkdownText.test.tsx`
- `src/ui/webview-react/test/components/output/DiffView.test.tsx`
- `src/ui/webview-react/test/components/output/CliOutput.test.tsx`
- `src/ui/webview-react/test/components/output/FileOperationOutput.test.tsx`
- `src/ui/webview-react/test/components/output/UndoChangesDialog.test.tsx`

---

## Risks

### 1. Language-name mismatch between fences, file paths, and `refractor`

This is the highest-likelihood regression. The current code already relies on translation layers:

- `getLanguageFromPath()`
- `normalizeLanguage()`

If those stay split, some code blocks will silently stop highlighting.

### 2. Markdown rendering regressions

`MarkdownText` currently depends on HTML output. Moving to `refractor` changes the render model. Regression risk is concentrated in:

- whitespace preservation
- CSS selector coverage for token classes
- safe fallback for unsupported languages

### 3. Theme drift between diffs and markdown blocks

Today the file carries two different token vocabularies:

- `.hljs-*`
- `.token.*`

If the migration keeps old selectors around unnecessarily, theme maintenance stays confusing. If it removes them too early, markdown blocks lose color.

---

## Verification Plan

### Automated

Run:

1. `npm run build:webview`
2. `npm run compile`
3. targeted webview tests for markdown and diff output

### Manual

Verify in the webview:

1. fenced TypeScript block in markdown
2. fenced JSON block in markdown
3. fenced bash block in markdown
4. unknown-language fenced block falls back cleanly
5. file-operation diffs still highlight correctly
6. undo dialog diffs still highlight correctly
7. diff expand/collapse behavior remains unchanged

### Dependency check

After code migration:

1. `rg "highlight\\.js|hljsUtils|highlightCode\\(" src/ui/webview-react`
2. confirm only intentional leftovers remain
3. remove `highlight.js` from `package.json`

---

## Recommended Execution Order

1. Introduce the neutral syntax module and central alias registry.
2. Move `DiffView` style injection and language normalization onto that module.
3. Migrate `MarkdownText` fenced code rendering to `refractor`.
4. Update tests to the new API.
5. Delete `highlight.js` code and dependency.

This order keeps the migration incremental and makes dependency removal the last, low-risk cleanup step rather than the first.
