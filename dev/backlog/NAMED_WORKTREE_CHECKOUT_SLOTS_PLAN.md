# Named Worktree Checkout Slots

**Status:** Not started. Written 2026-10-30 against current code.
**Priority:** P2

## Problem

Named mode treats a worktree's **branch** as its identity: the checkout
directory is derived from the branch. Many developers use worktrees the other
way round. They keep two or three long-lived **slots** (`bug-fix`, `feature`)
and check a different branch into a slot for each piece of work
(`fix-race-condition`, `add-paging-support`). That branch gets pushed and
reviewed in a PR.

The slot model matters most in large repositories. In a 30 GB monorepo,
creating a checkout per branch takes a long time and repeats every setup
(dependency installs, build caches). Today, a workflow that names
`branch: fix-race-condition` creates exactly that new checkout.

ctrlyoke's own development uses the narrower case where slot and branch have the
same name (`small-feature` only ever holds the `small-feature` branch) and
everything merges to local `main`. That flow must keep working unchanged.

## How things work today

- **Schema.** `worktreeConfig` in `schemas/workflow-schema.json` allows a named
  object with `mode`, `branch` (required), `base` and `setup`, plus a
  string shorthand meaning `branch`. `WorktreeConfig` in
  `src/types/CtrlYokeTypes.ts` mirrors it. `src/utils/WorktreeResolution.ts`
  normalizes the shorthand and rejects an empty branch.
- **Resolution** (`WorktreeManager.resolveNamedWorktree`,
  `src/core/orchestration/WorktreeManager.ts`):
  1. Look in `listGitWorktrees` for an entry with `branch` checked out. If one
     exists, attach to it, wherever it is (`origin: "discovered"`). The source
     checkout itself is refused.
  2. Otherwise create a directory under the resolved worktree root, named by
     `createWorktreeDirectoryName(branch, commonDirectory, { kind: "named",
branchRef })` (`src/utils/WorktreeUtils.ts`). The name is the slug plus a
     12-character hash, and the directory is created with `addWorktree`, using
     the existing branch or creating it from `base`/`HEAD`.
- **Pieces that already fit the slot model:**
  - The named setup record is keyed by **checkout path** (`recordPath(...,
executionCheckoutRoot, "named-worktrees")`), not by branch. A slot that has
    run setup once does not run it again when its branch changes.
  - The lease is `exclusive-worktree` on the execution root, so two runs (or a
    run and a terminal kept open by Reuse Running Terminal) cannot use the same
    slot.
  - Ahead/behind for the run uses `base`, or the branch's upstream when `base`
    is empty (`getBranchUpstream` in `src/utils/GitUtils.ts`).
- **Workaround that works today.** Run `git switch -c fix-race-condition` in
  the `bug-fix` checkout by hand, then author `branch: fix-race-condition`.
  Step 1 discovers it, so the run lands in the slot.
- **Settings → Worktrees** (`WorktreesSection.tsx`, `WorktreeGitStatus.tsx`)
  compares each branch only against the source checkout's branch
  (`WorktreeManagementEntry.sourceComparison`). The `divergence` line (against
  `base`/upstream) comes from the in-memory `namedDivergenceCache`, so it only
  appears after a named run in the same extension-host session. **Sync** and
  **Sync All** (`WorktreeManager.syncNamedWorktree`) merge the branch into the
  source checkout's branch and back. That suits the ctrlyoke flow, but it puts
  unreviewed PR work into local `main`.

## Proposal

### Schema: optional `checkout` on the named object

```yaml
worktree:
  mode: named
  checkout: bug-fix # the long-lived slot
  branch: fix-race-condition # the branch for this run
  base: origin/main # used only when the branch does not exist yet
  setup: npm ci # runs once per slot, as today
```

- `checkout` is an optional, non-empty string. It is either an absolute or
  `~`-prefixed path, or a bare name (no path separators).
- Without `checkout`, behavior is exactly as today. The string shorthand keeps
  meaning `branch`.
- Not legal in managed mode. The managed object keeps
  `additionalProperties: false` without it.
- This is an **additive optional property**, so no `npm run schema:bump` and no
  `FormatMigrations.ts` entry. A ctrlyoke older than this one rejects the field
  (`additionalProperties: false`). That is the normal forward-compatibility
  behavior for a newer workflow file. Run `npm run schema:update` and keep the
  field's behavior in its schema `description` (it feeds the reference docs and
  IntelliSense hovers).

Field name: `checkout` matches the existing vocabulary (`sourceCheckoutRoot`,
`executionCheckoutRoot`) and reads naturally next to `branch`. Rejected
alternatives: `path` (implies an absolute path only) and `slot` (jargon the docs
would have to define first). `worktree` is also out: `worktree.worktree` reads
badly.

### Resolving `checkout`

The input is a bare name or a path, and the result is one linked worktree of
this repository:

1. **Path form:** normalize it, then require it to be either an entry in
   `listGitWorktrees(sourceCheckoutRoot)` or a path that does not exist yet
   under any directory (creation, below). An existing directory that is not a
   registered worktree of this repository is an error. Never adopt an
   arbitrary folder.
2. **Bare-name form:** match registered linked worktrees whose directory
   basename is exactly the name, or the name followed by the
   `createWorktreeDirectoryName` hash suffix for the slot identity (below).
   Exactly one match is required. With no match, the target is a new slot under
   the resolved worktree root. With more than one, the error lists the
   candidates and asks for a path.
3. The source checkout is never a valid slot (same rule as today).

On this machine, `checkout: bug-fix` resolves to
`C:/dev/ctrlyoke.worktrees/bug-fix` through the basename rule.

### Resolution order with `checkout` set

1. **Branch already checked out somewhere.** If that worktree is the resolved
   slot, attach as today. If it is a different worktree, fail: `Branch
"fix-race-condition" is checked out in "<path>", not in checkout "bug-fix".`
   Never silently use another slot. (Git would refuse the switch anyway.)
2. **Slot exists, holds another branch (or is detached).**
   - Acquire the slot's lease **before** touching it. Today an attach persists
     runtime only after the lease, and the switch must follow the same order, so
     a run that cannot get the lease changes nothing.
   - Refuse if `hasUncommittedChanges(slot)`. Name the slot and its current
     branch, and leave it for the user to commit or stash. ctrlyoke never
     stashes, discards or carries changes across.
   - Refuse if a Git operation is in progress (merge, rebase, cherry-pick).
   - Refuse if the slot's current branch has a managed-worktree ownership
     record (the same check `syncNamedWorktree` makes).
   - Then, under `withWorktreeMutationLock`: `git switch <branch>` if the local
     branch exists, otherwise `git switch -c <branch> <capturedBase>`. Add a
     `switchBranch` helper to `GitUtils.ts` beside `addWorktree`.
   - Record the previous branch in the runtime (`previousBranch`) so the run
     view can say "Switched bug-fix from `bug-fix` to `fix-race-condition`".
3. **Slot does not exist.** Create it with `addWorktree` at the slot path, not
   at a branch-derived path, checking out or creating `branch` directly. Then
   run setup. The bare-name form creates `<root>/<slug(name)>-<hash>`, using a
   new `WorktreeNameIdentity` kind (`"checkout"`, identity `checkout:<name>`), so
   two repositories never collide on one root. Safety of reuse comes from Git
   registration in step 2 of "Resolving `checkout`", not from the hash.

ctrlyoke never switches a slot back after a run. The branch stays checked out
so the user can push it.

**Continuing an older run.** The run file's `_runtime` worktree block records
the branch and path. When a run is continued after its slot has moved to another
branch, resolution runs again with the run's own branch, so step 2 switches the
slot back if it is clean, or refuses with the dirty-slot message. That is the
correct outcome, but it is a visible mutation. The continue flow should show the
same "Switched …" notice, and the Dry Run modal should predict it.

### Setup

No change: the setup record is already keyed by checkout path. A branch switch
does not re-run setup. If a project needs a per-branch step (for example
reinstalling after a lockfile change), that belongs in a pre-condition or script
step, not in `setup`. The schema description for `setup` should say so when
`checkout` is set.

### Dashboard: workflow properties

`WorkflowPropertiesPanel.tsx` (named section, under the Worktree row):

- Add a **Checkout** field above Branch. It is a combobox listing the linked
  worktrees from `settingsStore.worktreeManagement` (excluding the source
  checkout and managed worktrees), plus free text for a new slot name or path.
  Empty means "derive from the branch" (today's behavior).
- Branch description: "Existing or new local Git branch. With a checkout set,
  it can differ from the checkout's name; ctrlyoke switches the checkout to it
  when the checkout is clean."
- Add `"checkout"` to the `WorktreeField` union, thread it through
  `handleWorktreeFieldChange`, the reset path and `worktreeObjectConfig`, and
  apply the same in `DefaultsHarnessPage.tsx`.
- `WorkflowStatus.tsx` and `DryRunModal.tsx` show `checkout → branch` when
  `checkout` is set, plus a "will switch from `<current>`" line or the
  dirty-slot blocker in Dry Run (`previewExecutionWorkspace`).

### Settings → Worktrees: the PR flow

1. **Upstream comparison.** Add `upstreamComparison?: { label: string; ahead:
number; behind: number }` to `WorktreeManagementEntry`, computed in
   `getManagementState` from `getBranchUpstream` and `getAheadBehind` (the same
   informational, failure-tolerant pattern as `sourceComparison`). Render it in
   `WorktreeGitStatus.tsx` next to the existing comparison, for example
   `↑2 origin/fix-race-condition`. This replaces the session-only
   `namedDivergenceCache` for this purpose. Decide whether `divergence` stays
   for the explicit-`base` case.
2. **Sync gating.** A branch whose upstream exists and is not the source
   checkout's branch is a PR branch. Two-way Sync would merge it into local
   `main`.
   - Exclude it from `isSyncEligible` (the row's **Sync** and **Sync All**), and
     repeat the check server-side in `syncNamedWorktree`, since the webview is
     not the only caller.
   - Offer **Update from `<source branch>`** instead: a one-way merge of the
     source branch into the worktree's branch, reusing the second half of the
     sync engine and the same lease and clean-tree guards.
   - Branches with no upstream (today's ctrlyoke flow) keep Sync unchanged.
3. **Slot label.** When a worktree's directory basename differs from its branch,
   show both (`bug-fix · fix-race-condition`), so the slot and its current work
   are readable at a glance.

## Compatibility checklist

- Workflow schema: additive optional property, so no bump. Run
  `npm run schema:update`.
- Settings schema: `defaults.worktree` `$ref`s `worktreeConfig`, so it picks up
  `checkout` automatically, with no separate change.
- Persisted run `_runtime` worktree block: `checkout` and `previousBranch` are
  new optional fields. A reader that ignores them is unaffected, so no
  `schemaVersion` bump.
- `WorktreeManagementEntry` and other webview payloads: additive.
- The Sync gating change is user-visible (a PR branch loses two-way Sync), so it
  goes under **Changed** in `CHANGELOG.md`. The new field goes under **Added**.
- Docs: `docs/workflows/worktrees.md` gets a "Checkout slots" subsection under
  "Named worktrees" and an update to "Managing worktrees" for Update-from and
  the upstream comparison. Update `docs/workflows/properties-panel.md` for the
  new field.

## Tests

- `src/test/**` (WorktreeManager): an existing slot switches when clean; it is
  refused when dirty, during an in-progress merge, or when the branch is
  checked out in another slot; a bare name matches exactly one basename and
  ambiguity is an error; an unregistered existing directory is refused; a new
  slot is created at the slot path; setup is not re-run after a switch;
  continuing an older run switches the slot back; the lease is taken before the
  switch (a held lease leaves the slot untouched); `syncNamedWorktree` refuses
  PR branches.
- `WorktreeResolution` normalization: `checkout` is kept on the named object and
  rejected on the managed object.
- `src/ui/webview-react/test/**`: Checkout field round trip and reset;
  `isSyncEligible` excludes upstream-tracked branches; Update-from button; the
  upstream comparison renders.

## Open questions

- **`{{vars}}` in `branch`.** `varsConfig` substitutes only into worktree
  `setup` today. A reusable "bug-fix slot" template wants
  `branch: "{{branch}}"` with `--var branch=fix-race-condition`. Substituting
  into `branch` and `checkout` is a natural follow-up, but it changes when the
  worktree config can be validated (after var resolution). Keep it a separate
  change.
- **Auto-switch as opt-in.** Should switching need an extra
  `switch: true`, or does writing `checkout` together with a different
  `branch` already state the intent clearly? Recommendation: no extra flag.
  The clean-tree, lease and in-progress guards make the switch safe, and a
  second flag would be required in every slot workflow anyway.
- **Pushing and opening a PR.** Out of scope. ctrlyoke still never pushes
  (`shell(git push:*)` is in the default denied tools).
