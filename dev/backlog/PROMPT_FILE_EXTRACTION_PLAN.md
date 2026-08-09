# Prompt File Extraction Plan

## Overview

ctrlyoke has two leftover "create a prompt file" commands from before the dashboard had its own
editor. They disagree about where files go, one writes example scaffolding nobody asked for, and
one is half-dead:

| Command                      | Writes to             | Content          | Reachable from                         |
| ---------------------------- | --------------------- | ---------------- | -------------------------------------- |
| `ctrlyoke.createPromptFile`  | `.ctrlyoke/` **root** | example scaffold | Command Palette, Explorer folder menu  |
| `ctrlyoke.createDraftPrompt` | `.ctrlyoke/prompts/`  | empty file       | Command Palette (webview path is dead) |

Meanwhile the real feature these were standing in for was never built: the dashboard's CodeMirror
editor already understands a prompt whose entire body is a file path (it inlines that file's
contents at parse time), but there is no way to _produce_ one from prompt text you have already
written.

**Goal:** ship "Convert to prompt file" — a header button in the editor that writes the current
editor contents to `.ctrlyoke/prompts/<name>.prompt.md`, replaces the step's text with the path to
that file, and opens the file for editing. **Pressed on an empty editor it creates an empty prompt
file and links it**, which is the "I'd rather write this one in a real editor" flow that
`createDraftPrompt` existed for. One button therefore subsumes both legacy commands, and both get
deleted.

**Non-goals:** changing how `PromptFileParser` inlines file-ref prompts; a file-backed _workflow_
concept (a step still stores a path string, nothing new is persisted in the schema); multi-file or
directory-scoped prompt libraries.

---

## 1. Current state

### 1.1 `ctrlyoke.createPromptFile` — legacy, replaceable

`extension.ts:698` → `WorkflowOrchestrator.createPromptFile()` (`:4685`) →
`WorkflowCommandHandler.createPromptFile()` (`WorkflowCommandHandler.ts:56`).

Prompts for a filename (validating `.ctrlyoke.yaml` / `.yml` / `.json` / `.prompt.md`), writes
example content from `createExampleCtrlYokeYAML()` / `...JSON()` / `createExampleMarkdownPrompt()`,
and opens it via `openPromptFile()`.

Two defects worth recording before it is deleted:

- The local is named `promptsDirPath` but is `.ctrlyoke/` itself (`:100-103`) — the source of the
  "one writes to `.ctrlyoke`, one to `.ctrlyoke/prompts`" confusion. The path is intentional
  (workflow files live at the `.ctrlyoke/` root); only the name is wrong.
- It is contributed to `explorer/context` under `when: explorerResourceIsFolder`
  (`package.json:373`), but the handler takes no arguments and ignores the clicked folder. Right-
  clicking `src/features/` and choosing "Create Prompt File" silently writes to `.ctrlyoke/`.

### 1.2 `ctrlyoke.createDraftPrompt` — partly dead

`extension.ts:932` → `WorkflowOrchestrator.createDraftPrompt()` (`:4701`) →
`WorkflowCommandHandler.createDraftPrompt()` (`WorkflowCommandHandler.ts:151`).

Writes an **empty** `YYYYMMDD-HHmmss.prompt.md` under `.ctrlyoke/prompts/`, opens it honoring
`ui.openPromptsInSecondGroup`, and then — unlike `createPromptFile` — binds it as the active
workflow's current file: `setCurrentPromptFile(...)`, `initializeFileWatcher(...)`, and a
`FILE_SELECTED` push to the panel (`WorkflowOrchestrator.ts:4704-4722`).

Its dashboard entry point is dead. `WebviewMessageRouter.ts:423` maps `MESSAGE_TYPES.NEW_PROMPT`
to this command, but **no code under `src/ui/webview-react` posts that message** — the dashboard's
"new prompt" affordance is `editorStore.preparePromptEditorForInsert()`, entirely in-webview.

> Trap: `MESSAGE_TYPES.NEW_PROMPT` and `EDITOR_TARGET_KINDS.NEW_PROMPT`
> (`DashboardConstants.ts:59` and `:999`) are both the literal `"newPrompt"`. Grepping the string
> finds the live editor-target constant and makes the dead message look used. Search for
> `MESSAGE_TYPES.NEW_PROMPT` specifically.

### 1.3 What already exists for file-ref prompts

This is the foundation the feature sits on — most of it is already built:

| Piece                  | Where                                                                               | Does                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `looksLikeFilePath()`  | `src/utils/promptPathUtils.ts:28`                                                   | shared heuristic, used by parser **and** webview                                |
| Inline-at-parse        | `PromptFileParser.resolvePromptContent()` `:203`                                    | a step whose `prompt` is a lone path becomes that file's text                   |
| Path resolution        | `PromptFileParser.resolvePromptFilePath()` `:275`                                   | absolute → prompt file's dir → workspace root (named-root aware) → `.ctrlyoke/` |
| Editor detection       | `PromptEditor.tsx:149` (`isFileRef`)                                                | drives badge + validation                                                       |
| Existence check        | `VALIDATE_FILE_REF` → `PromptEditorSupportService.handleFileRefValidation()` `:180` | debounced 400 ms, replies `FILE_REF_VALIDATION`                                 |
| File-ref badge         | `PromptEditor.tsx:887-905`                                                          | link-colored, warns when the file is missing                                    |
| Clickable lone path    | `CodeMirrorEditor.tsx:2359-2379`                                                    | `cm-link cm-prompt-file-ref` decoration                                         |
| Spellcheck suppression | `CodeMirrorEditor.tsx:1871-1878`                                                    | a lone path is not prose                                                        |

**Pre-existing mismatch to fix along the way:** `handleFileRefValidation` tries absolute → workspace
root → `.ctrlyoke/`, but the parser _also_ tries relative to the prompt file's own directory. A
path that resolves at run time can therefore show the "file not found" warning, and vice versa.
Extract one shared resolver and have both call it (§4.4).

**Closest precedent to copy:** pasted images. `SAVE_PASTED_IMAGE` →
`PromptEditorSupportService.handleSavePastedImage()` (`:238`) writes into `.ctrlyoke/attachments/`
via `TempFileManager`, converts the result with `buildFileReferenceValue()`, and replies
`PASTED_IMAGE_SAVED` with the reference string for the editor to insert. The conversion flow is the
same shape — webview asks the extension to write a file, gets back the reference text to swap in.

---

## 2. Target UX

### 2.1 The button

Placed in the `EditorSection` header (`EditorSection.tsx:297-311`), to the left of the gitignore
toggle, hidden when `isCLIManaged` or `isScriptMode`.

**Recommendation:**

| State                         | Codicon             | Tooltip                       |
| ----------------------------- | ------------------- | ----------------------------- |
| Editor holds prompt text      | `file-symlink-file` | "Convert to prompt file"      |
| Editor is empty               | `file-symlink-file` | "Write this prompt in a file" |
| Editor holds a lone file path | `go-to-file`        | "Open prompt file"            |
| Script step                   | hidden              | —                             |

The empty state deliberately keeps the same icon and enabled state — it is the same operation
(this step's text lives in a file from now on), just with nothing to move yet.

`file-symlink-file` is what VS Code itself uses for "Move to file" refactors, so the "this content
moves into a file and gets linked" reading is already learned; it is also what
`ctrlyoke.loadFromContext` uses, which keeps the icon meaning consistent across the extension.
`go-to-file` for the second state gives the button a useful job once conversion has happened,
rather than disabling it.

Alternatives considered: `new-file` (reads as "blank file", loses the _move_ meaning),
`save-as` (implies the step content is being duplicated, not relocated), `link-external` (means
"leaves VS Code" elsewhere in the UI).

Name the visible action **"Convert to prompt file"**, not "Edit as file" — the durable change is
where the content lives; opening the editor is a side effect.

### 2.2 Making room: gitignore toggle goes icon-only

`EditorSection.tsx:299-310` passes `activeLabel="Excluding ignored files"` /
`inactiveLabel="Including all files"` with `labelPosition="left"`. Drop both labels; keep
`activeTooltip`/`inactiveTooltip` as-is (they already say the same thing more precisely). The
`narrow` prop then has no effect on this button and can go too.

Consequences to handle in the same change:

- `EditorSection` is the **only** production caller of `IconToggleButton`
  (`components/shared/IconToggleButton.tsx`), so its `activeLabel`/`inactiveLabel`/`narrow`/
  `labelPosition` props and the invisible-spacer layout-shift machinery (`:36-57`) become dead.
  Either delete them or leave them documented as intentionally-unused API — deleting is preferred
  per the project's dead-code stance; `scripts/find-dead-methods.mjs` will flag them otherwise.
- `test/components/layout/EditorSection.test.tsx:18-25` mocks `IconToggleButton` by destructuring
  `activeLabel`/`inactiveLabel` and asserts on the rendered label text. Update it to assert on
  `title`/`aria-pressed` instead.

---

## 3. Behavior spec

### 3.1 Convert

1. Guard: prompt-mode step, not already a lone file path, not CLI-managed. **Empty text is
   allowed** — see step 3.
2. Derive a filename, in priority order:
   1. the step's `promptName` if set, slugified (`Fix flaky tests` → `fix-flaky-tests.prompt.md`);
   2. otherwise the first ~6 words of the first non-empty line, slugified;
   3. otherwise `YYYYMMDD-HHmmss.prompt.md` (the existing `createDraftPrompt` scheme, which is what
      an empty editor always falls through to).
      On collision, suffix `-2`, `-3`, … Never overwrite.
3. Write the **exact current editor text** (no template, no frontmatter) to
   `.ctrlyoke/prompts/<name>.prompt.md` — an empty editor writes an empty file, which is the
   draft-prompt flow. The directory is no longer pre-created by `WorkspaceInitializer`, so the
   writer must `mkdir` it (see §5.3).
4. Reply with the workspace-relative reference string (`buildFileReferenceValue`, same as pasted
   images) — for example `.ctrlyoke/prompts/fix-flaky-tests.prompt.md`.
5. Webview replaces the editor content with that string and persists it through the **existing**
   mutation path (`postWorkflowDefinitionMutation` with `UPDATE_PROMPT` / `UPDATE_FINAL_PROMPT`, or
   held as new-prompt text if the step has not been created yet) — no new persistence path, and no
   schema change: the step's `prompt` is still just a string.
6. Open the new file honoring `ui.openPromptsInSecondGroup`. This is the setting's new reason to
   exist and it stays valid unchanged. For the empty-file case this is not optional — the whole
   point of pressing the button on an empty editor is to land in the file editor.

### 3.1a Empty prompt files execute as their own path — handle it

`PromptFileParser.resolvePromptContent()` returns the **original value** when the referenced file
is empty (`PromptFileParser.ts:250-253`). So a step pointing at a not-yet-written draft does not
fail — it sends the harness the literal string `.ctrlyoke/prompts/20260808-141530.prompt.md`.

Since this plan makes empty prompt files a first-class flow rather than an accident, that silent
fallback has to be addressed, in the editor rather than the parser:

- The file-ref badge (`PromptEditor.tsx:887`) currently distinguishes only found / not-found. Add a
  third state: **found but empty** → warning color, "Prompt file is empty".
- `VALIDATE_FILE_REF` / `FILE_REF_VALIDATION` must carry that: return `{ exists, isEmpty }` rather
  than `exists` alone.
- Treat an empty referenced file the same as an empty prompt in run/queue guards, so the button
  cannot produce a step that silently executes its own path.

Leave the parser's fallback alone — changing it is a behavior change for every existing workflow,
and the warning belongs where the user can act on it.

### 3.2 Round trip

- **Open** (button's second state): open the resolved file, same second-group rule.
- **Inline back** (reverse conversion): out of scope for v1. When added, it must read the file,
  replace the step text with its contents, and _not_ delete the file — deleting user files from a
  toolbar button needs a confirm, and `ui.confirmDeleteOperations` already exists for that.

### 3.3 Failure modes

| Case                       | Behavior                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| No workspace folder        | error toast, editor unchanged                                                    |
| Write fails (EACCES, disk) | error toast, editor unchanged — never clear text before the reply lands          |
| Reply never arrives        | timeout like `PASTED_IMAGE_SAVE_TIMEOUT_MS`; restore editor text                 |
| Step is mid-execution      | button disabled (reuse `isRunning` / completed-step logic in `PromptEditor.tsx`) |

The editor text must survive every failure — the pasted-image flow's placeholder/restore pattern is
the model.

---

## 4. Implementation

### 4.1 New message pair

In `DashboardConstants.ts` `MESSAGE_TYPES`: `CONVERT_PROMPT_TO_FILE` (webview → extension:
`{ seq, text, suggestedName? }`) and `PROMPT_FILE_CREATED` (extension → webview:
`{ seq, reference, absolutePath, error? }`). Route in `WebviewMessageRouter.registerPromptEditor…`
alongside `SAVE_PASTED_IMAGE`; implement in `PromptEditorSupportService`.

### 4.2 Writer

Add `createPromptFile(text, suggestedName)` to whichever owner survives §5.2 —
`PromptEditorSupportService` calling a small helper is preferred over reviving
`WorkflowCommandHandler`, since the handler is VS Code-command-shaped and this flow is webview-shaped
(and must also work from the hosted server client eventually).

### 4.3 Webview

`EditorSection.tsx` renders the button but should not own the logic — `promptText`, `isFileRef` and
the mutation calls all live in `PromptEditor.tsx`. Lift the shared bits into `editorStore` (or pass a
callback down) rather than duplicating `looksLikeFilePath` in both components; `EditorSection`
already re-derives `stepCount` in a comment-flagged mirror of `PromptEditor`, and this would be a
second such mirror.

### 4.4 Unify path resolution (prerequisite)

Extract the parser's four-step order (`PromptFileParser.resolvePromptFilePath:275`) into a shared
helper next to `looksLikeFilePath` in `src/utils/promptPathUtils.ts`, taking an injected
"does this file exist" probe so both the extension host and the parser can use it. Point
`handleFileRefValidation` at it. Without this, a freshly converted prompt can show the "file not
found" warning depending on where the workflow file lives.

---

## 5. Removal

### 5.1 `ctrlyoke.createPromptFile` — delete

- `package.json`: `commands` entry (`:89-93`), `commandPalette` entry (`:297-299`),
  `explorer/context` entry (`:371-376`).
- `extension.ts:697-703` registration + the `createPromptFileCommand` subscription (`:1299`).
- `WorkflowOrchestrator.createPromptFile()` (`:4685-4687`).
- `WorkflowCommandHandler.createPromptFile()` (`:56-145`) and the example-content generators
  `createExampleCtrlYokeYAML` / `createExampleCtrlYokeJSON` / `createExampleMarkdownPrompt` — check
  first that `createNewTemplate` does not share them.
- `src/test/integration/cli.integration.test.ts:47` lists it among expected registered commands.
- `dev/reference/VSCODE_COMMANDS.md:355` (regenerate rather than hand-edit).
- Keep `openPromptFile()` (`:431`) — `openCurrentPromptFile` and the new flow both use it.

Users lose nothing: creating a workflow file is what `ctrlyoke.newWorkflow` (templates) and
`ctrlyoke.clearWorkflow` (blank) already do, and both produce a real workflow rather than a
commented example.

### 5.2 `ctrlyoke.createDraftPrompt` — delete

The empty-editor behavior in §3.1 replaces it outright: same file, same directory, same
timestamp naming, same "open it and start typing" outcome — reached from the editor the user is
already looking at instead of the Command Palette.

Delete:

- `package.json:178-183` (`commands` entry).
- `extension.ts:931-937` registration + the `createDraftPromptCommand` subscription (`:1317`).
- `WorkflowOrchestrator.createDraftPrompt()` (`:4701-4723`).
- `WorkflowCommandHandler.createDraftPrompt()` (`:151-215`).
- The dead `MESSAGE_TYPES.NEW_PROMPT` route (`WebviewMessageRouter.ts:423-425`) and the constant
  (`DashboardConstants.ts:59`) — this also removes the `"newPrompt"` string collision with
  `EDITOR_TARGET_KINDS.NEW_PROMPT`.
- `QUICK_START.md:200`, `dev/reference/VSCODE_COMMANDS.md:352`.

**The one behavior not carried over, on purpose:** `createDraftPrompt` also bound the new file as
the active workflow's current file — `setCurrentPromptFile(...)`, `initializeFileWatcher(...)`, and
a `FILE_SELECTED` push (`WorkflowOrchestrator.ts:4704-4722`). That is a different feature ("this
`.prompt.md` _is_ the workflow now"), not "this step's text lives in a file", and the new button
must not do it — converting one step must never repoint the whole workflow. `ctrlyoke.clearWorkflow`
("New Blank Workflow", `Ctrl+Shift+N`) already covers starting fresh. If file-backed workflows are
wanted later they need their own design, not this button's side effect.

### 5.3 Init interaction

`WorkspaceInitializer` no longer creates `.ctrlyoke/prompts/` — every consumer `mkdir`s its own
directory (see `orchestration.instructions.md`, `<workspaceAndTemplates>`). The new writer must do
the same. Do not "fix" this by re-adding the directory to init.

---

## 6. Git implications

**Decided — see `dev/backlog/WORKFLOW_PORTABILITY_PLAN.md` for the full policy and rationale.**

`.ctrlyoke/prompts/` is **gitignored**, and the convert button writes there anyway. That is correct
rather than contradictory: converted prompts belong to ephemeral runs under `.runs/`, which is
itself ignored, and a workflow only becomes durable by being exported with Save As — which bundles
its dependencies (inlining lone prompt-file bodies, copying attachments into a sibling
`<workflow>.assets/`). The dangling-reference failure the ignore rule would otherwise create is
closed by the bundler, not by tracking the directory.

Two constraints this feature must respect:

- The button is **explicitly user-initiated**. Never auto-convert on length, on save, or on paste.
- **This plan's phase 3 (the writer) must land before the portability plan's phase 4** (adding
  `prompts/` to `GITIGNORE_CONTENT`) _and_ after its phase 2 (bundling). Shipping the ignore entry
  while Save As still copies only the definition is the window where exported workflows silently
  lose their prompt files.

## 7. Phasing

| Phase | Scope                                                                                       |
| ----- | ------------------------------------------------------------------------------------------- |
| 0     | None — the §6 tracking question is settled in `WORKFLOW_PORTABILITY_PLAN.md`                |
| 1     | Unify path resolution (§4.4) — standalone, shippable, fixes a real false warning today      |
| 2     | Gitignore toggle → icon-only; prune `IconToggleButton` label machinery; update its test     |
| 3     | Message pair + writer + button (convert / empty-draft / open states)                        |
| 4     | Empty-file warning state (§3.1a): `FILE_REF_VALIDATION` gains `isEmpty`; badge + run guards |
| 5     | Delete `createPromptFile`, `createDraftPrompt`, dead `NEW_PROMPT` route; update docs        |
| 6     | (Later) Inline-back-into-step reverse action                                                |

Phases 1 and 2 are independent of the rest and can land first. Phase 4 should not lag phase 3 —
the empty-draft flow is the one that produces the silent path-as-prompt execution.

## 8. Testing

- `src/test/**` (Mocha): filename derivation and collision suffixing; empty editor produces an empty
  file under the timestamp name; writer creates `.ctrlyoke/prompts/` when absent; shared path
  resolver agrees with `PromptFileParser` across all four resolution positions;
  `FILE_REF_VALIDATION` reports `isEmpty` for a zero-byte target.
- `src/ui/webview-react/test/**` (Vitest): button hidden for script steps and CLI-managed
  workflows; tooltip/icon across all four states including empty; editor text restored when the
  reply carries an error; empty-file badge state; `EditorSection.test.tsx` mock updated for the
  icon-only toggle.
- `cli.integration.test.ts` registered-command list updated for the deletions.

## 9. Docs to update

- `QUICK_START.md:200` — "New Draft Prompt" row.
- `docs/reference/commands.md` — remove deleted commands; document the editor button.
- `dev/reference/VSCODE_COMMANDS.md` — regenerate.
- `.github/instructions/orchestration.instructions.md:53` — the bullet describing the
  `createPromptFile` / `createDraftPrompt` split becomes stale the moment §5 lands; replace it with
  the new rule (prompt files are produced by the editor's convert action into `.ctrlyoke/prompts/`;
  workflow files live at the `.ctrlyoke/` root) or drop it if the code makes it obvious.
