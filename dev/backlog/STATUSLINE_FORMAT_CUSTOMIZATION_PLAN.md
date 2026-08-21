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
     | { type: "field"; field: StatusLineFieldId }
     | { type: "literal"; text: string };
   ```
   Rejected alternative: a `printf`-style template string (e.g. `"{model} · {context}"`). An
   array of segments keeps the field vocabulary closed and typed — consistent with this
   project's "no hardcoded strings for flow control" rule (`CLAUDE.md`) — keeps the detached
   wrapper's parser trivial (iterate + `switch`, nothing to tokenize or fail to parse), and lets
   the settings UI render an editable list (toggle/reorder/insert) instead of a free-text box a
   user can typo into a broken statusline with no feedback loop. Trade-off: no inline
   conditionals ("show X only if Y ≥ Z") — not requested, out of scope.

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
   additional sanitization beyond the newline strip is warranted. Users who want ANSI color in a
   literal segment can type raw escape codes; no dedicated color-picker affordance in MVP (see
   Open Questions).

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

11. **Preview must reuse the real formatter, not a second hand-rolled one.** A settings-UI
    preview line that re-implements field formatting in TSX would drift from the wrapper's actual
    output the first time either one changes — exactly the duplication this project's CLAUDE.md
    prohibits ("Never duplicate code that can be single sourced"). The wrapper
    (`src/scripts/ctrlyoke-statusline-wrapper.js`) is plain CommonJS with zero bundler-resolved
    imports, by design, so it can run as a detached process outside the extension's module graph
    (`STATUSLINE_USER_CONTROLS_PLAN.md`'s Wrapper Script Consolidation section already establishes
    this constraint and that `esbuild.js`'s `copy-scripts` plugin only copies the flat immediate
    children of `src/scripts/`, not nested folders). Two options, needing a build-time spike
    before picking one:
    - **(a)** Extract the pure, side-effect-free formatting functions (`getContextValues`,
      `getQuotaPercentage`, `formatCompactTokenCount`, `calculateContextPercentage`,
      `getContextBand`, the new segment-driven `formatBrandedStatusLine`, and — net-new to this
      extraction scope, per Decisions 4-5 — `CLAUDE_RATE_LIMIT_WINDOWS`,
      `formatUsageWindowLabel`, `humanizeQuotaKey`, and `quotaWindowKind`) into an isomorphic TS
      module under `src/utils/`, imported both by the React preview/settings UI and, via a thin
      CommonJS re-export, by `src/scripts/ctrlyoke-statusline-wrapper.js` **and** by
      `ClaudeUsageProvider.ts`/`AntigravityUsageProvider.ts`, which already implement these exact
      functions for `UsageCard.tsx`'s data path. Without this, `usage1`/`usage2` would be a
      **third** independent reimplementation of window ordering and labeling — the wrapper
      duplicating logic the extension host already has, purely because of the module-boundary
      constraint, not because the logic actually differs. Preferred on DRY grounds, but needs
      verifying the extension-host/webview bundler and the scripts copier both resolve that
      re-export correctly — the wrapper today has intentionally zero external imports, and this
      would be the first exception.
    - **(b)** Push a live-rendered preview string from the extension host (which *can* `require()`
      the compiled `out/scripts/ctrlyoke-statusline-wrapper.js` directly, no bundler involved) down
      to the webview on every format edit, instead of rendering in React at all. Simpler
      dependency story, slightly higher latency per keystroke (mitigated by debouncing, same as
      any live-typed setting) — but does **not** solve the window-ordering/labeling duplication
      called out in (a), since the wrapper would still need its own copy of that logic even if the
      *preview* comes from the extension host. If (b) is chosen for the preview specifically, the
      window-ordering/labeling extraction from (a) should still happen on its own merits.

    Recommend (a) unless the Phase 1 spike finds a concrete bundler obstacle, since it also
    benefits any future non-webview consumer (CLI/MCP hosts) that might want to preview a format
    without spinning up a webview, and it closes the window-labeling duplication either way.

## UI Placement

- New `StatusLineFormatEditor` sub-component, rendered inside `StatusLineTrackingControls.tsx`
  (`src/ui/webview-react/components/settings/stats/StatusLineTrackingControls.tsx`), directly
  below the existing `useCtrlyokeStyle` toggle block (lines 185-198).
- **Visible only when `tracking.useCtrlyokeStyle === true`** — mirrors the existing pattern one
  level up, where the `useCtrlyokeStyle` toggle itself is only shown once `customCommand` is
  non-empty (`StatusLineTrackingControls.tsx:185`): don't show controls for output that isn't
  currently reaching the terminal. When `customCommand` is empty, `useCtrlyokeStyle` is always
  effectively `true` (that toggle is hidden, not off), so the format editor is visible in that
  case too.
- Per-segment row: a `field` segment shows its label with an include/exclude checkbox; a
  `literal` segment shows a small bounded text input (Decision 8's length cap). Up/Down move
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
  different direction than what the real statusline will render.
- **`percentDirection` toggle lives in `StatsUsageSection.tsx` itself, not in
  `StatusLineTrackingControls.tsx`** (see Decision 6) — it governs every harness's `UsageCard`,
  not just Claude/Antigravity's statusline, so it doesn't belong inside the per-provider
  statusline block. A simple two-option segmented control near the top of the section, alongside
  or near the existing `shareMetric`/`ScopeToggle` control already in that file
  (`StatsUsageSection.tsx:307-325`), is a reasonable, low-effort fit.

## Schema / Type Plumbing

- `schemas/settings-schema.json`'s `statusLineTrackingSettings` definition (currently
  `enabled`/`customCommand`/`useCtrlyokeStyle` only, lines ~906-922) gains a `format` array
  property: `items` as a `oneOf` of a field-segment shape (`field` enum sourced from the
  Decision 2 registry) and a literal-segment shape (`text` string, length-capped), with
  `additionalProperties: false` on both variants per the project's existing schema style.
- `StatusLineTrackingSettings` (`src/types/CtrlYokeSettings.ts:50-55`) gains
  `format: StatusLineSegment[]`; the `DEFAULT_STATUSLINE_SETTINGS` in
  `ctrlyoke-statusline-wrapper.js` and the `CtrlYokeSettings.ts` defaults block
  (lines ~380-385) both get the Decision 3 shared default array.
- `ConfigurationUtils.getStatusLineTrackingSettings(provider)` needs no change — it already
  returns the whole typed object generically.
- `schemas/settings-schema.json`'s `usageTracking` definition (currently
  `enabled`/`providerRefreshEnabled`/`persistObservedUsage`, lines
  442-465) gains `percentDirection: "used" | "remaining"` (default `"used"`), normal (non-machine)
  scope. `CtrlYokeSettings.ts`'s `usageTracking` interface and defaults block gain the matching
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
   Decision 3 shared default array, and the Decision 7 tolerance rules. Extend the existing
   wrapper test suite (already covers both providers' settings resolution, stdout,
   failure/timeout, malformed input) with segment-driven cases: empty format, unknown/removed
   field id, all-literal format, format with only a subset of fields, each new field
   (`version`/`cwd`/`sessionId`) rendered correctly for both providers, `usage1`/`usage2`
   ordering + absence-handling for both the fixed-enum (Claude) and dynamic-tier (Antigravity,
   including the single-tier case) paths, and both `percentDirection` values for
   `usage`/`usage1`/`usage2`.
3. Settings/schema/type plumbing: `format` field, `percentDirection` field, new `SETTING_PATHS`
   entries, schema definitions, defaults.
4. `UsageCard.tsx`/`usageBarColor.ts` changes: read `percentDirection` for the displayed
   quota number/label, while confirming every `getUsageBarColorClass` call site — including
   `WorkflowStep.tsx:388-390`'s unrelated context-bar usage — still receives a used%-oriented
   value regardless of the setting (Decision 6's critical catch). This phase's tests should
   specifically assert the context bar's coloring is unaffected by `percentDirection`.
5. UI: `StatusLineFormatEditor`, live preview (per Phase 1's architecture decision), reset,
   wired into `StatusLineTrackingControls.tsx`; the `percentDirection` control in
   `StatsUsageSection.tsx`; focused component tests alongside the existing
   `StatusLineTrackingControls`/`UsageCard` coverage.
6. Update `STATUSLINE_USER_CONTROLS_PLAN.md`'s "UX Risks Found In Review" section, which
   currently frames "write your own script" as the only escape hatch from ctrlyoke's fixed line
   — note this plan as the closing answer once shipped.

## Open Questions

- Whether literal segments should get a lightweight structured color option (e.g.
  `{ type: "literal", text: "...", color: "red" }`) instead of requiring users to paste raw ANSI
  codes by hand. Deferred — not requested, and raw-ANSI-in-a-text-field is a working MVP
  fallback that costs nothing to keep as the permanent option even if a color picker is added
  later.
- Whether to support per-field custom labels (e.g. relabel `context` as `"ctx"` instead of its
  full wording) as a fourth segment variant. Not requested; out of scope unless a concrete need
  shows up.
