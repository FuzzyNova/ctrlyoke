# Output Pane Step Attribution — UX Overhaul

## Background

The parallel-steps work added cross-step interleaving to the output pane, and with it three new
ways to say "this row belongs to step N". They stack, so a single step transition can now paint
three separate labels plus a rail. On a sequential run — where interleaving is impossible and the
attribution was never ambiguous — all of it is pure noise.

This doc is a design brainstorm, not an approved plan. Nothing here is implemented.

---

## What currently draws step attribution

| #   | Surface           | Where                                                 | Renders                                                              | Added by     |
| --- | ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| 1   | `cli-header` row  | `OutputRow.tsx` (~line 1190)                          | `[10:41:20 AM] [💬 Step 4] name  harness · model`, with a `border-b` | pre-existing |
| 2   | `step-switch` row | `StepSwitchRowView` in `OutputRow.tsx`                | full-width `border-y` bar: `→ Step 4  name`                          | parallel     |
| 3   | activity label    | `ActivityAttribution` when `row.activityFirst`        | `⚡ Step 4 · name`, 20px tall (`OUTPUT_ROW_ACTIVITY_LABEL_HEIGHT`)   | parallel     |
| 4   | activity rail     | `ActivityAttribution` when `row.activityContinuation` | `border-l-2 border-output-streaming/40` + `pl-2` on the content      | parallel     |
| 5   | minimap pills     | `OutputMinimap.tsx`                                   | one pill per step on the right rail                                  | pre-existing |

Rows 1–3 are all emitted from `buildOutputRows` and all say the same thing.

### What the rail (4) actually means today

`ActivityAttribution` renders **either** the label **or** the rail, never both, keyed off two
mutually exclusive flags on the row:

- `activityFirst` → the 20px `⚡ Step N · name` label above the row.
- `activityContinuation` → a `border-l-2 border-output-streaming/40` at the row's left edge plus
  `pl-2` on the content.

So the rail's intended meaning is **"the step that was already writing is still the one writing"** —
a _same-step-continues_ marker, not a step identifier. Two consequences follow, and both are why it
reads as noise:

- **It is one shared colour for every step.** `output-streaming/40` is a single accent, so the rail
  distinguishes "continuation" from "start" but tells you nothing about _which_ step — the exact job
  it looks like it is doing.
- **It is the only one of the five that costs horizontal space.** `pl-2` (8px) is applied to
  continuation rows only, so the output's left edge ragged-edges as you scroll past a switch. In a
  pane that is often narrow, that is the complaint about lost width, and it is a fair one.

---

## Open question — SETTLED (2026-09-04)

The previous revision asked whether the repeating `⚡ Step N` label was **(a)** a stale screenshot
predating the row-key fix (`18c0c19f`) or **(b)** an over-firing `activityFirst` predicate. It is
neither. **The predicate is correct; the _stamping_ is wrong.**

`activityFirst` is computed once per message, correctly, as
`previousActivityTargetKey !== targetKey` (`outputRows.ts` ~1985 and ~2175). But it is then packed
into `activityMeta` (`outputRows.ts` ~2193) and **spread onto every row that message emits** — four
spread sites (~2303 streaming text, ~2375 per structured event, ~2429 streaming response, ~2451
response). A slice carrying _n_ visible events therefore stamps `activityFirst: true` on all _n_
rows and paints the label _n_ times.

The rail shares the spread but **not** the defect: `activityContinuation` is a continuous left edge
down a slice's content, so per-row is what it wants. Its problem is scope, not stamping — it is on
for every slice after the first, which on a sequential run is essentially the whole attempt. That is
what §1 and §5 address, not the stamping fix.

### Measured, on a real run

Probe over `mapOrderedHistoryEntriesToMessages` + `buildOutputRows` fed with the real activity
entries reconstructed from
`~/.ctrlyoke/projects/ctrlyoke-81d730fe53ae/.runs/he-2026-09-04T19-59-28-285/run-2026-09-04T20-08-46-578Z/events.jsonl`
(step 1, run 1 — the run in the screenshot):

|                                  | value                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------ |
| rows built                       | 174                                                                            |
| rows with `activityFirst`        | **2** — both from the _same_ slice (`…:structured:4`, `event:0` and `event:1`) |
| rows with `activityContinuation` | **169**                                                                        |

Slice `sequence: 4` is a single `cliOutputEventsAppended` batch carrying `[text, bashCommand]`.
That is exactly the screenshot: `⚡ Step 1` above "I'll start by reading the plan…", then `⚡ Step 1`
again above the `wc -l` block. And the "green border showing up later" is the rail switching on at
slice 5 and never switching off again for the remaining 169 rows.

### The fix — DONE (2026-09-04)

The two flags needed **asymmetric** treatment, which is the part worth remembering:

- `activityFirst` + `activityLabel`/`activityName` describe the _slice_, so they moved out of
  `activityMeta` onto the slice's first **content** row alone (a `contentRowStart` marker taken
  after the leading chrome is pushed, stamped after the content block — leading chrome belongs to
  the attempt, so the label must not land on the header).
- `activityContinuation` and `activityKey` stayed per-row. Making the rail per-slice too would break
  a continuous left edge into 134 scattered dashes, and the minimap plus the streaming anchor look
  rows up by `activityKey`.

Re-measured on the same run: `activityFirst` 2 → **1**, `activityContinuation` 169 → **169**
(unchanged, by design). The estimator needed no change — `outputRowActivityChrome` charges 20px per
`activityFirst` row and now charges it on exactly the row that paints a label. Both existing tests
(`test/utils/outputRows.test.ts` ~428 for the +20 relationship, ~355 for the continuation rail)
passed untouched, which is the signal that the asymmetry was the right call; a regression test for
the multi-event opening slice was added beside them.

---

## Proposal

### 1. Text attribution is a parallel-only affordance; colour is not

On a sequential run the writer is unambiguous: rows are chronological and only one step can be
writing. Drop markers **2 and 3** — the `step-switch` row and the `⚡ Step N` label — entirely
there. The `cli-header` (1) already names the step once per attempt, which is the right cadence, and
the minimap (5) already gives spatial orientation.

**Marker 4 is exempt and is _not_ gated.** The rail becomes a zero-cost colour bar (§2) painted on
every step's output in every run — see "The colour bar is painted everywhere" in §5 for why gating
it was a mistake. The gate exists to remove things that consume rows and vertical space, and the bar
consumes neither.

The gate should be **"this step ran inside a parallel group with ≥2 members"**, not "the workflow
has a group" — a workflow with one parallel group and twelve sequential steps should show
attribution only inside the group.

**Caveat, and it is load-bearing: `getConcurrentGroupForStep` is not that predicate.** It is a
_snapshot_ predicate — after finding the group it requires
`workspaceSnapshots[group.startIndex]?.parallelGroupId === group.id` and returns `undefined`
otherwise, because its only current caller is undo-action labelling, which must not offer a group
undo without a group snapshot. Reused as-is for attribution, a genuinely parallel run with no
captured snapshot would silently lose all of its attribution — the one case the feature exists for.
Split it: a pure `getParallelGroupForStep(parallelGroups, stepIndex)` returning the `≥2`-member
group, and keep the snapshot check in a thin `getConcurrentGroupForStep` wrapper for the undo path.

This removes every text marker from the first screenshot except the one that was always there, and
removes all of them from ordinary runs.

### 2. Colour as the identity channel, painted in the gutter

Colour answers two questions without consuming a row: "which of the N concurrent writers is this?"
inside a parallel group, and "which step am I reading?" at any scroll position in a long sequential
run. Two constraints matter:

- **Never paint _readable text_ in the step colour.** A user-supplied hex cannot be guaranteed
  legible against both light and dark VS Code themes, and the pane already spends colour
  semantically (error red, streaming blue, diff add/remove). Restricting the colour to a 3px bar,
  a dot, and glyph-shaped icons sidesteps contrast entirely — a bar or an icon only has to be
  _visible_, not _readable_. (This is the rule that permits the coloured step icon in §5; it is a
  shape, not a word.)
- **Do not use `border-l` + `pl-2`.** Use `box-shadow: inset 3px 0 0 <colour>` on the row, or paint
  into `OutputRow`'s existing `px-[var(--spacing-md)]` gutter. Both cost **zero layout width and
  zero height**, which also means the estimator does not have to model them at all — a real
  advantage given how sensitive the virtualizer is to row-height changes.

**This is the chosen direction for the rail.** Replace the shared `output-streaming/40` continuation
rail with a zero-width inset bar in the step's own colour, painted on **every row of every step's
output, in every run**. That inverts what the rail means — from "same step continues" to "this is
step N's output" — which is what it already looks like it means, and is worth more than the
continuation signal it replaces. `pl-2` goes away with it, which is the whole horizontal-width
complaint resolved.

### 3. Where the text label lands — a genuine trade-off

The suggestion was: for parallel, show the bar and _no_ header at all.

That is the cleanest possible pane, but it moves decoding off-screen — a bar with no legend inside
the pane means looking at the steps panel to learn that teal is step 4. Three options, in the order
I would rank them:

| Option                                                        | Pane cost                  | Correlation cost                               |
| ------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| **A. Bar + one label per contiguous run of that step's rows** | one 20px line per _switch_ | none — self-describing                         |
| **B. Bar only**                                               | zero                       | must look at the steps panel / minimap         |
| **C. Bar + step number in the `●` gutter** (`●⁴`)             | zero extra rows            | poor legibility at 12px; repeats on every line |

**A** is what `ActivityAttribution` was reaching for, and now that the open question is settled, it
is one bug-fix away: stamping the label on the slice's opening row only (see above) turns "once per
event in the opening slice" into exactly "once per contiguous run". Fixing the stamping plus gating
on parallel lands **A** without removing the label.

**B** is defensible if the steps panel accent (below) is prominent, and it is strictly the
lowest-noise option. Worth prototyping both — after the stamping fix the difference is one boolean.

Either way, `step-switch` rows (2) should go. A full-width `border-y` bar per transition is the
heaviest of the three markers and the most redundant.

### 4. Where a step's colour comes from

**Decision (2026-09-04): the left rail means identity everywhere — expanded panel, group panel, and
chip rail alike.** A 2px left border must not mean one thing collapsed and another expanded.

#### What the default colour should be

Not transparent, and definitely not black. There is no theme-safe black — `#000` is invisible on
every dark theme, and the pane already proves the point: every existing accent in this codebase is a
`var(--vscode-charts-*)` with a hex fallback, never a raw literal. Transparent is wrong for a
different reason: once the rail is the identity channel, a transparent default deletes the panel's
left edge entirely and loses the visual rhythm it has today.

**Default by harness, and the map already exists.** `HARNESS_CHART_COLORS`
(`DashboardConstants.ts` 1539) is a complete, theme-aware `HarnessId → colour` map already
single-sourcing the workspace harness-share bar. Reuse it; do not author a second one.

Two entries need work before they can carry identity, and fixing them changes the share bar too —
make that a deliberate, shared change rather than a fork:

| Harness        | Current                           | Problem as an identity colour                                   |
| -------------- | --------------------------------- | --------------------------------------------------------------- |
| `codex-cli`    | `var(--vscode-editor-foreground)` | Not a hue. Inverts between themes and reads as "no colour set". |
| `opencode-cli` | `var(--vscode-charts-gray)`       | Too low-salience against `panel-border` at 2px.                 |

Script steps have no harness, so they need their own default — one neutral entry, not a per-step
guess.

#### Users can change it

Yes. A new `ui.stepColors` block in `schemas/settings-schema.json`, following the shape conventions
already in that file — harness keys enumerated exactly like `defaults.models`/`defaults.additionalArgs`,
values `^#[0-9a-fA-F]{6}$` exactly like `server.iconBgColor`/`iconFgColor`, `additionalProperties:
false` throughout:

```jsonc
"stepColors": {
  "enabled": true,
  "byHarness": { "claude-cli": "#d18616", /* … all six … */ },
  "script": "#808080"
}
```

Absent means "use the built-in `HARNESS_CHART_COLORS` entry", which is also the only way to say
"follow the theme's chart colour" — the hex pattern cannot express a `var()`. That is the right
trade: enumerating hex keeps the settings UI a simple colour picker, and the built-in default stays
theme-aware for everyone who does not override it.

#### The collision this creates, and how it resolves

Harness-by-default fights the seeded-palette idea head-on: a three-member parallel group all running
`claude-cli` would get three identical bars — failing at exactly the job the colour exists for.

**Resolution: harness colour is the base; the seeded palette only breaks ties.** Inside a
`≥2`-member group, a member whose resolved colour duplicates a sibling's takes the next palette
entry instead. Everywhere else the colour stays meaningful ("orange = Claude") rather than
arbitrary. All of it lives in the one resolver, so the tie-breaking rule cannot fork.

Seed the tie-breaker from a **stable identity, not the step index** — indices shift on reorder,
insert, and rewind, so an index seed would recolour a step mid-run. `ParallelGroupDefinition.id`
(a `crypto.randomUUID()` assigned at normalization; `CtrlYokeTypes.ts` 764) plus the member's offset
within the group is stable across everything except regrouping.

Pick tie-breakers from a **fixed curated palette** (8–10 hues) rather than raw HSL. Random HSL
produces near-duplicates, muddy low-chroma values, and occasional collisions with the semantic
red/green the pane already uses. A group larger than the palette wraps — acceptable, since members
are adjacent and `failFast`-bounded, and concurrency is capped by `queue.maxParallelSteps` anyway.

#### Full precedence

1. `step.color` — authored, always wins.
2. Tie-break palette entry — only inside a `≥2`-member group, only when the step would otherwise
   duplicate a sibling.
3. `ui.stepColors.byHarness[effectiveHarness]` — user override.
4. `HARNESS_CHART_COLORS[effectiveHarness]` — built-in default.
5. `ui.stepColors.script` (script steps).

The effective harness is the existing three-tier step → workflow → global resolution
(`getStepHarnessModel`, `WorkflowStepsPanel.tsx` ~409), so a colour resolves for every step and the
status accent is no longer a fallback — see §5.

#### Authored `color?` on the step

An optional `color?: string`, `^#[0-9a-fA-F]{6}$`, in `schemas/workflow-schema.json`. `PromptStep`
and `ScriptStep` are separate interfaces (`CtrlYokeTypes.ts` 724 and 739) with no shared display
base — `PromptStep extends ExecutionProperties`, `ScriptStep extends ScriptProperties` — and
`name`/`enabled` are already duplicated across both, so this wants a small shared
`StepDisplayProperties` (carrying `name`, `enabled`, `color`) rather than a third duplication. The
parser, export, template, and mutation paths all round-trip step fields and each would otherwise
need the key twice.

#### One implementation note that makes all of this cheap

`getStepAccentClass` returns Tailwind class names, while a step colour is an arbitrary hex. Those
look incompatible until you notice `indicator-success`/`-error`/`-running` are themselves defined as
`var(--vscode-charts-*)` strings (`tailwind.config.js` 274–276) — the exact same form as
`HARNESS_CHART_COLORS`. So the resolver can return **a CSS colour string in every case**, and the
rails switch from `className={...}` to `style={{ backgroundColor }}`. One shape, no branching, and
the status fallback stays expressible if it is ever needed again.

### 5. Correlation surfaces must single-source the colour

If colour is the attribution channel it has to appear in every place the user looks:

#### The steps-panel left rail — what is actually there

The accent the `WorkflowStep.tsx` docstring (~87–91) refers to is **real, but it is not drawn by
`WorkflowStep.tsx`, and `dimmed` is not what triggers it.** It is a `w-[2px] self-stretch` div the
_parent_ renders, coloured by `getStepAccentClass(status)` (`utils/status.ts` 105):
`bg-indicator-success` (green) for completed, `bg-indicator-error` for failed,
`bg-indicator-running` for cancelled/skipped. Three surfaces draw it:

| Surface                                                     | Line                         | Rail state                                       |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| `WorkflowStepsPanel` — completed slice                      | ~1177                        | coloured by status                               |
| `ParallelGroupPanel` — members, non-sortable branch         | ~294                         | coloured by status                               |
| `SortableWorkflowStepWrapper` — every pending/sortable step | `WorkflowStepRow.tsx` ~239   | **empty 2px spacer, no colour**                  |
| `PromptChipRail`                                            | ~69 via `getChipBorderClass` | status, plus RUNNING pulse / PENDING transparent |

So in the expanded panel the left rail is spoken for **only on completed steps**, and is a bare
alignment spacer on every pending one. In the chip rail it is spoken for on every chip _and is the
only status signal there_ — see below. Fix the `WorkflowStep.tsx` docstring regardless: it names the
wrong component and the wrong trigger.

#### Decision: the rail is identity, on all four surfaces

Rationale:

- **In the expanded row, status is already fully expressed one column to the right.** `StatusIcon`
  draws a coloured check/error/spinner beside the step name, and `PromptStepDetails` spells out
  failures. The rail is a redundant second rendering of that fact. Identity has no other home at all.
- **Bar-to-bar is the strongest possible correlation.** The output pane's inset gutter bar (§2) and
  this rail are the same shape, the same width, at the same left edge of their respective panes.
  Matching a hue across two identical bars is far easier than matching a 3px bar to a 12px glyph.
- **A 2px left border must not mean two different things** depending on whether the panel is
  collapsed. That alone settles the chip rail.
- **It fills the empty pending spacer**, so a parallel group is colour-coded while you are still
  authoring it, before any status exists.

Because §4's precedence resolves a colour for _every_ step, `getStepAccentClass` stops being a
fallback and becomes dead at these call sites. Delete it if nothing else claims it.

#### The chip rail needs the status icon added — this is not optional

**Correction to the previous revision, which claimed RUNNING's pulse had no other home in the chip
rail.** It does: `ExecutingStepHighlight` already draws a ring on the executing chip
(`PromptChipRail.tsx` ~124). The pulse is not load-bearing.

The real problem is bigger and cuts the other way. Unlike the expanded row, **a step chip has no
`StatusIcon` at all** — Row 1 is slot number + type icon, Row 2 is context %, and the left border is
the _only_ status signal on the chip. (`FinalStepChip` does render `StatusIcon`; step chips do not.)
So handing the border to identity genuinely destroys information here, and adding the status icon is
a prerequisite, not a nicety.

**Layout budget, because the rail is 32px wide** (docstring: desktop collapsed panel and the mobile
sidebar are both 32px). Subtract the 2px identity bar, the 2px right-edge context fill bar, and
`px-1` on both sides: roughly **20px of content width**. Three elements cannot share a row at that
width, so the status icon needs its own row:

```
[2px identity] │ row 1: slot number + type icon
               │ row 2: status icon              │ [2px context fill]
               │ row 3: context %
```

The cost is real and worth stating: a chip goes from roughly 32px to roughly 46px tall, so ~45%
fewer chips fit before scrolling — and "info at a glance for many steps" is the rail's entire
purpose. **Accepted**, but prototype the two-row variant alongside it (row 1: slot number + status
icon; row 2: type icon + context %), which keeps today's density if 20px turns out to fit two ~10px
glyphs. The difference is a layout swap, not an architecture change.

#### The colour bar is painted everywhere, including sequential runs

**Reversed from the previous revision (2026-09-04).** That revision gated the output-pane bar to
`≥2`-member parallel groups, arguing a sequential run has nothing to disambiguate. That reasoning
was wrong twice over:

- **Disambiguation is not the bar's only job.** In a long run the `cli-header` that names the step
  scrolls off, and there is then nothing on screen saying which step you are reading. A persistent
  left edge answers "where am I?" at any scroll position — continuous orientation, which a
  sequential run needs just as much as a parallel one, arguably more because its output is longer.
- **A gate would create a fresh disconnect.** Painting step 3 in the steps panel while its output
  carries no colour breaks the single rule the whole design rests on: _the left edge means step
  identity_. A rule with an exception nobody can see the boundary of is worse than no rule.

The original objections were **noise** and **lost horizontal width**, and the inset bar answers
both by construction — see the geometry below. Neither objection ever applied to a zero-cost edge
tint; they applied to text markers and to `border-l` + `pl-2`.

**What stays gated is the text, not the colour.** §1's gate narrows to markers 2 and 3 — the
`step-switch` row and the `⚡ Step N` label — which cost rows and vertical space and genuinely are
redundant when only one step can be writing. Marker 4 becomes the always-on colour bar.

#### Geometry: why the bar is genuinely free

`OutputRow`'s CLI-group wrapper already carries `px-[var(--spacing-md)]`, and `--spacing-md` is
**8px** (`globals.css` 41). An `inset 3px 0 0` box-shadow on that wrapper paints inside the existing
padding with 5px of clearance before any content — no width consumed, no height added, no reflow,
and nothing for the estimator to model. It also sits outside the content box entirely, so it cannot
collide with diffs, which render full-bleed within that same padding.

**The one real implementation trap: keep the bar continuous.** `OutputRow` has two return paths, and
only the CLI-group path has the padded wrapper — `step-anchor`, `status`, `step-hidden`,
`final-step-label` and friends return bare (`OutputRow.tsx` ~1897). Those rows interleave with
content, so applying the shadow only on the CLI-group path leaves gaps and the bar reads as dashed —
the same failure mode that ruled out stamping the continuation rail per slice. Paint it on both
paths, or hoist it to a shared wrapper.

#### An escape hatch, since this is now always-on chrome

A persistent visual element every user sees on every run needs a way off. Fold a
`ui.stepColors.enabled` boolean into the same settings block (§4) — default true, and when false the
resolver returns nothing and every surface falls back to its pre-colour treatment.

#### Colouring the kind icon — a good secondary, not the primary

Painting `codicon-comment` (`WorkflowStep.tsx` ~330) / `codicon-terminal-powershell` (~292) in the
step colour is cheap, costs no layout, and is legitimate under §2 (a glyph is a shape, not a word).
Two reasons it should not be the _only_ channel:

- At 12px, low-chroma palette entries are hard to pick out, and the icon currently sits at
  `opacity-60` for a reason — at full saturation it competes with `StatusIcon` immediately beside it.
- Shape-mismatched correlation (glyph ↔ bar) is measurably harder to scan than bar ↔ bar.

Worth adding on top of the rail if the rail alone tests too subtle in a narrow panel. Keep the
codicon shape either way so prompt-vs-script survives a low-contrast hue.

- **`ParallelGroupPanel.tsx`** is the other natural surface and the previous revision missed it —
  it already draws a bordered `<section>` per group with a `codicon-type-hierarchy` header. Its
  member rows are `WorkflowStep`s, so they inherit the icon colour for free; consider whether the
  group header should show the member swatches as a legend.
- **`OutputMinimap` pills — do _not_ use these.** The previous revision called the minimap "arguably
  the best home" on the belief that `dotColorClass` (`OutputMinimap.tsx` ~741) encodes only
  selection state. It does not: it encodes **undo/redo availability** — `text-focus-border` when
  selected, `text-warning-fg` mixed, `text-terminal-ansiGreen` redo-available,
  `text-link-fg` undo-available, `text-description-fg` otherwise. Colour is already fully spent
  there and is load-bearing for the undo affordance. If the minimap must carry step colour, it needs
  a **separate channel** (e.g. a thin leading swatch beside the pill), not the pill's own colour.
- Output rows — the inset gutter bar (§2).

All surfaces must read from one resolver (`resolveStepColor(step, group, offset)`), not open-coded
copies, or they will drift the first time the seeding changes.

---

## Consequences for the estimator

Worth stating because this pane is unusually sensitive to it (see
`webview-react.instructions.md`, `<outputRowEstimates>`):

- Removing `step-switch` rows and per-slice labels **reduces row count**, which helps both the
  virtualization threshold and measurement stability.
- The stamping fix and `outputRowActivityChrome` must land together — see "Consequences for the fix"
  above. Today's +20-per-`activityFirst`-row charge is correct for today's (wrong) render, so it
  stays correct only if the flag and the label move in lockstep.
- If the activity label goes away for sequential runs, `outputRowActivityChrome` /
  `OUTPUT_ROW_ACTIVITY_LABEL_HEIGHT` must be gated the same way or it will over-estimate every
  opener row by 20px.
- An inset box-shadow bar adds **no** height and **no** width, so it needs no estimator support at
  all. This is a concrete reason to prefer it over `border-l` + padding.

---

## Suggested sequencing

1. ~~Settle the open question~~ — done: the predicate is right, the per-row stamping is wrong.
2. ~~Fix the stamping~~ — done: the label lands on the slice's first content row only; the rail
   stays per-row. Removed the duplicate `⚡ Step 1`; the rail is untouched and still needs 3/5.
3. Gate **markers 2 and 3 only** behind "step ran in a parallel group with ≥2 members", via a new
   snapshot-free `getParallelGroupForStep`. Marker 4 is not gated — it becomes the always-on colour
   bar in step 7. Largest remaining win, smallest change.
4. Delete the `step-switch` row kind.
5. **Land `resolveStepColor` on built-in harness defaults only** — no schema, no settings yet. Fix
   the two unusable `HARNESS_CHART_COLORS` entries (`codex-cli`, `opencode-cli`) and add the script
   default, then switch the three steps-panel rails from `getStepAccentClass` to
   `style={{ backgroundColor }}`. This is the whole visual payoff and it needs no persisted state.
6. **Add the status icon to the chip rail, then flip its border to identity.** In that order — the
   chip's border is its only status signal, so flipping first loses information for one commit.
   Prototype the three-row and two-row layouts here (§5).
7. Replace the output pane's continuation rail with the zero-width inset gutter bar reading the same
   resolver, painted on every row of every run. Watch the continuity trap: `OutputRow`'s non-CLI-group
   return path has no padded wrapper, so the bar must be applied on both paths or it reads as dashed.
8. `ui.stepColors` in `schemas/settings-schema.json` + `CtrlYokeSettings.ts` — the `enabled` escape
   hatch and the per-harness overrides. Higher priority than it looks now that the bar is always-on
   chrome.
9. Last, the authored `color?` field on a shared `StepDisplayProperties`. It is the most invasive
   piece (schema, parser, export, templates, mutations) and the least urgent — harness defaults plus
   group tie-breaking already deliver the correlation benefit.

Steps 2, 3 and 4 are worth doing regardless of whether the colour work ever happens. Steps 5–7 are
the colour work proper; 8 and 9 are persistence and can lag indefinitely.
