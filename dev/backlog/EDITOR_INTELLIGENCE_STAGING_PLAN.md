# Editor Intelligence Staging Plan

**Status (2026-10-08):** In progress. **M1 is done** (single-source palette, in `bug-fix`). Every
other phase is not started. This plan only orders the work. The design lives in the three
plans it stages.
**Status (2026-10-08):** In progress. **F1 and F2 are done**; nothing else is implemented yet. This plan
only orders the work. The design lives in the three plans it stages.

This plan is the authoritative order for three overlapping plans:

| Key   | Plan                                                                                                                                                                                                                   | Phases                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **F** | [`WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md`](WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md): ctrlyoke completions, chips and diagnostics for workflow files in the hosted workspace editor, plus VS Code parity | F0–F7 = its Phases 0–7 |
| **M** | [`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md`](PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md): markdown highlighting for prompt text, the shared syntax palette, and the VS Code injection grammar                      | M0–M4 = its Phases 0–4 |
| **D** | [`PROMPT_DIAGNOSTICS_PLAN.md`](PROMPT_DIAGNOSTICS_PLAN.md): shared prompt-text lint rules and VS Code's diagnostics provider                                                                                           | D1–D3 = its Phases 1–3 |
| **B** | [`vscode-prompt-references-active-inside-code`](../bugs/backlog/vscode-prompt-references-active-inside-code.md): VS Code links and completes references inside code                                                    | one fix                |

The language intelligence plan these build on is already implemented
(`dev/implemented/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`), so nothing here waits on
it.

## Progress

| Phase           | State                 | Notes                                                                                                                                                                                                                                |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1              | **Done** (2026-10-08) | File predicate, language-server exclusion, `getWorkflowLocation`/`findRangeForPath` for YAML, JSON and `.prompt.md`, `WORKFLOW_TEXT_FIELDS`. The deviations from plan F are in its Phase 1 entry.                                    |
| F2              | **Done** (2026-10-08) | Generated `WorkflowSchemaOutline` (`schema:update`, `precompile`, `check:docs` drift check), hand-authored `WorkflowPropertySnippets.ts`, and `PromptPropertyCompletionProvider` moved onto both. Details in plan F's Phase 2 entry. |
| Everything else | Not started           |                                                                                                                                                                                                                                      |

F1 and F2 together unblock F3 and the workflow-file half of D2; F1 alone unblocks B and M4. D1, M0
and M1 never depended on either and can start now.

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

| Phase      | Needs                          | Why                                                                                                                             |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| M0, M1, F2 | none                           | Self-contained                                                                                                                  |
| F1         | none                           | New pure modules plus the server-side exclusion                                                                                 |
| D1         | none                           | Characterization tests, then extraction                                                                                         |
| F0         | D1                             | Same file as D1. Run serially so the two extractions don't conflict.                                                            |
| F3         | F1, F2                         | Completion items need the location and the outline                                                                              |
| B          | F1                             | Decoded prompt ranges come from `getWorkflowLocation`, so no throwaway extractor                                                |
| M4         | F1, ships with B               | The grammar is generated from `WORKFLOW_TEXT_FIELDS`. Shipping it without B makes backticks look literal while they still link. |
| D2         | D1, plus F1 for workflow files | `.prompt.md` support needs only D1                                                                                              |
| M2         | M1, D1, F0                     | Palette; lint precedence over the D1 adapters; same file as F0                                                                  |
| F4         | F0, F1, F3                     | As stated in plan F                                                                                                             |
| F5         | F4, D1                         | Workspace lint uses D1's rules. The compartment comes from F4.                                                                  |
| F7         | F3                             | VS Code value completions share F3                                                                                              |
| D3         | D2, F5                         | Needs the side-effect-free `PromptFileParser` validate added in F5                                                              |
| F6 + M3    | F4, M2                         | YAML chips and nested markdown share the same `PROMPT_TEXT` ranges and compartment, so they are planned as one change           |

## Waves

Every phase in a wave can run in parallel, apart from the one-at-a-time hot files. Each wave
lists a suggested split across the long-lived worktrees (`big-feature`, `small-feature`,
`bug-fix`). Any split that respects the hot-file rule works.

### Wave 1: foundations and quick wins

| Phase                                              | Hot file                                                             | Suggested worktree                         |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| **F1:** location, file predicate, LSP exclusion    | —                                                                    | `big-feature`                              |
| **F2:** schema outline and shared snippets         | —                                                                    | `big-feature` after F1, or `small-feature` |
| **D1:** characterization tests and rule extraction | `CodeMirrorEditor.tsx`                                               | `small-feature`                            |
| **M1:** single-source palette ✅ done 2026-10-08   | — (`codemirrorLanguage.ts`, `syntaxHighlighting.tsx`, `globals.css`) | `bug-fix`                                  |
| **M0:** readable code ranges                       | `CodeMirrorEditor.tsx`, a one-rule theme change                      | run after D1, or before D1 starts          |

M0 is the cheapest visible win. It can land on day one, before D1 starts.

### Wave 2: consumers of the core

| Phase                                                           | Hot file               | Notes                                                |
| --------------------------------------------------------------- | ---------------------- | ---------------------------------------------------- |
| **F0:** completion-client extraction                            | `CodeMirrorEditor.tsx` | After D1                                             |
| **F3:** completion items                                        | —                      | After F1 and F2                                      |
| **B + M4:** VS Code literal-reference fix and injection grammar | —                      | Ship together in one change                          |
| **D2:** VS Code diagnostics provider                            | —                      | Start with `.prompt.md`, then workflow prompt values |

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
