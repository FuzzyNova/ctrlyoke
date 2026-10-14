# Template Authoring Mode Plan

**Status:** Proposed — not started. Today the only way to declare template variables
is to hand-edit `_templateMeta` in YAML or JSON.

**Related:** `TEMPLATE_PROMPT_VARIABLE_PLAN.md` (the `prompt` variable type; the
variable manager here must offer it), `COMMUNITY_TEMPLATES_PLAN.md` (more templates
make an authoring UI more valuable), `COMPUTED_VARIABLES_PLAN.md` (the `{{vars}}`
runtime system this plan must not blur into),
`dev/implemented/WORKFLOW_PORTABILITY_PLAN.md` §8.3 (Save as Template's bundling
rules), `dev/implemented/WORKING_FILE_MODEL_PLAN.md`

## The ask

Let a user edit a template **as a template** in the dashboard:

- Put a workflow into **template mode**. `HeaderStatusBanner.tsx` shows "Editing
  template", lists the variable names so the user can see what is available, and
  has a button that opens a **template variable manager** (add, remove, edit
  variables).
- In `WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx`, dropdowns put
  compatible template variables at the top of their options: harness dropdowns
  offer harness and text variables, model dropdowns offer model and text variables
  (e.g. `{developerModel}`), and so on.
- Think through every field. Two-option and enum fields (Execution Mode, Resume
  Session, …) do not need to be templatable.
- An open invitation: propose a better way to edit templates in the dashboard.

## Current state (verified 2026-10-13)

**Two variable systems exist. Keep them distinct.**

|                  | Template variables                                                                         | Workflow vars                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Syntax           | `{name}`, `{file:name}`, `{text:name}` (`TEMPLATE_VARIABLE_PATTERN`, `TemplateManager.ts`) | `{{name}}` (`findVariablePlaceholders`, `src/utils/VariablePlaceholders.ts`)                  |
| Name rule        | `^[a-z][a-zA-Z0-9]*$` (schema `templatePlaceholder` / `propertyNames`)                     | `^\w+$` (`VARIABLE_NAME_PATTERN_SOURCE`)                                                      |
| When substituted | Once, at instantiation, into **every scalar** in the parsed file                           | At runtime, into prompt and script text only                                                  |
| Declared in      | `_templateMeta.variables`, stripped on instantiation                                       | `vars:`                                                                                       |
| Editor support   | None: plain text                                                                           | Styling, hover, undefined-var lint, "define var" quick fix (`codemirrorWorkflowVariables.ts`) |

Facts that shape the design:

1. **Variables are discovered from placeholders and only enriched by meta.**
   `mergeVariablesWithMeta` maps over `extractVariables(content)`, so a variable
   declared in `_templateMeta` with no placeholder anywhere **silently disappears**
   from the catalog. A variable manager that lets you add a variable before you use
   it breaks under this rule.
2. **Extraction scans raw file text**, including YAML comments and
   `_templateMeta.description` strings. A comment containing `{foo}` creates a
   variable called `foo`.
3. **Schema:** when `_templateMeta` is present, the root `allOf` lets `harness`
   (workflow, step, parallel child) be a `templatePlaceholder`. `model`, `agent`,
   `additionalArgs`, scripts, and prompt text are free strings, so a placeholder
   validates there with no schema work. Enum, boolean, and integer fields
   (`executionMode`, `resumeSession`, `maxRetries`, `timeoutSec`, `maxSteps`, …)
   **reject** a placeholder.
4. **Save as Template** (`SAVE_WORKFLOW_AS_TEMPLATE` →
   `TemplateManager.saveWorkflowAsTemplate`) writes `_templateMeta: { name,
description: "" }` and no variables. It is a one-way snapshot.
5. **Opening a template file as a workflow** goes through
   `PromptFileParser.validateAndNormalize`, whose contract says the input has no
   `_templateMeta`. The meta does not survive. Placeholders stay literal and fail at
   run time (`{harness}` is not a harness).
6. **Precedent for a mode banner:** lineages carry `isSystemGenerated`
   (`WorkflowLineageDescriptor`, `CtrlYokeTypes.ts`), read through
   `useIsSystemGeneratedWorkflow`, and `HeaderStatusBanner` shows a locked banner with
   an action link. Template mode is the same shape with an editable workflow.
7. Built-in templates (`src/templates/workflows/`) ship inside the extension and are
   read-only.

## Proposal

### Overview

A **template draft** is an ordinary dashboard lineage with one extra descriptor
field. Everything the dashboard can already do to a workflow (step editing, drawer,
properties panel, reordering, parallel groups) works on it unchanged. Template mode
adds four things:

1. **Placeholder-aware fields:** dropdowns offer compatible variables, and text
   fields and editors complete and lint `{name}`.
2. **A variable manager** that replaces hand-editing `_templateMeta`.
3. **A banner** that names the template, lists variables as insertable chips, and
   carries the mode's actions.
4. **Hard run guards:** a template draft can never execute.
5. **Try it:** instantiate the unsaved draft into a real workflow to test it.
6. **Promote to variable:** turn any field's current value, or a prompt text
   selection, into a template variable where it sits. This is the main authoring
   path: build a workflow that works, run it, then promote the settings that
   should vary.
7. **Text variables that stay editable after creation:** a per-variable
   `emitAs: var` writes the value into the new workflow's `vars` instead of
   copying it into every prompt.

### Entry and exit

| Entry point                                                                 | Behavior                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template modal / Templates settings page → **Edit template** (custom only)  | Load the template file into a new template draft bound to its path                                                                                                                                      |
| Same, on a built-in → **Edit a copy**                                       | Ask for a name and scope, reusing the inline "New template…" form and `CREATE_CUSTOM_TEMPLATE`, then edit the copy                                                                                      |
| Any workflow → **Convert to template…** (workflow context menu / Save menu) | Clone the current workflow into a template draft that is not yet bound to a file. Save asks for name, scope, and format like Save as Template does today. This supersedes the one-way Save as Template. |
| Opening a `.ctrlyoke.*` file whose top level has `_templateMeta`            | Offer "Edit as template" instead of loading it as a runnable workflow (fixes fact 5)                                                                                                                    |

Banner actions: **Variables…**, **Try it**, **Save template**, **Exit**. Exit asks
first when there are unsaved changes.

### Storage

- Add to `WorkflowLineageDescriptor`: `template?: { path?: string; scope:
TemplateScope; templateId?: string }`. `path` is unset until the first save of a
  converted workflow. Show template drafts in recent workflows with a template icon
  (or leave them out; see Open questions).
- The working file **keeps `_templateMeta` at the top level**, so the schema's
  conditional (fact 3) admits placeholders in harness fields everywhere in the
  draft. This means auditing every path that rebuilds or cleans a working file
  (`buildCleanWorkflow`, the working-file writers in `WorkflowSerializer`, the
  normalizer behind `validateAndNormalize`) so none of them strips the key or
  replaces a placeholder with a resolved harness. Add a regression test that a
  template draft round-trips byte-stable through load → edit → save.
- **Save template** serializes the clean workflow plus `_templateMeta` in the
  file's original format via `TemplateManager.serializeTemplate`. It overwrites in
  place, using the same compare-before-write staleness check the working-file
  writers use, so an edit made in a text editor meanwhile is not lost silently.

### Run guards (core, not just UI)

- The orchestrator refuses to start, queue, resume, or schedule a lineage that has
  `template` set. The check goes in core next to the runner-lock acquisition, so the
  CLI, MCP server, and hosted dashboard are all covered. The UI hides Run and Queue
  and replaces them with **Try it**.

### Try it

- **Try it** opens `TemplateModal` with the **unsaved draft** as its template.
  `CREATE_WORKFLOW` gains an optional inline template body in place of
  `templateId`, and `TemplateManager.createWorkflow` gets an overload that takes
  content instead of an id (it already works on content after
  `getTemplateContent`). The author fills in values and gets a real, runnable
  workflow in a new lineage, without saving the template. Today the loop is: save
  the YAML → reopen the picker → fill in → inspect. Try it replaces that.
- The modal's variable list comes from the draft's in-memory `_templateMeta` and
  placeholders, put through the same catalog merge as a file on disk, so what you
  try is what a saved template would show.
- Saved per-user and per-workspace defaults for the template's id apply as usual. A
  converted workflow that has never been saved has no id, so it gets authored
  defaults only.
- Dry run (`executionPreviewStore`) can run on a template draft by resolving
  placeholders to their defaults first. Label it "Preview with defaults". It
  shares the substitution step with Try it.

### The banner

`HeaderStatusBanner` gets a template-mode branch, in an info tone (not error, since
this is not a lock):

```
 ⧉ Editing template: Full Feature Pipeline   {featureDescription} {planDocument} {reviewHarness} +2   [Variables…] [Try it] [Save] [×]
```

- Each chip shows the variable's type icon. A tooltip gives its description,
  default, and usage count. Clicking a chip inserts `{name}` at the prompt editor's
  cursor through the existing `pendingInsertRequest` path, or copies it when no
  prompt editor has focus.
- An unused variable gets a muted chip with a warning dot. A placeholder that is
  used but not declared (possible after hand edits) gets an error chip with a
  "Declare…" action.
- `narrowChildren`: "Template: <name> · N vars" plus **Variables…**. The full chip
  list is one click away in the manager.
- A dirty marker on **Save**, like other unsaved state.

### The variable manager

A modal that shows `_templateMeta.variables` as rows. Each row has:

- **Name.** Validated against the template name rule. That rule is now duplicated
  across the schema pattern, `TEMPLATE_VARIABLE_PATTERN`, and
  `templatePlaceholder`, so single-source it as one exported pattern source next to
  `VARIABLE_NAME_PATTERN_SOURCE` and build the regex and the generated schema from
  it. **Renaming rewrites every placeholder in the draft**, across all fields,
  `{file:x}` / `{text:x}` forms included, in one undoable edit. YAML editing cannot
  do this, and it is the strongest reason to build the manager at all.
- **Type**, then type-specific fields: `options` (select), `fileFilter` and
  `autoFillFilename` (file and directory), the paired `harness` (model),
  `multiline` (text).
- **Description**, **Default**, **Required**. The Default control is
  `TemplateVariableField` itself, so a harness default uses the harness dropdown, a
  model default uses the paired model list, and a prompt default uses the prompt
  editor. This is the same component the end user sees, so the manager doubles as a
  live preview.
- **Usages**: "used in 3 places", expandable to a list of step and field links that
  select that step and open the right drawer page.
- **Delete**: when the variable has usages, ask "Replace N usages with: [default
  value] / [empty] / cancel".
- **Order**: drag to reorder. Meta order is the modal's field order, which today
  follows first-placeholder order. This needs the catalog fix below.

**Catalog fix (prerequisite).** Change `mergeVariablesWithMeta` to emit the union of
meta-declared and extracted variables, ordered by **meta order first**, then
undeclared placeholders in discovery order. Declared-but-unused variables still
reach the modal (harmless: their value substitutes nowhere) and get a `Log.debug`.
Built-in templates declare their variables in usage order, so they do not change.

### Placeholder-aware fields: the audit

Mechanism: one table maps each templatable field to the variable types it accepts,
`TEMPLATABLE_FIELDS: Record<TemplatableField, readonly TemplateVariableType[]>`,
next to the schema UI metadata in `src/types/SchemaUiMetadata.ts`. A shared
`templateVariableOptions(field, variables)` turns it into a "Template variables"
option group that `CustomSelect` / `HarnessDropdown` / `SkillsSelect` place above
Inherit. Outside template mode the helper returns nothing, so no call site needs a
branch.

| Field (workflow / step)                                                                                                                                                                                                                                                        | Templatable              | Accepts                                               | Notes                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness`                                                                                                                                                                                                                                                                      | ✅ dropdown              | harness, then text                                    | A text variable is listed below a divider with the hint "must resolve to a harness id". Instantiation already rejects a bad value through `validateAndNormalize`, but improve that error so it names the variable. |
| `model`                                                                                                                                                                                                                                                                        | ✅ dropdown              | model, then text                                      | See _Pairing_ below.                                                                                                                                                                                               |
| `agent`                                                                                                                                                                                                                                                                        | ✅ dropdown              | text, file                                            | An agent is a name or a path.                                                                                                                                                                                      |
| `skills`                                                                                                                                                                                                                                                                       | ✅ phase 3               | text (per item)                                       | Array field. `SkillsSelect` needs a "variable" entry kind.                                                                                                                                                         |
| `additionalArgs`                                                                                                                                                                                                                                                               | ✅ text field            | text                                                  | Free text. `{` completion in `AdditionalArgsEditor`.                                                                                                                                                               |
| `prompt`, `retryPrompt`, `passRetryPrompt`                                                                                                                                                                                                                                     | ✅ editor                | prompt, text, file, directory, select, harness, model | CodeMirror `{` completion, decoration, lint (below).                                                                                                                                                               |
| Script step `script`, `preCondition`/`endCondition.script`, hook commands                                                                                                                                                                                                      | ✅ editor / text         | text, file, directory, select                         | For values that change per run, use `{{vars}}` or `emitAs: var` (below).                                                                                                                                           |
| Condition `expected`                                                                                                                                                                                                                                                           | ✅ text                  | text, select                                          |                                                                                                                                                                                                                    |
| `worktree.branch`, `worktree.base`, `worktree.setup`                                                                                                                                                                                                                           | ✅ text                  | text                                                  |                                                                                                                                                                                                                    |
| `trustedExternalRoots`                                                                                                                                                                                                                                                         | ✅ text                  | directory, text                                       |                                                                                                                                                                                                                    |
| `toolPermissions.allowedTools` / `deniedTools`                                                                                                                                                                                                                                 | ✅ text (per line)       | text                                                  |                                                                                                                                                                                                                    |
| `vars` values                                                                                                                                                                                                                                                                  | ✅ text                  | any                                                   | A template variable seeds a runtime var: a good pattern, and worth documenting.                                                                                                                                    |
| Step `name`                                                                                                                                                                                                                                                                    | ✅ text                  | text                                                  |                                                                                                                                                                                                                    |
| `mcpServers` names                                                                                                                                                                                                                                                             | ❌ v1                    | —                                                     | Rare need. The editor is complex.                                                                                                                                                                                  |
| `secrets`                                                                                                                                                                                                                                                                      | ❌                       | —                                                     | The schema requires uppercase names, so `{x}` cannot match. Templating which credential a step gets is also a trust decision, best kept explicit.                                                                  |
| `sessionId`                                                                                                                                                                                                                                                                    | ❌                       | —                                                     | The values are step numbers or sentinels and are almost always position-bound.                                                                                                                                     |
| `executionMode`, `resumeSession`, `priorContext`, `priorContextDetail`, `toolPermissions.mode`, `worktree.keep`/`merge`, `errorBehavior.onError`, `onPass`/`onFail`, `operator`, `compareSource`, `returns`, `shell`, `ignoreCase`, `resumeSessionOnRetry`, `enabled`, `color` | ❌                       | —                                                     | Enum or boolean. The schema rejects strings, and a small fixed choice is a poor fit for a variable.                                                                                                                |
| `maxRetries`, `timeoutSec`, `maxSteps`, `retryDelaySec`                                                                                                                                                                                                                        | ❌ v1, phase 4 candidate | —                                                     | Integers. Templating would need a schema `oneOf` with `templatePlaceholder` under `_templateMeta` plus coercion at instantiation. Worth doing only if asked.                                                       |

**Pairing (harness ↔ model).** Template model variables declare a paired harness
variable. In the dropdowns:

- If a step's harness is `{reviewHarness}`, the model dropdown lists the model
  variables paired to `reviewHarness` first, then the models of that variable's
  **default** harness, then text variables.
- Choosing `{reviewHarness}` in a harness dropdown runs `buildHarnessChangeCascade`.
  When exactly one model variable is paired to it, the cascade sets the model to
  that variable instead of the global default.
- Choosing `{developerModel}` while the step's harness is not `{developerHarness}`
  (its pair) raises a field warning: "{developerModel} follows {developerHarness};
  this step uses Codex CLI".

**Display.** A selected placeholder renders as a `{name}` pill with the variable's
type icon. Every lookup keyed by a harness id (`HARNESS_DISPLAY_NAMES`, harness
icons on step cards and the timeline, `getModelsForHarness`, compatibility
diagnostics, "Inherit (X)" labels) needs a placeholder fallback. Add
`isTemplatePlaceholder(value)` (one helper built from the single-sourced pattern)
and resolve through the variable's default for anything that needs a concrete
harness: model lists, compatibility diagnostics. Label it "via {name} default".
`modelWarning` / `agentWarning` / `skillsWarning` return `null` for placeholders.

**Types.** `editorStore` / `settingsStore.workflowProperties` type `harness` as
`HarnessId`. Introduce a `TemplatePlaceholder` template-literal type and widen only
the template-aware read paths to `HarnessId | TemplatePlaceholder`, behind the
narrowing helper. Do not loosen `HarnessId` itself. Runtime code must never see a
placeholder, and the run guard makes sure it doesn't.

### Prompt and script editors in template mode

- When `CodeMirrorEditor` gets a `templateVariables` prop (only in template mode), it:
  - decorates `{name}` / `{file:name}` / `{text:name}` with a style distinct from
    `{{vars}}`, using the same pattern `TemplateManager` substitutes with;
  - completes on `{` with the declared variables (type icon and description);
  - lints undeclared placeholders, with a quick fix "Declare template variable" that
    opens the manager pre-filled;
  - shows a hover card with description, default, type, and usages.
- **Lint for accidental placeholders.** Outside template mode a prompt can contain
  `{foo}` (JSON, code) harmlessly. In a template, `TEMPLATE_VARIABLE_PATTERN` turns
  it into a variable (fact 2). The undeclared-placeholder lint surfaces this. The
  escape hatch is a fenced code block or a non-matching form (`{ foo }`). Document
  that, or teach `extractVariables` to skip fenced code the way `{{vars}}` does.
  Making that change would alter existing templates, so it is an Open question.

### Promote to variable

The variable manager is the full editor, but most variables should come from a
value that already works. Build and run a normal workflow, then promote the
settings that should vary. Authoring then works like an extract refactor: you never
start by writing `_templateMeta`.

**On a field: "Make this a template variable…"**

- Every field marked ✅ in the audit table gets the action in its label-row menu
  (and on right-click where the control supports it). The action works on **any**
  workflow, not only in template mode.
- A small popover asks for the name, suggested from the field (`harness` →
  `harness`, or `reviewHarness` when the step is named `review`; `model` →
  `<step>Model`). The type is picked from the field: a harness field gives
  `harness`, model gives `model` paired with the step's harness variable when it has
  one, a prompt-text selection gives `prompt` or `text`, everything else gives
  `text`. The field's current value becomes the variable's `default`, so the
  workflow behaves exactly as before at instantiation.
- The field's value becomes `{name}`. When the field is an inherit field set to
  Inherit, promoting writes the resolved value as the default and sets the field
  explicitly. The popover shows the resolved value so this is not a surprise.
- **If the workflow is not yet in template mode**, the first promotion runs
  Convert to template on a **copy** (a new template-draft lineage, not yet bound to
  a file) and opens it with the promotion applied. The original workflow and its
  run history are never changed.
- **"Also replace N other identical values"** is a checkbox. It appears when other
  fields of the same kind hold the same value (e.g. three steps on `codex-cli`), and
  rewrites those fields too.

**In the prompt editor: "Extract template variable"**

- With a text selection in any prompt, retry prompt, or script editor, a context
  menu action and a code action (the same surface as the lint quick fixes) extract
  the selection. The selected text becomes the default, the selection becomes
  `{name}`, and the type is `prompt` when the selection spans lines or contains
  references (`@`, `$`, `#`), otherwise `text`.
- "Replace all N occurrences across steps" behaves like the field checkbox. It
  matches exact text outside fenced code.
- A selection that already contains `{other}` placeholders is refused, with a
  message saying why. Nested template variables are not a thing.

**Undo.** A promotion, with all of its field rewrites and the meta entry, is one
undo step on the draft. It goes through the same working-file edit path as other
dashboard edits.

### Text variables that stay editable after creation (`emitAs: var`)

**Problem.** Instantiation copies a variable's value into every place it is used.
`full-feature`'s `{featureDescription}` appears in two prompts. Changing the feature
description after creating the workflow means finding and editing every copy. A
runtime `{{var}}` exists for exactly this, with hover, lint, and one place to edit,
but templates cannot produce one.

**Design.**

- Schema: add `emitAs` to `templateVariableMetadata`, enum `"inline" | "var"`,
  default `"inline"` (today's behavior). It is allowed on `text`, `prompt`, `file`,
  `directory`, and `select`, and rejected on `harness` and `model` through an
  `if`/`then` like the existing `model` → `harness` requirement. Those two only go
  into structural fields, where `{{vars}}` are never substituted.
- At instantiation (`TemplateManager.createWorkflow`), for each `emitAs: var`
  variable:
  1. Write the resolved value to `vars.<name>`. Template names
     (`^[a-z][a-zA-Z0-9]*$`) are a subset of the vars rule (`^\w+$`), so every
     template name is a valid var name.
  2. In the fields where `VarSubstitutor` substitutes at runtime (prompt and script
     text; check the exact field set against `VarSubstitutor`'s call sites and
     single-source it if it is not already), rewrite `{name}` / `{text:name}` /
     `{file:name}` to `{{name}}`. Skip fenced code blocks, because `{{vars}}` are
     not substituted there and the copy has to stay literal to behave the same.
  3. Anywhere else (e.g. `worktree.branch`, `additionalArgs`), substitute inline
     as today, and add a creation-time warning that names the fields: "this copy
     won't follow later edits to `vars.<name>`".
- **Collision:** if the template's own `vars` already defines `<name>`, it is a
  template error at discovery time. The template modal shows it, and so does the
  variable manager as a row error.
- The variable manager shows the setting as a checkbox, "Keep as a workflow var
  after creation", available only for allowed types. A tooltip lists the usages
  that would still be inlined.
- **Bonus:** an emitted var can be overridden per run with the CLI's `--var`, like
  any other var.
- **Built-ins:** switch `full-feature`'s `featureDescription` and `planDocument` to
  `emitAs: var`. Audit the other built-ins for variables used two or more times in
  prompt or script text.

**Things to verify before building it:**

- **`@`-adjacent paths.** `replaceVariables` quotes a value that follows `@`
  (`quoteReferencePath`) so `@{planDocument}` survives spaces. Check whether
  `@{{planDocument}}` resolves and quotes the same way at runtime. If it does not,
  inline `@`-prefixed usages and add them to the warning in step 3.
- **`{{x}}` inside an emitted value.** Inline substitution puts a value's `{{x}}`
  into the prompt, where it becomes a live runtime placeholder. If `VarSubstitutor`
  does not expand a var's value recursively, an emitted value containing `{{x}}`
  stays literal. That is a real difference for `prompt` variables (see
  `TEMPLATE_PROMPT_VARIABLE_PLAN.md`). Either document it or refuse to emit values
  that contain `{{`.
- **Secrets in values.** `vars` are persisted and shown in the dashboard just like
  inlined prompt text, so emitting exposes nothing new. Still, confirm `vars`
  values get no extra logging that inlined prompt text doesn't.

## Phasing

| Phase | Scope                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Prerequisites with no UI: single-source the template name pattern, `isTemplatePlaceholder`, meta-ordered union catalog (fact 1), core run guard for template lineages, `_templateMeta` round-trip through working-file paths (with test).                                         |
| 1     | Enter, exit, and save (Edit template / Edit a copy / Convert to template / open template file), the descriptor field, the banner with chips, the variable manager with rename-propagates and usages, **Try it**. Fields still take placeholders only by typing.                   |
| 2     | Dropdown integration for `harness`, `model`, `agent`, with pairing cascade and warnings. Placeholder fallbacks across the harness-keyed lookups. Free-text field `{` completion. **"Make this a template variable…"** on fields, including auto-convert to a template-draft copy. |
| 3     | CodeMirror template-variable decoration, completion, lint, hover. **"Extract template variable"** from a prompt selection. `skills` per-item variables.                                                                                                                           |
| 4     | **`emitAs: var`**: schema field, instantiation rewrite, manager checkbox, built-in template updates. It does not depend on phases 1–3 and can be built in parallel with them.                                                                                                     |
| 5     | Optional: integer-field placeholders (schema + coercion).                                                                                                                                                                                                                         |

Phase 1 alone already replaces YAML hand-editing of `_templateMeta`. Each later phase
stands on its own. Phase 4 also helps template authors who never open the
dashboard.

## Gotchas

- **Comments and key order in hand-written YAML templates.** Saving from the
  dashboard re-serializes the file. Comments are lost, the same as for any
  dashboard-saved workflow. Built-in templates carry useful comments, which is
  another reason "Edit a copy" is the only path for them. On the first save of a
  file that contains comments, warn once ("comments will be removed"). Preserving
  comments through a YAML CST round-trip is possible but not worth it in v1.
- **Placeholders in `_templateMeta` text.** A description that mentions `{foo}`
  creates a phantom variable through raw-text extraction (fact 2). After the
  catalog fix, extraction should run over the parsed document's scalar values, minus
  `_templateMeta`, not over raw text. That also removes the YAML-comment false
  positives. It is the same traversal `substituteVariablesInValues` already does.
- **Two brace systems in one editor.** `{name}` and `{{name}}` must never be
  decorated as each other. `TEMPLATE_VARIABLE_PATTERN` already excludes
  doubled braces with lookarounds, so reuse it in the editor instead of writing a
  second regex.
- **Multi-client.** A template draft is a lineage, so the existing multi-client
  active-workflow rules apply. Two clients editing one template draft follow the
  same last-write rules as any draft. No new mechanism is needed.
- **Defaults overlay.** Saved per-user and per-workspace defaults
  (`templateVariableDefaultsByScope`) are keyed by template id and variable name. A
  rename in the manager orphans them. Either migrate them during the rename or
  report them as orphaned in the Templates settings page (the classifier already
  reports unknown-variable overrides).

## Testing

- Core: catalog union and ordering; extraction over parsed values (no comment or
  meta false positives); run guard refuses template lineages from orchestrator,
  CLI, and MCP; `_templateMeta` survives working-file round-trips; save overwrites
  with a staleness check; Try it instantiates from an inline body.
- `emitAs: var`: writes `vars.<name>`; rewrites to `{{name}}` only in
  runtime-substituted fields and outside fences; inlines elsewhere with a warning;
  `vars` collision error; schema rejects it on `harness` / `model`; `@`-adjacent
  usage behaves as decided in the verification step.
- Promote: field promotion sets the default to the current (or resolved
  inherited) value and rewrites the field; "replace identical" covers the other
  fields; first promotion on a plain workflow creates a template-draft copy and
  leaves the original lineage untouched; extract-selection picks the type
  correctly and refuses selections that contain placeholders; each promotion is one
  undo step.
- UI: banner states (normal, narrow, unused, undeclared); manager add, rename
  (propagates to all fields), delete with replace, reorder; dropdown option groups
  per the audit table (a table-driven test over `TEMPLATABLE_FIELDS`); pairing
  cascade and mismatch warning; placeholder display fallbacks (no `undefined`
  labels or broken icons).

## Docs

- `docs/workflows/templates.md`: a new "Editing templates in the dashboard" section
  (entry points, promote to variable, the manager, Try it, the field table in short
  form). Keep the YAML reference for people who prefer files, and add `emitAs` to it
  with a before/after example.
- `docs/guide/dashboard.md`: the template-mode banner.
- `docs/guide/prompt-editor.md`: Extract template variable.
- Schema description for `emitAs` (phase 4), and integer placeholders if phase 5
  lands. Then run `npm run schema:update`.

## Open questions

1. **Recent workflows.** Should template drafts appear in the recent list with a
   template icon, or only be reachable from the template picker and settings page?
   Proposed: show them, because otherwise an unsaved draft is hard to find again.
2. **Fenced code in extraction.** Should `extractVariables` and `replaceVariables`
   skip fenced code blocks like `{{vars}}` does? Cleaner, but a behavior change for
   existing templates that put a placeholder in a fence on purpose.
3. **Retire Save as Template?** Convert to template does everything Save as Template
   does and more. Keep both for a release, or fold Save as Template into Convert
   → Save immediately?
4. **`emitAs` default for new variables.** The schema default stays `inline` for
   existing templates. Should the manager and the promote actions default new
   `text` / `prompt` variables to `var` when they are used only in prompt or script
   text? Proposed: yes. The UI defaults; the schema does not.
