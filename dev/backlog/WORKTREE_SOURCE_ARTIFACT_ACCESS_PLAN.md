# Worktree Source-Artifact Access — logs, attachments, and prompt files

> **Status:** Staged for implementation 2026-08-16. Written 2026-08-16 against
> current code; revised the same day after a code review found three points
> where the original design could not be built as written (§4.1.1, §5.1, §5.6).
>
> **Problem in one line:** ctrlyoke's own generated runtime artifacts
> (`.ctrlyoke/logs/`, `attachments/`, `prompts/`) are gitignored and always
> written to the **source** checkout, so a worktree run cannot reach any of
> them — pasted screenshots vanish, file-backed prompt steps hard-fail, and a
> referenced log is either dropped or rejected as "outside the workspace."
>
> **Relationship to neighbours.** `WORKTREE_SUPPORT_PLAN.md` established the
> execution-workspace root split this plan carves a read-only exception into;
> its isolation guarantee is about **write** access and is preserved intact
> (§2). `WORKFLOW_PORTABILITY_PLAN.md` decided these directories are ignored
> _because_ Save As bundles what a durable workflow needs — that decision is
> unchanged here, and this plan is its execution-time analogue: the bundler
> makes a workflow portable **across machines**, this makes a run's inputs
> reachable **across checkouts on one machine**.

---

## 1. What breaks today

Three directories, three different failure modes. All verified against current
code.

| Artifact                   | Written to                                                | Worktree-run outcome today                                                           |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `.ctrlyoke/attachments/**` | source checkout (`TempFileManager.ts:69-75`)              | ref dropped; surfaces only as a `prompt.reference.unresolved` diagnostic             |
| `.ctrlyoke/prompts/**`     | source checkout (`PromptEditorSupportService.ts:280-284`) | **lone** step prompt throws `PromptFileReferenceError`; **inline** `@ref` is dropped |
| `.ctrlyoke/logs/**`        | source checkout (`Log.openLogFile`, `Log.ts:133-144`)     | relative ref misses; absolute ref is **blocked** as "resolves outside the workspace" |

The common cause is one mapping. `WorktreeManager.buildExecutionWorkspace()`
(`src/core/orchestration/WorktreeManager.ts:2817-2844`) remaps every workspace
root onto the execution checkout:

```ts
mapSourcePath = (p) =>
  path.resolve(
    executionCheckoutRoot,
    path.relative(inputs.sourceCheckoutRoot, p)
  );
```

That is correct and deliberate for repository content. But all three
directories above are **gitignored** (`WorkspaceInitializer.ts:53-62`), so the
remapped path names a file that does not and will never exist in the worktree.

Consumers then diverge because they resolve through different code:

- Inline `@` / `#selection:` / `#sym:` refs → `ContextExpander.resolveReference`
  (`src/utils/ContextExpander.ts:804-839`), whose containment check at `:832-836`
  rejects anything outside `trustedRoots`.
- Lone step prompts → `PromptFileResolver.getCandidates`
  (`src/core/PromptFileResolver.ts:243-298`), built in `WorkflowExecutor.ts:2579-2590`
  with `workspaceRoot: executionRoot`.

**There is no working user workaround inside the reference syntax.** An
absolute path to the source checkout is precisely what the containment check
blocks. What remains: run with worktree `None`, hand-copy the file into the
worktree first, or bypass `@` entirely and paste a bare absolute path as
literal prompt text (§5.3).

### 1.1 Why this is worse than it looks

The gap is invisible until you are already debugging inside a worktree — which
is exactly when you want to hand the agent a log. It also scales the wrong way:
every named worktree is a fresh, permanently empty `attachments/` store, so the
more you use worktree mode the less any pasted context works.

---

## 2. The constraint this must not break

`WORKTREE_SUPPORT_PLAN.md` requires that worktree preflight _"reject any
approved/additional root that equals, contains, or is contained by the source
checkout"_, to stop an old trust decision from _"silently granting write access
back into the live checkout."_

That is not a general prohibition on reading source-side bytes — it is a
prohibition on **handing the harness a path into the live checkout**, because
`approvedExternalRoots` flow straight into `--add-dir`
(`CliProviderUtils.ts:244-266`, via `CliIntegration.ts:327-329`).

So the usable seam is narrow and precise:

> **ctrlyoke may read a source-side runtime artifact and embed its bytes into
> the prompt. The harness may never be given a path into the source checkout.**

This rules out the tempting one-line fixes: adding `sourceCheckoutRoot` to
`trustedRoots`, or registering it as an approved external root. Both grant
`--add-dir` write access.

---

## 3. The unified rule

One predicate decides _whether_ a reference qualifies. The reader decides
_what to do about it_.

### 3.1 Predicate — "source-only runtime artifact"

A reference qualifies when all four hold:

1. It does **not** resolve against the execution roots (today's tier-1
   resolution runs first and always wins).
2. It resolves to a path **inside** `sourceCheckoutRoot`.
3. That path is a **regular file** that exists.
4. That path is **gitignored** in the source checkout.

**Why "gitignored" and not merely "missing from the worktree."** A _tracked_
file absent from the worktree is a genuine branch difference, and importing it
would silently serve source-side content to a run whose entire purpose is a
different branch state — it must stay broken. A gitignored file has no branch
state at all, so copying or reading it cannot mask anything. The test is
derived from a fact about the file rather than a hardcoded directory list that
would need extending every time ctrlyoke adds a runtime directory.

**Untracked-but-not-ignored files are deliberately excluded.** Those are repo
files in progress; pulling them into a different branch's checkout is the same
silent-divergence hazard, just less obvious.

**This grants no new exposure.** Every qualifying file is one a _non-worktree_
run of the same workflow could already reference today. The rule restores
parity between worktree and non-worktree runs; it does not widen what a prompt
may name. (Secrets that happen to be gitignored — `.env` and friends — are in
scope for the same reason they are today in a normal run; redaction is
`SECRETS_AND_REDACTION_PLAN.md`'s problem, not this one's.)

### 3.2 Action — split by who opens the file

Verified: `directFileRefs` are **never** inlined as content. `CliPromptPreparer`
passes each one to `formatDirectFileRef` (`:569`, and on the inline fast path at
`:266-280`) so the _harness_ opens it. Embedding is therefore unavailable to
that category, and images cannot be embedded under any scheme.

| Reference form                  | Who opens it | Action                                     |
| ------------------------------- | ------------ | ------------------------------------------ |
| `#selection:` / `#sym:`         | ctrlyoke     | **Read in place** from source; embed (§4)  |
| Lone step `prompt` path         | ctrlyoke     | **Read in place** from source; inline (§4) |
| Full-file `@ref` — text         | **harness**  | **Copy** into the worktree (§5)            |
| Full-file `@ref` — image/binary | **harness**  | **Copy** into the worktree (§5)            |
| `@dir/`                         | ctrlyoke     | **Blocked** (§4.3)                         |

So `@.ctrlyoke/logs/ctrlyoke-….log` is copied, while
`#selection:"…ctrlyoke-….log":13769-14052` is not — the difference is the
reader, not the directory. Logs, attachments, and prompt files are not special
cases under this rule; they are just the files that happen to qualify most often.

---

## 4. Read-in-place (references ctrlyoke opens)

### 4.1 Resolution tier

Add one fallback tier after today's resolution: if tier 1 misses and §3.1 holds,
resolve against the source path, tagged with a new `ReferencePathBase` member
`"sourceRuntimeStore"` (`src/platform/WorkspaceRootResolver.ts:141-145`).

Both relative and absolute forms are accepted, so a hand-typed
`#selection:"C:\dev\ctrlyoke\.ctrlyoke\logs\ctrlyoke-….log":13769-14052` works
as written.

Two resolvers need this, because they are separate code paths:

- `ContextExpander.resolveReference` (`:804-839`) — inline refs.
- `PromptFileResolver.getCandidates` (`:243-298`) — lone step prompts. Append a
  source-side candidate; `isCandidateAllowed` (`:333-348`) must accept it, which
  is what the existing `ownStateRoots` escape hatch already models for UI reads.

### 4.1.1 The predicate is async; both resolution seams are synchronous

`ContextExpander.resolveReference` is a **synchronous** private method, and it
is reached from four callers (`resolveWorkspacePath` → `buildAttachmentXml`,
`buildSanitizedReferenceText`, `estimateFileReferenceTokens`,
`estimateImageReferenceTokens`). §3.1 needs `fs.stat` **and** a `git
check-ignore` subprocess, so the tier cannot be evaluated inside it, and making
it async would also defeat §5.5's "one `check-ignore` per prompt" requirement by
turning it into one subprocess per reference.

**Resolve it with a precomputed map, not an async resolver.** Before the
per-reference loop in `expandContextSplit`, run one pass that:

1. parses the references once (`parseAllFileReferences` — already called there),
2. computes each one's tier-1 absolute path and drops those that exist,
3. issues **one** batched `check-ignore` for the survivors' source-side
   paths (§5.6),
4. returns a `Map<refPath, { absolutePath, base: "sourceRuntimeStore" }>`.

`resolveReference` then consults that map after its own tier-1 resolution and
before the containment check, staying synchronous. The map is per-expansion
state, built once and reused by every caller above, so token estimation and
attachment building can never disagree about where a reference resolved.

The same precomputed-map shape serves §5: the copy pass needs exactly this
classification, so build it once and let both actions read it.

**`PromptFileResolver.resolvePathSync` is deliberately excluded.** It exists for
VS Code's synchronous document-link API, which runs against the source checkout
in the editor — where tier 1 already resolves, so the source tier would be dead
code there. Only the async paths (`resolve`, `resolvePath`, `findReadableFile`)
gain the tier. Keep the two implementations' candidate lists otherwise
identical, and assert that in a test.

### 4.2 Rendering: absolute in **both** the excerpt and the inline token

A read-in-place resolution renders its **absolute source path** in two places,
not one:

- `buildAttachmentXml` — `displayPath` at `ContextExpander.ts:743`, feeding the
  descriptions at `:749-750` and `:780-782`.
- `buildSanitizedReferenceText` — the `resolution.base === "workflow"` branch at
  `:494-497` and `:506`. `"sourceRuntimeStore"` joins that condition.
  `#sym:` is the same branch and needs no separate work.

**Decision: rewrite the inline token, do not rely on the attachment header
alone.** The harness's cwd is the _worktree_, so an as-typed
`#selection:".ctrlyoke/logs/x.log":100-200` is not a neutral hint — it is a
valid-looking path that resolves, from the harness's position, to a worktree
file that does not exist. Leaving it produces two contradictory paths for one
file (relative in the prompt body, absolute in the attachment header), whose
failure mode is an agent that tries the relative path, gets ENOENT, and
concludes the log is missing instead of re-reading the header. Contradiction
costs more than verbosity.

This is also the established precedent rather than a new rule: the
`base === "workflow"` branch exists for exactly this reason, per the comment at
`:491-493` — _"harness CLIs run from the workspace root, not the workflow
directory. Absolute output is unambiguous even when the workflow lives
elsewhere."_ Source-store refs are that case with a different base. The output
shape is already proven — `quoteReferenceField` (`:513`) handles the Windows
drive-colon form, which is why it exists, and multi-root workspaces emit the
same shape today via `effectiveAbsolute`. Attachment IDs stay as-typed, per the
existing invariant at `:93-96`.

Secondary benefit: an unsandboxed harness can open the **full** log when the
excerpt turns out to be too narrow. A sandboxed one cannot, and loses nothing it
had.

Result — attachment header and prompt body agreeing:
`Excerpt from C:\dev\ctrlyoke\.ctrlyoke\logs\ctrlyoke-….log, lines 13769 to 14052`.

### 4.2.1 Why copied refs are the opposite

Copied and read-in-place references land on opposite sides of this for the same
underlying reason:

| Action        | Relative token after the pass                               | Rewrite? |
| ------------- | ----------------------------------------------------------- | -------- |
| Copy (§5)     | **true** — the file now exists at that path in the worktree | no       |
| Read in place | **false** — nothing was copied                              | yes      |

The copy makes the relative path true; reading in place makes it a lie.

### 4.3 Directory refs stay blocked

`@<source>/…/` directory refs remain rejected, for the same reason
`WORKFLOW_PORTABILITY_PLAN.md` §3.2 blocks them at export: the generated stores
are flat and shared, so a directory ref sweeps in every unrelated paste. Block
with a message naming the offending token.

### 4.4 Logs are never copied

A log referenced as an excerpt is read in place and embedded. It is not copied,
because nothing needs it on disk in the worktree: logs are large, actively
appended during the run, and the point of the reference is that the agent knows
the file lives in the source checkout.

---

## 5. Copy (references the harness opens)

### 5.1 Mechanism — a deferred `PreparedMutation`, not an eager copy

For a qualifying full-file `@` reference, the destination is the **same relative
path** inside the execution checkout:

```ts
path.resolve(
  executionCheckoutRoot,
  path.relative(sourceCheckoutRoot, sourcePath)
);
```

**The copy must not happen during prompt building.** `CliPromptPreparer.
planPrompt` is contractually side-effect-free — it is what `ExecutionPreviewService`
calls for Dry Run, and its own doc comment promises "without creating any temp
file." An eager copy there would have Dry Run writing files into the worktree.

The codebase already has the right vehicle: `PreparedMutation`
(`src/core/harness/shared/interfaces/PreparedMutation.ts`). `planPrompt`
collects mutations; `preparePrompt` applies them in order and rolls back on
failure. So:

- **Plan time:** classify the reference, compute the destination, push the
  destination onto `directFileRefs`, and emit a `PreparedMutation` whose `apply`
  performs the copy. `path`/`description` on the mutation make the copy visible
  in the preview for free.
- **Execute time:** `preparePrompt` applies the mutation before launch, so the
  file exists by the time the harness opens it.

This means the plan does **not** wait for tier 1 to start hitting — it names the
post-copy destination directly, because at plan time the file is not there yet.
That is the only deviation from "let tier 1 resolve it normally"; the observable
result for the harness is identical, and it is what makes §6's Dry Run claim
true rather than aspirational.

`PromptSections` (`src/core/HarnessIntegration.ts:80-97`) carries the copy
descriptors up as plain `{ sourcePath, destinationPath }` records — core must
not import from `harness/shared`; `CliPromptPreparer` turns them into
`PreparedMutation`s.

No token rewriting, and no change to how the reference is written:
`@.ctrlyoke/logs/ctrlyoke-1786917981016.log` stays as typed (§4.2.1).

### 5.2 Why copy rather than widen `--add-dir`

Images are the forcing case: they cannot be embedded as text, so the file must
physically exist somewhere the harness may read. The only alternatives are
copying it in or exposing the source checkout through `--add-dir`, which §2
rules out.

### 5.3 Why not "pass the absolute source path through" instead

Bare absolute paths typed as literal prompt text work today only because they
are not parsed as references at all — they bypass `ContextExpander` entirely and
an unsandboxed harness reads them. Making that a supported mode was considered
and **rejected for v1**: correctness would depend on harness sandbox
configuration ctrlyoke does not control, and would differ across the six
harnesses. Copying is deterministic everywhere. The literal-text escape hatch
keeps working regardless; it just loses completion, token counting, and Dry Run
visibility, and breaks the day a sandbox is enabled.

### 5.4 Why this is safe for the branch

`WorkspaceInitializer.initializeIfNeeded(executionRoot)` runs on **both**
worktree paths — managed (`WorktreeManager.ts:1403`) and named (`:2079`) — and
writes a `.gitignore` covering these directories
(`WorkspaceInitializer.ts:53-62`). Both `getGitTrackedAndUntrackedFiles` and
`getGitUntrackedFiles` use `--exclude-standard` (`GitUtils.ts:474-493`), so the
copies are invisible to the managed-landing preflight at
`WorktreeManager.ts:717-742` and can never pollute a landed branch.

More generally this is self-consistent: a file qualifies only if it is
gitignored in the source, and the destination is the same relative path in a
checkout of the same repository — so the same `.gitignore` rule covers it there.
Verify it in a test rather than assuming it; an entry that stopped being ignored
would turn every copy into a landing blocker.

### 5.5 Guardrails

- **Files only.** Directory refs are blocked (§4.3), so a copy is always a
  single file.
- **Inside the source checkout only.** A gitignored path outside it stays
  blocked by the existing containment check.
- **Size cap — a new constant, deliberately not `MAX_CONTENT_SIZE`.** That
  constant is 512 KB (`DashboardConstants.ts:1261`) and governs _inline content_:
  the point above which text is no longer embedded or tokenized exactly. A copy
  embeds nothing, so the two limits answer different questions, and reusing it
  would refuse precisely the multi-megabyte session logs this plan exists to
  support. Add a separate, generous disk-safety ceiling (order of tens of MB);
  above it, refuse the copy and say so by name and size. Oversized references
  are _already_ warned about independently by the existing
  `prompt.reference.implausibly-large` diagnostic, which fires off
  `estimateFileTokens().estimated` regardless of worktree mode — the new ceiling
  exists only to stop an unbounded file from being duplicated on every run.
- **Batch the ignore query.** One `git check-ignore --stdin -z` call for all
  candidate references, not a subprocess per reference. No such helper exists in
  `GitUtils.ts` today; add one.
- **Skip identical destinations.** Attachments are content-addressed SHA-256
  (`TempFileManager.createPastedImageFile`, `:341-372`), so an existing
  destination is byte-identical and the copy can be skipped outright.
- **Overwrite otherwise.** Prompt files and logs are not content-addressed. A
  stale worktree copy silently feeding an old prompt body is worse than losing a
  hand-edit inside a gitignored runtime directory nobody is expected to edit.

### 5.6 `check-ignore` mechanics — three traps

The batched helper belongs in `GitUtils.ts` beside `getGitUntrackedFiles`
(`:485-493`) and must get all three of these right:

1. **Never pass `--no-index`.** Default `check-ignore` reports a _tracked_ file
   as not-ignored, which is precisely §3.1's tracked-file exclusion. `--no-index`
   evaluates ignore rules regardless of the index and would silently import
   tracked-but-absent files — the exact failure §3.1 and §8 forbid.
2. **Exit code 1 is success.** `git check-ignore` exits 1 when _nothing_ matched.
   `execFileAsync` rejects on any non-zero exit, so the helper must treat 0 and 1
   as normal results and only surface ≥2 as an error. A helper that lets the
   rejection through fails closed on every prompt with no ignored references —
   which is most of them.
3. **Prefer arguments over `--stdin`.** A prompt carries a handful of references,
   not thousands, so `git check-ignore -z -- <paths…>` is one subprocess and
   needs no stdin plumbing. (`promisify(execFile)` gives no writable stdin
   without reaching through `.child`.) Use `-z` and split on NUL, matching the
   file-listing helpers directly above it.

Return the ignored subset as a `Set` of absolute paths so callers do a lookup,
not a scan.

### 5.7 Accumulation

Managed worktrees are removed at completion, so copies vanish with them. Named
worktrees persist and accumulate copies across runs. Log filenames carry
timestamps and attachments are content-addressed, so repeat references to the
same file do not duplicate — but a long-lived named worktree will collect every
log ever referenced into it. Acceptable for v1 (the directory is gitignored and
the files are small relative to a checkout); revisit with a sweep if it bites.

---

## 6. Disclosure

No setting gates this. It is read-only ingestion of machine-local artifacts the
user explicitly referenced, and requiring opt-in would leave the default broken.

But it must not be silent. `WORKTREE_SUPPORT_PLAN.md` requires that isolation
degradation be _"recorded on the run — not merely logged"_, so emit an
info-level diagnostic through the existing `CompatibilityDiagnostic` channel
added alongside `prompt.reference.unresolved` in `CliPromptPreparer`:

> 2 references were read from the source checkout; 1 file was copied into the
> worktree.

`ExecutionPreviewService` already builds its preview against the worktree-remapped
`ExecutionWorkspace`, so Dry Run reflects both actions without extra work.

---

## 7. Sequencing

Six steps, each self-contained, tested, and committed on its own. Steps 1-4 are
independently shippable and fix excerpt references and file-backed prompt steps;
step 5 is what makes `@.ctrlyoke/logs/…` and pasted images work.

| Step | Scope                                                                                            | Depends on |
| ---- | ------------------------------------------------------------------------------------------------ | ---------- |
| 1    | `GitUtils` batched `check-ignore` helper (§5.6) + §3.1 predicate module + `"sourceRuntimeStore"` | —          |
| 2    | `sourceCheckoutRoot` plumbing + `ContextExpander` precomputed tier (§4.1, §4.1.1)                | 1          |
| 3    | Absolute-path rendering for source-store resolutions (§4.2) + directory block (§4.3)             | 2          |
| 4    | `PromptFileResolver` source tier for lone step prompts (§4.1)                                    | 1          |
| 5    | Copy pass as a deferred `PreparedMutation` (§5), with §5.5 guardrails                            | 2          |
| 6    | Disclosure diagnostic (§6) + Dry Run / landing-preflight / non-worktree assertions               | 5          |

Step 1 lands the two pure, dependency-free pieces together so steps 2 and 4 can
proceed against a stable predicate. Steps 2 and 3 are split because the tier and
its rendering have separate, substantial test surfaces, but the tier is what
makes the rendering reachable at all.

---

## 8. Testing

- **Tier 1 always wins:** a file present in both checkouts resolves to the
  **execution** copy, and is never read from or copied out of the source.
- **Tracked-but-absent stays blocked:** a tracked file deleted on the worktree's
  branch is not imported — the predicate's gitignore clause is what rejects it.
- **Untracked-but-not-ignored stays blocked.**
- Absolute and relative forms of a qualifying ref both resolve; a gitignored
  path _outside_ the source checkout remains blocked with the existing message.
- **Symlink escape:** a symlink inside the source checkout pointing outside it is
  rejected (`realpath` both sides, matching the export bundler's rule).
- Excerpt rendering carries the absolute source path in the attachment
  description **and** in `sanitizeReferences` output — assert both, and assert
  they name the _same_ path, since the whole point is that they cannot disagree.
  Windows drive-colon quoting is preserved (`quoteReferenceField`), and a
  rewritten `#sym:` keeps its kind suffix, symbol name, and line range.
- A **copied** ref's inline token is left workspace-relative and unrewritten —
  the mirror image of the excerpt case, and the assertion that keeps the two
  actions from converging by accident.
- A qualifying `@dir/` ref is blocked and names the token.
- **Copy:** lands at the mirrored relative path; a byte-identical attachment is
  skipped; a prompt file and a log **are** overwritten; copies do not appear in
  `getGitUntrackedFiles` for the worktree.
- **Size:** a multi-megabyte log — larger than `MAX_CONTENT_SIZE`, under the
  copy ceiling — **is** copied and resolves normally. This is the motivating
  case and must not regress into a refusal. Only a file over the copy ceiling is
  refused, by name and size.
- `check-ignore` is invoked **once** for a prompt with many references.
- Managed landing still succeeds with copies present, and the preflight at
  `WorktreeManager.ts:717-742` reports no blocked runtime paths.
- **Non-worktree runs are byte-for-byte unchanged:** `sourceCheckoutRoot` is
  undefined, so no predicate, no tier 2, no copies, no diagnostics, and no
  `check-ignore` subprocess.
- Dry Run surfaces the same resolutions, copies, and disclosure diagnostic as the
  real worktree run.

---

## 9. Related

- `dev/implemented/WORKTREE_SUPPORT_PLAN.md` — execution-workspace root split
  and the `--add-dir` isolation rule this plan works within.
- `dev/implemented/WORKFLOW_PORTABILITY_PLAN.md` — why these directories are
  ignored, and the export-time bundler whose copy/dedup rules §5 mirrors.
- `dev/implemented/PROMPT_FILE_EXTRACTION_PLAN.md` — the writer that puts prompt
  bodies into `.ctrlyoke/prompts/` in the first place.
- `dev/backlog/SECRETS_AND_REDACTION_PLAN.md` — owns the "what if the referenced
  gitignored file is a secret" question (§3.1).
