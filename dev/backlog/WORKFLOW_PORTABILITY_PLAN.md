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
- **`ensureGitignore` only ever appends, never prunes.** Anything added to `GITIGNORE_CONTENT` is
  permanent for every existing workspace. Add deliberately.
- Adding entries is safe for existing users — `.gitignore` does not affect already-tracked files —
  which is also why the dangling-reference risk in §5 is easy to miss in testing: it only bites
  files created after the change.

### 2.2 `settings.json`

The generator does not ignore it (users track it by default), but this repo's own
`.ctrlyoke/.gitignore` does. Resolve toward **track**: it holds harness defaults, permissions, and
queue/run behavior — team-shareable project config — and it is schema-validated
(`schemas/settings-schema.json`, wired through `package.json` `jsonValidation`). The only
machine-local fields are `server.certPath` / `server.keyPath`; exclude those keys later if it
becomes a problem, not the whole file.

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
2. On load, a reference into a `*.assets/` directory that does not exist warns through the existing
   file-ref validation path rather than failing silently at run time.
3. Re-saving over an existing workflow refreshes the assets directory and prunes orphans, so it
   never accumulates files from earlier revisions.

### 3.2 What gets bundled, inlined, and left alone

The rule is about _where a reference points_, not what kind of reference it is:

| Reference                                                             | Action                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Step `prompt` whose whole value is a path into `.ctrlyoke/prompts/**` | **inline** the file's text into the step                                                  |
| `@ref` / `#file:` into `.ctrlyoke/attachments/**`                     | **copy** into `<basename>.assets/`, rewrite the path                                      |
| `@ref` into `.ctrlyoke/prompts/**` inside larger prompt text          | copy + rewrite — **do not inline** (see below)                                            |
| `@ref` into ordinary repo files (`src/…`)                             | leave alone — travels with the repo                                                       |
| Anything under `.ctrlyoke/temp/**`                                    | warn — `TempFileManager` deletes these after the turn, so the reference is already broken |
| Absolute path outside the workspace                                   | warn, do not copy — an external reference is deliberate                                   |
| `script:` into `.ctrlyoke/scripts/**`                                 | leave alone — `scripts/` is tracked                                                       |

**Why inline a lone prompt-file body but copy an `@ref` to the same file:** these are two different
mechanisms. A lone path as a step's `prompt` is resolved by
`PromptFileParser.resolvePromptContent()` (`:203`) — the file's text _becomes_ the prompt. Inlining
at export therefore changes nothing semantically; it only moves resolution from run time to export
time, and it removes the dependency entirely so the common case saves as a single self-contained
file. An `@ref` embedded in larger text is a context attachment expanded by a different path with
different semantics, so inlining it would change what the harness receives.

Inlining is lossy in one respect: a prompt deliberately factored into a file for reuse across
workflows loses that factoring in the export. The local file still exists, so nothing is destroyed.
Default to inline; if this proves annoying, a "keep prompt files as references" checkbox in the
save dialog is the escape hatch, not a change to the default.

Attachments are already content-addressed (`TempFileManager.createPastedImageFile`), so two steps
referencing the same image dedupe to one copy for free.

### 3.3 Surfacing it

`SaveWorkflowDialog` should state what the save will do before it happens — "3 attachments will be
copied to `fix-tests.assets/`", "2 prompt files will be inlined", plus any warnings from the table
above. A bundle operation the user cannot see is one they will not trust or understand, and the
warning rows (temp refs, external absolute paths) are exactly the cases where they need to
intervene.

### 3.4 Implementation notes

- The bundling pass belongs between `buildCleanWorkflow()` and serialization in
  `WorkflowSerializer.handleSaveWorkflow()` (`:499-523`) — it rewrites the clean object, so it must
  run before `yaml.dump` / `JSON.stringify`.
- Reference discovery must cover both the prompt-value form and every inline reference form. Reuse
  the existing parsers (`findAtomicReferences` / `findContextReferenceMatches` in
  `utils/atomicReferences`, `looksLikeFilePath` in `utils/promptPathUtils`) rather than writing a
  new scanner — a bundler that misses a reference form produces exactly the silent breakage this
  plan exists to remove.
- `handleSaveWorkflowAsTemplate` (`:547`) shares `buildCleanWorkflow`. Decide explicitly whether
  templates bundle too. Recommendation: **templates inline prompt files but reject attachment
  references**, since a template is meant to be instantiated in any repo and cannot carry a sibling
  directory.
- Copy asset files atomically and only after the workflow write succeeds, so a failed save cannot
  leave a half-populated assets directory next to no workflow.

---

## 4. The self-ignoring `.gitignore` trap

`.ctrlyoke/.gitignore` lists itself, which is what keeps a fresh init from dirtying the worktree.
The trap: a user who edits it — to start tracking runs, say — makes a change that (a) never travels,
because the file ignores itself, and (b) cannot be reconciled on the other machine, which
regenerates the defaults and silently re-ignores everything. Two clones of one repo, different
tracking behavior, no signal anywhere.

Fix by saying so, at the top of the generated file, with the self-ignore line last so the note sits
next to what it describes:

```
# ctrlyoke runtime — generated, machine-local. Safe to commit nothing here.
#
# This file ignores ITSELF (last line) so initializing ctrlyoke leaves your
# worktree clean. If you edit this file — e.g. to start tracking runs or
# attachments — DELETE the `.gitignore` line at the bottom first. Otherwise your
# changes stay on this machine and every other clone regenerates the defaults.
```

Do **not** get clever here — e.g. auto-dropping the self-ignore once the file diverges from the
generated content. Silent behavior change inside the mechanism whose whole problem is silent
behavior is a bad trade, and `ensureGitignore`'s append-only design gives no reliable way to tell a
user edit from a generator change.

---

## 5. Sequencing — bundling first

| Phase | Scope                                                                |
| ----- | -------------------------------------------------------------------- |
| 1     | `.gitignore` header comment (§4) — standalone, no behavior change    |
| 2     | Reference-discovery pass + Save-As bundling + dialog disclosure (§3) |
| 3     | Missing-`*.assets/` warning on load (§3.1 mitigation 2)              |
| 4     | Add `attachments/` and `prompts/` to `GITIGNORE_CONTENT`             |
| 5     | Docs: what's ignored and why, the one-line tracking rule (§1, §2)    |

**Phase 4 must not ship before phase 2.** Between them is the window where a user exports a
workflow, commits it, and hands a teammate a definition whose assets were never tracked. The
incompleteness exists today, but ignoring the directories turns "usually works because the files
happen to be there" into "never works for anyone else".

## 6. Testing

- Bundler: each row of the §3.2 table, including the negative cases (repo-relative `@ref` untouched,
  `script:` into `scripts/` untouched); dedupe of two steps referencing one content-addressed image;
  pruning removes only unreferenced files and never on first write (§8.2); no assets directory
  created when nothing needs bundling.
- Template export refuses an attachment reference and names the step (§8.3).
- Round trip: export a run containing a pasted image and a converted prompt file, load the exported
  workflow from a different directory, confirm every reference resolves.
- Failure atomicity: a write failure mid-bundle leaves no partial assets directory.
- `WorkspaceInitializer` tests assert the new `GITIGNORE_CONTENT` entries and the header comment.

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

## 8. Open questions

Each carries a recommendation; none blocks starting phase 1 or the discovery pass in phase 2.

### 8.1 What base do rewritten references use? — the only structural one

`ContextExpander` resolves `@refs` against the **workspace root and named roots only**
(`src/utils/ContextExpander.ts:66-98`). It has no concept of "relative to the workflow file". So a
bundled reference has to be rewritten workspace-relative:
`@workflows/fix-tests.assets/shot.png`.

That is correct anywhere inside the repo, and exports are already constrained to the workspace
(`resolveSafeExportPath`, `WorkflowSerializer.ts:144-146`), so there is no cross-workspace case to
handle. It breaks only if someone later moves the `.yaml` + `.assets/` pair to a different
directory or repo — which §3.1's missing-assets warning catches loudly rather than silently.

The alternative — teach reference resolution a workflow-file-relative base so `@./fix-tests.assets/
shot.png` works and the pair is freely movable — is a genuine cross-layer change with a wrinkle
that is easy to miss: **at execution time the workflow being run is the working file inside
`.runs/<key>/run-<ts>/`, not the file the user saved.** "Relative to the workflow file" would have
to mean `descriptor.originalFile`, which is optional and can go stale. Not worth it for v1.

**Recommendation: workspace-relative rewrite.** Revisit only if moving exported pairs turns out to
be common.

### 8.2 Prune semantics on re-save

"Refresh and prune orphans" is unsafe if read as "delete anything in `*.assets/` that the bundler
did not just write" — a user may have hand-added a file there.

**Recommendation:** remove only files that are no longer referenced by the workflow, never on the
first write, and always disclose it in the save dialog ("2 unused assets will be removed") so the
deletion is something the user approved rather than discovered. Disclosure is what makes pruning
safe; without it, don't prune.

### 8.3 Templates and attachment references

`handleSaveWorkflowAsTemplate` shares `buildCleanWorkflow`, so it inherits whatever the bundler
does. A template is instantiated in arbitrary repos and cannot carry a sibling directory.

**Recommendation:** templates **inline** prompt-file bodies (same as export) and **refuse** to save
when an attachment reference is present, naming the offending step. Silently dropping the reference
would produce a template that looks fine and expands to a dangling path.

### 8.4 Existing asset-mode users after the ignore change

`.gitignore` does not untrack tracked files, so a workflow already committed with its attachments
keeps working. The gap is narrow: a user adds a _new_ screenshot to an already-committed workflow
and the new file lands ignored. Saving the workflow moves it into `*.assets/` and closes the gap,
so this only bites someone who edits a committed workflow and never re-saves it.

**Recommendation:** a release-note line, not code.

### 8.5 Verified, not open

- **One save path.** `src/server/**` contains no `SAVE_WORKFLOW` handling — the hosted browser
  dashboard routes through the extension host's `WorkflowSerializer`, so the bundler has exactly
  one implementation site.
- **Exports cannot leave the workspace**, so bundled assets are always inside it and always
  addressable workspace-relative.

## 9. Related

- `dev/backlog/PROMPT_FILE_EXTRACTION_PLAN.md` — the convert-to-prompt-file button writes into
  `.ctrlyoke/prompts/`; its §6 defers the tracking decision to this document.
