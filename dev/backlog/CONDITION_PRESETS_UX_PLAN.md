# Condition presets UX plan

**Status:** proposal, not started. Builds on stage 2 of
`dev/implemented/MCP_STEP_EXECUTION_CONTROLS_PLAN.md`, which added the workflow
`conditions` map and MCP `{ use: "<name>" }` attachment.

## Problem

A workflow's `conditions` map is the list of gates an orchestrator may attach to
the steps it queues. Today:

- The only way to edit it is the workflow file. `WorkflowPropertiesPanel.tsx`
  edits `preCondition` and `endCondition` but not `conditions`, and the
  dashboard store and `WorkflowProperties` don't carry the field.
- There is no shared library, so every workflow declares its own presets. The
  built-in loop templates each repeat the same `committed` gate, and share it
  with their own plan and review steps through a YAML anchor.
- A preset doesn't say whether it is an end condition or a pre-condition. An
  agent can attach a retrying preset as a `preCondition`, and nothing rejects it
  (`materializeMcpConditionPreset` copies it onto whichever field was named).
- Authored steps can't name a preset; `{ use }` is MCP-only.

## Today's state (verified 2026-11-01)

- **Schema:** `conditions` is a root-only map of `$defs/conditionPreset`
  (`schemas/workflow-schema.json`), which has `unevaluatedProperties: false`.
  Its `onPass`/`onFail` enums are the union of the end-condition and
  pre-condition actions.
- **Resolution:** `src/utils/McpConditionPresetResolver.ts` reads only
  `workingFile.conditions` and copies the preset onto the step at append time.
- **Defaults:** `PromptFileLoader.populateSettingsDefaults` seeds `defaults.*`
  into a new working file for any key the source file leaves undefined; an
  explicit value, including `null`, wins whole. `ExecutionPropertyResolver`
  also falls back to `defaults.endCondition`/`preCondition` at run time.
- **Trust:** `defaults.endCondition`/`preCondition` are workspace-sensitive
  (`src/config/WorkspaceSensitiveSettings.ts`).
- **Template dialog order:** fields appear in the order
  `TemplateManager.extractVariables` first finds each `{variable}` in the file;
  `_templateMeta.variables` order is ignored. This is why the loop templates
  define their gate after the plan step's prompt.
- **Schema versions:** the workflow schema has never been bumped
  (`schemas/archive/` doesn't exist yet), so this is the first run of the
  "Changing the schemas" flow in `CONTRIBUTING.md`.

## Decisions

1. **Presets declare what they are used as.** A new `usedAs` field on
   `conditionPreset`: `endCondition`, `preCondition`, or `both`. It narrows the
   valid actions:

   | `usedAs`       | `onPass`/`onFail` actions          | End-only fields allowed |
   | -------------- | ---------------------------------- | ----------------------- |
   | `endCondition` | continue, retry, stopWorkflow      | yes                     |
   | `preCondition` | continue, skipPrompt, stopWorkflow | no                      |
   | `both`         | continue, stopWorkflow             | no                      |

   End-only fields are `maxRetries`, `retryPrompt`, `passRetryPrompt` and
   `resumeSessionOnRetry`. The schema enforces the table with `if`/`then` on
   `usedAs`. Attaching a preset to a field it isn't used as is an error, from
   MCP and from an authored step alike, e.g. "preset 'committed' is used as an
   end condition; attach it as endCondition". A retry-prompt or `maxRetries`
   override on a pre-condition reference is rejected the same way. `usedAs` is
   stripped when a preset is copied onto a step, as `params` already is.
   `usedAs` is required: an older preset has no reliable answer, so the
   migration infers one (see stage 1).

2. **Any condition can name a preset.** `endCondition` and `preCondition`, on
   a step, a parallel member, the final step, or the workflow root, accept
   `{ use, params?, retryPrompt?, passRetryPrompt?, maxRetries? }` as well as a
   full condition. This is the same reference object `append_step` takes, and
   it goes through the same resolver, so the override and `params` rules are
   identical. Authored references stay references in the workflow and working
   file and are resolved in `ExecutionPropertyResolver` when a step runs, so the
   step editor, dry run and history all see the same resolved condition.
   Agent-appended steps keep being materialized at append time, so a later
   preset edit doesn't change work already queued. Settings defaults
   (`defaults.endCondition`) stay plain conditions: they have no `conditions`
   map to resolve against.
3. **A reference resolves only against the workflow's own `conditions`.**
   There is no run-time fallback to settings or built-ins, so a workflow file
   means the same thing on every machine and every ctrlyoke version. Loading a
   workflow whose reference names a missing preset is a validation error.
4. **Built-in presets are defined once in code and can't be edited.**
   `committed` is the first. Their names are reserved: a settings library entry
   can't use one. Built-ins reach a workflow only by being copied into its
   `conditions`:
   - a template lists them in `_templateMeta.conditions: [committed]`, and
     `TemplateManager` copies each into the created workflow (`_templateMeta`
     is stripped from the output, so this is template-only);
   - checking one as a default in settings seeds it into new workflows.
5. **Workflows hold copies.** The settings library and built-ins are where new
   workflows get presets, not what they point at. A workflow's copy is
   editable and only affects that workflow. The editor badges a copy that
   differs from the library or built-in entry of the same name and offers a
   reset. This keeps workflow files self-contained for the CLI, CI and other
   machines.
6. **Seed like the other defaults.** `populateSettingsDefaults` fills
   `conditions` only when the source file leaves it undefined. A file's own
   `conditions`, even `{}`, wins whole, which is what lets a workflow opt out.
7. **The template dialog follows `_templateMeta.variables` order.** Declared
   variables come first in declared order; undeclared ones follow in the order
   they appear. With built-ins, the templates no longer define `committed` at
   all, but this also frees authors to put `conditions:` or any other block
   wherever it reads best.
8. **One shared editor, single column.** `ConditionPresetsEditor`
   (`components/shared/`) is a vertical list of accordion rows, so it fits the
   narrow panel and a phone:
   - collapsed row: checkbox, name, a `usedAs` chip, and the script in
     monospace, truncated;
   - expanded row: a **Used as** selector, then `ScriptConditionEditor`
     narrowed to that kind, then a `params` list editor;
   - built-in rows are read-only with **Duplicate**.

   On the settings page, the same component switches to a list beside an editor
   when the container is wide enough (`useElementNarrow`), like the workspace
   viewer's side column. The checkbox means "default for new workflows" there,
   and "included in this workflow" in the properties panel.

9. **The library is sensitive.** Workspace-scope values of the new settings
   join `SENSITIVE_WORKSPACE_SETTINGS`: they are scripts copied into every new
   workflow.

## Settings shape

```jsonc
{
  // Library: name -> preset, the same $defs/conditionPreset as the workflow
  // schema (referenced, not copied). Built-in names are reserved.
  "conditionPresets": {
    "typecheck": { "usedAs": "endCondition", "script": "npm run typecheck" },
  },
  // Library or built-in names copied into new workflows' `conditions`.
  "defaults": { "conditions": [] },
}
```

These are additive settings fields, so the settings schema needs no bump. A
name in `defaults.conditions` that is in neither the library nor the built-ins
is ignored, with a warning badge on the settings page. `committed` is not
checked by default: an orchestrator told to attach it would fail every queued
step in a folder that isn't a git repository.

## Stages

### Stage 0: Confirm the dashboard doesn't drop `conditions`

The webview's `WorkflowProperties` has no `conditions` field. Add a test that
editing a workflow property in the panel and saving leaves the file's
`conditions` untouched. Fix it first if it doesn't.

### Stage 1: Schema bump — `usedAs` and authored references

The first workflow schema bump; follow "Changing the schemas" in
`CONTRIBUTING.md` and write down anything unclear in it as you go.

1. `npm run schema:bump -- workflow` on the committed schema.
2. Add `usedAs` to `conditionPreset` with the `if`/`then` rules above, and a
   `conditionReference` definition accepted by every `endCondition` and
   `preCondition` (`oneOf` a full condition or a reference).
3. Migration `1 → 2` in `src/utils/FormatMigrations.ts`: give each preset a
   `usedAs` inferred from its fields — `endCondition` if it uses `retry` or an
   end-only field, `preCondition` if it uses `skipPrompt`, otherwise `both`.
   A preset that uses both `retry` and `skipPrompt` was never valid as either
   kind and fails the migration with a message naming it. Add the fixture.
4. Move the resolver from `McpConditionPresetResolver.ts` to a shared
   `ConditionPresetResolver.ts`, add the `usedAs` check, and call it from
   `ExecutionPropertyResolver` for authored references and from the MCP layer
   for appended ones. Validate unknown names when a workflow loads.
5. Built-in presets (`src/types/BuiltInConditionPresets.ts`), `_templateMeta.
conditions` support in `TemplateManager`, and the `_templateMeta.variables`
   ordering change.
6. Convert the four built-in loops and the workspace loops: drop the YAML
   anchors and the inline gate, list `committed` in `_templateMeta.conditions`,
   and put `endCondition: { use: committed }` on the plan, review and
   bug-hunting steps.
7. Tests: migration and fixture, `usedAs` rejection from MCP and from an
   authored step, authored-reference resolution (step, parallel member, root
   inheritance), template instantiation, dialog order.
8. Docs: regenerate the reference pages with `npm run schema:update`; update
   `docs/workflows/end-conditions.md` (presets and references) and
   `docs/reference/mcp-tools.md`. CHANGELOG: the bump under **Changed**,
   presets and references under **Added**, dialog order under **Changed**.

### Stage 2: Edit a workflow's presets in the dashboard

- Add `conditions` to the workflow properties payload and store.
- Build `ConditionPresetsEditor` and the `usedAs`-narrowed variant of
  `ScriptConditionEditor`.
- Add a collapsed "Condition presets (N)" section under End Condition in
  `WorkflowPropertiesPanel`. Every listed entry is in the workflow, so no
  checkbox yet.
- In the step editor's and the properties panel's end/pre-condition sections,
  add a **Preset** choice next to a custom script: picking one writes
  `{ use }`, with the override fields beneath.

### Stage 3: Settings library and defaults

- `conditionPresets` and `defaults.conditions` in
  `schemas/settings-schema.json`, `CtrlYokeSettings.ts`, `ConfigurationUtils`
  and `SETTING_PATHS`, marked sensitive.
- A "Condition presets" card on `DefaultsValidationPage` with built-ins first,
  read-only.
- Seed in `populateSettingsDefaults`; include `conditions` in "Reset all to
  default".

### Stage 4: The library in the properties panel

- The panel lists the union of built-in, library and workflow names; the
  checkbox copies an entry in or removes it. Workflow-only entries are
  labelled.
- The "differs from library/built-in" badge with reset.
- "Save to library" for a workflow-only preset, using the existing scope
  selector.

## Open questions

1. **Removing a preset a step still references.** Unchecking or deleting
   `committed` in the panel while `{ use: committed }` sits on a step would
   leave a broken workflow. Block the removal and name the steps, or offer to
   inline the condition into each step first. Blocking is simpler.
2. **Reference on the workflow root.** A root `endCondition: { use: x }` is
   inherited by queued steps, which brings back the parallel-step problem this
   work started from. Allow it (it is the author's choice, and the docs can
   say why the templates don't) or reject it. Leaning allow.
