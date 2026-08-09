# Workflow-Relative Asset References — Making Exported Bundles Relocatable

## Overview

`dev/implemented/WORKFLOW_PORTABILITY_PLAN.md` §8.1 chose to rewrite bundled references
**workspace-relative**, and that is what shipped: `WorkflowBundleAnalyzer.toWorkspaceRelativePath()`
(`src/utils/WorkflowBundleAnalyzer.ts:956-973`) emits `path.relative(workspaceRoot, destination)`,
asserted as `@"workflows/fix-tests.assets/shot one.txt"` in
`src/test/unit/WorkflowBundleAnalyzer.test.ts:91-104`.

The consequence is that an exported pair is **position-locked, not repo-locked**. Cloning the repo
works. Copying `fix-tests.ctrlyoke.yaml` + `fix-tests.assets/` into another repo works *only* if
they land at the identical path relative to that repo's root. Moving the pair one directory over —
in the same repo — silently invalidates every bundled reference, which is what §3.1's
missing-assets warning exists to catch.

**Goal:** an exported workflow file plus its sibling `*.assets/` directory can be moved or copied
anywhere — another directory, another repo — and still resolve. That is the difference between
*committable* and *shareable*.

**Non-goals:** changing the sibling-directory bundle layout (§3.1 of the portability plan stands);
making `.runs/` state portable; changing how the UI inserts ordinary repo references.

**Scope note.** Only attachments are at stake. Lone prompt-file references are *inlined* at export
(`WorkflowBundleAnalyzer.ts:401-407`), so they carry no dependency. `*.assets/` only ever holds
copied attachment files.

---

## 1. What exists already, and what is actually missing

Half of the machinery is built. The portability plan's own steps 2-3 landed
`sourceDefinitionPath`, and it is threaded end to end — but only for *lone prompt-file paths*:

- `PromptFileResolver.getCandidates()` (`src/core/PromptFileResolver.ts:220-254`) probes
  `dirname(sourceDefinitionPath)` **first**, then the workspace root, then the `.ctrlyoke/`
  fallback.
- `WorkflowExecutor.resolveEffectivePrompt()` (`:2489-2508`) passes
  `context.sourceDefinitionPath`.
- `WorkflowInstance` sets it from `workingFile.originalFile` (`:1010`, `:1057`, `:3862`).
- `WorkflowOrchestrator.getViewSourceDefinitionPath()` (`:2185-2197`) reads it from the lineage
  descriptor, **deliberately not** from the `.runs/` working-copy path — which is the exact
  objection §8.1 raised against workflow-relative resolution. That objection is now answered.
- `PromptEditorSupportService.handleFileRefValidation()` (`:183-214`) already uses it.

**`originalFile` is working-file-only and is never exported.** The schema says so
(`schemas/workflow-schema.json:93-96`) and `WorkflowSerializer.buildCleanWorkflow()` strips it —
it is absent from `WORKFLOW_FIELDS` (`src/ui/WorkflowSerializer.ts:480-486`). It is a machine-local
absolute path recorded at load time (`PromptFileLoader.ts:87` → `WorkingFileManager.ts:377` →
lineage descriptor). Nothing in this plan puts it in a committed file; it is only the *base* the
resolver already knows.

### 1.1 What actually gets bundled — verified against the analyzer

Easy to get wrong from the §3.2 table alone. The rule is **where the reference points × how the
reference is written**, and the second factor is what surprises people:

| Prompt content                                              | Points into                | Result                                    |
| ----------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| lone `prompt: ./x.prompt.md`                                | `.ctrlyoke/prompts/**`     | **inlined** — content replaces the path   |
| lone `prompt: ./x.prompt.md`                                | ordinary repo file         | **untouched**                             |
| lone `prompt: ./x.prompt.md`                                | `attachments/**`, `temp/**`| **blocked**                               |
| `@x` / `#selection:x` / `#sym:x` inside prompt text         | `.ctrlyoke/attachments/**` | **copied to `*.assets/`** + token rewritten |
| `@x` / `#selection:x` / `#sym:x` inside prompt text         | `.ctrlyoke/prompts/**`     | **copied to `*.assets/`** + token rewritten |
| `@x` inside prompt text                                     | ordinary repo file         | **untouched**                             |

So `*.assets/` receives pasted attachments **and prompt files that were _mentioned_ rather than
_used_** — `"help me refine this prompt @.ctrlyoke/prompts/fixLint.prompt.md"` copies
`fixLint.prompt.md` into the assets directory. That is deliberate (`WORKFLOW_PORTABILITY_PLAN.md`
§3.2: an `@ref` embedded in larger text is expanded by a different mechanism, so inlining it would
change what the harness receives), and it is locked by
`src/test/unit/WorkflowBundleAnalyzer.test.ts:111-147` — "never inlines inline prompt refs".

**A lone `prompt:` value is never rewritten to point into `*.assets/`.** `analyzeLonePromptFile`
(`WorkflowBundleAnalyzer.ts:272-408`) has exactly three outcomes — inline, block, or return
untouched. It never produces a copy plan. This matters for §2.2: the `./`-prefixed form the
prompt-file completion generates is never the thing being rewritten.

**The relocatability boundary.** A moved pair carries its *generated* dependencies. It does not
carry the repo it operates on — `@src/foo.ts` and a lone prompt pointing at a committed
`prompts/fixLint.prompt.md` stay as they are, by design, the same way `.ctrlyoke/scripts/**` does.
"Relocatable" means the workflow and its assets travel together, not that a workflow works in a
repo that lacks its subject matter. Say this in the docs (§9 step 6) so the guarantee is not
oversold.

### 1.2 The author who factors a large workflow into prompt files

Worth stating because the §1.1 inline rule looks like it punishes this user and does not.

Someone organizing a large workflow so the top-level file stays readable — one `.prompt.md` per
step, workflow file reduced to structure — is **already fully served, and already relocatable, with
no changes**. Their prompt files are ordinary repo files, so export leaves them untouched (§1.1 row
2), and source-dir-first probing in `PromptFileResolver.getCandidates()` already resolves a sibling
layout:

```
workflows/big.ctrlyoke.yaml     prompt: ./prompts/step-001.prompt.md
workflows/prompts/step-001.prompt.md   → candidate 1: dirname(originalFile)/prompts/… ✓
```

Move `workflows/` anywhere and it still resolves, because candidate 1 is relative to the workflow
file. This is the one place the existing probing behavior is doing real work, and it is a reason to
leave §6.4 alone.

Inlining only ever touches `.ctrlyoke/prompts/**` — gitignored dashboard scratch that was never
going to travel. Inlining is the *correct* answer there.

**The actual defect is upstream, in the UI.** `PromptFileWriter` hard-codes the canonical
`.ctrlyoke/prompts/` store (`src/utils/PromptFileWriter.ts:22-30`) and the convert-to-prompt-file
button offers no destination. So two authors with identical intent get opposite export behavior
purely from *how* they created the file — hand-authored stays factored, dashboard-converted gets
inlined — and nothing in the UI signals the difference.

Note the sharper version of the complaint is not file size but **review granularity**: inlining N
prompt bodies into one YAML collapses N independent git diffs into one. For a workflow large enough
to need factoring, that is the real loss.

**Recommendation: do not change the inline default.** `WORKFLOW_PORTABILITY_PLAN.md` §3.2 already
reserved the escape hatch ("a later 'keep prompt files as references' option can be added without
changing the portable default"). Prefer the smaller fix first where it applies: give the convert
button a destination choice (a repo directory vs. the scratch store).

But the case that actually motivates the escape hatch is the **UI-built** workflow — dozens of
steps composed in the editor, each converted to a prompt file, so every one lands in
`.ctrlyoke/prompts/`. A destination choice does not help retroactively, and Save As inlines all of
them into one file. That user needs "keep prompt files as references".

#### 1.2.1 Escape-hatch resolution contract — no resolver change required

Copying a lone prompt file into `*.assets/` and rewriting its value to
`./big.assets/step-001.prompt.md` needs **no resolver work at all**.
`PromptFileResolver.getCandidates()` (`:220-254`) already probes
`dirname(sourceDefinitionPath)` first, so candidate 1 resolves it. The emitted form is forced, not
chosen: `looksLikeFilePath` requires a `./` prefix in single-root, so there is exactly one legal
shape. None of §3's `resolveReferencePath` work applies — that is for `@` / `#` tokens only.

The candidates 2/3 fallback stops being a feature for a bundler-written value: if the assets
directory goes missing, candidate 1 misses and candidate 2 can quietly hit a same-named path at the
workspace root. The `@./` answer (§3 step 2 — error, not fallback) is unavailable here, because
`./` is mandatory syntax for lone prompts and the completion emits `./` + workspace-relative paths
(§6.4). Teaching the resolver that a `*.assets/` segment means candidate-1-only is the §10-rejected
special-casing. **Accept the fallback** — it needs both a missing assets directory and a root-level
name collision to bite — and close the two gaps that make accepting it tolerable:

1. **The missing-assets warning does not cover lone prompts.**
   `findMissingWorkflowAssetDirectories` (`WorkflowAssetWarnings.ts:26`) runs
   `parseAllFileReferences`, which matches only `@` / `#selection:` / `#sym` tokens — a bare
   `./big.assets/x.prompt.md` is not one. The safety net that justifies the fallback currently has
   a hole exactly where the escape hatch would put traffic. It must also test lone prompt values.
   (Related: `warnAboutMissingWorkflowAssets` (`PromptFileLoader.ts:371-384`) scans `steps` and
   `finalStep` but skips top-level `workflow.prompt`, which `collectPromptFields` does cover. Fix
   the asymmetry while in there.)
2. **§6.5 becomes a prerequisite, not a nice-to-have.** A UI-built workflow with the escape hatch on
   puts N `.prompt.md` files in `*.assets/`, and every one is picked up by
   `findWorkflowFilesInWorkspace` as its own runnable workflow. At the scale that motivates the
   feature that is dozens-to-hundreds of phantom picker entries. Exclude `*.assets/` from the
   discovery walk **before** building the escape hatch.

Manifest and pruning need no changes — bundled prompt files are ordinary managed files in the
assets directory and the §3.4/§8.2 rules already govern them.

**Rejected: a dedicated sigil for workflow-relative-only lone paths** (e.g. `§./big.assets/x.md`).
It would be a third path syntax alongside `./` lone paths and `@`/`#` tokens, on top of the §2.3
dual meaning; it is only ever machine-written, so a user would first meet it as unexplained,
untypeable syntax in their own exported YAML; and it prevents a failure that requires a missing
assets directory *and* a root-level directory named `<stem>.assets/` holding the same-named file.
If a marker is ever genuinely needed, use an ASCII namespaced prefix in the existing
`#selection:` / `#sym:` family (`workflow:./x.prompt.md`), not a non-ASCII sigil — greppability of
this codebase is worth more than the character.

**The gap is exactly one resolver.** `ContextExpander.resolveWorkspacePath()`
(`src/utils/ContextExpander.ts:724-751`) knows only `workspaceRoot` + `namedRoots`. Inline `@`,
`#selection:`, and `#sym` references never received the source-definition base that lone prompt
paths got.

---

## 2. Decision: an explicit `./` marker, not two-base probing

This is the load-bearing decision, and it is what dissolves the collision problem.

### 2.1 The collision the naive approach creates

If `ContextExpander` copied `PromptFileResolver`'s behavior — try source-dir, fall back to
workspace root — then for a workflow at `workflows/fix-tests.ctrlyoke.yaml`, the token
`@src/index.ts` becomes ambiguous:

| Base                     | Resolves to                 |
| ------------------------ | --------------------------- |
| source-definition dir    | `workflows/src/index.ts`    |
| workspace root           | `src/index.ts`              |

Whichever is probed first wins, so **the meaning of an existing token would depend on filesystem
state**. A workflow that reads `src/index.ts` today starts reading a different file the day
someone adds a `workflows/src/` subtree. Nothing in the token warns you. `index.ts`, `README.md`,
`package.json`, `config/settings.json` — the colliding names are exactly the common ones.

Three further problems with probing: it doubles `stat` calls on the hot expansion path; it makes
resolution non-deterministic with respect to disk contents, which is a bad property for a value
that also feeds a security boundary (§4); and it gives no way to *express* "definitely relative to
the workflow" when both files exist.

### 2.2 The decision

**A leading `./` or `../` on a reference path means "relative to the workflow file". Every other
form stays workspace-relative (including folder-name-prefixed multi-root refs). Exactly one base
per token, chosen lexically, never by probing.**

The collision question then dissolves, because we control both producers:

- Every **`@` / `#selection:` / `#sym`** reference the UI inserts is workspace-relative —
  `buildFileReferenceValue` (`src/completions/ContextReferenceBuilder.ts:27`) does not prepend
  `./`. Verified: no generator emits a `./`-prefixed inline reference, so **no existing inline
  reference changes meaning**. (Lone `prompt:` values are a different story — §2.3.)
- The only producer of workflow-relative references is the bundler, and it will emit exactly one
  shape: `./<stem>.assets/<name>`.

So the ambiguous case — a token that could mean either — is never generated, and if a human writes
one they wrote `./` on purpose.

`../` is included deliberately and is a small win on its own: today `@../docs/x.png` resolves to
`path.resolve(workspaceRoot, "../docs/x.png")`, escapes the root, and is blocked. With a
workflow-file base it means the obvious thing and usually stays *inside* the root — still fully
containment-checked (§4).

### 2.3 `./` will mean two different things, and that is forced on us

**This is the one wart, and it needs a conscious decision rather than a footnote.**

In a **lone `prompt:` value**, a leading `./` is already *mandatory syntax*, not a base selector.
`looksLikeFilePath()` (`src/utils/promptPathUtils.ts`) only treats a prompt value as a file
reference if it starts with `./`, `../`, `/`, a drive letter, or — multi-root only — a folder-name
prefix. That gate exists to tell a path apart from a one-line prompt that happens to end in `.md`.
Accordingly the prompt-file completion inserts `./` + the **workspace-relative** path in single-root
(`CompletionHelpers.ts:1200`), and `buildPromptFileReferenceValue()`
(`ContextReferenceBuilder.ts:36-41`) hard-codes the prefix, its doc comment already noting that
"unlike an @-reference, the leading `./` is part of the path syntax".

So after this change:

| Position                        | `./x`                                            |
| ------------------------------- | ------------------------------------------------ |
| lone `prompt:` value            | "this is a path" marker; source-dir-then-workspace probing (unchanged) |
| `@` / `#selection:` / `#sym`    | workflow-relative base (new)                     |

**Decision: accept the dual meaning.** It is defensible because no single string is ever read both
ways — `looksLikeFilePath` explicitly rejects anything starting with `@` or `#`, and
`WorkflowBundleAnalyzer` branches on `looksLikePromptFile` before it looks for inline references
(`:177-200`). They are already two mechanisms with two parsers, two resolvers, and two documented
export behaviors (inline vs. copy). The alternative — a distinct sigil for workflow-relative inline
refs — buys consistency nobody will notice at the cost of syntax nobody will guess.

Also update, in the same change: `resolveNamedRelativePath()`
(`src/platform/WorkspaceRootResolver.ts:154-179`) strips a leading `./` before matching named roots
and documents `./root2/src/index.ts` as naming the same root as `root2/src/index.ts`. For inline
references `./` is now consumed earlier and never reaches it. Remove the stripping branch from the
inline path and correct the doc comment rather than leaving a misleading no-op. Pre-release, no
compatibility shim.

---

## 3. The resolution contract

Add one shared, pure function — the single source of truth every call site uses. Nothing else may
grow its own base-selection logic.

```
resolveReferencePath(referencePath, {
  primaryRoot,          // workspace root
  namedRoots,           // multi-root folders
  sourceDefinitionDir,  // dirname(originalFile), or undefined
}): { absolutePath, base: "absolute" | "workflow" | "namedRoot" | "workspace" }
```

Order, evaluated lexically with no filesystem access:

1. `path.isAbsolute(p)` → `path.resolve(p)`, base `absolute`.
2. `p` starts with `./` or `../` (after `\` → `/` normalization) → resolve against
   `sourceDefinitionDir`, base `workflow`. **If `sourceDefinitionDir` is undefined, this is an
   error, not a fallback** — falling back to the workspace root is precisely the silent-wrong-file
   outcome §2.1 exists to prevent. Surface it as an unresolvable reference with a message naming
   the cause ("this reference is relative to the workflow file, which has no known location").
3. First segment matches a named root → resolve against that root, base `namedRoot`.
4. Otherwise resolve against `primaryRoot`, base `workspace`.

Return the base alongside the path: §5.2 needs it, and it keeps diagnostics honest.

The function is deliberately side-effect free and synchronous, matching `resolveNamedRelativePath`.
Put it next to that function in `src/platform/WorkspaceRootResolver.ts` and have
`resolveNamedRelativePath` become its steps 1/3/4.

---

## 4. Security

Adding a resolution base adds an attack surface, because reference text is **untrusted input**:
`ContextExpander.resolveWorkspacePath()` already says so in its comment — a workflow may have been
authored by someone other than the person running it. Three rules:

**4.1 The containment check does not move.** `resolveReferencePath` resolves; it does not
authorize. Every existing `isPathWithinAnyDirectory(resolved, trustedRoots)` call stays exactly
where it is and runs on the result regardless of which base produced it. A `workflow`-based path
gets the identical treatment as a `workspace`-based one. Concretely, `@./../../../../etc/passwd`
resolves fine and is then blocked, same as today's `@../../../../etc/passwd`.

This is why the base must be chosen lexically rather than by probing: with probing, the boundary
check runs on whichever candidate happened to exist, which makes "what did we authorize" depend on
disk contents.

**4.2 The source-definition base itself must be inside a trusted root.** `sourceDefinitionDir`
derives from `descriptor.originalFile`, which is data read off disk from `.ctrlyoke/.runs/`.
Validate it once at the point it is turned into a base — if it is not within `trustedRoots`, treat
it as absent (§3 step 2 then errors) rather than resolving against it. Do not assume the descriptor
is well-formed just because ctrlyoke wrote it.

**4.3 Fix the pre-existing hole in `PromptFileResolver` while we are here.** Verified: there is
**no containment check anywhere** in the lone-prompt-file resolution chain. `getCandidates()`
returns `path.resolve(trimmedPath)` for absolute paths and
`path.resolve(dirname(sourceDefinitionPath), trimmedPath)` for relative ones with no boundary test,
and none of its consumers (`WorkflowExecutor.ts:2504`, `ExecutionPreviewService.ts:454`,
`PromptFileParser`, `PromptEditorSupportService`, `PromptLinkProvider`,
`WorkflowBundleAnalyzer`) add one. So a shared workflow containing `prompt: ../../../secrets.md`
reads outside the workspace today, while the equivalent `@` reference is blocked. That asymmetry is
a bug independent of this plan, and this plan touches exactly that code.

Fix: give `PromptFileResolver` the same `trustedRoots` + approved-external-roots inputs and run
`evaluateFileAccess()` (`src/utils/FileAccessPolicy.ts:44`) on every candidate before reading it.
Route both resolvers through `evaluateFileAccess` so there is one authorization decision in the
codebase rather than two shapes of it.

**4.4 Symlink escape.** Existing bundle-side handling already realpaths sources and validates the
assets directory and its ancestors (`WorkflowBundleAnalyzer.validateExportDirectory`). Reference
*reads* are lexical-only today. Do not expand that scope here — note it as a separate gap so it is
not silently assumed fixed.

---

## 5. Sites to change

### 5.1 Execution path (the actual feature)

`new ContextExpander(...)` has exactly **one** production call site:
`src/core/HarnessIntegration.ts:455`, inside `buildPromptSections()`. Everything else is tests.

1. Add `sourceDefinitionDir` to the `ContextExpander` constructor; `resolveWorkspacePath()` calls
   `resolveReferencePath` and keeps its containment check verbatim.
2. Plumb the value to `HarnessIntegration`. It exists on `WorkflowExecutionContext`
   (`src/core/WorkflowExecutor.ts:88`) and `WorkflowInstance.sourceDefinitionPath`
   (`:146`) but stops before the harness layer. One value, one more layer down — follow the
   existing `getWorkspaceRoot()` / `getNamedWorkspaceRoots()` accessor pattern on
   `HarnessIntegration` rather than threading it through `buildPromptSections`' signature.
3. `WorkflowBundleAnalyzer.toWorkspaceRelativePath()` becomes
   `toWorkflowRelativePath()`: `./` + `path.relative(dirname(destinationPath), assetPath)`, POSIX
   separators. Since the assets directory is always a sibling of the destination, this is always
   `./<stem>.assets/<name>` — no `../`, and the multi-root named-root branch disappears from this
   function entirely. Token reconstruction through `ContextReferenceBuilder` is unchanged.

### 5.2 The leak that will break this if missed

`ContextExpander.sanitizeReferences()` → `buildSanitizedReferenceText()` (`:416-459`) computes
`displayPath = this.effectiveAbsolute ? absolutePath : ref.path` and, in the common single-root
case, hands **`ref.path` verbatim** to the harness. The harness CLI's cwd is the workspace root,
not the workflow directory — so a `./fix-tests.assets/shot.png` token reaches the harness and
resolves against the wrong base.

Requirement: **a `workflow`-based reference must never leave ctrlyoke in its `./` form.**
`buildSanitizedReferenceText` must rewrite it unconditionally — not only when `effectiveAbsolute`
is set — to the absolute path (or the workspace-relative equivalent). This is what the `base` field
returned by `resolveReferencePath` is for. Note the early `if (!this.effectiveAbsolute) return
null;` on the excerpt branch (`:437-439`) has to grow the same exception.

`expandContextSplit()` is already safe: `directFileRefs` are pushed as `absolutePath` (`:303-308`)
and excerpt bodies embed content, not paths.

### 5.3 Parity sites

Each of these resolves reference paths against the workspace root only, and each would report a
correctly-bundled workflow as broken if left alone:

| Site                                                        | Symptom if skipped                                |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `PromptEditorSupportService.handleContextRefsValidation` (`:487`) → `validateContextReference` | every bundled ref marked invalid in the editor |
| `PromptEditorSupportService` image preview (`:440`)         | pasted-image thumbnails vanish after export       |
| `PromptEditorSupportService` (`:682`, `:773`)               | open-file / attach flows miss bundled assets      |
| `PromptLinkProvider.ts:224`                                 | ctrl+click in the `.yaml` dead-links              |
| `AttachmentBuilders.ts:107`                                 | directory attachments resolve wrong               |
| `WorkflowAssetWarnings.ts:63-70`                            | false "missing assets" warnings on load           |
| `PromptEditorSupportService.handleAttachmentTokenCountRequest`  | token counts wrong/zero for bundled refs      |

**CLI and MCP need no separate work.** The CLI's `run` path loads through
`WorkflowInstance.loadPromptFile()`, which sets `sourceDefinitionPath` (`:922-927`), so it inherits
the §5.1 plumbing; its preview path already passes it explicitly (`cli.ts:722-723`).
`src/mcp-server.ts` imports no `ContextExpander`, `HarnessIntegration`, or `WorkflowInstance` — it
never expands references — so there is nothing to thread there.

No wire-format change is needed for token counts. `useAttachmentTokenCount` sends reference
*strings* and caches counts by string (`REQUEST_ATTACHMENT_TOKEN_COUNTS` →
`WebviewMessageRouter.ts:668-676`); all resolution is host-side, where `ctx.clientId` makes
`getViewSourceDefinitionPath()` available exactly as it is in `handleFileRefValidation`. Every row
above is therefore an extension-host change.

---

## 6. Corner cases

### 6.1 Re-bundling an already-bundled asset — the one that silently corrupts

Save As from a workflow that was itself loaded from a previous export:

1. Working copy holds `@./fix-tests.assets/shot.png`, `originalFile` = `workflows/fix-tests.ctrlyoke.yaml`.
2. User does Save As to `tools/fix-tests.ctrlyoke.yaml`.
3. The analyzer resolves the ref to `workflows/fix-tests.assets/shot.png`. That is **not** inside a
   generated store (`.ctrlyoke/attachments|prompts|temp`), so today's classifier calls it "an
   ordinary repo file — leave alone" (`WORKFLOW_PORTABILITY_PLAN.md` §3.2, last-but-two row).
4. The new export keeps `@./fix-tests.assets/shot.png`, which now means
   `tools/fix-tests.assets/shot.png` — which does not exist.

**Fix: a reference resolving into any `*.assets/` directory listed in that directory's
`.ctrlyoke-assets.json` manifest is a bundle-managed source and must be re-copied to the new
destination's assets directory.** Add it as a row in the §3.2 classification table alongside the
generated stores.

Note this bug exists today with workspace-relative refs, in a nastier form: the ref stays
`@workflows/fix-tests.assets/shot.png` and keeps *resolving*, so the two exports silently share one
assets directory and deleting the first pair breaks the second. Workflow-relative at least fails
loudly. Either way the manifest-aware classification is the fix, and it should land in the same
change.

Saving to the **same** path is unaffected — the ref already points where the asset already is, and
the existing manifest prune logic (§3.4 / §8.2 of the portability plan) governs.

### 6.1.1 The same hole in template export

`handleSaveWorkflowAsTemplate` runs the analyzer with `templateMode: true`, which blocks every
*generated-store* reference (`WorkflowBundleAnalyzer.ts:509-518`). A `./big.assets/x.png` inherited
from a previously-exported workflow resolves to an **ordinary repo file**, so `generatedStore` is
undefined and the reference falls through the `if (!generatedStore) continue;` guard untouched. The
template is then instantiated in an arbitrary repo carrying a dangling `./` reference — exactly the
silent-dangling-path outcome `WORKFLOW_PORTABILITY_PLAN.md` §8.3 exists to prevent.

Fix alongside §6.1: once a reference into a manifested `*.assets/` directory is classified as
bundle-managed, template mode blocks it by the same rule that blocks generated-store references,
naming the step and token. Both handlers already call the analyzer explicitly, so this is one
classification change, not two.

### 6.2 A workflow with no source definition

`PromptFileLoader.loadFromMemory()` leaves `originalFile` undefined by design (`:100-105`), so
dashboard-composed and template-instantiated workflows have no workflow-relative base until they
are loaded from a file on disk. Per §3 step 2 this is an error, not a fallback — but it should
never be *reachable* in normal use, because such a workflow's references point into
`.ctrlyoke/attachments/`, not into an assets directory. It becomes reachable only if a human hand-
writes `./` in the dashboard editor. Make the editor's inline validation say so plainly.

Verified non-issue: Save As does **not** rewrite the working copy or the descriptor (it writes only
the export destination — `WorkflowSerializer.handleSaveWorkflow`, `:585-670`). So the running
lineage keeps its original `.ctrlyoke/attachments/…` references and nothing breaks mid-run.

Separately worth doing, but a UX nicety rather than a correctness fix: Save As could set
`descriptor.originalFile` to the export destination, so a second Save As defaults to the exported
location (`WorkflowSerializer.ts:375-376`) instead of falling back to `LAST_EXPORT_DIR_KEY`.

### 6.3 Multi-root workspaces

`./` is consumed before named-root matching, so a workflow living inside `root2` resolves
`./assets/x.png` against its own directory and is then containment-checked against `trustedRoots`,
which includes `root2`. Correct without special-casing.

`resolveEffectiveAbsoluteReferences()` forces absolute rendering in multi-root, which means §5.2's
rewrite already happens there — single-root is the case that needs the new unconditional branch.

### 6.4 The lone-prompt-path asymmetry stays, on purpose

After this change: `@x` is workspace-relative, `./x` is workflow-relative, and a lone
`prompt: x.prompt.md` remains source-dir-first-then-workspace probing. Do not unify them.

The lone-prompt case is established, tested, and off the portability path entirely because export
inlines it; the `@` case is machine-generated and needs determinism. The reason is not obvious from
the code, so record it in a comment on `PromptFileResolver.getCandidates` rather than only here.

**Do not "unify" by making `./` source-dir-only in `PromptFileResolver`.** An earlier draft of this
plan floated that as a cheap consistency win. It is wrong and would be a live bug: the prompt-file
completion inserts `./` + the **workspace-relative** path (`CompletionHelpers.ts:1200`), so
`./prompts/b.prompt.md` in a workflow under `workflows/` reaches its target through the
*workspace-root* candidate, not the source-dir one. Removing the fallback breaks every
completion-inserted prompt reference whose target is not a sibling of the workflow — which is the
common case. The probing order in `getCandidates` stays exactly as it is.

### 6.5 A bundled `.prompt.md` is discovered as a runnable workflow — today-bug

Because inline refs into `.ctrlyoke/prompts/**` are copied (§1.1), `*.assets/` routinely contains
`.prompt.md` files. `findWorkflowFilesInWorkspace()` (`src/utils/WorkflowFileDiscovery.ts:18-23,
44-70`) matches any file ending in `.prompt.md` and recurses into every directory except `.git`,
`node_modules`, `out`, `dist`, `coverage`. Verified: nothing excludes `*.assets/`.

So exporting a workflow that mentions a prompt file makes `fix-tests.assets/fixLint.prompt.md`
appear in the workflow picker as its own runnable workflow. This is a bug **today**, independent of
this plan — it arrived with bundling in the portability plan's step 6.

Fix: skip bundle-managed asset directories in the discovery walk. A bundled asset is a dependency
of a workflow, never a workflow. Cheap and independently shippable; do it before this plan rather
than as part of it — and see §6.5.1 before reaching for a name match.

#### 6.5.1 Detect asset directories by manifest, not by name

A user's own `mygame.assets/` is not a ctrlyoke bundle. Name-based `.assets` matching is used in
three places today or in this plan, and they do not share a risk profile:

| Site                                   | Keyed on | Cost of a false positive on `mygame.assets/` |
| -------------------------------------- | -------- | --------------------------------------------- |
| §6.1 re-bundling classification        | manifest | none — no manifest, not bundle-managed        |
| §6.5 discovery exclusion               | name     | a real `.prompt.md` workflow disappears from the picker |
| `WorkflowAssetWarnings.ts:71` regex    | name     | one spurious "use Save As" warning            |

**Rule: key on the manifest wherever the consequence is behavioral; name matching is acceptable
only where it is advisory.** For discovery that means treating a directory as a bundle only when it
contains `BUNDLE_MANIFEST_FILE_NAME` — one `existsSync` per directory ending in `.assets` during
the walk, which is negligible and makes the exclusion exact rather than heuristic. The warning site
may stay name-based: being wrong there costs a sentence, not behavior.

This is also why the §10-rejected resolver special-case cannot be rescued by manifest-keying: the
resolver is synchronous and runs per reference, so probing the filesystem for manifests there is
the wrong shape regardless of accuracy.

### 6.6 Quoting and token reconstruction

`./` contains no character requiring quotes, so `buildFileReference` / `buildSelectionReference` /
`buildSymbolReference` need no changes; a path with a space still quotes as
`@"./fix-tests.assets/shot one.txt"`.

Parser verified — no changes needed. `parseAtReferences`' unquoted branch is `[^\s:]+`
(`FileReferenceParser.ts:88`), which captures `./fix-tests.assets/shot.png` whole; the
trailing-punctuation strip is anchored (`[^a-zA-Z0-9/\\]+$`) and cannot touch a leading `./`; the
`#selection:` / `#sym` regexes exclude only whitespace, colons, and quotes. `./` and `../` survive
a parse → rewrite → parse round-trip verbatim in both quoted and bare forms. Masked-fenced-code
behavior is unchanged. Keep a round-trip test anyway so a future tightening of those regexes fails
loudly here.

### 6.7 Attachment IDs

`getAttachmentId()` / the excerpt `attachment id="…"` strings embed `ref.path`, so a `./` ref
produces `selection:./fix-tests.assets/x.png:2-4`. Cosmetic, and IDs are only used for dedupe within
one expansion. Leave it, but be aware the dedupe key differs between a `./`-form and
workspace-form reference to the same file — two tokens naming one file would produce two
attachments. Deduping on the resolved absolute path instead of `ref.path` fixes it and is a small,
self-contained improvement.

---

## 7. Migration script

Throwaway, single-user, delete after use. `dev/scripts/migrate-asset-refs.mjs`, plain Node, no
build step, not wired into `package.json`.

- Walk the repo for `*.ctrlyoke.{yaml,yml,json}` and `*.prompt.md`, honoring `.gitignore` at the
  simple level (skip `node_modules`, `.ctrlyoke/.runs`, `out`, `dist`).
- For each file, parse references with the runtime parser and find tokens whose workspace-relative
  path resolves inside a `*.assets/` directory that is a **sibling of that same workflow file**
  with a matching stem. Nothing else is rewritten.
- Rewrite those tokens to `./<stem>.assets/<name>`, preserving quoting, selection ranges, and
  symbol names/kinds — reuse `ContextReferenceBuilder`, apply edits in descending offset order, do
  not regex the whole document. Same rules as the analyzer, for the same reason.
- Default to `--dry-run` printing a per-file diff; require an explicit `--write`.
- Report and skip anything ambiguous (a `*.assets/` reference whose sibling does not exist, a stem
  mismatch, a ref inside a fenced block) rather than guessing.

Given this is pre-release with one developer, the honest expectation is that it finds zero or a
handful of files. It exists so the answer to "did I have any exported bundles lying around" is
checkable rather than assumed.

---

## 8. Testing

- `resolveReferencePath` unit table: absolute, `./`, `../`, `.\` (Windows), bare, named-root-
  prefixed, `./` with no `sourceDefinitionDir` (error), and the returned `base` for each.
- Collision: with both `<root>/src/index.ts` and `<workflowDir>/src/index.ts` present, `@src/index.ts`
  resolves to the workspace one and `@./src/index.ts` to the workflow one — deterministically, in
  both orders of file creation.
- Security: `@./../../../outside.txt` resolves then blocks; a `sourceDefinitionDir` outside
  `trustedRoots` is ignored rather than used; `prompt: ../../outside.md` is now blocked by
  `PromptFileResolver` (new coverage for the §4.3 hole, including the absolute-path form).
- `sanitizeReferences`: a `./` ref is rewritten away in single-root with `effectiveAbsolute` false —
  the §5.2 regression. Assert the emitted token contains no `./`.
- Analyzer: bundled refs come out as `./<stem>.assets/<name>` for `@`, `#selection:`, and `#sym`,
  with quoting/ranges/kinds preserved; multi-root export no longer emits a `rootName/` prefix for
  assets.
- Re-bundle (§6.1): export → Save As to a different directory → the asset is re-copied to the new
  sibling directory and the ref resolves; the previous manifest governs pruning of the old one.
  Template export of the same workflow blocks and names the step/token (§6.1.1).
- Idempotence: load an exported workflow and Save As **over the same path**. Source and destination
  for every copy are the same file, so the writer must stage-and-rename onto itself without
  truncating, `chooseAssetName` must return the identical name (it does — `manifest.files` makes the
  basename available), the prune set must be empty, and a third save must produce a byte-identical
  workflow. This is the cheapest regression test for the whole write ordering.
- Relocation round trip, the whole point: export a workflow with a pasted image, `mv` the pair to a
  different directory, load it, confirm every reference resolves and no missing-assets warning
  fires. Repeat into a second workspace at a *different* relative path — the case that fails today.
- Parity sites: at minimum `handleContextRefsValidation` and `WorkflowAssetWarnings` report a
  relocated bundle as valid.

---

## 9. Sequencing

| # | Step                                                                                  |
| - | ------------------------------------------------------------------------------------- |
| 0 | Today-bugs, independent of this plan: exclude manifested `*.assets/` from workflow discovery (§6.5, §6.5.1) and extend the missing-assets scan to top-level `workflow.prompt` (§1.2.1 gap 1, first half) — **landed** |
| 1 | `resolveReferencePath` + `PromptFileResolver` containment fix (§3, §4) — no behavior change to emitted refs yet — **landed** |
| 2 | `ContextExpander` base plumbing through `HarnessIntegration`, incl. the `sanitizeReferences` rewrite (§5.1, §5.2) and the §6.7 dedupe-on-absolute-path fix — **landed** |
| 3 | Parity sites (§5.3), webview payload included — **landed**                              |
| 4 | Analyzer emits `./` (§5.1.3) — the flip, plus the relocation round trip and idempotence tests (§8) |
| 5 | Manifest-aware re-bundling classification + template-mode block (§6.1, §6.1.1)         |
| 6 | Migration script (§7), run once, then delete                                           |
| 7 | Docs: `docs/reference/commands.md` Save-As section; the "exported pairs are movable" line in the guide, stating the §1.1 relocatability boundary |

Step 0 is pure bug-fixing that stands on its own and must land first: §6.5's discovery exclusion is
already wrong today (bundled `.prompt.md` files show up as runnable workflows), and the warning
asymmetry weakens the safety net every later step leans on.

Steps 1-3 are consumer-side and land with no visible change — every existing reference keeps its
meaning because nothing emits `./` yet. Step 4 is the flip. That ordering means step 4 is revertible
on its own if the relocation round trip surprises us. Step 5 fixes a corruption mode that exists
today in a different shape (§6.1), so it is deliberately separable from the flip.

Step 2 renders workflow-relative inline references as absolute paths during sanitization, even when
single-root rendering otherwise keeps workspace references in their authored form. Absolute output
is the deliberate choice because harness CLIs run from the workspace root rather than the workflow
directory, and it therefore preserves the workflow-relative meaning without relying on a second cwd
or another relative-path convention. Workspace-based references retain their existing byte-for-byte
sanitized output.

### 9.1 Explicitly out of scope for this execution

- **The "keep prompt files as references" escape hatch (§1.2, §1.2.1).** §1.2's recommendation
  stands: do not change the inline default. The escape hatch's prerequisites (§1.2.1) are therefore
  not being built either, beyond step 0's half of gap 1, which is worth doing on its own merits.
- **The convert-to-prompt-file destination choice (§1.2).** A separate UI change with its own
  design; it does not block relocatability.
- **Save As setting `descriptor.originalFile` to the export destination (§6.2).** A UX nicety, not a
  correctness fix — the relocation guarantee does not depend on it.
- **Symlink-escape hardening on reference reads (§4.4).** Named as a distinct pre-existing gap on
  purpose; do not let it grow into this plan.

## 10. Rejected

- **Two-base probing (source-dir first, workspace fallback).** §2.1: silently changes the meaning of
  existing tokens based on filesystem state, doubles stats on the expansion path, and makes the
  authorization boundary depend on which candidate happened to exist.
- **Special-casing `*.assets/`-shaped paths in the resolver.** Couples reference resolution to the
  bundler's naming convention, and gives a human no way to express the same intent.
- **A new sigil (`@~/`, `@workflow:`).** `./` is what every developer already reads as "here", and
  the only thing it costs is a documented no-op branch in `resolveNamedRelativePath` (§2.3).
- **Storing a portable base in the workflow file** (e.g. a top-level `assetsDir`). Redundant — the
  file's own location is the base, and a stored path is one more thing to go stale.

## 11. Related

- `dev/implemented/WORKFLOW_PORTABILITY_PLAN.md` — §8.1 is the decision this plan reverses; §3.2's
  classification table gains the §6.1 row; §3.1's missing-assets warning becomes the safety net for
  a genuinely movable pair rather than a consolation prize.
