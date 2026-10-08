# Editor Intelligence Staging Plan

**Status (2026-10-08):** In progress. **Wave 1 is done** (F1, F2, D1, M1 and M0), and so is
**F1b**, the follow-up the Wave 1 review added. **Wave 2 has started: F3 is done.** F0, D2
and B + M4 remain, and nothing in them waits on anything else. This plan only orders the work. The design lives in the three plans it
stages.

This plan is the authoritative order for three overlapping plans:

| Key   | Plan                                                                                                                                                                                                                   | Phases                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **F** | [`WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md`](WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md): ctrlyoke completions, chips and diagnostics for workflow files in the hosted workspace editor, plus VS Code parity | F0–F7 = its Phases 0–7, plus F1b = its Phase 1b |
| **M** | [`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md`](PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md): markdown highlighting for prompt text, the shared syntax palette, and the VS Code injection grammar                      | M0–M4 = its Phases 0–4                          |
| **D** | [`PROMPT_DIAGNOSTICS_PLAN.md`](PROMPT_DIAGNOSTICS_PLAN.md): shared prompt-text lint rules and VS Code's diagnostics provider                                                                                           | D1–D3 = its Phases 1–3                          |
| **B** | [`vscode-prompt-references-active-inside-code`](../bugs/backlog/vscode-prompt-references-active-inside-code.md): VS Code links and completes references inside code                                                    | one fix                                         |

The language intelligence plan these build on is already implemented
(`dev/implemented/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`), so nothing here waits on
it.

## Progress

| Phase           | State                 | Notes                                                                                                                                                                                                                                |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1              | **Done** (2026-10-08) | File predicate, language-server exclusion, `getWorkflowLocation`/`findRangeForPath` for YAML, JSON and `.prompt.md`, `WORKFLOW_TEXT_FIELDS`. Deviations in plan F's Phase 1 entry; the review's bugs were fixed in F1b.              |
| F2              | **Done** (2026-10-08) | Generated `WorkflowSchemaOutline` (`schema:update`, `precompile`, `check:docs` drift check), hand-authored `WorkflowPropertySnippets.ts`, and `PromptPropertyCompletionProvider` moved onto both. Details in plan F's Phase 2 entry. |
| D1              | **Done** (2026-10-08) | `src/utils/PromptDiagnosticRules.ts` and `src/utils/PromptReferenceScanner.ts`; CodeMirror linters are adapters. Characterization tests pass against the pre-extraction code too. Details in plan D's "Phase 1 as built".            |
| M1              | **Done** (2026-10-08) | `--cy-syntax-*` in `globals.css`, one role table in `utils/syntaxPalette.ts`, `resolveCodeMirrorLanguage`. Visual check done. Its one hosted regression is fixed: `hosted-high-contrast-light-syntax-colours`.                       |
| M0              | **Done** (2026-10-08) | `.cm-code-range` restyled to the editor font on a preformat background.                                                                                                                                                              |
| F1b             | **Done** (2026-10-08) | Added by the Wave 1 review: the F1/F2 bug fixes plus `getWorkflowTextSpans` (decoded prompt ranges). Details in plan F's Phase 1b entry.                                                                                             |
| F3              | **Done** (2026-10-08) | `WorkflowFileCompletionCore`: key and value items, `WorkflowValueDataSource`, document-aware step numbers and effective-harness models, per-object snippets, shared JSON escape. Details in plan F's Phase 3 entry.                  |
| Everything else | Not started           |                                                                                                                                                                                                                                      |

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

| Phase      | Needs            | Why                                                                                                                             |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| M0, M1, F2 | none             | Self-contained                                                                                                                  |
| F1         | none             | New pure modules plus the server-side exclusion                                                                                 |
| D1         | none             | Characterization tests, then extraction                                                                                         |
| F0         | D1               | Same file as D1. Run serially so the two extractions don't conflict.                                                            |
| F1b        | F1, F2           | Fixes their review bugs and adds `getWorkflowTextSpans`                                                                         |
| F3         | F1b              | Completion items need a correct location and outline; the F1b bugs all land on key completions                                  |
| B          | F1b              | Decoded prompt ranges come from `getWorkflowTextSpans`, so no throwaway extractor                                               |
| M4         | F1, ships with B | The grammar is generated from `WORKFLOW_TEXT_FIELDS`. Shipping it without B makes backticks look literal while they still link. |
| D2         | D1, F1b          | Prompt values, `.prompt.md` bodies included, come from `getWorkflowTextSpans`                                                   |
| M2         | M1, D1, F0       | Palette; lint precedence over the D1 adapters; same file as F0                                                                  |
| F4         | F0, F1, F3       | As stated in plan F                                                                                                             |
| F5         | F4, D1           | Workspace lint uses D1's rules. The compartment comes from F4.                                                                  |
| F7         | F3               | VS Code value completions share F3                                                                                              |
| D3         | D2, F5           | Needs the side-effect-free `PromptFileParser` validate added in F5                                                              |
| F6 + M3    | F4, M2           | YAML chips and nested markdown share the same `PROMPT_TEXT` ranges and compartment, so they are planned as one change           |

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

Every input is on `main`. The only ordering left is the worktree split: D2 follows F0 in
`small-feature`.

| Phase                                                           | Hot file                                | Suggested worktree | Notes                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **F3:** completion items                                        | —                                       | `big-feature`      | Plan F's Phase 3 lists what the Phase 1/2 API leaves to it (root mode filtering, step-type keys, per-object snippets) |
| **F0:** completion-client extraction                            | `CodeMirrorEditor.tsx`                  | `small-feature`    |                                                                                                                       |
| **D2:** VS Code diagnostics provider                            | `extension.ts` registration             | `small-feature`    | After F0 in the same worktree. Uses `getWorkflowTextSpans` for every file kind. Takes plan D's listed cleanups.       |
| **B + M4:** VS Code literal-reference fix and injection grammar | `package.json` (`contributes.grammars`) | `bug-fix`          | Merge them together. B uses `getWorkflowTextSpans`; M4's generator reads `WORKFLOW_TEXT_FIELDS`                       |

### Wave 3: the two editors

| Phase                                 | Hot file                  | Notes                           |
| ------------------------------------- | ------------------------- | ------------------------------- |
| **M2:** markdown in the prompt editor | `CodeMirrorEditor.tsx`    | After F0                        |
| **F4:** workspace editor completions  | `WorkspaceFileEditor.tsx` |                                 |
| **F7:** VS Code completion parity     | —                         | Can run alongside anything here |

### Wave 4: diagnostics everywhere

| Phase                                                                 | Hot file                  | Notes                                            |
| --------------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| **F5:** workspace editor diagnostics and hover                        | `WorkspaceFileEditor.tsx` | Adds the `PromptFileParser` validate entry point |
| **D3:** workflow-aware context and YAML schema diagnostics in VS Code | —                         | After F5                                         |

### Wave 5: prompt-text polish in the workspace editor

| Phase                                                                                                       | Hot file                  | Notes                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| **F6 + M3:** YAML chips, nested markdown in prompt values, `.prompt.md` markdown, `$step:` names, `{{var}}` | `WorkspaceFileEditor.tsx` | One change, since both work over the same ranges |

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
