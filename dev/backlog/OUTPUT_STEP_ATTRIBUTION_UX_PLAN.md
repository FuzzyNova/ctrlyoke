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

Rows 1–3 are all emitted from `buildOutputRows` and all say the same thing. That is the first
screenshot exactly: `[10:41:20 AM] [💬 Step 4]`, then `→ Step 4`, then `⚡ Step 4`.

### Two things worth separating

**The rail (4) is not a step indicator — it is a "same step continues" indicator**, and it is the
only one of the five that costs horizontal space. `pl-2` (8px) is applied to continuation rows
only, so the output's left edge ragged-edges as you scroll past a switch. In a pane that is often
narrow, that is the complaint about lost width, and it is a fair one.

**A single colour is per-step; `output-streaming/40` is not.** The rail currently uses one shared
accent for every step, so it distinguishes "continuation" from "start" but tells you nothing about
_which_ step — the exact job it looks like it is doing. That mismatch is a large part of why it
reads as noise.

---

## Open question to settle before designing (do this first)

In the second screenshot, `⚡ Final Step Loop 1 · review` repeats before nearly every event.
`activityFirst` is computed as `previousActivityTargetKey !== targetKey`
(`outputRows.ts` ~1985 and ~2175), so **it should only fire when the writing step changes.** For it
to repeat on one target, targets must be alternating between those events — which the screenshot
does not show.

So one of these is true, and it changes the plan:

- **(a) The screenshot predates the row-key fix** (commit `18c0c19f`). Before it, every activity
  slice re-emitted a full `cli-header`. If so, much of the second screenshot is already gone and
  the remaining problem is smaller than it looks.
- **(b) `activityFirst` is genuinely over-firing** — e.g. an interleaved status activity for a
  different target flipping `previousActivityTargetKey` between slices. Then it is a bug, and
  "hide the label on sequential runs" would mask it while leaving it live on exactly the parallel
  runs the label exists for.

Reproduce on a current build before committing to a design. A probe over
`mapOrderedHistoryEntriesToMessages` + `buildOutputRows` with several same-target slices was
inconclusive because `mergeActivityEvents` coalesced them into one message — a faithful repro needs
slices that survive coalescing.

---

## Proposal

### 1. Attribution is a parallel-only affordance

On a sequential run the writer is unambiguous: rows are chronological and only one step can be
writing. Drop 2, 3, and 4 entirely there. The `cli-header` (1) already names the step once per
attempt, which is the right cadence, and the minimap (5) already gives spatial orientation.

The gate should be **"this step ran inside a parallel group with ≥2 members"**, not "the workflow
has a group" — a workflow with one parallel group and twelve sequential steps should show
attribution only inside the group. `getConcurrentGroupForStep` in `outputRows.ts` already computes
exactly this predicate and is already snapshot-validated, so the gate is nearly free.

This alone removes every marker from the first screenshot except the one that was always there,
and removes all of them from ordinary runs.

### 2. Colour as the parallel channel, painted in the gutter

Colour answers "which of the N concurrent writers is this?" without consuming a row. Two
constraints matter:

- **Never paint text in the step colour.** A user-supplied hex cannot be guaranteed legible against
  both light and dark VS Code themes, and the pane already spends colour semantically (error red,
  streaming blue, diff add/remove). Restricting the colour to a 3px bar and a dot sidesteps
  contrast entirely — a bar only has to be _visible_, not _readable_.
- **Do not use `border-l` + `pl-2`.** Use `box-shadow: inset 3px 0 0 <colour>` on the row, or paint
  into `OutputRow`'s existing `px-[var(--spacing-md)]` gutter. Both cost **zero layout width and
  zero height**, which also means the estimator does not have to model them at all — a real
  advantage given how sensitive the virtualizer is to row-height changes.

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

**A** is what `ActivityAttribution` was reaching for, and if the open question above resolves to
(b), the real defect is that it fires far more often than "once per contiguous run". Fixing the
predicate plus gating on parallel may land close to the desired result without removing the label.

**B** is defensible if the steps panel accent (below) is prominent, and it is strictly the
lowest-noise option. Worth prototyping both — the difference is one boolean.

Either way, `step-switch` rows (2) should go. A full-width `border-y` bar per transition is the
heaviest of the three markers and the most redundant.

### 4. Per-step colour in the workflow file

**Schema.** An optional `color?: string` on steps, `^#[0-9a-fA-F]{6}$` in
`schemas/workflow-schema.json`. `PromptStep` and `ScriptStep` are separate interfaces
(`CtrlYokeTypes.ts` ~724 and ~739) with no shared display base, so this wants a small shared
`StepDisplayProperties` rather than being duplicated onto both — the parser, export, template, and
mutation paths all round-trip step fields and each would otherwise need the key twice.

**Default.** Absent → no colour, no bar. Matches the "sequential runs show nothing" rule and means
existing workflows change nothing on upgrade.

**Seeded colours for parallel.** Seed from a **stable identity, not the step index** — indices
shift on reorder, insert, and rewind, so an index seed would recolour a step mid-run.
`ParallelGroupDefinition.id` (a `crypto.randomUUID()` assigned at normalization) plus the member's
offset within the group is stable across everything except regrouping.

Pick from a **fixed curated palette** (8–10 hues) rather than raw HSL. Random HSL produces
near-duplicates, muddy low-chroma values, and occasional collisions with the semantic red/green the
pane already uses. A small hand-picked categorical palette avoids all three and stays legible in
both themes. A group larger than the palette wraps — acceptable, since members are adjacent and
`failFast`-bounded, and concurrency is capped anyway.

**Explicit colour wins over the seeded one** when both apply.

### 5. Correlation surfaces must single-source the colour

If colour is the attribution channel it has to appear in every place the user looks:

- `WorkflowStep.tsx` — a 3px left accent on the row. **Note the collision:** that component's
  docstring already reserves a "green left accent" for the `dimmed`/completed treatment
  (`WorkflowStep.tsx` ~87). Those two accents cannot both own the left edge; decide whether step
  colour replaces it, or moves to a dot beside the status icon.
- `OutputMinimap` pills — currently coloured only by selection state (`dotColorClass`,
  `OutputMinimap.tsx` ~741). This is arguably the _best_ home for the colour, since the minimap is
  already the step-correlation surface and has room.
- Output rows — the inset gutter bar.

All three must read from one resolver (`resolveStepColor(step, group, index)`), not three
open-coded copies, or they will drift the first time the seeding changes.

---

## Consequences for the estimator

Worth stating because this pane is unusually sensitive to it (see
`webview-react.instructions.md`, `<outputRowEstimates>`):

- Removing `step-switch` rows and per-slice labels **reduces row count**, which helps both the
  virtualization threshold and measurement stability.
- If the activity label goes away for sequential runs, `outputRowActivityChrome` /
  `OUTPUT_ROW_ACTIVITY_LABEL_HEIGHT` must be gated the same way or it will over-estimate every
  opener row by 20px.
- An inset box-shadow bar adds **no** height and **no** width, so it needs no estimator support at
  all. This is a concrete reason to prefer it over `border-l` + padding.

---

## Suggested sequencing

1. Settle the open question — is the repeated label a stale screenshot or an over-firing predicate?
2. Gate 2/3/4 behind "step ran in a parallel group with ≥2 members". Largest win, smallest change,
   independent of everything below.
3. Delete the `step-switch` row kind.
4. Replace the rail with a zero-width inset gutter bar in a per-step colour, seeded from the group
   id. Steps panel + minimap read the same resolver.
5. Only then add the authored `color?` schema field. It is the most invasive piece (schema, parser,
   export, templates, mutations) and the least urgent — the seeded colours deliver the correlation
   benefit on their own.

Steps 2 and 3 are worth doing regardless of whether the colour work ever happens.
