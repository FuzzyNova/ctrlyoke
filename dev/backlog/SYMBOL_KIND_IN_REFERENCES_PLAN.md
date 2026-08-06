# Symbol Kind In References Plan

> **Status:** Step 1 complete — Steps 2 and 3 pending
>
> **Priority:** P2 — output correctness and cross-surface parity

Embed a symbol's kind in the `#sym:` reference token itself so that every
surface that renders an atomic reference chip — the prompt editor, `OutputPane`,
the hosted browser dashboard — shows the correct symbol icon and accent color
without an asynchronous round trip to the extension host.

The kind is captured at authoring time, when a real `vscode.SymbolKind` is
already in hand, and travels with the reference wherever the reference goes.

---

## Goal

`#sym:` chips render with their true symbol icon and accent color in output,
in the hosted browser client, and for historical runs — with no language-server
query at render time, and with `#sym:` (no kind) remaining a valid hand-authored
form.

## Non-goals

- Do not remove the editor's validation round trip. It stays as the authority on
  reference **validity** and as a **corrector** for a stale embedded kind.
- Do not change what `#sym:` expands to. The kind is presentation metadata plus
  a hint to the model; `ContextExpander` still attaches the same line range.
- Do not add kinds to `@file`, `@dir/`, `#selection:`, `~git`, or `$context`
  references. None of them have a kind axis.
- Do not introduce an output-time symbol resolution pass (see Alternatives).

---

## Current state

### The bug

`#sym:` chips in output always show the generic icon and have no accent color.

Two independent causes, both verified:

1. `OutputRow.tsx:1257` calls `findAtomicReferences(text)` with **no**
   `getSymbolIcon` resolver, so `describeContextReferenceChip` falls through to
   `DEFAULT_COMPLETION_ICON` (`symbol-misc`, `atomicReferences.ts:243`) for
   every symbol reference.
2. `symbol-misc` has no entry in `SYMBOL_ICON_COLORS`
   (`atomicReferences.ts:258`). `AtomicReferenceChip.tsx:78` looks the icon up
   there to set `--atomic-reference-accent`, and `codemirrorTheme.ts:32`
   (`buildChipAccentShadowRules`) only emits accent rules for names present in
   that map. An unresolved chip therefore gets neither icon color nor accent —
   in **both** render engines.

### How the editor gets it right today

The prompt editor resolves the kind through two host-dependent paths, neither
available to output:

- **Completion insert.** `CodeMirrorEditor.tsx`'s `apply` handler seeds
  `symbolIconCacheRef` from the completion item's `kind` at insert time.
- **Validation piggyback.** The lint pass sends references to
  `PromptEditorSupportService`, which calls `findSymbolKindForReference`
  (`PromptEditorSupportService.ts:525-537`) and returns `symbolKind` on the
  response (`WebviewMessageTypes.ts:1876`). `CodeMirrorEditor.tsx:1998-2029`
  writes those into the same cache and dispatches `symbolKindsUpdatedEffect` to
  repaint.

Both feed `symbolIconCacheRef`, a `useRef` local to one editor instance. Output
rows cannot see it, and history rows reference symbols the editor never parsed.

### Where the kind already exists for free

Both producers of a `#sym:` token hold a real `vscode.SymbolKind` at the moment
they build the string:

| Producer                                  | Kind source     |
| ----------------------------------------- | --------------- |
| `CompletionHelpers.ts:792` (`#` completions) | `symbol.kind`   |
| `ContextMenuReferenceCommands.ts:197`     | `symbol.kind`   |

Neither currently passes it to `buildSymbolReferenceValue`
(`ContextReferenceBuilder.ts:45-61`), so it is discarded and then re-derived
asynchronously later by `resolveSymbolReferenceKind`
(`CompletionHelpers.ts:108-148`).

---

## Alternatives considered

### Output-time resolution pass (rejected)

Mirror the editor's round trip from `OutputPane`, cached per reference like
`imagePreviewUriCache` in `MarkdownText.tsx`.

Rejected for three reasons:

1. **Unavailable where output renders.** Kinds come from
   `vscode.executeDocumentSymbolProvider`. The hosted browser dashboard and CLI
   runs have no VS Code symbol provider, so those surfaces would stay generic
   permanently.
2. **Wrong semantics.** Output is a historical record. Resolving at render time
   reports what the symbol *is now*, not what was referenced then. A renamed or
   deleted symbol yields a wrong icon or none at all.
3. **Cost shape.** One async provider query per reference, per virtualized row,
   for information that was already known — and thrown away — at insert time.

### Kind in the verb position (`#class:path:Name:10-40`) (rejected)

Reads well, but a parser must know the entire kind vocabulary just to
**recognize a symbol reference at all**. A token written by a newer VS Code, or
by a language server emitting a kind not in our list, stops matching
`parseSymbolReferences` — so the reference is silently **not expanded**. That
turns a cosmetic gap into a context-expansion failure.

It also opens the `#` verb namespace to ~26 kind words shared with
`#selection:`, constraining every future `#`-prefixed feature.

---

## Design

### Syntax

The kind is an optional dotted suffix on the existing `sym` verb:

```
#sym:src/core/Foo.ts:Foo:10-40           ← still valid, generic icon
#sym.class:src/core/Foo.ts:Foo:10-40     ← kind embedded
#sym.method:src/core/Foo.ts:bar:12-18
#sym.type-parameter:"src/a b/T.ts":T:3-3 ← quoted paths unaffected
```

Why this shape:

- **One optional regex group.** Every parser becomes
  `#sym(?:\.([a-z-]+))?:…`. No parser needs the kind vocabulary to match a
  reference.
- **Graceful degradation.** An unrecognized kind falls back to the generic icon;
  expansion still works. This is the property the verb-position form loses.
- **No namespace pressure.** `#` keeps exactly two verbs, `sym` and `selection`.
- **Unambiguous.** `.` cannot appear before the first `:` in the existing
  grammar, so old and new tokens are trivially distinguished.
- **Hand-authorable.** `#sym:` stays supported and documented.

### Kind vocabulary

Embed the lowercased `vscode.SymbolKind` **name**, never an enum ordinal —
these tokens are persisted in prompt files and sent verbatim to harnesses, so a
number would be unreadable and would break if the enum ever shifted. Two names
are kebab-cased: `enum-member`, `type-parameter`.

The full set (26): `file`, `module`, `namespace`, `package`, `class`, `method`,
`property`, `field`, `constructor`, `enum`, `interface`, `function`, `variable`,
`constant`, `string`, `number`, `boolean`, `array`, `object`, `key`, `null`,
`enum-member`, `struct`, `event`, `operator`, `type-parameter`.

Store the true kind losslessly; collapse to a codicon only at render, matching
the collapsing `COMPLETION_KIND_ICONS` already performs (`namespace`/`package`
→ `symbol-module`; `string`/`number`/`boolean`/`array`/`object`/`null` →
`symbol-value`; `key` → `symbol-property`).

### Single source of truth

`COMPLETION_KIND_ICONS` currently lives in `CodeMirrorEditor.tsx:203`, keyed by
`CompletionItemKind` ordinal. Output needs a kind→icon map too, so add a
**kind-name → codicon** map in `src/ui/webview-react/utils/atomicReferences.ts`
alongside `SYMBOL_ICON_COLORS`, and have both render engines consume it. This
removes the last editor-owned presentation table the output path would otherwise
have to duplicate — the same coupling Step 1 of
`dev/implemented/GLOBAL_ATOMIC_REFERENCES_PLAN.md` removed for the parser.

The numeric `COMPLETION_KIND_ICONS` stays where it is: it serves the completions
dropdown, which is genuinely `CompletionItemKind`-keyed.

`ContextReferenceBuilder.ts` remains the only place that assembles the token
text; the kind parameter is added there, not at each call site.

### The round trip stays, as a corrector

`resolveSymbolReferenceKind` and the `symbolKind` field on the validation
response are **not** removed. In the editor they still:

- flag references whose symbol no longer resolves (`invalid` chip state), and
- override an embedded kind that has gone stale (symbol changed from `class` to
  `interface` since the reference was authored).

Output uses the embedded kind only — no async, no correction. That is the
correct asymmetry: the editor describes live code, output describes history.

---

## Changes by layer

### Producers

| File                                             | Change                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `src/completions/ContextReferenceBuilder.ts:45-61` | `buildSymbolReferenceValue` / `buildSymbolReference` accept an optional kind name   |
| `src/completions/CompletionHelpers.ts:792`       | Pass `symbol.kind` through a `SymbolKind → kind name` helper                        |
| `src/completions/ContextMenuReferenceCommands.ts:197` | Pass `symbol.kind` the same way                                                 |
| `src/utils/ContextExpander.ts:411`               | Preserve the kind when reconstructing the token for the simple-prompt fast path     |

The `SymbolKind → kind name` helper belongs next to `mapSymbolKindToCompletionKind`
(`CompletionHelpers.ts:46`) or in `ContextReferenceBuilder.ts`; it must not be
duplicated per call site.

`ContextExpander` rewrites the token from a parsed `FileReference`, so
`FileReference` (`FileReferenceParser.ts:23`) needs a `symbolKind?: string`
field or the kind is silently dropped on every rewritten prompt. **This is the
easiest step to miss** — the token survives the editor and the output pane but
loses its kind on the way to the harness.

### Consumers

| File                                                | Change                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/utils/FileReferenceParser.ts:171,187`          | Optional kind group on both the quoted and plain regexes; populate `symbolKind` |
| `src/ui/webview-react/utils/atomicReferences.ts:480-481` | Same on `symbolQuoted` / `symbol`; carry `symbolKind` on `ContextReferenceMatch` |
| `src/ui/webview-react/utils/atomicReferences.ts`    | `describeContextReferenceChip` prefers the embedded kind over `getSymbolIcon`; add the kind-name → codicon map |
| `src/completions/PromptLinkProvider.ts:61,65`       | Optional kind group so Ctrl+Click still resolves kinded tokens                 |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Resolver becomes the corrector; embedded kind is the initial value    |

Icon precedence in `describeContextReferenceChip`: resolver result (editor only,
authoritative) → embedded kind → `DEFAULT_COMPLETION_ICON`.

### Styling

**Done ahead of this plan.** `DEFAULT_COMPLETION_ICON` (`symbol-misc`) now has a
neutral `SYMBOL_ICON_COLORS` entry. It was independent of the kind work: any
icon missing from that map gets neither icon color nor accent, because both are
driven off the same lookup, so an unresolved chip painted as a bare box in both
render engines.

### Docs, schema, fixtures

- `schemas/workflow-schema.json:5,523` and `schemas/workflow-schema.yaml:6,479`
- `docs/guide/concepts.md:57`
- `docs/workflows/context-files.md:21,25,81`
- `src/templates/agents/ctrlyoke-tech-support.agent.md:165`
- `manual-test/attachment-test.prompt.md`,
  `manual-test/prompt-links-test.ctrlyoke.json`, `manual-test/README.md`

Each should document `#sym.<kind>:` as the form ctrlyoke inserts and `#sym:` as
the still-valid generic form.

---

## Resolved before Step 1 — the `#sym:`/`#selection:` field grammar

**Status: Done.** Found while verifying this plan's citations; pre-existing and
unrelated to kinds, but it landed in the same regexes Step 1 edits, so it was
fixed first. Recorded here because the kind suffix must extend *this* grammar.

Both fields of a `#sym:` reference (and the path of a `#selection:`) are now
**quoted, or bare with no whitespace, `:`, or `"`** — one regex per reference
type, alternation per field, in `FileReferenceParser`, `atomicReferences`, and
`PromptLinkProvider` alike. `ContextReferenceBuilder.quoteReferenceField`
decides quoting when building; `quoteReferencePath` stays space-only for `@`
refs, where a colon is unambiguous.

Adding the kind means extending the `sym` verb (`#sym(?:\.([a-z-]+))?:`), not
the field grammar, so the two are independent.

Three defects this closed:

1. **Symbol names the runtime parser rejected.** `Foo<T>`, `my-thing`,
   `Foo.bar`, `#private` chipped and Ctrl+Click'd fine but never expanded —
   the model silently received nothing. Now legal bare names.
2. **Names with spaces.** Markdown headings and CSS selectors arrive from the
   language server with spaces. Now quoted at build time rather than being
   made parseable by loosening the pattern — which is what keeps prose safe:
   the permissive `[^:]+` name the UI parser used matched `"MyClass, at 12"`
   out of `see #sym:a.ts:MyClass, at 12:30-45`.
3. **Windows absolute paths.** `ContextExpander.sanitizeReferences` emitted
   `#sym:C:\dev\repo\a.ts:foo:1-1` in multi-root/`effectiveAbsolute` mode —
   unparseable by *every* ctrlyoke parser, because space-only quoting left the
   drive colon bare. Two extension tests asserted exactly that broken output;
   they now assert the quoted form and additionally round-trip it back through
   `parseSymbolReferences`.

<details>
<summary>Original open-question write-up (kept for the reasoning)</summary>

Found while verifying this plan's citations; **pre-existing, unrelated to kinds,
but it lands in the same two regexes Step 1 edits**, so decide it first.

The UI and runtime parsers disagree on what a symbol *name* may contain:

| Parser                                     | Symbol-name pattern                  |
| ------------------------------------------ | ------------------------------------ |
| `atomicReferences.ts:481` (UI)             | `([^:]+)`                            |
| `FileReferenceParser.ts:187` (runtime)     | `([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?)`  |

Verified behavior — the UI parser accepts all of these, the runtime parser
matches none of them:

```
#sym:src/a.ts:get value:1-2      space
#sym:src/a.ts:Foo<T>:1-2         generics
#sym:src/a.ts:my-thing:1-2       hyphen
#sym:src/a.ts:Foo.bar:1-2        dotted/nested
#sym:src/a.ts:#private:1-2       JS private field
```

The failure mode is the bad kind: the reference renders as a normal clickable
chip and Ctrl+Click navigates fine (`PromptLinkProvider.ts:65` uses the loose
pattern too), but `parseSymbolReferences` never matches it, so
`ContextExpander` **silently attaches nothing** and the model never sees the
symbol's code.

It is reachable. `getSymbolCompletions` (`CompletionHelpers.ts:792`) inserts
`symbol.name` verbatim from `executeWorkspaceSymbolProvider` across *all* file
types, and `quoteReferencePath` only ever quotes the path — never the symbol
name. Markdown heading symbols, CSS class symbols, and C++/Rust generic names
all routinely contain spaces or hyphens.

Two ways to resolve it, and the choice affects this plan's grammar:

1. **Loosen the runtime pattern** to `([^:]+)`, matching the UI. ~2 lines plus
   tests. The `:(\d+)-(\d+)` tail still delimits the token, so prose false
   positives stay unlikely. Does not change any token that already works.
2. **Quote symbol names** the way paths already are —
   `#sym:src/a.ts:"get value":1-2` — via `quoteReferencePath` in
   `buildSymbolReferenceValue`. More consistent with the existing grammar and
   unambiguous, but it is a fourth pattern in every parser (quoted-path ×
   quoted-name), and it strands already-authored unquoted tokens.

Option 1 is the smaller, lower-risk fix and is recommended; option 2 is the
tidier grammar. Either way it should land as its own commit with its own tests,
**before** Step 1, so the kind work is not entangled with a change to what gets
expanded at runtime.

**Outcome:** option 2 (quoting), because option 1 would have propagated the
prose-swallowing `[^:]+` name into the runtime parser rather than removing it.
The feared cost of option 2 — "a fourth pattern in every parser" — did not
materialize: alternation per field collapses the existing quoted/plain *pair*
into a single pattern, so each parser lost a regex instead of gaining one.

</details>

---

## Implementation phases

Three steps. Each lands independently and keeps `npm test` green.

### Step 1 — Parse and render the kind (no producers yet) ✅

- Add the kind-name → codicon map to `atomicReferences.ts`. (The `symbol-misc`
  color entry already landed — see **Styling** above.)
- Add the optional kind group to the UI `symbol` pattern, the
  `parseSymbolReferences` pattern, and `PromptLinkProvider.symbol`; thread
  `symbolKind` onto `ContextReferenceMatch` and `FileReference`.
- Apply the icon precedence in `describeContextReferenceChip`.

Each of the three parsers is now a **single** symbol pattern with quoted/bare
alternation per field, so there is one regex per parser to edit, not two. Adding
`(?:\.([a-z-]+))?` after `sym` shifts every existing capture group index by one —
`FileReferenceParser.ts:190`, `atomicReferences.ts:537-545`, and
`PromptLinkProvider`'s match destructuring all read groups positionally, so all
three must be renumbered together.

No `data-symbol-kind` attribute is needed. `OutputRow` reconstructs a
`ContextReferenceMatch` from `descriptor.attrs`, but uses it only for the tooltip
and `openContextReference`; the icon travels on `descriptor.icon`, which
`findAtomicReferences` already computed.

After this step a hand-written `#sym.class:…` renders correctly everywhere and
nothing else has changed. Committing the reader before the writer means no
window exists where produced tokens cannot be parsed.

### Step 2 — Emit the kind

- Add the kind parameter to `ContextReferenceBuilder`, the `SymbolKind → name`
  helper, and both call sites.
- Preserve the kind through `ContextExpander.rewriteReferenceTokens`.

### Step 3 — Editor corrector, docs, and fixtures

- Make the validation round trip override rather than populate the icon; confirm
  the invalid-state path is unaffected. Step 1's precedence already gives the
  resolver priority, so this step is mostly *verification plus tests* — the
  editor-side behavior change is that a chip now paints its correct icon before
  validation returns, instead of flashing generic.
- **Keep** the completion `apply` handler's seeding of `symbolIconCacheRef`
  (`CodeMirrorEditor.tsx`, via `buildCodeMirrorCompletionResult`). It is
  redundant once tokens carry their kind, but it costs nothing and keeps the
  resolver correct for hand-edited tokens. Do not remove it.
- Update schema descriptions, docs, the agent template, and manual-test
  fixtures.
- While there: the doc examples use an **obsolete no-range form** —
  `#sym:path/to/file.ts:SymbolName:42` (`docs/guide/concepts.md:57`,
  `docs/workflows/context-files.md:21`,
  `src/templates/agents/ctrlyoke-tech-support.agent.md:165`,
  `manual-test/README.md:273,439`, `manual-test/attachment-test.prompt.md:8`,
  `manual-test/prompt-links-test.ctrlyoke.json:4`). Every parser requires
  `:<start>-<end>`, so those examples do not parse. Correct them to the range
  form as part of this pass.

---

## Test plan

### Parsing

- `#sym:path:Name:1-2` and `#sym.class:path:Name:1-2` both parse, with and
  without a quoted path, in `FileReferenceParser`, `atomicReferences`, and
  `PromptLinkProvider`.
- An unknown kind (`#sym.widget:path:Name:1-2`) parses, expands normally, and
  renders the generic icon — the property the verb-position form would lose.
- Source ranges (`from`/`to`) cover the full token including the kind suffix, so
  find projection and chip replacement stay exact.
- A symbol name containing `.` or `()` is unaffected.

### Rendering

- Each kind maps to its expected codicon and accent color in both
  `AtomicReferenceChip` and the CodeMirror widget.
- Collapsed kinds (`namespace`/`package`, the `value` group, `key`) resolve to
  the same codicons `COMPLETION_KIND_ICONS` produces today.
- An un-kinded chip renders `symbol-misc` **with** an accent color.
- Output chips need no resolver and issue no messages to the host.

### Round trip

- Insert via `#` completion and via the editor context menu; assert the emitted
  token carries the right kind.
- A stale embedded kind is corrected in the editor after validation and left
  alone in output.
- An invalid reference still renders `data-invalid="true"`.

### Expansion

- `ContextExpander` attaches the same content for `#sym:` and `#sym.class:`
  forms of the same reference.
- `rewriteReferenceTokens` round-trips the kind in a multi-root workspace
  (the `effectiveAbsolute` path at `ContextExpander.ts:407`).

---

## Acceptance criteria

- A `#sym.class:` reference echoed in output shows the class icon and amber
  accent, with no message sent to the extension host.
- The same reference renders identically in the hosted browser dashboard.
- `#sym:` with no kind still parses, expands, and renders — with an accent.
- An unrecognized kind degrades to the generic icon and still expands.
- The editor's validity and stale-kind correction behavior is unchanged.
- Kind names, kind → codicon mapping, and accent colors each have exactly one
  source of truth shared by the editor and output renderers.
