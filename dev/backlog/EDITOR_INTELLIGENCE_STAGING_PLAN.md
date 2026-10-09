# Editor Intelligence Staging Plan

**Status (2026-10-08):** In progress. **Wave 1 is done** (F1, F2, D1, M1 and M0), and so is
**F1b**, the follow-up the Wave 1 review added. **Wave 2 is done** (F3, F0, D2, B and M4),
merged and reviewed; its review fixes are on `main`, and so are fixes for all four bugs the
review filed. **Wave 3 is done** (M2, F4 and F7), merged to `main` and reviewed; its review
fixes are on `main`. **Wave 4 can start**: F5 now, then D3. **Wave 5 runs after Wave 4**:
M2b (the Wave 3 review's M2 follow-ups) first, then F6 + M3. This plan only orders the work. The design lives in the
three plans it stages.

This plan is the authoritative order for three overlapping plans:

| Key   | Plan                                                                                                                                                                                                                   | Phases                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **F** | [`WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md`](WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md): ctrlyoke completions, chips and diagnostics for workflow files in the hosted workspace editor, plus VS Code parity | F0–F7 = its Phases 0–7, plus F1b = its Phase 1b |
| **M** | [`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md`](PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md): markdown highlighting for prompt text, the shared syntax palette, and the VS Code injection grammar                      | M0–M4 = its Phases 0–4                          |
| **D** | [`PROMPT_DIAGNOSTICS_PLAN.md`](PROMPT_DIAGNOSTICS_PLAN.md): shared prompt-text lint rules and VS Code's diagnostics provider                                                                                           | D1–D3 = its Phases 1–3                          |
| **B** | [`vscode-prompt-references-active-inside-code`](../bugs/implemented/vscode-prompt-references-active-inside-code.md): VS Code links and completes references inside code                                                | one fix                                         |

The language intelligence plan these build on is already implemented
(`dev/implemented/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`), so nothing here waits on
it.

## Progress

| Phase           | State                     | Notes                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1              | **Done** (2026-10-08)     | File predicate, language-server exclusion, `getWorkflowLocation`/`findRangeForPath` for YAML, JSON and `.prompt.md`, `WORKFLOW_TEXT_FIELDS`. Deviations in plan F's Phase 1 entry; the review's bugs were fixed in F1b.                                                                         |
| F2              | **Done** (2026-10-08)     | Generated `WorkflowSchemaOutline` (`schema:update`, `precompile`, `check:docs` drift check), hand-authored `WorkflowPropertySnippets.ts`, and `PromptPropertyCompletionProvider` moved onto both. Details in plan F's Phase 2 entry.                                                            |
| D1              | **Done** (2026-10-08)     | `src/utils/PromptDiagnosticRules.ts` and `src/utils/PromptReferenceScanner.ts`; CodeMirror linters are adapters. Characterization tests pass against the pre-extraction code too. Details in plan D's "Phase 1 as built".                                                                       |
| M1              | **Done** (2026-10-08)     | `--cy-syntax-*` in `globals.css`, one role table in `utils/syntaxPalette.ts`, `resolveCodeMirrorLanguage`. Visual check done. Its one hosted regression is fixed: `hosted-high-contrast-light-syntax-colours`.                                                                                  |
| M0              | **Done** (2026-10-08)     | `.cm-code-range` restyled to the editor font on a preformat background.                                                                                                                                                                                                                         |
| F1b             | **Done** (2026-10-08)     | Added by the Wave 1 review: the F1/F2 bug fixes plus `getWorkflowTextSpans` (decoded prompt ranges). Details in plan F's Phase 1b entry.                                                                                                                                                        |
| B               | **Done** (2026-10-08)     | VS Code links and completions skip code. `src/completions/PromptCodeRanges.ts` runs `findCodeRanges` over each `getWorkflowTextSpans` span and maps back; `PromptLinkProvider` filters its links, `PromptCompletionProvider` returns nothing inside code. Bug moved to `dev/bugs/implemented/`. |
| M4              | **Done** (2026-10-08)     | `scripts/generate-prompt-markdown-injection.mjs` writes `syntaxes/ctrlyoke-prompt-markdown.injection.json` from `WORKFLOW_TEXT_FIELDS`. Details and the YAML-grammar gotcha in plan M's Phase 4 entry.                                                                                          |
| F3              | **Done** (2026-10-08)     | `WorkflowFileCompletionCore`: key and value items, `WorkflowValueDataSource`, document-aware step numbers and effective-harness models, per-object snippets, shared JSON escape. Details in plan F's Phase 3 entry.                                                                             |
| F0              | **Done** (2026-10-08)     | Completion client extracted to `utils/promptCompletion/` (`createPromptCompletionClient`, `promptTokenCompletionExtension` in override and language-data forms). Details in plan F's Phase 0 entry.                                                                                             |
| D2              | **Done** (2026-10-08)     | `PromptDiagnosticsProvider` (`ctrlyoke` collection) over `getWorkflowTextSpans`, registered in `extension.ts`. Takes D1's three cleanups. Details in plan D's "Phase 2 as built".                                                                                                               |
| F7              | **Done** (2026-10-08)     | `WorkflowFileCompletionProvider` replaces `PromptPropertyCompletionProvider` (YAML, JSON, `.prompt.md` frontmatter, values included); `PromptCompletionProvider` gates on `getWorkflowLocation` and gains `/`. Details in plan F's Phase 7 entry.                                               |
| F4              | **Done** (2026-10-08)     | `WorkspaceFileEditor` gets a `ctrlyokeFileSupport` compartment: key/value, script/permission and prompt-token sources as language data, over a lazily loaded location/completion chunk. Details in plan F's Phase 4 entry.                                                                      |
| F5              | **F5a done** (2026-10-08) | Side-effect-free host validation, routed diagnostics and schema lint in the workspace editor; F5b (prompt-text lint and outline hover) is pending.                                                                                                                                              |
| M2              | **Done** (2026-10-08)     | Markdown in the prompt editor: GFM plus memoised nested fence languages, quote/list mark tags, ctrlyoke mark decorations at `Prec.highest`, spellcheck skips fence info and link URLs. Details in plan M's Phase 2 entry.                                                                       |
| Everything else | Not started               |                                                                                                                                                                                                                                                                                                 |

### Wave 1 review (2026-10-08)

All five phases were reviewed against their plans. Typecheck, the outline drift check and its
generator tests, `CodeMirrorEditor.test.tsx` and `syntaxPalette.test.ts` pass; the F1 bugs
below were reproduced with probe documents. What the review changed:

- **D1 and M0:** no bugs. D1's new characterization tests also pass against the pre-D1 code,
  so the extraction preserved behaviour. Small cleanups are listed for D2 to take (plan D,
  "Phase 1 as built").
- **M1:** no bugs inside VS Code. In the hosted browser, high-contrast **light** gets the
  high-contrast dark palette:
  [`hosted-high-contrast-light-syntax-colours`](../bugs/implemented/hosted-high-contrast-light-syntax-colours.md),
  fixed before Wave 2.
  M2's real remaining work is narrower than planned (most markdown roles exist) but needs a
  lazy, memoised wrapper around `resolveCodeMirrorLanguage` (plan M, Phase 2).
- **F1 and F2:** several location bugs, each of which would cost F3 its key completions
  (first key under a new nested mapping, an empty `- ` item, flow mappings), plus a wrong
  `.prompt.md` frontmatter split, a predicate that disagrees with `WorkflowFileDiscovery`, a
  root-classification error and a first-branch-wins enum in the outline. They became plan
  F's **Phase 1b**, fixed before Wave 2 so nothing builds on them.
- **Missing shared piece.** B, D2 and later F5/F6 all need every prompt range in a workflow
  file as decoded text with an offset map. F1 only answers one cursor position at a time and
  returns raw spans. Without a shared helper, B and D2 would each write one in parallel. F1b
  added it: `getWorkflowTextSpans` in `src/completions/WorkflowPromptRanges.ts`.

### Wave 2 review (2026-10-08)

All five phases were merged to `main` (the conflicts were the shared progress tables and
`completions.instructions.md`, which every branch edited) and reviewed against their plans.
Every finding below was reproduced with a probe. The full `npm test` passed apart from one
unrelated, pre-existing flake (filed as
[`vscode-documents-dirty-save-test-flake`](../bugs/implemented/vscode-documents-dirty-save-test-flake.md)).

- **F0:** no regressions. The completion client's stale-response guard, progressive `#` cache
  and icon seeding match the old code; the global sequence numbers fix an old two-editor
  collision.
- **D2, fixed:**
  - A syntax error anywhere in a YAML file flagged every valid `$step:N`. D2 had its own strict
    parser; it now uses the tolerant `parseWorkflowDocumentRoot` that F3 uses.
  - A workflow-level `endCondition.retryPrompt` was judged as if it ran before step 1. It is
    now judged from the final step's view.
  - `git:` diff sides were linted, duplicating Problems entries.
  - "File not found" never cleared when a harness, rather than VS Code, created the file. It
    now uses a file system watcher.
  - An older pass could overwrite a newer one at the same document version.
- **D2, filed:**
  [`vscode-prompt-diagnostics-symbol-lookups-and-trust-refresh`](../bugs/implemented/vscode-prompt-diagnostics-symbol-lookups-and-trust-refresh.md)
  covers unused symbol-kind lookups on every pass, and no refresh when trust changes.
- **B and M4, fixed:**
  - **High:** a YAML comment containing `prompt: |` turned the rest of the file into markdown,
    in any YAML file. The injection selector now excludes comments and quoted strings.
  - Inexactly decoded spans mapped code ranges onto the wrong characters, which suppressed
    live references. Both consumers now check `span.exact`. One of the decoder's two causes,
    a leading tab counted as indent, is fixed; the other is filed as
    [`yaml-block-scalar-indent-indicator-measured-from-wrong-column`](../bugs/implemented/yaml-block-scalar-indent-indicator-measured-from-wrong-column.md).
  - Every completion request re-parsed the whole file. Code ranges are now cached per
    document version, and computed only once a trigger is found.
- **F3, fixed:**
  - A single-step script root offered prompt-only keys that the schema rejects.
  - The removed `returns` key was offered everywhere. The outline generator now treats a
    `not: {}` property as forbidden.
  - Completing an existing key doubled its colon.
  - `[N]` was offered inside a quoted `priorContext`.
  - YAML-reserved `@…` and `.inf`-like values were inserted unquoted.
  - `sessionId` offered script steps, which have no session.
- **F3, filed:**
  [`workflow-completion-core-json-arrays-flow-maps-and-commas`](../bugs/implemented/workflow-completion-core-json-arrays-flow-maps-and-commas.md)
  covers JSON arrays without a typed quote, multi-line inserts inside YAML flow mappings, and
  missing JSON commas.

All four filed bugs (this one, the D2 and decoder bugs above, and the save-test flake) were
fixed on `main` after the review. F4 and F7 no longer need a fix first.

### Wave 3 review (2026-10-08)

All three phases were merged to `main`. The only conflicts were the shared progress tables in
this plan and plan F. The full `npm test` passed on the merge. Each phase was then reviewed
against its plan, and every finding below was reproduced with a probe or a test.

- **F7, fixed:**
  - **High:** typing `/` showed nothing in VS Code. The range starts on the `/`, and VS Code
    filters on the range text, but `filterText` was the bare name. Items now filter on the
    full token.
  - JSON key items were hidden for the same reason: the range starts on the opening quote.
  - Multi-line key inserts were indented twice: the core already indents them, and VS Code
    added the line's indent again. They now set `keepWhitespace`.
  - Typing a space at a JSON key position opened the full key list, so the next Enter
    inserted a key. The space trigger now opens values only.
  - `/` didn't open after `"` or `(`. The trigger now uses the runtime token's own start
    boundary (`findPartialSlashTokenStart`).
  - The six per-trigger registrations are now one, so Ctrl+Space no longer lists items
    repeatedly.
- **F4, fixed:**
  - Picking an output-capture item left `[Capturing output…]` in the file for good, because
    the workspace editor has no capture handler. A client without one no longer offers
    those items.
  - `mcpServers` and `secrets` values stayed empty unless another panel had loaded those
    lists. The first completion that needs one now requests it.
  - A quoted path inserted into a YAML quoted prompt broke the YAML. The escape now follows
    the scalar style (`getWorkflowInsertEscape`, shared with VS Code, which had the same bug).
  - Script completion only worked on a block script's first line. Line breaks now separate
    commands in the shared parser.
  - In compact JSON, an `@` in an earlier field could start a prompt-token completion that
    overwrote the fields between it and the cursor.
- **M2, fixed:** the code-range mark at `Prec.highest` was drawn inside the lint mark. Its
  background hid the suppressed-expansion squiggle, which plan M says must survive. It is
  back at default precedence. The planned code-range restyle was never built; plan M now
  records it as deferred.
- **M2, filed:**
  - [`prompt-markdown-code-colouring-disagrees-with-find-code-ranges`](../bugs/backlog/prompt-markdown-code-colouring-disagrees-with-find-code-ranges.md),
    medium. Six fence and inline layouts are coloured as code while their references stay
    live. The parity corpus skipped the cases plan M asked for; they are now pinned as
    known gaps.
  - [`prompt-editor-reference-link-split-by-markdown-emphasis`](../bugs/backlog/prompt-editor-reference-link-split-by-markdown-emphasis.md),
    low and cosmetic.

## Short answer

- **The three plans can run in parallel, with three ordering constraints:**
  1. **F1 goes first.** It is the shared core: `getCtrlYokeFileKind`, `getWorkflowLocation`
     and `WORKFLOW_TEXT_FIELDS`. Every workflow-file feature in all three plans and the bug
     fix reads it. It also stops installed YAML/JSON/Markdown language servers attaching to
     ctrlyoke files, a live problem today.
  2. **D1 goes before anything else edits the prompt editor's lint.** It pins today's lint
     behaviour with tests before anything moves, and M2's precedence change and F5's
     workspace lint both build on its shared rules.
  3. **One change at a time per hot file.** `CodeMirrorEditor.tsx` (touched by M0, D1, F0 and
     M2) and `WorkspaceFileEditor.tsx` (F4, F5, F6 and M3) each take changes one after
     another, never from two worktrees at once. They are large files, and every one of those
     phases edits the same extension-list block.
- Otherwise the work splits into three tracks that move independently once their inputs
  exist: **VS Code**, **workspace editor** and **prompt editor**. The shared core feeds all
  three.

## Dependencies

Each row lists what must land before that phase.

| Phase      | Needs            | Why                                                                                                                                                                                                       |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0, M1, F2 | none             | Self-contained                                                                                                                                                                                            |
| F1         | none             | New pure modules plus the server-side exclusion                                                                                                                                                           |
| D1         | none             | Characterization tests, then extraction                                                                                                                                                                   |
| F0         | D1               | Same file as D1. Run serially so the two extractions don't conflict.                                                                                                                                      |
| F1b        | F1, F2           | Fixes their review bugs and adds `getWorkflowTextSpans`                                                                                                                                                   |
| F3         | F1b              | Completion items need a correct location and outline; the F1b bugs all land on key completions                                                                                                            |
| B          | F1b              | Decoded prompt ranges come from `getWorkflowTextSpans`, so no throwaway extractor                                                                                                                         |
| M4         | F1, ships with B | The grammar is generated from `WORKFLOW_TEXT_FIELDS`. Shipping it without B makes backticks look literal while they still link.                                                                           |
| D2         | D1, F1b          | Prompt values, `.prompt.md` bodies included, come from `getWorkflowTextSpans`                                                                                                                             |
| M2         | M1, D1, F0       | Palette; lint precedence over the D1 adapters; same file as F0                                                                                                                                            |
| F4         | F0, F1, F3       | As stated in plan F                                                                                                                                                                                       |
| F5         | F4, D1           | Workspace lint uses D1's rules. The compartment comes from F4.                                                                                                                                            |
| F7         | F3               | VS Code value completions share F3                                                                                                                                                                        |
| D3         | D2, F5           | Needs the side-effect-free `PromptFileParser` validate added in F5                                                                                                                                        |
| M2b        | M2               | Follow-ups from the Wave 3 review of M2; see Wave 5                                                                                                                                                       |
| F6 + M3    | F4, M2b, F5      | YAML chips and nested markdown share the same `PROMPT_TEXT` ranges and compartment, so they are planned as one change. M3 reuses M2's code colouring, so M2b settles it first; F5 holds the same hot file |

## Waves

Every phase in a wave can run in parallel, apart from the one-at-a-time hot files. Each wave
lists a suggested split across the long-lived worktrees (`big-feature`, `small-feature`,
`bug-fix`). Any split that respects the hot-file rule works.

### Wave 1: foundations and quick wins

**Done 2026-10-08.** All five phases merged to `main`. The review's follow-ups, F1b and the
hosted high-contrast light fix, were then committed on `main` directly.

| Phase                                              | Hot file                                                             | Worktree it ran in        |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| **F1:** location, file predicate, LSP exclusion    | —                                                                    | `big-feature`             |
| **F2:** schema outline and shared snippets         | —                                                                    | `big-feature`, after F1   |
| **D1:** characterization tests and rule extraction | `CodeMirrorEditor.tsx`                                               | `small-feature`           |
| **M1:** single-source palette                      | — (`codemirrorLanguage.ts`, `syntaxHighlighting.tsx`, `globals.css`) | `bug-fix`                 |
| **M0:** readable code ranges                       | `CodeMirrorEditor.tsx`, a one-rule theme change                      | `small-feature`, after D1 |

### Wave 2: consumers of the core

**Done 2026-10-08.** All five phases merged to `main`; the review's fixes were committed on
`main` directly.

| Phase                                                           | Hot file                                | Suggested worktree | Notes                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **F3:** completion items                                        | —                                       | `big-feature`      | Plan F's Phase 3 lists what the Phase 1/2 API leaves to it (root mode filtering, step-type keys, per-object snippets) |
| **F0:** completion-client extraction                            | `CodeMirrorEditor.tsx`                  | `small-feature`    |                                                                                                                       |
| **D2:** VS Code diagnostics provider                            | `extension.ts` registration             | `small-feature`    | After F0 in the same worktree. Uses `getWorkflowTextSpans` for every file kind; took plan D's listed cleanups.        |
| **B + M4:** VS Code literal-reference fix and injection grammar | `package.json` (`contributes.grammars`) | `bug-fix`          | Merged together. B uses `getWorkflowTextSpans`; M4's generator reads `WORKFLOW_TEXT_FIELDS`                           |

### Wave 3: the two editors

**Done 2026-10-08.** All three phases merged to `main`.

| Phase                                 | Hot file                  | Worktree it ran in | Notes                                                                      |
| ------------------------------------- | ------------------------- | ------------------ | -------------------------------------------------------------------------- |
| **M2:** markdown in the prompt editor | `CodeMirrorEditor.tsx`    | `small-feature`    | `resolveFenceLanguage` is the memoised wrapper the Wave 1 review asked for |
| **F4:** workspace editor completions  | `WorkspaceFileEditor.tsx` | `big-feature`      | The core's first consumer                                                  |
| **F7:** VS Code completion parity     | —                         | `bug-fix`          | Moved the VS Code providers onto the F3 core                               |

### Wave 4: diagnostics everywhere

**Ready to start.** F5's inputs (F4, D1) are on `main` and Wave 3's review fixes are in, so
nothing needs fixing first. D3 starts once F5 lands, since it needs F5's side-effect-free
`PromptFileParser` validate.

| Phase                                                                 | Hot file                  | Notes                                            |
| --------------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| **F5:** workspace editor diagnostics and hover                        | `WorkspaceFileEditor.tsx` | Adds the `PromptFileParser` validate entry point |
| **D3:** workflow-aware context and YAML schema diagnostics in VS Code | —                         | After F5                                         |

**Session split (orchestrated run, 2026-10-08).** F5 runs as two sessions: **F5a** is the
host-side validate entry point, the message pair, the `instancePath` converter and schema lint
in the workspace editor; **F5b** is prompt-text lint over `PROMPT_TEXT` ranges and the outline
hover. D3 needs only F5a's validate, but runs after F5b so the two never share a working tree.
D3 also takes the `$preCondition:` caveat left by D2 (plan D, "Phase 2 as built").

### Wave 5: prompt-text polish

**Runs after Wave 4**, in this order. M2b and F6 + M3 are on different hot files, but M3
must not start until M2b has settled what the editor colours as code, or the mismatch
spreads to a second editor. F6 + M3 also waits for F5, which holds `WorkspaceFileEditor.tsx`.

| Phase                                                                                                       | Hot file                                         | Notes                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **M2b:** M2 follow-ups from the Wave 3 review                                                               | `CodeMirrorEditor.tsx`, `FileReferenceParser.ts` | All three items below, in one change or in order                                       |
| **F6 + M3:** YAML chips, nested markdown in prompt values, `.prompt.md` markdown, `$step:` names, `{{var}}` | `WorkspaceFileEditor.tsx`                        | One change, since both work over the same ranges. Split it if it won't fit one session |

M2b covers:

1. **[`prompt-markdown-code-colouring-disagrees-with-find-code-ranges`](../bugs/backlog/prompt-markdown-code-colouring-disagrees-with-find-code-ranges.md)**
   (medium). Decide, case by case, whether `findCodeRanges` should match CommonMark (this
   changes runtime expansion everywhere) or the editor should stop colouring the text as code.
   Flip each `agree: false` entry in the parity corpus in
   `CodeMirrorEditorMarkdown.test.tsx` to agree, or document why the gap is intended.
2. **[`prompt-editor-reference-link-split-by-markdown-emphasis`](../bugs/backlog/prompt-editor-reference-link-split-by-markdown-emphasis.md)**
   (low, cosmetic).
3. **The deferred code-range restyle** from plan M's "Code ranges" section: inline spans get
   the `codeSpan.border` box, and fences lose their background so nested-language colours
   show through. Keep the code-range mark at default precedence (see
   `webview-react-components.instructions.md`), so the suppressed-expansion squiggle stays
   visible.

Move each bug to `dev/bugs/implemented/` in the commit that fixes it, and mark the restyle
done in plan M's Phase 2 entry.

**Session split (orchestrated run, 2026-10-08).** M2b runs as two sessions: item 1 alone
(it can change runtime expansion), then items 2 and 3. F6 + M3 runs as three: **F6a** the
YAML/`.prompt.md` chips and the shared `PROMPT_TEXT` range state they need; **M3** nested
markdown in `.prompt.md` and YAML prompt values, reusing that range state; **F6b** the
completion polish (`$step:` names, `$endCondition:`/`$preCondition:` scoping, `{{var}}` in
both editors). The orchestrator's review pass makes the move to `dev/implemented/` described
under "Keeping this plan current".

## Release-relevance

None of these block the release checklist. If time is short before release, the order of
value is:

1. **F1's LSP exclusion.** It fixes a live double-attach for anyone who installs a YAML, JSON
   or Markdown server.
2. **M0.** Code in prompts becomes readable, and it is visible in every capture.
3. **B + M4.** VS Code stops linking references that won't expand.
4. **F4.** The workspace editor becomes a real ctrlyoke editor, which the phone-IDE pitch in
   `SCREENSHOTS_AND_MEDIA_PLAN.md` #10 relies on.

## Keeping this plan current

When a phase lands, mark it done here and in its own plan. When a plan gains or splits a
phase, update the edge table first. That table is the contract between the three plans.

When Wave 5 is done, move this plan to `dev/implemented/` together with the three plans it
stages (F, M and D), once each one's remaining phases are marked done. Fix the relative links
between them in the same commit.
