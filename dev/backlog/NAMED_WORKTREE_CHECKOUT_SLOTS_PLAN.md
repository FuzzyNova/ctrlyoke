# Named Worktree Checkout Slots

**Status:** Ready to implement. Written 2026-10-30; checked against the code
again on 2026-11-12 (`0e5bd6ea0`). All open questions are resolved.
**Priority:** P2

## Progress

Each implementation step ticks its item in the commit that lands it, and
records anything it found that differs from this plan under the item.

- [x] 1. Contracts: `checkout` schema field, types, normalization, `"checkout"`
      name identity, run-file format 3 → 4 (`checkout`, `previousBranch`).
      Deviation: none.
- [x] 2. Slot resolution helper (`resolveCheckoutSlot`), `switchBranch`, the
      branch-derived collision error, and Dry Run prediction
      (`previewWorktreePlacement`, `WorktreeExecutionPreview`).
      Deviation: none.
- [x] 3. `resolveNamedWorktree` with `checkout`: attach / switch / create,
      lease ordering, runtime recording, plumbing from `WorkflowInstance`.
- [x] 4. Continue resolves from the recorded run worktree; "Switched …"
      notice in the run view; workspace settings trust for path-form
      `checkout`.
      Deviation: none.
- [x] 5. Dashboard: Checkout field (properties panel, defaults page),
      switcher indicator, Dry Run lines.
      Deviation: the free-text checkout controls use native datalist
      suggestions so users can select linked slots or enter a new name/path.
- [ ] 6. Settings → Worktrees backend: `upstream` data, comparison
      classification, PR Sync refusal, `updateNamedWorktreeFromSource`.
- [ ] 7. Settings → Worktrees UI: upstream bracket, PR readiness labels,
      source drift line, Sync gating, Update from, slot label.
- [ ] 8. Docs pass (`docs/workflows/worktrees.md`, `properties-panel.md`),
      CHANGELOG check, plan moved to `dev/implemented/`.

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
  object with `mode`, `branch` (required), `base` and `setup`, plus a string
  shorthand meaning `branch`. Both object forms use `additionalProperties:
false`. `WorktreeConfig` in `src/types/CtrlYokeTypes.ts` mirrors it.
  `toWorktreeObjectConfig` in `src/utils/WorktreeConfigShape.ts` turns the
  shorthand into the object form. `normalizeDefault` in
  `src/utils/WorktreeResolution.ts` rejects an empty branch on an object
  default, and `resolveNamedWorktree` rejects an empty branch at run time.
- **Resolution** (`WorktreeManager.resolveNamedWorktree`,
  `src/core/orchestration/WorktreeManager.ts`, called from
  `WorkflowInstance.prepareExecutionWorktree`):
  1. Look in `listGitWorktrees` (the `listWorktrees` import from
     `GitUtils.ts`) for an entry with `branch` checked out. If one exists,
     attach to it, wherever it is (`origin: "discovered"`). The source
     checkout itself is refused.
  2. Otherwise create a directory under the resolved worktree root, named by
     `createWorktreeDirectoryName(branch, commonDirectory, { kind: "named",
branchRef })` (`src/utils/WorktreeUtils.ts`). The name is
     `slugifyWorktreeName(branch)` (lowercased, at most 40 characters) plus a
     12-character hash of the common Git directory and the branch. The
     directory is created with `addWorktree`, using the existing branch or
     creating it from `base`/`HEAD`. The re-check inside
     `withWorktreeMutationLock` handles a race with another creator.
  3. Ordering: creating a checkout persists the provisioning runtime **before**
     the mutation. Attaching to an existing one persists runtime only **after**
     the `exclusive-worktree` lease, so a continue that cannot get the lease
     leaves the run file's previous worktree record alone.
- **Pieces that already fit the slot model:**
  - The named setup record is keyed by **checkout path** (`recordPath(...,
executionCheckoutRoot, "named-worktrees")`), not by branch. A slot that has
    run setup once does not run it again when its branch changes.
  - The lease is `exclusive-worktree` on the execution root, so two runs (or a
    run and a terminal kept open by Reuse Running Terminal) cannot use the same
    slot.
  - Ahead/behind for the run uses `base`, or the branch's upstream when `base`
    is empty (`getBranchUpstream` in `src/utils/GitUtils.ts`).
  - Guards the switch needs already exist in `GitUtils.ts`:
    `hasUncommittedChanges` (counts untracked files, not ignored ones, so
    `node_modules` survives a switch), `hasGitOperationInProgress` (merge,
    cherry-pick, revert, rebase, sequencer), `localBranchExists`,
    `validateBranchName` and `GitWorktreeBranchCheckoutError`.
- **Named runs leave the slot dirty by design.** ctrlyoke never commits a named
  worktree (`docs/workflows/worktrees.md`, "Named worktrees"), so after a run
  the slot normally holds uncommitted work on its branch. The clean-tree guard
  below therefore fires on most attempts to move a slot to a new branch until
  the user commits (and usually pushes) the previous branch. That is the
  intended flow, and the refusal message must say how to get out of it.
- **Continue re-resolves the worktree from scratch.**
  `WorkflowInstance` (around line 2630) calls `resolveWorktreeForWorkspace`
  with the run file's own `worktree` **and the current `defaults.worktree`**,
  then `prepareExecutionWorktree` resolves the branch again. A run whose
  worktree came from the settings default follows that default as it is
  _now_, not as it was when the run started.
- **Workaround that works today.** Run `git switch -c fix-race-condition` in
  the `bug-fix` checkout by hand, then author `branch: fix-race-condition`.
  Step 1 discovers it, so the run lands in the slot.
- **Dry Run** (`ExecutionPreviewService`, around line 959) calls
  `previewWorktreePlacement` in `WorktreeUtils.ts`, a read-only copy of the
  placement rule (exact when Git already has the branch checked out, otherwise
  the deterministic best guess). Its result fills `WorktreeExecutionPreview`
  (`src/types/ExecutionPreviewTypes.ts`: `branch`, `base`, `plannedDirectory`,
  `plannedDirectoryIsExact`, `plannedDirectoryNotice`), shown by
  `DryRunModal.tsx`. (`WorktreeManager.previewExecutionWorkspace` only maps
  workspace roots once the directory is known.)
- **Settings → Worktrees** (`WorktreesSection.tsx`, `WorktreeGitStatus.tsx`)
  compares each branch only against the source checkout's branch
  (`WorktreeManagementEntry.sourceComparison`). The `divergence` line (against
  `base`/upstream) comes from the in-memory `namedDivergenceCache`, filled by a
  named run or by `refreshManagementState`, so it is session-only. **Sync** and
  **Sync All** (`isSyncEligible` in `WorktreesSection.tsx`, then
  `WorktreeManager.syncNamedWorktree` via `DashboardMessageRouter`) merge the
  branch into the source checkout's branch and back. That suits the ctrlyoke
  flow, but it puts unreviewed PR work into local `main`.
- **Workspace settings trust.** A workspace-scope `defaults.worktree` is
  trust-gated only when it has a `setup` command (`hasWorktreeSetupCommand` in
  `src/config/WorkspaceSensitiveSettings.ts`). `worktrees.root`, which chooses
  where ctrlyoke creates checkouts, is user-only
  (`WORKSPACE_FORBIDDEN_SETTING_ROOTS` in `CtrlYokeConfigService.ts`).

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
  `~`-prefixed path, or a bare name (no `/` or `\`). A relative path with
  separators is a validation error, so the meaning never depends on the
  current directory.
- Without `checkout`, behavior is exactly as today. The string shorthand keeps
  meaning `branch`.
- Not legal in managed mode. The managed object keeps
  `additionalProperties: false` without it.
- **No workflow schema bump.** This is an additive optional property. An
  older ctrlyoke does not silently ignore it, which is the case "Changing the
  schemas" in `CONTRIBUTING.md` says needs a bump. It rejects the file instead:
  the named object is closed with `additionalProperties: false`, and
  `PromptFileParser`'s relaxed validator relaxes only
  `unevaluatedProperties`, so the error is a hard one. Run
  `npm run schema:update`. Keep the field's behavior in its schema
  `description`, which feeds the reference docs and IntelliSense hovers.
- `branch` stays required. A slot workflow must say which branch it runs on.

Field name: `checkout` matches the existing vocabulary (`sourceCheckoutRoot`,
`executionCheckoutRoot`) and reads naturally next to `branch`. Rejected
alternatives: `path` (implies an absolute path only) and `slot` (jargon the docs
would have to define first). `worktree` is also out: `worktree.worktree` reads
badly.

### Resolving `checkout`

Add one read-only helper, `resolveCheckoutSlot(sourceCheckoutRoot, checkout,
entries, commonDirectory, root)`, in `WorktreeUtils.ts`. Both
`resolveNamedWorktree` and `previewWorktreePlacement` use it, so the Dry Run
answer and the real run cannot drift apart. It returns either an existing
registered worktree entry or a planned path for a new slot:

1. **Path form:** expand `~`, then normalize. The path must be either a
   `listGitWorktrees(sourceCheckoutRoot)` entry (compared with `pathsEqual`) or
   a path that does not exist yet (the slot will be created there). An existing
   directory that is not a registered worktree of this repository is an error.
   ctrlyoke never adopts an arbitrary folder. A path whose admin entry is
   prunable (directory gone) is an error that points at **Repair** / **Prune**
   in Settings → Worktrees.
2. **Bare-name form:** match registered linked worktrees whose directory
   basename is any of:
   - the name exactly (a user-created `git worktree add ../repo.worktrees/bug-fix`);
   - `createWorktreeDirectoryName(name, commonDirectory, { kind: "checkout",
name })`, the directory a bare-name slot gets when ctrlyoke creates it;
   - `createWorktreeDirectoryName(name, commonDirectory, { kind: "named",
branchRef: name })`, the directory today's ctrlyoke already created for a
     branch with that name. This makes an existing `small-feature-<hash>`
     checkout usable as slot `small-feature` without moving it.

   Exactly one match is required. With no match, the target is a new slot at
   `<root>/<slug(name)>-<hash>` using the `"checkout"` identity. With more than
   one, the error lists the candidates and asks for a path.

3. The source checkout is never a valid slot (same rule as today).

New `WorktreeNameIdentity` member: `{ kind: "checkout"; name: string }`, hashed
as `checkout:<name>` so it can never equal a branch identity. Add the constant
beside `WORKTREE_MODES` in `DashboardConstants.ts`, not as an inline string.
Reuse is made safe by Git registration (rule 1/2), not by the hash.

Example: on the maintainer's machine `git worktree list` shows
`…/ctrlyoke.worktrees/mac-bug-fix [mac-bug-fix]`, so `checkout: mac-bug-fix`
resolves to it through the exact-basename rule.

### Resolution order with `checkout` set

In `resolveNamedWorktree`, after `validateBranchName(branch)` and before any
mutation:

1. **Branch already checked out somewhere.** If that worktree is the resolved
   slot, attach as today. If it is the source checkout, keep today's error. If
   it is a different worktree, fail: `Branch "fix-race-condition" is checked
out in "<path>", not in checkout "bug-fix".` Never silently use another
   slot. (Git would refuse the switch anyway.)
2. **Slot exists, holds another branch (or is detached).**
   - Acquire the slot's `exclusive-worktree` lease **before** touching it, and
     persist runtime only after the lease, matching today's attach ordering. A
     run that cannot get the lease changes nothing, in Git or in the run file.
   - Then, under `withWorktreeMutationLock`, re-read `listGitWorktrees` (the
     branch may have been checked out elsewhere meanwhile) and check, in this
     order:
     - `hasGitOperationInProgress(slot)`: refuse, naming the operation's slot.
     - `hasUncommittedChanges(slot)`: refuse with `Checkout "bug-fix" has
uncommitted changes on branch "<current>". Commit or stash them, then
run again.` ctrlyoke never stashes, discards or carries changes across.
     - the slot's current branch has a managed-worktree ownership record
       (`readRecords(commonDirectory)`, the same check `syncNamedWorktree`
       makes): refuse. A managed run's checkout is never a slot.
   - Switch: `git switch <branch>` if `localBranchExists`, otherwise
     `git switch -c <branch> <capturedBase>`. Add a `switchBranch(dir, branch,
{ createFrom? })` helper in `GitUtils.ts` beside `addWorktree`, with the
     mutation timeout. Never pass `--force`/`--discard-changes`. Always create
     with `--no-track`. `base: origin/main` would otherwise set the new
     branch's upstream to `origin/main` (Git's `branch.autoSetupMerge`), and
     the Settings → Worktrees status below would then treat an unpushed branch
     as a PR branch measured against `origin/main`. The upstream should appear
     only when the user pushes with `-u`. `capturedBase` is already a resolved
     commit, which does not set tracking, but pass `--no-track` anyway so the
     rule does not depend on that.
   - Record `checkout` (the authored value) and `previousBranch` (absent when
     the slot was detached) in the runtime. The run view uses them to say
     "Switched bug-fix from `bug-fix` to `fix-race-condition`".
   - Release the lease on any refusal or switch failure. `origin` is
     `"discovered"` (ctrlyoke did not create the checkout).
3. **Slot does not exist.** Create it with `addWorktree` at the slot path
   instead of a branch-derived path, checking out or creating `branch`
   directly, then run setup. This is today's provisioning path, with the path
   from `resolveCheckoutSlot`, so runtime is persisted before the mutation and
   the race re-check stays.

ctrlyoke never switches a slot back after a run. The branch stays checked out
so the user can push it.

**Branch-derived path collides with a slot.** Without `checkout`, today's rule
can compute a path that already exists as a slot holding another branch (a slot
created as `small-feature-<hash>` and later switched). `addWorktree` then fails
with Git's "already exists". Catch that case before calling `addWorktree`: if
the derived path is a registered worktree on another branch, fail with
`"<path>" now holds branch "<other>". Add checkout: <basename> to run
"<branch>" in it.`

**Continuing an older run.** The run file's `_runtime.worktree` block records
the branch and path. When a run is continued after its slot has moved to another
branch, resolution runs again and step 2 switches the slot back if it is clean,
or refuses with the dirty-slot message. That is the correct outcome, but it is
a visible mutation. The continue flow shows the same "Switched …" notice, and
the Dry Run modal predicts it.

Continue must resolve from what the run **recorded**, not from today's
defaults. Today continue re-reads the current `defaults.worktree` (see "How
things work today"). With slots, a changed default would move an old run's
follow-up onto whatever branch the default names now. Rule: when the run file
has a named `_runtime.worktree` with `checkout` set, continue resolves with
`checkout = executionCheckoutRoot` (path form) and `branch = branchName` from
that block. The authored or default `worktree` is consulted only to detect that
it was turned off (`false`), which keeps today's
`abandonActiveWorktree` path. This also keeps continue correct once `branch`
accepts `{{vars}}` (see
[FULL_VAR_SUBSTITUTION_SUPPORT.md](FULL_VAR_SUBSTITUTION_SUPPORT.md)): the
recorded, already-substituted branch is reused rather than substituted again
with different values.

### Setup

No change: the setup record is already keyed by checkout path. A branch switch
does not re-run setup. If a project needs a per-branch step (for example
reinstalling after a lockfile change), that belongs in a pre-condition or script
step, not in `setup`. The schema description for `setup` says so for `checkout`.

### Workspace settings trust

A workspace-scope `defaults.worktree` with a **path-form** `checkout` chooses
where ctrlyoke creates a checkout, which `worktrees.root` reserves for user
scope. Extend the `DEFAULTS_WORKTREE` descriptor in
`WorkspaceSensitiveSettings.ts`: `isSensitive` is true for a `setup` command
**or** a path-form `checkout`. `isCoveredByUser` compares both the setup
command and the path-form checkout with the user value. Update
`summarizeWorktreeSetup` so the approval prompt shows the path. A bare-name
`checkout` resolves only among registered worktrees or under the user's own
root, so it applies without asking, like `branch` today. Update the
`defaults.worktree` description in `schemas/settings-schema.json` to match.

### Dashboard: workflow properties

`WorkflowPropertiesPanel.tsx` (named section, under the Worktree row):

- Add a **Checkout** field above Branch. It is a combobox listing the linked
  worktrees from `settingsStore.worktreeManagement` (excluding the source
  checkout and `ownership: "managed"` entries) by basename, plus free text for
  a new slot name or path. Empty means "derive from the branch" (today's
  behavior).
- Branch description: "Existing or new local Git branch. With a checkout set,
  it can differ from the checkout's name; ctrlyoke switches the checkout to it
  when the checkout is clean."
- Add `"checkout"` to the `WorktreeField` union. Carry it in
  `handleWorktreeFieldChange` (its explicit `currentConfig` object would drop
  it otherwise), in the reset/seed path (around line 924), and in the
  `normalize` inside `isDifferentFromGlobal`. Omit the key rather than writing
  `checkout: ""`.
- Same in `DefaultsHarnessPage.tsx` (`updateWorktreeField`'s field union and
  the named section). Add the description to `worktreeSettingDescription` in
  `settingsCatalog.ts`.
- `WorkflowSwitcher.tsx`'s worktree indicator shows `checkout → branch` when
  `checkout` is set.
- Dry Run: add `checkout?`, `checkoutCurrentBranch?` and `switchBlocker?` to
  `WorktreeExecutionPreview`. `previewWorktreePlacement` gets the `checkout`
  input, and uses `resolveCheckoutSlot` plus the read-only guards
  (`currentBranch`, `hasUncommittedChanges`, `hasGitOperationInProgress`).
  `DryRunModal.tsx` shows "Will switch from `<current>`", "Will create
  checkout at …", or the blocker.

### Settings → Worktrees: the PR flow

1. **Upstream comparison.** Today every row's posh-git bracket
   (`WorktreeGitStatus.tsx`), its readiness label ("Ready to merge", "Behind
   main", from `resolveWorktreeMergeReadiness` in
   `src/ui/webview-react/utils/worktreeStatus.ts`) and its tooltip
   (`describeWorktreeStatus`) all use `sourceComparison`, which is
   hard-coded to the source checkout's branch. The component's doc comment
   says so on purpose: Sync merges into that branch. The only upstream-aware
   piece is the separate `divergence` line, which is session-only. Nothing
   accounts for a pushed branch yet.
   - **Data.** Add `upstream?: { label: string; gone: boolean; ahead?: number;
behind?: number }` to `WorktreeManagementEntry` (both the
     `WorktreeManager.ts` interface and its mirror in `WebviewMessageTypes.ts`).
     Compute it in `getManagementStateIn` in the same failure-tolerant
     `Promise.all` as `sourceComparison`. Read `%(upstream:short)` and
     `%(upstream:track)` with one `for-each-ref`, extending `getBranchUpstream`
     or adding a sibling helper. `[gone]` means the upstream is configured but
     the remote branch was deleted, usually because the PR merged. Counts
     come from `getAheadBehind` against the upstream ref, and are absent when
     the upstream is gone.
   - **Classification.** One shared helper in `src/utils/` returns each row's
     comparison kind. The dashboard and `syncNamedWorktree` both use it (see 2):
     - `pr`: the upstream exists (or is gone) and is neither the source branch
       nor the source branch's own upstream. So `origin/main` for a
       `main` source checkout does **not** make a branch a PR branch.
     - `local`: no upstream (today's ctrlyoke flow), or an upstream that is the
       source branch or its upstream.
   - **Bracket (posh-git semantics).** For `pr` rows the arrows compare against
     the upstream, as posh-git itself does: `[fix-race-condition ↑2 …]`
     means two unpushed commits, `≡` means pushed and in sync, and `×`
     means the upstream is gone. For `local` rows the bracket stays exactly as
     today. The tooltip names what the arrows compare against in both cases
     ("2 commits not pushed to origin/fix-race-condition").
   - **Readiness label.** For `pr` rows, "Ready to merge" and "Behind main"
     describe the wrong action, because the merge happens in the PR.
     `resolveWorktreeMergeReadiness` takes the comparison kind and, for `pr`,
     returns new `WORKTREE_MERGE_READINESS` values:
     - "Unpushed commits" when ahead of the upstream;
     - "Behind `<upstream>`" when behind it;
     - "Pushed" when in sync;
     - "Upstream gone" when the remote branch was deleted. This is the cue that
       the slot can move to its next branch.
       Conflicted and uncommitted keep priority over all of these, as today. Add
       display entries to `READINESS_DISPLAY`.
   - **Source branch drift.** A PR branch still needs to know how far `main` has
     moved, because that is when to use **Update from** (see 2). For `pr` rows,
     render `sourceComparison.behind` as a muted line under the bracket
     ("12 behind main") and omit it when it is 0. `sourceComparison` itself is
     still computed for every row.
   - **Decision:** `divergence` and `namedDivergenceCache` stay only for the
     explicit-`base` case, where the comparison base is not the upstream and
     cannot be recomputed from Git alone. `refreshManagementState`'s upstream
     loop is dropped, because `upstream` replaces it. Do not render
     `divergence` when its label equals the upstream label.
   - Tests (`src/ui/webview-react/test/**`): bracket, tooltip and readiness for
     the `local`, `pr`, `pr` + gone and `origin/main`-tracking cases.
2. **Sync gating.** A row classified `pr` (see 1) is a PR branch. Two-way Sync
   would merge it into local `main`.
   - Exclude it from `isSyncEligible` (the row's **Sync** and **Sync All**), and
     repeat the check server-side in `syncNamedWorktree`, since the webview is
     not the only caller. Both sides use the classification helper from 1.
   - Offer **Update from `<source branch>`** instead: a one-way merge of the
     source branch into the worktree's branch. Extract the second half of
     `syncNamedWorktree` (`guardedSyncMerge` into the worktree, behind the
     same live-lease, managed-record and detached-HEAD checks) into
     `updateNamedWorktreeFromSource`. Add a `MESSAGE_TYPES` entry beside
     `SYNC_NAMED_WORKTREE` and route it in `DashboardMessageRouter`. It needs
     no source-checkout lease, because the source checkout is only read.
   - Branches with no upstream (today's ctrlyoke flow) keep Sync unchanged.
3. **Slot label.** When a worktree's directory basename (minus a ctrlyoke hash
   suffix) differs from its branch, show both (`bug-fix · fix-race-condition`),
   so the slot and its current work are readable at a glance.

## Compatibility checklist

- **Workflow schema:** additive optional property, so no bump (reasoning
  under "Schema"). Run `npm run schema:update`.
- **Settings schema:** `defaults.worktree` `$ref`s `worktreeConfig`, so it picks
  up `checkout` automatically. Its description changes for the trust rule.
- **Run file `_runtime.worktree`: bump the run-file format (3 → 4).** The plan
  first assumed new optional fields were free. They are not: the runtime block
  is `additionalProperties: false`, which the relaxed validator does not relax,
  so ctrlyoke 0.2.x opening a run that holds `checkout`/`previousBranch` would
  fail schema validation instead of showing the "written by a newer ctrlyoke"
  read-only notice. Follow the `noTurnStarted` precedent (`0ade66c9a`): bump
  `CURRENT_SCHEMA_VERSIONS[RUN_FILE]` in `PersistedSchemaGuard.ts`, add a no-op
  `from: 3` migration in `FormatMigrations.ts` ("Record the checkout slot and
  previous branch"), and add both fields to `runtimeMetadata.worktree`,
  `WorkingFileWorktreeRuntime` and, for the run view, `WorktreeRunProjection` /
  `projectWorktreeRuntime`.
- `WorktreeManagementEntry`, `WorktreeExecutionPreview` and other webview
  payloads: additive. The new message type is additive.
- The Sync gating change is user-visible (a PR branch loses two-way Sync), so it
  goes under **Changed** in `CHANGELOG.md`, along with the stricter trust rule
  and the clearer error for a branch-derived path that is now a slot. The new
  field, Update from and the upstream comparison go under **Added**.
- Docs: `docs/workflows/worktrees.md` gets a "Checkout slots" subsection under
  "Named worktrees" (including commit-before-switch and the setup-per-slot
  note) and an update to "Managing worktrees" for Update from and the upstream
  comparison. Update `docs/workflows/properties-panel.md` for the new field.

## Tests

- `src/test/**` (WorktreeManager), using real temporary repositories like the
  existing worktree tests:
  - An existing clean slot switches to an existing branch, and to a new branch
    created from `base`.
  - A dirty slot (tracked change, and untracked file) is refused. So is a slot
    with a merge in progress, a slot holding a managed branch, and a branch
    checked out in another slot.
  - A held lease leaves the slot's branch and the run file untouched.
  - Bare name: matches an exact basename, a `"checkout"`-hash basename and a
    `"named"`-hash basename. Two matches is an error. No match creates
    `<root>/<slug>-<hash>`.
  - An unregistered existing directory is refused, and a relative path is
    refused.
  - Setup is not re-run after a switch.
  - Continuing an older run switches the slot back, and uses the recorded
    branch even after `defaults.worktree` changed.
  - The branch-derived path colliding with a slot gives the new error.
  - `syncNamedWorktree` refuses PR branches.
  - `updateNamedWorktreeFromSource` merges one way and leaves the source branch
    unchanged.
- `previewWorktreePlacement`: predicts the switch, the blocker and the new slot
  path, with the same matches as the real resolver.
- `WorkspaceSensitiveSettings`: a path-form `checkout` is sensitive and a bare
  name is not.
- Run-file migration: a v3 run file reads, and a v4 file is read-only for a
  v3 reader (the existing `PersistedSchemaGuard` fixtures pattern).
- `WorktreeResolution` / schema: `checkout` is kept on the named object and
  rejected on the managed object.
- `src/ui/webview-react/test/**`: Checkout field round trip and reset (the key
  is omitted when empty), `isSyncEligible` excludes upstream-tracked branches,
  the Update from button, the slot label, the upstream bracket and PR readiness
  labels (item 1), and the Dry Run switch line.

## Resolved questions

- **`{{vars}}` in `branch` and `checkout`.** Resolved: yes. Variable
  substitution is extended to (nearly) every workflow field in a separate
  change, [FULL_VAR_SUBSTITUTION_SUPPORT.md](FULL_VAR_SUBSTITUTION_SUPPORT.md),
  which covers `worktree.branch`, `worktree.base` and `worktree.checkout`. A
  reusable "bug-fix slot" workflow then writes `branch: "{{branch}}"` and runs
  with `--var branch=fix-race-condition`. This plan does not depend on it and
  can land first. The one thing it must do now is make continue use the
  recorded branch (above), which that plan relies on.
- **Auto-switch as opt-in.** Resolved: no `switch: true` flag. Writing
  `checkout` together with a different `branch` states the intent. The
  clean-tree, lease and in-progress guards make the switch safe, and a second
  flag would be needed in every slot workflow anyway.
- **Pushing and opening a PR.** Resolved: out of scope. ctrlyoke still never
  pushes (`shell(git push:*)` is in the default denied tools).
