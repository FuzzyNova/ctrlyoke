# Highlight a UI Control Plan

**Status:** Proposed 2026-10-24. Not started.

Last reviewed against code: 2026-10-26.

**Goal:** a single "take me to this control" action: open the surface that holds the control, scroll
it into view, and highlight it until the user acts on it or looks away. Start with Global Settings
rows, so every confirmation dialog and compatibility warning can offer **Show setting**. Build it
so walkthroughs and getting-started flows can later use the same mechanism on non-settings
controls.

## 1. Why

- **Confirmation dialogs name a setting they cannot show.** The delete, reset,
  continuation-discard and re-run modals (`components/shared/*ConfirmModal.tsx`) each persist one
  `ui.confirm*` setting from inside the dialog. A user who wants to see or reset that choice later
  has to know it lives under General → UI Preferences.
- **Compatibility warnings explain a problem but do not lead to the fix.** "Allowed Tools are NOT
  ENFORCED by the codex-cli harness" (`getCompatibilityDiagnosticMessage` in
  `src/types/CompatibilityTypes.ts`) is shown in the properties drawer, the workflow properties
  panel, `DryRunModal`, `FieldDiagnostic` and `PermissionCapabilitySummary`. The controls that
  matter (`permissions.codexSandboxMode`, `permissions.codexApprovalPolicy` in
  `AdvancedPermissionsSection.tsx`) are several clicks away.
- **Walkthroughs need it.** A getting-started flow that says "set your default harness here" is
  far clearer when "here" lights up.

## 2. What already exists

Most of the plumbing is in place for settings search. This feature should reuse it, not
duplicate it.

| Piece              | Where                                                                                                                                                                            | What it gives us                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings catalog   | `components/settings/settingsCatalog.ts` (`SETTINGS_CATALOG`, `SETTINGS_CATALOG_ENTRIES`)                                                                                        | Every setting row's `id`, `path`, `tab`, label and `revealedBy` (the row that must be enabled before a dependent row renders). That is a complete map from setting path to tab. |
| Row anchors        | `SettingInputRow`/`SettingToggleRow` put `data-settings-search-id={entry.id}` on their root; landmark sections add `landmark:*` ids by hand.                                     | A DOM handle for every row, already used for search.                                                                                                                            |
| Scroll to a row    | The `settingsSearch.activeMatchId` effect in `GlobalSettingsDrawer.tsx`                                                                                                          | Finds the row by id (falling back to `revealedBy`), then calls `scrollIntoView({ block: "nearest" })` inside a `requestAnimationFrame` after the tab renders.                   |
| Active-row styling | `useSettingMatch(settingKey)` gives `isActive`, rendered as `outline-solid outline-1 outline-focus-border`                                                                       | The highlight look already used for search matches.                                                                                                                             |
| Open a tab         | `uiStore.setGlobalSettingsTab` + `toggleGlobalSettings`; `MESSAGE_TYPES.OPEN_GLOBAL_SETTINGS_TAB` (extension → webview, used by `CtrlYokeWebviewProvider.openGlobalSettingsTab`) | Tab navigation, from the webview or from the extension host.                                                                                                                    |

What is missing is a **target that outlives the search box**. Today the scroll and the highlight
only run while `settingsSearch.isOpen`.

## 3. Proposed design

### 3.1 A highlight target in `uiStore`

```ts
interface UiHighlightTarget {
  /** Settings catalog id, or a `landmark:*` id. */
  id: string;
  /** Where it lives. Only settings for now. */
  surface: typeof HIGHLIGHT_SURFACES.GLOBAL_SETTINGS;
  /** Bumped on every request so asking for the same control twice re-runs the scroll and pulse. */
  nonce: number;
}
```

- `highlightControl(id)` resolves the tab from `SETTINGS_CATALOG[id].tab`, sets
  `globalSettingsActiveTab`, opens the drawer, and stores the target. It should not touch
  `settingsSearch`: a highlight is not a search, and it must not leave the search box open.
- The target is not persisted. It clears when the user changes that control, switches tab, closes
  the drawer, or after a timeout (about 6 s, so the cue does not linger on a phone that was put
  down).
- Add `HIGHLIGHT_SURFACES` to `DashboardConstants.ts` with only `GLOBAL_SETTINGS` for now. The
  surface field is there so that later targets (a step row, a header button, a workspace-viewer
  tab) do not need a second mechanism.

### 3.2 One "reveal" path, shared with search

Pull the find-by-id → `revealedBy` fallback → `scrollIntoView` logic out of the
`GlobalSettingsDrawer` effect into a helper (for example `revealSettingsRow(root, id)`), and call
it from both the search effect and a new highlight effect. Both paths then reveal a row
the same way, and a fix to one cannot drift from the other.

Use `block: "center"` for the highlight (the user did not scroll there themselves, so the control
should not land at the bottom edge). Keep `"nearest"` for search, where results are stepped through
one by one.

### 3.3 The look

- Reuse the search outline (`outline-focus-border`) so a highlighted row matches an active search
  match. Add a short pulse (two cycles, then steady) so the eye finds it after the drawer slides
  in. Honour `prefers-reduced-motion` by showing the outline without the pulse.
- Move focus to the row's control (`#id` of the input or select) so keyboard and screen-reader
  users land on it as well. Announce "Showing setting: <label>" through the existing live region if
  there is one.
- Check High Contrast themes: the outline must stay visible against `contrastActiveBorder`.

### 3.4 Dependent rows (`revealedBy`)

When the target only renders after another setting is enabled (for example `server.tls.*` under
`server.tls.enabled`), highlight the `revealedBy` row instead and say so in the cue text ("Turn this
on to see <label>"). Never flip the parent setting on the user's behalf.

## 4. First consumers

1. **Confirmation dialogs.** Add a quiet **Show setting** link to `DeleteConfirmModal`,
   `ResetConfirmModal`, `SuffixEditConfirmModal` and `RerunConfirmModal`. The link closes the dialog
   without performing the action, then highlights `ui.confirmDeleteOperations`,
   `ui.confirmResetOperations`, `ui.confirmContinuationDiscardOperations` or
   `ui.confirmRerunOperations`. All four live in `GeneralSection.tsx` → UI Preferences. Put the link
   in one shared spot (next to `DontAskAgainCheckbox`, or a small `ShowSettingLink`) instead of
   adding it to each modal by hand.
2. **Codex permission warnings.** Give the compatibility diagnostics an optional target, ideally
   through `getCompatibilityDiagnosticRemediation` (`CompatibilityTypes.ts`), so that every surface
   rendering a diagnostic gets the action for free:
   - `ALLOWED_TOOLS_NOT_ENFORCED` / `DENIED_TOOLS_NOT_ENFORCED` on codex-cli →
     `permissions.codexSandboxMode`
   - the approval-related codes → `permissions.codexApprovalPolicy`

   Both rows are in `AdvancedPermissionsSection.tsx` (Permissions tab). Keep the target as data (a
   catalog id), not a callback, because `CompatibilityTypes.ts` is shared with the CLI and must stay
   free of UI code.

3. **Extension-host callers.** Widen `OPEN_GLOBAL_SETTINGS_TAB` additively with an optional
   `highlight` id, or add a sibling `HIGHLIGHT_CONTROL` message, so commands and walkthrough steps
   in VS Code can drive the same path. `openGlobalSettingsTab` currently accepts only
   `"secrets" | "license"`.

## 5. Later: beyond settings

Walkthrough targets that are not settings rows: the header Run button, the workflow picker, the
steps panel, the prompt editor. They need:

- a stable anchor attribute for non-settings controls (`data-cy-highlight-id`), with the valid ids
  kept as a typed `const` so a renamed control fails the type check instead of silently
  highlighting nothing;
- a surface resolver per `HIGHLIGHT_SURFACES` entry that knows how to make the control visible
  (open a drawer, expand a mobile panel, switch an output tab);
- a coach-mark style callout (text next to the highlight) once custom tooltips exist. See
  `CUSTOM_TOOLTIPS_PLAN.md`, which is building a themed tooltip layer that can host it.

Keep this out of the first cut. The settings case should ship on its own.

## 6. Gotchas to respect

- **Only the active tab is mounted:** the settings drawer renders the active tab only, so the
  reveal must wait for that tab's rows to mount. The existing `requestAnimationFrame` handles one
  frame. A lazily loaded section (stats, MCP manager) may need to retry until the anchor appears,
  within a bounded number of frames.
- **Mobile:** the drawer is full-screen on phones. Opening it from a modal must close the modal
  first, or the modal's focus trap fights the drawer's.
- **Hosted browser and VS Code panel share the bundle:** keep everything client-side in `uiStore`.
  Do not route the highlight through the extension for webview-initiated cases.
- **Read-only settings** (`globalSettingsReadOnly`): still highlight, since seeing the value is the
  point, but the cue must not suggest the row can be edited.

## 7. Tests

- `GlobalSettingsDrawer`: highlighting a catalog id opens the right tab, scrolls the row, applies the
  highlight class, and clears it on change, tab switch, close and timeout. A second request for the
  same id re-runs the scroll (nonce).
- `revealedBy` fallback highlights the parent row.
- Each confirmation modal's **Show setting** link closes the dialog without firing its action and
  highlights the right id.
- A compatibility diagnostic with a target renders the action in `FieldDiagnostic` and
  `PermissionCapabilitySummary`, and the target id exists in `SETTINGS_CATALOG` (a table test over
  every diagnostic code that names one, so a renamed setting fails the test).
