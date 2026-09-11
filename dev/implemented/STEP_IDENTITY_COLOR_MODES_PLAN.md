# Step Identity Color Modes — a unique color per step

> **Status:** Implemented — all seven sequencing steps landed 2026-09-06.
> Recorded follow-ups: the CVD-safe named palette (`ui.stepColorPalette`, §3a) and the
> `name`-as-cosmetic decision (§7). This is a follow-on to
> [`OUTPUT_STEP_ATTRIBUTION_UX_PLAN.md`](./OUTPUT_STEP_ATTRIBUTION_UX_PLAN.md)
> (landed 2026-09-04/05), which established the left edge as the step identity channel and
> `resolveStepColor` as the single resolver every surface reads.

## Problem

The identity color's job is **correlation across panes** — match the 2px bar beside step 4 in the
steps panel to the 2px bar on its rows in the output pane, to its chip in the collapsed rail. The
implemented design does that with `HARNESS_CHART_COLORS`, so the color also carries "which harness".

For anyone who runs one harness — the common case — that makes the whole channel inert: every bar
in every pane is the same orange, and correlation is impossible. The one place a second color
appears is `getTieBreakColor`, and it only fires **inside a parallel group of ≥2 members whose base
colors actually collide** (`stepColor.ts` `resolveStepColor`). Sequential runs never see it.

The ask: make "unique color per step" a first-class mode, selected from a dropdown rather than the
current on/off checkbox.

## What exists today

| Piece                                               | Where                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `resolveStepColor` (the single resolver)            | `src/ui/webview-react/utils/stepColor.ts`                                               |
| `resolveHarnessColor` (harness palette)             | same file — also feeds the **stats harness-share bar**                                  |
| `HARNESS_CHART_COLORS`, `SCRIPT_STEP_DEFAULT_COLOR` | `src/types/DashboardConstants.ts:1610`, `:1620`                                         |
| `STEP_COLOR_TIE_BREAK_PALETTE` (8 entries)          | `src/types/DashboardConstants.ts:1636`                                                  |
| Settings shape `HarnessColorSettings`               | `src/types/CtrlYokeSettings.ts:70`, used at `:245`, defaulted at `:514`                 |
| Schema                                              | `schemas/settings-schema.json:737`                                                      |
| Extension → webview plumbing                        | `ConfigurationUtils.ts:265` → `WebviewSettingsSync.ts:911` → `settingsStore.ts:130,423` |
| Enable toggle + script swatch                       | `GeneralSection.tsx:119-143`                                                            |
| Per-harness swatches                                | `HarnessesSection.tsx:184-212`                                                          |

Five call sites resolve a step color, and **every one already has the step's flat index in hand**:

| Surface                               | Call site                     |
| ------------------------------------- | ----------------------------- |
| Steps panel, completed slice          | `WorkflowStepsPanel.tsx:1502` |
| Parallel group members                | `ParallelGroupPanel.tsx:347`  |
| Pending/sortable step rows            | `WorkflowStepRow.tsx:248`     |
| Collapsed chip rail                   | `PromptChipRail.tsx:386`      |
| Output rows (memoized per target key) | `outputRows.ts:1933`          |

When the resolver returns `undefined`, each surface falls back to `getStepAccentClass(status)`
(`utils/status.ts:105`) — green/red/blue by status. That fallback is what "off" means today.

---

## 1. The setting: a new mode, and `ui.harnessColors` left alone

`ui.harnessColors` is **not** a step-color block that happens to be keyed by harness — it is the
harness identity palette, and it has a second consumer that has nothing to do with steps:
`HarnessShareBar.tsx:51` paints the workspace harness-share bar through `resolveHarnessColor`. So it
keeps its name and its `byHarness`/`script` entries, unchanged, and stays meaningful in every mode.
`script` belongs there too: it is the "no harness" entry of the same palette, which is exactly what
`resolveHarnessColor(undefined, settings)` returns.

The only thing that moves is `enabled`. It is not a property of the harness palette — it is a
statement about how _steps_ get colored — and it is what the new mode replaces:

```jsonc
// schemas/settings-schema.json
"ui": {
  "stepColorMode": "unique",                   // NEW: "off" | "harness" | "unique"
  "harnessColors": {                           // UNCHANGED, minus `enabled`
    "byHarness": { "claude-cli": "#d18616" },
    "script": "#808080"
  }
}
```

Flat rather than a `ui.stepColors: { mode }` object because it is one choice with no siblings; the
knobs a rainbow might eventually want (ring size, tier count) belong in generated constants, not in
user settings, and the one plausible second setting — a named palette, §3a — is its own flat enum.
`"off" | "harness" | "unique"` are compared with `===`, so they must be a
`STEP_COLOR_MODES` const object in `DashboardConstants.ts` with a derived union type, per the
project's no-hardcoded-flow-control-strings rule — not a bare string union.

Consequences worth naming, since they are the whole cost of this shape:

- `HarnessColorSettings` (`CtrlYokeSettings.ts:70`) loses `enabled` and gains nothing.
  `resolveStepColor` currently gates on `settings?.enabled === false`; it instead takes the mode as
  its own field in `ResolveStepColorOptions`. Every call site already reads `globalSettings`, so this
  is one extra property at five sites plus `BuildOutputRowsInput`.
- `HarnessesSection.tsx:186` describes the swatch as applying "when step colors are enabled". That
  sentence becomes wrong in two directions — the color still paints the share bar in `off`, and does
  not paint steps in `unique` — so it needs rewording regardless.

### Mode semantics

| Mode                   | Step bar                                                                     | Harness-share bar |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------- |
| `off`                  | nothing — surfaces fall back to `getStepAccentClass`                         | harness colors    |
| `harness`              | harness color; a colliding parallel member falls through to its unique color | harness colors    |
| `unique` **(default)** | a distinct color per step; the collision path never fires                    | harness colors    |

### "Should parallel steps always be unique, regardless of the mode?" — no

Taking the three modes in turn:

- **`unique`** — already true by construction. Nothing to decide.
- **`harness`** — already true _where it matters_, and deliberately not where it doesn't. The
  collision check only fires when two members of a `≥2` group resolve to the same base color, so a
  `claude-cli` + `codex-cli` group keeps orange and red: unambiguous _and_ still telling you which
  harness is which. Forcing rainbow there would trade a signal for nothing. Collision-only is
  strictly better than always-on.
- **`off`** — this is the real question, and the answer is still no, for a reason stronger than the
  aesthetic one.

The aesthetic argument stands: _a 2px left border must not mean two different things_. In `off` the
rail means status, so coloring parallel members by identity puts both meanings in one panel with no
visible boundary between them.

But the argument that actually settles it is that **`off` does not cost you parallel attribution in
the first place.** The `⚡ Step N` label above each activity slice is gated on
`getParallelGroupForStep(input.parallelGroups, target.index) !== undefined` and nothing else
(`outputRows.ts:2062-2065`, `:2248-2250`), and `ActivityAttribution` renders off `row.activityFirst`
with a fixed `text-output-streaming` icon (`OutputRow.tsx:275-300`). Neither reads the color
settings. So a parallel run is text-labelled in every mode, including `off` — and text is the
_stronger_ attribution channel anyway, which is exactly why the implemented plan kept it for parallel
groups and dropped it everywhere else.

`off` is now a deliberate opt-out from a default that colors everything. Overriding it would be
answering a question the user already answered.

### Rejected: an `auto` mode

"Harness colors when the workflow uses >1 harness, unique when it uses one" reads well and behaves
badly: changing one step's harness silently repaints every other step in the workflow. The meaning of
the channel must not depend on workflow contents.

### Default: `unique` (decided)

Correlation across panes is the channel's stated primary job, and under `harness` that job fails
outright for single-harness users, which is most of them. Harness identity keeps two dedicated
surfaces — the share bar, and the harness/model text on each expanded step row — so making it the
_secondary_ signal loses less than making correlation the secondary signal does.

The accepted cost: multi-harness users lose an at-a-glance harness read in the chip rail, which has
no harness text. It is a one-dropdown change back.

---

## 2. What seeds a unique color

**This is the load-bearing decision, and it is constrained by a fact worth stating up front: a step
has no stable identity.** `PromptStep`/`ScriptStep` (`CtrlYokeTypes.ts:740`, `:752`) carry no id.
`ParallelGroupDefinition.id` (`:775`) is the only `crypto.randomUUID()` in the model, which is
exactly why `getTieBreakColor` seeds from it today — and why that seeding cannot be reused here, since
a sequential step belongs to no group at all.

| Option                                            | Verdict                                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Step index (slot order)**                    | **Chosen.** No new state, and it is the only option that produces an actual _rainbow_.                                                                                                                          |
| B. Hash of step name/content                      | Rejected. Renaming or editing a prompt recolors the step — strictly worse than A — and hashed hues land in random adjacency, so two neighbors can be near-identical.                                            |
| C. New persisted `id?` on `StepDisplayProperties` | Rejected. An opaque UUID in every authored YAML step, generation on parse/insert/paste, collision handling on duplicate — and it still hashes to a random hue, so it buys stability at the cost of the rainbow. |
| D. Materialize `color` on step creation           | Rejected. Writes hex into every workflow file, makes diffs noisy, and erases the authored-vs-derived distinction the reset affordance depends on.                                                               |

**Index seeding's one real cost: reorder, insert, and delete recolor steps.** That is worth accepting
because the color's contract is _simultaneous_ agreement across panes, not agreement across edits —
every surface derives from the same live `steps` array and the output pane addresses rows by the same
flat index, so all five surfaces repaint together and can never disagree at any instant. The only
casualty is memory ("step 4 was teal yesterday"), which the slot number already serves better.

Two consequences to get right:

- **Slot number ≡ index + 1** on both branches of the steps panel (`WorkflowStepsPanel.tsx:1461`,
  `:1604`), so an index-seeded rainbow runs top-to-bottom in the visible numbering. That is a feature:
  the ramp doubles as a position ruler.
- **The final step needs an index.** `outputRows.ts` resolves it via `input.finalStep` with no index
  (`:1914-1917`). Seed it with `steps.length` so it takes the slot after the last step rather than
  colliding with step 1. Note also that the final step gets a color _only_ in the output pane today —
  neither `WorkflowStepsPanel` nor `FinalStepChip` passes one. Fixing that asymmetry is cheap and
  belongs in this change.

---

## 3. The palette

### The order is fixed, and that is the point

Index seeding already makes this deterministic: **step 1 is always the first palette entry, in every
workflow, forever.** Nothing is hashed, nothing depends on workflow contents, and the panel numbering
runs in the same order as the palette. "Step 1 is red, step 2 is orange" becomes learnable, and the
color stops being a lookup and starts being a second name for the slot.

Two things follow that are worth stating because they constrain everything below. Learnability comes
from the _seed_, not from the palette being a gradient — any fixed ordering is equally learnable. And
the palette must therefore be **stable across releases**: re-tuning a hue after ship silently
retrains every user. Treat the generated table as a frozen artifact once it lands, which is the
strongest argument for getting the property test (§6) in first.

### Generate in OKLCH

HSL hue is perceptually non-uniform: even hue steps give a wide band of near-identical greens and a
narrow, muddy blue/purple range. Generate at fixed L and C, reducing C per hue only as far as needed
to stay in sRGB gamut.

### 8 hues × 3 lightness tiers, walked in rainbow order

**This supersedes an earlier draft of this plan that proposed 16 hues assigned with a coprime stride
(`(i * 7) % 16`) to keep neighbors apart.** The stride was solving a problem created by the ring
being too fine, and the numbers do not support it. Minimum ring separation across the first _k_
steps, in units of 22.5°, for every stride coprime to 16:

| stride | k=2 | 3   | 4   | 5   | 6   | 7   | 8   | 9+  |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- |
| 1      | 1   | 1   | 1   | 1   | 1   | 1   | 1   | 1   |
| 3      | 3   | 3   | 3   | 3   | 1   | 1   | 1   | 1   |
| 5      | 5   | 5   | 1   | 1   | 1   | 1   | 1   | 1   |
| 7      | 7   | 2   | 2   | 2   | 2   | 2   | 1   | 1   |

Every stride collapses to 22.5° by k=8, because 16 hues at one lightness cannot do better — the
ceiling is the ring size, not the ordering. Paying for that with a scrambled order buys ~2 steps of
headroom and gives up the rainbow entirely.

Halving the ring and spending the difference on lightness is strictly better:

```
ring N = 8 hues, 45° apart        tier = floor(index / 8)   hue = index % 8
3 tiers, each shifted 15° and to a different lightness  →  24 slots
```

- **Steps 1–8 are 45° apart at one lightness** — comfortably distinguishable, and in plain rainbow
  order, which is exactly the "step 1 red, step 2 orange" model. Most workflows never leave tier 0.
- **Steps 9+ differ from their tier-0 counterpart by lightness _and_ 15° of hue.** The tier offset
  interleaves rather than merely re-shading, so tiers 0 and 1 together give 16 distinct hues in which
  every 22.5° pair is _also_ lightness-separated — better than 16 hues at one lightness, which was
  the best the stride scheme could manage.
- Tier lightness moves **away from the background**, so its direction is theme-dependent. That falls
  out for free from generating two tables.

`stride = 1` is now the right default rather than a fallback, and ring size / tier count stay
generator constants if 8 proves too few in practice.

### Two tables, light and dark — and ship hex, not `oklch()`

A single mid-lightness ramp _could_ serve both themes, since the color is only ever a 2px bar, a
swatch, or (optionally) a glyph — never readable text, per the implemented plan's §2 rule, so it must
be _visible_, not _legible_. But the tiers have nowhere to go without a theme-appropriate direction,
so generate two tables.

**Generate them offline into hex constants** (`scripts/generate-step-palette.mjs`, wired into
`precompile` alongside the existing `generate-*` scripts) rather than emitting `oklch()` into CSS.
The deciding constraint is the color picker: `getInheritedStepColor` / `getHarnessStepColorPickerValue`
regex-extract `#rrggbb` to feed `<input type="color">`, which accepts nothing else — so under
`unique` mode the header quick picker's "inherited" value needs a real hex. Static hex also keeps the
values reviewable in diffs and sidesteps browser color-space support in the hosted client entirely.

Shipped generator output (hue ring from 0°, 15° tier offset, chroma clipped to gamut; `L`
0.78/0.88/0.92 dark and 0.58/0.54/0.48 light):

```
DARK   tier 0  #ff8fb4 #ff996a #dfb100 #82d04f #00d4bb #00cafe #9cb4ff #df94ff   (steps 1–8)
       tier 1  #ffc7ca #ffcca3 #eadd24 #72f896 #00f6f6 #b1deff #d3d3ff #ffbff8   (steps 9–16)
       tier 2  #ffdbd5 #ffdfb4 #d6f55b #8effd0 #acf2ff #d4e6ff #e9deff #ffd8ec   (steps 17–24)

LIGHT  tier 0  #c93f76 #c65100 #967600 #498f00 #008e7d #0087ab #526ee3 #a151c2
       tier 1  #c0304c #a25900 #797200 #00853c #007f7f #0076af #6857d1 #a53d9f
       tier 2  #ac1c0f #7e5400 #566600 #006f4f #006a77 #005bb4 #6f3bb2 #9d1f74
```

The property test keeps every entry at least 8 CIEDE2000 units from the fallback and indicator
accents, and raises the tier-0 adjacent-pair bar to 18 units. This tuned output avoids the muddy
light tier-1 band and the near-`indicator-error` light tier-0 red from the illustrative sample.

### Delivery: CSS custom properties, with a hex helper for the picker

Emit the tables as `--fp-step-hue-0 … --fp-step-hue-47` in `globals.css`, defined on `:root` with the
dark values and overridden under `body.vscode-light, body.vscode-high-contrast-light` — matching the
existing `color-scheme` block at `globals.css:145-153`, which already treats
`vscode-high-contrast` as dark and `vscode-high-contrast-light` as light. The resolver then returns
`var(--fp-step-hue-N, #<dark hex>)`, **the exact shape `HARNESS_CHART_COLORS` already returns**, so
all five painting surfaces need no change at all and theme switches repaint with zero React work.

The picker is the one consumer that needs a literal, and it must not silently take the dark fallback
on a light theme. Add a small `getStepPaletteHex(index, themeKind)` reading theme kind the way
`codemirrorTheme.ts:222-229` already does — body class first, `--fp-color-theme-kind` second (the
synthetic var set at `useMessageHandler.ts:283-289` and mirrored to the hosted client by
`standalone-shim.js:248`, which is what makes this work in the browser).

---

## 3a. Can users change the palette?

**Not entry by entry, and the reason is not paternalism — it is that the invariants cannot survive
it.** The table is 48 values (24 slots × light/dark). There is no sane settings control for that, and
every guarantee the palette carries is enforced at build time by the property test in §6: mutual
perceptual separation, distance from the six harness colors and the `indicator-*` accents, sRGB
gamut, light/dark parity. A user-supplied array satisfies none of them and degrades the feature
silently — and `ui.harnessColors.byHarness`, which _is_ per-entry editable, only works because it has
six entries with names users recognize. "Slot 11" is not that.

Three escape hatches already exist or should, in ascending order of how much they cost to build:

1. **`step.color` — already shipped, and already the right hatch.** It is authored in the workflow
   file, so it travels with the workflow, shows up in diffs, and is reviewable; it wins over the
   palette in every mode (precedence rule 1); and its reset writes `undefined` rather than a hex
   equal to the default, so a reset step returns to following the palette. That covers the real
   authoring need — "this step is the deploy, make it red" — which is per-step and per-workflow, not
   global.
2. **`ui.stepColorMode: "harness"`** already exists as the global "I don't want a rainbow" answer,
   and `"off"` as the "I don't want any of this" answer.
3. **Named palettes, not custom ones** — `ui.stepColorPalette: "rainbow" | …`, a second enum
   generated by the same script and validated by the same test. Structure the generator to emit
   _named_ tables from day one so adding one later is a data change rather than a refactor, but ship
   only `rainbow`.

### The named palette that actually earns building: color-vision-deficiency safe

This is the one gap `step.color` genuinely cannot fill. An 8-hue rainbow collapses red/green/brown
for deuteranopia and protanopia (~8% of men), and the per-step override cannot fix it — you would
have to author a color on every step of every workflow. A CVD-safe table trades hue range for a
blue↔yellow axis plus wider lightness separation, which fits this palette's structure directly: fewer
hues per tier, more tiers.

It is a fast-follow rather than a v1 blocker, and the reason is worth recording so nobody
re-litigates it: **the color is decorative-redundant everywhere it appears.** Every surface that
paints a step color also shows the slot number and, since the chip-rail work in the implemented plan,
a status icon. A CVD user does not get _wrong_ information, they lose a shortcut — the feature
degrades toward `off`, which is a supported state.

### One interaction to accept rather than fix

In `unique` mode an authored `step.color` can duplicate another step's generated color. Do not try to
detect it: the only way to resolve a collision would be to move the _other_ step's color, so
authoring a color on step 3 would silently repaint step 9. That is a worse surprise than two similar
bars, and it would require every surface to know every authored color in the workflow. The user
picked the color and can see the result.

### `off` still suppresses authored colors — keep it that way

`resolveStepColor` checks the disabled state _before_ reading `step.color` (`stepColor.ts:131-133`),
so `off` drops authored colors too. Re-affirming rather than changing it: in `off` the rail means
status, and honoring an authored color would put identity and status in one panel with no visible
boundary — the same reasoning that settles the parallel question in §1. `off` means off.

---

## 4. Precedence

```
1. mode === "off"                 → undefined (surfaces fall back to status),
                                    checked first so it drops authored colors too — see §3a
2. step.color                     authored — wins over every palette, unchanged
3. mode === "unique"              → getUniqueStepColor(stepIndex)
4. mode === "harness"             → getUniqueStepColor(stepIndex), when a ≥2-member parallel
                                    sibling resolves to the same base color
5. mode === "harness"             → ui.harnessColors.byHarness[harness] / .script
6. mode === "harness"             → HARNESS_CHART_COLORS[harness] / SCRIPT_STEP_DEFAULT_COLOR
```

### One palette, and the tie-break collapses into it

`STEP_COLOR_TIE_BREAK_PALETTE` (`DashboardConstants.ts:1636`) is **deleted**, and rules 3 and 4 call
the same `getUniqueStepColor(stepIndex)`. That is a bigger simplification than swapping one array for
another, because the tie-break's _resolution_ logic goes with it:

| Deleted                                                                          | Why it is no longer needed                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STEP_COLOR_TIE_BREAK_PALETTE` (8 curated entries)                               | Superseded by the generated ring.                                                                                                                                                                                                       |
| `hashSeed` (FNV-1a)                                                              | The seed is the step index, which is already unique per step.                                                                                                                                                                           |
| `getTieBreakColor`'s forward scan over `forbiddenColors`                         | Distinct indices give distinct hues by construction; nothing to scan past.                                                                                                                                                              |
| The group-id seeding, and with it the **power-of-two palette-length constraint** | That whole invariant — plus the review-pass note warning that growing 8 → 9 silently regresses ~1.5% of groups — exists only to make `hashSeed(groupId:offset) % length` collision-free. Index seeding has no modulus problem to solve. |

What survives is only the _detection_ half: `groupMembers` still has to be built so the resolver can
see that two members share a base color. That stays `harness`-mode-only, so under the `unique`
default the surfaces can skip constructing it entirely — the three surface-local `groupMembers`
builders (`WorkflowStepsPanel`, `PromptChipRail`, `outputRows`) become dead work in the default path
and should be guarded on the mode rather than always computed.

Two properties the old curated palette gave for free, which the generator must now guarantee
instead — see §6:

- **Distance from the six harness colors.** Curation handled this by hand; string-equality scanning
  never could, since `var(--vscode-charts-blue, #59a4f9)` and a near-identical rainbow hex are
  different strings. It becomes a generator constraint plus a test, which is the stronger form.
- **Distance from the semantic `indicator-*` accents**, for the same reason.

### Resolver signature

The resolver gains one required argument, `stepIndex`, supplied by the caller exactly as `harnessId`
already is. All five call sites have it (§"What exists today"); `outputRows.ts` additionally needs
`steps.length` for the final-step target.

---

## 5. Surfaces

**No painting surface changes.** The bar geometry, the `pl-[3px]` offset on the non-CLI-group output
path, and the estimator are all untouched — this changes which string the resolver returns, nothing
about how it is drawn. In particular, keep `getStepIdentityBarStyle` (`components/output/outputStyles.ts`)
as the `linear-gradient`: the `box-shadow: inset` form leaks a hairline of the accent along a
fractionally-positioned row's top and bottom edges, which is why it is a gradient today.

Settings UI:

- `GeneralSection.tsx:119-126` — swap the "Show step identity colors" `SettingToggleRow` for a
  `CustomSelect` in a `SettingInputRow` at `path="ui.stepColorMode"` (Off / Harness color / Unique
  per step). The parity suite (`src/test/integration/settingsSchemaUiParity.integration.test.ts`)
  matches on that literal `path` prop, so schema, section, and any `PENDING_UI_PARITY` entry move
  together — and `ui.harnessColors.enabled` must disappear from the schema in the same commit or the
  suite fails on a property with no control.
- `GeneralSection.tsx:127-143` — the script swatch stays where it is (it is a `ui.harnessColors`
  path, and moving it into `HarnessesSection` would put a non-harness row in a per-harness loop), but
  its description should say it applies in `harness` mode.
- `HarnessesSection.tsx:184-212` — leave the per-harness swatches **enabled in every mode**; they
  drive the share bar regardless. Only the description at `:186` changes.

Not in scope:

- **The minimap.** `40b2fafb` deliberately removed both the step color bar and the activity band from
  the minimap as noise, after `263e9b7b` added them. Do not reintroduce them here.
- **Coloring the kind icon.** Still available as a secondary channel (implemented plan §5) if the
  2px rail tests too subtle, but it is independent of this work.
- **A user-editable palette.** See §3a — `step.color` is the authoring hatch, and a CVD-safe named
  palette is the follow-up.

---

## 6. Testing

- `test/utils/stepColor.test.ts` — one case per mode; `off` returns `undefined`; `unique` ignores
  `byHarness` but still honors `step.color`; `harness` still resolves harness colors for a
  non-colliding group and unique colors for a colliding one. The existing tie-break cases get
  rewritten rather than deleted: same scenario, new expected values, which is what proves the
  collision _detection_ survived the removal of the collision _resolution_.
- A **palette property test**, now load-bearing in a way it was not when the palette was curated by
  hand. All 24 slots are distinct; no entry lands within a minimum perceptual
  distance of a `HARNESS_CHART_COLORS` fallback, `SCRIPT_STEP_DEFAULT_COLOR`, or an `indicator-*`
  value; and every adjacent-by-index pair clears that same distance, with tier 0 (steps 1–8) held to
  a higher bar than the cross-tier pairs. Assert against **both** the light and dark tables. This
  test is what replaces the deleted curation, so it has to fail loudly on a well-meaning palette
  tweak — write it before the generator, not after.
- A **stability snapshot** of both generated tables. The palette is learned by users (§3), so a
  post-ship hue tweak is a user-visible regression, not a refactor. An inline-snapshot test makes
  changing it a deliberate, reviewed act rather than a side effect of touching the generator.
- Surface tests: `WorkflowStepsPanel.test.tsx` and `PromptChipRail.test.tsx` already assert resolved
  rail colors; add a `unique`-mode case to each and one asserting the final step does not collide
  with step 1.
- Parity suite green: `ui.stepColorMode` has a control, `ui.harnessColors.enabled` no longer exists.

## 7. Editing a color on a completed step must not rewind the run

Folded in here rather than split out, because it exists only because `step.color` exists — but note
the mechanism it introduces (classify the _change_, not the step) is general, and would broaden if
another cosmetic field is ever added.

### What happens today, and why

`PromptEditor` sets `rewindCompletedStep: true` whenever the edited step is completed —
`isPromptCompleted` is derived from status alone (`PromptEditor.tsx:272`) and spread into the
`UPDATE_PROMPT` message at `:681`, `:1060`, and `:1094` **without looking at what actually changed**.
`WorkflowStepHandlers.handleUpdatePrompt` (`src/ui/WorkflowStepHandlers.ts:91-104` — note it
lives under `src/ui/`, not `src/core/orchestration/`) routes that to
`WorkflowOrchestrator.updateCompletedPromptInQueue`, which calls `setStartPositionAtRun` to establish
a durable pending rewind _before_ applying the edit.

That is correct, and deliberately so, for every field it was designed for: the pre-edit snapshot is
what lets Discard Continuation restore the exact completed definition. It is wrong for `color`
because `color` is the one editable field that feeds nothing but `resolveStepColor`. Rewinding a
finished run to record that a bar is now red destroys real continuation state to persist a fact with
no bearing on what the run did.

### The rule: classify the change, not the step's status

When the diff between the pre-edit step and the submitted step touches **only** cosmetic fields,
write it in place against the run's own definition and leave `_runtime`, the start position, and the
continuation state untouched.

**Do not express this as a client-asserted boolean.** A `cosmeticOnly: true` flag on `UPDATE_PROMPT`
would let a stale or buggy client smuggle a prompt change through the in-place path. Send it as its
own message carrying _only_ the changed cosmetic fields, so there is nothing else it could change —
which lands on machinery that already exists and has no caller:

- `WorkingFileManager.updateStepAtRun` already accepts `{ updates: Partial<WorkflowStep> }`
  (`:1336-1338`). Every current caller goes through `buildPromptStepChange`
  (`WorkflowOrchestrator.ts:237-257`), which only ever returns `{ replace }`. The patch shape is
  already there, waiting for exactly this.
- `applyRunAddressedMutation` already takes `invalidation: "properties"` for edits that leave steps
  and output untouched — see `updateWorkflowName` (`WorkflowOrchestrator.ts:3794-3816`) and its
  reasoning about not forcing a full `RUN_VIEW_LOADED` snapshot. A cosmetic step edit is that same
  class. **Verify the properties push actually carries the changed step field to viewers** before
  reusing it; a rename had a dedicated `WORKFLOW_NAME_UPDATED` broadcast doing that work, and a color
  change has no equivalent yet.

### What counts as cosmetic: `color` only

`StepDisplayProperties` is **not** the right set, and reaching for it is the trap here — it carries
`enabled`, which gates execution outright. The cosmetic set is its own list, and for now it is
exactly `{ color }`.

`name` is the interesting case and the recommendation is **not yet**. It is runtime-inert: there is
no name-based step lookup anywhere in `src/core`, and `step.name` appears only in log and label
strings (`WorkflowExecutor.ts:692`, `:1740`, `:3721`) plus seeding a _new_ workflow's name
(`WorkflowInstance.generateWorkflowNameFromPrompt:5878`). But inert is not the same as cosmetic: a
name is a **label of record**. It is written into that run's own logs and step labelling, so
retroactively renaming a step on a historical run edits the description of what happened, which
recoloring cannot do. Ship `color`, and treat `name` as a separate decision with that argument on the
table.

### Three things to get right

- **`_runtime` survives the partial update — verified, and by the same mechanism both branches
  already use.** `updateStepAtRun` (`WorkingFileManager.ts:1331`) does not hand `change` straight to
  `replaceParallelGroupStep`; it first runs `mergeWorkflowStepUpdate(steps[index], incomingStep, …)`
  (`WorkflowStepSanitizer.ts:554-568`), which returns `{ ...existingStep, ...incomingStep }`. The
  disk-head step carries `_runtime`, an incoming patch has no `_runtime` key, so the field is
  inherited rather than reconstructed. A `{ updates }` patch therefore gets the same protection the
  `{ replace }` path gets today, with no change to `WorkingFileManager` — assert it in the test
  rather than building for it. (The one escape hatch: `mergeWorkflowStepUpdate` returns
  `incomingStep` outright on a prompt↔script type change, which a cosmetic patch can never be.)
- **Keep the edit undoable.** `isStepContentEqual` (`workflowStore.ts:80`) ignores only `status` and
  `_runtime`, so a color change already registers as an undoable content change. Do **not** add
  `color` to its ignore list while implementing "cosmetic" — cosmetic means "does not rewind the
  run", not "is not tracked".
- **Step 0 is a second, separate symptom and is not fixed by this rule alone.** The rewind branch is
  guarded on `index > 0` (`src/ui/WorkflowStepHandlers.ts:93`), so index 0 never took it; the observed
  "creates a new draft" comes from the step-zero full-rerun path that
  `handleUpdatePrompt`'s else-branch comment describes. Reproduction confirmed that routing symptom:
  index 0 enters that ordinary branch because of the guard. With a valid addressed run mutation, the
  write still stays on that run and does not create a draft; the new-draft observation therefore needs
  a separate stale/missing-address reproduction. The color-only message bypasses this branch entirely,
  so recoloring takes the same in-place path at every index.

- **Viewer push result.** `invalidation: "properties"` carries workflow-level fields only; it drops
  `steps`, so it cannot carry a changed step color. The implementation adds the narrow
  `STEP_COLOR_UPDATED` broadcast (index + color + revision), while retaining the lightweight
  properties-style invalidation and avoiding `RUN_VIEW_LOADED`.

### Testing

An end-to-end test is the only one that proves this: edit the color of a completed nonzero step on a
historical run, then assert the run's `workflow.ctrlyoke.json` has the new color, the step's
`_runtime` block is byte-identical, and no `pendingRewind` was created. Add the mirror case at index
0, and a negative case — a prompt edit on the same completed step still rewinds — so the
classification cannot silently widen.

Implemented in `WorkflowOrchestrator.test.ts`: both index 0 and index 1 are edited through the
addressed historical-run path, with exact `_runtime` assertions, no pending-rewind file, and no full
run-view broadcast. The existing completed-suffix prompt-edit test remains the negative rewind case;
the webview test also verifies that a color-only editor submission carries no prompt payload or rewind
flag.

---

## 8. Sequencing

1. ✅ **Done.** Move `enabled` out: drop it from `HarnessColorSettings`, the schema, and the defaults; add
   `STEP_COLOR_MODES` + `ui.stepColorMode` through `CtrlYokeSettings`, `ConfigurationUtils`,
   `WebviewSettingsSync`, `settingsStore`, and `ResolveStepColorOptions`. `ui.harnessColors` is
   otherwise untouched. `src/test/unit/CtrlYokeConfigService.test.ts:586-600` writes and asserts
   `ui.stepColorMode` alongside the palette; the schema's `additionalProperties: false` means the
   schema, `CTRLYOKE_SETTINGS_DEFAULTS`, and that test have to change in the same commit or nothing
   validates. Behavior-neutral: `"off"`/`"harness"` reproduce today exactly, so this ships
   and is reviewable on its own. The step-1 default remains `"harness"`; the final `"unique"`
   default is intentionally deferred to step 6.
2. ✅ **Done.** Write the palette property + stability tests (§6), then `scripts/generate-step-palette.mjs`, the
   generated constants, and the `globals.css` variable blocks until they pass. Nothing consumes them
   yet, and the tests are what carry the guarantees the old curated palette carried. Have the
   generator emit _named_ tables (`rainbow` for now) so §3a's CVD palette is later a data change.
3. ✅ **Done.** Thread `stepIndex` through `resolveStepColor` and all five call sites (plus `steps.length` for the
   final step), add `getUniqueStepColor`, and implement the `unique` branch. This is the whole visual
   payoff.
4. ✅ **Done.** Collapse the tie-break into it (§4): point the `harness`-mode collision path at
   `getUniqueStepColor`, then delete `STEP_COLOR_TIE_BREAK_PALETTE`, `hashSeed`, and
   `getTieBreakColor`, and guard the three surface-local `groupMembers` builders on the mode.
   Separate from step 3 so the deletion is reviewable against a working `unique` mode.
5. ✅ **Done.** Swap the `GeneralSection` toggle for the mode select; reword the two swatch descriptions.
6. ✅ **Done.** Flip the default to `unique` in `CTRLYOKE_SETTINGS_DEFAULTS` — one line, deliberately last so the
   preceding steps can all be reviewed against today's rendering.

7. ✅ **Done.** Cosmetic in-place color edits (§7). The editor sends a color-only addressed message;
   the core applies it with the existing partial step update so `_runtime`, continuation state, and
   start position remain untouched. Historical viewers receive a narrow color broadcast, and completed
   prompt edits retain their rewind path.

Follow-up, not part of the above: the CVD-safe named palette and `ui.stepColorPalette` (§3a), and the
`name`-as-cosmetic decision (§7).
