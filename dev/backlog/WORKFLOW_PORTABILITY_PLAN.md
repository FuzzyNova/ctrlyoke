# Workflow Portability Plan — Save-As Bundling and `.ctrlyoke` Tracking Policy

## Overview

`.ctrlyoke/attachments/` and `.ctrlyoke/prompts/` currently serve two populations with nothing in
common:

- files referenced from an **ephemeral run** under `.runs/` — pasted debug screenshots, prompts
  composed in the dashboard. Lifetime: the run. Never leave the machine.
- files referenced from a **durable, committed workflow** — the hand-authored YAML case. Lifetime:
  the repo. Must travel with it.

There is no single ignore rule for a directory that holds both, which is why the tracking question
has felt unresolvable. The fix is not to pick a side but to separate the populations by lifecycle
and make the transition between them an explicit operation: **Save As**.

**Goal:** Save As stops emitting incomplete artifacts (a definition whose dependencies stay behind
on one machine), after which `attachments/` and `prompts/` can be ignored by default without
silently breaking anything.

**Non-goals:** a new workflow file format; syncing runs across machines; making favorites portable.

---

## 1. Where workflows live

**By default, work you do in the dashboard is machine-local.** Composing, queueing, appending, and
running all happen inside `.ctrlyoke/.runs/`, which is gitignored — along with the screenshots you
paste and the prompt files you create along the way. Most of that work is a conversation, not an
artifact, so none of it reaches a commit unless you ask for it.

**Durable workflows are files you author or export.** A `*.ctrlyoke.{yaml,yml,json}` or
`*.prompt.md` anywhere in the repo is tracked like any other source file, as is everything under
`templates/`. You get one by writing it directly or by exporting a run with Save As.

**How much is ignored is a dial, not a fixed setting.** `.ctrlyoke/.gitignore` is a plain file the
user owns; someone who wants their runs in source control edits it (see §4 for the one caveat that
makes that stick). So the split above is a default, not a mode the user is in.

Two supporting facts:

- **ctrlyoke's persistence already assumes the ephemeral default.** `isFavorite` lives in the
  lineage descriptor at `.ctrlyoke/.runs/<workflowKey>/workflow.json`
  (`WorkflowLineageRepository.ts:86`), which is gitignored — a favorite is a machine-local bookmark
  by construction. Runs, their definitions, and their metadata are all per-machine.
- **Save As is the only path _out_ of the ephemeral side.** Favorites don't travel, runs don't
  travel, attachments don't travel. Direct authoring stays fully first-class and is unaffected by
  anything here — but for work that started in the dashboard, the export is the single moment it
  becomes durable. That is what puts all the weight on Save As being complete (§3).

> **Deliberately unnamed.** An earlier draft called these "driver mode" and "asset mode". Dropped:
> the labels pushed the actual behavior behind a piece of vocabulary, implied a binary choice where
> the `.gitignore` is really a dial, and invited users to ask "which mode am I in?" instead of
> reading what happens. Describe the behavior; don't name the modes.

---

## 2. Tracking policy

**Rule: ignore what ctrlyoke generates for itself; track what you authored or explicitly
exported.**

| Path                                             | Verdict | Why                                                          |
| ------------------------------------------------ | ------- | ------------------------------------------------------------ |
| `certs/`, `notifications/`                       | ignore  | TLS private key; VAPID private key — **secrets, hard rule**  |
| `.runs/`, `.search-index/`, `logs/`, `temp/`     | ignore  | regenerable, machine-local, high churn                       |
| `capabilities.json`                              | ignore  | records which CLIs _this machine_ has installed              |
| `attachments/`                                   | ignore  | debug screenshots belonging to ephemeral runs                |
| `prompts/`                                       | ignore  | dashboard-composed prompt bodies belonging to ephemeral runs |
| `.gitignore`                                     | ignore  | itself (see §4)                                              |
| root `*.ctrlyoke.{yaml,yml,json}`, `*.prompt.md` | track   | the shareable artifact                                       |
| `<workflow>.assets/`                             | track   | exported dependencies — see §3                               |
| `templates/`                                     | track   | authored, reusable                                           |
| `scripts/`                                       | track   | referenced by `script:` / end conditions                     |
| `agents/`, `skills/`                             | track   | referenced by steps                                          |
| `mcp/servers.json`                               | track   | referenced by workflows                                      |
| `settings.json`                                  | track   | schema-validated project config (§2.2)                       |

Stated in one line for the docs:

> Nothing under `.ctrlyoke/` is committed except what you author (`templates/`, `scripts/`,
> `agents/`, `skills/`, `mcp/servers.json`, `settings.json`) or explicitly export with Save As.

### 2.1 Notes

- **`snapshots/` is intentionally absent from the generator.** It is written only by
  `UxSnapshotButton` (`src/ui/webview-react/components/dev/UxSnapshotButton.tsx`), which mounts
  only in dev builds with the developer setting on. Users never produce the directory, so the
  generated `.gitignore` should not mention it. This repo ignores it from the _root_ `.gitignore`
  because ctrlyoke develops itself. Do not "fix" this by adding it to `GITIGNORE_CONTENT`.
- **`<workflow>.assets/` must not be blanket-ignored**, including when a workflow is saved inside
  `.ctrlyoke/`. Exported assets are tracked by definition — that is the entire point of exporting
  them.
- **`ensureGitignore` only ever appends patterns, never prunes.** Anything added to the generated
  ignore-entry list is permanent for every existing workspace. Add deliberately.
- Adding entries is safe for existing users — `.gitignore` does not affect already-tracked files —
  which is also why the dangling-reference risk in §5 is easy to miss in testing: it only bites
  files created after the change.

### 2.2 `settings.json`

The generator does not ignore it (users track it by default), but this repo's own
`.ctrlyoke/.gitignore` does. **Decision: track it.** It holds harness defaults, permissions, and
queue/run behavior — team-shareable project config — and it is schema-validated
(`schemas/settings-schema.json`, wired through `package.json` `jsonValidation`). The
`server.certPath` / `server.keyPath` fields are machine-local; document that caveat. Git cannot
ignore individual JSON keys, so a future fix would need schema/config layering rather than another
`.gitignore` rule.

---

## 3. Save As becomes a bundle operation

### 3.1 Layout: sibling file + assets directory

**Decision: `my-workflow.ctrlyoke.yaml` plus, only when needed, a sibling `my-workflow.assets/`.**
Not a container directory per workflow.

Rationale:

- **Most workflows have no assets and must keep saving as exactly one file** — the property that
  makes a ctrlyoke workflow droppable anywhere, emailable, and pasteable into a gist. A container
  format taxes the 99% to serve the 1%.
- **Discovery is file-suffix based.** `WorkflowFileDiscovery.ts:18-23` matches `.ctrlyoke.json`,
  `.ctrlyoke.yaml`, `.ctrlyoke.yml`, `.prompt.md` on file names. A directory format needs a new
  discovery concept plus an in-directory naming convention, and every doc that says "create a file
  ending in `.ctrlyoke.yaml` anywhere in your workspace" becomes wrong.
- **The rest of the system addresses workflows by file path** — `descriptor.originalFile`, the
  Save-As default path (`WorkflowSerializer.ts:269-284`), `LAST_EXPORT_DIR_KEY`.
- Progressive disclosure: the folder appears only when the workflow has actually earned it.

Rejected: a zip/bundle single file — not diffable, not editable in place, not git-friendly.

The directory name is **derived, not chosen**: strip the workflow suffix from the file's basename
and append `.assets`. `fix-tests.ctrlyoke.yaml` → `fix-tests.assets/`. A derived name is what makes
the association visible in a directory listing and mechanical for the loader to check.

Sibling layout's one real weakness is "move the YAML, forget the assets". Mitigate:

1. Derived naming, above — the pairing is self-evident.
2. On load, a reference into a missing `*.assets/` directory produces one workflow-level warning;
   the editor's existing inline-context validation continues to mark each missing token. This is
   not the lone-prompt `FILE_REF_VALIDATION` path — `@` / `#selection:` / `#sym` references use
   `CONTEXT_REFS_VALIDATION`.
3. Re-saving over an existing workflow refreshes bundler-managed assets and prunes only files
   recorded in the previous bundle manifest (§3.4), preserving anything the user added by hand.

### 3.2 What gets bundled, inlined, and left alone

The rule is about _where a reference points_, not what kind of reference it is:

| Reference                                                            | Action                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lone step `prompt` resolving into `.ctrlyoke/prompts/**`             | **inline** the resolved content, including `""` for an empty draft                             |
| Inline `@`, `#selection:`, or `#sym` into `.ctrlyoke/attachments/**` | **copy** the underlying file into `<basename>.assets/`; rebuild the token with the new path    |
| Inline `@`, `#selection:`, or `#sym` into `.ctrlyoke/prompts/**`     | copy + rewrite — **do not inline** (see below)                                                 |
| Directory `@.../` into either generated store                        | block save and ask for explicit file refs; copying the shared store would leak unrelated files |
| Inline ref into ordinary repo files (`src/…`)                        | leave alone — travels with the repo                                                            |
| Missing generated-store ref or anything under `.ctrlyoke/temp/**`    | block save — emitting a knowingly incomplete artifact violates the goal                        |
| Generated-store path containing `{{var}}`                            | block save — export cannot know which runtime file to copy                                     |
| Lone absolute prompt-file path outside the workspace                 | warn and leave unchanged; it is deliberately machine-specific                                  |
| Inline absolute path outside the workspace                           | block save; `ContextExpander` already blocks it at execution                                   |
| Script command/path into `.ctrlyoke/scripts/**`                      | leave alone — `scripts/` is tracked                                                            |

**Why inline a lone prompt-file body but copy an `@ref` to the same file:** these are two different
mechanisms. A lone path as a step's `prompt` is resolved through the shared `PromptFileResolver` —
the file's text _becomes_ the effective prompt. Export calls that same resolver, including its
empty-file behavior, so inlining only moves resolution from run time to export time and removes the
dependency. An inline context ref embedded in larger text is expanded by a different mechanism, so
inlining it would change what the harness receives.

Inlining is lossy in one respect: a prompt deliberately factored into a file for reuse across
workflows loses that factoring in the export. The local file still exists, so nothing is destroyed.
**Decision: inline by default with no v1 checkbox.** If reuse proves common enough, a later "keep
prompt files as references" option can be added without changing the portable default.

Pasted attachments are already content-addressed (`TempFileManager.createPastedImageFile`), but the
bundler must still dedupe by source content because copied prompt files and basename collisions are
not content-addressed. Preserve a basename when unambiguous; when different files share it, append
a stable short content hash before the extension. Identical bytes in the current plan map to one
destination. Naming is ownership-aware: never adopt an unmanifested pre-existing file as managed,
even when its bytes match; choose a non-colliding managed name instead.

### 3.3 Surfacing it

`SaveWorkflowDialog` states what the save will do before it happens — "3 attachments will be copied
to `fix-tests.assets/`", "2 prompt files will be inlined", "2 managed assets will be removed" —
plus warnings and blockers from the table above. Extend the existing addressed/debounced
`CHECK_SAVE_PATH` → `SAVE_PATH_CHECKED` exchange to return the destination-specific bundle preview;
the destination and prune set change when the user edits the name or location. Disable Save while
the preview is pending or contains a blocker. Recompute the analysis in the authoritative save
handler so the preview remains advisory, like the overwrite check. Because pruning is destructive,
the preview response includes a plan fingerprint and `SAVE_WORKFLOW` echoes it; if recomputation
changes the copy/rewrite/blocker/prune plan, reject the save and return the refreshed preview for
explicit reconfirmation. Never delete a larger/different set than the one the user approved.

### 3.4 Implementation notes

- Fix the serializer allowlist before layering bundling onto it. The current `WORKFLOW_FIELDS` and
  `PROMPT_FIELDS` omit `executionMode`, so Save As already changes workflow/step behavior. Build
  both lists from the shared `EXECUTION_PROPERTY_KEYS` / `WORKFLOW_PROPERTY_KEYS` sources plus the
  shape-specific fields, and add a schema-backed round-trip test that fails whenever a persisted
  property is dropped. Portability starts with a complete definition, not only complete files.
- The analysis/rewrite pass belongs after `buildCleanWorkflow()` and before serialization in
  `WorkflowSerializer.handleSaveWorkflow()` (`:499-523`). It returns a rewritten clean object plus
  a typed copy/warning/blocker/prune plan; it does not perform writes while discovering references.
  Pass the semantic source-definition path from the addressed lineage into the analyzer so lone
  prompt refs use the same base as execution; never resolve them relative to the `.runs/` working
  copy.
- Reference discovery covers top-level `prompt`, every prompt step, and `finalStep`. Use the
  runtime parser `parseAllFileReferences()` from `src/utils/FileReferenceParser.ts` plus
  `looksLikeFilePath()` / the shared `PromptFileResolver`. Do **not** import
  `src/ui/webview-react/utils/atomicReferences.ts` into the extension host: that is a deliberately
  separate rendering parser, not the runtime source of truth. Extract/reuse the fenced-code masking
  used by `ContextExpander` so export ignores exactly the references execution ignores.
- Classify a dependency by its resolved canonical path, not by string prefix. For example,
  `@prompts/foo.prompt.md` can resolve through the `.ctrlyoke/` fallback into the generated prompt
  store even though the token does not contain `.ctrlyoke`.
- Rewrite complete tokens from typed parser results and the existing `ContextReferenceBuilder`
  functions, preserving selection ranges, symbol names/kinds, and required quoting. Apply edits in
  descending offset order. Do not use regex replacement over the whole prompt.
- Apply the same containment rules to both sides of every copy. Resolve/`realpath` a generated-store
  source and block symlink escapes outside the trusted workspace roots. Validate the derived assets
  directory independently of the workflow file, rejecting an existing symlink or non-directory;
  `resolveSafeExportPath()` checking only the workflow destination is not sufficient.
- **Decision for templates:** `handleSaveWorkflowAsTemplate()` runs the analyzer in template mode.
  It inlines lone prompt-file bodies and rejects every generated-store reference that would require
  a sibling asset directory, naming the offending step and token. Ordinary repo references remain
  unchanged. Sharing `buildCleanWorkflow()` alone does not make templates inherit the pass; both
  handlers must call it explicitly.
- Write `<workflow>.assets/.ctrlyoke-assets.json` with a versioned list of files created by the
  bundler. On re-save, prune only paths present in the previous manifest but absent from the new
  plan. If the directory has no manifest, treat every existing file as user-owned and do not prune.
  Never delete a currently referenced path even if a stale manifest lists it. The manifest is part
  of the portable bundle and is committed with the assets directory. If the new plan has no assets,
  remove the old manifest after pruning and remove the directory only when it is empty; user-owned
  leftovers keep the directory in place.
- Stage and verify every copy before publishing anything. Publish asset files with temp-file +
  rename, then atomically replace the serialized workflow, then atomically replace the manifest;
  prune obsolete managed files only after the workflow commit. A prune/manifest failure reports a
  warning and may leave harmless extra files, but a saved workflow never points at a missing newly
  bundled asset. Clean staging paths on failure. Multi-path filesystem updates cannot honestly be
  called fully atomic, so this — not "no directory is ever left behind" — is the invariant to test.

---

## 4. The self-ignoring `.gitignore` trap

`.ctrlyoke/.gitignore` lists itself, which is what keeps a fresh init from dirtying the worktree.
The trap: a user who edits it — to start tracking runs, say — makes a change that (a) never travels,
because the file ignores itself, and (b) cannot be reconciled on the other machine, which
regenerates the defaults and silently re-ignores everything. Two clones of one repo, different
tracking behavior, no signal anywhere.

**Decision:** say so at the top of every newly generated file, with the self-ignore line last:

```
# ctrlyoke generated runtime entries are machine-local. Authored files in
# templates/, scripts/, agents/, skills/, mcp/, and settings.json remain trackable.
#
# This file ignores ITSELF (last line) so initializing ctrlyoke leaves your
# worktree clean. If you edit this file — e.g. to start tracking runs or
# attachments — DELETE the `.gitignore` line at the bottom first. Otherwise your
# changes stay on this machine and every other clone regenerates the defaults.
```

Split the rendered header from the ignore-entry list so comments are not treated as appendable
entries. For an existing `.gitignore`, preserve its bytes/order and append only missing patterns;
do not prepend the new header or move its existing self-ignore line, because the file is user-owned.
Existing users get the same warning through docs/release notes. Do **not** auto-drop the self-ignore
when content diverges: `ensureGitignore` has no reliable way to distinguish a user edit from a
generator change.

---

## 5. Sequencing — bundling first

| Phase | Scope                                                                             |
| ----- | --------------------------------------------------------------------------------- |
| 1     | Fresh-file `.gitignore` header (§4)                                               |
| 2     | Prompt-extraction phase 1: shared resolver + just-in-time execution contract      |
| 3     | Reference analysis + Save-As bundling/manifest + dialog disclosure (§3)           |
| 4     | Prompt-extraction phases 2-5: editor writer/UX and legacy cleanup                 |
| 5     | Missing-`*.assets/` aggregate warning on load (§3.1 mitigation 2)                 |
| 6     | Add `attachments/` and `prompts/` to the generated ignore-entry list              |
| 7     | Docs/release note: tracking rule, Save-As behavior, self-ignore, migration caveat |

**Phase 6 must not ship before phases 3 and 4.** Between them is the window where a user exports a
workflow, commits it, and hands a teammate a definition whose assets were never tracked. The
incompleteness exists today, but ignoring the directories turns "usually works because the files
happen to be there" into "never works for anyone else".

### 5.1 Staged execution ledger

The phases above are the design sequence; the table below is how they were split into single-session
work items across both plans. `PFE` = `PROMPT_FILE_EXTRACTION_PLAN.md`, `WP` = this document.
**Each step must tick its own row to `done` when it commits** — this table is the cross-session
record of what has actually landed.

| #   | Step                                              | Covers          | Status |
| --- | ------------------------------------------------- | --------------- | ------ |
| 1   | `.gitignore` header + self-ignore warning         | WP §4 / P1      | done   |
| 2   | Shared `PromptFileResolver` (refactor only)       | PFE §4.4 / P1   | todo   |
| 3   | Just-in-time resolution contract                  | PFE §4.4, §3.1a | todo   |
| 4   | Serializer field completeness (`executionMode`)   | WP §3.4         | todo   |
| 5   | Bundle analyzer (pure analysis/rewrite plan)      | WP §3.2 / P3    | todo   |
| 6   | Bundle writer, manifest, Save-As/template wiring  | WP §3.4 / P3    | todo   |
| 7   | Save-dialog bundle disclosure + plan fingerprint  | WP §3.3 / P3    | todo   |
| 8   | Gitignore toggle → icon-only; prune label API     | PFE §2.2 / P2   | todo   |
| 9   | Prompt-file writer + message contract             | PFE §4.1-4.2    | todo   |
| 10  | Convert button + empty-file UX                    | PFE §2.1, §3.1a | todo   |
| 11  | Delete `createPromptFile` / `createDraftPrompt`   | PFE §5 / P5     | todo   |
| 12  | Missing-assets warning, ignore entries, docs      | WP P5-P7        | todo   |

Ordering constraints this split honors: step 3 precedes every consumer of file-backed prompts;
steps 5-7 (bundling) precede steps 9-10 (the writer), which precede step 12 (the ignore entries).

## 6. Testing

- Serializer round trip preserves every schema-backed workflow/step field (including
  `executionMode`) while still stripping runtime-only metadata.
- Bundler: each row of the §3.2 table, including repo-relative refs/scripts untouched and every
  blocking case; `@`, `#selection:`, and `#sym` rewrites preserve quoting/ranges/kinds; fenced refs
  stay untouched; equal content dedupes; unequal same-basename files get stable hash suffixes; no
  assets directory is created when nothing needs bundling; source/destination symlink escapes are
  rejected; unmanifested collisions are neither overwritten nor adopted as managed.
- Manifest/pruning: first write does not delete pre-existing files; only prior-manifest-owned
  orphans are removed; hand-added and currently referenced files survive; stale/missing/corrupt
  manifests fail safe without deletion; an emptied managed directory is removed but a non-empty
  user-owned one remains; prune count appears in the destination-specific preview.
- Template export inlines lone prompt files, refuses every generated-store inline reference, and
  names the step/token.
- Round trip: export a run containing a pasted image and a converted prompt file, load the exported
  workflow from a different directory, confirm every reference resolves.
- Failure ordering: copy failure leaves the old workflow untouched; workflow-write failure never
  replaces the old definition with one referencing missing assets; manifest/prune failure can leave
  only harmless extras and reports a warning; staging paths are cleaned.
- Save-dialog races: stale `SAVE_PATH_CHECKED` bundle previews cannot repaint a newer destination,
  blockers disable Save, and an authoritative-plan fingerprint mismatch forces reconfirmation
  without writing or pruning.
- `WorkspaceInitializer`: fresh output has the header and self-ignore last; existing files preserve
  content/order and receive only missing patterns; new ignore entries are asserted.

## 7. Docs

- `QUICK_START.md`, `docs/guide/` — state what's ignored, how to make a workflow durable, and that
  the `.gitignore` is editable. No mode vocabulary (§1). Draft copy:

  > **Workflows you build in the dashboard stay on your machine.** Everything you queue, run, and
  > edit lives under `.ctrlyoke/.runs/`, which ctrlyoke gitignores — including screenshots you paste
  > and prompt files you create along the way. Most of that work is a conversation, not an artifact,
  > so nothing lands in your commits by default.
  >
  > **When a workflow turns out to be worth keeping, use Save As.** It writes a portable copy — the
  > workflow file plus any assets it depends on — anywhere you choose in the repo. That copy is
  > yours to commit and share. You can also just write a `.ctrlyoke.yaml` by hand; files you author
  > are tracked like any other source file.
  >
  > **Want your runs committed instead?** Edit `.ctrlyoke/.gitignore` and remove the lines you want
  > tracked — but delete the `.gitignore` line at the bottom first, or your change stays on this
  > machine.

- `docs/reference/commands.md` — Save As now bundles; say what it copies and what it inlines.
- `.github/instructions/` — the tracking rule and the "ignoring `prompts/`/`attachments/` is only
  safe because Save As bundles" coupling belong wherever the serializer's ownership is documented;
  it is exactly the kind of cross-layer constraint the code cannot show on its own.

## 8. Decisions

### 8.1 What base do rewritten references use? — the only structural one

`ContextExpander` resolves `@refs` against the **workspace root and named roots only**
(`src/utils/ContextExpander.ts:66-98`). It has no concept of "relative to the workflow file". So a
bundled reference has to be rewritten workspace-relative:
`@workflows/fix-tests.assets/shot.png`.

That is correct anywhere inside the primary workspace root, and workspace-backed exports are
already constrained there (`resolveSafeExportPath`, `WorkflowSerializer.ts:144-146`). It breaks
only if someone later moves the `.yaml` + `.assets/` pair to a different directory or repo — which
§3.1's missing-assets warning catches loudly rather than silently. A no-workspace shim cannot bundle
assets (§8.5).

The alternative — teach reference resolution a workflow-file-relative base so `@./fix-tests.assets/
shot.png` works and the pair is freely movable — is a genuine cross-layer change with a wrinkle
that is easy to miss: **at execution time the workflow being run is the working file inside
`.runs/<key>/run-<ts>/`, not the file the user saved.** "Relative to the workflow file" would have
to mean `descriptor.originalFile`, which is optional and can go stale. Not worth it for v1.

**Decision: workspace-relative rewrite.** Revisit only if moving exported pairs turns out to be
common.

### 8.2 Prune semantics on re-save

"Refresh and prune orphans" is unsafe if read as "delete anything in `*.assets/` that the bundler
did not just write" — a user may have hand-added a file there.

**Decision:** use the versioned bundle manifest from §3.4. Remove only previously managed files
absent from the new plan, never unmanifested/user-owned or currently referenced files, and always
disclose the count in the save dialog ("2 managed assets will be removed"). Without a valid prior
manifest, do not prune.

### 8.3 Templates and attachment references

`handleSaveWorkflowAsTemplate` shares `buildCleanWorkflow` but does not automatically inherit a
pass added to the normal save handler. A template is instantiated in arbitrary repos and cannot
carry a sibling directory.

**Decision:** call the analyzer explicitly in template mode. Templates **inline** lone prompt-file
bodies and **refuse** any generated-store inline reference, naming the offending step/token.
Silently dropping it would produce a template that looks fine and expands to a dangling path.

### 8.4 Existing users after the ignore change

`.gitignore` does not untrack tracked files, so a workflow already committed with its attachments
keeps working. The gap is narrow: a user adds a _new_ screenshot to an already-committed workflow
and the new file lands ignored. Saving the workflow moves it into `*.assets/` and closes the gap,
so this only bites someone who edits a committed workflow and never re-saves it.

**Decision:** cover this with a release-note line, not code.

### 8.5 Verified, not open

- **One save path.** `src/server/**` contains no `SAVE_WORKFLOW` handling — the hosted browser
  dashboard routes through the extension host's `WorkflowSerializer`, so the bundler has exactly
  one implementation site.
- **Workspace-backed exports cannot leave the primary workspace root.** `resolveSafeExportPath()`
  deliberately falls back to unrestricted absolute resolution only when VS Code exposes no
  workspace folders (unit-test/CLI shims). Bundle analysis must require a workspace root whenever
  it needs to copy/rewrite an asset; a dependency-free no-workspace export can keep the existing
  fallback.

## 9. Related

- `dev/backlog/PROMPT_FILE_EXTRACTION_PLAN.md` — the convert-to-prompt-file button writes into
  `.ctrlyoke/prompts/`; its §6 defers the tracking decision to this document.
