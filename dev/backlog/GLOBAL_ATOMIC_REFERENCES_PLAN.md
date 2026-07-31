# Global Atomic Reference Formatting Plan

> **Status:** In progress — staged as seven steps (see Implementation phases)
>
> **Priority:** P2 — output readability and consistency

Extend the existing `ui.atomicContextReferences` presentation from the prompt
editor to every semantic local-code reference rendered inside `OutputPane`.
When the setting is enabled, clickable references use the same compact,
icon-bearing chip language as CodeMirror. When it is disabled, output keeps its
current link presentation.

The full source text remains the source of truth for copy, navigation, search,
and output export. A chip is only a view over that text.

---

## Goals

1. Use one reference parser and one presentation model for CodeMirror chips,
   echoed prompt references, Markdown local-file links, and structured file-tool
   headers.
2. Preserve the current click behavior for files, folders, selections, symbols,
   git references, and prior-context references.
3. Keep find-in-output searching the complete original text, including path
   segments hidden by a compact chip.
4. Make every counted find match visible when its row is rendered.
5. Keep the feature scoped to `OutputPane`; reusing `MarkdownText` in the
   workspace viewer must not silently turn preview links into output chips.
6. Preserve virtualization, streaming Markdown, syntax highlighting, accessible
   names, selection/copy behavior, and output export.

## Non-goals

- Do not make output chips editor-atomic. Output is read-only, so cursor motion
  and whole-token deletion remain CodeMirror-only behavior.
- Do not turn arbitrary path-looking text in shell output, generic tool output,
  code fences, inline code, or diff bodies into links. This work changes the
  presentation of references that are already semantic/clickable.
- Do not chip external HTTP, HTTPS, or mail links.
- Do not replace image thumbnails produced by `MarkdownText`; only their
  existing file-link fallback may use a chip.
- Do not perform output-time existence validation or symbol-kind requests.
  Output chips use known metadata and a stable fallback icon; editor validation
  remains responsible for invalid-state and asynchronously resolved symbol
  icons.
- Do not change the persisted output, workflow text, event payloads, search
  corpus, or exported text.

---

## Current state

### Prompt editor

`CodeMirrorEditor.tsx` currently owns too many layers of the feature:

- reference parsing (`findContextReferenceMatches`, fenced-block filtering, and
  inline prior-context parsing);
- compact labels and icons (`describeContextReferenceChip` and
  `describePriorContextChip`);
- the `AtomicReferenceChip` presentation shape;
- the CodeMirror replace widget and atomic range behavior;
- chip styling, while `codemirrorTheme.ts` owns the icon/accent color map.

`OutputRow.tsx` already imports the editor's parser to decorate echoed prompts.
That component-to-component dependency is the clearest sign that parsing and
presentation metadata need a shared home before the output feature expands.

`src/utils/FileReferenceParser.ts` is already the runtime single source for
`@file`, `#selection`, `#sym`, `~git`, and `$context` syntax. The UI parser has
partly duplicated those rules because it also needs exact source ranges and a
single discriminated match type. The implementation should close that gap,
not add a third parser for output.

### Output links

There are currently three relevant rendering paths beneath `OutputPane`:

| Surface                        | Current renderer                                 | Semantic references                                                                        |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Echoed prompt row              | `PromptReferenceText` in `OutputRow.tsx`         | `@file`, `@dir/`, `#selection`, `#sym`, `~git` (but not the editor's `$context` links yet) |
| Markdown response/thinking row | `MarkdownText.tsx`                               | auto-detected paths and explicit Markdown links whose target is a local file               |
| Structured file tool row       | `FileOperationOutput.tsx` inside `ToolCallBlock` | file edit/write/read/delete path headers                                                   |

`ToolCallBlock.tsx` itself is only the shared gutter/frame. Generic MCP, web
search, bash, and tool-result bodies do not currently create local-code links,
so the frame should not scan or rewrite their arbitrary text. File-operation
headers should supply the shared chip as header content.

### Find in output

Find has deliberately separate indexing and rendering stages:

1. `findOutputMatches()` in `outputFind.ts` searches canonical row search
   segments and records row-global source offsets.
2. `useOutputFind.ts` owns match order, active match, navigation, and per-row
   decorations.
3. Plain output uses `highlightText()` with exact offsets.
4. Markdown uses `remarkHighlightMatches` plus code-specific highlighting.
5. Diff bodies use `markFindTokens()` in `rdvFindTokens.ts` over
   `react-diff-view` syntax tokens.

The index already searches the full path. Rendering a path such as
`@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts` as only
`codemirrorTheme.ts` creates a visibility problem, not an indexing problem: a
query for `webview-react` would be counted and navigable but would have no
visible DOM mark to reveal.

---

## Product decisions

### What becomes a chip

With `ui.atomicContextReferences` enabled inside `OutputPane`:

- echoed ctrlyoke references become chips using their reference type;
- echoed `$context` references gain the same chip/open behavior they already
  have in CodeMirror, closing the current prompt-editor/output discrepancy.
  **Note this is a behavior change, not only a presentation change:** echoed
  `$context` tokens are not clickable in output today at all, because
  `PromptReferenceText` calls only `findContextReferenceMatches` and never
  `findInlinePriorContextRefs`. Gating clickability on a *formatting* setting
  would be incoherent, so `$context` becomes clickable in **both** states —
  a plain text link when the setting is off (matching how every other echoed
  reference renders when off) and a chip when it is on;
- Markdown auto-linked local paths become file chips;
- explicit Markdown links with a local-file target become file chips;
- file edit/write/read/delete header paths become file chips;
- a failed image preview's existing file-reference fallback becomes a chip.

The following stay as they are:

- external Markdown links;
- successfully rendered image thumbnails;
- text in inline/fenced code and Mermaid source;
- diff body tokens;
- bash commands/results and generic tool bodies that are not already links;
- `MarkdownText` calls outside `OutputPane` unless a future caller explicitly
  opts into the presentation.

### Compact labels

Use the editor's existing labels as the canonical rules:

- file: basename (`codemirrorTheme.ts`);
- directory: basename plus `/`;
- selection: basename plus line range;
- symbol: symbol name, with the generic symbol icon when no resolved kind is
  already available;
- git: keyword, `stash N`, or seven-character commit hash;
- prior context: `previous`, `all steps`, `final step`, `all final`, or the
  selected step list.

For an explicit Markdown link, keep an intentionally authored label when it is
meaningfully different from the raw target. Its title and accessible name must
still expose the complete local target. Auto-linked paths use the basename rule.

### Find matches hidden by compaction

Search always runs against the original row search segment; compact labels must
never alter match count or order.

Each rendered reference carries:

- its canonical full source/target text;
- its row-search `[from, to)` range;
- the ranges represented by its normal compact label;
- its compact presentation metadata and open action.
- its selection-copy text, which is the original token for auto/context
  references and the authored label for an explicit Markdown link.

The shared chip renderer projects `RowFindDecoration` ranges onto that model:

1. If a match overlaps text represented by the compact label, keep the compact
   label and mark the matching characters.
2. If any match overlaps a hidden portion of the reference, temporarily expand
   that chip to its full reference/target text while the query is active and
   mark the exact substring there.
3. Apply `data-find-active="true"` to the active `<mark>` so
   `outputDom.ts` can reveal it after row navigation.
4. Collapse the chip again when the query is cleared or no longer matches its
   hidden text.

For the motivating example, a search for `webview-react` expands
`codemirrorTheme.ts` to
`@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts` and highlights
`webview-react`. This is preferable to outlining a chip with no visible match:
the find counter, active result, and pixels on screen all describe the same
occurrence.

All matching chips, not only the active chip, should expose hidden matching
text. The active occurrence retains the stronger existing find outline.

For explicit Markdown links, map label and target source ranges separately:
a match in the authored label marks that label, while a match in the hidden
local target expands to the target and marks it. Markdown punctuation itself is
not a reference label; the pre-existing limitation for searches that match only
source markup can remain documented.

---

## Architecture

### 1. Single-source parsing and presentation metadata

**Scope decision (revised during planning).** An earlier draft called for
extending `src/utils/FileReferenceParser.ts` so one parser served both runtime
and UI. That is the wrong trade here and is explicitly **not** part of this work:

- `FileReferenceParser.ts` is the *runtime* parser. `parseAtReferences()` and
  friends feed harness context expansion through `HarnessIntegration`; its
  regexes are tuned for prose tolerance (trailing-punctuation stripping) and it
  returns `FileReference` objects, not ranged discriminated matches.
- `findContextReferenceMatches()` in `CodeMirrorEditor.tsx` is the *UI* parser.
  It needs exact `[from, to)` source ranges, a discriminated `type`, and it
  covers dialects the runtime parser does not (quoted variants, `~git` refs,
  inline `$context`).

Merging them would put harness context expansion at risk for no user-visible
benefit to this feature. The single-source requirement that actually matters —
and the one the acceptance criteria test — is *one parser shared by the editor
and output renderers*. That is achieved entirely on the webview side.

So: extract the UI parser and presentation helpers out of
`CodeMirrorEditor.tsx` verbatim (no behavior change) into
`src/ui/webview-react/utils/atomicReferences.ts`, and leave the runtime parser
alone. Document the two-parser boundary and why it exists so a later agent does
not "helpfully" merge them. If genuinely shared leaf helpers surface during
extraction (basename/normalization), share those specific functions only.

That utility owns:

- `AtomicReferencePresentation` / `AtomicReferenceRange` types;
- basename, git-label, and prior-context-label helpers;
- reference-to-icon/label/title/open-target mapping;
- fenced-range filtering and overlap resolution;
- the match-projection helper that decides compact versus find-expanded text.

CodeMirror and output should consume the same descriptors. CodeMirror keeps the
replace widget, `EditorView.atomicRanges`, validation map, and symbol icon cache;
those are editor mechanics and must not leak into the React output component.

Remove `OutputRow.tsx`'s import from `components/editor/CodeMirrorEditor.tsx`.
Both components should depend on the parser/presentation utilities instead.

### 2. Shared React renderer and shared visual tokens

Add a focused output component such as
`components/output/AtomicReferenceChip.tsx`. It should render a native
`<button>` with:

- a codicon and compact/find-expanded label;
- `title` containing the full original reference or target;
- an `aria-label` such as `Open <full path>`, `Reveal <directory>`, or
  `Open git <ref>`;
- the existing open action (`openFile` or `openContextReference`);
- exact find marks supplied through the shared projection helper;
- stable data identifying the source/copy text for output selection handling;
- no nested button or link markup.

Move the reusable chip box, icon sizing, hover, focus-visible, high-contrast,
and invalid-state primitives to global component CSS in `styles/globals.css`.
Extract the icon/accent color map from `codemirrorTheme.ts` into a shared
webview utility so CodeMirror's generated theme rules and the React chip use one
color source. CodeMirror may retain a thin `.cm-*` adapter for editor-specific
layout and event behavior.

Do not make React render inside CodeMirror. Sharing the descriptor, colors, and
visual class contract gives one source of truth without coupling the two render
engines.

### 3. Output-scoped feature gate

Read `globalSettings.atomicContextReferences` once at the output composition
boundary (`OutputSection` or `OutputPane`) and pass an explicit presentation
flag through `OutputPane -> OutputRow` to the link-producing children.

`MarkdownText` must expose an opt-in prop rather than reading the store itself.
Its workspace-viewer preview call therefore keeps today's rendering by default.
Live toggling the setting should switch already-realized and virtualized rows
without changing their source data.

Add a capture-phase `copy` adapter at the output-pane boundary for selections
that intersect chips. It should serialize each selected chip as the descriptor's
copy text instead of the compact/find-expanded DOM label. Thus an auto-linked
path or context reference still copies its full original token, while an
explicit `[authored label](local-target)` keeps normal rendered-Markdown copy
semantics. Existing Copy all/export paths are already model-based and must stay
unchanged.

Update both user-facing descriptions:

- `schemas/settings-schema.json` should describe atomic editing in the prompt
  editor and compact chip formatting for output references;
- `GeneralSection.tsx` should explain the same behavior and make clear that the
  off state restores ordinary text links.

No settings contract, default, sync payload, or persistence migration is
needed; the existing boolean remains the source of truth.

### 4. Echoed prompt references

Replace `PromptReferenceText`'s local span/link construction with the shared
descriptor and React chip renderer when enabled. Keep its current plain,
selectable, verbatim text-link path when disabled.

Continue excluding fenced references exactly as the editor does. Preserve
`openContextReference` behavior for directories, ranges, symbols, git, and
prior context, and retain plain text between references with exact find-offset
slicing.

### 5. Markdown references

Keep the existing secure custom-element pipeline; do not introduce arbitrary
schemes or bypass `rehype-sanitize`/`rehype-harden`.

Enrich `<file-ref>` nodes with a stable reference id or sanitized source-range
metadata that indexes a descriptor computed from the original Markdown. The
React custom-element renderer can then choose `FileRefButton` or
`AtomicReferenceChip` without reparsing rendered children.

The Markdown integration must preserve:

- authored labels for explicit local links;
- normalized open targets and optional line suffixes;
- the full-target title/accessibility text;
- auto-linked path behavior;
- image thumbnail security and fallback behavior;
- Streamdown's stable plugin identities and static-mode find workaround;
- find marks inside inline/fenced code through the existing code renderer.

Pass row-relative find decorations into `MarkdownText` in addition to the query
options it needs for normal Markdown/code highlighting. Reference custom nodes
consume exact offset decorations; ordinary Markdown text can retain the current
query-based remark pass.

### 6. Structured file tool rows

Replace the local `FilePath` renderer in `FileOperationOutput.tsx` with the
shared chip when enabled. The file event's `data.path` is both the open target
and the `filePath` search segment, so its source-range mapping is direct.

Keep `ToolCallBlock.tsx` presentation-agnostic: it receives a chip in its header
but does not know how references are parsed. Preserve wrapping, the gutter rail,
undo/redo actions, and full-bleed diff layout.

### 7. Find and virtualization integration

Keep `findOutputMatches()` and `useOutputFind()` authoritative for match count,
order, case sensitivity, active match, and row navigation. Add only reusable
range-projection helpers/types needed by renderers; do not create a second
query pass whose results can disagree with the hook.

Ensure a find-expanded chip renders a real active `<mark>` so
`findActiveMatchElement()` can locate it. Verify that a chip changing width or
wrapping during search causes the row measurement path to update before/while
the navigation controller settles. Do not add fixed chip heights that would
hide wrapped full paths.

`rdvFindTokens.ts` remains responsible only for syntax-token leaves in diff
bodies. Because diff contents are not converted to links/chips, it should not
import atomic-reference code. Add a regression test proving a path-like query
inside a diff still receives its normal token mark; this makes the boundary
explicit and prevents a later “global” implementation from rewriting code.

---

## Implementation phases

Staged as seven single-session steps. Each lands independently, keeps `npm test`
green, and commits its own work. Later steps assume earlier ones are committed.

### Step 1 — Extract the shared webview model (no behavior change)

**Status: Complete.** Extracted the shared parser, presentation metadata, and
palette; repointed editor/output consumers; and relocated the utility tests.

- Move `findContextReferenceMatches`, `findInlinePriorContextRefs`,
  `getFencedBlockRanges`, `isInFencedBlock`, `referenceBasename`,
  `gitReferenceLabel`, `describeContextReferenceChip`,
  `describePriorContextChip`, `findAtomicReferences`,
  `PRIOR_CONTEXT_CHIP_LABELS`, and the `AtomicReferenceChip` type out of
  `CodeMirrorEditor.tsx` into `src/ui/webview-react/utils/atomicReferences.ts`.
- Move the `CHART_ACCENT_COLORS` / `SYMBOL_ICON_COLORS` palette out of
  `codemirrorTheme.ts` into a shared utility that both the generated CodeMirror
  theme rules and the React chip consume.
- Repoint `CodeMirrorEditor.tsx` and `OutputRow.tsx` at the new module, deleting
  `OutputRow`'s component-to-component import of the editor.
- Relocate the parser/presentation unit tests out of the editor component test.
- Do **not** touch `FileReferenceParser.ts` (see Architecture §1).

### Step 2 — Find range projection (pure, no rendering)

**Status: Complete.** Added the pure source-to-label projection and Vitest
coverage for compact/expanded rendering, hidden matches, active marks, and
boundary behavior.

- Add the descriptor → render-segments projection: given full source text, its
  row-search range, the sub-ranges the compact label represents, and the row's
  find matches, decide compact vs. find-expanded and return exact mark ranges.
- Cover case sensitivity, multiple matches in one reference, active-match
  forwarding, label-only matches, hidden-segment matches, and collapse on clear.

### Step 3 — `AtomicReferenceChip` component and shared styles

**Status: Complete.** Added the standalone native-button chip, projected find
marks, canonical copy/source metadata, and shared global chip primitives. The
CodeMirror widget now uses those primitives with only its editor-specific
single-line adapter remaining.

- Native `<button>` chip: codicon, compact/expanded label, full-reference
  `title`, `aria-label`, open action, marks from Step 2, copy-text metadata.
- Move the reusable chip box/icon/hover/focus/high-contrast primitives into
  global component CSS; leave CodeMirror a thin `.cm-*` adapter.

### Step 4 — Output gate and echoed prompt references

**Status: Complete.** Scoped the setting to `OutputPane`, added shared-chip
rendering and `$context` links for echoed prompts, canonical selection copy
serialization, and updated the setting descriptions.

- Read the setting at the output composition boundary and thread an explicit
  presentation flag to `OutputRow`.
- Re-render `PromptReferenceText` through descriptors + the chip when enabled,
  keeping today's plain link path when disabled, and wire `$context` in both
  states (see Product decisions).
- Add the capture-phase copy adapter at the output-pane boundary.
- Update `schemas/settings-schema.json` and `GeneralSection.tsx` descriptions.

### Step 5 — Structured file-operation rows

- Replace `FileOperationOutput.tsx`'s local `FilePath` with the shared chip when
  enabled; keep `ToolCallBlock` presentation-agnostic; preserve `filePath` find
  marks, undo/redo, and full-bleed diff layout.

### Step 6 — Markdown references

- Carry descriptor/source-range metadata on `<file-ref>` nodes through the
  existing sanitized custom-element pipeline; add the opt-in prop so
  non-output callers are unchanged; thread exact find decorations for reference
  nodes while ordinary Markdown keeps its query-based remark pass.

### Step 7 — Regression, boundary, and performance verification

- Add the `rdvFindTokens` diff-boundary regression test.
- Exercise virtualized and non-virtualized output with long wrapped paths.
- Toggle the setting while output is visible and while rows are off-screen.
- Search hidden path segments, navigate among several matches in one row and
  across rows, change case sensitivity, and clear the query.
- Verify streaming Markdown does not accumulate processor-cache entries or
  remount when neither find state nor reference presentation changed.
- Verify output export/copy still contains full original text.

---

## Test plan

### Parser and presentation utilities

- All `@file`, quoted path, directory, selection, symbol, git, and prior-context
  forms produce stable source ranges and the same labels/icons as today.
- Fenced references and overlapping/nested candidates remain excluded exactly
  as they are in CodeMirror.
- Windows separators, Codex pseudo-absolute paths, workspace-relative paths,
  paths with spaces, and line suffixes normalize without changing open targets.
- A visible-label match stays compact; a hidden-directory match expands to full
  text; case-sensitive mode and multiple matches are projected correctly.

### CodeMirror

- Existing atomic cursor/delete behavior, click/touch behavior, invalid state,
  symbol-icon cache upgrade, and non-atomic link mode all continue to pass after
  extraction.

### `AtomicReferenceChip`

- Native button semantics work with pointer, Enter, and Space.
- Icon, compact label, title, and `aria-label` represent the correct target.
- `webview-react` in a hidden path segment expands and marks the full path.
- A basename match remains compact and marked.
- The active mark carries `data-find-active="true"`; inactive matches do not.
- Long expanded references wrap without overflowing the output pane.
- Copying a selection across compact/expanded chips produces stable canonical
  text rather than whichever shortened label happens to be visible.

### Markdown

- Setting off preserves current auto-path and explicit-local-link rendering.
- Setting on chips auto paths and local Markdown targets, preserves an authored
  label, and leaves external links unchanged.
- Hidden target matches are counted, visibly expanded, and active-marked.
- Inline code, fenced code, Mermaid, and successful image thumbnails do not
  become chips; image fallback does.
- `MarkdownText` without the output opt-in (workspace preview) stays unchanged.
- Existing static-mode, active-occurrence, and syntax-highlight find tests pass.

### Output rows and tools

- Echoed prompts render each supported context-reference chip only when enabled
  and invoke the existing open action.
- File edit/write/read/delete headers render file chips only when enabled and
  preserve highlighted `filePath` matches plus undo/redo/diff controls.
- Generic tool, MCP, web search, and bash bodies are not heuristically rewritten.

### Find, diff, and virtualization

- `findOutputMatches()` returns the same count/order/offsets with the setting on
  or off.
- `useOutputFind()` navigation reveals an active mark inside an expanded chip,
  including repeated matches in one reference and multiple rows.
- Clearing/changing a query collapses stale expanded chips and removes marks.
- `rdvFindTokens` still marks path-looking substrings in syntax-tokenized diffs
  and does not receive reference-chip behavior.
- Virtualized rows remeasure after find expansion/collapse and navigation lands
  on the intended occurrence without oscillation.

---

## Acceptance criteria

- Enabling `Atomic context references` changes all existing local-code links
  beneath `OutputPane` to the shared chip presentation and changes no external
  link or non-output `MarkdownText` surface.
- Disabling it restores today's output link rendering and CodeMirror's
  character-by-character editing mode.
- The motivating `@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts`
  reference normally shows `codemirrorTheme.ts`, opens the same target as
  before, and exposes the full reference to hover and assistive technology.
- Searching `webview-react` returns the same match count as the unchipped view,
  expands the chip, visibly marks `webview-react`, and gives the active match
  the existing stronger outline.
- Find navigation, case sensitivity, Markdown rendering, diff highlighting,
  virtualization, copy/export, tool-call layout, and undo/redo show no
  regressions.
- Parsing, labels, icons, accent colors, and open-target metadata each have one
  source of truth shared by editor and output renderers. (Webview-side, per
  Architecture §1 — the runtime `FileReferenceParser` stays separate by design.)
