# Trusted Roots Scope Refactor Plan

**Status (2026-09-02):** Proposed.

**Related plans:**

- [`ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`](../implemented/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md) —
  the user- and workspace-scope trust model this plan adds a third tier to.
  Read that plan first; this doc does not repeat its security model, only
  extends it.
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md) —
  owns making the trust-confirmation UI reachable from a browser/hosted
  client. This plan's VS Code-native approval UI is an accepted interim state,
  not a design choice to defend.

## Problem

Confirmed against the code on 2026-09-02:

1. `permissions.allowedExternalFileRoots` only has two scopes: **user**
   (`~/.ctrlyoke`-style global settings, trusted immediately) and
   **workspace** (`.ctrlyoke/settings.json`, gated by one-time batch approval
   via `ExternalRootsTrustStore`). `schemas/workflow-schema.json` has no
   external-roots concept anywhere in `executionProperties` or
   `workflowOnlyProperties`. There is no way to trust a directory for one
   workflow, or one prompt run, without widening trust for the whole
   workspace or the whole user profile.
2. The existing "Trust Parent Folder" action is broader than it looks.
   `confirmExternalFileTrust()` in `src/ui/ExternalFileTrustPrompt.ts`
   unconditionally calls `ConfigurationUtils.addUserAllowedExternalFileRoot()`
   — every accepted offer, regardless of which flow triggered it (dashboard
   output link, `PromptLinkProvider` click, or the prompt-file-open path in
   `PromptEditorSupportService.ts`), trusts the folder at **user scope**: for
   every workspace opened with ctrlyoke going forward, not just the current
   one. There is currently no scope choice in that dialog at all.

The naive fix — a `trustedExternalRoots` array a workflow file can declare —
is not safe by itself. `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`'s "Additional
Decisions (2026-07-04)" section already identifies this exact shape of attack
for workspace-scope settings: a shared/committed config that widens trust,
paired with a bundled reference that reads the now-trusted path, with no
per-file confirmation. A workflow file is at least as shareable as a
workspace config file — arguably more so, since workflow files are the thing
ctrlyoke users routinely hand to teammates or check into templates. **A
workflow declaring a root must never be sufficient, on its own, to grant
access to it.** This plan applies the workspace-scope mitigation pattern
(declare = request; a separate, explicit, persisted decision gates actual
access) to workflow scope instead of inventing a new mechanism.

## Goals

- Add a workflow-scoped trust tier: a workflow file can request specific
  external roots, but reading under them (or passing `--add-dir` to a
  harness) requires a one-time batch approval recorded against that
  workflow's identity, mirroring `ExternalRootsTrustStore`'s existing
  workspace-scope behavior.
- Fail closed: `ctrlyoke run` and the VS Code "Run" action must refuse to
  execute a workflow with pending (never-decided) requested roots, exactly
  like the existing workspace-scope gate in `cli.ts`.
- Fix the "Trust Parent Folder" dialog to ask which scope to trust into
  (user / this workspace / this workflow) instead of hardcoding user scope.
- Reuse `ExternalRootsTrustStore` and `ConfigurationUtils`'s existing
  scope-union helpers rather than building a parallel persistence mechanism.

## Non-Goals

- No per-step override of workflow-level trusted roots (see "Schema Changes"
  for why).
- No one-time/"trust just this run" grant that bypasses the persisted
  decision — that is a separate, smaller idea (see `code-review` session
  notes / prior brainstorm: "Option B — session-only trust"); it can be added
  later as an extra button on the same dialog this plan builds, not a
  replacement for the persisted workflow-scope decision.
- No change to how user- or workspace-scope roots are approved; both are
  already correct per `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`.
- Not responsible for making the approval UI work from a browser/hosted
  client — that's `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s
  `ExternalFileTrustPrompt.ts` row. The CLI command this plan adds
  (`ctrlyoke trust-workflow-external-roots`) is the working path for
  non-VS-Code and hosted-server-only usage in the meantime.

## Security Model

Three tiers, widest-to-narrowest:

| Scope | Persisted where | Grant trigger | Applies to |
| --- | --- | --- | --- |
| User | `permissions.allowedExternalFileRoots` at user config scope | Immediate — user already trusted it by editing their own settings | Every workspace this user opens |
| Workspace | `permissions.allowedExternalFileRoots` at workspace config scope | One-time batch approval, keyed by workspace identity, in `~/.ctrlyoke/external-roots-trust.json` | Every workflow run in this workspace |
| Workflow *(new)* | `trustedExternalRoots` on the workflow file itself | One-time batch approval, keyed by **workspace identity + workflow file identity**, in the same trust store | Only runs of this specific workflow file |

The effective set of readable/harness-accessible roots for a given workflow
run is the union of all three, same union pattern
`ConfigurationUtils.getEffectiveApprovedExternalFileRoots` already uses for
user+workspace.

## Schema Changes (`schemas/workflow-schema.json`)

Add to the `workflowOnlyProperties` definition (alongside `worktree`, `vars`)
— **workflow-root only, no per-step override**:

```json
"trustedExternalRoots": {
  "type": "array",
  "items": { "type": "string", "minLength": 1 },
  "description": "Absolute external directory roots this workflow requests read access to, in addition to the workspace's approved permissions.allowedExternalFileRoots. Declaring a root here only registers a request — it never grants access by itself. Before this workflow first runs (or is loaded in VS Code) with a newly declared root, a one-time batch approval is required: a VS Code prompt, or `ctrlyoke trust-workflow-external-roots <file>` for the standalone CLI. Execution fails closed until every declared root has a recorded decision for this workflow file's identity. See dev/backlog/TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md."
}
```

**Why workflow-root only, not per-step:** `workflowOnlyProperties` already
establishes this pattern for `worktree` — a property the schema explicitly
forbids on individual steps (`workflowStep`'s `not: { required: ["worktree"] }`
clause). Add the identical clause for `trustedExternalRoots`:

```json
"workflowStep": {
  "allOf": [
    { "oneOf": [{ "$ref": "#/definitions/promptStep" }, { "$ref": "#/definitions/scriptStep" }] },
    { "not": { "type": "object", "required": ["worktree"] } },
    { "not": { "type": "object", "required": ["trustedExternalRoots"] } }
  ]
}
```

**The real reason this must be root-only:** it is not that a per-step
declaration would skip the approval prompt — any new root still needs a
recorded decision before use, wherever it's declared. The reason is dynamic
queue extension. Any workflow with `mcpServers: ["ctrlyoke"]` lets the AI
append new steps to the queue at runtime (see the `mcpServers` description
in `schemas/workflow-schema.json`). If `trustedExternalRoots` could live on
a step, a step appended mid-conversation by the AI — potentially steered by
a prompt injection in file content it just read — could request trust for a
root that never existed in the workflow file a human reviewed before
clicking Run. Locking the field to the workflow root means the complete set
of roots this run could ever request is fixed and reviewable at parse time,
before execution and before any dynamic queue extension occurs; nothing that
happens during the run can add to it.

A secondary reason: `ctrlyoke run` must compute the full pending-approval
set before starting at all, to stay fail-closed the way the workspace-scope
gate in `cli.ts` already does (exit 2 before anything runs). A per-step
design would still have to walk and aggregate every step's declarations up
front to support that — making it functionally equivalent to a root-level
array for headless execution anyway, just harder to audit (a reviewer has to
check N step objects for new entries instead of one array).

A workflow that genuinely needs different external roots for different
steps declares the union at the workflow root; nothing stops individual
`@`-references from only using the subset relevant to a given step.

Run `npm run generate-schema` after editing; do not hand-edit the generated
YAML.

## Trust Store: Generalize the Identity, Not the Class

`ExternalRootsTrustStore`'s public methods already take an opaque
`workspaceIdentity: string` used only as a map-key component
(`` `${workspaceIdentity}${SEPARATOR}${canonicalRoot}` ``) — nothing in the
class actually requires that string to be a workspace root. No new store, no
schema/file-format migration, and existing workspace-scope decisions in
`~/.ctrlyoke/external-roots-trust.json` stay valid as-is. Two changes:

1. Rename the parameter `workspaceIdentity` → `scopeIdentity` for clarity
   (behavior-neutral).
2. Add a helper that composes a workflow-scope identity from the workspace
   root and the workflow's own canonical source path:

   ```ts
   static canonicalizeWorkflowIdentity(
     workspaceRoot: string,
     workflowSourcePath: string
   ): string {
     const workspaceIdentity = ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
     const workflowIdentity = ExternalRootsTrustStore.canonicalizeRoot(workflowSourcePath);
     return `workflow:${workspaceIdentity}::${workflowIdentity}`;
   }
   ```

   Prefixing with `workflow:` keeps workflow-scope keys namespace-distinct
   from workspace-scope keys (which are bare canonical workspace roots) in
   the same decisions file, so a collision between a workspace path and a
   workflow path can't alias two different decisions.

**Open question to resolve during implementation:** which path is "the
workflow's own canonical source path" for a *working file* that has already
started running (whose live copy lives under
`.runs/<workflowKey>/run-<timestamp>/workflow.ctrlyoke.json`, per the
`copilot-instructions.md` run-storage section) versus the authored
`.ctrlyoke.yaml`/`.prompt.md`/draft file a user edits? Use the authored
source (`originalFile` for working files, the parsed file path otherwise) —
identity should track the file the user reviews and edits, not an ephemeral
per-run copy, so re-running the same lineage doesn't re-trigger approval and
editing a copy under `.runs/` (which nothing should do directly) can't
silently bypass it.

`ConfigurationUtils` gains the workflow-scope equivalents of the existing
workspace-scope helpers, following the same naming and signature shape.

**Cross-scope exclusion and canonicalization, not just a new tier.** A root
the workflow declares that's already covered by a broader-scope approval
(e.g. already present in workspace-scope `permissions.allowedExternalFileRoots`)
must not trigger a redundant workflow-scope prompt — it's already granted.
`getPendingWorkflowExternalFileRoots` therefore needs `workspaceIdentity` as
well, so it can subtract `getEffectiveApprovedExternalFileRoots(workspaceIdentity)`
from the declared roots before checking for an undecided workflow-scope
entry. That subtraction — and the union inside
`getEffectiveApprovedExternalFileRoots` itself — must compare by canonical
path (`ExternalRootsTrustStore.canonicalizeRoot`), not raw string equality:
`C:\dev\codex` and `C:/dev/codex` are the same directory but different
strings. Today's implementation unions user+workspace roots with a raw-string
`Set` (`src/utils/ConfigurationUtils.ts:532-561`), so this canonicalize-
before-compare fix applies to the existing two-tier union too, not only the
new workflow tier — worth doing here since the function is already being
extended. The same requirement carries into `CliProviderUtils.getWorkspaceDirs()`'s
`--add-dir` assembly: a root approved at two scopes, or expressed with
different casing/slash style, must produce one `--add-dir` argument, not two.

```ts
getEffectiveApprovedExternalFileRoots(
  workspaceIdentity: string,
  workflowIdentity?: string,
  trustStore?: ExternalRootsTrustStoreLike
): string[]
// unions, by canonical path: user roots + approved workspace roots +
// (approved workflow roots, if workflowIdentity given)

getPendingWorkflowExternalFileRoots(
  workspaceIdentity: string,
  workflowIdentity: string,
  requestedRoots: readonly string[],
  trustStore?: ExternalRootsTrustStoreLike
): string[]
// requestedRoots comes from the parsed workflow's own trustedExternalRoots —
// unlike workspace scope, this isn't read from CtrlYokeConfigService, so the
// caller must pass the workflow's declared array explicitly. Excludes (by
// canonical path) any root already covered by
// getEffectiveApprovedExternalFileRoots(workspaceIdentity) before checking
// for an undecided workflow-scope entry.
```

## Approval Flow — VS Code

Reuse the shape of `promptBatchApprovalForPendingWorkspaceExternalRoots`
(`src/ui/ExternalFileTrustPrompt.ts`) rather than writing a second, near-
identical `showQuickPick` flow: extract a shared
`promptBatchApprovalForPendingRoots(scopeIdentity, pendingRoots, title)`
helper that both the existing workspace call site and a new
`promptBatchApprovalForPendingWorkflowExternalRoots(workspaceRoot,
workflowSourcePath, requestedRoots)` call into.

Trigger point: when a workflow/prompt file is loaded as the active workflow
in the dashboard (the same moment `WorkflowOrchestrator`/`WorkflowSerializer`
resolves a parsed file into working-file state), not on every keystroke.
Gate the "Run" action the same way the CLI gates execution below — a pending
root should block Run, not just print a warning, matching the existing
workspace-scope fail-closed behavior in `cli.ts`.

## Approval Flow — CLI

Add `ctrlyoke trust-workflow-external-roots <file>`, mirroring
`trustExternalRootsCommand` in `cli.ts` (~line 1640): parse the target
workflow file, read its `trustedExternalRoots`, compute pending roots via
`getPendingWorkflowExternalFileRoots`, print them, and record a batch
allow/deny decision. Supports `--yes` for deliberate automation, matching the
existing command's convention.

Extend the existing fail-closed gate in `cli.ts` (~line 546-570, the
workspace-scope check that already runs before `ctrlyoke run` proceeds) with
a second check: after the target workflow file is parsed, if it declares
`trustedExternalRoots`, compute the workflow identity and call
`getPendingWorkflowExternalFileRoots`; a nonempty result exits 2 with
guidance to run the new trust command, exactly like the existing workspace
message.

## Effective Roots and Harness Alignment

Once approved, workflow-scope roots flow through the exact same downstream
paths `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`'s "Harness Permission Alignment"
section already established for workspace/user roots — no new plumbing
there, only a wider input set:

- `ContextExpander`'s `trustedRoots`/`approvedExternalRoots` construction
  gains the workflow's approved roots (call sites already pass
  `ConfigurationUtils.getEffectiveApprovedExternalFileRoots(...)`; they now
  also pass the resolved workflow identity for the workflow currently
  executing).
- `CliProviderUtils.getWorkspaceDirs()`'s `--add-dir` assembly (Claude,
  Codex, Copilot, Antigravity) includes approved workflow roots the same way
  it already includes approved workspace roots. Qwen/OpenCode behavior is
  unchanged (their own trust mechanisms remain authoritative, per the
  existing plan).

## Trust Parent Folder Dialog: Add a Scope Choice

Fix the bug this plan started from: `confirmExternalFileTrust()` currently
hardcodes user scope. Change its single "Trust Parent Folder" action button
into a choice among the scopes that are actually contextually available:

- **Trust for me (all workspaces)** → today's existing behavior
  (`addUserAllowedExternalFileRoot`), kept as an explicit choice rather than
  the silent default.
- **Trust for this workspace** → write to workspace-scope
  `permissions.allowedExternalFileRoots` and record an immediate "allow" in
  `ExternalRootsTrustStore` for the workspace identity (the user is making
  the same decision the batch-approval flow would ask for, so no separate
  re-prompt is needed).
- **Trust for this workflow** *(new, only offered when the untrusted
  reference was encountered while a specific workflow file is the active
  context — e.g. clicked from within the prompt editor or workflow dashboard,
  not from an arbitrary output pane with no associated workflow)* → append to
  that workflow file's `trustedExternalRoots` and record an immediate
  "allow" for the workflow identity.

`vscode.window.showWarningMessage` supports multiple action strings, so this
can stay a modal with 3-4 buttons rather than becoming a `showQuickPick`;
keep whichever is more legible once the actual copy is drafted.

## Relationship to VS Code/Browser Decoupling

This plan's approval UI (both the batch-approval picker and the Trust Parent
Folder scope choice) is native VS Code UI, same as today. Making it reachable
from a browser/hosted client is out of scope here — see the new
`ExternalFileTrustPrompt.ts` row added to
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`. The CLI trust command
(`ctrlyoke trust-workflow-external-roots`) is not a workaround for that gap;
it is the same first-class path `trust-external-roots` already is for
non-interactive/headless workflows, and it works today regardless of when
the browser gap closes.

## Implementation Plan

### Phase 1: Schema and store

1. Add `trustedExternalRoots` to `workflowOnlyProperties`; add the
   `workflowStep` denial clause; regenerate the YAML schema.
2. Update `src/types/CtrlYokeTypes.ts`/workflow types for the new field.
3. Rename `ExternalRootsTrustStore`'s `workspaceIdentity` parameter to
   `scopeIdentity`; add `canonicalizeWorkflowIdentity`.
4. Add `ConfigurationUtils.getPendingWorkflowExternalFileRoots`, excluding
   roots already effectively approved at a broader scope, and extend
   `getEffectiveApprovedExternalFileRoots` with the optional workflow
   identity parameter. Canonicalize before dedup in both, and in the
   `--add-dir` assembly.
5. Resolve the "authored source path" open question above against
   `PromptFileParser`/`WorkflowSerializer` before writing tests that depend
   on it.

### Phase 2: CLI

1. Add the `cli.ts` fail-closed check for workflow-scope pending roots.
2. Add `trust-workflow-external-roots` command and its help text.
3. Tests: pending roots block `ctrlyoke run`; the trust command clears them;
   `--yes` automation path.

### Phase 3: VS Code UI

1. Extract the shared batch-approval helper; add the workflow-scope call
   site triggered on workflow load, gating "Run".
2. Add the scope-choice buttons to `confirmExternalFileTrust`; thread
   "current workflow file, if any" into its call sites in
   `PromptEditorSupportService.ts` and `PromptLinkProvider.ts` so "Trust for
   this workflow" can be offered where applicable and omitted where there is
   no active workflow context.
3. Settings/dashboard UI: show a workflow's requested/approved
   `trustedExternalRoots` somewhere reachable (e.g. a read-only summary near
   `AdvancedPermissionsSection.tsx`'s existing external-roots section,
   pointing at the file rather than being editable there — this field is
   authored in the workflow file, not global settings).

### Phase 4: Harness plumbing

1. Thread the resolved workflow identity into the `ContextExpander`
   construction call sites and `CliProviderUtils.getWorkspaceDirs()`.
2. Tests: a workflow-declared root that's approved is readable and reaches
   `--add-dir` for the four supporting harnesses; a pending/denied root is
   not, even if the identical path is already approved at workspace scope
   for a *different* workflow.

### Phase 5: Documentation

Document the three-tier model, the workflow-file abuse case and why it's
mitigated, and the new CLI command, alongside the existing
`ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` documentation obligations.

## Files Likely Changed

| File | Change |
| --- | --- |
| `schemas/workflow-schema.json` | Add `trustedExternalRoots` to `workflowOnlyProperties`; deny it on `workflowStep` |
| `schemas/workflow-schema.yaml` | Regenerated via `npm run generate-schema` |
| `src/config/ExternalRootsTrustStore.ts` | Rename identity parameter; add `canonicalizeWorkflowIdentity` |
| `src/utils/ConfigurationUtils.ts` | Add workflow-scope pending/effective-roots helpers |
| `src/ui/ExternalFileTrustPrompt.ts` | Extract shared batch-approval helper; add workflow-scope call site; add scope choice to `confirmExternalFileTrust` |
| `src/cli.ts` | Fail-closed check for workflow-scope pending roots; `trust-workflow-external-roots` command |
| `src/core/WorkflowOrchestrator.ts` / wherever "Run" is gated | Block Run on pending workflow-scope roots |
| `src/utils/ContextExpander.ts` | Accept/merge workflow-scope approved roots |
| `src/core/harness/shared/CliProviderUtils.ts` | Include approved workflow roots in `--add-dir` assembly |
| `src/ui/PromptEditorSupportService.ts`, `src/completions/PromptLinkProvider.ts` | Thread current-workflow context into trust dialog call sites |
| `src/ui/webview-react/components/settings/AdvancedPermissionsSection.tsx` | Optional read-only surfacing of a workflow's requested/approved roots |
| `src/test/**` | Store, `ConfigurationUtils`, CLI gate/command, `ContextExpander`, `CliProviderUtils` tests |

## Testing

- Unit: `ExternalRootsTrustStore` workflow-identity keys don't collide with
  workspace-identity keys for the same literal path string.
- Unit: `getPendingWorkflowExternalFileRoots`/`getEffectiveApprovedExternalFileRoots`
  correctly union all three scopes and correctly exclude denied/pending
  workflow roots.
- Unit: a root already approved at workspace (or user) scope, when also
  declared in a workflow's `trustedExternalRoots`, is not reported as
  pending and does not trigger a second prompt; the same root expressed with
  different casing/slash style across scopes still dedupes to one entry in
  the effective set and one `--add-dir` argument.
- Abuse-case test (the reason this plan exists): a workflow file declaring
  `trustedExternalRoots: ["<some external dir>"]` plus an `@`-reference into
  it must fail closed on first `ctrlyoke run` (CLI) and must not enable Run
  (VS Code) until an explicit batch approval is recorded — never silently
  read the file merely because the field is present.
- Regression: existing workspace- and user-scope behavior from
  `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` is unchanged for workflows that
  don't declare `trustedExternalRoots`.
- Manual: approve a workflow-scope root via the CLI command, run the
  workflow, confirm `--add-dir` on a supporting harness; deny it and confirm
  the workflow's reference is skipped with a warning instead of blocking the
  whole run (matching `ContextExpander`'s existing skip-with-warning
  behavior for untrusted references).
