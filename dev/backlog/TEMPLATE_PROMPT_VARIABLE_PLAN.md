# Template Prompt Variable Plan

**Status:** Proposed — not started. No `prompt` value exists in
`TEMPLATE_VARIABLE_TYPES` or in the schema's `templateVariableMetadata.type` enum.

**Related:** `TEMPLATE_AUTHORING_MODE_PLAN.md` (the dashboard template editor; its
variable manager has to offer this type, and its `emitAs: var` option can keep a
prompt variable as a runtime `{{var}}` after creation. Read its note on `{{x}}`
inside emitted values before combining the two), `dev/implemented/TEMPLATE_REQUIRED_VARIABLES_PLAN.md`,
`dev/implemented/TEMPLATE_VARIABLE_DEFAULTS_PLAN.md`

## The ask

Add a `prompt` template variable type. The Create Workflow from Template modal
(`TemplateModal.tsx`) renders it as the full prompt editor (`CodeMirrorEditor.tsx`),
with completions, reference chips, `{{var}}` hover, spellcheck, and prompt
diagnostics, in place of a plain textarea. The existing `text` type, including
`multiline: true`, stays as it is. A `prompt` variable is meant for the
`prompt`, `retryPrompt`, and `passRetryPrompt` fields of a template.

```yaml
_templateMeta:
  variables:
    featureDescription:
      type: prompt
      required: true
      description: What to build. You can reference files with @ and earlier output with $.
steps:
  - prompt: |
      {featureDescription}

      Write an implementation plan to {planDocument}.
    endCondition:
      script: npm test
      retryPrompt: |
        Tests still fail. Re-read the original request:
        {featureDescription}
```

The motivating case is `full-feature.ctrlyoke.yaml`'s `featureDescription`. Today it
is a `multiline` text box, yet whatever is typed there lands in a prompt verbatim.
`@src/foo.ts` and `$previous` in that box work at runtime, but you type them blind,
with no completion or validation.

## Current state (verified 2026-10-13)

- `TEMPLATE_VARIABLE_TYPES` (`src/types/DashboardConstants.ts`) has `text`, `file`,
  `directory`, `select`, `harness`, and `model`. The schema enum at
  `$defs.templateVariableMetadata.type` mirrors that list.
- `TemplateVariableField.tsx` renders every type. It is shared by `TemplateModal.tsx`
  and the template-defaults settings page (`settings/TemplatesSection.tsx`).
  `multiline` gives a `<textarea>`.
- `TemplateModal` and `TemplatesSection` each carry their own copy of the
  "is this variable multiline" predicate: the inline `isMultiline` computation in the
  modal's variable map, and `isMultiline()` in `TemplatesSection.tsx`. Multiline
  variables get no "Save as default" control in the modal
  (`renderVariableDefaultControls` returns `null`).
- `TemplateManager.replaceVariables` substitutes in one regex pass over **parsed
  scalar values** (`substituteVariablesInValues`). A multi-line value therefore cannot
  break YAML structure (`dev/bugs/implemented/template-variables-substituted-into-raw-yaml.md`).
  A substituted value is never re-scanned, so a `{x}` the user types inside a prompt
  value stays literal.
- `CodeMirrorEditor` already runs in compact embedded form. `ScriptConditionEditor.tsx`
  mounts it for Retry Prompt and Pass Retry Prompt with `surface="input"`,
  `mode={PROMPT_PROPERTIES.END_CONDITION}`, min and max height classes, and
  `getDictionaryUris()` for spellcheck.
- Scoped completions and lint take a `PromptCompletionWorkflowContext`
  (`src/completions/PromptContextCompletions.ts`): `stepNames`, `vars`, `field`,
  `hasPreCondition`, `stepCount`, `hasFinalStep`. Without it, the editor styles
  `{{name}}` but cannot lint it.

## Design

### 1. Type and schema

- Add `PROMPT: "prompt"` to `TEMPLATE_VARIABLE_TYPES` and `"prompt"` to the schema enum.
  The `type` description should say that a prompt variable gets the prompt editor and
  belongs in prompt-text fields. Run `npm run schema:update`.
- `multiline` means nothing for a prompt variable, because it is always the editor.
  `TemplateManager.parseTemplateMeta` keeps accepting the key. The UI ignores it.
- `TemplateManager.parseTemplateMeta` validates `type` against the enum, so check that
  the enum list there comes from `TEMPLATE_VARIABLE_TYPES` and not from a local copy.

### 2. Editor context: computed by the extension, not guessed by the modal

The modal knows nothing about where a variable is used. If it gives the editor no
context, the editor cannot offer `$step:N` / `$previous` completions or flag a
`$step:5` that points past the start of the workflow. Lint and completion both
depend on the usage site.

`TemplateManager` already parses the template. Add a pass that walks the parsed
document (top-level steps, parallel group children, `finalStep`) and records every
place each `prompt` variable appears: step index, field (`prompt` / `retryPrompt` /
`passRetryPrompt` / other), whether the step has an effective pre-condition, the
names of earlier steps, and the template's `vars`. Send the result on the wire
`TemplateVariable` as `promptContext?: PromptCompletionWorkflowContext`, reduced to
the **strictest** usage:

| Context field     | Reduction across usages                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `stepCount`       | minimum, so `$step:N` is valid at every use                                                                        |
| `stepNames`       | the names visible at the earliest use                                                                              |
| `field`           | `prompt` unless every usage is a retry prompt. `$endCondition:*` is valid only when every usage is a retry prompt. |
| `hasPreCondition` | `true` only when every usage step has one                                                                          |
| `hasFinalStep`    | the template's own value                                                                                           |
| `vars`            | the template's `vars` block, so `{{name}}` lint works inside the modal                                             |

With the strictest reduction, a reference the editor accepts resolves at every
place the variable lands. Put the reducer next to `getContextualPriorCompletions`
as a pure function (`mergePromptCompletionContexts`) and unit-test it there.

A prompt variable used in a non-prompt field (a script, `additionalArgs`) gets a
`Log.warn` at discovery time. It still substitutes, since it is just text, but the
author probably meant `text`. Template authoring mode (the related plan) can show
this as an inline diagnostic.

### 3. Rendering in the modal

- `TemplateVariableField` gets a `prompt` branch that renders `CodeMirrorEditor` with
  `surface="input"`, `mode` from `promptContext.field`, and
  `workflowCompletionContext={variable.promptContext}`. Copy the
  min-height, max-height, and class choices from `ScriptConditionEditor`'s retry
  prompt so the controls look like one family. The modal is `size="lg"`. Start at
  about 6 lines and grow to about 16 before the editor scrolls internally.
- Keyboard: the modal's `handleKeyDown` submits on Enter only when the target is an
  `HTMLInputElement`, so Enter inside CodeMirror (a contenteditable) already inserts a
  newline. Ctrl+Enter must not fire twice. Pass `onRun={() => handleSubmit(true)}`
  to the editor and stop the keydown from bubbling to the modal handler, or leave
  `onRun` unset and let the bubble do it. Pick one and add a test.
- Turn off features that need a workflow to exist. Pasted images
  (`SAVE_PASTED_IMAGE`) and output captures write into the **active** workflow's
  attachment store, and while the modal is open that is a different workflow, or
  none. Add an editor prop (e.g. `allowAttachments={false}`) that turns off image
  paste and capture, and set it here. The other way out, staging attachments and
  re-homing them on create, is real work and goes to Open questions.
- External insert requests (`pendingInsertRequest`, from VS Code's "add to prompt"
  context menu) keep targeting the main prompt editor. Do not route them here.
- `@` file completion and reference chips go through the dashboard's message
  bridge, so they should work in both the VS Code panel and the hosted browser.
  Check this in the hosted dashboard during implementation.
- Required validation (`isSatisfiedRequiredValue`) and the blur-to-validate path
  work unchanged. The editor exposes `onBlur`.

### 4. Defaults and the settings page

- Treat `prompt` like a multiline `text` variable for saved defaults: the modal shows
  no "Save as default" (open question below). Fold the two copies of the predicate
  into one helper, e.g. `isMultilineTemplateVariable(variable)` in
  `src/utils/TemplateVariableDefaults.ts`, that returns `true` for `prompt`. Use it
  from both `TemplateModal` and `TemplatesSection`.
- `TemplatesSection` renders `TemplateVariableField`, so authored defaults for a
  prompt variable get the editor there as well. There is no usage-site context on
  that page unless the wire variable carries `promptContext`, and it does: it comes
  from the same `TemplateInfo`.

### 5. Built-in templates

- `full-feature.ctrlyoke.yaml` → `featureDescription: type: prompt`.
- Audit the other built-ins (`simple-feature`, `spec-driven-loop`,
  `feature-driven-loop`, `bug-*`, `fix-tests`) for any `text` + `multiline` variable
  that lands only in prompt text, and convert those.
- `template-starter.ctrlyoke.yaml` shows every type, so add a prompt variable there
  (e.g. change `constraints` to `type: prompt` and use it in a `retryPrompt`, which
  also shows the retry-prompt context rule).

## Gotchas

- **Single-brace collisions inside the value are fine.** Substitution happens once,
  so a user who types `{foo}` (a JSON example, say) into a prompt variable gets it
  literally. Lock this in with a test, because a "helpful" recursive substitution
  later would break it.
- **`$step:N` is relative to the usage step.** A prompt variable used at step 2 and
  step 5 means something different by `$previous` at each site. The strictest
  context keeps references valid. It does not make them mean the same thing. Say so
  in the `type` schema description and in the docs.
- **`{{var}}` inside a prompt variable becomes a runtime var placeholder.** This is
  intended, and the modal lints it against the template's `vars` (§2).

## Testing

- `src/test/unit/` (TemplateManager): usage-site discovery across steps, parallel
  children, and `finalStep`; the strictest reduction; warning for use outside prompt
  fields; one-pass substitution of a value that contains `{x}` and `{{x}}`.
- `src/ui/webview-react/test/`: `TemplateVariableField` renders the editor for
  `prompt`; required validation; Ctrl+Enter fires Create & Run exactly once; Enter
  inserts a newline and does not submit; image paste is disabled.
- Schema: a template with `type: prompt` validates, and `check:docs` passes.

## Docs

- `docs/workflows/templates.md`: add `prompt` to the variable-type table with an
  example and the `$step` relativity note.
- Generated reference pages follow from `npm run schema:update`.

## Open questions

1. **Saved defaults for prompt variables.** Saving a long prompt to `settings.json`
   works, but the modal's label-row control was built for short values. Parity with
   multiline text (no save) is the proposed v1. Revisit if someone asks.
2. **Attachments in the modal.** Should a pasted screenshot be staged and moved
   into the new workflow's store on create? This needs a temp attachment area and a
   re-home step in `CREATE_WORKFLOW`. Deferred.
