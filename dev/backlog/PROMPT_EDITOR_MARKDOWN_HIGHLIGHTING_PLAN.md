# Prompt Editor Markdown Highlighting Plan

**Status (2026-10-08):** Phases 0 (readable code ranges) and 1 (single-source palette) are
done. Phases 2, 3 and 4 are not started.

**Sequencing:**
[`EDITOR_INTELLIGENCE_STAGING_PLAN.md`](EDITOR_INTELLIGENCE_STAGING_PLAN.md) orders this plan
against the ctrlyoke file support and prompt diagnostics plans.

**Priority:** P2. This is readability polish on the product's most-used surface. It is also
visible in every prompt-editor capture in
[`SCREENSHOTS_AND_MEDIA_PLAN.md`](SCREENSHOTS_AND_MEDIA_PLAN.md) (#9's completion clip, #13a).

**Related plans:**

- [`WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md`](WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md):
  its `PROMPT_TEXT` ranges are where Phase 3 here nests markdown inside YAML prompt values.
- [`STANDALONE_THEME_SNAPSHOTS_PLAN.md`](STANDALONE_THEME_SNAPSHOTS_PLAN.md): how the hosted
  browser gets VS Code's colour variables. The palette below must work when only a snapshot is
  available.

## Problem

A ctrlyoke prompt is markdown with ctrlyoke references layered on top, and `.prompt.md` is a
supported format. The prompt editor (`CodeMirrorEditor.tsx`) treats it as plain text, with one
exception. Every fenced block and inline code span is painted with `.cm-code-range` (`color:
var(--vscode-disabledForeground)`, italic). In Default Dark that colour is `#555555`. The
"this is literal" signal ends up as "this is greyed out and hard to read", in both dark and
light themes, and a pasted JSON or YAML block loses all structure.

VS Code's own markdown editor shows a better model:

- Every formatting character stays visible (`**`, `_`, `~~`, `#`, backticks, `[]()`).
- The text is only coloured or styled: headings blue and bold, bold text bold, italic text
  italic, strikethrough struck, inline code coloured, links underlined.
- The contents of a fenced block are highlighted in the fence's language.
- Heading lines are not resized.

Goal: the prompt editor highlights everything that isn't a chip as markdown, the way VS Code
does, and fenced code becomes readable, highlighted code instead of grey italics.

## Key facts that shape the design

These were verified against `src/` on 2026-10-07.

1. **The prompt editor has no language today.** It builds on `minimalSetup` with no
   `LanguageSupport`. Code styling comes from `createCodeRangeDecorationExtension()`, which
   marks every range from `getCodeRanges()` with the `.cm-code-range` theme rule (grey italics
   until Phase 0 restyled it).

2. **Code ranges carry meaning beyond styling.** `getCodeRanges()`
   (`src/utils/PromptReferenceScanner.ts`) wraps `findCodeRanges` from
   `src/utils/FileReferenceParser.ts`. The host uses the same function to decide that references
   inside backticks or a fence are **not expanded** (the "Writing references literally" rule in
   `docs/workflows/context-files.md`). The prompt editor uses it in about eight places to skip
   chips, links, lint and spellcheck inside code. **That function stays the only authority on
   what is literal.** A markdown parser's notion of code is used for colour only, never for
   reference behaviour.

3. **VS Code's markdown and syntax token colours are not CSS variables.** Webviews receive the
   workbench colour registry as `--vscode-*` variables (955 of them in
   `dev/reference/vscode-css-vars-defaultdark.json`). The theme's TextMate `tokenColors`, such
   as `markup.heading` or `markup.inline.raw`, are not among them, and there is no extension API
   that reads them. The markdown-adjacent variables that do exist:

   | Variable                                                       | Default Dark value | Notes                                    |
   | -------------------------------------------------------------- | ------------------ | ---------------------------------------- |
   | `--vscode-textLink-foreground`                                 | `#48a0c7`          |                                          |
   | `--vscode-textPreformat-foreground`                            | `#8c8c8c`          |                                          |
   | `--vscode-textPreformat-background`                            | `#262626`          |                                          |
   | `--vscode-textCodeBlock-background`                            | `#242526`          |                                          |
   | `--vscode-textBlockQuote-border`                               |                    |                                          |
   | `--vscode-markdown-extension.editor.codeSpan.border`           |                    | the box VS Code draws around inline code |
   | `--vscode-markdown-extension.editor.formattingMark.foreground` |                    | the whitespace dots in the screenshot    |

   So "use VS Code's markdown colours" means: use those variables where they exist, and
   otherwise use fallbacks taken from VS Code's own default themes.

4. **Two copies of the code-token palette already exist and have drifted.**
   - `utils/syntaxHighlighting.tsx` `SYNTAX_TOKEN_STYLES` is the refractor CSS for output code
     blocks rendered by `MarkdownText` and streamdown.
   - `utils/codemirrorLanguage.ts` `createWorkspaceEditorHighlightExtension()` is the
     workspace editor's `HighlightStyle`. Its comment says it is "matching the colours in
     SYNTAX_TOKEN_STYLES".

   Both map keywords to `--vscode-symbolIcon-functionForeground`, which is **`#b180d7`
   (purple)** in Default Dark. The intended `#569cd6` blue is only the fallback, and the
   fallback never applies because the variable always exists. Both copies use dark-only hex
   fallbacks, so a missing variable in a light theme picks a dark-theme colour. This plan
   single-sources the palette and fixes those choices in one place. _(Fixed by Phase 1:
   `SYNTAX_TOKEN_STYLES` is gone, and both outputs are generated from `utils/syntaxPalette.ts`.)_

5. **Streamdown is a renderer, not a highlighter.** The output pane renders markdown to HTML
   (`MarkdownText.tsx`, streamdown styles in `globals.css`). Two pieces are reusable here: the
   code-token palette (fact 4) and `normalizeSyntaxLanguage`, which maps a fence info string
   to a language. Its prose CSS (heading sizes, list layout) doesn't apply to an editor, where
   text keeps one size and the markers stay visible.

6. **The dependencies are already installed.** `@codemirror/lang-markdown` (^6.5.0,
   `@lezer/markdown` underneath) and the language packages that
   `codemirrorLanguage.ts getLanguageExtension` already maps (JSON, YAML, JS/TS, Python, CSS,
   HTML, …) are root dependencies. `@codemirror/language-data` is not installed and isn't
   needed.

7. **ctrlyoke tokens mostly don't collide with markdown syntax.**
   - `#selection:` and `#sym.…:` are not ATX headings, because a heading needs a space after
     the `#`.
   - `~diff` is not strikethrough, which needs `~~`.
   - `!NAME` is not an image, which needs `![`.
   - `@path`, `$previous`, `/skill:` and `{{var}}` are inert in markdown.

   The real overlaps are these:
   - `_` or `*` inside an unquoted path can open emphasis, though CommonMark's flanking rules
     stop most intraword cases.
   - A reference inside `[text](…)` link syntax.
   - Chips are replace-decorations, so they hide whatever marks sit beneath them.

   All three are covered by the precedence rule in "Decision".

## Options considered

| Option                                                                                                                                                             | Verdict                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Restyle `.cm-code-range` only**: normal foreground, code font, preformat background.                                                                          | Rejected as the whole answer. It fixes the readability complaint in an hour, but fenced JSON stays monochrome and the rest of the markdown stays unstyled. It survives as Phase 0, a quick win that ships first. |
| **B. Obsidian-style live preview**: hide the markers, render headings large, render tables.                                                                        | Rejected. You asked for markers to stay visible, as in VS Code. Hidden markers also fight atomic chips, the cursor model and the "what you see is what's sent" promise of a prompt editor.                       |
| **C. `@codemirror/lang-markdown` with nested languages for fenced code, a single-sourced VS Code-matched palette, and ctrlyoke decorations at higher precedence.** | **Chosen.**                                                                                                                                                                                                      |

## Decision

### Markdown language in the prompt editor

- Add `markdown({ base: commonmarkLanguage + GFM extensions, codeLanguages })` to the prompt
  editor in a `Compartment`.
  - The GFM extensions cover strikethrough, task lists and tables, which only get styling.
  - `codeLanguages` resolves the fence info string through `normalizeSyntaxLanguage`, then
    through the same mapping `getLanguageExtension` uses. Those two mappings become one shared
    function, `resolveCodeMirrorLanguage(name)`.
  - Nested language packages load lazily the first time a fence uses them.
- Use **no** `markdownKeymap` and no markdown auto-pairing. Enter, Tab and Backspace keep the
  prompt editor's current behaviour. Lists do not continue on Enter (see Open questions).
- **Heading lines keep the editor font size.** Headings are coloured and bold only, as in VS
  Code.

### One palette, three consumers

- Define the token palette once, as CSS custom properties in `globals.css`.
- Name them `--cy-syntax-<role>`. As built in Phase 1, the roles are `SYNTAX_ROLES` in
  `utils/syntaxPalette.ts`: the code roles keyword, control-keyword, string, number, comment,
  function, type, variable, property, attribute, selector, boolean, regexp, tag and url, and
  the markdown roles heading, strong, emphasis, inline-code, quote and list-marker. Link text
  reuses `string` and link URLs reuse `url`; strikethrough is style-only. Fence markers, fence
  info and formatting marks have no role, because VS Code's default themes leave them
  uncoloured.
- Each one resolves to a real VS Code variable where one exists (fact 3). Otherwise it
  resolves to a per-theme fallback, set under `body.vscode-dark`, `body.vscode-light`,
  `body.vscode-high-contrast` and `body.vscode-high-contrast-light`, never one dark hex for all
  themes.
- Three consumers read the same variables, all generated from one `SYNTAX_ROLE_SPECS` table:
  - output code blocks: `buildSyntaxTokenStyles()` (refractor CSS, injected by
    `injectSyntaxHighlightStyles()`)
  - the workspace editor's `HighlightStyle`: `createCtrlYokeHighlightStyle()`
  - the prompt editor's markdown highlighting (Phase 2): the same
    `createCtrlYokeHighlightStyle()`

  This removed the duplicate in fact 4 and corrected the keyword mapping.

- The fallback values come from VS Code's built-in themes: `dark_vs.json`/`dark_plus.json` and
  their light counterparts in `microsoft/vscode`, `extensions/theme-defaults/themes/`. Verified
  against those files on 2026-10-08 (Phase 1). Default Dark uses:

  | Role                   | Default Dark      |
  | ---------------------- | ----------------- |
  | `markup.heading`       | `#569cd6`, bold   |
  | `markup.inline.raw`    | `#ce9178`         |
  | `markup.bold`          | `#569cd6`, bold   |
  | `markup.italic`        | `#c586c0`, italic |
  | `markup.strikethrough` | strikethrough     |
  | quote punctuation      | `#6a9955`         |
  | list punctuation       | `#6796e6`         |

  The 2026-10-07 draft of this table remembered bold and italic as style-only; the theme files
  colour them too. Light themes use the light-theme equivalents. The full four-theme table is
  in `globals.css` next to the variables.

- Record the chosen mapping in a short table next to the variables, so the next contributor
  knows why each colour was chosen.

### Code ranges: semantics stay with `findCodeRanges`

- `createCodeRangeDecorationExtension` stays, because it still marks the literal ranges. Its
  style changes from grey italics to a subtle literal indicator:
  - inline spans: the code font, the `--cy-syntax-inline-code` colour, and the
    `codeSpan.border` box VS Code draws
  - fenced blocks: the code font, with the markdown parser's nested-language colours showing
    through, and no background. VS Code's editor draws none, and this follows it.
- **Parity test.** A shared fixture corpus asserts that Lezer's `InlineCode`/`FencedCode`
  ranges equal `findCodeRanges` output. It covers:
  - indented fences
  - unclosed fences
  - longer closing fences
  - a backtick with no partner
  - double-backtick spans
  - backticks inside a fence

  If the two disagree, `findCodeRanges` wins for behaviour (chips, links and lint are skipped
  only inside its ranges) and the test documents the gap. Text that looks like code must never
  silently expand.

### Precedence with ctrlyoke decorations

- The markdown highlighting runs at default precedence. Everything ctrlyoke draws runs at
  higher precedence via `Prec.high`:
  - atomic chips
  - reference links (`.cm-link`, `.cm-prompt-file-ref`)
  - prior-context and condition-output marks
  - slash-token marks
  - lint
- A reference that sits inside emphasis or link syntax renders as a reference, and the
  surrounding markdown styles only the text outside it.
- Chips still replace their range entirely, as they do today.
- **The suppressed-expansion warning is what tells the user a reference is literal, so it must
  survive.** The prompt editor already warns on a reference inside code when its target exists
  (`CodeMirrorEditor.tsx`: "Context expansion suppressed — this reference won't be expanded
  inside code"). That warning, not the code colour, catches the real mistake: writing
  `` `@real/file.ts` `` and expecting it to attach. Polished code styling looks intentional, so
  the warning matters more after this plan than before. Running the lint at `Prec.high` keeps
  its underline and tooltip above the markdown styling.
- Spellcheck keeps skipping `findCodeRanges` ranges. It also skips fence info strings and link
  URLs.

### Where else it applies

- **Workspace editor, `.prompt.md`.** `getLanguageExtension` already gives `.md` files
  `markdown()`, and since Phase 1 the shared `HighlightStyle`. Switch it to the same configured
  markdown, with nested languages, so a prompt looks the same in both editors.
- **YAML prompt values.** In `.ctrlyoke.yaml` opened in the workspace editor, a
  `prompt: |` block scalar is markdown. Use `parseMixed` on lang-yaml's block-literal nodes,
  limited to the `PROMPT_TEXT` ranges from the ctrlyoke file support plan's
  `getWorkflowLocation`. Only that plan's Phase 1 is required, and the work fits naturally into
  its Phase 6, next to the YAML chips.
- **VS Code's own editor.** This is required: a workflow should read the same in VS Code as in
  the dashboard. `.prompt.md` already highlights natively in VS Code. For YAML, ship a TextMate
  injection grammar that embeds markdown in prompt values. `package.json` contributes no
  languages or grammars today, so this is the first.
  - **Contribution:** `contributes.grammars` entry `{ scopeName: "ctrlyoke.prompt-markdown.injection",
path: "./syntaxes/ctrlyoke-prompt-markdown.injection.json", injectTo: ["source.yaml"],
embeddedLanguages: { "meta.embedded.block.markdown": "markdown" } }`. The
    `embeddedLanguages` mapping gives the region markdown's comment toggling, bracket pairs and
    snippets as well as colours.
  - **Rule:** `begin` matches a `prompt`, `retryPrompt` or `passRetryPrompt` key followed by a
    block-scalar header (`|`/`>` with optional chomping/indent indicators), capturing the key's
    indent. `end` is the first non-blank line indented at or below that key. The body includes
    `text.html.markdown`. A second rule covers a single-line plain scalar
    (`prompt: Fix @src/app.ts`). Quoted scalars are left as YAML strings, for the same escape
    reason JSON gets no chips. Build the key list from `WORKFLOW_TEXT_FIELDS` (ctrlyoke file
    support plan) at build time, so a new prompt field reaches the grammar without a hand
    edit.
  - **Scope, an accepted tradeoff:** a TextMate grammar is selected by language, not by file
    name. `.ctrlyoke.yaml` files are plain `yaml`. Giving them their own language id would cut
    them off from the Red Hat YAML extension and the bundled `yamlValidation` schema, so the
    injection applies to every YAML file. A `prompt: |` block in some other tool's YAML gets
    markdown colours too. That is harmless, since such prompt text is almost always markdown,
    and the key-anchored rule never touches anything else.
  - **References:** `PromptLinkProvider` already turns ctrlyoke references in these files into
    links, so the grammar doesn't scope them. The markdown colours sit underneath, and the link
    underline sits on top.
  - **JSON workflow files** get no injection, because their prompts are escaped strings.
  - **Packaging:** `.vscodeignore` is an allowlist. Add `!syntaxes/**`, or the published VSIX
    ships without the grammar even though the dev host works.

## Implementation phases

1. **Phase 0: Readable code ranges.** **Done 2026-10-08.**
   - `.cm-code-range` now uses `--vscode-editor-font-family`, the normal foreground and
     `--vscode-textPreformat-background` with a 3px radius, using only existing VS Code
     variables and no parser change. It applies to inline and fenced ranges alike. Phase 2
     replaces the shared background with the inline-only box and the background-free fence
     described in "Code ranges" above.
   - `createCodeRangeDecorationExtension` and `createLinkDecorationExtension` are exported for
     tests. `CodeMirrorEditor.test.tsx` checks the class lands on inline and fenced ranges and
     that no reference inside them is decorated.

2. **Phase 1: Single-source the palette.** **Done 2026-10-08.**
   - **As built:**
     - `utils/syntaxPalette.ts` holds `SYNTAX_ROLES` and one `SYNTAX_ROLE_SPECS` table (role →
       Lezer tags + refractor token classes + font style). `createCtrlYokeHighlightStyle()`
       (cached) and `buildSyntaxTokenStyles()` (the refractor CSS that replaced the
       hand-written `SYNTAX_TOKEN_STYLES`) are both generated from it. The values are in
       `globals.css` under `:root, body.vscode-dark`, `body.vscode-light`,
       `body.vscode-high-contrast` and `body.vscode-high-contrast-light`, with the source table
       in a comment.
     - `resolveCodeMirrorLanguage(name)` in `codemirrorLanguage.ts` resolves any alias or fence
       info string through `normalizeSyntaxLanguage`; `getLanguageExtension(path)` delegates to
       it.
     - Only `url` uses a real VS Code variable (`textLink.foreground`). The others have no
       theme-tracking equivalent: the `debugTokenExpression`/`symbolIcon`/`charts` variables
       the old copies borrowed don't follow the editor's token colours, which is how keywords
       came out purple.
     - **Roles changed from the list above.** Added `control-keyword`, `property`, `attribute`
       and `selector`, so Dark+'s purple control keywords and the old CSS's selector and
       attribute colours survive. Link text uses `string` (VS Code's
       `string.other.link.title.markdown`), and link URLs share `url`, because Lezer tags code
       URLs and markdown link destinations with the same `tags.url`. Strikethrough is style-only.
     - **Left for Phase 2:** `fence-marker`, `fence-info` and `formatting-mark` have no variable,
       because VS Code's default themes leave those scopes uncoloured. Lezer also tags every
       markdown mark as `processingInstruction`, so the `quote` and `list-marker` variables reach
       only refractor until Phase 2's markdown configuration gives `QuoteMark`/`ListMark` their
       own tags.
     - Comments are no longer italic, matching the theme files.
     - **Deliberate class remaps beyond the old copies:** refractor `builtin` and `namespace`
       use the type colour and `constant` the variable colour; `annotation`/`decorator` use the
       function colour and `important`/`entity` the keyword colour (all four were the old
       `#c9b299`/link colour). New CodeMirror tags: `atom` (boolean), `operatorKeyword` and
       `moduleKeyword` (keyword), `function(propertyName)`. `.md` files in the workspace editor
       now get heading, bold and link colours. The `selector` role has no Lezer tags, so it
       colours only refractor output. `tags.self` and `escape` are uncoloured, as before.
     - Tests: `test/utils/syntaxPalette.test.ts` covers inline snapshots of both generated
       outputs, every role defined for all four theme selectors in `globals.css`, the
       keyword-colour regression, tag-to-variable resolution, and `resolveCodeMirrorLanguage`.
     - **Visual check: done 2026-10-08.** Output code blocks and the workspace editor were
       checked in VS Code and in the hosted browser, high-contrast light included (its body
       classes were fixed by
       [`hosted-high-contrast-light-syntax-colours`](../bugs/implemented/hosted-high-contrast-light-syntax-colours.md)).
       One known gap was left as is: in the hosted browser on a light theme with no theme
       snapshot, untokenised text in output code blocks falls back to the dark-theme
       `#d4d4d4` (`buildSyntaxTokenStyles()`'s `.cy-syntax` base colour).

3. **Phase 2: Markdown in the prompt editor.**
   - Add the `markdown()` compartment with GFM and lazy nested languages.
   - **The markdown roles mostly exist already** (Phase 1 maps heading, strong, emphasis,
     strikethrough, monospace, link and url). What's left: give `QuoteMark`, `ListMark` and
     probably `HeaderMark` their own tags through the markdown config's `styleTags` (Lezer
     tags every mark `processingInstruction`), then fill the empty `tags: []` of the `quote`
     and `list-marker` entries in `SYNTAX_ROLE_SPECS`.
   - **`codeLanguages` needs a wrapper around `resolveCodeMirrorLanguage`.** As built, that
     function imports every language package statically and returns a new `LanguageSupport`
     on each call. Phase 2 needs `LanguageDescription`s (or a memoised resolver) so nested
     languages load lazily and are not rebuilt per fence, and it must take only the first word
     of the info string (`ts title=a.ts` resolves to null today). Refractor-only aliases that
     `LANGUAGE_ALIAS_MAP` lacks (`cxx`, `cc`, `webmanifest`) also resolve to null; add them if
     they matter.
   - Raise ctrlyoke decorations to `Prec.high`, and make spellcheck exclude fence info strings
     and link URLs.
   - Tests:
     - the parity corpus against `findCodeRanges`
     - chips and links still render inside emphasis and link syntax
     - `#selection:` at the start of a line is not a heading
     - fenced JSON gets string and number classes
     - typing inside a fence keeps completions suppressed exactly as today
     - the suppressed-expansion warning still appears, with its message and range, on a
       backticked reference to an existing file, both inline and in a fence. It does not appear
       for a reference to a missing file. The warning's first test is added by
       [`PROMPT_DIAGNOSTICS_PLAN.md`](PROMPT_DIAGNOSTICS_PLAN.md) Phase 1, which lands before
       this phase. Here it is re-asserted with markdown highlighting on, to prove the
       precedence rule holds.
     - a performance check on a ~25K-token prompt, where the typing-latency budget must hold

4. **Phase 3: Workspace editor and YAML prompts.**
   - `.prompt.md` gets the shared markdown configuration with nested languages. It already
     uses the shared `HighlightStyle` (Phase 1 did that for every `.md` file).
   - YAML `prompt:` block scalars get nested markdown, scheduled with the ctrlyoke file support
     plan's Phase 6.

5. **Phase 4: VS Code injection grammar.** This is independent of the webview phases and can
   land at any point.
   - Add `syntaxes/ctrlyoke-prompt-markdown.injection.json`, generated from
     `WORKFLOW_TEXT_FIELDS`, plus the `contributes.grammars` entry and the `.vscodeignore` line.
   - The prompt-field list is `WORKFLOW_TEXT_FIELDS` (`src/completions/WorkflowLocationTypes.ts`,
     landed with the file support plan's Phase 1); take every `PROMPT_TEXT` key. Don't write a
     second list. It is a TypeScript module and the other generators are plain `.mjs`
     scripts, so the generator has to load it through the compiled output or a TS loader
     (no `tsx` is installed; `esbuild` is).
   - Generate the grammar in the build, with a drift check like the schema docs have
     (`scripts/generate-workflow-schema-outline.mjs --check` in `check:docs` is the nearest
     model).
   - Tests: an extension-host integration test in `src/test/integration/`. It opens a fixture
     `.ctrlyoke.yaml` and reads tokens with VS Code's `_workbench.captureSyntaxTokens` command,
     the one VS Code's own colorization tests use. Check that the command still exists when
     implementing; if it doesn't, tokenize with `vscode-textmate` and `vscode-oniguruma`. The
     test asserts:
     - markdown heading, emphasis and fenced-code scopes inside `prompt: |`, `retryPrompt: >-`
       and a single-line `prompt:`
     - plain YAML scopes on `name:`, on comments and on the line after the block ends
     - a quoted `prompt: "…"` stays a YAML string
     - a nested `steps[].parallel[].prompt` block is covered
   - Check the published VSIX's file list contains the grammar.
   - **Fix [`vscode-prompt-references-active-inside-code`](../bugs/backlog/vscode-prompt-references-active-inside-code.md) in the same phase,
     if it hasn't already been fixed on its own.** The grammar makes backticks look like code
     in VS Code. Today `PromptLinkProvider` and `PromptCompletionProvider` still link and
     complete references inside them, though they're sent literally. Both providers must skip
     `findCodeRanges` ranges, computed on the decoded prompt value: dedent YAML block scalars
     and decode JSON strings. Phase 2's precedence rule applies here too: what looks literal
     must behave literally. The fix and its tests are in the bug doc; its decoded prompt
     ranges come from `getWorkflowTextSpans` (file support plan Phase 1b). The VS Code diagnostics
     provider that carries the suppressed-expansion warning is
     [`PROMPT_DIAGNOSTICS_PLAN.md`](PROMPT_DIAGNOSTICS_PLAN.md) Phase 2. It is not a blocker
     for this phase.

## Open questions

All resolved on 2026-10-07:

- **No setting.** Markdown highlighting is always on. The parity test protects the behaviour
  that matters, and pre-release there is one look. Add a `ui.*` toggle only if users ask.
- **No fenced-block background,** following VS Code's editor. Revisit only if real prompts with
  long pasted logs prove hard to scan.
- **Lists do not continue on Enter.** VS Code's built-in markdown editor doesn't continue lists
  either; that comes from extensions such as Markdown All in One. So a developer's baseline
  expectation is plain Enter, and this plan is "follow VS Code". Prompts also use lists less
  than replies to people do. If it is ever added, it means wiring `markdownKeymap`'s
  `insertNewlineContinueMarkup`/`deleteMarkupBackward` into the prompt editor's existing keymap
  order. It would be a separate change, not part of this plan.
