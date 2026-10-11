# Template Variable Defaults Plan

**Status:** Ready to implement (not started)

## Goal

Let a user change the default value of any template variable — built-in or custom — so the next
time they open that template in **New Workflow** the field is already filled with _their_ value.

The motivating case is the two bug templates being made built-in (`bug-hunt-loop`,
`bug-drain-loop`). Every user who runs them has a fixed answer for `bugBacklogDir`,
`bugImplementedDir`, `testCommand`, and the two harness and model pairs, and today they retype those answers on
every run because the template's authored defaults (`bugs/backlog`, `claude-cli`/`codex-cli`) are
almost never right for them.

This is the first piece of a broader "make templates easier to edit" theme. Structural edits
(changing prompts or steps) are out of scope here; see [Relationship to copying](#decision-overlay-not-copy).

## Terminology

"Default template" already means something: `general.defaultTemplate`, the template the picker
pre-selects, set by the modal's **Set as Default** link (`TemplateModal.handleSetDefault` →
`SET_DEFAULT_TEMPLATE`). This plan is about **variable defaults**: the pre-filled value of one
input of one template. Code, settings, and UI copy must say "variable default" / "saved value",
never "template default", to keep the two apart. The two features do share one control, the
modal's scope toggle (see "Set as Default uses the same toggle").

Scopes are named **User** and **Workspace** everywhere in UI copy and in this plan, exactly as
the Settings drawer names them (`GlobalSettingsDrawer.tsx`). Never "all workspaces", "global",
or "this project".

## Decision: overlay, not copy

Two ways to implement "change a built-in's default":

1. **Copy on change.** The first time a user changes a default, copy the template into
   `~/.ctrlyoke/templates/` and edit `_templateMeta.variables.<name>.default` in the copy.
2. **Overlay.** Store `{ templateId → { variable → value } }` in settings and apply it on top of
   the template's authored defaults when templates are listed.

**Chosen: overlay.** Reasons:

- **A copy forks the whole template to change one value.** The copy freezes the prompts, steps,
  and agents as they were on the day of the copy. When a later ctrlyoke release improves the
  built-in bug-hunt prompt, the user's copy never gets it, and they don't know why their loop
  behaves differently from the docs. The user asked to change a value, not to own the template.
- **A copy duplicates the picker entry.** The user then sees both "Bug Hunt Loop" and their copy
  and has to remember which one carries their settings. Hiding the built-in when a copy exists
  is its own feature with its own surprises.
- **Some defaults are per-project and some are per-person.** A backlog directory belongs to a
  repo; a preferred harness belongs to the user. Settings already have exactly this split
  (user `~/.ctrlyoke/settings.json` vs workspace `.ctrlyoke/settings.json`). A copy lives in one
  place only.
- **Copying already exists for when it's actually wanted.** **New template…** in the picker
  (`TemplateManager.createCustomTemplate`) copies the selected template into either scope. That
  stays the path for structural edits, and an overlay on the built-in carries over (see
  Phase 3).

Overlays apply to custom templates too, keyed by their `custom:<scope>:<name>` id, so the feature
works the same everywhere. A user who owns a custom template file can still edit its
`_templateMeta` directly. The overlay just means they don't have to.

## Contract

### Setting

New settings root `templates`, in `schemas/settings-schema.json` + `CtrlYokeSettings.ts`:

```json
{
  "templates": {
    "variableDefaults": {
      "bug-hunt-loop": {
        "bugBacklogDir": "dev/bugs/backlog",
        "bugImplementedDir": "dev/bugs/implemented",
        "hunterHarness": "claude-cli",
        "hunterModel": "opus"
      },
      "custom:user:yoke-driven-loop": { "specFile": "docs/spec.md" }
    }
  }
}
```

- Values are strings, the same type as `TemplateVariable.default`.
- Allowed at both user and workspace scope. Workspace beats user **per variable**, not per
  template: a workspace that saves only `bugBacklogDir` still inherits the user's
  `hunterHarness`. The one exception is a harness and its linked models, which resolve from a
  single scope together (see "Harness and model pairs").
- **Do not rely on the generic merge.** `deepMerge` in `CtrlYokeConfigService.ts` only recurses
  into keys whose schema default is a plain object. `variableDefaults` defaults to `{}`, but the
  per-template objects under it have no default, so a workspace entry for `bug-hunt-loop` would
  replace the user's entire `bug-hunt-loop` entry. Read both scopes with
  `configService.getScoped("templates", scope)` and merge per variable in one helper (below).
  This is the same reason `getScoped` exists for array unions.

### Resolution (single source)

One pure module, `src/utils/TemplateVariableDefaults.ts`, resolves the effective default for
every variable, and every consumer goes through it. It has no Node or VS Code imports, so the
extension (`TemplateManager`, the save handler) and the dashboard (the Phase 2 settings editor)
import the same code. It owns the per-scope merge, the pair rule, the stale/invalid
classification, and the clear-instead-of-store comparison.

```
effective = workspace override ?? user override ?? authored _templateMeta default
```

`TemplateVariable` (and its mirror in `uiStore.ts`, which must stay identical) gains:

| Field             | Meaning                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `default`         | Now the **effective** default. Existing consumers keep working unchanged.              |
| `authoredDefault` | The template's own `_templateMeta` default, if any (the clear baseline at User scope). |
| `defaultSource`   | `TEMPLATE_VARIABLE_DEFAULT_SOURCES.{TEMPLATE,USER,WORKSPACE}`                          |

`defaultSource` values go in `DashboardConstants.ts` (flow-control strings rule).

Apply the overlay after `mergeVariablesWithMeta` in `getAvailableTemplates`. Because `default`
is already effective by then:

- `TemplateModal.seedVariableDefaults` pre-fills the saved value with no change.
- `createWorkflow`'s `withDefaults` loop substitutes the saved value when a caller omits the
  variable, so a non-modal caller gets the same result as the modal.
- `TEMPLATE_REQUIRED_VARIABLES_PLAN`'s `required` gate counts a saved value as satisfying the
  field, which is the right behaviour, and its Phase 2 blank fill applies only after the overlay.

### Stale and invalid overrides

Templates change underneath saved values. The resolver drops an override silently (debug log
only) when:

- the template no longer has that variable;
- it is a `harness` variable and the value is not in `HARNESS_IDS` (a harness was renamed or
  removed);
- it is a `select` variable and the value is not in `options`.

Leave the setting itself alone; a template edit may bring the variable back. Settings view
cleanup (Phase 2) is how users prune.

An override for a template id that no longer exists is likewise ignored.

### Harness and model pairs

A `model` variable is linked to a `harness` variable through its `harness` field (see
`docs/workflows/templates.md` and `TemplateManager.mergeVariablesWithMeta`). A model name only
means something on its own harness, so a harness and its linked models are saved, resolved, and
cleared as one unit, never one variable at a time:

- **Saving.** Pinning either control of a pair saves the harness and every model linked to it,
  at the toggle's scope, in one write. Saving a harness alone would leave the model on the
  template's authored default, which usually belongs to a different harness. Saving a model alone
  would break as soon as the harness changed.
- **The clear-instead-of-store rule applies to the whole pair.** The pin clears the pair's
  overrides at the toggle's scope only when the harness and every linked model all equal what
  the pair resolves to without that scope (see "Saving a value that's already inherited"). If
  any of them differs, it stores all of them, so a later change to the built-in's default
  harness can't leave a saved model paired with a harness it was never chosen for.
- **Resolution.** A linked model takes its value from the same scope as its harness, not from
  its own per-variable precedence. If the workspace saves `hunterHarness`, `hunterModel` comes
  from the workspace too, or from the authored default if the workspace entry has no model. It
  never comes from the user scope underneath. Pins always write the whole pair, so this only
  matters for hand-edited settings, but it means a resolved pair always comes from a single
  choice.
- **Stale overrides.** When a harness override is dropped (the value is no longer in
  `HARNESS_IDS`), drop its linked models' overrides from the same scope too. Do not check model
  names against a list in the extension: model lists are discovered per harness in the
  dashboard and may still be loading or offline. The modal's existing model warning
  (`modelWarning`) already flags a saved model the harness doesn't offer.
- **Clear saved value** on either control clears the whole pair at the scope it came from.
- **One marker per pair.** The pair shares a row in the modal, so it gets one "Saved (…)"
  marker and one pin/clear action rather than one per control.
- **Re-seeding must not trigger the harness-change reset.** `TemplateModal.handleVariableChange`
  clears a pair's models when its harness changes, so the effect can pick the new harness's
  default model. When a save re-sends the template list and the modal re-seeds the changed
  values, it must set the harness and model together directly, not through
  `handleVariableChange`. Otherwise the saved model would be replaced by the harness default.

## Phase 1 — store, resolve, and save from the modal

### UX

`TemplateModal` gets **one new** **User / Workspace** scope toggle, in its title bar, like the
one in the Settings drawer's title bar. It does not exist today. That single toggle controls
where every save in the modal is written:

- the existing **Set as Default** button in the footer (see "Set as Default uses the same
  toggle");
- every new per-variable **Save as default** pin and **Clear saved value** action.

Saving is therefore one click with no follow-up menu, and the current target is always visible.
Render it through `Modal`'s existing `headerActions` prop.

The modal's other User/Workspace control is unrelated and stays as it is: the **Location**
toggle inside the collapsed **New template…** form, which picks where a copied template _file_
is written (the same control `SaveWorkflowDialog` shows under **Save as Template**).

- **Single-source the options.** The drawer builds its User/Workspace options inline. Move them
  to a shared `SETTING_SCOPE_OPTIONS` beside `ScopeToggle` and use it in both places. Do **not**
  reuse `TEMPLATE_SCOPE_OPTIONS` (`templateScope.ts`): its tooltips describe template file
  locations (`.ctrlyoke/templates`), not where a setting is written. The title-bar toggle's
  `ariaLabel` should be "Save defaults to" so screen readers can tell it apart from the
  **Location** toggle.

- **Toggle starting value:** **Workspace** until the user has saved a value at least once;
  after that, whichever scope they saved to last. The last-saved scope is a persisted `uiStore`
  preference, written on save, not on merely flipping the toggle. It is a single value for
  every template and variable type. A per-type default (harnesses to user, folders to
  workspace) was considered and rejected: a rule that changes with the field is harder to
  predict than "where I saved last". With no workspace open the toggle is pinned to **User**
  and **Workspace** is disabled.
- **Save as default** (pin icon) on each variable input, shown when the field's current value
  differs from its effective default. Saves the value at the toggle's scope.
- **Saving a value that's already inherited clears instead** (see the next section).
- When a field's effective default comes from an override, its label shows a subtle
  "Saved (Workspace)" / "Saved (User)" marker naming where the value actually comes from. That
  may differ from the toggle. The action then becomes **Clear saved value** (tooltip names the
  scope), which clears the override at the scope it came from. It is deliberately not called
  "Reset to template default": if a User override is still underneath a cleared Workspace one,
  the field falls back to the User value, not the template's, and the marker updates.

### Saving a value that's already inherited

When a pin's value equals what the field would resolve to **without the toggle's scope**, the
handler removes the override at that scope instead of storing a duplicate:

- Saving at **User**: compare against the template's authored default.
- Saving at **Workspace**: compare against the User override if there is one, else the
  authored default.

Comparing against the authored default alone would be wrong. With `hunterHarness` saved as
`codex-cli` at User, pinning `claude-cli` (the authored default) at Workspace must store it.
Clearing would leave the field resolving to the User value, `codex-cli`, the opposite of what
the user just picked.

The cost: a value that matched the layer below at save time follows that layer if it changes
later. That is accepted. It's the same reason the rule exists at all: a later change to the
built-in's default still reaches a user who never actually chose something different.

### Set as Default uses the same toggle

**Set as Default** (`handleSetDefault`) currently writes `general.defaultTemplate` at User scope
unconditionally (`ConfigurationUtils.setDefaultWorkflowTemplate`). It now writes at the
toggle's scope, with the same behaviour as a variable pin:

- **Same scope rules.** It writes to the toggle's scope, and a successful write updates the
  persisted last-saved scope. A pin and **Set as Default** share that one preference.
- **Same clear rule.** If the selected template equals what `general.defaultTemplate` resolves
  to without the toggle's scope (the User value, or the schema default `blank`), clear the
  setting at that scope instead of storing it.
- **Source marker.** The "Default template" label becomes "Default template (Workspace)" /
  "Default template (User)" when the value comes from a saved setting, and stays plain when it
  is the schema default. Visibility is unchanged: **Set as Default** shows when the selected
  template is not the effective default.
- **Reading is unchanged.** `getDefaultWorkflowTemplate` reads the merged value, so a Workspace
  setting already beats User. `general.defaultTemplate` is a scalar, so the generic merge is
  correct here and needs no per-scope helper.
- **Where it lives.** `general.defaultTemplate` stays where it is. Moving it under `templates`
  would churn the General settings section and catalogue for no behavioural gain.

Why explicit, per field, instead of auto-remembering the last values used:

- Many fields hold one-off input (`featureDescription`, `specFile`) that should not come back
  pre-filled on the next run.
- An explicit pin makes the source of every pre-filled value visible, and "why is this field
  filled with that?" is the question auto-remember would raise.
- Saving the bug templates' four or five stable fields is a one-time, five-click job.

Not offered on multiline `text` fields: they are always one-off descriptions. Revisit if a real
template has a multiline value worth saving.

### Messages

- New `SET_TEMPLATE_VARIABLE_DEFAULTS` (webview → extension): `{ templateId, values:
Record<string, string | null>, scope: SettingWriteScope }`. A `null` value clears that entry.
  It carries several variables so a harness and its linked models save in one write. Remove the
  template's key entirely when its last variable is cleared.
- The handler writes through `CtrlYokeConfigService.set` at the given scope, then re-sends the
  template list through the same `toWireTemplates` path `handleNewWorkflow` uses, so the modal
  re-renders with the new `defaultSource` and doesn't need an optimistic copy of the resolution
  logic. Changing a saved value must **not** reset the other fields the user has already typed:
  re-seed only the variables in the saved message.
- The clear-instead-of-store comparison runs in the **extension** handler, against the resolver,
  not in the webview. The webview just sends what the user pinned.
- `toWireTemplates` passes `variables` through untouched, so the new fields need no wire change
  beyond the shared types.
- `SET_DEFAULT_TEMPLATE` gains `scope: SettingWriteScope`. `OPEN_NEW_WORKFLOW_MODAL` and
  `DEFAULT_TEMPLATE_SET` gain `defaultTemplateSource` (the same
  `TEMPLATE_VARIABLE_DEFAULT_SOURCES` values, where `TEMPLATE` means the schema default). The
  handler computes it with `getScoped("general", scope)`. The modal's current optimistic update
  sets the id only. It should wait for `DEFAULT_TEMPLATE_SET` before showing the source, since a
  clear can land on a different effective template than the one selected.

### Touchpoints

| File                                                             | Change                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`  | `templates.variableDefaults` (record of record of string), default `{}`               |
| `src/utils/TemplateVariableDefaults.ts` (new)                    | Pure resolver: per-scope merge, pair rule, classifier, clear comparison               |
| `src/core/TemplateManager.ts`                                    | `TemplateVariable` fields; apply the resolver in `getAvailableTemplates`              |
| `src/types/DashboardConstants.ts`                                | `TEMPLATE_VARIABLE_DEFAULT_SOURCES`, new message type                                 |
| `src/types/WebviewMessageTypes.ts`                               | Message payload                                                                       |
| `src/ui/WebviewMessageRouter.ts`, `src/ui/WorkflowSerializer.ts` | New route + handler; `handleSetDefaultTemplate` takes a scope and returns the source  |
| `src/utils/ConfigurationUtils.ts`                                | `setDefaultWorkflowTemplate(templateId, scope)`, plus clearing; source lookup         |
| `src/ui/webview-react/store/uiStore.ts`                          | Mirror `TemplateVariable` fields; persisted last-saved scope; default-template source |
| `src/ui/webview-react/components/shared/` (beside `ScopeToggle`) | Shared `SETTING_SCOPE_OPTIONS`; `GlobalSettingsDrawer.tsx` switches to it             |
| `src/ui/webview-react/components/workflow/TemplateModal.tsx`     | Title-bar `ScopeToggle`, pin / clear action, saved markers, scoped Set as Default     |
| `docs/workflows/templates.md`                                    | "Defaults and blank fields": saved values and precedence                              |
| `docs/reference/settings.md`                                     | Regenerated by `npm run schema:update`, never hand-edited                             |

`TemplateManager` currently takes only a `workspaceRootResolver`. Inject a narrow
"read variable defaults per scope" accessor rather than reaching for `ConfigurationUtils`
directly, so the unit tests can supply overrides without a config backend.

### Tests

- `src/test/unit/TemplateManager.test.ts`: user override replaces the authored default; workspace
  beats user per variable while other user values still apply; `authoredDefault`/`defaultSource`
  are set correctly; stale variable, invalid harness, and out-of-options select overrides are
  dropped; `createWorkflow` substitutes an override when the caller omits the variable; overlay
  on a `custom:` id. Pairs: a workspace harness with no workspace model resolves the model to
  its authored default, not the user's model; dropping an invalid harness override also drops
  its linked models' overrides.
- Serializer handler (`src/test/unit/WorkflowSerializer.test.ts`): saving
  the authored default at User clears; saving the authored default at Workspace **stores** it
  when a different User value exists; writing then clearing the last variable removes the
  template key; `handleSetDefaultTemplate` writes at the given scope, clears when the template
  equals the inherited value, and reports the right source.
- `src/ui/webview-react/test/components/workflow/TemplateModal.test.tsx` (new, or shared with
  the required-variables plan, whichever lands first): pin shown only when value differs; pin
  saves to the toggle's scope; toggle starts on Workspace, then on the last-saved scope after a
  save, and flipping it without saving doesn't change that; Workspace disabled with no
  workspace; saved marker and clear; clearing falls back to the User value underneath a
  Workspace value; re-sent template list does not wipe other typed fields. Set as Default
  sends the toggle's scope, updates the last-saved scope, and shows "Default template
  (Workspace)" / "(User)" from the reply. Pairs: pinning a harness sends its linked models in the same message;
  saving a harness that equals its authored default with a changed model stores both; one marker
  and one clear action per pair; re-seeding after a save keeps the saved model rather than resetting it
  to the harness default. These belong in `TemplateModelVariables.test.tsx` if the new modal test
  file doesn't exist yet.

## Phase 2 — Templates settings tab

Without a list, the only way to find or fix a saved value is to open each template in **New
Workflow**. Phase 2 adds a **Templates** tab to the Settings drawer that lists, edits, adds, and
clears saved values for every template. It also takes over the default-template setting.

### Placement and scope

- New `GLOBAL_SETTINGS_TABS.TEMPLATES` entry in `settingsTabs.ts`, in the Core group after
  **Workflow Defaults** (label "Templates", icon `codicon-file-code`). New `TemplatesSection`
  component under `components/settings/`, rendered from `GlobalSettingsDrawer.tsx` like the
  other sections.
- Like every drawer section, it shows and edits **only the drawer's active scope** (User or
  Workspace), not a merged view. The drawer's title-bar toggle is the scope control; the
  section adds none of its own. With Workspace selected and no workspace open, the section
  shows the drawer's usual no-workspace state.
- The drawer's read-only state (settings written by a newer ctrlyoke) disables it through the
  existing `<fieldset disabled>`, with no extra code.

### Layout

```
TEMPLATES                                                    (scope: User)

Default template   [ Bug Hunt Loop                       v ]   ↺
                   Pre-selected when New Workflow opens.

SAVED VARIABLE VALUES
Values pre-filled when you create a workflow from a template.

┌ Bug Hunt Loop  bug-hunt-loop                          [Clear all] ┐
│ bugBacklogDir      [ dev/bugs/backlog            ] [Browse…]  🗑  │
│                    Template default: bugs/backlog                 │
│ hunterHarness      [ Codex CLI   v ] [ gpt-5-codex          v ]  🗑  │
│ + hunterModel      Template default: Claude CLI · opus            │
│                    ⚠ Workspace also saves this; its value wins in │
│                      this workspace.                              │
│ testCommand        [ npm test -- --run           ]            🗑  │
│ [+ Add value v]                                                    │
└───────────────────────────────────────────────────────────────────┘
┌ old-template  (template not found)                    [Clear all] ┐
│ planDoc            plans/plan.md                              🗑  │
└───────────────────────────────────────────────────────────────────┘
[+ Add template v]
```

**Default template row.** This replaces the free-text `general.defaultTemplate` input in
`GeneralSection.tsx` (today you have to type a template id by hand). It becomes a dropdown
grouped like the modal's picker (Built-in / Custom (Workspace) / Custom (User)), inside a
`SettingInputRow`, so it gets the standard source indicator and reset. Move its
`settingsCatalog.ts` entry to the new tab so settings search lands here. The setting key does
not change.

**One card per template**, not one row. Each template with at least one saved value at the
active scope gets a bordered card:

- **Header:** the template's display name, its id in muted monospace (so two templates with
  the same name can be told apart), and a **Clear all** button that clears every saved value
  for that template at this scope in one message.
- **Body: one row per saved variable**, in the template's declaration order, laid out like
  `KeyValueRowsEditor`: name | value control | trash, with `FieldDiagnostic` under the value.
  The trash clears that one value. So yes, each saved value can be cleared on its own.
- **Below each value:** a muted "Template default: …" hint (`authoredDefault`, or "none").
- **Footer:** an **Add value** dropdown listing the template's variables that have no saved
  value at this scope (multiline text excluded, as in the modal). Picking one adds a row
  pre-filled with the variable's current effective value and focuses it. Nothing is written
  until the value is committed.

**Add template** at the bottom: a dropdown of templates with no saved values at this scope.
Picking one adds an empty card with its **Add value** dropdown open. Nothing is written until a
value is committed, and an empty card disappears when the tab is left.

**Empty state** (no saved values at this scope): "No saved values in User settings. Pin a value
in New Workflow, or add one here." followed by **Add template**.

**Order:** cards follow the modal picker's order (built-in, workspace custom, user custom), with
missing templates last.

### Value controls

Each value uses the same control as the modal field for its type. Extract the modal's
per-variable field rendering into a shared `TemplateVariableField` (plus the existing paired
model rendering) under `components/workflow/`. `TemplateModal` and `TemplatesSection` both use
it, so the controls cannot drift apart:

| Variable type        | Control                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `text`               | single-line input, committed on blur / Enter                                   |
| `file` / `directory` | input + **Browse…** (native dialog in VS Code, `FileBrowserModal` when hosted) |
| `select`             | dropdown of `options`, committed on change                                     |
| `harness` + models   | **one row**: `HarnessDropdown` and its model `CustomSelect`s side by side      |
| unpaired `model`     | text input                                                                     |

A harness and its linked models behave as one unit here too. They are one row with one trash
button, and **Add value** offers the harness, never a model on its own. Changing the harness
resets the models to the new harness's default (`defaultModelForHarness`) and writes harness
and models in one message, so a saved pair is never half-updated.

### Editing semantics

- **Every commit is a write.** There is no Save button, consistent with the rest of the
  drawer. Writes go through the Phase 1 `SET_TEMPLATE_VARIABLE_DEFAULTS` message at the
  drawer's active scope, so the extension's clear-instead-of-store rule applies. If you commit
  a value equal to the inherited one, the row disappears, and an inline note on the
  card ("Matches the inherited value, so nothing is saved") explains why for a few seconds.
- **Blank text is a clear.** Committing an empty text field clears that saved value instead of
  storing `""`. The authored default or the other scope's value then applies again.
- **Cross-scope hint.** When the other scope also saves a variable, the row says so. At User
  scope: "Workspace also saves this; its value wins in this workspace." At Workspace scope:
  "Overrides your User value: …". For a pair, the hint is about the harness, since the pair
  resolves from one scope.

### Stale and invalid entries

These use the shared classifier from `TemplateVariableDefaults.ts`, so the editor flags exactly
the entries the resolver ignores:

| Case                               | Row                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Template not found                 | Card titled with the raw id + "(template not found)"; values read-only text; trash and **Clear all** still work |
| Variable no longer in the template | Value as read-only text, warning "This template no longer has this variable; the value is ignored"; trash works |
| Harness not in `HARNESS_IDS`       | Editable dropdown with warning "Not a known harness; the value is ignored" until fixed                          |
| `select` value not in `options`    | Editable dropdown with the same kind of warning                                                                 |
| Model not offered by the harness   | The existing `modelWarning`, same as the modal (warning only; the value still applies)                          |

### Data

- **Per-scope values.** `FullGlobalSettings.settings` is the merged view, which can't show one
  scope (and the generic merge is wrong for this key anyway; see "Setting"). Add
  `templateVariableDefaultsByScope: Record<SettingWriteScope, …>` to `FullGlobalSettings`, read
  with `getScoped`. It then refreshes on every existing `GLOBAL_SETTINGS_LOADED`, including
  after a write or a hand edit of `settings.json`.
- **Template catalog.** The editor needs template names, variable types, options, pairings, and
  authored defaults. Add `TEMPLATE_CATALOG_REQUEST` → `TEMPLATE_CATALOG_LOADED`, answered with
  the same `toWireTemplates` payload the modal gets. Request it when the tab opens. Don't reuse
  `handleNewWorkflow`, which opens the modal.
- **Writes.** Reuse `SET_TEMPLATE_VARIABLE_DEFAULTS` (values map, `null` clears). **Clear all**
  is that message with every saved variable set to `null`. No new write message.

### Why not `KeyValueRowsEditor` itself

Its contract is free-text keys with free-text values: key validation, duplicate-key checks,
bulk `KEY=value` editing, paste splitting, and a secret picker. Here the keys are fixed by the
template, each value has a typed control, and two variables can share a row. Reusing it would
mean disabling most of it and bolting on the rest. Borrow its row grid, trash button, and
`FieldDiagnostic` placement so the two look like siblings, but keep the component separate.

### Search

Add `settingsCatalog.ts` entries for the tab, the **Default template** row (moved from
General), and the **Saved variable values** heading, so "template", "default", and "saved
value" all land on the tab. Individual saved values are dynamic data and are not indexed.

### Touchpoints

| File                                                                                | Change                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                                   | `GLOBAL_SETTINGS_TABS.TEMPLATES`; catalog request/loaded message types      |
| `src/types/WebviewMessageTypes.ts`                                                  | `templateVariableDefaultsByScope` on `FullGlobalSettings`; catalog messages |
| `src/ui/` settings load handler, `WebviewMessageRouter.ts`, `WorkflowSerializer.ts` | Populate per-scope values; answer the catalog request                       |
| `src/ui/webview-react/components/settings/settingsTabs.ts`                          | New tab                                                                     |
| `src/ui/webview-react/components/settings/TemplatesSection.tsx`                     | New section                                                                 |
| `src/ui/webview-react/components/settings/GeneralSection.tsx`                       | Remove the default-template input                                           |
| `src/ui/webview-react/components/settings/settingsCatalog.ts`                       | Move/add entries                                                            |
| `src/ui/webview-react/components/workflow/TemplateVariableField.tsx`                | Extracted from `TemplateModal`; used by both                                |
| `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx`                   | Render the section                                                          |
| `docs/` settings / templates pages                                                  | Document the tab                                                            |

### Tests

- `TemplateVariableDefaults` unit tests (`src/test/unit/`): per-scope merge, pair resolution,
  classifier cases, clear comparison. This is the shared module, so test it once, directly.
- `TemplatesSection.test.tsx` (`src/ui/webview-react/test/components/settings/`): shows only the
  active scope's entries; one card per template and one row per value; trash clears one value
  and **Clear all** clears the template, each as one message at the active scope; a pair is one
  row and a harness change sends harness + models together; **Add value** excludes saved and
  multiline variables and offers the harness but not its models; blank text sends a clear;
  cross-scope hint text at each scope; every stale/invalid case from the table; the
  default-template dropdown writes `general.defaultTemplate` at the active scope.
- `TemplateModal` tests keep passing after the field extraction. That is the check the extraction
  didn't change modal behaviour.

## Phase 3 — carry saved values into a copied template

When **New template…** copies a template that has saved values (`createCustomTemplate`), write
the effective defaults into the copy's `_templateMeta.variables.<name>.default` and drop nothing
from the source. The copy then starts as "my version of this template" instead of losing the
user's settings at the moment they decide to customize further. Do not move or delete the
overlay on the source; the user may still use the built-in.

## Follow-up — community templates in the Templates tab

[`COMMUNITY_TEMPLATES_PLAN.md`](COMMUNITY_TEMPLATES_PLAN.md) Phase 2 (Discovery & Import) puts
its browse-and-install UI in the **Templates** tab instead of a separate Community Templates
tab. That plan owns the design (fetch source, `CommunityTemplateService`, store, install
validation). This section only records the shared layout so Phase 2 here doesn't paint it into a
corner:

- **Pages.** When community import lands, the tab gets a page bar at the bottom like
  **Workflow Defaults**: **Defaults** (everything Phase 2 builds) and **Discover** (community
  browse and install). Use the generic `SegmentedTabBar` with a Templates-specific page set.
  `DrawerTabBar` is hard-wired to the Workflow Defaults pages (`DRAWER_TABS`). Phase 2 ships
  without a page bar: a bar with one page is noise. `TemplatesSection` should still keep its
  body in its own `TemplateDefaultsPage` component so adding the second page is a wrapper
  change, not a rewrite.
- **One scope control.** Install location follows the drawer's User/Workspace toggle (User →
  `~/.ctrlyoke/templates/`, Workspace → `.ctrlyoke/templates/`), the same way it decides where
  a saved value is written. The section has no second scope picker. Every write the tab makes
  goes to the scope shown in the title bar.
- **It flows into Defaults with no extra work.** An installed template is an ordinary custom
  template (`custom:<scope>:<name>`), so it appears in the **Add template** dropdown and the
  New Workflow picker, and its variables can be saved like any other. After an install,
  **Discover** offers a **Set defaults** link that switches to **Defaults** with that
  template's card added and its **Add value** dropdown open.
- **Search.** Add the **Discover** page to the tab's settings-catalog entries so a search for
  "community" lands on it.

## Non-goals

- **Editing prompts or steps of a built-in in place.** That is what copying is for.
- **Auto-remembering last-used values.** See Phase 1 rationale. Can be an opt-in later if users
  ask for it.
- **Overrides on anything other than declared variables** (e.g. forcing `executionMode` on a
  built-in). Templates that want a knob should declare a variable; the bug templates already do
  for harnesses and models.
- **CLI/MCP instantiation.** Neither binary creates workflows from templates today
  (`WorkflowSerializer.handleCreateWorkflow` is the only `createWorkflow` caller). The overlay
  lives in `TemplateManager`, so a future CLI `new --template` picks it up for free.

## Decisions

- **Overlay, not copy.** See above.
- **Scope is chosen with a modal-level User/Workspace toggle, not a per-pin menu.** It starts on
  Workspace until the first save, then on the last-saved scope, for every variable type. The
  same toggle and preference drive **Set as Default**.
- **Saving a value that's already inherited clears the override at that scope.** The comparison
  is against the layer below the target scope, not just the authored default.
- **`general.defaultTemplate` stays under `general`.** It becomes writable at either scope.
- **A harness and its linked models are one unit.** They are saved, resolved from one scope,
  and cleared together. See "Harness and model pairs".

## Verification

`npm run schema:update`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:docs`.
Do **not** run `npm run test:harness`.

Manual: open **New Workflow** → Bug Hunt Loop. Confirm the toggle starts on Workspace, then pin
`bugBacklogDir`. Switch to User, change `hunterHarness` to Codex CLI and `hunterModel` to a
non-default Codex model, and pin the pair. Close and reopen the modal: the toggle should now
start on User, both fields and the pair should be pre-filled with the right markers, and the
model should still be the one you picked, not Codex's default. Open a different workspace and
confirm only the harness and model carry over. Back in the first workspace, switch the toggle to
Workspace and click **Set as Default** on Bug Hunt Loop. The footer should read "Default
template (Workspace)", and the other workspace should still open on its own default.
