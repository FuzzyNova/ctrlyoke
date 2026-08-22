# Status Line Shared/Per-Harness Format Toggle Plan

> **Status:** Not implemented. Motivated by upcoming Copilot and Qwen statusline support
> (`STATUS_LINE_TRACKING_PROVIDERS` currently has 2 entries — `claude`, `antigravity` — and
> is about to grow to 4), but this plan only builds the shared/per-harness toggle mechanism.
> Adding the new providers themselves is separate, larger work and not covered here.

## Goal

Today `StatusLineSection.tsx` renders one full `StatusLineTrackingControls` block — including
its own embedded `StatusLineFormatEditor` — per tracked harness (`STATUS_LINE_HARNESS_IDS` in
`src/ui/webview-react/components/settings/StatusLineSection.tsx:8-11`). A user who wants the
same look everywhere has to configure the format N times, once per harness, with no way to
keep them in sync short of manually repeating every edit. At 2 harnesses this is mildly
annoying; at 4 it's a real tax on the common case (most users want one consistent statusline
everywhere, not per-harness bespoke formats).

Add a setting that, by default, shows a **single** format editor whose output applies to every
harness, with an opt-in to break out per-harness formats for users who actually want them.

## Naming

Setting: `useDifferentFormatPerHarness: boolean`, default `false`.
Label: **"Use a different status line format per harness"**.

This is the inverse framing of the "apply to all" checkbox floated in conversation. Reasoning:
the simple, no-per-harness-fuss experience is the default for every new install, and a
default-checked checkbox reading "apply to all" would sit there checked-and-unremarkable for
everyone who never needs the advanced path. Naming the boolean after the opt-in behavior
(`useDifferentFormatPerHarness`) means the control reads as "turn this on for more control,"
which is what's actually happening, and keeps the false/default state doing the semantic work
instead of a checked-by-default box. Same tradeoff already exists in this file's
`useCtrlyokeStyle` (positive framing, defaults `true`) — the difference here is which state is
the common case.

## Behavior spec

- **`useDifferentFormatPerHarness: false` (default) — shared mode.** `StatusLineSection`
  renders exactly one `StatusLineFormatEditor`, backed by a new
  `permissions.statusLineTracking.sharedFormat` setting. Each harness's own
  `enabled` / `customCommand` / `useCtrlyokeStyle` rows still render per-harness inside their
  existing `StatusLineTrackingControls` blocks — only the format editor itself is centralized.
  Each harness's per-provider `format` field is **not** touched while in this mode; it just
  isn't the value driving rendering.
- **`useDifferentFormatPerHarness: true` — per-harness mode.** Behaves exactly as today:
  each `StatusLineTrackingControls` block renders its own `StatusLineFormatEditor` bound to
  that provider's own `format` field. `sharedFormat` is not touched while in this mode.
- **Turning the toggle ON (false → true):** for every provider whose current `format` is still
  structurally equal to `DEFAULT_STATUS_LINE_FORMAT` (i.e. never customized), seed it with a
  clone of the current `sharedFormat` value, so switching to per-harness view doesn't dump the
  user back to the generic default for harnesses they hadn't touched yet. Any provider whose
  `format` already diverges from the default is left completely alone. This is the one
  direction that writes multiple settings at once.
- **Turning the toggle OFF (true → false):** pure read — no writes. `sharedFormat` keeps
  whatever value it already had.
- **Net effect:** per-provider `format` values are never destroyed by toggling either
  direction. A user with 4 already-unique per-harness formats who flips the toggle on and back
  off lands on the same 4 unique formats. `sharedFormat` is a fully independent value, edited
  only while the toggle is off, and it survives being toggled away from and back to.

## Data model changes

- `src/types/CtrlYokeSettings.ts` — `CtrlYokeGlobalSettings.permissions.statusLineTracking`
  (currently `Record<StatusLineTrackingProvider, StatusLineTrackingSettings>`,
  `CtrlYokeSettings.ts:118-121`) gains two sibling keys:
  ```ts
  statusLineTracking: Record<StatusLineTrackingProvider, StatusLineTrackingSettings> & {
    useDifferentFormatPerHarness: boolean;
    sharedFormat: StatusLineSegment[];
  };
  ```
  `DEFAULT_GLOBAL_SETTINGS` (`CtrlYokeSettings.ts:384-397`) needs
  `useDifferentFormatPerHarness: false` and
  `sharedFormat: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }))` alongside the
  existing per-provider entries.
- `schemas/settings-schema.json:420-430` — add `useDifferentFormatPerHarness` (`boolean`,
  default `false`) and `sharedFormat` (reuse the existing `format` array schema currently
  inlined under `statusLineTrackingSettings.format`, `settings-schema.json:905ff` — pull it out
  into its own `$ref`-able definition so `sharedFormat` and every per-provider `format` share
  one schema instead of duplicating the segment `oneOf`).
- `src/types/DashboardConstants.ts:1075-1091` — add
  `PERMISSIONS_STATUS_LINE_TRACKING_USE_DIFFERENT_FORMAT_PER_HARNESS` and
  `PERMISSIONS_STATUS_LINE_TRACKING_SHARED_FORMAT` to `SETTING_PATHS`.
- `src/utils/ConfigurationUtils.ts:761-780` — add `getSharedStatusLineFormat()` /
  `isUseDifferentFormatPerHarness()` (or a single `getStatusLineFormatMode()` returning both)
  next to `getStatusLineTrackingSettings`, and a setter for `sharedFormat` following the same
  `configService.set(path, value, CONFIG_SCOPE.USER)` shape as
  `setStatusLineTrackingSettings`.
- No migration needed. This is pre-release with no installs to account for besides the
  developer's own, so the two new keys just take their static schema defaults
  (`useDifferentFormatPerHarness: false`, `sharedFormat` = the default format) like any other
  new setting — no special-casing for pre-existing per-harness formats.

## Runtime resolution (statusline wrapper script)

`src/scripts/ctrlyoke-statusline-wrapper.js` is the actual runtime consumer — `resolveStatusLineSettings` (`ctrlyoke-statusline-wrapper.js:107-176`) reads `.ctrlyoke/settings.json`
directly and returns `configured.format` per provider; the two per-harness entry scripts
(`ctrlyoke-claude-statusline.js`, and the Antigravity equivalent) pass that straight into
`formatBrandedStatusLine`. This resolution needs the same shared/per-harness branch:

```js
const useDifferentFormatPerHarness = typeof tracking?.useDifferentFormatPerHarness === "boolean"
  ? tracking.useDifferentFormatPerHarness
  : false;
const effectiveFormat = useDifferentFormatPerHarness
  ? configured?.format
  : tracking?.sharedFormat;
```

This file's header comment is explicit that it "must remain standalone and depend only on Node
built-ins" — it can't `require` `ConfigurationUtils`. So this branch has to be a second,
hand-kept copy of the same rule the webview/extension side applies, not a shared import. Keep
`src/test/unit/StatuslineWrapper.test.ts` (already exists) covering both toggle states so drift
between the two copies gets caught.

## UI changes

The driving reason for this feature is that 4 full format-editor blocks (drag-and-drop rows,
color pickers, add/remove controls) is a lot of vertical space — so in shared mode, the
per-harness editor doesn't just defer to the shared one, it's **completely absent**, not
collapsed or grayed out. What each harness block keeps instead is a live preview, so switching
the toggle doesn't leave 4 harnesses silently unaccounted for.

- Extract the current preview block (`StatusLineFormatEditor.tsx:370-390`,
  `renderStatusLinePreview` + `previewPayload`) into a standalone `StatusLinePreview` component
  taking `format`, `provider`, `snapshot`, and `percentDirection` — the same inputs
  `StatusLineFormatEditor` already threads through today. `StatusLineFormatEditor` keeps
  rendering it internally by default (per-harness mode needs no behavior change at all), gated
  behind a new optional `hidePreview?: boolean` prop for the one case that needs to suppress it.
- `StatusLineFormatEditor` also gets an optional `onDraftChange?: (format: StatusLineSegment[]) => void`,
  fired everywhere `commit()` already fires internally (`StatusLineFormatEditor.tsx:284-287`).
  This lets a parent observe the live in-progress draft without owning it — needed so the
  per-harness previews below can track the shared editor's edits instantly, the same way the
  editor's own internal preview does today, rather than waiting on a settings round-trip.
- `StatusLineSection.tsx` — add the `SettingToggleRow` for `useDifferentFormatPerHarness`.
  When `false` (shared mode): keep local state `sharedDraft` seeded from `sharedFormat` and
  render one `<StatusLineFormatEditor format={sharedFormat} onCommit={...→ sharedFormat...}
  onDraftChange={setSharedDraft} hidePreview />` above the harness list, then pass `sharedDraft`
  down into each `StatusLineTrackingControls`.
- `StatusLineTrackingControls.tsx` — when shared mode is active, don't render
  `StatusLineFormatEditor` at all (`StatusLineTrackingControls.tsx:205-213`); render
  `<StatusLinePreview format={sharedDraft} provider={...} snapshot={snapshot}
  percentDirection={...} />` in its place, gated behind `tracking.useCtrlyokeStyle` exactly
  like the existing editor already is — a harness with ctrlyoke styling turned off wouldn't
  show this format anyway, so previewing it there would be misleading. The
  `enabled` / `customCommand` / `useCtrlyokeStyle` rows are untouched either way — only the
  format section (editor vs. preview-only) is conditional.
- The global shared editor itself doesn't get its own preview (`hidePreview` above) — the 4
  per-harness previews underneath already show it live as it's edited, and a 5th generic one
  next to the editor would be redundant and cost back exactly the vertical space this feature
  is trying to save. This also sidesteps a real inaccuracy a single generic preview would have
  had: Claude-shaped and Antigravity/Gemini-shaped payloads render the same segment list
  slightly differently (compare `text = ${label || (provider === CLAUDE ? "rate" : "quota")}`
  at `StatuslineFormat.ts:549`) — showing one preview per actual harness means each preview is
  already correct for that harness's payload shape, with no separate handling needed.

## Coordinated write path

The false → true transition needs a multi-field write (the toggle itself, plus conditionally
seeding any still-default provider `format`s from `sharedFormat`), so it should follow the
same dedicated-message pattern already used for `DISABLE_STATUS_LINE_TRACKING` rather than
issuing several raw `UPDATE_GLOBAL_SETTING` calls from the webview:

- New message type in `MESSAGE_TYPES` (`DashboardConstants.ts:145` is the existing
  `DISABLE_STATUS_LINE_TRACKING` entry to sit next to), e.g.
  `SET_STATUS_LINE_FORMAT_MODE: "setStatusLineFormatMode"`, carrying
  `{ useDifferentFormatPerHarness: boolean }`.
- `WebviewMessageRouter.ts` — a `table.set(MESSAGE_TYPES.SET_STATUS_LINE_FORMAT_MODE, ...)`
  entry next to the existing one at `WebviewMessageRouter.ts:1549-1565`, delegating to a new
  `WebviewSettingsSync` method.
- `WebviewSettingsSync.ts` — new `handleSetStatusLineFormatMode`, modeled on
  `handleDisableStatusLineTracking` (`WebviewSettingsSync.ts:1064-1101`): write the boolean via
  `ConfigurationUtils`; when transitioning to `true`, iterate every
  `StatusLineTrackingProvider`, and for each whose current `format` deep-equals
  `DEFAULT_STATUS_LINE_FORMAT`, call `setStatusLineTrackingSettings` with `sharedFormat`
  cloned in.
- New helper `isDefaultStatusLineFormat(format: StatusLineSegment[]): boolean` in
  `src/utils/StatuslineFormat.ts` next to `DEFAULT_STATUS_LINE_FORMAT`, used by
  `handleSetStatusLineFormatMode`. Simple deep-equality against the default array — needed
  because `StatusLineTrackingSettings.format` is never `undefined`/absent, so "never
  customized" can only be detected by comparing values, not presence.

## Affected components

| Component | Planned role |
| --- | --- |
| `CtrlYokeSettings.ts` | New `useDifferentFormatPerHarness` / `sharedFormat` fields + defaults |
| `settings-schema.json` | Schema for the two new fields; extract shared `format` array definition |
| `DashboardConstants.ts` | New `SETTING_PATHS` entries, new `MESSAGE_TYPES` entry |
| `ConfigurationUtils.ts` | Getters/setter for the new fields |
| `StatuslineFormat.ts` | `isDefaultStatusLineFormat` helper |
| `ctrlyoke-statusline-wrapper.js` | Mirror the shared/per-harness resolution rule (standalone copy, can't import) |
| `StatusLineFormatEditor.tsx` | New `hidePreview` / `onDraftChange` props; extract `StatusLinePreview` out of it |
| `StatusLinePreview.tsx` (new) | Preview-only component reused by the editor (default) and by each harness block in shared mode |
| `StatusLineSection.tsx` | Toggle row; owns `sharedDraft` state; single shared editor (no preview) vs. per-harness blocks |
| `StatusLineTrackingControls.tsx` | In shared mode, renders `StatusLinePreview` instead of `StatusLineFormatEditor`, gated on `useCtrlyokeStyle` |
| `WebviewMessageRouter.ts` / `WebviewSettingsSync.ts` | New coordinated message for the false→true seed-defaults write |

## Non-goals

- Adding the Copilot/Qwen statusline providers themselves — separate work. This plan only
  needs the toggle mechanism to already scale cleanly to N providers, which it does since
  `Record<StatusLineTrackingProvider, StatusLineTrackingSettings>` doesn't change shape as
  `STATUS_LINE_TRACKING_PROVIDERS` grows.
- A first-run migration that inspects existing per-harness formats to pick a smarter initial
  `useDifferentFormatPerHarness` default — moot pre-release (see Data model changes above).

## Open questions

- Small implementation detail: each per-harness preview in shared mode should probably carry
  a short label (e.g. the harness name) so it's clear which harness it's previewing, since the
  block around it no longer has an editor giving that context implicitly. Exact placement/
  wording left to implementation.
