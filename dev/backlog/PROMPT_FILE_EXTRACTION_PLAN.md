# Prompt File Extraction Plan

## Overview

ctrlyoke has two leftover "create a prompt file" commands from before the dashboard had its own
editor. They disagree about where files go, one writes example scaffolding nobody asked for, and
one is half-dead:

| Command                      | Writes to             | Content          | Reachable from                         |
| ---------------------------- | --------------------- | ---------------- | -------------------------------------- |
| `ctrlyoke.createPromptFile`  | `.ctrlyoke/` **root** | example scaffold | Command Palette, Explorer folder menu  |
| `ctrlyoke.createDraftPrompt` | `.ctrlyoke/prompts/`  | empty file       | Command Palette (webview path is dead) |

Meanwhile the real feature these were standing in for was never built. The source-file parser and
CodeMirror UI recognize a prompt whose entire body is a file path, but there is no way to _produce_
one from prompt text you have already written.

There is also an important execution gap: `PromptFileParser` resolves file-backed prompts only
while loading a workflow. A path introduced later by a dashboard mutation is written straight into
`PromptQueue` and would be sent to the harness literally. The feature therefore needs a shared,
just-in-time prompt-content resolver; the existing load-time behavior is not sufficient (§4.4).

**Goal:** ship "Convert to prompt file" — a header button in the editor that writes the current
editor contents to `.ctrlyoke/prompts/<name>.prompt.md`, replaces the step's text with the path to
that file, and opens the file for editing. **Pressed on an empty editor it creates an empty prompt
file and links it**, which is the "I'd rather write this one in a real editor" flow that
`createDraftPrompt` existed for. One button therefore subsumes both legacy commands, and both get
deleted.

**Non-goals:** a file-backed _workflow_ concept (a step still stores a path string, nothing new is
persisted in the schema); multi-file or directory-scoped prompt libraries; deleting source prompt
files during conversion or export.

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

**Pre-existing mismatches to fix along the way:**

- `handleFileRefValidation` tries absolute → workspace root → `.ctrlyoke/`, but the parser _also_
  tries relative to the prompt file's own directory. A path that resolves on load can therefore
  show the "file not found" warning, and vice versa.
- `PromptLinkProvider.findPromptFileLinks()` contains a third copy of the parser's candidate order.
- Dashboard mutations are not reparsed, so a newly introduced path does not resolve at execution.

One backend resolver must own candidate generation and content loading, with parser, validation,
document links, execution, preview, and export calling the appropriate part of it (§4.4).

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

**Decision:**

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
  Delete them; retaining an intentionally unused layout API conflicts with the project's dead-code
  stance and leaves unnecessary test surface.
- `test/components/layout/EditorSection.test.tsx:18-25` mocks `IconToggleButton` by destructuring
  `activeLabel`/`inactiveLabel` and asserts on the rendered label text. Update it to assert on
  `title`/`aria-pressed` instead.

---

## 3. Behavior spec

### 3.1 Convert

1. Guard: prompt-mode step, not already a lone file path, not CLI-managed. **Empty text is
   allowed** — see step 3.
2. Derive a filename, in priority order:
   1. the editor store's `promptName` (persisted as the step's `name`) if set, slugified
      (`Fix flaky tests` → `fix-flaky-tests.prompt.md`);
   2. otherwise the first ~6 words of the first non-empty line, slugified;
   3. otherwise `YYYYMMDD-HHmmss.prompt.md` (the existing `createDraftPrompt` scheme, which is what
      an empty editor always falls through to).
      Normalize to a bounded ASCII slug, reject Windows device basenames, and fall back to the
      timestamp when the result is empty/unsafe. On collision, suffix `-2`, `-3`, … Never
      overwrite.
3. Write the **exact current editor text** (no template, no frontmatter) to
   `.ctrlyoke/prompts/<name>.prompt.md` — an empty editor writes an empty file, which is the
   draft-prompt flow. The directory is no longer pre-created by `WorkspaceInitializer`, so the
   writer must `mkdir` it (see §5.3).
4. Reply with a canonical lone-prompt reference — for example
   `./.ctrlyoke/prompts/fix-flaky-tests.prompt.md`. Do **not** use
   `buildFileReferenceValue()` unchanged: it normalizes/quotes an existing path but does not add
   the leading `./` that `looksLikeFilePath()` requires in a single-root workspace. Add a dedicated
   `buildPromptFileReferenceValue()` helper that normalizes separators and guarantees a recognized
   relative-path prefix. Do not quote a lone prompt path: the entire string is already the path and
   `looksLikeFilePath()` does not treat surrounding quotes as syntax.
5. Webview replaces the editor content with that string and persists it through the **existing**
   mutation path (`postWorkflowDefinitionMutation` with `UPDATE_PROMPT` / `UPDATE_FINAL_PROMPT`, or
   held as new-prompt text if the step has not been created yet) — no new persistence path, and no
   schema change: the step's `prompt` is still just a string.
6. After the successful reply, open the returned resolved path honoring
   `ui.openPromptsInSecondGroup`. This is the setting's new reason to exist and it stays valid
   unchanged. For the empty-file case this is not optional — the whole point of pressing the
   button on an empty editor is to land in the file editor. Late replies for an expired `seq` are
   ignored.

### 3.1a Empty prompt files execute as their own path — handle it

`PromptFileParser.resolvePromptContent()` returns the **original value** when the referenced file
is empty (`PromptFileParser.ts:250-253`). So a step pointing at a not-yet-written draft does not
fail — it sends the harness the literal path string.

Since this plan makes empty prompt files a first-class authoring flow, that fallback must be
removed at the shared resolver boundary:

- The file-ref badge (`PromptEditor.tsx:887`) currently distinguishes only found / not-found. Add a
  third state: **found but empty** → warning color, "Prompt file is empty".
- `VALIDATE_FILE_REF` / `FILE_REF_VALIDATION` must carry that: return `{ exists, isEmpty }` rather
  than `exists` alone. "Empty" means `content.trim().length === 0`, not only a zero-byte file.
- The resolver returns the file's raw content (including `""` for a zero-byte file), never the path
  as a fallback after a file successfully resolves. Missing/unreadable intentional prompt
  references are errors, not literal prompts; existing consumer trimming remains the effective
  prompt normalization.
- Execution and preview resolve just in time without mutating the persisted step. Existing
  empty-prompt validation then rejects `""` in CLI/MCP/extension execution as well as in the UI.
- The empty-draft badge cannot remain stale after the user types in the opened file. Revalidate on
  webview focus and poll at a low rate only while the current target is missing/empty; stop once it
  becomes non-empty, the editor target changes, or the component unmounts. Execution-time
  resolution remains authoritative, so stale UI validation must never be the only run gate.

This is intentionally a pre-release behavior correction: no execution surface may send a file path
as prompt text merely because its target is empty or unreadable.

### 3.2 Round trip

- **Open** (button's second state): use the latest successful validation's resolved absolute path,
  same second-group rule. Disable the action while validation is pending or missing; an empty but
  existing file remains openable.
- **Inline back** (reverse conversion): out of scope for v1. When added, it must read the file,
  replace the step text with its contents, and _not_ delete the file — deleting user files from a
  toolbar button needs a confirm, and `ui.confirmDeleteOperations` already exists for that.

### 3.3 Failure modes

| Case                       | Behavior                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| No workspace folder        | error toast, editor unchanged                                                    |
| Write fails (EACCES, disk) | error toast, editor unchanged — never clear text before the reply lands          |
| Reply never arrives        | timeout like `PASTED_IMAGE_SAVE_TIMEOUT_MS`; clear busy state, editor unchanged  |
| Step is mid-execution      | button disabled (reuse `isRunning` / completed-step logic in `PromptEditor.tsx`) |

The editor text must survive every failure. Conversion is not optimistic: do not replace or clear
the editor until a matching success reply arrives. A timed-out write may leave an unreferenced file
in `.ctrlyoke/prompts/`; that is harmless, and a late reply must not change the editor.

---

## 4. Implementation

### 4.1 New message pair

In `DashboardConstants.ts` `MESSAGE_TYPES`: `CONVERT_PROMPT_TO_FILE` (webview → extension:
`{ seq, text, suggestedName? }`) and `PROMPT_FILE_CREATED` (extension → webview:
`{ seq, reference, resolvedPath, error? }`). Route in `WebviewMessageRouter.registerPromptEditor…`
alongside `SAVE_PASTED_IMAGE`; implement in `PromptEditorSupportService`.

Add `OPEN_PROMPT_FILE` (webview → extension: `{ path }`) for both the post-create open and the
button's existing-ref state. It re-applies host-side file-access checks and opens with
`ui.openPromptsInSecondGroup`; the generic `OPEN_FILE` path does not express that placement rule.

Also make lone-file validation addressed and race-safe. `VALIDATE_FILE_REF` carries
`{ seq, filePath, address }`; `FILE_REF_VALIDATION` echoes `seq` and `filePath` and returns
`{ exists, isEmpty, resolvedPath? }`. The webview accepts only the latest matching response. This
both supplies the open action with the exact resolved target and prevents a slow response for the
previous editor value from repainting the current badge.

### 4.2 Writer

Add `createPromptFile(text, suggestedName)` to a small filesystem helper called by
`PromptEditorSupportService`; do not revive `WorkflowCommandHandler`. The handler is VS
Code-command-shaped while this flow is client-message-shaped, and hosted dashboard clients already
route through the same extension-host service.

Treat `suggestedName` as untrusted input. Resolve the candidate under the workspace's canonical
`.ctrlyoke/prompts/` directory, reject traversal/symlink escapes, and create with exclusive
`wx` semantics so collision detection and writing are one atomic operation. An `exists` check
followed by ordinary `writeFile` can race and violate the never-overwrite guarantee.

### 4.3 Webview

`EditorSection.tsx` renders the button but should not own the logic — `promptText`, `isFileRef` and
the mutation calls all live in `PromptEditor.tsx`. Lift the shared bits into `editorStore` (or pass a
callback down) rather than duplicating `looksLikeFilePath` in both components; `EditorSection`
already re-derives `stepCount` in a comment-flagged mirror of `PromptEditor`, and this would be a
second such mirror.

### 4.4 Make file-backed prompts a real runtime contract (prerequisite)

Create a Node-capable `PromptFileResolver` next to, but **not inside**,
`src/utils/promptPathUtils.ts`. That existing module is deliberately browser-safe and must remain
free of `fs`, `path`, `vscode`, and other Node APIs.

The resolver owns:

1. candidate generation in the current order: absolute → source workflow directory → named/primary
   workspace root → `.ctrlyoke/`;
2. existence/type/readability checks; and
3. raw content loading plus semantic emptiness (`trim().length === 0`), and an error for a
   missing/unreadable intentional reference.

Use it from `PromptFileParser`, `PromptEditorSupportService`, and
`PromptLinkProvider.findPromptFileLinks()` so all three stop mirroring the order. Validation must
derive the source directory from the addressed lineage's `descriptor.originalFile`; for a
dashboard-created draft with no original file, omit that candidate and fall back to the workspace
root. Never use the `.runs/...` working-copy directory as the semantic base for an authored
relative reference.

Thread that semantic source path as runtime context, not a schema field: direct CLI/MCP/file loads
use the input definition path; dashboard runs use the lineage's `originalFile`; drafts with no
source use no source-directory candidate. Do not infer it later from the internal working-copy path.

During parse, statically resolvable lone paths are validated/read for an early error but retained as
paths. A path containing `{{var}}` is retained and deferred until substitution at preview/execution;
the parser cannot resolve a runtime override safely.

Persist the raw path string in `PromptStep.prompt`; do not replace it with file contents during
normalization. At execution and preview, apply `VarSubstitutor` first and then resolve the resulting
lone path into a local copy, without mutating queue state or the working file. That makes edits
performed in the newly opened text file visible on the next run, supports variable-backed paths,
and makes load-time and dashboard-created references behave identically. Token estimation/dry-run
code that consumes the effective prompt must use the same resolved copy.

The portability bundler calls the same resolver when inlining a lone prompt reference. This is the
single contract that keeps execution, validation, links, preview, and export from drifting.

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
- **This plan's phase 3 (the writer) must land before the portability plan's phase 6** (adding
  `prompts/` to `GITIGNORE_CONTENT`) _and_ after its phase 3 (bundling). Shipping the ignore entry
  while Save As still copies only the definition is the window where exported workflows silently
  lose their prompt files.

## 7. Phasing

| Phase | Scope                                                                                   |
| ----- | --------------------------------------------------------------------------------------- |
| 0     | None — the §6 tracking question is settled in `WORKFLOW_PORTABILITY_PLAN.md`            |
| 1     | Shared resolver + preserve refs + just-in-time execution/preview resolution (§4.4)      |
| 2     | Gitignore toggle → icon-only; prune `IconToggleButton` label machinery; update its test |
| 3     | Message pair + writer + button (convert / empty-draft / open states)                    |
| 4     | Empty-file UX (§3.1a): validation `isEmpty`, badge, addressed revalidation              |
| 5     | Delete `createPromptFile`, `createDraftPrompt`, dead `NEW_PROMPT` route; update docs    |
| 6     | (Later) Inline-back-into-step reverse action                                            |

Phases 1 and 2 can land first. Phase 1 is a hard prerequisite for both portability bundling and this
plan's phase 3: without just-in-time resolution, a converted dashboard step executes the path
itself. Phase 4 ships in the same release as phase 3. The portability plan's phase table is the
cross-plan master sequence: shared resolver → bundler → writer/UX → ignore entries.

## 8. Testing

- `src/test/**` (Mocha): filename derivation and collision suffixing; empty editor produces an empty
  file under the timestamp name; reserved/traversal names and symlink escapes are rejected; two
  concurrent creates cannot overwrite each other; writer creates `.ctrlyoke/prompts/` when absent;
  shared path resolver agrees across parser, validation, and document-link callers for all four
  resolution positions; canonical generated refs begin `./` and are recognized in single- and
  multi-root workspaces; a path introduced by `UPDATE_PROMPT` resolves to current file contents at
  execution and preview time without replacing the persisted path; empty/missing/unreadable refs
  fail instead of executing their path; `FILE_REF_VALIDATION` reports `isEmpty` for zero-byte and
  whitespace-only targets.
- `src/ui/webview-react/test/**` (Vitest): button hidden for script steps and CLI-managed
  workflows; tooltip/icon across all four states including empty; editor text remains unchanged
  when the reply carries an error; late create and validation replies are ignored; empty-file badge
  state; missing/empty revalidation stops after the file becomes non-empty or the target changes;
  open uses the resolved validation path; `EditorSection.test.tsx` mock updated for the icon-only
  toggle.
- `cli.integration.test.ts` registered-command list updated for the deletions.

## 9. Docs to update

- `QUICK_START.md:200` — "New Draft Prompt" row.
- `docs/reference/commands.md` — remove deleted commands; document the editor button.
- `dev/reference/VSCODE_COMMANDS.md` — regenerate.
- `.github/instructions/orchestration.instructions.md:53` — the bullet describing the
  `createPromptFile` / `createDraftPrompt` split becomes stale the moment §5 lands; replace it with
  the new rule (prompt files are produced by the editor's convert action into `.ctrlyoke/prompts/`;
  workflow files live at the `.ctrlyoke/` root) or drop it if the code makes it obvious.
