# Statusline Format Customization Plan

**Related:** [`STATUSLINE_USER_CONTROLS_PLAN.md`](../implemented/STATUSLINE_USER_CONTROLS_PLAN.md)
(implemented — gives users enable/disable, a custom forward command, and the
`useCtrlyokeStyle` switch this plan builds on top of)

## Goal

Today a user has exactly two choices for what appears in their Claude/Antigravity statusline
once ctrlyoke is managing it: ctrlyoke's fixed branded line, or (if they configure
`customCommand`) their own script's output. There is no middle ground for someone who doesn't
want to write a script but also doesn't want ctrlyoke's exact hardcoded line — e.g. "I want
context window, model, and usage, in that order, with my own label stuck on the front, and I
don't care about anything else." This plan adds that middle ground: a field-based format
editor for ctrlyoke's own branded line, configured entirely through the settings UI already
built in `StatusLineTrackingControls.tsx`.

This directly closes a risk `STATUSLINE_USER_CONTROLS_PLAN.md` flagged going in: for users who
don't already have a script and don't want ctrlyoke's exact line, "installing ctrlyoke" and
"force our line on them until they turn it off" were the only two states. This plan turns that
into a third state — keep ctrlyoke's line, but shape it.

Scoped to the two providers `STATUSLINE_USER_CONTROLS_PLAN.md` shipped — Claude and Antigravity.
Extending statusline tracking to Copilot CLI and Qwen Code (both of which also support a
configurable statusline in their native CLIs) is tracked as a follow-up, not designed in this
plan — see "Follow-up: extend statusline tracking to Copilot and Qwen" near the end.

## Current State (verified in code)

- `formatBrandedStatusLine` (`src/scripts/ctrlyoke-statusline-wrapper.js:332-371`) is one
  hardcoded formatter for both providers: a fixed array —
  `["ctrlyoke ⚡", modelLabel, "·", contextLabel, "·", "rate "/"quota " + quotaLabel, "·", agentState]`
  — joined with `" "`. No field is optional, reorderable, or removable, and there is no way to
  inject a literal custom string anywhere in the line.
- **Existing quirk worth noting**: `agentState` is read unconditionally from
  `payload.agent_state` (line 350) and always appended (line 369) **for both providers**, even
  though Claude's statusline payload has no `agent_state` field per this repo's own research
  (`dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md`'s documented Claude payload lists only
  `cost`, `context_window`, `rate_limits`). So today's Claude branded line always ends in
  `· unknown` — dead weight nobody asked for. This plan's default-format change (Decision 3)
  fixes that as a side effect, called out explicitly rather than left as a silent behavior
  change.
- Field extraction is already provider-generic and reusable: `getContextValues`,
  `calculateContextPercentage`, `getContextBand`, `formatCompactTokenCount`, and
  `getQuotaPercentage` (which already branches internally on `provider` to read
  `rate_limits` vs `quota`) all live in the shared `ctrlyoke-statusline-wrapper.js` module and
  need no rework, only a caller that assembles them differently.
- Settings shape: `StatusLineTrackingSettings` (`src/types/CtrlYokeSettings.ts:50-55`) currently
  has exactly three fields — `enabled`, `customCommand`, `useCtrlyokeStyle` — one instance per
  provider under `permissions.statusLineTracking.{claude,antigravity}`. Read by the wrapper via
  `resolveStatusLineSettings` (tolerant of malformed/missing values, falls back to
  `DEFAULT_STATUSLINE_SETTINGS`), rendered by `StatusLineTrackingControls.tsx`, one instance per
  provider, itself rendered in a loop from `StatsUsageSection.tsx:230-238`.
- The branded line only ever reaches the terminal when `useCtrlyokeStyle: true`; when false, the
  custom command's own stdout wins instead (`ctrlyoke-claude-statusline.js:35-41` /
  `ctrlyoke-antigravity-statusline.js:49-55`). A format editor is therefore only meaningful
  configuration while `useCtrlyokeStyle` is `true` — see UI Placement.

## Field Availability Research (Claude vs. Antigravity payload schemas)

Compared Claude's full documented statusline payload schema against a real Antigravity example
payload, field by field, to answer "what can actually be shared" — the constraint being that a
field id in the registry must mean the same thing on both providers, not just share a key name.

**Present in both payloads, same key, same meaning** — safe to build fields on directly:
`cwd`, `session_id`, `transcript_path`, `model.{id,display_name}`, `workspace.{current_dir,project_dir}`,
`version`, `context_window.*` (fully matching shape: `total_input_tokens`, `total_output_tokens`,
`context_window_size`, `used_percentage`, `remaining_percentage`, `current_usage.*`).

**Present in both, equivalent concept, different shape** — needs a normalizing extractor, already
the existing `usage` field's job: Claude's `rate_limits.{five_hour,seven_day}.used_percentage`
↔ Antigravity's `quota.{tier}.remaining_fraction`.

**Present in both under the same key, but NOT actually equivalent — rejected despite matching
names:**
- `exceeds_200k_tokens` — both payloads carry this exact key, but it's a hardcoded legacy
  Claude-specific 200k threshold. Antigravity's own example shows `context_window_size: 1048576`
  (1M tokens) with the flag still `false` at ~14% usage — comparing against a fixed 200k line is
  meaningless once the real window is 5x that size. The existing `context` field's percentage
  already conveys usage correctly and portably; this flag would just be a confusing, sometimes-lying
  duplicate of it. Excluded.
- Claude's `workspace.git_worktree` / `worktree.branch` vs. Antigravity's `vcs.branch` — not
  equivalent. Claude's only populates inside a ctrlyoke-managed worktree (rare, opt-in); Antigravity's
  is a general "current git branch" field, present whenever the workspace is a git repo. A shared
  `branch` field would work on Antigravity almost always and sit empty on Claude almost always —
  not a real cross-provider field. Excluded.
- Claude's structured `effort.level` vs. Antigravity embedding effort as free text inside
  `model.display_name` (e.g. `"Gemini 3.5 Flash (High)"`) — not structurally equivalent without
  fragile regex parsing of a display string. Excluded.

**No equivalent at all, either direction** — stays out of the registry entirely, per your
instruction to only allow fields available in both (or with real equivalents in both):
- Claude-only: `session_name`, `prompt_id`, `output_style`, `cost.*`, `fast_mode`, `thinking`,
  `vim`, `agent.name`, `pr.*`, `worktree.*`.
- Antigravity-only: `conversation_id`, `product`, `agent_state`, `vcs.{type,dirty}`, `sandbox`,
  `artifact_count`, `plan_tier`, `email`, `task_count`, `terminal_width`, `execution_mode`.

This resolves the previous draft's open question about `payload.cost`'s exact shape (it's
`cost.total_cost_usd`, confirmed) — but the answer is moot: since Antigravity has no cost
concept in its payload at all, `cost` is dropped from the registry rather than added. The
previous draft's `agentState` field (marked Antigravity-only, with a Claude-side toggle that
would always render "unknown") is dropped for the same reason — see the "Existing quirk" bullet
above, which this plan now fixes completely rather than partially.

### Both providers already have exactly two rate/quota windows in shipped code

The collapsed `usage` field (Decision 2 below) throws away real information: both providers
report **two separate usage windows**, not one, and ctrlyoke already has shipped, tested code
that knows this — it's just not surfaced per-window in the statusline yet:

- **Claude**: `CLAUDE_RATE_LIMIT_WINDOWS` (`src/core/harness/shared/usage/providers/ClaudeUsageProvider.ts:27-38`)
  is a **fixed, ordered** two-entry array — `five_hour` (`windowMinutes: 300`) then `seven_day`
  (`windowMinutes: 10080`) — read from `payload.rate_limits`. `parseClaudeRateLimitWindows`
  (lines 56-93) already iterates this fixed list in this fixed order. Per
  `HARNESS_USAGE_TRACKING_PLAN.md`'s research, "each window can be absent" — `rate_limits`
  overall appears only after the first API response, and any individual key can be missing.
- **Antigravity**: `parseAntigravityQuotaSnapshot` (`AntigravityUsageProvider.ts:75-116`) iterates
  `payload.quota` as an **open-ended, dynamically-keyed** map (`Object.entries`, no fixed enum —
  correctly, since these are plan-tier names, not a stable schema). Real captured payloads show
  either two tiers (`3p-weekly`, `gemini-weekly`) or just one (`gemini-weekly` alone, depending on
  plan) — never observed more than two. `humanizeQuotaKey` (lines 43-55) already turns
  `3p-weekly` → `"3P Weekly"`, `gemini-weekly` → `"Gemini Weekly"`; `quotaWindowKind` (lines 57-72)
  already classifies each key as rolling/daily/weekly/monthly/unknown by substring match.

This confirms the premise directly: a generic `usage1`/`usage2` pair is the right shape, and the
labeling/classification logic to build it on already exists — it just lives in the
extension-host usage-provider layer (`HarnessQuotaSnapshot`/`UsageCard.tsx`'s data path), a
different consumer from the detached statusline wrapper. See Decision 4 below for how the
wrapper reuses these conventions without importing across that boundary.

## Decisions

1. **Model the format as an ordered array of typed segments, not a template string.**
   ```typescript
   type StatusLineSegment =
     | { type: "field"; field: StatusLineFieldId; label?: string; color?: StatusLineColorId }
     | { type: "literal"; text: string; color?: StatusLineColorId };
   ```
   Rejected alternative: a `printf`-style template string (e.g. `"{model} · {context}"`). An
   array of segments keeps the field vocabulary closed and typed — consistent with this
   project's "no hardcoded strings for flow control" rule (`CLAUDE.md`) — keeps the detached
   wrapper's parser trivial (iterate + `switch`, nothing to tokenize or fail to parse), and lets
   the settings UI render an editable list (toggle/reorder/insert) instead of a free-text box a
   user can typo into a broken statusline with no feedback loop. `label` and `color` are
   both optional per-segment overrides, resolved (in design discussion, 2026-08-21) from what
   were the two Open Questions below — see Decision 13 (`color`) and Decision 14 (`label`) for
   the full design; both are additive and don't change this shape's two base variants.

   **Ordering is a first-class part of this design, not an afterthought**: the format *is* an
   ordered array, and the format editor gives users Up/Down reorder controls per row (see UI
   Placement) — there's no separate "ordering" feature to add, it falls straight out of modeling
   the format as an array in the first place.

   **No raw string/template mode, and no conditionals, in the format editor itself — confirmed,
   2026-08-21.** Two related but separate questions came up in design discussion, both settled the
   same way: a `literal` segment is inert static text (plus, per Decision 13, an optional color) —
   it cannot reference field values or branch on anything, so "edit the string myself" and "add a
   conditional" are not the same request even though they sound similar. A raw editable
   template string (e.g. typing `"{model} · {context if context > 50}"` directly) would need its
   own parser and its own tiny expression language to support real conditionals — exactly the
   parse-failure and hardcoded-string-for-flow-control risk this decision's array-of-typed-segments
   design was chosen to avoid in the first place, so it isn't being added as an alternate input
   mode alongside the structured editor. Genuine conditional logic ("show X only if Y ≥ Z", or any
   formatting the fixed field/literal vocabulary can't express) has an existing, already-shipped
   escape hatch that isn't being duplicated here: `customCommand`
   (`STATUSLINE_USER_CONTROLS_PLAN.md`) already lets a user hand ctrlyoke an arbitrary script that
   receives the same stdin payload and can implement any logic they want in real code, not a
   template string — and, per Decision 16, `useCtrlyokeStyle` is now always reachable in the UI to
   switch between that script's output and ctrlyoke's structured line. So the two supported paths
   stay: (a) the structured segment editor — typed fields, literals, reordering, color, labels —
   for the common case this plan targets, and (b) `customCommand` for anything that needs real
   conditional logic. Nothing here forecloses adding a raw-string mode later if a concrete need
   shows up, but it isn't part of this plan.

2. **Single-source the field vocabulary in a `StatusLineFieldId` registry**, keyed by id. Because
   every field id is now required to mean the same thing on both providers (per the research
   above), the registry needs no per-provider availability column at all — a field is either in
   the registry (valid everywhere) or it isn't (not in the registry). Each entry gives a display
   label for the UI and, wrapper-side, its extractor:

   | id          | label                        | claude source                              | antigravity source                    |
   | ----------- | ---------------------------- | ------------------------------------------- | -------------------------------------- |
   | `brand`     | "ctrlyoke ⚡" mark            | static                                       | static                                 |
   | `model`     | Model name                   | `payload.model.{id,display_name}`           | `payload.model.{id,display_name}`      |
   | `context`   | Context usage (colored band) | `payload.context_window`                    | `payload.context_window` (identical shape) |
   | `usage`     | Rate/quota used % (worst of all windows) | `payload.rate_limits.*` (normalized) | `payload.quota.*` (normalized) |
   | `usage1`    | First usage window, used % + short label | `payload.rate_limits.five_hour` | `payload.quota[sorted[0]]`     |
   | `usage2`    | Second usage window, used % + short label | `payload.rate_limits.seven_day` | `payload.quota[sorted[1]]`    |
   | `version`   | Harness/CLI version          | `payload.version`                           | `payload.version`                      |
   | `cwd`       | Current directory (basename) | `payload.cwd`                               | `payload.cwd`                          |
   | `sessionId` | Session id (truncated)       | `payload.session_id`                        | `payload.session_id`                   |

   `usage` reuses today's already-provider-branching `getQuotaPercentage`, keeping today's
   per-provider label ("rate" for Claude, "quota" for Antigravity), **but flips its number to
   used %, not remaining %** — see the direction fix below. `usage1`/`usage2` are net-new,
   generic, positional fields exposing each window individually instead of collapsing to the
   worst case — see Decision 4 for the ordering rule and Decision 5 for rendering. `version`,
   `cwd`, and `sessionId` are also net-new and, unlike the previous draft's `cost`/`agentState`,
   need no confirmation spike — both example payloads carry these keys verbatim with matching
   semantics. `cwd` renders as `path.basename(payload.cwd)` (showing the raw absolute path would
   dominate the line); `sessionId` renders truncated (first 8 chars) since a full UUID is not
   glanceable — and, being low-signal for most users, is available to add but **not included in
   either provider's default array** (Decision 3). `agentState` and `cost` from the previous
   draft are dropped entirely, not demoted to provider-specific — see the Field Availability
   Research section above.

   **Direction fix: used %, not remaining %.** Today's `getQuotaPercentage`
   (`ctrlyoke-statusline-wrapper.js:277-323`) deliberately computes the *remaining* percentage —
   `100 - used_percentage` for Claude's rate limits, the raw `remaining_fraction` for
   Antigravity's quota — then takes the `Math.min` across windows (worst case = lowest
   remaining). That's the outlier, not the norm, in this exact codebase: the wrapper's own
   `context` field computes `used/size` (used %, via `calculateContextPercentage`), and
   `UsageCard.tsx`'s `window.percentUsed` is used %-oriented on both providers too (Claude:
   `usedPercentage` straight from the payload, `ClaudeUsageProvider.ts:82-85`; Antigravity:
   `(1 - remainingFraction) * 100`, `AntigravityUsageProvider.ts:98-107`). There's no comment or
   plan doc anywhere justifying `usage`'s remaining-% choice — it reads as an unexamined default
   from whenever the branded line was first written, not a deliberate one, and it's the one place
   in the product where the same underlying quota data reads in the opposite direction depending
   on which UI surface shows it. Per this project's pre-release "no backward compatibility
   constraints, prioritize... bold improvements" stance (`CLAUDE.md`), flip `usage` (and, by
   construction, `usage1`/`usage2`) to used %, worst case = `Math.max` of used-% across windows
   (the direction flips; "worst case" as a concept doesn't change). This is a second deliberate,
   called-out behavior change bundled into this plan alongside the Claude `agentState` fix noted
   above — not a silent one.

3. **Default format reproduces today's line's *composition* exactly, with two intentional
   exceptions already called out above** (Claude drops the dead `agentState` tail; `usage`'s
   number now reads used % instead of remaining %). Because the registry no longer has any
   provider-exclusive field, **both providers now share one identical default array** — a further
   simplification the "shared fields only" constraint buys for free:
   ```
   [brand, model, ·, context, ·, usage]
   ```
   where `·` is itself a **literal segment**, not a separator concept — this is not a new idea,
   it's exactly how the current array already works (`"·"` is just another array element,
   space-joined like everything else). Modeling it as a literal segment in the new scheme means
   the default array can be expressed with zero new formatting concepts beyond what
   `formatBrandedStatusLine` already does today. The new `usage1`/`usage2` fields (Decisions 4-5)
   deliberately stay **out** of this default — adding them would both change the line's look and
   lengthen it, breaking the "no visible change on upgrade" promise. A user who wants the split
   view opens the format editor and swaps `usage` for `usage1`/`usage2` (or adds both alongside
   it) — no new UI mechanism needed beyond the per-segment include/exclude editor already planned
   under UI Placement.

4. **`usage1`/`usage2` ordering rule — deterministic, not runtime-dependent.** The naive
   approach (sort each provider's windows by remaining time, e.g. `reset_in_seconds`) is
   rejected: for Antigravity's two *weekly* tiers, `reset_in_seconds` just reflects where each
   tier happens to sit in its own week-long cycle right now, not a structural property of the
   tier — a user's `usage1` could silently become "gemini quota" one week and "3rd-party quota"
   the next, purely from reset timing, with no config change. Instead:
   - **Claude**: fixed order, matching the already-shipped `CLAUDE_RATE_LIMIT_WINDOWS` array
     exactly — `five_hour` is always `usage1`, `seven_day` is always `usage2`, when present.
     Since this list is a small curated enum (not open-ended), hardcoding the order in the
     wrapper is safe and mirrors what `ClaudeUsageProvider.ts` already does.
   - **Antigravity**: keys are open-ended plan tiers with no fixed enum, so ordering must be
     computed from the payload itself, deterministically. Sort by window **kind** first
     (rolling < daily < weekly < monthly < unknown — reusing `quotaWindowKind`'s existing
     classification, and mirroring the same cadence-ascending principle Claude's fixed order
     already encodes: shorter-cadence window first), then alphabetically by raw key as a
     tiebreak for same-kind windows. Applied to the real captured payload (both tiers are
     `weekly`, tying on kind), this lands `3p-weekly` as `usage1` and `gemini-weekly` as
     `usage2` — deterministic and stable across sessions, even though the specific choice of
     "alphabetical" for the tiebreak is arbitrary (there's no stronger natural ordering between
     two same-cadence tiers).
   - Build the wrapper's extractor as "sort into an array, then `usageN` = `sorted[N-1]`" rather
     than two hardcoded slots, so a future third window (neither provider currently reports one)
     falls out of the same logic as `usage3` with no rework — not needed now, just don't paint
     the implementation into a two-slots-only corner.
   - **Absence, not placeholder, when a slot has no data.** Unlike collapsed `usage` (which
     falls back to a visible `"—"` when no window resolves, since it's a single always-expected
     slot), a missing `usage1`/`usage2` — Claude's `seven_day` genuinely absent, or an
     Antigravity plan with only one quota tier — renders as an **empty string and is dropped
     from the line entirely**, not a stray em-dash. Two windows silently collapsing to one is a
     normal, common state (not an error condition) for both providers, and a dangling `"— "`
     would read as a rendering glitch rather than a designed outcome.

5. **`usage1`/`usage2` render with their per-window label, not the generic "rate"/"quota" word**
   — `"{shortLabel} {usedPercent}%"`, e.g. `"5h 24%"` / `"week 41%"` for Claude (from the example
   `used_percentage` values of 23.5 / 41.2), `"3P Weekly 1%"` / `"Gemini Weekly 6%"` for
   Antigravity (from example `remaining_fraction` values of 0.991 / 0.9378, converted to used %).
   Without a label, two bare percentages sitting next to each other in the line are ambiguous —
   which one is which becomes guesswork. Reuse the exact label functions the extension host
   already ships for the same data, rather than inventing a third naming convention:
   `formatUsageWindowLabel(windowMinutes)` (`DashboardConstants.ts:806-822`, → `"5h"` / `"week"`)
   for Claude, `humanizeQuotaKey(id)` (`AntigravityUsageProvider.ts:43-55`, → `"3P Weekly"` /
   `"Gemini Weekly"`) for Antigravity — this also keeps the statusline's window naming consistent
   with what `UsageCard.tsx` already shows for the same two windows, instead of drifting from it.
   The used-percentage direction matches both the "Direction fix" in Decision 2 and
   `UsageCard.tsx`'s `window.percentUsed` for consistency across all three surfaces (`context`,
   `usage`/`usage1`/`usage2`, and the Settings usage card) — not the wrapper's old, unexplained
   remaining-% convention. This is the wired-in default; Decision 6 makes it user-overridable.

6. **Add one global `usageTracking.percentDirection: "used" | "remaining"` setting** (default
   `"used"`, matching Decision 2/5's direction fix) so users coming from Codex or Antigravity's
   *native* CLI — which show remaining%, unlike Claude/Copilot's native used% — can pick the
   convention they already think in, confirmed as the right shape in conversation: a single
   global toggle, not per-provider (a per-provider pair would only additionally help someone
   running multiple harnesses side-by-side who wants each line to mirror its own CLI's
   convention — a narrower need than "let me pick the convention I personally think in").
   - **Scope, deliberately not machine-only.** Unlike `customCommand`/`enabled`/
     `useCtrlyokeStyle`/`format` (machine-scoped per `STATUSLINE_USER_CONTROLS_PLAN.md`'s
     reasoning — a single physical global settings file, and `customCommand` specifically is an
     executable shell command), this is a pure display preference with no filesystem or security
     angle. No reason to forbid workspace-level override; leave it at normal default scope.
   - **Placement**: `usageTracking.percentDirection`, not nested under
     `permissions.statusLineTracking.*` — it is not provider-specific and (see below) also
     governs `UsageCard.tsx`, not just the two statusline-tracked harnesses. Sits alongside the
     existing `usageTracking.{enabled,providerRefreshEnabled,persistObservedUsage}`
     siblings (`schemas/settings-schema.json:442-465`).
   - **Scope of effect — genuinely global, not statusline-only.** It must govern both (a) the
     statusline wrapper's `usage`/`usage1`/`usage2` rendering and (b) `UsageCard.tsx`'s displayed
     quota numbers, for every harness, not only Claude/Antigravity — leaving UsageCard fixed at
     used% while the statusline could be toggled to remaining% would recreate the exact
     same-data-different-direction inconsistency across UI surfaces that Decision 2's direction
     fix just closed. **`context` is explicitly out of scope for this toggle** — harnesses have
     no native "remaining context" convention to match (they always express it as used/size), so
     `context` stays used% always, unaffected by `percentDirection`.
   - **UI placement**: a single control in `StatsUsageSection.tsx` (not inside
     `StatusLineTrackingControls.tsx`, and not duplicated per provider), since it now affects
     every harness's `UsageCard`, not just the two statusline-managed ones.
   - **Critical implementation catch — do not invert `getUsageBarColorClass` itself.**
     `getUsageBarColorClass` (`src/ui/webview-react/utils/usageBarColor.ts:9-14`) is a *shared*
     danger-coloring function, and its other caller has nothing to do with quota: `WorkflowStep.tsx:388-390`
     feeds it a plain used% **context** value (`contextPct`) to color the step's context-fill
     animation, with no remaining-% concept at all. Inverting the function's thresholds/comparison
     for "remaining mode" would silently flip that unrelated bar's danger coloring backwards
     (a nearly-exhausted context window would render green instead of red) the moment a user
     enables `percentDirection: "remaining"` — a correctness bug hiding behind an unrelated
     preference toggle. The function's semantics must stay fixed ("higher input = more danger");
     only the **displayed number/label** should follow `percentDirection`, never the color
     computation. Concretely: every call site continues passing `getUsageBarColorClass` the
     canonical **used%** value (`window.percentUsed`, which — per Decision 2 — is already used%
     regardless of the display toggle) for coloring, while a small
     `formatUsagePercentForDisplay(usedPercent, direction)` helper (`remaining` mode returns
     `100 - usedPercent`) governs only the **text** shown next to/above the bar. This decouples
     "what color implies danger" (fixed, used%-based, shared safely across quota bars and the
     context bar) from "what number is shown" (toggle-controlled, quota-only).
   - This one-line transform (`100 - usedPercent`) is cheap enough that literal, tracked
     duplication between the detached wrapper (CommonJS) and the TS settings UI is acceptable on
     its own if Decision 11's shared-module extraction doesn't land first — but if that
     extraction does happen, `formatUsagePercentForDisplay` belongs in the same isomorphic module
     for the same DRY reasons already argued there.

7. **Generalize `formatBrandedStatusLine(provider, payload)` to
   `formatBrandedStatusLine(provider, payload, format)`.** When `format` is missing, not an
   array, or empty, fall back to the shared default array from Decision 3 — matching the existing
   tolerant posture of `resolveStatusLineSettings` (malformed settings.json → defaults, never a
   thrown error, since this runs as a detached process with no error surface a user will ever
   see). Per-segment tolerance: a `field` segment naming an id not present in the registry is
   **skipped silently**, not an error — the line renders shorter, never broken. Since every
   registry field is now valid for both providers, this case is narrower than the previous
   draft's (no more "valid for the other provider" scenario to handle) — it now only covers a
   future ctrlyoke version removing a field id that an older saved format still references.

8. **Literal segment handling**: reuse the existing `safeStatusLabel` treatment (strip `\r\n`,
   since this is a single-line terminal output whose one hard invariant is "no
   newlines") and add a UI-side length cap (recommend 64 chars) purely for statusline
   usability — not a security boundary. Literal text is user-authored local machine settings,
   the same trust level as `customCommand`, which is already an arbitrary shell command; no
   additional sanitization beyond the newline strip is warranted. Raw ANSI escape codes typed
   directly into the text still work as a manual fallback, but most users get there through the
   structured `color` picker instead — see Decision 13.

9. **Settings shape**: add `format: StatusLineSegment[]` to `StatusLineTrackingSettings`
   (`src/types/CtrlYokeSettings.ts:50-55`), nested per-provider exactly like the three existing
   fields — `permissions.statusLineTracking.{claude,antigravity}.format`. **Machine-scoped**,
   same as the other three leaves in that object; `STATUSLINE_USER_CONTROLS_PLAN.md`'s "Scope:
   User/Machine Only, Not Workspace" reasoning (single physical global settings file, no
   per-workspace variant exists) applies unchanged here — this isn't a new resource, just a new
   field on an existing one.

10. **No new `MESSAGE_TYPES` needed.** Reuse `UPDATE_GLOBAL_SETTING` with two new
   `SETTING_PATHS` entries (`PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_FORMAT`,
   `..._ANTIGRAVITY_FORMAT`), written as one whole-array commit per edit — the same granularity
   `permissions.allowedExternalFileRoots` already uses today (whole array recommitted on
   textarea blur, `AdvancedPermissionsSection.tsx:99-113`). No per-segment message plumbing to
   invent.

11. **Preview must reuse the real formatter, not a second hand-rolled one.** The settled
    implementation is **(a1)**: pure statusline display helpers live in an isomorphic TypeScript
    module under `src/utils/`, imported by TypeScript consumers and compiled by a dedicated esbuild
    entry to the flat CommonJS sibling `out/scripts/ctrlyoke-statusline-format.js`. The detached
    `src/scripts/ctrlyoke-statusline-wrapper.js` requires that sibling, while the webview imports
    the source module through its existing `@root/utils/*` alias. Phase 1 proves the dependency with
    `formatUsagePercentForDisplay(usedPercent, direction)`, exercised by the wrapper and the
    `UsageCard` TypeScript path, plus a packaging test that verifies the emitted artifact and a
    detached child-process require after a real build. The sequential esbuild rebuild keeps the
    `copyScriptsPlugin` flat-file copy from racing or clobbering the generated sibling. Options
    (a2) and (c) were rejected: (a2) cannot serve the webview's TypeScript-only module boundary,
    while (c) would preserve the duplication that this shared build proves avoidable.

12. **Give statusline configuration its own top-level settings tab ("Status Line"), separate
    from Stats & Usage.** The original design (this plan's earlier draft, and where
    `StatusLineTrackingControls` already lives today) nested everything inside
    `StatsUsageSection.tsx`'s "Statusline Tracking" block. Revisited in design discussion
    (2026-08-21): `StatsUsageSection` is already the longest tab in the settings drawer (stat
    tiles, harness-share bar, six per-harness `UsageCard`s), and the format editor alone
    (per-segment field/literal rows, live preview, reset-to-default) roughly doubles the size of
    the existing `StatusLineTrackingControls` block *per provider* — bolting that onto the bottom
    of an already-dense tab makes it the longest scroll in the whole drawer by a wide margin.
    Splitting is cheap: `GlobalSettingsDrawer.tsx`'s `ALL_TABS` (lines 31-51) is a flat array and
    its render switch (lines 209 on) is one `{condition && <Section/>}` block per tab — the exact
    shape used to add "Stats & Usage" itself, no special nested-page machinery like
    `WorkflowDefaultsSection`'s own internal sub-nav needed. The two concerns are also
    conceptually distinct: statusline formatting is "what shows in my terminal prompt," a
    display/UX question independent of whether usage tracking is even enabled, whereas
    `usageTracking.*`'s toggles are about data collection and belong beside the `UsageCard`s they
    gate. **Decision**: add a new top-level "Status Line" tab that owns the entire existing
    `StatusLineTrackingControls` block (enabled/customCommand/useCtrlyokeStyle, currently
    rendered from `StatsUsageSection.tsx:230-238`) plus this plan's new `StatusLineFormatEditor`,
    for every statusline-tracked provider. `usageTracking.percentDirection` (Decision 6) stays on
    Stats & Usage — it governs every harness's `UsageCard`, not just the statusline-tracked ones
    — which means the format editor's live preview (see UI Placement) depends on a setting whose
    control lives on a different tab; call that out directly in the preview UI (e.g. "uses your
    Stats & Usage percent-direction setting") rather than leaving it unexplained. This split is
    unaffected by, and doesn't require touching, `SETTINGS_UI_PARITY_PLAN.md`'s parity table — the
    four `usageTracking.*` toggles it lists stay on Stats & Usage exactly as already documented
    there.

    This split also anticipates growth: Copilot CLI and Qwen Code both support a configurable
    statusline in their native CLIs too, unlike the fixed two-provider scope
    `STATUSLINE_USER_CONTROLS_PLAN.md` shipped with (that plan's stated reason for stopping at
    Claude/Antigravity was "Claude and Antigravity are both single-statusline harnesses" — a
    description of what was true of those two, not an argument against extending further).
    Adding those two providers is out of this plan's scope (see the follow-up section near the
    end) but would add two more `StatusLineTrackingControls` + `StatusLineFormatEditor` provider
    blocks to whichever tab hosts them — a second, independent reason not to grow that content
    further inside Stats & Usage.

    **Implemented:** added the flat top-level "Status Line" settings tab and moved the existing
    statusline-tracking provider controls into `StatusLineSection`, leaving the statistics and
    usage controls in `StatsUsageSection`.

13. **Per-segment `color` override, applying to both `field` and `literal` segments** (resolves
    the former "structured color option" Open Question — decided yes, 2026-08-21). A small
    curated `StatusLineColorId` enum, not free-form RGB/truecolor, keeping the picker a simple
    swatch list and the schema a closed enum (consistent with this project's "no hardcoded
    strings for flow control" rule) rather than a color-input widget with unbounded values:

    | id        | ANSI code | notes |
    | --------- | --------- | ----- |
    | `default` | *(none)*  | no override — segment renders with its own built-in coloring if it has one (today, only `context`'s band coloring), otherwise plain terminal foreground. This is the implicit value when `color` is omitted. |
    | `red`     | `31`      | matches the existing `CONTEXT_COLORS.danger` |
    | `yellow`  | `33`      | matches the existing `CONTEXT_COLORS.warning` |
    | `green`   | `32`      | new |
    | `cyan`    | `36`      | matches the existing `CONTEXT_COLORS.neutral` |
    | `blue`    | `34`      | new |
    | `magenta` | `35`      | new |
    | `white`   | `37`      | new |
    | `gray`    | `90`      | new (bright-black) |

    **Precedence over built-in semantic coloring, deliberately.** `context` is currently the only
    field with inherent coloring — a danger band (`getContextBand`/`CONTEXT_COLORS`) signaling how
    close the window is to full. Setting an explicit `color` on a `context` segment overrides that
    band coloring outright, every time, not just as a fallback when the band would otherwise be
    neutral. This is a deliberate, called-out trade-off, not an oversight: a user who picks a
    static color for `context` is choosing a consistent look over the at-a-glance danger signal,
    and the format editor's per-segment color picker should say so in its help text (e.g. "Overrides
    the automatic warning/danger coloring for this field") rather than leaving it a silent surprise
    when their context bar stops turning red near full. No other current field has built-in
    coloring, so this precedence rule only has one real case to worry about today, but the rule
    itself ("explicit `color` always wins") is what keeps the implementation simple as more
    semantically-colored fields are potentially added later (e.g. if `usage`/`usage1`/`usage2`
    ever grow the same kind of danger-band coloring `UsageCard.tsx` already applies via
    `getUsageBarColorClass` — not in scope here, just noting the rule generalizes cleanly if it
    happens).

    Implementation: `STATUS_LINE_COLOR_IDS`/`StatusLineColorId` registry, single-sourced the same
    way as the Decision 2 field registry — a small id→ANSI-code map. Lives wherever Decision 11's
    spike lands the shared isomorphic module (or, if that extraction doesn't happen first, as a
    small tracked duplication between the wrapper and the TS settings UI, same posture as
    `formatUsagePercentForDisplay` in Decision 6). Rendering: wrap the segment's text in
    `` `${ANSI_CODES[color]}${text}${ANSI_RESET}` `` when `color` is set and not `"default"`;
    when unset, existing per-field coloring logic (`context`'s band) runs unchanged.

14. **Per-`field`-segment `label` override** (resolves the former "custom labels" Open Question —
    decided yes, 2026-08-21), narrower in scope than it might first sound. A general "stick my own
    text next to a field" need is already solved for free by literal segments adjacent to the
    field — that's literally this plan's own motivating example in the Goal section ("with my own
    label stuck on the front"). What literal segments *can't* do is change the word a field prints
    **internally** as part of its own formatter: `usage`'s `"rate "`/`"quota "` prefix, `usage1`/
    `usage2`'s per-window short label (`"5h"`/`"week"`/`"3P Weekly"`, from Decision 5's
    `formatUsageWindowLabel`/`humanizeQuotaKey`), and `context`'s trailing `" ctx"` word. `label`
    targets exactly that: when set on a `field` segment, it substitutes for that field's own
    internal label slot instead of the registry default. For fields with no internal label slot to
    begin with (`brand`, `model`, `version`, `cwd`, `sessionId`, `branch`, `date`, `time` — see
    Decision 15 — all render as bare values), `label` is accepted by the schema (kept generic
    rather than per-field-validated, matching this plan's existing tolerant posture) but is a
    silent no-op — same "never breaks the line" tolerance as Decision 7's unknown-field handling,
    just for an inapplicable property instead of an inapplicable field id. UI-side length cap
    reuses Decision 8's 64-char literal cap for the same usability reason.

15. **Locally-computed fields — not sourced from either provider's payload at all.** A new field
    category, distinct from every field in Decision 2's registry: these are computed by the
    wrapper itself from the local machine/filesystem, so — unlike `usage`, which inherently
    branches on `provider` — they need no per-provider extraction logic and are identical by
    construction on both statusline-tracked harnesses, not merely coincidentally similar.

    - **`branch` (git branch of the current workspace) — recommended, designed below.** Field
      Availability Research above already rejected a payload-derived `branch`: Claude's
      `workspace.git_worktree`/`worktree.branch` only populates inside a ctrlyoke-managed
      worktree (rare) while Antigravity's `vcs.branch` is a general current-branch field (common)
      — genuinely different data, not a shared field despite the matching name. That asymmetry is
      specific to *reading it out of the payload*; it disappears entirely once the wrapper computes
      the branch itself from disk, using `payload.cwd` (already confirmed present with matching
      semantics on both providers, per Decision 2's registry) as the repo root. At that point both
      providers get the exact same real git branch, computed the same way — this isn't a
      workaround for the earlier rejection, it's a genuinely different, symmetric data source that
      happens to answer the same question. Mechanism: read `<cwd>/.git/HEAD` directly rather than
      spawning a `git` subprocess — both harnesses poll the statusline frequently (the wrapper's
      own `FORWARD_TIMEOUT_MS` comment notes staying under Antigravity's ~300ms poll cadence), so
      this can run several times a second while a session sits idle, and a filesystem read is
      effectively free next to spawning a process on every refresh. Three cases to handle: (a)
      `.git` is a directory and `HEAD` contains `ref: refs/heads/<branch>` → branch name; (b) `.git`
      is a **file** containing `gitdir: <path>` — true for every worktree, including ctrlyoke's own
      managed worktrees — which must be resolved and `HEAD` re-read from the redirected location;
      (c) detached HEAD (`HEAD` holds a raw SHA, no `ref:` line) → render the short SHA (first 7
      chars) instead of leaving the field blank, so "detached" still reads as informative rather
      than empty. Every failure mode (`payload.cwd` missing, not a git repo, permission error)
      resolves to the field being silently absent — same "skipped, not broken" tolerance as
      Decision 7. Not added to the Decision 3 default array (opt-in only, same treatment as
      `sessionId`).
    - **`date` / `time` (wall-clock, read via `new Date()`) — confirmed (2026-08-21).** Trivially
      cheap (no filesystem or subprocess access needed at all). Two separate fields, matching this
      registry's existing one-concept-per-field granularity (see `cwd`/`sessionId`/`version` as
      separate fields rather than one combined "meta" field): `date` → `YYYY-MM-DD`, `time` →
      24-hour `HH:MM`, both fixed, non-localized formats to avoid taking on locale/timezone
      configuration as MVP scope. **Opt-in only, like `branch`/`sessionId` — not added to the
      Decision 3 default array**, since a terminal's own clock already covers this for most users
      and the goal is zero visible change on upgrade.
    - **User identity — rejected (2026-08-21).** Confirmed as the weakest of the candidates: on a
      personal single-developer machine (this product's primary use case) a user already knows who
      they are, and the shared/remote-dev-box scenario that would justify it wasn't the actual
      motivation here. Not built — no `StatusLineFieldId` entry, no OS-username or git-identity
      extraction.

16. **[Done] Always show the `useCtrlyokeStyle` toggle in `StatusLineTrackingControls.tsx`, not just when
    `customCommand` is non-empty.** Fixes a real gap, not a cosmetic one: today
    (`StatusLineTrackingControls.tsx:185`) the toggle only renders inside
    `{tracking.customCommand.length > 0 && (...)}`, per `STATUSLINE_USER_CONTROLS_PLAN.md`'s
    original reasoning ("with no custom command configured, ctrlyoke's branded line is the only
    sensible output anyway, so the toggle has nothing to choose between yet"). That reasoning
    missed a real third state: a user with **no** custom command who still wants the harness's own
    default (i.e. unconfigured) statusline — not ctrlyoke's branded line — while ctrlyoke keeps
    collecting usage data in the background. Today that state is simply unreachable through the
    UI, not merely hidden behind extra clicks — the setting can only be changed by hand-editing
    `settings.json`.

    **The mechanics already support this; only the UI needs to change.** Confirmed by reading both
    entry scripts (`ctrlyoke-claude-statusline.js`/`ctrlyoke-antigravity-statusline.js`):
    `writeSnapshotAtomic` (the actual data-collection step) runs unconditionally whenever
    `settings.enabled` is true, entirely independent of `useCtrlyokeStyle` and `customCommand` —
    so "still get the benefits of having our statusline collect data" is already true today, with
    zero code changes needed for that half of the ask. Separately, stdout resolves to
    `formatBrandedStatusLine(...)` when `useCtrlyokeStyle` is true, or to `forwardedOutput`
    otherwise — and `forwardToCommand` already short-circuits to an empty buffer when
    `customCommand` is empty (`ctrlyoke-statusline-wrapper.js:174-176`), so `useCtrlyokeStyle:
    false` with no custom command already prints nothing today, in the one state the UI currently
    prevents a user from reaching.

    **Verification of the unconfigured CLI states.** Claude Code's official statusline
    documentation says deleting `statusLine` disables the custom statusline; it does not show a
    built-in default statusline in that state. Antigravity's official documentation explicitly says
    deleting its custom statusline configuration restores the built-in default statusline. ctrlyoke
    does not delete either CLI's `statusLine` block when this toggle is turned off: its wrapper owns
    the command slot and emits empty stdout when no `customCommand` is set. Therefore the reachable
    no-command off-state is a blank statusline for both providers, not Antigravity's built-in
    default. The UI copy promises a blank line rather than a harness default, while usage tracking
    continues independently.

    **Implemented:** remove the `tracking.customCommand.length > 0 &&` gate around the
    `SettingToggleRow` in `StatusLineTrackingControls.tsx` so it always renders. Update its
    description text, which currently reads "Show ctrlyoke's branded statusline instead of
    custom-command output" — accurate only when a custom command exists. Reword to cover both
    reachable off-states and make the data-collection guarantee explicit, e.g.: "Show ctrlyoke's
    branded statusline. Turn off to show your custom command's output instead — or, with no
    custom command set, leave the statusline blank. Usage tracking keeps collecting data either
    way." No settings-shape or wrapper-script change was needed; this is a standalone UI fix that
    doesn't depend on the tab split (Decision 12) or the format editor and can ship independently
    of the rest of the plan.

## UI Placement

- New top-level **"Status Line" settings tab** (added to `ALL_TABS`/the render switch in
  `GlobalSettingsDrawer.tsx`, the same flat pattern as every other tab there — see Decision 12),
  hosting the entire existing `StatusLineTrackingControls` block per provider (moved out of
  `StatsUsageSection.tsx:230-238`) plus this plan's new `StatusLineFormatEditor` sub-component,
  rendered directly below the existing `useCtrlyokeStyle` toggle block within each provider's
  `StatusLineTrackingControls` (currently lines 185-198).
- **Visible only when `tracking.useCtrlyokeStyle === true`** — mirrors the existing pattern one
  level up, where the `useCtrlyokeStyle` toggle itself is only shown once `customCommand` is
  non-empty (`StatusLineTrackingControls.tsx:185`): don't show controls for output that isn't
  currently reaching the terminal. When `customCommand` is empty, `useCtrlyokeStyle` is always
  effectively `true` (that toggle is hidden, not off), so the format editor is visible in that
  case too.
- Per-segment row: a `field` segment shows its label with an include/exclude checkbox, an
  optional custom-label text input (Decision 14, shown only for fields with an internal label
  slot — `usage`/`usage1`/`usage2`/`context` — so the control isn't offered where it would be a
  silent no-op), and a color swatch picker (Decision 13); a `literal` segment shows a small
  bounded text input (Decision 8's length cap) plus the same color swatch picker. Up/Down move
  buttons per row for reordering — simpler and more accessible than drag-and-drop, no new
  dependency. (`WorkflowStepsPanel.tsx` already has a native HTML5 drag-and-drop precedent
  elsewhere in this codebase if a later pass wants reorder-by-drag parity; not needed for MVP.)
- "Add custom text" button appends a new empty literal segment at the end.
- "Reset to default" button restores the Decision 3 shared default array in one write.
- Live preview line above the editor, rendered via Decision 11's shared formatter against the
  latest cached snapshot for that harness from `useHarnessUsageStore` when one exists, falling
  back to a fixture payload otherwise (a brand-new user with no snapshot yet should still see
  *something* representative, not a blank preview). The preview must also respect the current
  `usageTracking.percentDirection` (Decision 6), not just the segment list, so it never shows a
  different direction than what the real statusline will render — since that setting's control now
  lives on a different tab (Decision 12), the preview reads it from shared settings state, not a
  locally-threaded prop, and should say as much in its own UI so the dependency isn't invisible.
- **`percentDirection` toggle lives in `StatsUsageSection.tsx` itself, not in
  `StatusLineTrackingControls.tsx`/the new Status Line tab** (see Decision 6) — it governs every
  harness's `UsageCard`, not just Claude/Antigravity's statusline, so it doesn't belong inside the
  per-provider statusline block. A simple two-option segmented control near the top of the
  section, alongside or near the existing `shareMetric`/`ScopeToggle` control already in that file
  (`StatsUsageSection.tsx:307-325`), is a reasonable, low-effort fit.

## Schema / Type Plumbing

- `schemas/settings-schema.json`'s `statusLineTrackingSettings` definition (currently
  `enabled`/`customCommand`/`useCtrlyokeStyle` only, lines ~906-922) gains a `format` array
  property: `items` as a `oneOf` of a field-segment shape (`field` enum sourced from the
  Decision 2 registry, plus `branch`/`date`/`time` per Decision 15; optional `label` string,
  length-capped per Decision 14) and a literal-segment shape (`text` string, length-capped), with
  `additionalProperties: false` on both variants per the project's existing schema style. Both
  variants also gain an optional `color` property, enum-sourced from Decision 13's
  `StatusLineColorId` list. No user-identity field id is added — rejected per Decision 15.
- `StatusLineTrackingSettings` (`src/types/CtrlYokeSettings.ts:50-55`) gains
  `format: StatusLineSegment[]`; the `DEFAULT_STATUSLINE_SETTINGS` in
  `ctrlyoke-statusline-wrapper.js` and the `CtrlYokeSettings.ts` defaults block
  (lines ~380-385) both get the Decision 3 shared default array.
- `ConfigurationUtils.getStatusLineTrackingSettings(provider)` needs no change — it already
  returns the whole typed object generically.
- `schemas/settings-schema.json`'s `usageTracking` definition (currently
  `enabled`/`providerRefreshEnabled`/`persistObservedUsage`/`warningPercentUsed`, starting at line
  442) gains `percentDirection: "used" | "remaining"` (default `"used"`), normal (non-machine)
  scope. Note `usageTracking.enabled` specifically *is* listed in
  `WORKSPACE_FORBIDDEN_SETTING_ROOTS` (`CtrlYokeConfigService.ts:27-32`) while its siblings are
  not — `percentDirection` follows the siblings and must **not** be added to that list. `CtrlYokeSettings.ts`'s `usageTracking` interface and defaults block gain the matching
  field; a new `SETTING_PATHS.USAGE_TRACKING_PERCENT_DIRECTION` entry alongside the existing
  `USAGE_TRACKING_ENABLED`.

## Phases

1. **Spike**: the field-availability research above already confirms every registry field's
   exact payload shape for both providers (no more open questions about `cost`, since it's out
   of the registry entirely) — so this spike narrows to settling the Decision 11(a) vs 11(b)
   build-dependency question with a throwaway bundler test before committing to a preview/shared-
   module architecture. Include `formatUsagePercentForDisplay` (Decision 6) in that spike's scope
   alongside the window-ordering/labeling functions, since it's a candidate for the same
   extraction.
2. Field registry + segment-driven `formatBrandedStatusLine` rewrite in
   `ctrlyoke-statusline-wrapper.js`, including the `usage1`/`usage2` extractor (Decisions 4-5), the
   `percentDirection` read (Decision 6, wrapper side only — resolved the same tolerant way as the
   rest of `resolveStatusLineSettings`, defaulting to `"used"` on anything malformed), the
   Decision 3 shared default array, the Decision 7 tolerance rules, the `branch`/`date`/`time`
   extractors (Decision 15 — `branch` via `.git/HEAD` read with worktree-gitdir-redirect and
   detached-HEAD handling; `date`/`time` via `new Date()`), and `color`/`label` segment resolution
   (Decisions 13-14). Extend the existing wrapper test suite (already covers both providers'
   settings resolution, stdout, failure/timeout, malformed input) with segment-driven cases: empty
   format, unknown/removed field id, all-literal format, format with only a subset of fields, each
   new field (`version`/`cwd`/`sessionId`/`branch`/`date`/`time`) rendered correctly for both
   providers, `branch` specifically covering a plain repo, a worktree
   (`gitdir:` redirect), a detached HEAD, and a non-repo `cwd`, `usage1`/`usage2` ordering +
   absence-handling for both the fixed-enum (Claude) and dynamic-tier (Antigravity, including the
   single-tier case) paths, both `percentDirection` values for `usage`/`usage1`/`usage2`, `color`
   overriding (and not overriding, when unset) `context`'s band coloring, and `label` substituting
   a field's internal label slot where one exists and no-oping where one doesn't.
3. Settings/schema/type plumbing: `format` field, `percentDirection` field, new `SETTING_PATHS`
   entries, schema definitions, defaults.
4. `UsageCard.tsx`/`usageBarColor.ts` changes: read `percentDirection` for the displayed
   quota number/label, while confirming every `getUsageBarColorClass` call site — including
   `WorkflowStep.tsx:388-390`'s unrelated context-bar usage — still receives a used%-oriented
   value regardless of the setting (Decision 6's critical catch). This phase's tests should
   specifically assert the context bar's coloring is unaffected by `percentDirection`.
5. UI: new "Status Line" settings tab (`ALL_TABS` entry + render switch in
   `GlobalSettingsDrawer.tsx`, mirroring how "Stats & Usage" was added — Decision 12) hosting the
   relocated `StatusLineTrackingControls` blocks; `StatusLineFormatEditor`, live preview (per
   Phase 1's architecture decision), reset, wired into each provider's `StatusLineTrackingControls`
   on that new tab; the per-segment color swatch picker (Decision 13) and custom-label input
   (Decision 14, shown conditionally); the `percentDirection` control stays in
   `StatsUsageSection.tsx` (Decision 6); focused component tests alongside the existing
   `StatusLineTrackingControls`/`UsageCard` coverage, plus a test confirming the new tab appears
   in the settings drawer's tab list.
6. Update `STATUSLINE_USER_CONTROLS_PLAN.md`'s "UX Risks Found In Review" section, which
   currently frames "write your own script" as the only escape hatch from ctrlyoke's fixed line
   — note this plan as the closing answer once shipped.

## Staging vs. `SETTINGS_UI_PARITY_PLAN.md`

**No strict dependency either direction — the two plans can be worked in parallel, or in either
order.** Checked for real coupling (2026-08-21) and found none: `SETTINGS_UI_PARITY_PLAN.md`'s
remaining work (the four `usageTracking.*` toggles, the `modelPricing` editor) is about
data-collection/cost settings; this plan is about display formatting. Neither reads or depends on
the other's settings or code paths.

Both plans edit `StatsUsageSection.tsx`, but in disjoint regions: the parity plan adds toggles near
the top (where they gate the stats rendered below); this plan's only edit to that file is
*removing* the statusline block (Decision 12) and adding the `percentDirection` control. Whichever
lands first, the other's diff doesn't meaningfully conflict with it.

**One operational watch-item, not a blocker.** This plan introduces a brand-new schema leaf,
`usageTracking.percentDirection` (Decision 6), sitting in the same `usageTracking` object
`settingsSchemaUiParity.integration.test.ts` already inventories (the test that backs
`SETTINGS_UI_PARITY_PLAN.md`'s `PENDING_UI_PARITY` list). If this plan's Phase 3 (schema) and its
`percentDirection` UI control (Phase 5) ever land in *separate* merges instead of together, that
test will flag a new gap in the interim — fix, if it happens, is adding
`permissions.usageTracking.percentDirection` to `PENDING_UI_PARITY`, same as any other
tracked-but-not-yet-controlled setting. Landing schema and control together (as this plan's own
Phase breakdown already intends) avoids needing that at all.

**Recommended build order, within this plan, independent of the parity plan's own schedule**:
Decision 16 (always-show `useCtrlyokeStyle`) and Decision 12 (the "Status Line" tab itself) have
zero dependencies on anything else in this plan — including Phase 1's spike — and can ship as
standalone changes before the rest: **16 → 12 → Phase 1 spike → 3 → 2 → 4 → 5 → 6.**

**Phase 3 moves ahead of Phase 2 (revised in the orchestration pass, 2026-08-21).** The phase list
below is written 2-before-3 (wrapper first, then types/schema), but the wrapper is a *consumer* of
this plan's new contracts — `StatusLineSegment`, the `StatusLineFieldId` registry, the
`StatusLineColorId` registry, the shared default array, and `percentDirection` — and those
contracts have to be single-sourced somewhere before two independent implementations start
guessing at them. Building the wrapper first means the wrapper's hand-rolled shapes become the de
facto source of truth and the TS types get retrofitted to match, which is backwards for a codebase
whose stated rule is that contracts live in `src/types` / `schemas`. Land the type/schema/defaults
plumbing first, then implement the wrapper against it. Nothing in Phase 3 depends on Phase 2, so
this reorder costs nothing.

## Follow-up: extend statusline tracking to Copilot and Qwen (not in this plan's scope)

`STATUS_LINE_TRACKING_PROVIDERS`/`StatusLineTrackingHarnessId` (`src/types/DashboardConstants.ts`)
and `STATUS_LINE_HARNESS_IDS` (`StatsUsageSection.tsx`) are currently a fixed two-entry set
(`claude`, `antigravity`), matching `STATUSLINE_USER_CONTROLS_PLAN.md`'s original scope. Copilot
CLI and Qwen Code also support a configurable statusline in their native CLIs and are candidates
for the same tracking + format-editor treatment this plan and `STATUSLINE_USER_CONTROLS_PLAN.md`
built for Claude/Antigravity. Noted here as a planned follow-up, not designed yet — it needs its
own pass to confirm, per provider: the statusline config mechanism (global settings file vs.
per-invocation flag — the same idempotent install/uninstall lease approach `StatuslineManager`
already uses may not transfer directly), and the payload schema (whether either exposes the same
normalizable `context_window`/usage-window shape the Field Availability Research section above
relied on for Claude/Antigravity, or whether the field registry needs per-provider availability
gating reintroduced — the exact complication Decision 2 above was able to avoid by requiring every
registry field to mean the same thing on both existing providers). This is the second, independent
reason (alongside the format editor's own size) that statusline configuration gets a dedicated tab
in Decision 12 rather than staying folded into Stats & Usage — two more provider blocks fit far
more comfortably as tab content than as a growing sub-section.

## Open Questions

None currently. Both prior questions here (`date`/`time` inclusion, and what "user identity"
should mean) were resolved in design discussion on 2026-08-21 — see Decision 15 for the settled
outcome of each (`date`/`time`: yes, opt-in only; user identity: rejected, not built) and Decision
1 for the settled "no raw string/conditional mode" question.
