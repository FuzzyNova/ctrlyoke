# Dry Run Mutation Timeline Plan

**Status:** Steps 1–4 complete — steps 5–6 pending
**Priority:** P2

Follow-up to [`DRY_RUN_PREVIEW_PLAN.md`](DRY_RUN_PREVIEW_PLAN.md) (Implemented).
That plan shipped a flat "workspace mutations" list in the Overview and per-step
Summary tabs. This plan started as a redesign of that one section into an
execution timeline; its scope has broadened to general redesign decisions for
the shipped `DryRunModal`, tab by tab, while keeping the original filename for
continuity. Sections are added per tab as they're worked through — Summary/
Overview (the timeline), Payload, and the tab bar itself (order, icons,
number formatting) are covered below; Command and Conditions tab *content*
are still to come.

## Implementation Sequencing

Every section below eventually edits `DryRunModal.tsx` — the timeline
rendering, the file-reference layout, the tab order/icons, and the
byte/token formatting call sites all land in that one file. Splitting
implementation therefore has to split along real dependency lines, not by
section, or a later step can't compile against types an earlier one hasn't
added yet. Steps must run **sequentially, never concurrently**: steps 4–6
all edit `DryRunModal.tsx` and would conflict if overlapped.

1. **✅ Mutation scope/ownedKeys (backend) — complete.** `WorkspaceMutationPreview.scope`
   + optional `path`/`warning` (`ExecutionPreviewTypes.ts`),
   `PreparedMutation.ownedKeys`, `ExecutionPreviewService.toWorkspaceMutation`
   classification, `ExecutionPlanBuilder`'s directory-scoped cleanup path,
   `QwenCliProvider`'s explicit `ownedKeys`.
2. **✅ Payload backend.** `PREVIEW_PROMPT_CATEGORY_LABELS` +
   `PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE` (`DashboardConstants.ts`),
   `CliPromptPreparer`'s prior-context placeholder section,
   `resolvePriorContextItems` wiring (`WorkflowOrchestrator.ts`, `cli.ts`),
   `CliTerminalFormatter`'s three-way `delivery` ternary and shared labels.
3. **✅ Shared UI primitives, no `DryRunModal.tsx` edits.** `formatMagnitude`,
   `buildStepTimeline` + `StepTimelineEntry`, `getPermissionModeBadge`,
   the `TabIconOverride` badge fields, `SegmentedTabBar`'s badge rendering.
4. **✅ `DryRunModal` timeline rendering — complete.** Per-step Summary and
   Overview now render the pure payload → mutation → command timeline in
   execution order, grouped by step in the Overview. Consecutive run-local
   mutations collapse into an expandable local summary; shared mutations keep
   warning styling and merge-key details. Payload and command anchors switch
   tabs in place, selecting the step first when launched from Overview.
5. **`DryRunModal` Payload tab** — file-reference branch, category labels,
   corrected delivery copy, `not-yet-available` placeholder rendering.
6. **`DryRunModal` tab bar and formatting** — tab order, Conditions/Summary
   icons, Summary/Command badges, `formatCount` → `formatMagnitude` call
   sites, and the `EditorSection` refactor onto the shared formatter.

Step 3 landed with shared UI primitives only: magnitude formatting, a pure
payload → mutation → command timeline builder, permission-mode badge styling,
and corner-badge rendering in `SegmentedTabBar`. Step 4 consumed the timeline
builder in `DryRunModal.tsx` without changing the tab definitions or the
Payload/Command tab content; those remain for steps 5–6.

Step 2 landed with one implementation correction: the timeline-backed prior
context callback is shared by `WorkflowInstance`, the dashboard preview, and
CLI dry runs through `createPriorContextResolver`. The dashboard derives its
history manifest from the addressed run (not the active instance), while CLI
dry runs derive it only when the input is a promoted run file; drafts and
ordinary workflow files return no history. An unresolved prior-context
reference therefore gets a preview-only placeholder section and does not add a
temp file, planned file, mutation, or context reference.

Steps 1–3 are mutually independent and could be reordered; 4–6 each depend
on 3 (and 4/5 on 1/2 respectively for the fields they render).

### Placement corrections (verified against the current tree)

- **`formatMagnitude` goes in the existing
  `src/ui/webview-react/utils/number.ts`**, not a new `formatting.ts`. That
  file already exists and is already documented as "Numeric utility
  functions" (it currently holds only `clamp`) — adding a second numeric
  util module beside it would be the duplication this plan is trying to
  remove.
- **`buildStepTimeline` and `StepTimelineEntry` go in a new
  `src/ui/webview-react/utils/dryRunTimeline.ts`**, not
  `utils/executionPreview.ts`. Despite its name that file is not a home for
  "the other preview helpers" — it contains exactly one function,
  `getExecutionPreviewEditorSnapshot`, which captures unsaved editor state
  for the preview *request*. It reaches into `useEditorStore`/
  `useWorkflowStore`; a pure DTO→view-model function does not belong beside
  it.
- **The file-reference basename is derived client-side from
  `section.path`**, not added to the DTO. `CategorizedPromptSectionPreview`
  already carries the full absolute path, so a `basename` field would be
  redundant state that can disagree with `path`. Derive it in the modal
  (split on both `/` and `\` — preview paths are produced on the host OS and
  the dashboard also runs in a browser, so `path.basename` is unavailable
  and a platform-specific separator assumption would break).
  `CliPromptPreparer` therefore needs **no** change for the basename; its
  only Payload-tab change is the prior-context placeholder.

## Problem

The current `DryRunModal` Overview and per-step Summary tabs render
`WorkspaceMutationPreview[]` as a flat, undifferentiated list
(`MutationList` in `DryRunModal.tsx`, built by
`ExecutionPreviewService.toWorkspaceMutation`). Concretely:

- **Fake path placeholder duplicates the operation label.** `toWorkspaceMutation`
  sets `path: mutation.path ?? "(process-local)"` and separately
  `operation: isProcessLocal ? "process-local" : "write-or-update"`. Rendered
  together this reads as `(process-local) process-local`.
- **"process-local" is derived from path-presence, not from what actually
  happens.** `ExecutionPlanBuilder`'s "Remove previous prompt hook artifacts"
  mutation deletes real files under `.ctrlyoke/temp` (it loops over multiple
  paths, so it has no single `path` field) and gets the same "process-local"
  label as `OpenCodeCliProvider`'s genuinely in-memory
  `this.pendingUserHooksEnv = ...` mutation, which never touches disk.
- **The warning-colored "Workspace-wide side effect" line is applied to every
  mutation that has *any* path**, regardless of what kind of path. Compare
  `ClaudeCliProvider.createHookSettingsMutation` (writes
  `.ctrlyoke/temp/claude-hook-settings-*.json` — per-prompt, gitignored by
  ctrlyoke's own installed `.gitignore`, deleted by
  `cleanupPreviousPromptHooks` before the next prompt, invisible to any other
  session) against `QwenCliProvider.registerHooksInSettings` (merges into
  `.qwen/settings.json` — a real, persistent, ref-counted shared config file
  another concurrent workflow or the user's own edits could collide with).
  Only the second is what the warning styling exists for; today both render
  identically.
- **Categorized prompt/context temp files never appear in this list at all.**
  `CliPromptPreparer.createCategorizedPromptPlan`'s own mutations are never
  merged into `ExecutionPlan.mutations` — they surface only as
  `promptPlan.promptPreview.sections`, shown with full content in the Payload
  tab. That's the right home for them, but the mutation list gives no hint
  that's where they went, so it reads as arbitrarily incomplete.
- **"Owned keys" is wired to the wrong case.**
  `ExecutionPreviewService.extractOwnedKeys` parses `mutation.intendedContent`
  and lists its top-level keys. That question — "which keys does this
  mutation touch in a file it doesn't fully own" — only matters for a partial
  merge into a *shared* file, i.e. exactly the Qwen `.qwen/settings.json`
  case. But that mutation never sets `intendedContent` (the merge happens
  inside `SettingsJsonHooksTracker.registerWorkflow`, not as a precomputed
  string), so `ownedKeys` comes back empty exactly where it would matter.
  Meanwhile Claude's full-file `.ctrlyoke/temp` writes populate `["hooks"]`
  even though ctrlyoke owns the entire file, so the label says nothing useful
  there either.

## Decision: the list is a timeline, not a bag — keep it chronological

`ExecutionPlanBuilder.plan()` pushes mutations in true execution order:
provider preparation mutations, then hook cleanup, then the new hook
settings write, then the permission mutation. `DryRunModal` already renders
`step.workspaceMutations` in that array order with no re-sorting. **Grouping
entries by scope (as considered in the prior discussion) would destroy that
ordering and is rejected.** Scope is expressed through styling only (muted
vs. prominent), never through regrouping or reordering.

This generalizes further once payload preparation and command dispatch are
brought into the same view. Verified against `CliIntegration`:

- `initializeExecutionSession()` calls `promptPreparer.preparePrompt(...)` —
  this is where the categorized payload temp files are actually written.
- `runExecutionSession()` calls `initializeExecutionSession()` first (or
  reuses an already-prepared session), *then* calls
  `executionPlanBuilder.plan(session)` — this is where every
  `WorkspaceMutationPreview` originates.
- The resolved command is dispatched only after `plan()` returns.

So for a prompt step, `[payload prepared] → [mutations, in existing order] →
[command dispatched]` is a structurally guaranteed sequence, not a modeling
choice. The timeline is this same sequence made visible, per step, with the
existing mutation entries as its middle segment.

For a script step, `ExecutionPreviewService.buildStepPreview` returns
`workspaceMutations: []` unconditionally and only a `command` — the timeline
for a script step is command-only.

## Design

### Naming: "Timeline", not "events"

The container renamed from "Workspace mutations" — it now holds payload and
command entries too, not just mutations. **"Timeline," not "Step events" or
"Step Sequence."** `events.jsonl` (`run-<timestamp>/events.jsonl`, documented
in `.github/copilot-instructions.md`) already means something specific and
different in this codebase: the per-step *output* chunks captured from an
already-executed run. A dry run is the opposite of that — nothing has
happened yet — so naming this section "events" would collide with an
established term for real captured output right when a user could plausibly
have both a dry run and a run's output history open. "Timeline" carries no
such collision and matches the word this plan (and the prior discussion)
already converged on.

Headings, matching the existing `Workflow <noun>` pattern already used by
`OverviewPanel` ("Workflow summary", "Workflow diagnostics"):

- Per-step Summary tab (already scoped to one step by the tab context):
  **"Timeline"**.
- Overview tab (spans every step): **"Workflow timeline"**, replacing
  "Workspace mutations across all steps".

`WorkspaceMutationPreview` and `scope` remain the internal/type-level names
— "mutation" is still the accurate term for that one entry kind. Only the
user-facing container name changes.

### Timeline entries

Two new entry kinds join the existing mutation entry, both derived
**client-side from fields the DTO already carries** — no new backend fields
for these two:

```typescript
type StepTimelineEntry =
  | { kind: "payload"; fileCount: number; totalByteCount: number }
  | { kind: "mutation"; mutation: WorkspaceMutationPreview }
  | { kind: "command"; cwd: string; executable: string };
```

- **Payload entry**: derived from `step.prompt.sections`, counting every
  section except `category === "file-reference"` (Tier 1 references are
  paths the harness reads directly — ctrlyoke never writes them, per
  `DRY_RUN_PREVIEW_PLAN.md`'s Tier 1 rules). Shows a file count and total
  byte count, and links to that step's Payload tab. Omitted when there are
  zero qualifying sections.
- **Command entry**: `{ cwd: command.cwd, executable: command.executable }`
  from the step's existing `CommandPreview`. **Deliberately excludes `args`.**
  Showing a "simplified" rendering of the full command would be a second,
  lower-fidelity command builder living beside the real one — exactly what
  `DRY_RUN_PREVIEW_PLAN.md`'s Product Decision already forbids ("must not
  maintain a simplified second command builder"). cwd + executable is an
  identity fact, not a partial re-derivation of `args`/`displayCommand`; the
  entry links to the Command tab for anything beyond that. Omitted when the
  step has no command (should not happen in practice, but mirrors the
  existing optional `step.command`).
- **Mutation entry**: existing `WorkspaceMutationPreview`, restyled (see
  below), unchanged position in the sequence.

Composition is a pure client function,
`buildStepTimeline(step: StepExecutionPreview): StepTimelineEntry[]`, in a
new `src/ui/webview-react/utils/dryRunTimeline.ts` (see Placement
corrections above):

```text
[payload?] → [...mutations, in DTO order] → [command?]
```

### Mutation entry: fix scope, drop the fake path, fix owned keys

Add a `scope` field, computed structurally by `ExecutionPreviewService`, no
provider call sites need to change for the common case:

```typescript
export interface WorkspaceMutationPreview {
  path?: string; // now genuinely optional — no "(process-local)" placeholder
  scope: "run-local" | "shared";
  ownedKeys: string[];
  operation: string;
  warning?: string; // only present for scope: "shared"
}
```

Both `path` and `warning` are **required** on the shipped
`WorkspaceMutationPreview`, so relaxing them to optional is a breaking type
change with one non-obvious consumer outside the modal:
`CliTerminalFormatter.ts:216-219` renders
`` `  Mutation: ${mutation.operation} ${mutation.path} — ${mutation.warning}` ``
unguarded, and would print `undefined` for a pathless or `run-local`
mutation. It needs a scope-aware line, not just a compile fix.

`toWorkspaceMutation` rule: a mutation whose `path` resolves under
`<workspaceRoot>/.ctrlyoke/temp` (compare against
`PATH_CONSTANTS.CTRLYOKE_DIR`/`TEMP_DIR`, the same constants
`getHookSettingsPath` already uses) is `run-local`. Any other path (e.g.
`.qwen/settings.json`) is `shared`. For the no-path "Remove previous prompt
hook artifacts" case, give `ExecutionPlanBuilder`'s cleanup mutation a
directory-level `path` (the `.ctrlyoke/temp` dir itself, not a specific file)
so it classifies as `run-local` structurally instead of falling into today's
ill-defined "process-local" bucket. Reserve "no `path` at all" strictly for
mutations with no filesystem interaction (e.g. OpenCode's
`pendingUserHooksEnv`), which are also `run-local`.

UI styling by `scope`, not by path-presence:

- `run-local`: muted/neutral row, label along the lines of "Internal —
  `.ctrlyoke/temp`, cleared after this run." No warning icon or color.
- `shared`: keeps the current warning styling and "Workspace-wide side
  effect: …" copy — which will now actually be true every time it appears.

### Visibility: show everything, collapse the low-signal rows — don't hide them

Rejected: filtering the timeline down to `scope: "shared"` mutations only.
The dry run's stated purpose (`DRY_RUN_PREVIEW_PLAN.md`'s Problem section)
is that users cannot currently inspect the *complete* execution ctrlyoke is
about to prepare — hiding `run-local` mutations, and the payload/command
rows, would reintroduce exactly that gap for the sake of a shorter list. The
Payload and Command tabs already default to showing full internal detail
rather than a curated subset; filtering only this section would be an
inconsistent policy relative to the rest of the modal.

Instead, reuse the collapse-by-default idiom this modal already has for the
same reason: `PayloadSection` collapses Tier 3 chunk bodies via
`buildCollapsedOutputPreview`/`formatCollapsedOutputToggleLabel` rather than
omitting them. Apply the same pattern to `run-local` mutation rows — group
consecutive `run-local` entries within one step's timeline into a single
collapsed summary line by default (e.g. "3 internal changes —
`.ctrlyoke/temp`, cleared after this run ▸"), expandable per step to the
individual rows. The payload row, command row, and any `scope: "shared"`
mutation always render expanded — only `run-local` mutations collapse.
Nothing is omitted from the DTO or from what a user can reach; only the
*default* rendering density changes, same as the existing chunk-body
pattern.

`ownedKeys`: rename the rendered label from "Owned keys" to something
self-explanatory (e.g. "Merges into existing keys:") and only render it for
`scope: "shared"` mutations — for `run-local` full-file writes ctrlyoke owns
the entire file, so the key list is noise and should not render. Fix the
underlying gap by letting a provider set `ownedKeys` explicitly on
`PreparedMutation` instead of relying solely on regex/JSON-sniffing
`intendedContent`:

```typescript
export interface PreparedMutation {
  readonly path?: string;
  readonly intendedContent?: string;
  readonly ownedKeys?: string[]; // new — explicit, provider-supplied
  readonly description?: string;
  readonly apply: () => Promise<void>;
  readonly restore?: () => Promise<void>;
}
```

`QwenCliProvider`'s hook-registration mutations set `ownedKeys` directly
(the keys `registerHooksInSettings` is about to touch — already known to
the caller, e.g. `ctrlyokeHookKeys`/hook section keys). `extractOwnedKeys`
from `intendedContent` becomes a fallback used only when a provider didn't
set `ownedKeys` explicitly (Claude/Antigravity's full-file writes can keep
deriving it automatically — it's cheap and correct there, it's just not
worth *showing* per the `scope` gating above).

### Rendering

- **Per-step Summary tab**: replace the current bare `MutationList` section
  (heading "Workspace mutations") with a "Timeline" section rendering
  `StepDetail`'s slice of the timeline —
  `buildStepTimeline(step).map(renderTimelineEntry)` — in order: payload row
  (if present) → mutation rows (consecutive `run-local` rows collapsed into
  one summary row by default) → command row (if present). Each of the two
  new synthetic rows is a single line with a "View in Payload tab" /
  "View in Command tab" affordance that switches `activeTab` for that step
  rather than navigating away from the modal.
- **Overview tab**: replace "Workspace mutations across all steps" with
  "Workflow timeline" — the concatenation of every step's timeline, grouped
  under a per-step heading (step index, name, harness icon — reusing the
  existing rail row styling) so the sequence still reads
  top-to-bottom as "what happens, in order, across the whole run," while
  remaining visually anchored to which step owns which segment. Steps with
  an empty timeline (e.g. a script step with `workspaceMutations: []` and no
  meaningful command) are skipped entirely rather than rendering an empty
  heading.
- **Overview's click-through needs one more step than the per-step tab's
  does.** From the per-step Summary tab, "View in Payload/Command tab" only
  has to set `activeTabs[stepIndex]` — the rail selection is already that
  step. From Overview, `selection` is `"overview"`, not a step index, so the
  same affordance must set `selection` to that step's index *and*
  `activeTabs[stepIndex]`, in that order — otherwise the tab switch has no
  step detail mounted to apply to. Easy to implement only for the per-step
  case and miss this because the two call sites look identical at a glance.
- The new payload/command timeline rows are pure navigation aids into content
  that already renders in those tabs — they don't duplicate it. See
  **Payload Tab** below for the separate redesign of that tab's own content.

## Timeline Non-goals

- No new backend DTO field for the payload/command timeline rows — computed
  client-side from `CategorizedPromptPreview`/`CommandPreview`, both already
  shipped.
- No "simplified command" renderer. The command timeline row is cwd +
  executable only, never a partial or re-escaped rendering of `args`.
- No reordering of `ExecutionPlan.mutations` or the underlying execution
  order — this plan only makes the existing, already-chronological sequence
  visible and adds two synthetic anchor points to it.
- No change to redaction behavior or CLI `--dry-run --json` output shape.

## Timeline Testing

- `ExecutionPreviewService` unit tests: assert `scope` classification for a
  `.ctrlyoke/temp` path, a non-temp shared path, and the no-path cleanup
  mutation (now directory-scoped); assert `warning` is present only for
  `scope: "shared"`.
- Assert `ownedKeys` is populated for a Qwen-style mutation that sets it
  explicitly and empty (and unrendered) for a `run-local` full-file write.
- `buildStepTimeline` unit tests: prompt step with Tier 1 references only
  (no payload row), prompt step with real payload content (payload row with
  correct file count), script step (command-only), a step with a `shared`
  mutation in the middle (order preserved: payload, mutation, command).
- Dashboard test: Overview renders step-grouped timeline segments in step
  order; per-step Summary tab's "View in Payload/Command tab" row switches
  `activeTab` without closing the modal.
- Assert the collapse behavior directly: a step with multiple `run-local`
  mutations renders one collapsed summary row by default with all rows
  reachable via expand; a step with a `scope: "shared"` mutation renders it
  expanded without requiring a click; collapsing/expanding never changes the
  underlying `WorkflowExecutionPreview` — only local component state.

## Payload Tab

### Problem

**1. File-reference rows are misleading and borrow "chunk" semantics that
don't apply to them.** `CliPromptPreparer.buildFileReferenceSection` builds
one `CategorizedPromptSectionPreview` per `@path`/`#file:` reference with
`chunkIndex` set to that reference's plain loop index (`i` over
`directFileRefs`) — there is no splitting involved. But `PayloadSection`
renders every category identically: `{section.category} · chunk
{section.chunkIndex + 1}`. For agent instructions, skill content, excerpts,
and prior context, `chunkIndex` really does mean "this is fragment N of one
logical body," because those categories are built via `addChunkFiles` from a
real `PromptFileSplitter.split()` call. For file references it means "this is
the Nth distinct file referenced" — a different axis entirely, and rendering
it with the same "chunk" word implies the file itself was split into pieces,
which never happens.

**2. The delivery-status copy for file references is factually wrong.**
`DryRunModal`'s `TRUNCATION_REASON_COPY.reference` reads "Harness will not
receive this content: it is represented as a reference." That's backwards —
per `HarnessIntegration.ts`'s `formatAttachmentClauses` (the single source
for both CLI and Chat harness prompt composition), a direct file reference is
embedded directly in the prompt text sent to the harness, exactly like an
excerpt reference; the harness absolutely receives it and reads the file
itself. What ctrlyoke's own process does *not* do is embed the file's bytes
in its own payload — that's a true statement about ctrlyoke's internal
pipeline, not about what the harness receives, and the current copy conflates
the two. `src/cli/CliTerminalFormatter.ts` already gets this right for the
same `truncationReason` value ("the harness receives the provider reference,
not inline content") — the modal and the CLI currently disagree about the
same fact for the same data, which is exactly the kind of copy drift a
single-sourced label avoids.
**3. The "No inline body in this preview" line is pure noise for file
references.** `PayloadSection` falls through to that line whenever `body` is
falsy; for `file-reference` sections `body` is never set to begin with — it's
not a truncation outcome worth calling out, it's the section's permanent,
by-design shape.
**4. "Inline reference" doesn't match the terminology the actual prompt
uses.** `PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE` maps to
`TEMP_FILE_CATEGORIES.EXCERPTS` internally, and `HarnessIntegration.ts`'s own
clause-composition doc comment names this concept "attachment excerpts"
(`and these attachment excerpts <excerptRefs>`, confirmed in the excerpt at
`HarnessIntegration.ts:494-511`). The dry-run UI is the only place in the
codebase still calling it "inline reference."
**5. Prior-context payload never appears in the dry run — verified as a real
wiring bug, not a display issue.** `ExecutionPreviewService`'s
`workflowContext` only gets a `resolvePriorContextItems` callback when
`this.options.resolvePriorContextItems` was supplied to its constructor
(`ExecutionPreviewService.ts:322-324`). Neither production call site sets it:
`WorkflowOrchestrator.ts:2102` (the dashboard's preview handler) and
`cli.ts:682` (the standalone CLI's `--dry-run`) both construct
`ExecutionPreviewService` without that option. Compare real execution —
`WorkflowInstance.ts:3010` always supplies `resolvePriorContextItems`,
resolving through `AddressedPriorContextResolver` against
`outputHistoryManager.getRunOutputResolver()` keyed by `historyFilePath`. So
`CliPromptPreparer.createCategorizedPromptPlan` never receives prior-context
items during preview and the `prior-context` category section is always
empty — this reproduces on every workflow with a `priorContext` reference,
not just edge cases.

### Design

**Single-source category display labels.** Add
`PREVIEW_PROMPT_CATEGORY_LABELS: Record<PreviewPromptCategory, string>` to
`DashboardConstants.ts`, alongside the existing `_LABELS` maps (e.g.
`COMMAND_DISPLAY_SHELL_LABELS`), and use it from both `DryRunModal.tsx` and
`CliTerminalFormatter.ts` instead of interpolating the raw category string in
each place independently:

```typescript
export const PREVIEW_PROMPT_CATEGORY_LABELS: Record<PreviewPromptCategory, string> = {
  "agent-instructions": "Agent instructions",
  "skill-content": "Skill content",
  "prompt-text": "Prompt text",
  "prior-context": "Prior context",
  "inline-reference": "Excerpts", // renamed — was "Inline reference"
  "file-reference": "File reference",
  "image-metadata": "Image metadata",
};
```

**File-reference rows get their own rendering, not a variant of the
chunk-based one.** They never have a `body`, never need the collapse/expand
toggle, and "chunk" doesn't apply — that's enough structural difference to
justify a dedicated branch in `PayloadSection` (or a small sibling
component) rather than threading more conditionals through the generic one.
Target layout, matching the simplified example from the discussion:

```text
File reference DRY_RUN_PREVIEW_PLAN.md          34,126 bytes · 7,290 tokens
c:\dev\ctrlyoke\dev\backlog\DRY_RUN_PREVIEW_PLAN.md
Direct file reference — included with the prompt; the harness reads it directly.
```

- Header line: `PREVIEW_PROMPT_CATEGORY_LABELS["file-reference"]` + the
  reference's basename (new — not shown today) + byte/token counts. No
  "chunk N".
- Second line: `section.path` (unchanged — already the full absolute path).
- Third line: the corrected, non-warning delivery note, replacing both the
  old warning-colored reason line and the "No inline body" fallback with one
  neutral-styled sentence. No warning icon, no warning color — this is
  expected, correct behavior, not degraded output. Reuse the same corrected
  wording in `CliTerminalFormatter`'s `delivery` ternary so the two surfaces
  say the same thing about the same `truncationReason` value.

Chunk-based categories (`agent-instructions`, `skill-content`,
`prior-context`, `inline-reference`) keep the existing "chunk N" rendering
unchanged — those really are fragments of one logical body produced by
`PromptFileSplitter`, and the label change above only affects the category
name shown, not the chunk suffix.

**Fix prior-context wiring.** Give `WorkflowOrchestrator.ts` and `cli.ts` the
same `resolvePriorContextItems` capability `WorkflowInstance.ts:3010` already
has, so `ExecutionPreviewService` can resolve real prior-context items during
preview instead of silently omitting the section. Both call sites have
access to the same run/history plumbing `WorkflowInstance` uses
(`outputHistoryManager`, `historyFilePath` resolution) — this is a wiring
gap, not a new subsystem.

**Decided: when no run history exists yet, render a placeholder section
rather than omitting it.** Silence and "genuinely nothing configured" were
indistinguishable before this fix — the same ambiguity this whole plan has
been removing elsewhere (`run-local` vs `shared`, "chunk" vs "reference
index") — so a step whose prompt actually references prior context must
always produce a visible `prior-context` section, even when there is nothing
to resolve yet. Concretely, when `resolvePriorContextItems` resolves to zero
items, `createCategorizedPromptPlan` still emits exactly one `prior-context`
section (no body, `byteCount: 0`, `tokenEstimate: 0`, `chunkIndex: 0`), so it
renders through the same title path as a real chunk — "Prior context ·
chunk 1" — rather than needing a separate placeholder component.

**Threading note.** `createCategorizedPromptPlan` currently receives
`resolvedContextContent`, which `planPrompt` only computes when
`contextItems.length > 0` — so "referenced but unresolvable" and "not
referenced at all" are indistinguishable inside it today. Emitting the
placeholder requires passing `hasPriorContext` (already computed in
`planPrompt`) through as its own argument. Both of `planPrompt`'s inline
fast paths already bail out when `hasPriorContext` is true, so the
categorized path is the only one that needs to handle this.

This reuses the truncation-reason mechanism rather than adding a parallel
conditional to `PayloadSection`, but it is not a truncation (nothing was cut
— there's nothing to cut yet), so it gets its own
`PREVIEW_TRUNCATION_REASONS` entry rather than overloading `"reference"` or
`"over-inline-cap"`, which mean something else:

```typescript
"not-yet-available": "No prior context to preview yet: this reference resolves against run history that doesn't exist until the step runs."
```

Styled neutral, like the corrected `"reference"` copy above — this is
expected, correct behavior for a workflow that hasn't run yet, not data loss
or a problem, so no warning icon or warning color. (`"over-inline-cap"` and
`"body-budget"` keep their current warning styling — those genuinely
represent content the harness will not receive; this plan only changes the
styling verdict for `"reference"` and this new `"not-yet-available"` case,
not the other two.)

**Watch point for `CliTerminalFormatter.ts`'s `delivery` ternary specifically
(not just the modal).** It's currently two-branch: `truncationReason ===
"reference"` gets its own sentence, everything else falls through to "the
full planned payload remains available to the harness." That fallback is
wrong for `"not-yet-available"` — there is no payload available, it doesn't
exist yet, which is a different claim than "available but not shown here."
This needs a third branch with wording matching the modal's new copy above,
not just a reuse of the existing two-way split — an easy thing to miss since
the rest of this section talks about *reusing* `CliTerminalFormatter`'s
existing wording for the `"reference"` case, and it would be easy to
generalize that into "reuse it for this case too" without noticing the
existing ternary has nowhere for a third meaning to go.

### Payload Tab Non-goals

- No change to how `PromptFileSplitter` actually splits content — this is
  display-only for the chunk-based categories.
- No change to Tier 1/2/3 size-limit or redaction behavior from
  `DRY_RUN_PREVIEW_PLAN.md` — only the copy and layout describing them.
- Fixing the prior-context wiring gap does not change what real execution
  resolves or when; it only makes preview match what execution already does.

### Payload Tab Testing

- `PREVIEW_PROMPT_CATEGORY_LABELS` covers every `PreviewPromptCategory`
  value (exhaustiveness — a missing entry should be a type error, not a
  silent fallback to the raw category string).
- Snapshot/unit test that `DryRunModal` and `CliTerminalFormatter` render the
  identical delivery sentence for a `truncationReason: "reference"` section.
- File-reference section rendering: no "chunk" text, no warning color/icon,
  basename shown in the header line, full path shown below it.
- `ExecutionPreviewService` test: a workflow step with a `priorContext`
  reference and real prior run history produces a non-empty `prior-context`
  section, matching what `CliPromptPreparer` would build for real execution
  given the same resolved items — closing the gap the golden tests in
  `DRY_RUN_PREVIEW_PLAN.md` (preview vs. real execution) should have caught.
- `ExecutionPreviewService` test: a workflow step with a `priorContext`
  reference and *no* resolvable run history yet produces exactly one
  `prior-context` section with `truncationReason: "not-yet-available"`,
  zero byte/token counts, and no body — not an omitted section, not an
  error. Dashboard test: that section renders "Prior context · chunk 1"
  with the neutral (non-warning) placeholder copy.

## Tab Bar

### Order

Reorder `DRY_RUN_TAB_DEFINITIONS` in `DryRunModal.tsx` from
Summary → Payload → Command → Conditions to **Summary → Command → Payload →
Conditions**. Command is the tab a reviewer most often wants immediately
after Summary — "what's it actually going to run" — and having it third
underneath Payload buries it. Payload and Conditions keep their relative
order. No change to the tab *contents* here, only `DRY_RUN_TAB_DEFINITIONS`'
array order (`SegmentedTabBar` renders tabs in array order, so this is the
only place the change needs to be made).

### Conditions tab icon

`DRY_RUN_TAB_DEFINITIONS`'s Conditions entry currently uses
`codicon: "symbol-event"` — verified this is not a generic "event" icon
choice, it's a direct copy from the drawer's **Hooks** tab
(`drawerPages.ts:26`: `{ id: "hooks", label: "Hooks", codicon:
"symbol-event" }`). The drawer's actual end-condition tab is **Validation**,
which uses `codicon: "coverage"` (`drawerPages.ts:24`). Change Conditions to
`"coverage"` to match — this fixes a mixed-up icon, not just a stylistic
choice.

### Summary tab icon

**Problem, verified in `StepDetail`'s `tabOverrides` construction
(`DryRunModal.tsx`):** the Summary tab's displayed icon is not its coded
default (`codicon: "info"`) in the common case. `getPermissionOverride`
supplies a `tabOverrides[SUMMARY]` override whenever `getPermissionTabOverride`
returns one, and `SegmentedTabBar` renders `override?.codicon ?? tab.codicon`
— override wins. For `PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL` specifically,
`getPermissionTabOverride` (`tabBadgeUtils.ts:39-45`) sets
`codicon: "workspace-untrusted"`, replacing the icon shape entirely, not just
its color — in that mode the tab reads as "workspace-untrusted," not
"summary," for exactly the case a reviewer most needs the actual summary
identity to stay legible.

**Recommendation: `"map-vertical"`, and move the permission indicator off the
icon entirely rather than shrinking it to a badge.**

`"history"` was considered and rejected: it's VS Code's own glyph for a
timeline view, but its connotation is backward-looking (a record of what
already happened), which is exactly wrong for a dry run — this tab
summarizes what is *about to* happen, never what did.

`"map-vertical"` (codicon metadata: `tags: location, guide, up, down,
chart`, description "Vertical map") is forward/guide-oriented instead —
a map orients a future route, not a record of a past one — and "vertical"
isn't arbitrary: it echoes how this content actually renders, the Overview
rail lists steps top-to-bottom and each step's own timeline stacks payload →
mutations → command top-to-bottom, a resonance `"history"` or a plain
`"map"` don't have. Checked for collisions: none — no existing
`codicon-map*` usage anywhere in the codebase. `"dashboard"` is ruled out
because this exact modal's own Overview rail entry already uses it
(`DryRunModal.tsx:678`); `"globe"` is ruled out because ctrlyoke already
uses it elsewhere (`GlobalSettingsDrawer`, MCP remote-server rows) to mean
*global/workspace scope* — reusing it here would read as "this tab is about
workspace-wide effects," which is exactly the distinction the `scope:
"run-local" | "shared"` work above is trying to make legible.
`"telescope"` is ruled out for a different reason: it's already the Dry Run
feature's own launcher icon (`Header.tsx:64`, the step context-menu
accelerator, and the `PropertiesDrawer` entry point all use
`codicon-telescope`, per `title="Dry Run"`) — reusing it for a tab inside
the modal it launches would be redundant with the modal's own icon. Other
candidates surveyed from the codicon set: `"checklist"`/`"tasklist"`
(already used for the workflow list and output-row icons elsewhere in
ctrlyoke; also reads as "to-do," not "what's about to happen"),
`"milestone"` (reasonable, but its tags skew toward git/PR milestones
specifically, which risks reading as "release milestone" rather than "step
in this run" for a developer audience already using git integrations
heavily), `"compass"` (good forward-looking connotation, but a single-point
orientation instrument reads weaker than a multi-waypoint route for implying
a *sequence* of steps), `"report"` (generic "document/summary," says
nothing about sequence), the harness icon (rejected — it's step-specific,
already shown separately in the `StepDetail` header, and Summary's icon
should stay stable across steps like every other tab).
**Revised, superseding the full-replace behavior for both tabs: neither
tab's icon *shape* ever changes. All signals — diagnostic severity on
Summary, permission mode on Command — render as a color tint on the stable
shape plus a small badge, never a shape swap.** A shape swap makes a tab
read as "this is now the warning tab" / "this is now the permission tab,"
which misrepresents a tab that shows much more than that one signal. Color +
badge keeps the tab's identity legible while still making the signal visible
at a glance; recoloring the main icon alongside the badge (not just the
badge alone) keeps it from being too subtle to notice, since a badge alone
is small.

- **Summary: diagnostic severity, color + badge, shape stays
  `map-vertical` always.** When `getWorstSeverity(step.diagnostics)` is set,
  tint the main icon with the matching `DIAGNOSTIC_SEVERITY_STYLE[worst].text`
  color (as today) and add a badge using `DIAGNOSTIC_SEVERITY_STYLE[worst].icon`
  (`"warning"` or `"error"`) in the same color. This also fixes an existing
  bug along the way: today's code hardcodes `codicon: "warning"` for this
  override regardless of actual severity, so an `"error"`-severity step
  still shows a warning-shaped icon, only recolored red — the badge should
  use the correct per-severity shape instead of a hardcoded one.
- **Command: permission mode, color + badge, shape stays `terminal`
  always — no diagnostic signal of any kind.** Confirmed: Command shows
  *only* the permission-mode indicator; diagnostics (including permission-
  translation diagnostics) stay exclusively on Summary. Checked both tab
  bodies to justify moving the mode indicator here at all: `SummaryPanel`
  already renders `["Permission mode", permissionMode]` as a plain labeled
  row, so a same-information badge there would be redundant; `CommandPanel`
  has no headline mode indicator, only the *translated* native arguments
  buried in its `DefinitionList`.
- **`getPermissionTabOverride` (`tabBadgeUtils.ts`) must not change** — it's
  not private to `DryRunModal`. `useDrawerTabOverrides.ts` and
  `useSettingsDrawerTabOverrides.ts` both call it for the editor's own
  Permissions tab, which this plan already commits to leaving untouched, and
  it still does the shape-swap thing for `DANGEROUSLY_ALLOW_ALL` there —
  changing its behavior would silently change the drawer too. Add a new
  sibling function instead, e.g. `getPermissionModeBadge(mode: string):
  Pick<TabIconOverride, "color" | "hoverColor" | "activeColor" |
  "badgeCodicon" | "badgeColor"> | undefined`, used only by `DryRunModal`'s
  Command tab. One constant badge shape across all modes —
  `badgeCodicon: "shield"` (codicon tags: `security, protect, safety,
  guard` — a clean, mode-agnostic "this is about permissions" glyph) —
  colored per mode with the same palette `getPermissionTabOverride` already
  uses (green for custom, yellow for allow-all, red for
  dangerously-allow-all; no badge for `none`). One shape recolored by level
  reads as one continuous concept ("how much is auto-approved") the same
  way a battery icon stays one shape and only its color/fill changes — unlike
  severity, where warning and error are genuinely two different shapes
  today, so that distinction is worth keeping. Considered and rejected the
  `workspace-trusted`/`workspace-unknown`/`workspace-untrusted` codicon
  family (a real three-tier icon set VS Code ships) specifically because it
  already carries VS Code's own distinct "workspace trust" feature
  association — reusing it here would misrepresent tool-permission mode as
  that unrelated feature.

**New capability needed:** no existing "small badge in the corner of an
icon" pattern exists anywhere in this codebase today (checked
`PropertiesDrawer.tsx`, `WorkflowStep.tsx`, `TerminalInstance.tsx`,
`PromptChipRail.tsx` — all unrelated `absolute`-positioning uses). This is
new, not a config change:

```typescript
export interface TabIconOverride {
  codicon?: string;
  color?: string;
  hoverColor?: string;
  activeColor?: string;
  /** Small secondary icon rendered in the lower-right corner of the tab's main icon. */
  badgeCodicon?: string;
  /** Tailwind text-color class for the badge icon. */
  badgeColor?: string;
}
```

`codicon`/`color`/`hoverColor`/`activeColor` are the existing fields —
unchanged shape here, just no longer set to a different shape by either of
`DryRunModal`'s two overrides. Only `badgeCodicon`/`badgeColor` are new.
`SegmentedTabBar` wraps the primary `codicon` `<span>` in a `relative`
container and renders the badge as a smaller (~11px vs. the primary 20px),
absolutely positioned `bottom-right` span with its own small background fill
(e.g. a filled circle in `bg-sidebar-bg`, matching the tab bar's own
container background) behind the glyph — without a fill, a badge glyph will
visually merge with the primary icon's strokes at this size and become
illegible. Badge color is a single fixed value, no separate hover/active
variants — it's a small informational marker, not an interactive element,
so it doesn't need the primary icon's three-state color system. This is a
`SegmentedTabBar`-level capability (shared with `DrawerTabBar`), so it's
available for the drawer's own tabs later, but this plan only applies it to
`DryRunModal`'s Summary and Command tabs.

### Tab Bar Non-goals

- No change to `DrawerTabBar`'s own tab set, the properties drawer's
  Permissions tab, or `getPermissionTabOverride`'s existing behavior — the
  badge capability is added to the shared `SegmentedTabBar`, and permission
  mode gets a new, separate `getPermissionModeBadge` function so the
  drawer's existing shape-swap rendering is untouched.
- Command tab never gains a diagnostic-severity signal of any kind (color,
  badge, or shape) — confirmed scope: all diagnostics, including
  permission-translation diagnostics, stay exclusively on Summary.
- No change to which diagnostics drive the Summary severity signal
  (`step.diagnostics`, via `getWorstSeverity`) — only to how that signal
  renders (color + correctly-shaped badge, never a full shape swap).

### Tab Bar Testing

- `SegmentedTabBar` renders a `badgeCodicon` as a smaller, corner-positioned
  icon distinct from the primary `codicon`, for both active and inactive tab
  states.
- `DryRunModal`: Conditions tab renders `codicon-coverage`. Summary tab
  renders `codicon-map-vertical` **unconditionally** — including when
  diagnostics are present — with severity conveyed only via icon color and a
  `badgeCodicon` matching the actual severity (`"warning"` vs `"error"`,
  not a hardcoded value). Command tab renders `codicon-terminal`
  **unconditionally** — including for `DANGEROUSLY_ALLOW_ALL` — with mode
  conveyed only via icon color and a constant `badgeCodicon: "shield"`
  recolored per mode; Command renders no badge at all for
  `PERMISSION_MODES.NONE` and never renders a diagnostic-driven badge under
  any condition.
- Regression test: `getPermissionTabOverride` (`tabBadgeUtils.ts`) and its
  existing callers (`useDrawerTabOverrides.ts`,
  `useSettingsDrawerTabOverrides.ts`) are unchanged — same shape-swap
  behavior for the drawer's Permissions tab as before this plan.
- Tab order test: `DRY_RUN_TAB_DEFINITIONS` renders Summary, Command,
  Payload, Conditions in that order.

## Formatting

**Problem.** `DryRunModal.tsx`'s `formatCount` is one function
(`value.toLocaleString()`) used for three different kinds of number:
plain counts (steps, mutation counts, retry attempts — correct as-is),
byte counts, and token counts. Byte and token values need magnitude
formatting and don't get it today — `OverviewPanel` renders `["Payload
bytes", formatCount(preview.workflow.totalByteCount)]` as `"176,185"`
instead of a scannable `"176K"`. `EditorSection.tsx` already has the desired
shape for token counts, inlined in JSX rather than shared:

```typescript
tokenCount >= 1_000
  ? `${(tokenCount / 1_000).toFixed(1)}K`
  : tokenCount.toString()
```

That inline version also has a latent gap worth fixing at the same time: it
has no tier above `K`, so a step at or above 1,000,000 tokens would render
`"1000.0K tokens"` instead of `"1.0M tokens"`.

**Design.** Add one shared magnitude formatter to the existing
`src/ui/webview-react/utils/number.ts` (see Placement corrections above),
used by both `EditorSection` and `DryRunModal` instead of maintaining two
slightly different versions:

```typescript
export function formatMagnitude(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}
```

Callers keep their own trailing unit word, matching the existing token
pattern exactly (`formatMagnitude(tokenCount)} tokens`,
`formatMagnitude(byteCount)} bytes`) rather than baking a unit letter into
the formatter — this matches the literal target from the discussion
(`"Payload bytes 176K"`, not `"Payload bytes 176KB"`).

Call sites to switch from `formatCount` to `formatMagnitude` in
`DryRunModal.tsx`: `OverviewPanel`'s "Payload bytes" and "Token estimate"
rows, `SummaryPanel`'s "Token contribution" row, `PayloadSection`'s byte/token
count line, and `PayloadPanel`'s "N of M body bytes shown" line.
`formatCount`/`.toLocaleString()` stays for genuine plain counts (step
count, mutation count, retry attempts) — those are not magnitudes that
benefit from K/M compression and should keep exact values.

Out of scope: `CliTerminalFormatter.ts`'s human-text output and `--dry-run
--json` keep raw exact numbers. Terminal output and JSON are consumed
differently (scripting, exact debugging) than the dashboard modal, and
nothing in the discussion asked to change them.

### Formatting Non-goals

- No change to `--dry-run --json` numeric output — magnitude formatting is
  a dashboard/`EditorSection` display concern only, never applied to
  machine-readable output.
- No change to CLI human-text output (`CliTerminalFormatter.ts`).

### Formatting Testing

- `formatMagnitude` unit tests: boundary values at 999/1,000,
  999,999/1,000,000, and a few mid-range values for both K and M tiers.
- `EditorSection`'s token count and `DryRunModal`'s byte/token rows render
  identically formatted magnitudes for the same input value (regression
  guard against the two drifting again).
- Plain-count fields (steps, mutation count, retry attempts) remain
  unformatted exact values after the switch — a regression test that they
  were not accidentally routed through `formatMagnitude`.
