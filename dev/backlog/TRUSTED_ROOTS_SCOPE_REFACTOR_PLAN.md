# Trusted Roots Scope Refactor Plan

**Status (2026-09-03):** Phase 2 complete; Phase 3 items 1-3 complete;
Phase 3 items 4-6 and Phases 4-5 remain proposed.

**Implementation note (2026-09-03):** The current schema's two existing
workflow-only denial clauses are on `workflowStep` and
`promptRuntimeMetadata` (rather than two separate workflowStep branches);
Phase 1 adds the `trustedExternalRoots` denial alongside both.

**Related plans:**

- [`ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`](../implemented/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md) —
  the user- and workspace-scope trust model this plan adds a third tier to.
  Read that plan first; this doc does not repeat its security model, only
  extends it.
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md) —
  owns the general native-vs-built-in-modal policy (decided 2026-09-02): this
  plan's approval UI is built **once**, host-neutral, from the start — there
  is no VS Code-native interim state and no separate browser-only dialog to
  build later. See "Approval Flow" and "Trust Parent Folder Dialog" below,
  which reuse the `UserInteractionPort`/`BatchApprovalModal` pattern already
  shipped for `SecretGrantsTrustPrompt.ts`.

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

- Add a workflow-scoped trust tier that can both **extend and restrict**
  access, not only extend it — **decided 2026-09-02, superseding this
  section's original additive-only framing** (see "Security Model" below).
  A workflow file can request specific external roots beyond the
  user/workspace tiers, but it can *also* declare an explicit list that
  **replaces** (not unions with) the inherited user+workspace set for that
  workflow's runs, or `null` to disable external-root access entirely for
  that workflow. Reading under any declared root still requires a one-time
  batch approval recorded against the workflow's identity, mirroring
  `ExternalRootsTrustStore`'s existing workspace-scope behavior — replace
  semantics change *what set of roots* a workflow ends up with, not whether
  each root still needs its own approval.
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
- No change to how user- or workspace-scope roots are **approved**
  (per-root batch-approval mechanics, `ExternalRootsTrustStore` shape) —
  those are already correct per `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`. This
  plan does fix one workspace-scope behavior gap (interactive UI adds not
  recording an immediate decision — see "Declared vs. approved" above),
  but that is a bug fix to an existing inconsistency, not a redesign of the
  workspace-scope approval model itself.
- Not responsible for making the approval UI work from a browser/hosted
  client — that's `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s
  `ExternalFileTrustPrompt.ts` row. The CLI command this plan adds
  (`ctrlyoke trust-workflow-external-roots`) is the working path for
  non-VS-Code and hosted-server-only usage in the meantime.

## Security Model

**Revised 2026-09-02 — this plan originally made the workflow tier
purely additive (union with user+workspace). That's wrong for the actual
motivating use case and has been corrected to override/replace semantics
below; see the design discussion this replaces at the end of this section.**

Three tiers, widest-to-narrowest, but the workflow tier now **overrides**
rather than **adds to** the tiers above it when the workflow explicitly sets
a value:

| Scope | Persisted where | Grant trigger | Resolution |
| --- | --- | --- | --- |
| User | `permissions.allowedExternalFileRoots` at user config scope | Immediate — user already trusted it by editing their own settings | Always part of the base set (see below) |
| Workspace | `permissions.allowedExternalFileRoots` at workspace config scope | One-time batch approval, keyed by workspace identity, in `~/.ctrlyoke/external-roots-trust.json` | Always part of the base set (see below) |
| Workflow *(new)* | `trustedExternalRoots` on the workflow file itself — `undefined` \| `string[]` \| `null` | One-time batch approval per declared root, keyed by **workspace identity + workflow file identity**, in the same trust store | See resolution rule below |

**Resolution rule** — this is the actual design change, driven directly by
the motivating use case (a user with a large personal library of
user-scope trusted roots wants a specific *risky* workflow to see only one
of them, or none, without shrinking their everyday default):

- `trustedExternalRoots` **omitted** (the default — every workflow that
  doesn't touch this field, including all existing workflows) → effective
  set = the live union of approved user + workspace roots, exactly today's
  behavior. Adding a new user-trusted root still grows every such
  workflow's `--add-dir` list, same as today — that's the intentional,
  unchanged default.
- `trustedExternalRoots: [...]` (an explicit array) → effective set =
  the **approved subset of exactly that list**, full stop. It **replaces**
  the user+workspace union for this workflow rather than adding to it. A
  root in this list that's already approved at a broader scope needs no
  extra approval (trusting a path once is enough); a root that isn't
  approved anywhere yet still goes through the same one-time batch-approval
  gate as before.
- `trustedExternalRoots: null` (explicit) → effective set = empty. This
  workflow gets no external-root access at all — only workspace files, and
  no external `--add-dir` arguments — regardless of how large the user's
  global trusted-roots list is. This is the "I don't want any external
  roots for this workflow" case that motivated this plan.

This is the exact same `undefined` = inherit / explicit-array = replace /
`null` = explicitly disable pattern `executionProperties.secrets` and
`executionProperties.mcpServers` already use in this schema — reusing an
established convention, not inventing a new one. The approval-gate
mechanism (declare ≠ grant; a separate persisted decision is required) is
**unchanged** by this correction — only the arithmetic that turns approved
roots into an effective set changes, from union to conditional replace.
`ConfigurationUtils.getEffectiveApprovedExternalFileRoots` gains this
branching logic; see "Trust Store" below for the updated contract.

**Why not union, revisited:** the original framing ("workflow can only ask
for *more* access") solved the sharing-abuse case but not the actual
request driving this plan — restricting a specific risky workflow to less
than the user's everyday default. A pure union can never shrink the
effective set below what user+workspace already grant, so it can't express
"only this one directory, nothing else I normally trust" or "nothing at
all." Replace-with-null-to-disable can express both, while the abuse case
this plan exists to prevent (a shared workflow file silently reading a
newly-declared path) is unaffected, because it was never about the
union-vs-replace arithmetic — it was about requiring a separate approval
before any declared root takes effect, which replace semantics still
require identically.

### Declared vs. approved — reconciled 2026-09-02, and a real existing gap

"Grant trigger" above hides an asymmetry worth stating plainly, confirmed
against the code (`ExternalRootsTrustStore.ts`, `WebviewSettingsSync.ts`):

- **User scope**: presence in the user-scope `permissions.allowedExternalFileRoots`
  array **is** the approval. `ExternalRootsTrustStore` never records a
  decision for these at all — its own doc comment says so — because editing
  your own settings already is the trust act. Revoke = delete the line.
- **Workspace scope**: presence in the workspace-scope array is only a
  *request*. The actual decision is a separate record in
  `~/.ctrlyoke/external-roots-trust.json`, written only by the batch-approval
  QuickPick or `ctrlyoke trust-external-roots`.
- **Existing gap this plan should also fix, not just replicate for the new
  tier**: `WebviewSettingsSync.handleBrowseAndAddExternalRoot` (the "Add
  folder…" button in `AdvancedPermissionsSection.tsx`) and the raw textarea
  `onUpdate` path both write *only* the workspace-scope request array —
  neither calls `ExternalRootsTrustStore.setDecisions()`. So today, manually
  adding a folder through the dashboard UI at workspace scope does **not**
  auto-approve it; the user is re-prompted by the batch-approval QuickPick
  the next time a workflow loads, identically to a root that arrived via a
  hand-edited or `git`-pulled config file. That's inconsistent with how user
  scope already treats "you just typed it yourself" as sufficient trust, and
  it's needless friction for someone who just deliberately picked a folder
  in their own native OS dialog.

**Decision: any interactive add through the dashboard UI immediately
records an "allow" decision, at whichever scope it was added.** This
applies to the existing workspace-scope textarea/"Add folder…" paths (fixed
as part of this plan, since the new workflow-scope surface would otherwise
just copy the same inconsistency) and to the new
`WorkflowPropertiesPanel.tsx` `trustedExternalRoots` field. This is safe
because the *decision* store is always personal/local
(`~/.ctrlyoke/external-roots-trust.json`, never committed) — only the
*request* list can be shared, via a committed workspace config or a shared
workflow file. A teammate who inherits that shared file still hits their
own pending-approval gate on their own machine, because their local trust
store has no decision recorded for it. The batch-approval prompt is then
correctly reserved for exactly the case it exists to guard: a root that
appears in a file this session's own UI didn't touch (hand-edited YAML,
`git pull`, a teammate's shared config).

**Missing today, needed for both the existing workspace tier and the new
workflow tier: a way to see and revoke a recorded decision.** Neither
`AdvancedPermissionsSection.tsx` nor any other surface currently shows
per-root decision status (approved/denied/pending) or lets a user flip one
without deleting-then-re-adding the request line (which only re-triggers
the prompt — it does not record "deny"). Both `AdvancedPermissionsSection.tsx`
and the new workflow-scope field should show each entry's live status
sourced from `ExternalRootsTrustStore.getDecision()`, with a control to
change it. This is scoped to workspace/workflow entries only — user-scope
entries have no separate decision to show; presence in the array already is
the full story there.

### Shared control: `TrustedRootsListEditor` — decided 2026-09-02, replaces the raw textarea

The existing `AdvancedPermissionsSection.tsx` "External File Roots" control
(a raw multi-line textarea over `permissions.allowedExternalFileRoots` —
no per-entry validation, nothing stops typing a non-path string, and no way
to see or revoke a recorded decision) is being **replaced**, not extended.
It and the new workflow-scope field share one new component,
`src/ui/webview-react/components/shared/TrustedRootsListEditor.tsx`,
modeled on `SecretsSection.tsx`'s row-list (one row per entry: path,
status, actions; an "add" affordance above the list) rather than:

- `SecretGrantsEditor`/`MultiCheckboxDropdown` — that pattern fits picking
  from a known, named registry (secrets have global names to choose from).
  External roots are arbitrary strings the user types or browses to, so a
  checkbox list doesn't apply.
- `AgentSkillsManagerSection.tsx`'s per-row multi-target flyout — that
  exists because one file can be saved to N different target directories.
  A root has exactly one path and one decision; there's no fan-out to
  model.

```ts
interface TrustedRootsListEditorProps {
  entries: { path: string; decision?: "allow" | "deny" }[];
  /** false at user scope (presence in the array already is the approval); true at workspace/workflow scope */
  showDecisionStatus: boolean;
  onAdd: (path: string) => void;
  /** posts BROWSE_AND_ADD_EXTERNAL_ROOT (extended, see below) */
  onBrowse: () => void;
  onRemove: (path: string) => void;
  /** omitted/hidden wherever showDecisionStatus is false */
  onDecisionChange?: (path: string, decision: "allow" | "deny") => void;
}
```

- **Row**: mono-font path (break-all, like `SecretRow`'s name column), a
  colored status badge (Approved / Pending / Denied) when
  `showDecisionStatus` is true, and a Delete button. This is the "see and
  revoke a recorded decision" surface flagged as missing in "Declared vs.
  approved" above — both call sites get it from one component instead of
  two bespoke ones.
- **Add flow** fixes the actual defect being replaced: the primary action
  is the existing native "Add folder…" picker (can't produce an invalid
  path by construction); the secondary is a manual path `<input>` + Add
  button for headless/paste entry, with the same tier of lightweight
  client-side validation `SecretDialog` applies to secret names — non-empty,
  trimmed, rejects obviously-not-a-path strings — not full filesystem
  verification, which still happens server-side. **Either path immediately
  calls `ExternalRootsTrustStore.setDecisions([path], "allow")`** — the
  "interactive add implies allow" rule from "Declared vs. approved" above,
  now with one concrete implementation point instead of two.
- `handleBrowseAndAddExternalRoot` (`src/ui/WebviewSettingsSync.ts`) gains
  an optional workflow-identity parameter so the same native-picker flow
  can append-and-approve into a workflow's `trustedExternalRoots` array,
  not only workspace/user `permissions.allowedExternalFileRoots`.

### UI surfaces for `trustedExternalRoots` — three, not four, and confirmed against `WorkflowDefaultsSection.tsx` 2026-09-02

1. **`WorkflowPropertiesPanel.tsx`** *(new)* — wraps `TrustedRootsListEditor`
   in the same **Inherit / None / Custom** three-state pattern already used
   throughout this file for other override-chain properties, specifically
   the worktree mode-select/seed pattern (`worktreeConfigForMode()`,
   `WorkflowPropertiesPanel.tsx` lines ~120-146, 774-807) rather than
   `SecretGrantsEditor`'s inherit-via-dropdown-label trick — that trick only
   works when "inherit" is a pickable subset of a fixed list, which a
   free-form path list is not. Position: below the existing Secrets
   section, above Allowed Tools (the Secrets block ends around line 2231;
   Allowed Tools starts at line 2243 as of 2026-09-02).
   - **Inherit** (the default/undefined state): label shows something like
     "Inherit (N roots)" resolving to the live user+workspace union;
     `TrustedRootsListEditor` is not rendered (or rendered read-only/dimmed
     as a preview) — no value is written to the workflow file.
   - **None**: writes `trustedExternalRoots: null`. `TrustedRootsListEditor`
     is not rendered. No seeding needed.
   - **Custom**: renders `TrustedRootsListEditor` bound to the explicit
     array. **When switching from Inherit to Custom, seed the editable list
     from the current live effective user+workspace set** — the same
     seed-on-mode-switch pattern `worktreeConfigForMode()` already uses for
     worktree defaults. This matters for correctness, not just convenience:
     without seeding, a user who picks "Trust for this workflow" from the ad
     hoc Trust Parent Folder dialog (see below) to add *one more* directory
     to an already-inheriting workflow would otherwise silently collapse
     that workflow down to just the one new path, stripping away everything
     it used to inherit — the opposite of what a one-off "also trust this"
     click should do.
   Adding a root through Custom mode immediately records an "allow"
   decision, via the same `onAdd`/`onBrowse` behavior described above.
2. **`AdvancedPermissionsSection.tsx`** *(replaces the raw textarea)* — the
   user/workspace-scope "External File Roots" section renders
   `TrustedRootsListEditor` directly (no Inherit/None/Custom wrapper needed
   — this *is* the base set a workflow inherits when it doesn't override).
   `showDecisionStatus` is `false` at user scope (presence in the array is
   already the full story there — `ExternalRootsTrustStore` never records a
   decision for user-scope entries) and `true` at workspace scope.
3. **`ctrlyoke trust-workflow-external-roots`** *(new CLI command, Phase 2)*
   — the non-interactive path, for headless/CI and non-VS-Code usage.

**Explicitly not `WorkflowDefaultsSection.tsx`/`DefaultsPermissionsPage.tsx`
— confirmed with the user 2026-09-02, who independently converged on the
same conclusion while reviewing this plan against `WorkflowDefaultsSection.tsx`.**
That section (and its `DefaultsHarnessPage.tsx` sibling tab) hosts the
global-settings fallback tier consulted when a workflow-level property is
undefined — `worktree` has an entry there (`defaults.worktree.*`) precisely
because nothing else applies a worktree config broadly. `trustedExternalRoots`
doesn't need that role filled a second time: `AdvancedPermissionsSection.tsx`'s
existing External File Roots section, at user *or* workspace scope, **is**
the base/inherited set now that resolution is undefined→inherit rather than
pure union — the exact same underlying `permissions.allowedExternalFileRoots`
setting that a second `WorkflowDefaultsSection.tsx` control would just edit
a second time under a different tab. There is only one global setting here;
it does double duty as both "the direct grant for every non-overriding
workflow" and "the seed value `WorkflowPropertiesPanel.tsx` copies from when
a user switches into Custom mode." Do not add a `defaults.trustedExternalRoots`
field anywhere.

## Schema Changes (`schemas/workflow-schema.json`)

Add to the `workflowOnlyProperties` definition (alongside `worktree`, `vars`)
— **workflow-root only, no per-step override**:

```json
"trustedExternalRoots": {
  "oneOf": [
    {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "description": "Absolute external directory roots this workflow is restricted to. REPLACES (does not add to) the workspace's approved permissions.allowedExternalFileRoots for this workflow's runs — a root already approved at user or workspace scope needs no separate approval, but this array is the complete set; roots trusted broadly but omitted here are not accessible to this workflow. Declaring a new root here only registers a request — it never grants access by itself. Before this workflow first runs (or is loaded in VS Code) with a newly declared root, a one-time batch approval is required: a VS Code prompt, or `ctrlyoke trust-workflow-external-roots <file>` for the standalone CLI. Execution fails closed until every declared root has a recorded decision for this workflow file's identity."
    },
    {
      "type": "null",
      "description": "Explicitly disables all external-root access for this workflow, regardless of user/workspace-scope trusted roots. Only workspace files are accessible. Use this to run a specific workflow with no external directories at all."
    }
  ],
  "description": "Restricts, extends, or disables this workflow's external-root access relative to the user/workspace defaults. Omit this field entirely to inherit the live union of approved user + workspace permissions.allowedExternalFileRoots (today's behavior, unchanged). When set, the array REPLACES that inherited union rather than adding to it — it may contain brand-new roots this workflow alone needs (widening, without growing the user/workspace list for every other workflow) and/or a deliberately narrowed subset of already-trusted roots (restricting a risky workflow to less than the everyday default); either way every root in the array still needs its own one-time approval unless already approved at a broader scope. See dev/backlog/TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md."
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

**Cross-scope exclusion still applies to *approval*, even though the
*effective-set arithmetic* is no longer a plain union (see "Security Model"
above — this was corrected 2026-09-02 from a pure additive union to
undefined→inherit / array→replace / null→disable).** A root the workflow
declares that's already covered by a broader-scope approval (e.g. already
present in workspace-scope `permissions.allowedExternalFileRoots`) must not
trigger a redundant workflow-scope prompt — trusting a path once is enough,
regardless of which scope's array happens to list it.
`getPendingWorkflowExternalFileRoots` therefore still needs
`workspaceIdentity`, so it can subtract
`getEffectiveApprovedExternalFileRoots(workspaceIdentity)` from the declared
roots before checking for an undecided workflow-scope entry. That
subtraction — and the union inside `getEffectiveApprovedExternalFileRoots`'s
own user+workspace base-set computation — must compare by canonical path
(`ExternalRootsTrustStore.canonicalizeRoot`), not raw string equality:
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
  workflow?: { identity: string; declaredRoots: string[] | null | undefined },
  trustStore?: ExternalRootsTrustStoreLike
): string[]
// Base set = union, by canonical path, of approved user roots + approved
// workspace roots (unchanged two-tier arithmetic).
// - workflow undefined, or workflow.declaredRoots === undefined:
//     return the base set as-is (inherit).
// - workflow.declaredRoots === null:
//     return [] (explicitly disabled) regardless of the base set.
// - workflow.declaredRoots is an array:
//     return the approved subset of that array only (by workflow identity
//     decisions, falling back to "already approved in the base set needs
//     no separate decision") — REPLACES the base set, does not union with it.

getPendingWorkflowExternalFileRoots(
  workspaceIdentity: string,
  workflowIdentity: string,
  requestedRoots: readonly string[],
  trustStore?: ExternalRootsTrustStoreLike
): string[]
// requestedRoots comes from the parsed workflow's own trustedExternalRoots
// array (called only when it's a non-null array — null needs no pending
// check at all, since it grants nothing) — unlike workspace scope, this
// isn't read from CtrlYokeConfigService, so the caller must pass the
// workflow's declared array explicitly. Excludes (by canonical path) any
// root already covered by getEffectiveApprovedExternalFileRoots(workspaceIdentity)
// (the two-tier base set, i.e. no workflow override) before checking for an
// undecided workflow-scope entry.
```

## Approval Flow — VS Code panel and browser (one implementation)

**Decided 2026-09-02: this is not "native now, browser later."** Build it
once, host-neutral, using the `UserInteractionPort` pattern already shipped
for workspace secret grants
(`promptBatchApprovalForPendingWorkspaceSecretGrants` in
`SecretGrantsTrustPrompt.ts`, backed by `WebviewUserInteractionPort` and the
`BatchApprovalModal.tsx` React component) — not `vscode.window.showQuickPick`.
That existing flow already has zero `vscode` import and already renders
identically in the VS Code panel and a browser-connected hosted-dashboard
client, because both are just a connected `WebviewClientContext` receiving a
`SHOW_BATCH_APPROVAL_REQUEST` message. There is no reason the workflow-root
batch approval needs a different mechanism than the workspace-root one it's
extending.

Concretely: extract a shared
`promptBatchApprovalForPendingRoots(scopeIdentity, pendingRoots, title, port)`
helper (taking a `UserInteractionPort`, exactly like
`promptBatchApprovalForPendingWorkspaceSecretGrants` already does) that both
the existing workspace call site and a new
`promptBatchApprovalForPendingWorkflowExternalRoots(workspaceRoot,
workflowSourcePath, requestedRoots, port)` call into. This also means
`promptBatchApprovalForPendingWorkspaceExternalRoots`'s existing
`vscode.window.showQuickPick` implementation gets migrated to the same port
in the same pass — it should not be left as a second, inconsistent
mechanism sitting next to the new workflow-scope one.

Trigger point: when a workflow/prompt file is loaded as the active workflow
in the dashboard (the same moment `WorkflowOrchestrator`/`WorkflowSerializer`
resolves a parsed file into working-file state), not on every keystroke.
Gate the "Run" action the same way the CLI gates execution below — a pending
root should block Run, not just print a warning, matching the existing
workspace-scope fail-closed behavior in `cli.ts`.

**Non-dashboard call sites need a panel-reveal step.** Unlike the secret-grant
flow (only triggered from dashboard-connected contexts, where a client is
already known to be present), `confirmExternalFileTrustAndOpen` — which the
single-item "Trust Parent Folder" dialog below extends — is also invoked from
`extension.ts`'s `ctrlyoke.confirmExternalFileTrust` command (driven by
`PromptLinkProvider` document-link clicks in the native editor) and, once
`TRUSTED_ROOTS_STAGING_PLAN.md` Stage 1 ships, from
`ContextMenuReferenceCommands.ts`'s four Explorer/editor context-menu
commands. Neither guarantees the ctrlyoke webview panel is open. Once the
dialog is webview-rendered only, `UserInteractionPort.canPrompt()` reflects
whether a client is connected *and* READY — if the panel was never opened,
`canPrompt()` is false and the trust offer silently does nothing, which is a
regression from today's native modal (always shown, regardless of panel
state). These two call sites must therefore reveal/focus the panel first
(reuse the existing `vscode.commands.executeCommand("ctrlyoke.openPanel")`
call already used this way at `extension.ts:1500`) and await the client's
READY handshake before requesting the prompt. The dashboard-originated call
sites in `PromptEditorSupportService.ts` need no such change — they already
have `ctx` for a connected client.

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
there, only a replace-aware input:

- `ContextExpander`'s `trustedRoots`/`approvedExternalRoots` construction
  switches to whatever `getEffectiveApprovedExternalFileRoots` resolves to
  for the executing workflow (call sites already pass
  `ConfigurationUtils.getEffectiveApprovedExternalFileRoots(...)`; they now
  also pass the resolved workflow identity and its parsed
  `trustedExternalRoots` value so the function can apply inherit/replace/
  disable rather than a flat union).
- `CliProviderUtils.getWorkspaceDirs()`'s `--add-dir` assembly (Claude,
  Codex, Copilot, Antigravity) is built from that same replace-aware result
  — an overriding workflow's `--add-dir` list reflects exactly its
  explicit array (or nothing, for `null`), not the full user+workspace set
  plus the override. Qwen/OpenCode behavior is unchanged (their own trust
  mechanisms remain authoritative, per the existing plan).

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
  not from an arbitrary output pane with no associated workflow)* → append
  to that workflow file's `trustedExternalRoots` and record an immediate
  "allow" for the workflow identity. **Must not silently narrow an
  inheriting workflow.** Because an explicit array now replaces the
  inherited user+workspace union rather than adding to it (see "Security
  Model"), this action's write depends on whether the workflow already has
  an explicit override: if `trustedExternalRoots` is currently `undefined`
  (inheriting), write the *current live effective set plus the new path*,
  not just `[newPath]` — otherwise a one-off "also trust this" click would
  unexpectedly strip away everything the workflow used to inherit. If
  `trustedExternalRoots` is already an explicit array, simply append to it.
  This is the same seed-from-current-effective-set rule the
  `WorkflowPropertiesPanel.tsx` Inherit→Custom switch uses (see "UI
  surfaces" above) — both are instances of "the first time a workflow
  becomes explicit about this field, don't lose what it used to inherit."

This is a single-select choice among 3-4 named options (plus implicit
cancel/dismiss), not a checklist — `UserInteractionPort` as it exists today
only exposes `requestBatchApproval` (a checklist). Extend the port with a
second, equally host-neutral capability, e.g.:

```ts
interface ChoiceRequest {
  id: string;
  title: string;
  detail: string;
  choices: { value: string; label: string }[];
}
// added to UserInteractionPort:
requestChoice(request: ChoiceRequest): Promise<string | undefined>;
```

implemented by `WebviewUserInteractionPort` the same way
`requestBatchApproval` is (a new `SHOW_CHOICE_REQUEST` /
`CHOICE_RESPONSE` message pair, mirroring `SHOW_BATCH_APPROVAL_REQUEST`), and
rendered by a small new React modal (or an extended `BatchApprovalModal`
single-select mode — whichever is less duplicative once written). No native
`vscode.window.showWarningMessage`/`showQuickPick` implementation is built
for this dialog; see "Relationship to VS Code/Browser Decoupling" below.

## Relationship to VS Code/Browser Decoupling

**Decided 2026-09-02 — superseding the original framing of this section.**
This plan's approval UI (both the batch-approval picker and the Trust Parent
Folder scope choice) is built once, host-neutral, using the
`UserInteractionPort` pattern above. There is no VS Code-native version to
build now and no separate browser-only dialog to build later in
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` — that plan's corrected
`ExternalFileTrustPrompt.ts` row now points back here instead of describing
a second implementation. The general policy (built-in modal by default;
native VS Code UI only for the OS file/folder picker and toast/status-bar
notifications) lives in that plan's "Decision" section. The CLI trust command
(`ctrlyoke trust-workflow-external-roots`) remains independently useful for
headless/non-interactive usage regardless of this UI's host — it is the same
first-class path `trust-external-roots` already is, not a workaround for a
browser gap that no longer exists once this section's design ships.

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
   identity **and declared-roots value** (`undefined` \| `string[]` \|
   `null`), implementing inherit/replace/disable per "Security Model"
   above — not a third unionable input. Canonicalize before dedup, and in
   the `--add-dir` assembly.
5. Resolve the "authored source path" open question above against
   `PromptFileParser`/`WorkflowSerializer` before writing tests that depend
   on it.

### Phase 2: CLI

1. ~~Add the `cli.ts` fail-closed check for workflow-scope pending roots.~~
2. ~~Add `trust-workflow-external-roots` command and its help text.~~
3. ~~Tests: pending roots block `ctrlyoke run`; the trust command clears them;
   `--yes` automation path.~~

### Phase 3: Approval UI (VS Code panel + browser, one implementation)

1. ~~Migrate `promptBatchApprovalForPendingWorkspaceExternalRoots`'s
   `showQuickPick` call to the `UserInteractionPort` pattern (matching
   `promptBatchApprovalForPendingWorkspaceSecretGrants`); extract the shared
   `promptBatchApprovalForPendingRoots` helper; add the workflow-scope call
   site triggered on workflow load, gating "Run".~~
2. ~~Add `UserInteractionPort.requestChoice` + `WebviewUserInteractionPort`
   support + the new choice modal; wire the scope-choice options into
   `confirmExternalFileTrust`; thread "current workflow file, if any" into
   its call sites in `PromptEditorSupportService.ts` and
   `PromptLinkProvider.ts` so "Trust for this workflow" can be offered where
   applicable and omitted where there is no active workflow context.~~
3. ~~Add the panel-reveal-then-await-READY step to the two non-dashboard call
   sites (`extension.ts`'s `ctrlyoke.confirmExternalFileTrust` command; the
   four `ContextMenuReferenceCommands.ts` commands once
   `TRUSTED_ROOTS_STAGING_PLAN.md` Stage 1 lands) before requesting a prompt
   through the port.~~
4. Build `TrustedRootsListEditor.tsx` (see "Shared control" above),
   including its decision-status badges, revoke control, and
   interactive-add-implies-allow behavior on both the native-picker and
   manual-path add paths. Replace `AdvancedPermissionsSection.tsx`'s raw
   textarea with it directly (`showDecisionStatus` true at workspace scope,
   false at user scope) — this also fixes the existing workspace-scope gap
   where adding via "Add folder…" or the old textarea didn't record an
   immediate decision (see "Declared vs. approved" above).
5. Add the Inherit/None/Custom-wrapped `trustedExternalRoots` field to
   `WorkflowPropertiesPanel.tsx` (below Secrets, above Allowed Tools — see
   "UI surfaces" above), rendering `TrustedRootsListEditor` in Custom mode
   with the seed-on-switch behavior. Extend
   `WebviewSettingsSync.handleBrowseAndAddExternalRoot` with the optional
   workflow-identity parameter needed for the workflow-scope "Add folder…"
   path.
6. Add `trustedExternalRoots` to `schemaUiPropertyRoundTrip.integration.test.ts`'s
   `workflowOnlyProperties` matrix (mapping it to the new field's element id,
   alongside the existing `worktree`/`vars` entries) and to
   `dev/implemented/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md` — this suite enumerates
   every `workflowOnlyProperties` schema key and fails closed if a new one
   has no mapped UI element and persistence round-trip, so this is not
   optional cleanup.

### Phase 4: Harness plumbing

1. Thread the resolved workflow identity *and* the workflow's parsed
   `trustedExternalRoots` value (`undefined` \| `string[]` \| `null`) into
   the `ContextExpander` construction call sites and
   `CliProviderUtils.getWorkspaceDirs()`, so both consume
   `getEffectiveApprovedExternalFileRoots`'s replace-aware result rather
   than a simple union of everything approved.
2. Tests: a workflow-declared root that's approved is readable and reaches
   `--add-dir` for the four supporting harnesses; a pending/denied root is
   not, even if the identical path is already approved at workspace scope
   for a *different* workflow; a workflow with an explicit
   `trustedExternalRoots` array does **not** also receive
   `--add-dir` for user/workspace roots it left out; a workflow with
   `trustedExternalRoots: null` receives no external `--add-dir` arguments
   at all, even when the user's global list is non-empty.

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
| `src/ui/ExternalFileTrustPrompt.ts` | Migrate `showQuickPick` batch-approval to `UserInteractionPort`; extract shared helper; add workflow-scope call site; add scope choice to `confirmExternalFileTrust` via `requestChoice`; add panel-reveal step to non-dashboard call sites |
| `src/ui/UserInteractionPort.ts`, `src/ui/WebviewUserInteractionPort.ts` | Add `requestChoice`/`ChoiceRequest` |
| `src/ui/webview-react/components/shared/` (new or extended modal) | Render the scope-choice dialog; reuse `BatchApprovalModal.tsx`'s plumbing where practical |
| `src/ui/webview-react/components/shared/TrustedRootsListEditor.tsx` *(new)* | Shared row-list control (path, decision-status badge, revoke, add-by-browse, add-by-manual-path with validation) — see "Shared control" above |
| `src/types/DashboardConstants.ts`, `src/types/WebviewMessageTypes.ts` | Add `SHOW_CHOICE_REQUEST`/`CHOICE_RESPONSE` message types |
| `src/cli.ts` | Fail-closed check for workflow-scope pending roots; `trust-workflow-external-roots` command |
| `src/core/WorkflowOrchestrator.ts` / wherever "Run" is gated | Block Run on pending workflow-scope roots |
| `src/utils/ContextExpander.ts` | Consume the replace-aware effective-roots result (not a simple merge) |
| `src/core/harness/shared/CliProviderUtils.ts` | Assemble `--add-dir` from the replace-aware effective-roots result |
| `src/ui/PromptEditorSupportService.ts`, `src/completions/PromptLinkProvider.ts` | Thread current-workflow context into trust dialog call sites |
| `src/ui/webview-react/components/settings/AdvancedPermissionsSection.tsx` | Replace the raw textarea with `TrustedRootsListEditor` (`showDecisionStatus` true at workspace scope, false at user scope) |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Add Inherit/None/Custom-wrapped `trustedExternalRoots` field (below Secrets, above Allowed Tools), rendering `TrustedRootsListEditor` in Custom mode with seed-on-switch |
| `src/ui/WebviewSettingsSync.ts` | `handleBrowseAndAddExternalRoot`: record an immediate "allow" decision on interactive add (not only a request), and accept an optional workflow-identity parameter for the workflow-scope add path |
| `src/test/integration/schemaUiPropertyRoundTrip.integration.test.ts` | Add `trustedExternalRoots` to the `workflowOnlyProperties` matrix |
| `src/test/**` | Store, `ConfigurationUtils`, CLI gate/command, `ContextExpander`, `CliProviderUtils` tests |

## Testing

- Unit: `ExternalRootsTrustStore` workflow-identity keys don't collide with
  workspace-identity keys for the same literal path string.
- Unit: `getEffectiveApprovedExternalFileRoots` — `trustedExternalRoots`
  omitted returns the user+workspace union unchanged (regression); an
  explicit array returns only the approved subset of that array, even when
  the user+workspace union is non-empty and disjoint from it (replace, not
  union); `null` returns `[]` regardless of a non-empty user+workspace union.
- Unit: `getPendingWorkflowExternalFileRoots` correctly excludes
  denied/pending workflow roots and does not require re-approval for a
  declared root already approved at workspace or user scope.
- Unit: a root already approved at workspace (or user) scope, when also
  declared in a workflow's explicit `trustedExternalRoots` array, is not
  reported as pending and does not trigger a second prompt; the same root
  expressed with different casing/slash style across scopes still dedupes
  to one entry in the effective set and one `--add-dir` argument.
- Abuse-case test (the reason this plan exists): a workflow file declaring
  `trustedExternalRoots: ["<some external dir>"]` plus an `@`-reference into
  it must fail closed on first `ctrlyoke run` (CLI) and must not enable Run
  (VS Code) until an explicit batch approval is recorded — never silently
  read the file merely because the field is present. This holds regardless
  of whether the declared array also overlaps with already-approved
  user/workspace roots.
- Restriction-case test (the corrected motivating use case): a user with
  several approved user-scope roots sets a specific workflow's
  `trustedExternalRoots` to a one-element array containing only one of
  them; confirm the effective set for that workflow's run is exactly that
  one root, and a second, unrelated workflow with `trustedExternalRoots`
  omitted still sees the full user+workspace union unaffected. Repeat with
  `trustedExternalRoots: null` and confirm an empty effective set.
- Seed-on-first-override test: an inheriting workflow (undefined) that gets
  one new root added via "Trust for this workflow" or the
  `WorkflowPropertiesPanel.tsx` Inherit→Custom switch ends up with an
  explicit array containing *both* everything it used to inherit *and* the
  new path — never just the new path alone.
- Regression: existing workspace- and user-scope behavior from
  `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` is unchanged for workflows that
  don't declare `trustedExternalRoots`.
- Interactive add records an immediate "allow": adding a root via
  `TrustedRootsListEditor`'s manual-path input or "Add folder…" button, in
  both its `WorkflowPropertiesPanel.tsx` (workflow scope) and
  `AdvancedPermissionsSection.tsx` (workspace scope) usages, results in
  `ExternalRootsTrustStore.getDecision()` returning `"allow"` immediately —
  no separate batch-approval prompt fires for that root afterward. A root
  that instead appears because the workflow file or workspace settings.json
  was edited outside the dashboard (or pulled via git) remains pending
  until explicitly approved. Since both surfaces share one component, this
  is effectively one behavioral test exercised through two call sites.
- Decision-status display: a root with a recorded "deny" shows as denied in
  `TrustedRootsListEditor` in both its call sites, and can be flipped back
  to allow from the UI (via `onDecisionChange`) without deleting and
  re-adding the entry. The manual-path add rejects an empty or
  obviously-not-a-path string before calling `onAdd`.
- Manual: approve a workflow-scope root via the CLI command, run the
  workflow, confirm `--add-dir` on a supporting harness; deny it and confirm
  the workflow's reference is skipped with a warning instead of blocking the
  whole run (matching `ContextExpander`'s existing skip-with-warning
  behavior for untrusted references).
- Two-tab isolation: same pattern as `CoreFeedbackMigration.test.ts:25-45`,
  adapted for `requestChoice`/the workflow batch-approval prompt — one
  connected client receives the prompt, another connected client does not.
- Manual, browser: the batch-approval picker and the Trust Parent Folder
  scope choice both render in a browser-connected hosted-dashboard client,
  not only the VS Code panel.
- Manual, panel-closed: trigger `confirmExternalFileTrustAndOpen` via a
  `PromptLinkProvider` link click (and, once available, a
  `ContextMenuReferenceCommands.ts` command) while the ctrlyoke panel is
  closed; confirm the panel opens and the dialog appears instead of silently
  no-oping.
