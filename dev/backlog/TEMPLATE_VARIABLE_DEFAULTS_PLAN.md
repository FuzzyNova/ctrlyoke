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

One function in `TemplateManager` (or a small `TemplateVariableDefaults` helper it owns) resolves
the effective default for every variable, and every consumer goes through it:

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

The modal's title bar gets a **User / Workspace** scope toggle, the same `ScopeToggle` control
the Settings drawer puts in its title bar. It decides where both a pin and **Set as Default**
save, so saving is one click with no follow-up menu, and the current target is always visible.

- **Single-source the options.** The drawer builds its User/Workspace options inline. Move them
  to a shared `SETTING_SCOPE_OPTIONS` beside `ScopeToggle` and use it in both places. Do **not**
  reuse `TEMPLATE_SCOPE_OPTIONS` (`templateScope.ts`): its tooltips describe template file
  locations (`.ctrlyoke/templates`), which is what the **New template…** form's **Location**
  toggle means, not where a setting is written. The title-bar toggle's `ariaLabel` should be
  "Save defaults to" so it isn't confused with that **Location** toggle further down the modal.

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
| `src/core/TemplateManager.ts`                                    | `TemplateVariable` fields; per-variable resolver; apply in `getAvailableTemplates`    |
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

## Phase 2 — see and clear saved values in Settings

Without a list, the only way to find a stale override is to open each template. Add a
**Templates** group to the Settings view (`GeneralSection.tsx` neighbourhood, catalogued in
`settingsCatalog.ts`), with one row per template that has saved values. Like every other drawer
section, it shows and edits the drawer's active scope (User or Workspace), not a merged view.
Each row shows its variables and values, with a clear button per value and per template. Show
templates that no longer exist as "(template not found)" so they can be removed. Clearing a
harness or model clears its whole pair, as in the modal.

## Phase 3 — carry saved values into a copied template

When **New template…** copies a template that has saved values (`createCustomTemplate`), write
the effective defaults into the copy's `_templateMeta.variables.<name>.default` and drop nothing
from the source. The copy then starts as "my version of this template" instead of losing the
user's settings at the moment they decide to customize further. Do not move or delete the
overlay on the source; the user may still use the built-in.

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
